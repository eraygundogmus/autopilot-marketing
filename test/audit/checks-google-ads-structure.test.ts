import { describe, expect, it } from 'vitest';
import { googleAdsStructureChecks } from '../../src/audit/checks/google-ads-structure';
import { buildSnapshot } from '../../src/connectors/snapshot';
import { DEFAULT_THRESHOLDS } from '../../src/core/config';
import { addDays } from '../../src/core/dates';
import type { AccountConfig, CheckContext, CheckOutcome, DatasetName, Row } from '../../src/core/types';

const baseAccount: AccountConfig = { id: 'acme-google', platform: 'google_ads', externalId: '1234567890' };

// 30 days, so monthly(x) === x.
const RANGE = { start: '2026-01-01', end: '2026-01-30' };

function context(datasets: Partial<Record<DatasetName, Row[]>>, account: Partial<AccountConfig> = {}): CheckContext {
  const merged: AccountConfig = { ...baseAccount, ...account };
  const snapshot = buildSnapshot({
    account: merged,
    source: 'csv',
    dateRange: RANGE,
    currency: 'USD',
    timezone: 'UTC',
    datasets,
    now: new Date('2026-01-31T00:00:00Z'),
  });
  return { snapshot, account: merged, thresholds: { ...DEFAULT_THRESHOLDS }, judge: null };
}

async function run(id: string, ctx: CheckContext): Promise<CheckOutcome> {
  const check = googleAdsStructureChecks.find((item) => item.id === id);
  if (check === undefined) throw new Error(`missing check ${id}`);
  return check.run(ctx);
}

function campaign(id: string, metrics: Row['metrics'], attrs: Row['attrs'], name = `Campaign ${id}`): Row {
  return { id, name, metrics, attrs: { status: 'ENABLED', ...attrs } };
}

describe('googleAdsStructureChecks', () => {
  it('exports the checks in order for google_ads', () => {
    expect(googleAdsStructureChecks.map((check) => check.id)).toEqual([
      'gads.budget.limited_winners',
      'gads.bidding.rank_limited',
      'gads.structure.low_quality_score',
      'gads.creative.disapproved_ads',
      'gads.tracking.conversion_drop',
      'gads.tracking.conversion_actions',
      'gads.structure.brand_in_nonbrand',
    ]);
    expect(googleAdsStructureChecks.every((check) => check.platform === 'google_ads')).toBe(true);
    expect(googleAdsStructureChecks[0]?.usesConversions).toBe(true);
    expect(googleAdsStructureChecks[6]?.needs).toEqual(['brand_terms']);
  });
});

