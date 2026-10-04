import { AutopilotError } from '../core/errors';
import { kpis, sumMetrics } from '../core/metrics';
import { formatMoney } from '../core/money';
import type { AccountConfig, DateRange, KpiDelta, KpiReport, KpiSet, Row, Snapshot } from '../core/types';

const KPI_KEYS: Array<keyof KpiSet> = [
  'impressions',
  'clicks',
  'cost',
  'conversions',
  'conversionValue',
  'ctr',
  'cpc',
  'cpa',
  'roas',
  'conversionRate',
];

const TOP_CAMPAIGNS = 10;

/** The KPIs that depend on what `conversions` counts. */
const CONVERSION_KEYS: ReadonlySet<keyof KpiSet> = new Set<keyof KpiSet>([
  'conversions',
  'conversionValue',
  'cpa',
  'roas',
  'conversionRate',
]);

/** The two definitions when both snapshots state one and they differ, otherwise null. */
function definitionMismatch(current: Snapshot, previous: Snapshot | null): { current: string; previous: string } | null {
  const now = current.conversionDefinition;
  const before = previous?.conversionDefinition;
  if (now === undefined || before === undefined || now === before) return null;
  return { current: now, previous: before };
}

function totalRows(snapshot: Snapshot): Row[] {
  const rows = snapshot.datasets.campaigns ?? snapshot.datasets.daily;
  if (rows === undefined) {
    throw new AutopilotError('invalid_input', `Snapshot ${snapshot.id} has neither a campaigns nor a daily dataset`, {
      hint: 'Take a snapshot that includes the campaigns dataset.',
    });
  }
  return rows;
}

function relativeChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return (current - previous) / previous;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
}

function formatPercent(fraction: number, decimals: number): string {
  return `${(fraction * 100).toFixed(decimals)}%`;
}

function comparison(change: number | null, previousText: string | null): string {
  if (previousText === null) return '';
  if (change === null) return ` (previous period: ${previousText})`;
  const rounded = Math.abs(change * 100).toFixed(1);
  if (rounded === '0.0') return `, unchanged on the previous period (${previousText})`;
  return `, ${change > 0 ? 'up' : 'down'} ${rounded}% on the previous period (${previousText})`;
}

function buildFacts(input: {
  current: KpiSet;
  previous: KpiSet | null;
  range: DateRange;
  currency: string;
  mismatch: { current: string; previous: string } | null;
}): string[] {
  const { current, previous, range, currency, mismatch } = input;
  const period = `from ${range.start} to ${range.end}`;
  const facts: string[] = [];
  const add = (label: string, verb: string, key: keyof KpiSet, format: (value: number) => string): void => {
    const value = current[key];
    if (value === null) return;
    const before = previous === null || (mismatch !== null && CONVERSION_KEYS.has(key)) ? null : previous[key];
    const previousText = before === null ? null : format(before);
    facts.push(`${label} ${verb} ${format(value)} ${period}${comparison(relativeChange(value, before), previousText)}.`);
  };
  add('Cost', 'was', 'cost', (value) => formatMoney(value, currency));
  add('Conversions', 'were', 'conversions', formatCount);
  add('CPA', 'was', 'cpa', (value) => formatMoney(value, currency));
  add('ROAS', 'was', 'roas', (value) => value.toFixed(2));
  add('CTR', 'was', 'ctr', (value) => formatPercent(value, 2));
  if (mismatch !== null) {
    facts.push(
      `Conversions are not comparable between the two periods: the current period counts "${mismatch.current}", the previous one "${mismatch.previous}". Set META_CONVERSION_ACTION to fix the definition.`,
    );
  }
  return facts;
}

export function buildKpiReport(input: { current: Snapshot; previous: Snapshot | null; account: AccountConfig }): KpiReport {
  const { current, previous, account } = input;
  if (current.platform !== 'google_ads' && current.platform !== 'meta_ads') {
    throw new AutopilotError('unsupported', `KPI reports are not available for platform ${current.platform}`, {
      hint: 'Use data_query to read this platform\'s datasets.',
    });
  }
  if (previous !== null && (previous.accountId !== current.accountId || previous.platform !== current.platform)) {
    throw new AutopilotError('invalid_input', 'The previous snapshot belongs to a different account or platform', {
      hint: 'Compare two snapshots of the same account.',
    });
  }

  const currentKpis = kpis(sumMetrics(totalRows(current)));
  const previousKpis = previous === null ? null : kpis(sumMetrics(totalRows(previous)));

  const mismatch = definitionMismatch(current, previous);

  const deltas: KpiDelta[] = KPI_KEYS.map((metric) => {
    const now = currentKpis[metric];
    const before = previousKpis === null ? null : previousKpis[metric];
    const comparable = mismatch === null || !CONVERSION_KEYS.has(metric);
    return { metric, current: now, previous: before, change: comparable ? relativeChange(now, before) : null };
  });

  const previousById = new Map<string, Row>();
  for (const row of previous?.datasets.campaigns ?? []) previousById.set(row.id, row);

  const topCampaigns = [...(current.datasets.campaigns ?? [])]
    .sort((a, b) => (b.metrics.cost ?? 0) - (a.metrics.cost ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, TOP_CAMPAIGNS)
    .map((row) => {
      const before = previousById.get(row.id);
      return {
        id: row.id,
        name: row.name ?? row.id,
        kpis: kpis(row.metrics),
        previous: before === undefined ? null : kpis(before.metrics),
      };
    });

  const currency = current.currency || account.currency || 'XXX';

  return {
    accountId: current.accountId,
    platform: current.platform,
    currency,
    current: { snapshotId: current.id, dateRange: current.dateRange, kpis: currentKpis },
    previous:
      previous === null || previousKpis === null
        ? null
        : { snapshotId: previous.id, dateRange: previous.dateRange, kpis: previousKpis },
    deltas,
    topCampaigns,
    facts: buildFacts({ current: currentKpis, previous: previousKpis, range: current.dateRange, currency, mismatch }),
  };
}
