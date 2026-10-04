import { describe, expect, it, vi } from 'vitest';
import { createGoogleAdsConnector } from '../../src/connectors/google-ads';
import { fetchGoogleAdsSnapshot } from '../../src/connectors/google-ads-read';
import { AutopilotError } from '../../src/core/errors';
import type { AccountConfig, ConnectorDeps, Env, HttpClient, HttpRequest, JsonValue } from '../../src/core/types';

vi.mock('../../src/connectors/google-auth', () => ({
  GOOGLE_ADS_SCOPE: 'https://www.googleapis.com/auth/adwords',
  getGoogleAccessToken: async () => 'tok-123',
  googleAuthMissing: (env: Record<string, string | undefined>) =>
    env['GOOGLE_ADS_REFRESH_TOKEN'] === undefined ? ['GOOGLE_ADS_REFRESH_TOKEN'] : [],
}));

const account: AccountConfig = {
  id: 'acme-google',
  platform: 'google_ads',
  externalId: '123-456-7890',
  loginCustomerId: '999-888-7777',
};
const range = { start: '2026-09-01', end: '2026-09-30' };
const metrics = { impressions: '1000', clicks: '50', costMicros: '1230000', conversions: 2.5, conversionsValue: 99.5 };

type Responder = (query: string) => JsonValue;

function resourceOf(query: string): string {
  return / FROM (\w+)/.exec(query)?.[1] ?? '';
}

const fixtures: Record<string, JsonValue> = {
  customer: [{ results: [{ customer: { currencyCode: 'EUR', timeZone: 'Europe/Istanbul' } }] }],
  campaign: [
    {
      results: [
        {
          campaign: { id: '11', name: 'Brand', status: 'ENABLED', advertisingChannelType: 'SEARCH', biddingStrategyType: 'TARGET_CPA', campaignBudget: 'customers/1234567890/campaignBudgets/77' },
          campaignBudget: { amountMicros: '50000000', explicitlyShared: false },
          metrics: { ...metrics, searchBudgetLostImpressionShare: 0.25, searchRankLostImpressionShare: 0.1 },
          segments: { device: 'MOBILE', date: '2026-09-01' },
        },
      ],
    },
  ],
  ad_group: [{ results: [{ adGroup: { id: '21', name: 'AG', status: 'PAUSED' }, campaign: { id: '11' }, metrics }] }],
  ad_group_ad: [
    {
      results: [
        {
          adGroupAd: {
            ad: { id: '31', name: 'Ad', finalUrls: ['https://example.com/a', 'https://example.com/b'] },
            status: 'ENABLED',
            policySummary: { approvalStatus: 'APPROVED' },
          },
          adGroup: { id: '21' },
          campaign: { id: '11' },
          metrics,
        },
      ],
    },
  ],
  keyword_view: [
    {
      results: [
        {
          adGroupCriterion: {
            criterionId: '41',
            keyword: { text: 'expense app', matchType: 'PHRASE' },
            status: 'ENABLED',
            qualityInfo: { qualityScore: 7 },
            effectiveCpcBidMicros: '1500000',
          },
          adGroup: { id: '21' },
          campaign: { id: '11' },
          metrics,
        },
      ],
    },
  ],
  search_term_view: [
    {
      results: [
        {
          searchTermView: { searchTerm: 'free expense app', status: 'NONE' },
          adGroup: { id: '21' },
          campaign: { id: '11', name: 'Brand' },
          metrics,
        },
      ],
    },
  ],
  conversion_action: [
    {
      results: [
        {
          conversionAction: {
            id: '51',
            name: 'Signup',
            status: 'ENABLED',
            type: 'WEBPAGE',
            category: 'SIGNUP',
            primaryForGoal: true,
            countingType: 'ONE_PER_CLICK',
          },
        },
      ],
    },
  ],
};

function defaultResponder(query: string): JsonValue {
  if (query.includes('segments.date,')) return [{ results: [{ segments: { date: '2026-09-01' }, metrics }] }];
  return fixtures[resourceOf(query)] ?? [];
}

