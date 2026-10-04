import { describe, expect, it } from 'vitest';
import type { AccountConfig, KpiSet, Snapshot } from '../../src/core/types';
import { buildKpiReport } from '../../src/report/kpi';

const account: AccountConfig = { id: 'acme-meta', platform: 'meta_ads', externalId: 'act_1' };

const NOT_COMPARABLE =
  'Conversions are not comparable between the two periods: the current period counts "lead", the previous one "purchase". Set META_CONVERSION_ACTION to fix the definition.';

const CONVERSION_METRICS: Array<keyof KpiSet> = ['conversions', 'conversionValue', 'cpa', 'roas', 'conversionRate'];

function snapshot(id: string, conversions: number, cost: number, definition?: string): Snapshot {
  return {
    id,
    schemaVersion: 1,
    platform: 'meta_ads',
    accountId: 'acme-meta',
    externalAccountId: 'act_1',
    source: 'demo',
    currency: 'USD',
    timezone: 'UTC',
    dateRange: { start: '2026-09-01', end: '2026-09-30' },
    createdAt: '2026-10-01T00:00:00Z',
    datasets: {
      campaigns: [
        {
          id: 'c1',
          name: 'One',
          metrics: { impressions: 10000, clicks: 500, cost, conversions, conversionValue: conversions * 20 },
          attrs: {},
        },
      ],
    },
    coverage: {},
    warnings: [],
    contentHash: 'h',
    ...(definition === undefined ? {} : { conversionDefinition: definition }),
  };
}

describe('buildKpiReport with conversion definitions', () => {
  it('does not compare conversion metrics counted under different definitions', () => {
    const report = buildKpiReport({
      current: snapshot('now', 100, 1100, 'lead'),
      previous: snapshot('before', 10, 1000, 'purchase'),
      account,
    });
    const byMetric = new Map(report.deltas.map((delta) => [delta.metric, delta]));
    for (const metric of CONVERSION_METRICS) expect(byMetric.get(metric)?.change).toBeNull();
    expect(byMetric.get('conversions')).toMatchObject({ current: 100, previous: 10 });
    expect(byMetric.get('cpa')?.previous).toBeCloseTo(100);
    expect(byMetric.get('cost')).toMatchObject({ current: 1100, previous: 1000 });
    expect(byMetric.get('cost')?.change).toBeCloseTo(0.1);
    expect(byMetric.get('impressions')?.change).toBe(0);

    expect(report.facts).toContain(NOT_COMPARABLE);
    expect(report.facts).toContain('Conversions were 100 from 2026-09-01 to 2026-09-30.');
    expect(report.facts).toContain('CPA was 11.00 USD from 2026-09-01 to 2026-09-30.');
    expect(report.facts).toContain('ROAS was 1.82 from 2026-09-01 to 2026-09-30.');
    expect(report.facts.find((fact) => fact.startsWith('Cost '))).toContain('up 10.0% on the previous period');
    expect(report.facts.find((fact) => fact.startsWith('CTR '))).toContain('unchanged on the previous period');
    expect(report.topCampaigns[0]?.previous?.conversions).toBe(10);
  });

  it.each([
    ['equal', 'purchase', 'purchase'],
    ['absent on both', undefined, undefined],
    ['absent on the current snapshot', undefined, 'purchase'],
    ['absent on the previous snapshot', 'lead', undefined],
  ])('compares conversion metrics when the definitions are %s', (_label, now, before) => {
    const report = buildKpiReport({
      current: snapshot('now', 100, 1100, now),
      previous: snapshot('before', 10, 1000, before),
      account,
    });
    const byMetric = new Map(report.deltas.map((delta) => [delta.metric, delta]));
    expect(byMetric.get('conversions')?.change).toBeCloseTo(9);
    expect(byMetric.get('conversionValue')?.change).toBeCloseTo(9);
    expect(byMetric.get('conversionRate')?.change).toBeCloseTo(9);
    expect(byMetric.get('cpa')?.change).toBeCloseTo(11 / 100 - 1);
    expect(byMetric.get('roas')?.change).not.toBeNull();
    expect(report.facts.some((fact) => fact.startsWith('Conversions are not comparable'))).toBe(false);
    expect(report.facts.find((fact) => fact.startsWith('Conversions '))).toContain('up 900.0% on the previous period (10)');
  });

  it('adds no comparability fact without a previous period', () => {
    const report = buildKpiReport({ current: snapshot('now', 100, 1100, 'lead'), previous: null, account });
    expect(report.facts.some((fact) => fact.startsWith('Conversions are not comparable'))).toBe(false);
  });
});