describe('gads.budget.limited_winners', () => {
  const id = 'gads.budget.limited_winners';

  it('flags an efficient budget-limited campaign and suggests a 15% budget raise', async () => {
    const ctx = context(
      { campaigns: [campaign('c1', { cost: 400, conversions: 20 }, { lostIsBudget: 0.5, dailyBudget: 33.33 }, 'Search "Core"')] },
      { targets: { cpa: 25 } },
    );
    const result = await run(id, ctx);
    expect(result.status).toBe('fail');
    const finding = result.findings[0];
    expect(finding?.entity).toEqual({ level: 'campaign', id: 'c1', name: 'Search "Core"' });
    expect(finding?.observation).toContain('50.0%');
    expect(finding?.observation).toContain('20.00 USD');
    expect(finding?.observation).toContain('"Search "Core""');
    expect(finding?.impact?.kind).toBe('missed_conversions');
    expect(finding?.impact?.monthly).toBeCloseTo(20, 6);
    expect(finding?.evidence[0]?.metrics).toEqual({ cost: 400, conversions: 20, lostIsBudget: 0.5, dailyBudget: 33.33 });
    const action = finding?.suggestedActions?.[0];
    expect(action?.kind).toBe('google_ads.campaign.set_daily_budget');
    expect(action?.params).toEqual({ dailyBudget: 38.33 });
    expect(action?.target.id).toBe('c1');
    expect((action?.rationale ?? '').length).toBeLessThan(200);
  });

  it('gives no action for a shared or unknown budget', async () => {
    const ctx = context({
      campaigns: [
        campaign('c1', { cost: 400, conversions: 20 }, { lostIsBudget: 0.5, dailyBudget: 50, sharedBudget: true }),
        campaign('c2', { cost: 400, conversions: 40 }, { lostIsBudget: 0.5 }),
      ],
    });
    const result = await run(id, ctx);
    expect(result.findings.map((finding) => finding.entity?.id)).toEqual(['c2', 'c1']);
    expect(result.findings.every((finding) => finding.suggestedActions === undefined)).toBe(true);
  });

  it('passes when the CPA is above target or the lost share is small', async () => {
    const ctx = context(
      {
        campaigns: [
          campaign('c1', { cost: 1000, conversions: 20 }, { lostIsBudget: 0.5, dailyBudget: 50 }),
          campaign('c2', { cost: 100, conversions: 20 }, { lostIsBudget: 0.1, dailyBudget: 50 }),
          { id: 'c3', metrics: { cost: 100, conversions: 20 }, attrs: { status: 'PAUSED', lostIsBudget: 0.9 } },
        ],
      },
      { targets: { cpa: 25 } },
    );
    expect(await run(id, ctx)).toEqual({ status: 'pass', findings: [] });
  });

  it('does not call a campaign above the account CPA efficient or raise its budget when no target is set', async () => {
    const ctx = context({
      campaigns: [
        campaign('a', { cost: 5000, conversions: 10 }, { lostIsBudget: 0.4, dailyBudget: 100 }),
        campaign('b', { cost: 3000, conversions: 100 }, { lostIsBudget: 0.5, dailyBudget: 100 }),
      ],
    });
    const result = await run(id, ctx);
    const worst = result.findings.find((finding) => finding.entity?.id === 'a');
    expect(worst?.title).toBe('Budget limits a campaign: "Campaign a"');
    expect(worst?.needsReview).toBe(true);
    expect(worst?.suggestedActions).toBeUndefined();
    const best = result.findings.find((finding) => finding.entity?.id === 'b');
    expect(best?.title).toContain('efficient');
    expect(best?.needsReview).toBe(true);
    expect(best?.observation).toContain('account average of 72.73 USD');
    expect(best?.suggestedActions?.[0]?.params).toEqual({ dailyBudget: 115 });
  });

  it('skips a campaign below the ROAS target', async () => {
    const rows = [
      campaign('a', { cost: 1000, conversions: 20, conversionValue: 1500 }, { lostIsBudget: 0.5, dailyBudget: 100 }),
      campaign('b', { cost: 1000, conversions: 20, conversionValue: 5000 }, { lostIsBudget: 0.5, dailyBudget: 100 }),
    ];
    const result = await run(id, context({ campaigns: rows }, { targets: { roas: 3 } }));
    expect(result.findings.map((finding) => finding.entity?.id)).toEqual(['b']);
  });

  it('does not set needsReview when a CPA target backs the claim', async () => {
    const ctx = context(
      { campaigns: [campaign('c1', { cost: 400, conversions: 20 }, { lostIsBudget: 0.5, dailyBudget: 50 })] },
      { targets: { cpa: 25 } },
    );
    expect((await run(id, ctx)).findings[0]?.needsReview).toBeUndefined();
  });

  it('is not applicable below the conversion threshold', async () => {
    const ctx = context({ campaigns: [campaign('c1', { cost: 50, conversions: 3 }, { lostIsBudget: 0.6, dailyBudget: 50 })] });
    const result = await run(id, ctx);
    expect(result.status).toBe('not_applicable');
    expect(result.findings).toEqual([]);
  });
});

describe('gads.bidding.rank_limited', () => {
  const id = 'gads.bidding.rank_limited';

  it('flags rank-limited campaigns without an action', async () => {
    const ctx = context({ campaigns: [campaign('c1', { impressions: 5000 }, { lostIsRank: 0.45 })] });
    const result = await run(id, ctx);
    expect(result.status).toBe('fail');
    expect(result.findings[0]?.entity?.id).toBe('c1');
    expect(result.findings[0]?.observation).toContain('45.0%');
    expect(result.findings[0]?.recommendation).toContain('Quality Score');
    expect(result.findings[0]?.suggestedActions).toBeUndefined();
  });

  it('passes at or below the threshold and is not applicable below the impression floor', async () => {
    expect((await run(id, context({ campaigns: [campaign('c1', { impressions: 5000 }, { lostIsRank: 0.3 })] }))).status).toBe('pass');
    expect((await run(id, context({ campaigns: [campaign('c1', { impressions: 500 }, { lostIsRank: 0.9 })] }))).status).toBe(
      'not_applicable',
    );
  });
});

