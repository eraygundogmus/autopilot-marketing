import { describe, expect, it } from 'vitest';
import { metaAdsChecks } from '../../src/audit/checks/meta-ads';
import { buildSnapshot } from '../../src/connectors/snapshot';
import { DEFAULT_THRESHOLDS } from '../../src/core/config';
import { ACTION_KINDS } from '../../src/core/types';
import type { AccountConfig, AccountTargets, CheckContext, CheckOutcome, Metrics, Row, Snapshot } from '../../src/core/types';

// 30 days, so monthly(x) === x.
const RANGE = { start: '2026-01-01', end: '2026-01-30' };

function context(datasets: Snapshot['datasets'], targets?: AccountTargets): CheckContext {
  const account: AccountConfig = { id: 'acme-meta', platform: 'meta_ads', externalId: 'act_1' };
  if (targets !== undefined) account.targets = targets;
  const snapshot = buildSnapshot({
    account,
    source: 'demo',
    dateRange: RANGE,
    currency: 'USD',
    timezone: 'UTC',
    datasets,
    now: new Date('2026-01-31T00:00:00.000Z'),
  });
  return { snapshot, account, thresholds: { ...DEFAULT_THRESHOLDS }, judge: null };
}

function row(id: string, metrics: Metrics, attrs: Row['attrs'] = { status: 'ENABLED' }, extra: Partial<Row> = {}): Row {
  return { id, name: `Name ${id}`, metrics, attrs, ...extra };
}

async function run(id: string, ctx: CheckContext): Promise<CheckOutcome> {
  const check = metaAdsChecks.find((item) => item.id === id);
  if (check === undefined) throw new Error(`no check ${id}`);
  return check.run(ctx);
}

function daily(conversionsRecent: number, clicksRecent: number, from = '2026-01-01'): Row[] {
  // end = 2026-01-27 with a 3 day lag: prior 01-14..01-20, recent 01-21..01-27.
  const out: Row[] = [];
  for (let day = Number(from.slice(8)); day <= 30; day += 1) {
    const date = `2026-01-${String(day).padStart(2, '0')}`;
    const recent = date >= '2026-01-21';
    out.push({
      id: date,
      date,
      metrics: { clicks: recent ? clicksRecent : 100, conversions: recent ? conversionsRecent : 5 },
      attrs: {},
    });
  }
  return out;
}

