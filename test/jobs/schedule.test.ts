import { describe, expect, it } from 'vitest';

import { AutopilotError } from '../../src/core/errors';
import type { ScheduleConfig } from '../../src/core/types';
import { everyMs, latestSlot, nextSlot, slotJobId } from '../../src/jobs/schedule';

const DAY_MS = 86_400_000;
const NY = 'America/New_York';

function schedule(every: string, at?: string): ScheduleConfig {
  return { id: 's1', accountId: 'demo-google', task: 'audit', every, ...(at === undefined ? {} : { at }) };
}

function latest(every: string, at: string | undefined, tz: string | undefined, now: string): string {
  return latestSlot(schedule(every, at), tz, new Date(now)).toISOString();
}

function next(every: string, at: string | undefined, tz: string | undefined, now: string): string {
  return nextSlot(schedule(every, at), tz, new Date(now)).toISOString();
}

describe('everyMs', () => {
  it('converts minutes, hours and days', () => {
    expect(everyMs('15m')).toBe(900_000);
    expect(everyMs('6h')).toBe(21_600_000);
    expect(everyMs('7d')).toBe(7 * DAY_MS);
    expect(everyMs('9999d')).toBe(9999 * DAY_MS);
  });

  it('throws config_invalid for a malformed interval', () => {
    for (const bad of ['', '0m', '15', 'm', '15s', '1.5h', '-1d', '10000m', ' 15m', '15M', '1d ']) {
      let caught: unknown;
      try {
        everyMs(bad);
      } catch (error) {
        caught = error;
      }
      expect(caught, bad).toBeInstanceOf(AutopilotError);
      expect((caught as AutopilotError).code).toBe('config_invalid');
    }
    expect(() => latestSlot(schedule('soon'), undefined, new Date(0))).toThrow(AutopilotError);
    expect(() => nextSlot(schedule('soon'), undefined, new Date(0))).toThrow(AutopilotError);
  });
});

describe('minute and hour intervals', () => {
  it('aligns 15m to the epoch in UTC and ignores at and timezone', () => {
    expect(latest('15m', undefined, undefined, '2026-10-04T10:22:31.500Z')).toBe('2026-10-04T10:15:00.000Z');
    expect(next('15m', undefined, undefined, '2026-10-04T10:22:31.500Z')).toBe('2026-10-04T10:30:00.000Z');
    expect(latest('15m', '07:30', 'Asia/Kolkata', '2026-10-04T10:22:31.500Z')).toBe('2026-10-04T10:15:00.000Z');
  });

  it('aligns 6h to the epoch in UTC', () => {
    expect(latest('6h', undefined, NY, '2026-10-04T10:22:00Z')).toBe('2026-10-04T06:00:00.000Z');
    expect(next('6h', undefined, NY, '2026-10-04T10:22:00Z')).toBe('2026-10-04T12:00:00.000Z');
  });

  it('treats an instant on a slot as that slot, and the next one as strictly later', () => {
    expect(latest('6h', undefined, undefined, '2026-10-04T12:00:00Z')).toBe('2026-10-04T12:00:00.000Z');
    expect(next('6h', undefined, undefined, '2026-10-04T12:00:00Z')).toBe('2026-10-04T18:00:00.000Z');
  });
});