describe('gads.structure.low_quality_score', () => {
  const id = 'gads.structure.low_quality_score';
  const keyword = (rowId: string, cost: number, qualityScore: number | null, status = 'ENABLED'): Row => ({
    id: rowId,
    name: `kw ${rowId}`,
    campaignId: 'c1',
    adGroupId: 'g1',
    metrics: { cost },
    attrs: { status, qualityScore },
  });

  it('flags low-score keywords above half the waste floor, largest cost first', async () => {
    // No target CPA and no campaigns: floor = wasteMinCost (25), half = 12.5.
    const ctx = context({ keywords: [keyword('k1', 15, 3), keyword('k2', 90, 2), keyword('k3', 10, 1), keyword('k4', 500, 2, 'PAUSED')] });
    const result = await run(id, ctx);
    expect(result.status).toBe('fail');
    expect(result.findings.map((finding) => finding.entity?.id)).toEqual(['k2', 'k1']);
    expect(result.findings[0]?.entity).toEqual({ level: 'keyword', id: 'k2', name: 'kw k2', campaignId: 'c1', adGroupId: 'g1' });
    expect(result.findings[0]?.observation).toContain('Quality Score 2');
    expect(result.findings[0]?.observation).toContain('90.00 USD');
    expect(result.findings[0]?.impact).toBeUndefined();
    expect(result.findings[0]?.suggestedActions).toBeUndefined();
  });

  it('uses the target CPA for the floor', async () => {
    // floor = 100 * 2 = 200, half = 100.
    const ctx = context({ keywords: [keyword('k1', 90, 2)] }, { targets: { cpa: 100 } });
    expect((await run(id, ctx)).status).toBe('pass');
  });

  it('passes for good scores and is not applicable without scores', async () => {
    expect((await run(id, context({ keywords: [keyword('k1', 90, 8)] }))).status).toBe('pass');
    expect((await run(id, context({ keywords: [keyword('k1', 90, null)] }))).status).toBe('not_applicable');
  });

  it('caps findings at 25', async () => {
    const many = Array.from({ length: 30 }, (_, index) => keyword(`k${index}`, 100 + index, 1));
    const result = await run(id, context({ keywords: many }));
    expect(result.findings).toHaveLength(25);
    expect(result.findings[0]?.entity?.id).toBe('k29');
  });
});

describe('gads.creative.disapproved_ads', () => {
  const id = 'gads.creative.disapproved_ads';
  const ad = (rowId: string, approvalStatus: string, status = 'ENABLED'): Row => ({
    id: rowId,
    name: `Ad ${rowId}`,
    campaignId: 'c1',
    adGroupId: 'g1',
    metrics: { impressions: 12 },
    attrs: { status, approvalStatus },
  });

  it('flags enabled disapproved ads as a risk', async () => {
    const result = await run(id, context({ ads: [ad('a1', 'DISAPPROVED'), ad('a2', 'APPROVED'), ad('a3', 'DISAPPROVED', 'PAUSED')] }));
    expect(result.status).toBe('fail');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.entity).toEqual({ level: 'ad', id: 'a1', name: 'Ad a1', campaignId: 'c1', adGroupId: 'g1' });
    expect(result.findings[0]?.impact).toEqual({ kind: 'risk', monthly: 0, basis: 'disapproved ads do not serve' });
    expect(result.findings[0]?.suggestedActions).toBeUndefined();
  });

  it('passes with approved ads and is not applicable without enabled ads', async () => {
    expect((await run(id, context({ ads: [ad('a2', 'APPROVED')] }))).status).toBe('pass');
    expect((await run(id, context({ ads: [ad('a3', 'DISAPPROVED', 'PAUSED')] }))).status).toBe('not_applicable');
  });
});

