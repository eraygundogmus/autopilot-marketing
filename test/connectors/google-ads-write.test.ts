import { describe, expect, it, vi } from 'vitest';
import { applyGoogleAdsAction, readGoogleAdsState } from '../../src/connectors/google-ads-write';
import { AutopilotError } from '../../src/core/errors';
import type {
  Action,
  ActionDraft,
  ActionKind,
  ConnectorDeps,
  EntityLevel,
  HttpRequest,
  HttpResponse,
  JsonObject,
  JsonValue,
} from '../../src/core/types';

vi.mock('../../src/connectors/google-auth', () => ({
  GOOGLE_ADS_SCOPE: 'https://www.googleapis.com/auth/adwords',
  getGoogleAccessToken: async () => 'test-token',
  googleAuthMissing: () => [],
}));

const BASE = 'https://googleads.googleapis.com/v25/customers/1234567890';

type Handler = (request: HttpRequest) => { body: JsonValue; headers?: Record<string, string> };

function makeDeps(handler: Handler, env: Record<string, string> = {}): { deps: ConnectorDeps; calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  const deps: ConnectorDeps = {
    account: { id: 'acme-google', platform: 'google_ads', externalId: '123-456-7890', loginCustomerId: '111-222-3333' },
    env,
    http: {
      request: async <T = JsonValue>(request: HttpRequest): Promise<HttpResponse<T>> => {
        calls.push(request);
        const out = handler(request);
        return { status: 200, headers: out.headers ?? {}, body: out.body as T };
      },
    },
    now: () => new Date('2026-10-04T00:00:00Z'),
  };
  return { deps, calls };
}

function rows(...results: JsonObject[]): { body: JsonValue } {
  return { body: [{ results }] };
}

function isSearch(request: HttpRequest): boolean {
  return request.url.endsWith('googleAds:searchStream');
}

function queryOf(request: HttpRequest | undefined): string {
  const json = request?.json as { query?: string } | undefined;
  return json?.query ?? '';
}

function draft(kind: ActionKind, level: EntityLevel, id: string, params: JsonObject = {}): ActionDraft {
  return { kind, target: { level, id }, params, rationale: 'test rationale' };
}

function action(kind: ActionKind, level: EntityLevel, id: string, params: JsonObject = {}): Action {
  return {
    ...draft(kind, level, id, params),
    id: 'act_0000000000000000',
    platform: 'google_ads',
    before: null,
    after: {},
    preconditionHash: null,
    spendEffect: 'unknown',
    spendDeltaPerDay: null,
    reversible: 'exact',
    status: 'pending',
  };
}

const LIVE = { validateOnly: false, idempotencyKey: 'key-1' };
const DRY = { validateOnly: true, idempotencyKey: 'key-1' };