describe('day intervals', () => {
  it('runs 1d at midnight UTC without at', () => {
    expect(latest('1d', undefined, undefined, '2026-10-04T10:00:00Z')).toBe('2026-10-04T00:00:00.000Z');
    expect(next('1d', undefined, undefined, '2026-10-04T10:00:00Z')).toBe('2026-10-05T00:00:00.000Z');
  });

  it('runs 1d at the given time in UTC', () => {
    expect(latest('1d', '07:30', undefined, '2026-10-04T10:00:00Z')).toBe('2026-10-04T07:30:00.000Z');
    expect(latest('1d', '07:30', undefined, '2026-10-04T07:00:00Z')).toBe('2026-10-03T07:30:00.000Z');
    expect(next('1d', '07:30', undefined, '2026-10-04T07:00:00Z')).toBe('2026-10-04T07:30:00.000Z');
    expect(next('1d', '07:30', undefined, '2026-10-04T07:30:00Z')).toBe('2026-10-05T07:30:00.000Z');
  });

  it('runs 1d at 07:30 New York time on an ordinary day', () => {
    expect(latest('1d', '07:30', NY, '2026-06-15T12:00:00Z')).toBe('2026-06-15T11:30:00.000Z');
    expect(latest('1d', '07:30', NY, '2026-06-15T11:00:00Z')).toBe('2026-06-14T11:30:00.000Z');
    expect(next('1d', '07:30', NY, '2026-06-15T12:00:00Z')).toBe('2026-06-16T11:30:00.000Z');
    expect(latest('1d', '07:30', NY, '2026-01-15T13:00:00Z')).toBe('2026-01-15T12:30:00.000Z');
  });

  it('uses the first instant after the gap on the spring-forward day', () => {
    expect(latest('1d', '02:30', NY, '2026-03-08T12:00:00Z')).toBe('2026-03-08T07:00:00.000Z');
    expect(latest('1d', '02:30', NY, '2026-03-08T07:00:00Z')).toBe('2026-03-08T07:00:00.000Z');
    expect(latest('1d', '02:30', NY, '2026-03-08T06:59:59.999Z')).toBe('2026-03-07T07:30:00.000Z');
    expect(next('1d', '02:30', NY, '2026-03-07T12:00:00Z')).toBe('2026-03-08T07:00:00.000Z');
    expect(next('1d', '02:30', NY, '2026-03-08T12:00:00Z')).toBe('2026-03-09T06:30:00.000Z');
  });

  it('uses the first occurrence on the fall-back day', () => {
    expect(latest('1d', '01:30', NY, '2026-11-01T12:00:00Z')).toBe('2026-11-01T05:30:00.000Z');
    // Between the two occurrences of 01:30 local.
    expect(latest('1d', '01:30', NY, '2026-11-01T06:00:00Z')).toBe('2026-11-01T05:30:00.000Z');
    expect(next('1d', '01:30', NY, '2026-11-01T06:00:00Z')).toBe('2026-11-02T06:30:00.000Z');
    expect(next('1d', '01:30', NY, '2026-10-31T12:00:00Z')).toBe('2026-11-01T05:30:00.000Z');
  });

  it('hits only days whose day number is a multiple of 7 for 7d', () => {
    expect(latest('7d', undefined, undefined, '2026-10-04T10:00:00Z')).toBe('2026-10-01T00:00:00.000Z');
    expect(next('7d', undefined, undefined, '2026-10-04T10:00:00Z')).toBe('2026-10-08T00:00:00.000Z');
    expect(latest('7d', undefined, undefined, '1970-01-03T00:00:00Z')).toBe('1970-01-01T00:00:00.000Z');
    let now = new Date('2026-09-01T00:00:00Z');
    for (let i = 0; i < 10; i += 1) {
      now = nextSlot(schedule('7d', '09:00'), undefined, now);
      expect(now.toISOString().slice(11)).toBe('09:00:00.000Z');
      expect(Math.floor(now.getTime() / DAY_MS) % 7).toBe(0);
    }
    // The local date decides, not the UTC date: 2026-10-01 00:00 in New York is 04:00 UTC.
    expect(latest('7d', undefined, NY, '2026-10-04T10:00:00Z')).toBe('2026-10-01T04:00:00.000Z');
  });

  it('treats an invalid zone name as UTC', () => {
    expect(latest('1d', '07:30', 'Not/A_Zone', '2026-06-15T12:00:00Z')).toBe('2026-06-15T07:30:00.000Z');
    expect(next('1d', '07:30', 'Not/A_Zone', '2026-06-15T12:00:00Z')).toBe('2026-06-16T07:30:00.000Z');
  });

  it('throws config_invalid for a malformed at', () => {
    expect(() => latestSlot(schedule('1d', '7:30pm'), undefined, new Date(0))).toThrow(AutopilotError);
    expect(() => nextSlot(schedule('1d', '24:00'), undefined, new Date(0))).toThrow(AutopilotError);
  });
});

describe('slot invariants', () => {
  const cases: Array<[string, string | undefined, string | undefined]> = [
    ['15m', undefined, undefined],
    ['6h', undefined, NY],
    ['1d', undefined, undefined],
    ['1d', '07:30', NY],
    ['1d', '02:30', NY],
    ['1d', '01:30', NY],
    ['1d', '02:30', 'Europe/Istanbul'],
    ['1d', '00:15', 'Asia/Kolkata'],
    ['1d', '23:45', 'Pacific/Kiritimati'],
    ['3d', '12:00', 'Australia/Lord_Howe'],
    ['7d', '09:00', NY],
    ['7d', undefined, 'Nope/Nowhere'],
  ];
  // Around both New York transitions of 2026, and a spread across the year.
  const instants: number[] = [];
  for (const start of ['2026-03-06T00:00:00Z', '2026-10-30T00:00:00Z']) {
    for (let i = 0; i < 300; i += 1) instants.push(new Date(start).getTime() + i * 17 * 60_000 + i);
  }
  for (let i = 0; i < 200; i += 1) instants.push(Date.UTC(2026, 0, 1) + i * 43 * 3_600_000 + i * 977);

  it.each(cases)('holds for every %s at %s in %s', (every, at, tz) => {
    const s = schedule(every, at);
    for (const t of instants) {
      const now = new Date(t);
      const before = latestSlot(s, tz, now).getTime();
      const after = nextSlot(s, tz, now).getTime();
      expect(before).toBeLessThanOrEqual(t);
      expect(after).toBeGreaterThan(t);
      expect(latestSlot(s, tz, new Date(after)).getTime()).toBe(after);
      // No slot lies between the two: the slot just before `after` is `before`.
      expect(latestSlot(s, tz, new Date(after - 1)).getTime()).toBe(before);
      expect(nextSlot(s, tz, new Date(before)).getTime()).toBe(after);
      expect(latestSlot(s, tz, new Date(before)).getTime()).toBe(before);
    }
  });
});

describe('slotJobId', () => {
  it('is stable and differs per slot and per schedule', () => {
    const slot = new Date('2026-10-04T00:00:00Z');
    const id = slotJobId('daily-audit', slot);
    expect(id).toMatch(/^job_[0-9a-f]{16}$/);
    expect(slotJobId('daily-audit', new Date(slot.getTime()))).toBe(id);
    expect(slotJobId('daily-audit', new Date('2026-10-05T00:00:00Z'))).not.toBe(id);
    expect(slotJobId('weekly-report', slot)).not.toBe(id);
  });
});