describe('gads.tracking.conversion_drop', () => {
  const id = 'gads.tracking.conversion_drop';
  // Lag 3 days: end = 01-27, recent = 01-21..01-27, prior = 01-14..01-20.
  const daily = (priorPerDay: { conversions: number; clicks: number }, recentPerDay: { conversions: number; clicks: number }, from = '2026-01-14'): Row[] => {
    const out: Row[] = [];
    for (let date = from; date <= RANGE.end; date = addDays(date, 1)) {
      const metrics = date <= '2026-01-20' ? priorPerDay : recentPerDay;
      out.push({ id: date, date, metrics: { ...metrics }, attrs: {} });
    }
    return out;
  };

  it('fails once at account level when conversions collapse while clicks hold', async () => {
    const result = await run(id, context({ daily: daily({ conversions: 5, clicks: 100 }, { conversions: 0.5, clicks: 90 }) }));
    expect(result.status).toBe('fail');
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0];
    expect(finding?.entity).toEqual({ level: 'account', id: 'acme-google' });
    expect(finding?.observation).toContain('90.0%');
    expect(finding?.observation).toContain('from 35 in 2026-01-14..2026-01-20 to 3.5 in 2026-01-21..2026-01-27');
    expect(finding?.observation).toContain('700 to 630');
    expect(finding?.recommendation).toContain('conversion tag');
    expect(finding?.evidence).toHaveLength(14);
    expect(finding?.suggestedActions).toBeUndefined();
  });

  it('passes when clicks fell too or the drop is small', async () => {
    expect((await run(id, context({ daily: daily({ conversions: 5, clicks: 100 }, { conversions: 0.5, clicks: 10 }) }))).status).toBe('pass');
    expect((await run(id, context({ daily: daily({ conversions: 5, clicks: 100 }, { conversions: 4, clicks: 100 }) }))).status).toBe('pass');
  });

  it('fails on a drop of exactly the threshold', async () => {
    // Weekly totals 10 -> 2, 15 -> 3, 35 -> 7 and 50 -> 10 at the default 80% drop.
    for (const [prior, recent] of [[10, 2], [15, 3], [35, 7], [50, 10]] as const) {
      const rows = daily({ conversions: 0, clicks: 100 }, { conversions: 0, clicks: 100 });
      const first = rows.find((row) => row.date === '2026-01-14');
      const later = rows.find((row) => row.date === '2026-01-21');
      if (first === undefined || later === undefined) throw new Error('missing day');
      first.metrics['conversions'] = prior;
      later.metrics['conversions'] = recent;
      expect((await run(id, context({ daily: rows }))).status).toBe('fail');
    }
  });

  it('is not applicable without coverage of both windows or with too few prior conversions', async () => {
    const short = await run(id, context({ daily: daily({ conversions: 5, clicks: 100 }, { conversions: 0, clicks: 100 }, '2026-01-18') }));
    expect(short.status).toBe('not_applicable');
    expect(short.reason).toContain('2026-01-14..2026-01-27');
    const thin = await run(id, context({ daily: daily({ conversions: 1, clicks: 100 }, { conversions: 0, clicks: 100 }) }));
    expect(thin.status).toBe('not_applicable');
  });
});

describe('gads.tracking.conversion_actions', () => {
  const id = 'gads.tracking.conversion_actions';
  const action = (rowId: string, name: string, attrs: Row['attrs']): Row => ({
    id: rowId,
    name,
    metrics: { conversions: 40 },
    attrs: { status: 'ENABLED', ...attrs },
  });

  it('reports a critical finding when no enabled action is primary', async () => {
    const result = await run(
      id,
      context({
        conversion_actions: [
          action('ca1', 'Newsletter', { primary: false, category: 'SIGNUP' }),
          action('ca2', 'Purchase', { primary: true, category: 'PURCHASE', status: 'REMOVED' }),
        ],
      }),
    );
    expect(result.status).toBe('fail');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.severity).toBe('critical');
    expect(result.findings[0]?.observation).toContain('no primary conversion action');
    expect(result.findings[0]?.entity?.level).toBe('account');
    expect(result.findings[0]?.evidence.map((ref) => ref.rowId)).toEqual(['ca1']);
  });

  it('reports page views counted as primary, by category or by name', async () => {
    const result = await run(
      id,
      context({
        conversion_actions: [
          action('ca1', 'Purchase', { primary: true, category: 'PURCHASE' }),
          action('ca2', 'Key pages', { primary: true, category: 'PAGE_VIEW' }),
          action('ca3', 'Pricing PageView', { primary: true, category: 'DEFAULT' }),
          action('ca4', 'Blog page view', { primary: false, category: 'PAGE_VIEW' }),
        ],
      }),
    );
    expect(result.status).toBe('fail');
    expect(result.findings.map((finding) => finding.entity?.id)).toEqual(['ca2', 'ca3']);
    expect(result.findings.every((finding) => finding.severity === 'medium')).toBe(true);
    expect(result.findings[0]?.observation).toContain('"Key pages"');
    expect(result.findings[0]?.observation).toContain('40 conversions');
    expect(result.findings[0]?.observation).toContain('inflates conversions');
  });

  it('passes with a real primary action and is not applicable with none enabled', async () => {
    expect((await run(id, context({ conversion_actions: [action('ca1', 'Purchase', { primary: true, category: 'PURCHASE' })] }))).status).toBe(
      'pass',
    );
    expect(
      (await run(id, context({ conversion_actions: [action('ca1', 'Purchase', { primary: true, status: 'REMOVED' })] }))).status,
    ).toBe('not_applicable');
  });
});

