import { AutopilotError } from '../core/errors';
import { shortId } from '../core/ids';
import type { ScheduleConfig } from '../core/types';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

type Unit = 'm' | 'h' | 'd';

interface Interval {
  n: number;
  unit: Unit;
}

function parseEvery(every: string): Interval {
  const match = /^([1-9]\d{0,3})([mhd])$/.exec(every);
  const digits = match?.[1];
  const unit = match?.[2];
  if (digits === undefined || (unit !== 'm' && unit !== 'h' && unit !== 'd')) {
    throw new AutopilotError('config_invalid', 'Schedule interval is malformed.', {
      hint: 'Use a whole number from 1 to 9999 followed by m, h or d, for example 15m, 6h or 1d.',
    });
  }
  return { n: Number(digits), unit };
}

function unitMs(unit: Unit): number {
  if (unit === 'm') return MINUTE_MS;
  if (unit === 'h') return HOUR_MS;
  return DAY_MS;
}

/** Interval of a schedule in milliseconds. Throws `config_invalid` for a malformed `every`. */
export function everyMs(every: string): number {
  const { n, unit } = parseEvery(every);
  return n * unitMs(unit);
}

/** Milliseconds after local midnight. */
function parseAt(at: string | undefined): number {
  if (at === undefined) return 0;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(at);
  if (!match) {
    throw new AutopilotError('config_invalid', 'Schedule time of day is malformed.', {
      hint: 'Use HH:MM on a 24-hour clock, for example 07:30.',
    });
  }
  return Number(match[1]) * HOUR_MS + Number(match[2]) * MINUTE_MS;
}

const formatters = new Map<string, Intl.DateTimeFormat | null>();

/** Formatter for the zone's wall clock, or null when the zone is UTC, undefined or not valid. */
function formatterFor(timezone: string | undefined): Intl.DateTimeFormat | null {
  if (timezone === undefined || timezone === 'UTC') return null;
  const cached = formatters.get(timezone);
  if (cached !== undefined) return cached;
  let formatter: Intl.DateTimeFormat | null;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    formatter = null;
  }
  formatters.set(timezone, formatter);
  return formatter;
}

/** Zone offset at instant `t`, in ms: wall clock (read as if it were UTC) minus `t`. */
function offsetAt(formatter: Intl.DateTimeFormat | null, t: number): number {
  if (formatter === null) return 0;
  const seconds = Math.floor(t / 1000) * 1000;
  const fields: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(seconds))) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value);
  }
  const wall = Date.UTC(
    fields['year'] ?? 1970,
    (fields['month'] ?? 1) - 1,
    fields['day'] ?? 1,
    fields['hour'] ?? 0,
    fields['minute'] ?? 0,
    fields['second'] ?? 0,
  );
  return wall - seconds;
}

/**
 * The instant at which the zone's wall clock first shows `local` (ms since 1970-01-01 00:00 on that
 * wall clock), or the first instant after the gap when the wall clock skips it.
 */
function instantOfLocal(formatter: Intl.DateTimeFormat | null, local: number): number {
  if (formatter === null) return local;
  const before = offsetAt(formatter, local - DAY_MS);
  const after = offsetAt(formatter, local + DAY_MS);
  const valid = [local - before, local - after].filter((t) => t + offsetAt(formatter, t) === local);
  if (valid.length > 0) return Math.min(...valid);
  // Gap: the old offset still holds at `lo`, and no longer at `hi`.
  let lo = Math.min(local - before, local - after);
  let hi = Math.max(local - before, local - after);
  const old = offsetAt(formatter, lo);
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (offsetAt(formatter, mid) === old) lo = mid;
    else hi = mid;
  }
  return hi;
}

interface DayGrid {
  n: number;
  /** Day number of the latest scheduled local day at or before the local date of `now`. */
  day: number;
  slotOf: (day: number) => number;
}

function dayGrid(schedule: ScheduleConfig, n: number, timezone: string | undefined, now: number): DayGrid {
  const at = parseAt(schedule.at);
  const formatter = formatterFor(timezone);
  const today = Math.floor((now + offsetAt(formatter, now)) / DAY_MS);
  return {
    n,
    day: Math.floor(today / n) * n,
    slotOf: (day) => instantOfLocal(formatter, day * DAY_MS + at),
  };
}

function assertInstant(now: Date): number {
  const t = now.getTime();
  if (Number.isNaN(t)) throw new AutopilotError('internal', 'Schedule arithmetic needs a valid date.');
  return t;
}

/**
 * The latest slot of `schedule` at or before `now`. An interval in minutes or hours is aligned to
 * the Unix epoch in UTC. An interval in days falls on `at` (default 00:00) in `timezone` (UTC when
 * undefined), on local calendar days whose day number since 1970-01-01 is a multiple of the interval.
 */
export function latestSlot(schedule: ScheduleConfig, timezone: string | undefined, now: Date): Date {
  const t = assertInstant(now);
  const { n, unit } = parseEvery(schedule.every);
  if (unit !== 'd') {
    const interval = n * unitMs(unit);
    return new Date(Math.floor(t / interval) * interval);
  }
  const grid = dayGrid(schedule, n, timezone, t);
  let day = grid.day + n;
  let slot = grid.slotOf(day);
  while (slot > t) {
    day -= n;
    slot = grid.slotOf(day);
  }
  return new Date(slot);
}

/** The first slot after `now`. */
export function nextSlot(schedule: ScheduleConfig, timezone: string | undefined, now: Date): Date {
  const t = assertInstant(now);
  const { n, unit } = parseEvery(schedule.every);
  if (unit !== 'd') {
    const interval = n * unitMs(unit);
    return new Date(Math.floor(t / interval) * interval + interval);
  }
  const grid = dayGrid(schedule, n, timezone, t);
  let day = grid.day - n;
  let slot = grid.slotOf(day);
  while (slot <= t) {
    day += n;
    slot = grid.slotOf(day);
  }
  return new Date(slot);
}

/** Id of the job for one slot of one schedule: `job_` + 16 hex chars, the same in every process. */
export function slotJobId(scheduleId: string, slot: Date): string {
  return shortId('job', { scheduleId, slot: slot.toISOString() });
}