describe('readGoogleAdsState', () => {
  it('reads campaign status and budget, with auth headers', async () => {
    const { deps, calls } = makeDeps(() =>
      rows({ campaign: { status: 'ENABLED' }, campaignBudget: { amountMicros: '12340000', explicitlyShared: false } }),
    );
    const state = await readGoogleAdsState(deps, draft('google_ads.campaign.pause', 'campaign', '42'));
    expect(state).toEqual({ status: 'ENABLED', dailyBudget: 12.34 });
    expect(calls[0]?.url).toBe(`${BASE}/googleAds:searchStream`);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers).toEqual({ Authorization: 'Bearer test-token', 'login-customer-id': '1112223333' });
    expect(queryOf(calls[0])).toContain('FROM campaign WHERE campaign.id = 42');
  });

  it('sends the developer token and api version only from env', async () => {
    const { deps, calls } = makeDeps(() => rows({ adGroup: { status: 'PAUSED' } }), {
      GOOGLE_ADS_DEVELOPER_TOKEN: 'dev',
      GOOGLE_ADS_API_VERSION: 'v26',
    });
    const state = await readGoogleAdsState(deps, draft('google_ads.ad_group.enable', 'ad_group', '7'));
    expect(state).toEqual({ status: 'PAUSED' });
    expect(calls[0]?.url).toBe('https://googleads.googleapis.com/v26/customers/1234567890/googleAds:searchStream');
    expect(calls[0]?.headers?.['developer-token']).toBe('dev');
  });

  it('returns a null budget for a shared budget on pause and refuses set_daily_budget', async () => {
    const shared = (): { body: JsonValue } =>
      rows({ campaign: { status: 'PAUSED' }, campaignBudget: { amountMicros: '5000000', explicitlyShared: true } });
    const pause = makeDeps(shared);
    expect(await readGoogleAdsState(pause.deps, draft('google_ads.campaign.enable', 'campaign', '42'))).toEqual({
      status: 'PAUSED',
      dailyBudget: null,
    });
    const budget = makeDeps(shared);
    await expect(
      readGoogleAdsState(budget.deps, draft('google_ads.campaign.set_daily_budget', 'campaign', '42', { dailyBudget: 9 })),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('reads ad and keyword state through composite ids', async () => {
    const ad = makeDeps(() => rows({ adGroupAd: { status: 'ENABLED' } }));
    expect(await readGoogleAdsState(ad.deps, draft('google_ads.ad.pause', 'ad', '5~9'))).toEqual({ status: 'ENABLED' });
    expect(queryOf(ad.calls[0])).toContain('FROM ad_group_ad WHERE ad_group.id = 5 AND ad_group_ad.ad.id = 9');

    const bid = makeDeps(() => rows({ adGroupCriterion: { cpcBidMicros: '1230000' } }));
    expect(await readGoogleAdsState(bid.deps, draft('google_ads.keyword.set_bid', 'keyword', '5~77', { bid: 2 }))).toEqual({
      bid: 1.23,
    });
    expect(queryOf(bid.calls[0])).toContain('WHERE ad_group.id = 5 AND ad_group_criterion.criterion_id = 77');
  });

  it('throws not_found when the entity returns no row', async () => {
    const { deps } = makeDeps(() => ({ body: [] }));
    await expect(readGoogleAdsState(deps, draft('google_ads.keyword.pause', 'keyword', '5~77'))).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('rejects ids that are not numeric before any request', async () => {
    const cases: Array<[ActionKind, EntityLevel, string]> = [
      ['google_ads.campaign.pause', 'campaign', '1 OR 1=1'],
      ['google_ads.campaign.pause', 'campaign', "1'"],
      ['google_ads.ad_group.pause', 'ad_group', '5~9'],
      ['google_ads.ad.pause', 'ad', '5'],
      ['google_ads.keyword.pause', 'keyword', '5~9 OR 1=1'],
      ['google_ads.keyword.set_bid', 'keyword', '5~"9"'],
      ['google_ads.negative_keyword.add', 'campaign', '42; DROP'],
    ];
    for (const [kind, level, id] of cases) {
      const { deps, calls } = makeDeps(() => rows());
      const params = kind.includes('negative') ? { text: 'free', matchType: 'EXACT' } : {};
      await expect(readGoogleAdsState(deps, draft(kind, level, id, params))).rejects.toMatchObject({
        code: 'invalid_input',
      });
      expect(calls).toHaveLength(0);
    }
  });

  it('escapes quotes and backslashes in negative keyword text and validates the match type', async () => {
    const { deps, calls } = makeDeps(() => rows({ campaignCriterion: { criterionId: '900' } }));
    const state = await readGoogleAdsState(
      deps,
      draft('google_ads.negative_keyword.add', 'campaign', '42', { text: "men's \\ free", matchType: 'PHRASE' }),
    );
    expect(state).toEqual({ exists: true });
    expect(queryOf(calls[0])).toBe(
      'SELECT campaign_criterion.criterion_id FROM campaign_criterion WHERE campaign.id = 42 ' +
        "AND campaign_criterion.negative = TRUE AND campaign_criterion.type = 'KEYWORD' " +
        "AND campaign_criterion.keyword.text = 'men\\'s \\\\ free' AND campaign_criterion.keyword.match_type = 'PHRASE' " +
        "AND campaign_criterion.status != 'REMOVED'",
    );
    await expect(
      readGoogleAdsState(
        deps,
        draft('google_ads.negative_keyword.add', 'campaign', '42', { text: 'free', matchType: "EXACT' OR '1'='1" }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('applyGoogleAdsAction', () => {
  it('ignores removed criteria in the lookup before a negative keyword remove', async () => {
    const { deps, calls } = makeDeps((request) => (isSearch(request) ? rows() : { body: {} }));
    await applyGoogleAdsAction(
      deps,
      action('google_ads.negative_keyword.remove', 'campaign', '42', { text: 'free', matchType: 'EXACT' }),
      LIVE,
    );
    const lookup = calls.find(isSearch);
    expect(queryOf(lookup)).toContain("AND campaign_criterion.status != 'REMOVED'");
  });

  it('pauses a campaign with one mutate call', async () => {
    const { deps, calls } = makeDeps(() => ({
      body: { results: [{ resourceName: 'customers/1234567890/campaigns/42' }] },
      headers: { 'Request-Id': 'req-1' },
    }));
    const result = await applyGoogleAdsAction(deps, action('google_ads.campaign.pause', 'campaign', '42'), LIVE);
    expect(result).toEqual({
      ok: true,
      dryRun: false,
      after: null,
      resource: 'customers/1234567890/campaigns/42',
      platformRequestId: 'req-1',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      url: `${BASE}/campaigns:mutate`,
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'login-customer-id': '1112223333' },
      json: {
        operations: [{ update: { resourceName: 'customers/1234567890/campaigns/42', status: 'PAUSED' }, updateMask: 'status' }],
        validateOnly: false,
      },
      retry: false,
    });
    expect(JSON.stringify(calls[0])).not.toContain('key-1');
  });

  it('builds the request for each status kind', async () => {
    const cases: Array<[ActionKind, EntityLevel, string, string, string, string]> = [
      ['google_ads.campaign.enable', 'campaign', '42', 'campaigns:mutate', 'campaigns/42', 'ENABLED'],
      ['google_ads.ad_group.pause', 'ad_group', '5', 'adGroups:mutate', 'adGroups/5', 'PAUSED'],
      ['google_ads.ad_group.enable', 'ad_group', '5', 'adGroups:mutate', 'adGroups/5', 'ENABLED'],
      ['google_ads.ad.pause', 'ad', '5~9', 'adGroupAds:mutate', 'adGroupAds/5~9', 'PAUSED'],
      ['google_ads.ad.enable', 'ad', '5~9', 'adGroupAds:mutate', 'adGroupAds/5~9', 'ENABLED'],
      ['google_ads.keyword.pause', 'keyword', '5~77', 'adGroupCriteria:mutate', 'adGroupCriteria/5~77', 'PAUSED'],
      ['google_ads.keyword.enable', 'keyword', '5~77', 'adGroupCriteria:mutate', 'adGroupCriteria/5~77', 'ENABLED'],
    ];
    for (const [kind, level, id, path, resource, status] of cases) {
      const { deps, calls } = makeDeps(() => ({ body: {} }));
      const result = await applyGoogleAdsAction(deps, action(kind, level, id), DRY);
      const resourceName = `customers/1234567890/${resource}`;
      expect(result).toEqual({ ok: true, dryRun: true, after: null, resource: resourceName });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(`${BASE}/${path}`);
      expect(calls[0]?.retry).toBe(false);
      expect(calls[0]?.json).toEqual({
        operations: [{ update: { resourceName, status }, updateMask: 'status' }],
        validateOnly: true,
      });
    }
  });

  it('sets a keyword bid in micros', async () => {
    const { deps, calls } = makeDeps(() => ({ body: {} }));
    await applyGoogleAdsAction(deps, action('google_ads.keyword.set_bid', 'keyword', '5~77', { bid: 1.23 }), LIVE);
    expect(calls[0]?.url).toBe(`${BASE}/adGroupCriteria:mutate`);
    expect(calls[0]?.retry).toBe(false);
    expect(calls[0]?.json).toEqual({
      operations: [
        {
          update: { resourceName: 'customers/1234567890/adGroupCriteria/5~77', cpcBidMicros: '1230000' },
          updateMask: 'cpc_bid_micros',
        },
      ],
      validateOnly: false,
    });
  });

  it('sets a campaign budget on the budget resource, in micros', async () => {
    const { deps, calls } = makeDeps((request) =>
      isSearch(request)
        ? rows({
            campaign: { status: 'ENABLED', campaignBudget: 'customers/1234567890/campaignBudgets/88' },
            campaignBudget: { amountMicros: '5000000', explicitlyShared: false },
          })
        : { body: { results: [{ resourceName: 'customers/1234567890/campaignBudgets/88' }] } },
    );
    const result = await applyGoogleAdsAction(
      deps,
      action('google_ads.campaign.set_daily_budget', 'campaign', '42', { dailyBudget: 19.99 }),
      LIVE,
    );
    expect(result).toMatchObject({ ok: true, resource: 'customers/1234567890/campaignBudgets/88' });
    expect(calls).toHaveLength(2);
    expect(queryOf(calls[0])).toContain('campaign.campaign_budget');
    expect(calls[1]?.url).toBe(`${BASE}/campaignBudgets:mutate`);
    expect(calls[1]?.retry).toBe(false);
    expect(calls[1]?.json).toEqual({
      operations: [
        {
          update: { resourceName: 'customers/1234567890/campaignBudgets/88', amountMicros: '19990000' },
          updateMask: 'amount_micros',
        },
      ],
      validateOnly: false,
    });
  });

  it('refuses a shared budget without mutating', async () => {
    const { deps, calls } = makeDeps(() =>
      rows({
        campaign: { status: 'ENABLED', campaignBudget: 'customers/1234567890/campaignBudgets/88' },
        campaignBudget: { amountMicros: '5000000', explicitlyShared: true },
      }),
    );
    const result = await applyGoogleAdsAction(
      deps,
      action('google_ads.campaign.set_daily_budget', 'campaign', '42', { dailyBudget: 20 }),
      LIVE,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: 'unsupported', retryable: false });
    expect(calls.every(isSearch)).toBe(true);
  });

  it('adds a negative keyword only when it does not exist', async () => {
    const params = { text: 'free', matchType: 'EXACT' };
    const fresh = makeDeps((request) => (isSearch(request) ? rows() : { body: {} }));
    const added = await applyGoogleAdsAction(
      fresh.deps,
      action('google_ads.negative_keyword.add', 'campaign', '42', params),
      LIVE,
    );
    expect(added.ok).toBe(true);
    expect(fresh.calls[1]?.url).toBe(`${BASE}/campaignCriteria:mutate`);
    expect(fresh.calls[1]?.retry).toBe(false);
    expect(fresh.calls[1]?.json).toEqual({
      operations: [
        {
          create: {
            campaign: 'customers/1234567890/campaigns/42',
            negative: true,
            keyword: { text: 'free', matchType: 'EXACT' },
          },
        },
      ],
      validateOnly: false,
    });

    const existing = makeDeps(() => rows({ campaignCriterion: { criterionId: '900' } }));
    const skipped = await applyGoogleAdsAction(
      existing.deps,
      action('google_ads.negative_keyword.add', 'campaign', '42', params),
      LIVE,
    );
    expect(skipped).toEqual({ ok: true, dryRun: false, after: null });
    expect(existing.calls.every(isSearch)).toBe(true);
  });

  it('removes a negative keyword by criterion id, and is a no-op when absent', async () => {
    const params = { text: 'free', matchType: 'BROAD' };
    const present = makeDeps((request) =>
      isSearch(request) ? rows({ campaignCriterion: { criterionId: '900' } }) : { body: {} },
    );
    const removed = await applyGoogleAdsAction(
      present.deps,
      action('google_ads.negative_keyword.remove', 'campaign', '42', params),
      LIVE,
    );
    expect(removed).toMatchObject({ ok: true, resource: 'customers/1234567890/campaignCriteria/42~900' });
    expect(present.calls[1]?.json).toEqual({
      operations: [{ remove: 'customers/1234567890/campaignCriteria/42~900' }],
      validateOnly: false,
    });
    expect(present.calls[1]?.retry).toBe(false);

    const absent = makeDeps(() => rows());
    const result = await applyGoogleAdsAction(
      absent.deps,
      action('google_ads.negative_keyword.remove', 'campaign', '42', params),
      LIVE,
    );
    expect(result).toEqual({ ok: true, dryRun: false, after: null });
    expect(absent.calls.every(isSearch)).toBe(true);
  });

  it('returns ok:false for an injected id without calling the API', async () => {
    const { deps, calls } = makeDeps(() => ({ body: {} }));
    const result = await applyGoogleAdsAction(deps, action('google_ads.campaign.pause', 'campaign', '1 OR 1=1'), LIVE);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  it('returns ok:false when the platform rejects the change', async () => {
    const { deps } = makeDeps(() => {
      throw new AutopilotError('platform_error', 'HTTP 400: invalid status', { retryable: false });
    });
    const result = await applyGoogleAdsAction(deps, action('google_ads.campaign.pause', 'campaign', '42'), LIVE);
    expect(result).toEqual({
      ok: false,
      dryRun: false,
      after: null,
      error: { code: 'platform_error', message: 'HTTP 400: invalid status', retryable: false },
    });
  });

  it('rethrows a retryable failure on a live call and reports it on validateOnly', async () => {
    const failing: Handler = () => {
      throw new AutopilotError('platform_error', 'HTTP 500', { retryable: true });
    };
    const live = makeDeps(failing);
    await expect(
      applyGoogleAdsAction(live.deps, action('google_ads.campaign.pause', 'campaign', '42'), LIVE),
    ).rejects.toMatchObject({ code: 'platform_error', retryable: true });

    const dry = makeDeps(failing);
    const result = await applyGoogleAdsAction(dry.deps, action('google_ads.campaign.pause', 'campaign', '42'), DRY);
    expect(result).toEqual({
      ok: false,
      dryRun: true,
      after: null,
      error: { code: 'platform_error', message: 'HTTP 500', retryable: true },
    });
  });
});

describe('applyGoogleAdsAction beforeWrite', () => {
  const budgetRow = (): { body: JsonValue } =>
    rows({
      campaign: { status: 'ENABLED', campaignBudget: 'customers/1234567890/campaignBudgets/9' },
      campaignBudget: { amountMicros: '5000000', explicitlyShared: false },
    });

  function recording(): { deps: ConnectorDeps; calls: HttpRequest[]; events: string[] } {
    const events: string[] = [];
    const made = makeDeps((request) => {
      events.push(isSearch(request) ? 'read' : 'write');
      return isSearch(request) ? budgetRow() : { body: { results: [{ resourceName: 'r' }] } };
    });
    return { ...made, events };
  }

  it('calls beforeWrite once, after the read and directly before the mutate', async () => {
    const { deps, events } = recording();
    const result = await applyGoogleAdsAction(
      deps,
      action('google_ads.campaign.set_daily_budget', 'campaign', '42', { dailyBudget: 20 }),
      { ...LIVE, beforeWrite: () => void events.push('beforeWrite') },
    );
    expect(result.ok).toBe(true);
    expect(events).toEqual(['read', 'beforeWrite', 'write']);
  });

  it('lets a beforeWrite error through unchanged and sends no mutate', async () => {
    for (const refusal of [new Error('lock lost'), new AutopilotError('platform_error', 'taken over')]) {
      const { deps, calls } = recording();
      const pending = applyGoogleAdsAction(deps, action('google_ads.campaign.pause', 'campaign', '42'), {
        ...LIVE,
        beforeWrite: () => {
          throw refusal;
        },
      });
      await expect(pending).rejects.toBe(refusal);
      expect(calls.filter((call) => !isSearch(call))).toHaveLength(0);
    }
  });

  it('never calls beforeWrite on validateOnly', async () => {
    const { deps, calls } = recording();
    const beforeWrite = vi.fn();
    const result = await applyGoogleAdsAction(deps, action('google_ads.campaign.pause', 'campaign', '42'), {
      ...DRY,
      beforeWrite,
    });
    expect(result).toMatchObject({ ok: true, dryRun: true });
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(calls.filter((call) => !isSearch(call))).toHaveLength(1);
  });

  it('sends the same requests with and without beforeWrite', async () => {
    const without = recording();
    const withGuard = recording();
    const act = action('google_ads.campaign.pause', 'campaign', '42');
    const a = await applyGoogleAdsAction(without.deps, act, LIVE);
    const b = await applyGoogleAdsAction(withGuard.deps, act, { ...LIVE, beforeWrite: () => undefined });
    expect(a).toEqual(b);
    expect(without.calls).toEqual(withGuard.calls);
  });
});