describe('metaAdsChecks', () => {
  it('lists the nine checks in order with valid metadata', () => {
    expect(metaAdsChecks.map((check) => check.id)).toEqual([
      'meta.waste.adsets_no_conversions',
      'meta.bidding.high_cpa_adsets',
      'meta.bidding.low_roas_campaigns',
      'meta.creative.low_link_ctr',
      'meta.creative.fatigue',
      'meta.structure.landing_view_rate',
      'meta.budget.learning_limited',
      'meta.bidding.placement_outlier',
      'meta.tracking.conversion_drop',
    ]);
    expect(metaAdsChecks.every((check) => check.platform === 'meta_ads')).toBe(true);
    expect(metaAdsChecks.filter((check) => check.usesConversions).map((check) => check.id)).toEqual([
      'meta.waste.adsets_no_conversions',
      'meta.bidding.high_cpa_adsets',
      'meta.bidding.low_roas_campaigns',
      'meta.budget.learning_limited',
      'meta.bidding.placement_outlier',
    ]);
  });

  describe('meta.waste.adsets_no_conversions', () => {
    const id = 'meta.waste.adsets_no_conversions';

    it('flags spend without conversions and suggests a pause at 30 clicks', async () => {
      const ctx = context(
        {
          ad_groups: [
            row('as1', { cost: 150, clicks: 40, conversions: 0 }, { status: 'ENABLED' }, { campaignId: 'c1' }),
            row('as2', { cost: 300, clicks: 10, conversions: 0 }),
            row('as3', { cost: 500, clicks: 90, conversions: 0 }, { status: 'PAUSED' }),
            row('as4', { cost: 90, clicks: 90, conversions: 0 }),
          ],
        },
        { cpa: 50 },
      );
      const result = await run(id, ctx);
      expect(result.status).toBe('fail');
      expect(result.findings.map((finding) => finding.entity?.id)).toEqual(['as2', 'as1']);
      const [limited, full] = result.findings;
      expect(limited?.dataStatus).toBe('limited');
      expect(limited?.suggestedActions).toBeUndefined();
      expect(full?.entity).toEqual({ level: 'ad_group', id: 'as1', name: 'Name as1', campaignId: 'c1' });
      expect(full?.observation).toContain('"Name as1"');
      expect(full?.observation).toContain('150.00 USD');
      expect(full?.impact).toMatchObject({ kind: 'wasted_spend', monthly: 150 });
      expect(full?.dataStatus).toBeUndefined();
      expect(full?.suggestedActions?.[0]).toMatchObject({ kind: 'meta_ads.adset.pause', params: {}, target: { id: 'as1' } });
      expect(ACTION_KINDS).toContain(full?.suggestedActions?.[0]?.kind);
      expect(full?.suggestedActions?.[0]?.rationale.length).toBeLessThan(200);
      expect(full?.evidence[0]).toMatchObject({ dataset: 'ad_groups', rowId: 'as1', metrics: { cost: 150, clicks: 40, conversions: 0 } });
    });

    it('uses wasteMinCost without a reference CPA, passes and reports not applicable', async () => {
      const failing = await run(id, context({ ad_groups: [row('as1', { cost: 25, clicks: 30, conversions: 0 })] }));
      expect(failing.status).toBe('fail');
      const passing = await run(id, context({ ad_groups: [row('as1', { cost: 24, clicks: 30, conversions: 0 })] }));
      expect(passing).toEqual({ status: 'pass', findings: [] });
      const none = await run(id, context({ ad_groups: [row('as1', { cost: 900 }, { status: 'PAUSED' })] }));
      expect(none.status).toBe('not_applicable');
    });

    it('keeps at most 25 findings, largest impact first', async () => {
      const adSets = Array.from({ length: 30 }, (_, index) => row(`as${index}`, { cost: 100 + index, clicks: 50, conversions: 0 }));
      const result = await run(id, context({ ad_groups: adSets }));
      expect(result.findings).toHaveLength(25);
      expect(result.findings[0]?.entity?.id).toBe('as29');
    });
  });

  describe('meta.bidding.high_cpa_adsets', () => {
    const id = 'meta.bidding.high_cpa_adsets';

    it('flags a CPA above the multiple of target', async () => {
      const result = await run(
        id,
        context({ ad_groups: [row('as1', { cost: 1000, conversions: 10 }), row('as2', { cost: 700, conversions: 10 })] }, { cpa: 50 }),
      );
      expect(result.status).toBe('fail');
      expect(result.findings).toHaveLength(1);
      const finding = result.findings[0];
      expect(finding?.entity?.id).toBe('as1');
      expect(finding?.observation).toContain('100.00 USD');
      expect(finding?.observation).toContain('50.00 USD');
      expect(finding?.impact).toMatchObject({ kind: 'wasted_spend', monthly: 500 });
      expect(finding?.suggestedActions).toBeUndefined();
    });

    it('passes at the boundary and is not applicable below the conversion threshold', async () => {
      const passing = await run(id, context({ ad_groups: [row('as1', { cost: 750, conversions: 10 })] }, { cpa: 50 }));
      expect(passing.status).toBe('pass');
      const none = await run(id, context({ ad_groups: [row('as1', { cost: 5000, conversions: 9 })] }, { cpa: 50 }));
      expect(none.status).toBe('not_applicable');
    });
  });

  describe('meta.bidding.low_roas_campaigns', () => {
    const id = 'meta.bidding.low_roas_campaigns';

    it('flags a ROAS below the multiple of target', async () => {
      const result = await run(
        id,
        context({ campaigns: [row('c1', { cost: 1000, conversions: 20, conversionValue: 1500 })] }, { roas: 3 }),
      );
      expect(result.status).toBe('fail');
      const finding = result.findings[0];
      expect(finding?.entity).toMatchObject({ level: 'campaign', id: 'c1' });
      expect(finding?.observation).toContain('1.50');
      expect(finding?.impact).toMatchObject({ kind: 'missed_revenue', monthly: 1500 });
    });

    it('passes above the line and is not applicable without value', async () => {
      const passing = await run(id, context({ campaigns: [row('c1', { cost: 1000, conversions: 20, conversionValue: 2100 })] }, { roas: 3 }));
      expect(passing.status).toBe('pass');
      const none = await run(id, context({ campaigns: [row('c1', { cost: 1000, conversions: 20, conversionValue: 0 })] }, { roas: 3 }));
      expect(none.status).toBe('not_applicable');
    });
  });

  describe('meta.creative.low_link_ctr', () => {
    const id = 'meta.creative.low_link_ctr';

    it('flags a low link CTR on enough impressions', async () => {
      const result = await run(
        id,
        context({ ads: [row('ad1', { impressions: 10000, linkClicks: 50 }), row('ad2', { impressions: 10000, linkClicks: 80 })] }),
      );
      expect(result.status).toBe('fail');
      expect(result.findings).toHaveLength(1);
      const finding = result.findings[0];
      expect(finding?.entity).toMatchObject({ level: 'ad', id: 'ad1' });
      expect(finding?.observation).toContain('0.5%');
      expect(finding?.recommendation).toMatch(/hook/);
      expect(finding?.suggestedActions).toBeUndefined();
      expect(finding?.evidence[0]?.metrics).toEqual({ impressions: 10000, linkClicks: 50 });
    });

    it('is not applicable below 3x minImpressions', async () => {
      const result = await run(id, context({ ads: [row('ad1', { impressions: 2999, linkClicks: 0 })] }));
      expect(result.status).toBe('not_applicable');
    });
  });

  describe('meta.creative.fatigue', () => {
    const id = 'meta.creative.fatigue';
    const tired = (attrs: Row['attrs'] = { status: 'ENABLED', frequency: 4 }): Row =>
      row('ad1', { impressions: 10000, linkClicks: 50, cost: 100 }, attrs, { adGroupId: 'as1' });

    it('flags a frequent ad far below its ad set and pauses it when another ad is enabled', async () => {
      const other = row('ad2', { impressions: 10000, linkClicks: 250 }, { status: 'ENABLED', frequency: 1.5 }, { adGroupId: 'as1' });
      const result = await run(id, context({ ads: [tired(), other] }));
      expect(result.status).toBe('fail');
      expect(result.findings).toHaveLength(1);
      const finding = result.findings[0];
      expect(finding?.entity).toMatchObject({ level: 'ad', id: 'ad1', adGroupId: 'as1' });
      // Pooled link CTR 300 / 20000 = 1.5%; the ad's 0.5% is 66.7% below it.
      expect(finding?.observation).toContain('4.0');
      expect(finding?.observation).toContain('0.5%');
      expect(finding?.observation).toContain('1.5%');
      expect(finding?.observation).toContain('66.7%');
      expect(finding?.recommendation).toMatch(/[Rr]efresh the creative/);
      expect(finding?.suggestedActions?.[0]).toMatchObject({ kind: 'meta_ads.ad.pause', params: {}, target: { id: 'ad1' } });
      expect(finding?.evidence[0]?.metrics).toEqual({ impressions: 10000, linkClicks: 50, frequency: 4 });
    });

    it('suggests no pause when the other ad is paused', async () => {
      const other = row('ad2', { impressions: 10000, linkClicks: 250 }, { status: 'PAUSED', frequency: 1.5 }, { adGroupId: 'as1' });
      const result = await run(id, context({ ads: [tired(), other] }));
      expect(result.status).toBe('fail');
      expect(result.findings[0]?.suggestedActions).toBeUndefined();
    });

    it('marks an ad below 3x minImpressions as limited and drafts no pause', async () => {
      const thin = (impressions: number): Row =>
        row('adx', { impressions, linkClicks: 0, cost: 5 }, { status: 'ENABLED', frequency: 3.4 }, { adGroupId: 'as1' });
      const other = row('ady', { impressions: 20000, linkClicks: 300 }, { status: 'ENABLED', frequency: 1.2 }, { adGroupId: 'as1' });
      const result = await run(id, context({ ads: [thin(60), other] }));
      expect(result.status).toBe('fail');
      expect(result.findings).toHaveLength(1);
      const finding = result.findings[0];
      expect(finding?.entity?.id).toBe('adx');
      expect(finding?.dataStatus).toBe('limited');
      expect(finding?.suggestedActions).toBeUndefined();
      expect(finding?.recommendation).toMatch(/enough impressions/);
      expect(finding?.recommendation).not.toMatch(/pause this ad/);

      const below = (await run(id, context({ ads: [thin(2999), other] }))).findings[0];
      expect(below?.dataStatus).toBe('limited');
      expect(below?.suggestedActions).toBeUndefined();
      const atFloor = (await run(id, context({ ads: [thin(3000), other] }))).findings[0];
      expect(atFloor?.dataStatus).toBeUndefined();
      expect(atFloor?.suggestedActions?.[0]).toMatchObject({ kind: 'meta_ads.ad.pause', target: { id: 'adx' } });
    });

    it('passes below the frequency threshold and is not applicable without frequency', async () => {
      const other = row('ad2', { impressions: 10000, linkClicks: 250 }, { status: 'ENABLED', frequency: 1.5 }, { adGroupId: 'as1' });
      const passing = await run(id, context({ ads: [tired({ status: 'ENABLED', frequency: 2.9 }), other] }));
      expect(passing.status).toBe('pass');
      const none = await run(id, context({ ads: [tired({ status: 'ENABLED' })] }));
      expect(none.status).toBe('not_applicable');
    });
  });

  describe('meta.structure.landing_view_rate', () => {
    const id = 'meta.structure.landing_view_rate';

    it('flags a low landing page view rate', async () => {
      const result = await run(
        id,
        context({
          ad_groups: [
            row('as1', { linkClicks: 200, landingPageViews: 100 }),
            row('as2', { linkClicks: 200, landingPageViews: 150 }),
            row('as3', { linkClicks: 500 }),
          ],
        }),
      );
      expect(result.status).toBe('fail');
      expect(result.findings).toHaveLength(1);
      const finding = result.findings[0];
      expect(finding?.entity).toMatchObject({ level: 'ad_group', id: 'as1' });
      expect(finding?.observation).toContain('50.0%');
      expect(finding?.recommendation).toMatch(/redirects/);
      expect(finding?.suggestedActions).toBeUndefined();
    });

    it('passes, and skips rows without the metric or enough link clicks', async () => {
      const passing = await run(id, context({ ad_groups: [row('as1', { linkClicks: 200, landingPageViews: 150 })] }));
      expect(passing.status).toBe('pass');
      const none = await run(
        id,
        context({ ad_groups: [row('as1', { linkClicks: 99, landingPageViews: 1 }), row('as2', { linkClicks: 500 })] }),
      );
      expect(none.status).toBe('not_applicable');
    });
  });

  describe('meta.budget.learning_limited', () => {
    const id = 'meta.budget.learning_limited';

    it('flags a failed learning status and a slow conversion pace', async () => {
      const result = await run(
        id,
        context({
          ad_groups: [
            row('as1', { cost: 10, conversions: 0 }, { status: 'ENABLED', learningStatus: 'FAIL' }),
            row('as2', { cost: 400, conversions: 60 }),
            row('as3', { cost: 400, conversions: 300 }),
            row('as4', { cost: 20, conversions: 3 }),
          ],
        }),
      );
      expect(result.status).toBe('fail');
      expect(result.findings.map((finding) => finding.entity?.id)).toEqual(['as2', 'as1']);
      // 60 conversions over 30 days = 14.0 per 7 days.
      expect(result.findings[0]?.observation).toContain('14.0 conversions per 7 days');
      expect(result.findings[0]?.observation).toContain('400.00 USD');
      expect(result.findings[0]?.recommendation).toMatch(/[Cc]onsolidat/);
      expect(result.findings[0]?.suggestedActions).toBeUndefined();
    });

    it('passes with enough events and is not applicable without active ad sets', async () => {
      const passing = await run(id, context({ ad_groups: [row('as1', { cost: 400, conversions: 300 })] }));
      expect(passing.status).toBe('pass');
      const none = await run(id, context({ ad_groups: [] }));
      expect(none.status).toBe('not_applicable');
    });
  });

  describe('meta.bidding.placement_outlier', () => {
    const id = 'meta.bidding.placement_outlier';
    const adSet = row('as1', { cost: 1000, conversions: 20 });
    const placement = (name: string, metrics: Metrics): Row => ({
      id: `as1:${name}`,
      adGroupId: 'as1',
      metrics,
      attrs: { placement: name },
    });

    it('flags an expensive placement and one with no conversions', async () => {
      const result = await run(
        id,
        context({
          ad_groups: [adSet],
          placements: [
            placement('audience_network', { cost: 400, conversions: 2 }),
            placement('feed', { cost: 350, conversions: 18 }),
            placement('reels', { cost: 200, conversions: 0 }),
            placement('stories', { cost: 50, conversions: 0 }),
          ],
        }),
      );
      expect(result.status).toBe('fail');
      expect(result.findings).toHaveLength(2);
      const [first, second] = result.findings;
      // Ad set CPA 50: 400 - 2 * 50 = 300.
      expect(first?.observation).toContain('"audience_network"');
      expect(first?.observation).toContain('200.00 USD');
      expect(first?.observation).toContain('50.00 USD');
      expect(first?.impact).toMatchObject({ kind: 'wasted_spend', monthly: 300 });
      expect(first?.entity).toMatchObject({ level: 'ad_group', id: 'as1' });
      expect(first?.evidence.map((ref) => ref.rowId)).toEqual(['as1:audience_network', 'as1']);
      expect(first?.recommendation).toMatch(/[Ee]xclude/);
      expect(first?.suggestedActions).toBeUndefined();
      expect(second?.observation).toContain('"reels"');
      expect(second?.impact?.monthly).toBe(200);
    });

    it('passes for a balanced placement and is not applicable below the cost share', async () => {
      const passing = await run(
        id,
        context({ ad_groups: [adSet], placements: [placement('feed', { cost: 500, conversions: 10 })] }),
      );
      expect(passing.status).toBe('pass');
      const none = await run(
        id,
        context({ ad_groups: [adSet], placements: [placement('stories', { cost: 99, conversions: 0 })] }),
      );
      expect(none.status).toBe('not_applicable');
    });
  });

  describe('meta.tracking.conversion_drop', () => {
    const id = 'meta.tracking.conversion_drop';

    it('fails when conversions collapse while clicks hold', async () => {
      const result = await run(id, context({ daily: daily(1, 90) }));
      expect(result.status).toBe('fail');
      const finding = result.findings[0];
      // Prior 35 conversions and 700 clicks; recent 7 and 630.
      expect(finding?.observation).toContain('80.0%');
      expect(finding?.observation).toContain('from 35 in 2026-01-14..2026-01-20 to 7 in 2026-01-21..2026-01-27');
      expect(finding?.observation).toContain('700 to 630');
      expect(finding?.recommendation).toMatch(/pixel and the Conversions API/);
      expect(finding?.evidence).toHaveLength(14);
      expect(finding?.impact).toMatchObject({ kind: 'risk', monthly: 0 });
      expect(finding?.suggestedActions).toBeUndefined();
    });

    it('passes when clicks fell too or conversions held', async () => {
      expect((await run(id, context({ daily: daily(1, 50) }))).status).toBe('pass');
      expect((await run(id, context({ daily: daily(4, 100) }))).status).toBe('pass');
    });

    it('is not applicable when the rows do not cover both windows', async () => {
      expect((await run(id, context({ daily: daily(1, 90, '2026-01-15') }))).status).toBe('not_applicable');
      expect((await run(id, context({ daily: [] }))).status).toBe('not_applicable');
    });
  });
});