describe('gads.structure.brand_in_nonbrand', () => {
  const id = 'gads.structure.brand_in_nonbrand';
  const term = (rowId: string, name: string, cost: number, campaignId: string, campaignName: string): Row => ({
    id: rowId,
    name,
    campaignId,
    metrics: { cost, clicks: 3 },
    attrs: { campaignName },
  });
  const account = { brandTerms: ['Acme'] };

  it('groups brand terms by non-brand campaign, largest cost first', async () => {
    const generic = Array.from({ length: 6 }, (_, index) => term(`g${index}`, `acme tool ${index}`, 10 + index, 'c1', 'Generic Search'));
    const result = await run(
      id,
      context(
        {
          search_terms: [
            ...generic,
            term('t7', 'ACME login', 5, 'c2', 'Competitors'),
            term('t8', 'acme', 80, 'c3', 'Brand - Exact'),
            term('t9', 'acme free', 0, 'c2', 'Competitors'),
            term('t10', 'expense software', 40, 'c1', 'Generic Search'),
          ],
        },
        account,
      ),
    );
    expect(result.status).toBe('fail');
    expect(result.findings.map((finding) => finding.entity)).toEqual([
      { level: 'campaign', id: 'c1', name: 'Generic Search' },
      { level: 'campaign', id: 'c2', name: 'Competitors' },
    ]);
    const first = result.findings[0];
    expect(first?.observation).toContain('75.00 USD');
    expect(first?.observation).toContain('6 search terms');
    expect(first?.observation).toContain('"acme tool 5", "acme tool 4", "acme tool 3", "acme tool 2", "acme tool 1" and 1 more');
    expect(first?.evidence).toHaveLength(6);
    expect(first?.needsReview).toBe(true);
    expect(first?.suggestedActions).toBeUndefined();
    expect(first?.recommendation).toContain('negatives');
    expect(result.findings[1]?.observation).toContain('"ACME login"');
  });

  it('passes when brand terms only run in brand campaigns', async () => {
    const result = await run(id, context({ search_terms: [term('t1', 'acme', 80, 'c3', 'Brand - Exact')] }, account));
    expect(result).toEqual({ status: 'pass', findings: [] });
  });

  it.each(['Search - Non-Brand', 'Nonbrand', 'Search_NonBrand', 'Unbranded', 'No Brand'])(
    'flags brand spend in the non-brand campaign %s',
    async (campaignName) => {
      const result = await run(
        id,
        context({ search_terms: [term('t1', 'acme boots', 400, 'c1', campaignName), term('t2', 'acme', 80, 'c2', 'Search - Brand')] }, account),
      );
      expect(result.status).toBe('fail');
      expect(result.findings.map((finding) => finding.entity?.id)).toEqual(['c1']);
    },
  );

  it.each(['Brand_Exact', 'Search - Brand', 'Brand - Exact'])('treats %s as a brand campaign', async (campaignName) => {
    const result = await run(id, context({ search_terms: [term('t1', 'acme', 80, 'c3', campaignName)] }, account));
    expect(result).toEqual({ status: 'pass', findings: [] });
  });

  it('is not applicable when no search term contains a brand term', async () => {
    const result = await run(id, context({ search_terms: [term('t1', 'expense software', 40, 'c1', 'Generic Search')] }, account));
    expect(result.status).toBe('not_applicable');
  });
});
