import { AutopilotError } from './errors';
import type { DateRange } from './types';

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function formatUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** UTC midnight of an ISO date in epoch ms. */
function toUtcMs(date: string): number {
  if (!isIsoDate(date)) {
    throw new AutopilotError('invalid_input', `Not an ISO date: ${JSON.stringify(date)}`, {
      hint: 'Use a real calendar date as YYYY-MM-DD, e.g. 2026-01-31.',
    });
  }
  return Date.parse(`${date}T00:00:00Z`);
}

function assertInteger(value: number, label: string, min: number): void {
  if (!Number.isInteger(value) || value < min) {
    throw new AutopilotError('invalid_input', `${label} must be an integer${min > 0 ? ` >= ${min}` : ''}, got ${value}`);
  }
}

export function isIsoDate(value: string): boolean {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  // The round trip rejects overflowing days such as 2026-02-30.
  return Number.isFinite(ms) && formatUtc(ms) === value;
}

/** UTC calendar date of `now`. */
export function todayIso(now: Date): string {
  const ms = now.getTime();
  if (!Number.isFinite(ms)) {
    throw new AutopilotError('invalid_input', 'now is not a valid Date');
  }
  return formatUtc(ms);
}

export function addDays(date: string, days: number): string {
  const start = toUtcMs(date);
  assertInteger(days, 'days', Number.MIN_SAFE_INTEGER);
  return formatUtc(start + days * MS_PER_DAY);
}

/** Inclusive day count. */
export function daysInRange(range: DateRange): number {
  assertRange(range);
  return Math.round((toUtcMs(range.end) - toUtcMs(range.start)) / MS_PER_DAY) + 1;
}

/** The `days` complete days ending yesterday. */
export function lastNDays(days: number, now: Date): DateRange {
  assertInteger(days, 'days', 1);
  const end = addDays(todayIso(now), -1);
  return { start: addDays(end, -(days - 1)), end };
}

/** The range of equal length that ends the day before `range` starts. */
export function previousRange(range: DateRange): DateRange {
  const length = daysInRange(range);
  const end = addDays(range.start, -1);
  return { start: addDays(end, -(length - 1)), end };
}

/** Throws `invalid_input` unless both dates are ISO dates and start <= end. */
export function assertRange(range: DateRange): void {
  const hint = 'Use YYYY-MM-DD for both dates with start on or before end, e.g. { start: "2026-01-01", end: "2026-01-31" }.';
  if (!isIsoDate(range.start)) {
    throw new AutopilotError('invalid_input', `Range start is not an ISO date: ${JSON.stringify(range.start)}`, { hint });
  }
  if (!isIsoDate(range.end)) {
    throw new AutopilotError('invalid_input', `Range end is not an ISO date: ${JSON.stringify(range.end)}`, { hint });
  }
  // ISO dates order lexicographically.
  if (range.start > range.end) {
    throw new AutopilotError('invalid_input', `Range start ${range.start} is after end ${range.end}`, { hint });
  }
}

export function hoursBetween(earlierIso: string, laterIso: string): number {
  const earlier = Date.parse(earlierIso);
  const later = Date.parse(laterIso);
  if (!Number.isFinite(earlier) || !Number.isFinite(later)) {
    throw new AutopilotError('invalid_input', `Not an ISO timestamp: ${JSON.stringify(Number.isFinite(earlier) ? laterIso : earlierIso)}`, {
      hint: 'Use an ISO 8601 timestamp, e.g. 2026-01-31T12:00:00Z.',
    });
  }
  return (later - earlier) / MS_PER_HOUR;
}
