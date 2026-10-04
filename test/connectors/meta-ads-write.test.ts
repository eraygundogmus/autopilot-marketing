import { describe, expect, it } from 'vitest';
import { applyMetaAdsAction, readMetaAdsState } from '../../src/connectors/meta-ads-write';
import { AutopilotError } from '../../src/core/errors';
import type {
  AccountConfig,
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
import { buildAction } from '../../src/plan/actions';

const TOKEN = 'secret-token-123';
const BASE = 'https://graph.facebook.com/v26.0';

type Handler = (request: HttpRequest) => JsonValue | Error;

function makeDeps(handler: Handler, account: Partial<AccountConfig> = {}, env: Record<string, string> = {}) {
  const requests: HttpRequest[] = [];
  const deps: ConnectorDeps = {
    account: { id: 'acme-meta', platform: 'meta_ads', externalId: '1234', currency: 'USD', ...account },
    env: { META_ACCESS_TOKEN: TOKEN, ...env },
    http: {
      request: async <T = JsonValue>(request: HttpRequest): Promise<HttpResponse<T>> => {
        requests.push(request);
        const out = handler(request);
        if (out instanceof Error) throw out;
        return { status: 200, headers: {}, body: out as T };
      },
    },
    now: () => new Date('2026-10-04T00:00:00Z'),
  };
  return { deps, requests };
}

const LEVELS: Record<string, EntityLevel> = { campaign: 'campaign', adset: 'ad_group', ad: 'ad' };

function draft(kind: ActionKind, params: JsonObject = {}, id = '111'): ActionDraft {
  const level = LEVELS[kind.split('.')[1] ?? ''] ?? 'campaign';
  return { kind, target: { level, id }, params, rationale: 'test' };
}

function action(kind: ActionKind, params: JsonObject = {}, before: JsonObject | null = null): Action {
  return buildAction(draft(kind, params), before);
}

const OPTIONS = { validateOnly: false, idempotencyKey: 'key-1' };

function expectNoTokenOutsideHeader(requests: HttpRequest[]): void {
  for (const request of requests) {
    expect(request.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    const { headers: _headers, ...rest } = request;
    expect(JSON.stringify(rest)).not.toContain(TOKEN);
  }
}

/** Graph API double: the target belongs to `accountId`, and every POST succeeds. */
function owned(accountId = '1234'): Handler {
  return (request) => (request.method === 'POST' ? { success: true } : { account_id: accountId });
}

function failingPost(failure: Error): Handler {
  return (request) => (request.method === 'POST' ? failure : { account_id: '1234' });
}

describe('readMetaAdsState', () => {
  it('reads status and daily budget for a campaign pause', async () => {
    const { deps, requests } = makeDeps(() => ({ status: 'ACTIVE', daily_budget: '5000', id: '111', account_id: '1234' }));
    const state = await readMetaAdsState(deps, draft('meta_ads.campaign.pause'));
    expect(state).toEqual({ status: 'ENABLED', dailyBudget: 50 });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: `${BASE}/111`,
      method: 'GET',
      query: { fields: 'status,daily_budget,lifetime_budget,account_id' },
    });
    expectNoTokenOutsideHeader(requests);
  });

  it('returns a null daily budget when the ad set has none', async () => {
    const { deps } = makeDeps(() => ({ status: 'PAUSED', daily_budget: '0', lifetime_budget: '90000', account_id: '1234' }));
    const state = await readMetaAdsState(deps, draft('meta_ads.adset.enable'));
    expect(state).toEqual({ status: 'PAUSED', dailyBudget: null });
  });

  it('returns only status for an ad and maps archived to REMOVED', async () => {
    const { deps } = makeDeps(() => ({ status: 'ARCHIVED', account_id: '1234' }));
    expect(await readMetaAdsState(deps, draft('meta_ads.ad.pause'))).toEqual({ status: 'REMOVED' });
  });

  it('fetches the account currency when it is not configured and treats JPY as zero-decimal', async () => {
    const { deps, requests } = makeDeps(
      (request) => (request.url.endsWith('/act_1234') ? { currency: 'JPY' } : { daily_budget: '5000', account_id: '1234' }),
      { currency: undefined as unknown as string },
    );
    delete deps.account.currency;
    const state = await readMetaAdsState(deps, draft('meta_ads.adset.set_daily_budget', { dailyBudget: 6000 }));
    expect(state).toEqual({ dailyBudget: 5000 });
    expect(requests[1]).toMatchObject({ url: `${BASE}/act_1234`, method: 'GET', query: { fields: 'currency' } });
    expectNoTokenOutsideHeader(requests);
  });

  it('keeps an existing act_ prefix and honours the version and env prefix', async () => {
    const { deps, requests } = makeDeps(
      (request) => (request.url.includes('act_') ? { currency: 'USD' } : { daily_budget: '250', account_id: '77' }),
      { externalId: 'act_77', envPrefix: 'ACME_' },
      { ACME_META_ACCESS_TOKEN: 'prefixed', META_GRAPH_API_VERSION: 'v27.0' },
    );
    delete deps.account.currency;
    const state = await readMetaAdsState(deps, draft('meta_ads.campaign.set_daily_budget', { dailyBudget: 3 }));
    expect(state).toEqual({ dailyBudget: 2.5 });
    expect(requests[1]?.url).toBe('https://graph.facebook.com/v27.0/act_77');
    expect(requests[0]?.headers).toEqual({ Authorization: 'Bearer prefixed' });
  });

  it('refuses set_daily_budget on a lifetime budget', async () => {
    const { deps } = makeDeps(() => ({ status: 'ACTIVE', lifetime_budget: '90000', account_id: '1234' }));
    await expect(
      readMetaAdsState(deps, draft('meta_ads.adset.set_daily_budget', { dailyBudget: 10 })),
    ).rejects.toMatchObject({ code: 'unsupported', message: expect.stringContaining('lifetime budget') });
  });

  it('refuses set_daily_budget on a campaign without a campaign-level budget', async () => {
    const { deps } = makeDeps(() => ({ status: 'ACTIVE', account_id: '1234' }));
    await expect(
      readMetaAdsState(deps, draft('meta_ads.campaign.set_daily_budget', { dailyBudget: 10 })),
    ).rejects.toMatchObject({ code: 'unsupported', message: expect.stringContaining('ad sets') });
  });

  it('rejects a non-numeric id before any request', async () => {
    const { deps, requests } = makeDeps(() => ({}));
    await expect(readMetaAdsState(deps, draft('meta_ads.campaign.pause', {}, '111/../me'))).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(requests).toHaveLength(0);
  });

  it('fails with not_configured when the token is missing', async () => {
    const { deps } = makeDeps(() => ({}));
    deps.env = {};
    await expect(readMetaAdsState(deps, draft('meta_ads.campaign.pause'))).rejects.toMatchObject({
      code: 'not_configured',
    });
  });
  it('refuses a target that belongs to another ad account', async () => {
    const { deps } = makeDeps(() => ({ status: 'ACTIVE', daily_budget: '5000', account_id: '9999' }));
    const failure = await readMetaAdsState(deps, draft('meta_ads.adset.pause')).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AutopilotError);
    expect(failure).toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('This ad set belongs to another ad account'),
    });
  });

  it('refuses a target whose owning account is not reported', async () => {
    const { deps } = makeDeps(() => ({ status: 'ACTIVE' }));
    await expect(readMetaAdsState(deps, draft('meta_ads.campaign.pause'))).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('accepts an owner reported with the act_ prefix when the config has none', async () => {
    const { deps } = makeDeps(() => ({ status: 'PAUSED', account_id: 'act_1234' }));
    expect(await readMetaAdsState(deps, draft('meta_ads.ad.enable'))).toEqual({ status: 'PAUSED' });
  });

  it('reads only status and account_id for an ad pause', async () => {
    const { deps, requests } = makeDeps(() => ({ status: 'ACTIVE', account_id: '1234' }));
    expect(await readMetaAdsState(deps, draft('meta_ads.ad.pause'))).toEqual({ status: 'ENABLED' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.query).toEqual({ fields: 'status,account_id' });
  });

  it('reads a COP budget unscaled and a KWD budget with offset 100', async () => {
    const cop = makeDeps(() => ({ daily_budget: '5000', account_id: '1234' }), { currency: 'COP' });
    expect(
      await readMetaAdsState(cop.deps, draft('meta_ads.campaign.set_daily_budget', { dailyBudget: 6000 })),
    ).toEqual({ dailyBudget: 5000 });
    const kwd = makeDeps(() => ({ daily_budget: '1250', account_id: '1234' }), { currency: 'KWD' });
    expect(
      await readMetaAdsState(kwd.deps, draft('meta_ads.campaign.set_daily_budget', { dailyBudget: 20 })),
    ).toEqual({ dailyBudget: 12.5 });
  });
});

describe('applyMetaAdsAction', () => {
  const statusCases: Array<[ActionKind, string]> = [
    ['meta_ads.campaign.pause', 'PAUSED'],
    ['meta_ads.campaign.enable', 'ACTIVE'],
    ['meta_ads.adset.pause', 'PAUSED'],
    ['meta_ads.adset.enable', 'ACTIVE'],
    ['meta_ads.ad.pause', 'PAUSED'],
    ['meta_ads.ad.enable', 'ACTIVE'],
  ];

  it.each(statusCases)('%s posts status=%s', async (kind, status) => {
    const { deps, requests } = makeDeps(owned());
    const result = await applyMetaAdsAction(deps, action(kind), OPTIONS);
    expect(result).toEqual({ ok: true, dryRun: false, after: null, resource: '111' });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ url: `${BASE}/111`, method: 'GET', query: { fields: 'account_id' } });
    expect(requests[1]).toEqual({
      url: `${BASE}/111`,
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      form: { status },
      retry: false,
    });
    expect(JSON.stringify(requests)).not.toContain('key-1');
  });

  it.each(['meta_ads.campaign.set_daily_budget', 'meta_ads.adset.set_daily_budget'] as const)(
    '%s posts the budget in USD cents',
    async (kind) => {
      const { deps, requests } = makeDeps(owned());
      const result = await applyMetaAdsAction(deps, action(kind, { dailyBudget: 12.34 }, { dailyBudget: 10 }), OPTIONS);
      expect(result.ok).toBe(true);
      expect(requests).toHaveLength(2);
      expect(requests[1]?.form).toEqual({ daily_budget: '1234' });
      expect(requests[1]?.retry).toBe(false);
    },
  );

  it('posts a JPY budget without scaling, reading the currency from the account', async () => {
    const { deps, requests } = makeDeps((request) =>
      request.method === 'POST' ? { success: true } : request.url.endsWith('/act_1234') ? { currency: 'JPY' } : { account_id: '1234' },
    );
    delete deps.account.currency;
    const result = await applyMetaAdsAction(
      deps,
      action('meta_ads.campaign.set_daily_budget', { dailyBudget: 5000 }, { dailyBudget: 4000 }),
      OPTIONS,
    );
    expect(result.ok).toBe(true);
    expect(requests.map((request) => request.method)).toEqual(['GET', 'GET', 'POST']);
    expect(requests[2]?.form).toEqual({ daily_budget: '5000' });
    expectNoTokenOutsideHeader(requests);
  });

  it('adds execution_options on validate_only and reports a dry run', async () => {
    const { deps, requests } = makeDeps(owned());
    const result = await applyMetaAdsAction(deps, action('meta_ads.adset.pause'), {
      validateOnly: true,
      idempotencyKey: 'key-1',
    });
    expect(result).toEqual({ ok: true, dryRun: true, after: null, resource: '111' });
    expect(requests[1]?.form).toEqual({ status: 'PAUSED', execution_options: '["validate_only"]' });
    expect(requests[1]?.retry).toBe(false);
  });

  it('returns ok:false on a 400', async () => {
    const { deps } = makeDeps(
      failingPost(new AutopilotError('platform_error', `HTTP 400: Invalid parameter (${TOKEN})`, { retryable: false })),
    );
    const result = await applyMetaAdsAction(deps, action('meta_ads.campaign.pause'), OPTIONS);
    expect(result.ok).toBe(false);
    expect(result.dryRun).toBe(false);
    expect(result.after).toBeNull();
    expect(result.error).toMatchObject({ code: 'platform_error', retryable: false });
    expect(result.error?.message).toContain('Invalid parameter');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('rethrows a retryable failure on a live call', async () => {
    const failure = new AutopilotError('platform_error', 'HTTP 500', { retryable: true });
    const { deps, requests } = makeDeps(failingPost(failure));
    await expect(applyMetaAdsAction(deps, action('meta_ads.campaign.pause'), OPTIONS)).rejects.toBe(failure);
    expect(requests).toHaveLength(2);
  });

  it('returns ok:false with retryable true when a validate_only call fails with a 500', async () => {
    const { deps } = makeDeps(failingPost(new AutopilotError('platform_error', 'HTTP 500', { retryable: true })));
    const result = await applyMetaAdsAction(deps, action('meta_ads.campaign.pause'), {
      validateOnly: true,
      idempotencyKey: 'key-1',
    });
    expect(result).toMatchObject({ ok: false, dryRun: true, after: null, error: { retryable: true } });
  });

  it('returns ok:false without a request for a non-numeric id or a bad budget', async () => {
    const { deps, requests } = makeDeps(owned());
    const bad = { ...action('meta_ads.campaign.pause'), target: { level: 'campaign' as const, id: 'abc' } };
    expect((await applyMetaAdsAction(deps, bad, OPTIONS)).error?.code).toBe('invalid_input');
    const zero = { ...action('meta_ads.campaign.set_daily_budget', { dailyBudget: 5 }), params: { dailyBudget: 0 } };
    expect((await applyMetaAdsAction(deps, zero, OPTIONS)).error?.code).toBe('invalid_input');
    expect(requests).toHaveLength(0);
  });
  it('refuses a target of another ad account without sending a POST', async () => {
    for (const validateOnly of [false, true]) {
      const { deps, requests } = makeDeps(owned('9999'));
      const result = await applyMetaAdsAction(deps, action('meta_ads.campaign.pause'), {
        validateOnly,
        idempotencyKey: 'key-1',
      });
      expect(result).toMatchObject({ ok: false, dryRun: validateOnly, after: null, error: { code: 'invalid_input', retryable: false } });
      expect(result.error?.message).toContain('This campaign belongs to another ad account');
      expect(requests.map((request) => request.method)).toEqual(['GET']);
    }
  });

  it('refuses a budget change on a target of another ad account without sending a POST', async () => {
    const { deps, requests } = makeDeps(owned('9999'));
    const result = await applyMetaAdsAction(
      deps,
      action('meta_ads.adset.set_daily_budget', { dailyBudget: 20 }, { dailyBudget: 10 }),
      OPTIONS,
    );
    expect(result.error).toMatchObject({ code: 'invalid_input', retryable: false });
    expect(requests.some((request) => request.method === 'POST')).toBe(false);
  });

  const unitCases: Array<[string, number, string]> = [
    ['COP', 5000, '5000'],
    ['USD', 50, '5000'],
    ['KWD', 12.5, '1250'],
  ];

  it.each(unitCases)('sends %s %d as daily_budget=%s', async (currency, amount, sent) => {
    const { deps, requests } = makeDeps(owned(), { currency });
    const result = await applyMetaAdsAction(
      deps,
      action('meta_ads.campaign.set_daily_budget', { dailyBudget: amount }, { dailyBudget: 1 }),
      OPTIONS,
    );
    expect(result.ok).toBe(true);
    expect(requests.at(-1)).toMatchObject({ method: 'POST', form: { daily_budget: sent } });
  });

  it('refuses JPY 1203.6 rather than rounding it, and sends nothing', async () => {
    const { deps, requests } = makeDeps(owned(), { currency: 'JPY' });
    const base = action('meta_ads.campaign.set_daily_budget', { dailyBudget: 1200 }, { dailyBudget: 1000 });
    const result = await applyMetaAdsAction(deps, { ...base, params: { dailyBudget: 1203.6 } }, OPTIONS);
    expect(result).toMatchObject({ ok: false, after: null, error: { code: 'invalid_input', retryable: false } });
    expect(requests).toHaveLength(0);
  });
});