function setup(responder: Responder = defaultResponder, env: Env = {}, acct: AccountConfig = account) {
  const calls: HttpRequest[] = [];
  const http: HttpClient = {
    request: async <T>(request: HttpRequest) => {
      calls.push(request);
      const query = (request.json as { query: string }).query;
      return { status: 200, headers: {}, body: responder(query) as T };
    },
  };
  const deps: ConnectorDeps = { account: acct, env, http, now: () => new Date('2026-10-04T00:00:00Z') };
  return { deps, calls };
}

describe('fetchGoogleAdsSnapshot', () => {
  it('sends the expected request and headers', async () => {
    const { deps, calls } = setup();
    await fetchGoogleAdsSnapshot(deps, { account, dateRange: range });
    expect(calls).toHaveLength(9);
    for (const call of calls) {
      expect(call.url).toBe('https://googleads.googleapis.com/v25/customers/1234567890/googleAds:searchStream');
      expect(call.url).not.toContain('tok-123');
      expect(call.query).toBeUndefined();
      expect(call.method).toBe('POST');
      expect(call.headers).toEqual({ Authorization: 'Bearer tok-123', 'login-customer-id': '9998887777' });
    }
    const queries = calls.map((call) => (call.json as { query: string }).query);
    const dated = queries.filter((query) => query.includes("segments.date BETWEEN '2026-09-01' AND '2026-09-30'"));
    expect(dated).toHaveLength(7);
    expect(queries.some((query) => query.includes("campaign.status != 'REMOVED'"))).toBe(true);
    expect(queries.some((query) => query.endsWith('ORDER BY metrics.cost_micros DESC LIMIT 2000'))).toBe(true);
  });

  it('adds developer-token and the api version only when configured', async () => {
    const plain: AccountConfig = { id: 'a', platform: 'google_ads', externalId: '1234567890', envPrefix: 'ACME_' };
    const { deps, calls } = setup(defaultResponder, {
      ACME_GOOGLE_ADS_DEVELOPER_TOKEN: 'dev-tok',
      GOOGLE_ADS_API_VERSION: 'v26',
    }, plain);
    await fetchGoogleAdsSnapshot(deps, { account: plain, dateRange: range, datasets: ['daily'] });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain('/v26/customers/1234567890/');
    expect(calls[1]?.headers).toEqual({ Authorization: 'Bearer tok-123', 'developer-token': 'dev-tok' });
  });

  it('normalises rows, ids and micros', async () => {
    const { deps } = setup();
    const snapshot = await fetchGoogleAdsSnapshot(deps, { account, dateRange: range });
    expect(snapshot.source).toBe('api');
    expect(snapshot.currency).toBe('EUR');
    expect(snapshot.timezone).toBe('Europe/Istanbul');
    expect(snapshot.externalAccountId).toBe('123-456-7890');
    expect(snapshot.warnings).toEqual([]);

    const core = { impressions: 1000, clicks: 50, cost: 1.23, conversions: 2.5, conversionValue: 99.5 };
    expect(snapshot.datasets.campaigns).toEqual([
      {
        id: '11',
        name: 'Brand',
        metrics: core,
        attrs: {
          status: 'ENABLED',
          channelType: 'SEARCH',
          biddingStrategy: 'TARGET_CPA',
          dailyBudget: 50,
          sharedBudget: false,
          budgetId: 'customers/1234567890/campaignBudgets/77',
          lostIsBudget: 0.25,
          lostIsRank: 0.1,
        },
      },
    ]);
    expect(snapshot.datasets.ad_groups).toEqual([
      { id: '21', name: 'AG', campaignId: '11', metrics: core, attrs: { status: 'PAUSED' } },
    ]);
    expect(snapshot.datasets.ads?.[0]).toMatchObject({
      id: '21~31',
      campaignId: '11',
      adGroupId: '21',
      attrs: { status: 'ENABLED', approvalStatus: 'APPROVED', finalUrl: 'https://example.com/a' },
    });
    expect(snapshot.datasets.keywords?.[0]).toMatchObject({
      id: '21~41',
      name: 'expense app',
      campaignId: '11',
      adGroupId: '21',
      attrs: { status: 'ENABLED', matchType: 'PHRASE', qualityScore: 7, bid: 1.5 },
    });
    expect(snapshot.datasets.search_terms?.[0]).toMatchObject({
      id: '11:21:free expense app',
      name: 'free expense app',
      attrs: { searchTermStatus: 'NONE', campaignName: 'Brand' },
    });
    expect(snapshot.datasets.devices?.[0]).toMatchObject({ id: '11:MOBILE', campaignId: '11', attrs: { device: 'MOBILE' } });
    expect(snapshot.datasets.daily).toEqual([{ id: '2026-09-01', date: '2026-09-01', metrics: core, attrs: {} }]);
    expect(snapshot.datasets.conversion_actions).toEqual([
      {
        id: '51',
        name: 'Signup',
        metrics: {},
        attrs: { status: 'ENABLED', type: 'WEBPAGE', category: 'SIGNUP', primary: true, countingType: 'ONE_PER_CLICK' },
      },
    ]);
    expect(snapshot.coverage.campaigns).toEqual({ status: 'complete', rows: 1 });
  });

  it('selects the budget resource name so shared budgets can be counted once', async () => {
    const { deps, calls } = setup();
    await fetchGoogleAdsSnapshot(deps, { account, dateRange: range });
    const queries = calls.map((call) => JSON.stringify(call.json ?? null));
    expect(queries.some((query) => query.includes('FROM campaign ') && query.includes('campaign.campaign_budget,'))).toBe(true);
  });

  it('falls back to the account currency and timezone', async () => {
    const acct: AccountConfig = { ...account, currency: 'TRY' };
    const { deps } = setup((query) => (resourceOf(query) === 'customer' ? [] : defaultResponder(query)), {}, acct);
    const snapshot = await fetchGoogleAdsSnapshot(deps, { account: acct, dateRange: range, datasets: ['ad_groups'] });
    expect(snapshot.currency).toBe('TRY');
    expect(snapshot.timezone).toBe('UTC');
  });

  it('records a failing dataset as missing while the others load', async () => {
    const { deps } = setup((query) => {
      if (resourceOf(query) === 'keyword_view') throw new AutopilotError('platform_error', 'Google Ads said no');
      return defaultResponder(query);
    });
    const snapshot = await fetchGoogleAdsSnapshot(deps, { account, dateRange: range });
    expect(snapshot.datasets.keywords).toBeUndefined();
    expect(snapshot.coverage.keywords).toEqual({ status: 'missing', rows: 0, note: 'Google Ads said no' });
    expect(snapshot.warnings).toEqual(['keywords: Google Ads said no']);
    expect(snapshot.datasets.campaigns).toHaveLength(1);
    expect(snapshot.coverage.ads?.status).toBe('complete');
  });

  it('marks search terms partial at the 2000-row cap', async () => {
    const results: JsonValue[] = [];
    for (let i = 0; i < 2000; i += 1) {
      results.push({ searchTermView: { searchTerm: `term ${i}`, status: 'NONE' }, adGroup: { id: '21' }, campaign: { id: '11' }, metrics });
    }
    const { deps } = setup((query) =>
      resourceOf(query) === 'search_term_view'
        ? [{ results: results.slice(0, 1200) }, { results: results.slice(1200) }]
        : defaultResponder(query),
    );
    const snapshot = await fetchGoogleAdsSnapshot(deps, { account, dateRange: range, datasets: ['search_terms'] });
    expect(snapshot.datasets.search_terms).toHaveLength(2000);
    expect(snapshot.coverage.search_terms?.status).toBe('partial');
    expect(snapshot.coverage.search_terms?.rows).toBe(2000);
    expect(snapshot.coverage.search_terms?.note).toContain('2000');
    expect(snapshot.warnings).toHaveLength(1);
  });

  it('selects the attribution settings of each conversion action', async () => {
    const { deps, calls } = setup();
    await fetchGoogleAdsSnapshot(deps, { account, dateRange: range, datasets: ['conversion_actions'] });
    const query = calls
      .map((call) => (call.json as { query: string }).query)
      .find((text) => text.endsWith('FROM conversion_action'));
    expect(query).toContain('conversion_action.attribution_model_settings.attribution_model');
    expect(query).toContain('conversion_action.click_through_lookback_window_days');
    expect(query).toContain('conversion_action.view_through_lookback_window_days');
    expect(query).toContain('conversion_action.counting_type');
    expect(query).not.toContain('segments.date');
  });

  it('records the attribution model and lookback windows as attrs', async () => {
    const action = (extra: Record<string, JsonValue>): JsonValue => ({
      conversionAction: { id: '51', name: 'Signup', status: 'ENABLED', countingType: 'ONE_PER_CLICK', ...extra },
    });
    const responder: Responder = (query) =>
      resourceOf(query) === 'conversion_action'
        ? [
            {
              results: [
                action({
                  attributionModelSettings: { attributionModel: 'GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN' },
                  clickThroughLookbackWindowDays: '30',
                  viewThroughLookbackWindowDays: 1,
                }),
                { ...(action({ id: '52', clickThroughLookbackWindowDays: 'n/a', attributionModelSettings: {} }) as object) },
              ],
            },
          ]
        : defaultResponder(query);
    const { deps } = setup(responder);
    const snapshot = await fetchGoogleAdsSnapshot(deps, { account, dateRange: range, datasets: ['conversion_actions'] });
    const rows = snapshot.datasets.conversion_actions ?? [];
    expect(rows[0]?.attrs).toEqual({
      status: 'ENABLED',
      type: null,
      category: null,
      primary: false,
      countingType: 'ONE_PER_CLICK',
      attributionModel: 'GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN',
      clickLookbackDays: 30,
      viewLookbackDays: 1,
    });
    expect(typeof rows[0]?.attrs['clickLookbackDays']).toBe('number');
    expect(rows[1]?.id).toBe('52');
    expect(rows[1]?.attrs).toEqual({ status: 'ENABLED', type: null, category: null, primary: false, countingType: 'ONE_PER_CLICK' });
    expect('attributionModel' in (rows[1]?.attrs ?? {})).toBe(false);
    expect('clickLookbackDays' in (rows[1]?.attrs ?? {})).toBe(false);
    expect('viewLookbackDays' in (rows[1]?.attrs ?? {})).toBe(false);
    expect('attribution' in snapshot).toBe(false);
  });

  it('rejects an invalid range before any request', async () => {
    const { deps, calls } = setup();
    await expect(
      fetchGoogleAdsSnapshot(deps, { account, dateRange: { start: '2026-09-30', end: '2026-09-01' } }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });
});

describe('createGoogleAdsConnector', () => {
  it('reports status without credentials', () => {
    const status = createGoogleAdsConnector(setup().deps).status();
    expect(status.ready).toBe(false);
    expect(status.missingEnv).toEqual(['GOOGLE_ADS_REFRESH_TOKEN']);
    expect(status.platform).toBe('google_ads');
    expect(status.accountId).toBe('acme-google');
    expect(status.source).toBe('api');
  });

  it('reports status with credentials', () => {
    const connector = createGoogleAdsConnector(setup(defaultResponder, { GOOGLE_ADS_REFRESH_TOKEN: 'r' }).deps);
    const status = connector.status();
    expect(connector.platform).toBe('google_ads');
    expect(connector.source).toBe('api');
    expect(status.ready).toBe(true);
    expect(status.missingEnv).toEqual([]);
    expect(status.datasets).toHaveLength(8);
    expect(status.actions).toHaveLength(12);
    expect(status.actions.every((kind) => kind.startsWith('google_ads.'))).toBe(true);
  });
});
