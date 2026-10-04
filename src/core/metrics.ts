import { AutopilotError } from './errors';
import type { DateRange, KpiSet, Metrics, Row } from './types';

const MS_PER_DAY = 86_400_000;

/** `numerator / denominator`, or null when the denominator is missing or zero. */
export function ratio(numerator: number | undefined, denominator: number | undefined): number | null {
  if (denominator === undefined || denominator === 0) return null;
  return (numerator ?? 0) / denominator;
}

/** A metric value, 0 when absent. */
export function metric(row: Row, key: string): number {
  return row.metrics[key] ?? 0;
}

export function attrNumber(row: Row, key: string): number | null {
  const value = row.attrs[key];
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function attrString(row: Row, key: string): string | null {
  const value = row.attrs[key];
  return typeof value === 'string' ? value : null;
}

/** Sums every metric key across rows. */
export function sumMetrics(rows: Row[]): Metrics {
  const total: Metrics = {};
  for (const row of rows) {
    for (const [key, value] of Object.entries(row.metrics)) {
      if (value === undefined) continue;
      total[key] = (total[key] ?? 0) + value;
    }
  }
  return total;
}

export function kpis(metrics: Metrics): KpiSet {
  const impressions = metrics.impressions ?? 0;
  const clicks = metrics.clicks ?? 0;
  const cost = metrics.cost ?? 0;
  const conversions = metrics.conversions ?? 0;
  const conversionValue = metrics.conversionValue ?? 0;
  return {
    impressions,
    clicks,
    cost,
    conversions,
    conversionValue,
    ctr: ratio(clicks, impressions),
    cpc: ratio(cost, clicks),
    cpa: ratio(cost, conversions),
    roas: ratio(conversionValue, cost),
    conversionRate: ratio(conversions, clicks),
  };
}

function utcDay(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const ms = match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : Number.NaN;
  if (!Number.isFinite(ms)) {
    throw new AutopilotError('invalid_input', `Invalid date '${date}'`, { hint: 'Use YYYY-MM-DD.' });
  }
  return ms;
}

/** Inclusive: a range whose start equals its end is one day. */
function dayCount(range: DateRange): number {
  const days = Math.round((utcDay(range.end) - utcDay(range.start)) / MS_PER_DAY) + 1;
  if (days < 1) {
    throw new AutopilotError('invalid_input', `Date range ends before it starts: ${range.start}..${range.end}`);
  }
  return days;
}

/** Scales an amount observed over `range` to 30 days. */
export function monthly(amount: number, range: DateRange): number {
  return (amount * 30) / dayCount(range);
}

export function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group) group.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}
