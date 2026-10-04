import { describe, expect, it } from 'vitest';
import {
  addDays,
  assertRange,
  daysInRange,
  hoursBetween,
  isIsoDate,
  lastNDays,
  previousRange,
  todayIso,
} from '../../src/core/dates';
import { AutopilotError } from '../../src/core/errors';
import {
  currencyExponent,
  formatMoney,
  fromMicros,
  fromMinorUnits,
  roundMoney,
  toMicros,
  toMinorUnits,
} from '../../src/core/money';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof AutopilotError ? error.code : `not AutopilotError: ${String(error)}`;
  }
  return undefined;
}

describe('money', () => {
  it('knows zero-, two- and three-decimal currencies, case-insensitively', () => {
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('krw')).toBe(0);
    expect(currencyExponent('XOF')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
    expect(currencyExponent('bhd')).toBe(3);
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('try')).toBe(2);
  });

  it('converts micros', () => {
    expect(toMicros(1.23)).toBe(1_230_000);
    expect(toMicros(0.1 + 0.2)).toBe(300_000);
    expect(fromMicros(1_230_000)).toBe(1.23);
    expect(fromMicros('2500000')).toBe(2.5);
  });

  it('converts minor units per currency', () => {
    expect(toMinorUnits(50, 'USD')).toBe(5000);
    expect(toMinorUnits(5000, 'JPY')).toBe(5000);
    expect(toMinorUnits(1.2345, 'KWD')).toBe(1235);
    expect(toMinorUnits(19.99, 'usd')).toBe(1999);
    expect(fromMinorUnits(5000, 'USD')).toBe(50);
    expect(fromMinorUnits('5000', 'JPY')).toBe(5000);
    expect(fromMinorUnits(1235, 'KWD')).toBe(1.235);
  });

  it('rounds without float noise', () => {
    expect(roundMoney(0.1 + 0.2, 'USD')).toBe(0.3);
    expect(roundMoney(1.005, 'USD')).toBe(1.01);
    expect(roundMoney(1234.5, 'JPY')).toBe(1235);
    expect(roundMoney(1.23456, 'KWD')).toBe(1.235);
    expect(roundMoney(1e-7, 'USD')).toBe(0);
    expect(Object.is(roundMoney(-0.001, 'USD'), 0)).toBe(true);
  });

  it('formats with the currency exponent', () => {
    expect(formatMoney(1234.5, 'USD')).toBe('1,234.50 USD');
    expect(formatMoney(5000, 'jpy')).toBe('5,000 JPY');
    expect(formatMoney(1.5, 'KWD')).toBe('1.500 KWD');
  });

  it('rejects non-finite inputs', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(codeOf(() => toMicros(bad))).toBe('invalid_input');
      expect(codeOf(() => fromMicros(bad))).toBe('invalid_input');
      expect(codeOf(() => toMinorUnits(bad, 'USD'))).toBe('invalid_input');
      expect(codeOf(() => fromMinorUnits(bad, 'USD'))).toBe('invalid_input');
      expect(codeOf(() => roundMoney(bad, 'USD'))).toBe('invalid_input');
      expect(codeOf(() => formatMoney(bad, 'USD'))).toBe('invalid_input');
    }
    expect(codeOf(() => fromMicros('abc'))).toBe('invalid_input');
    expect(codeOf(() => fromMicros(''))).toBe('invalid_input');
    expect(codeOf(() => fromMinorUnits('12x', 'USD'))).toBe('invalid_input');
  });
});

describe('dates', () => {
  it('accepts only real calendar dates', () => {
    expect(isIsoDate('2026-01-31')).toBe(true);
    expect(isIsoDate('2024-02-29')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('2026-1-01')).toBe(false);
    expect(isIsoDate('2026-01-01T00:00:00Z')).toBe(false);
    expect(isIsoDate('')).toBe(false);
  });

  it('takes today in UTC', () => {
    expect(todayIso(new Date('2026-03-01T23:59:59-05:00'))).toBe('2026-03-02');
    expect(todayIso(new Date('2026-03-01T00:00:00Z'))).toBe('2026-03-01');
  });

  it('adds days across leap day, month and year boundaries', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2024-02-29', 1)).toBe('2024-03-01');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2025-12-31', 1)).toBe('2026-01-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2024-03-01', -366)).toBe('2023-03-01');
    expect(addDays('2026-05-10', 0)).toBe('2026-05-10');
    expect(codeOf(() => addDays('2026-02-30', 1))).toBe('invalid_input');
  });

  it('counts days inclusively', () => {
    expect(daysInRange({ start: '2026-01-01', end: '2026-01-01' })).toBe(1);
    expect(daysInRange({ start: '2024-02-01', end: '2024-03-01' })).toBe(30);
    expect(daysInRange({ start: '2025-12-25', end: '2026-01-05' })).toBe(12);
  });

  it('lastNDays ends yesterday and spans exactly n days', () => {
    const now = new Date('2026-01-03T00:30:00Z');
    expect(lastNDays(1, now)).toEqual({ start: '2026-01-02', end: '2026-01-02' });
    const week = lastNDays(7, now);
    expect(week).toEqual({ start: '2025-12-27', end: '2026-01-02' });
    expect(daysInRange(week)).toBe(7);
    expect(daysInRange(lastNDays(90, now))).toBe(90);
    expect(codeOf(() => lastNDays(0, now))).toBe('invalid_input');
    expect(codeOf(() => lastNDays(1.5, now))).toBe('invalid_input');
  });

  it('previousRange has equal length and ends the day before', () => {
    const range = { start: '2026-01-01', end: '2026-01-07' };
    const previous = previousRange(range);
    expect(previous).toEqual({ start: '2025-12-25', end: '2025-12-31' });
    expect(daysInRange(previous)).toBe(daysInRange(range));
    expect(previousRange({ start: '2024-03-01', end: '2024-03-01' })).toEqual({ start: '2024-02-29', end: '2024-02-29' });
  });

  it('assertRange rejects bad dates and inverted ranges with a hint', () => {
    expect(() => assertRange({ start: '2026-01-01', end: '2026-01-31' })).not.toThrow();
    for (const range of [
      { start: '2026-02-30', end: '2026-03-01' },
      { start: '2026-01-01', end: 'tomorrow' },
      { start: '2026-01-02', end: '2026-01-01' },
    ]) {
      try {
        assertRange(range);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(AutopilotError);
        const typed = error as AutopilotError;
        expect(typed.code).toBe('invalid_input');
        expect(typed.hint).toBeTruthy();
      }
    }
  });

  it('hoursBetween is signed', () => {
    expect(hoursBetween('2026-01-01T00:00:00Z', '2026-01-01T06:30:00Z')).toBe(6.5);
    expect(hoursBetween('2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z')).toBe(-24);
    expect(hoursBetween('2025-12-31T23:00:00Z', '2026-01-01T01:00:00+01:00')).toBe(1);
    expect(codeOf(() => hoursBetween('nope', '2026-01-01T00:00:00Z'))).toBe('invalid_input');
  });
});
