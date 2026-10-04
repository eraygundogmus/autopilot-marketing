import { describe, expect, it } from 'vitest';
import { diagnoseMetaAds } from '../../src/connectors/meta-ads-diagnose';
import { AutopilotError } from '../../src/core/errors';
import type { AccountConfig, ConnectorDeps, DiagnosticCheck, HttpClient, HttpRequest, HttpResponse } from '../../src/core/types';

const TOKEN = 'EAAB-secret-token-value-123456';

type Reply = { body: unknown; headers?: Record<string, string> } | Error;

interface Routes {
  me?: Reply;
  permissions?: Reply;
  account?: Reply;
}

function graphError(code: number, subcode?: number, message = 'Graph said no'): AutopilotError {
  const error: Record<string, unknown> = { message, type: 'OAuthException', code };
  if (subcode !== undefined) error['error_subcode'] = subcode;
  return new AutopilotError('platform_error', `GET https://graph.facebook.com/v26.0/x -> 400: ${JSON.stringify({ error })}`);
}

function perms(...names: string[]): Reply {
  return { body: { data: names.map((permission) => ({ permission, status: 'granted' })) } };
}

const ACCOUNT_BODY = {
  account_status: 1,
  disable_reason: 0,
  currency: 'EUR',
  timezone_name: 'Europe/Istanbul',
  name: 'Acme Main',
  id: 'act_123',
};

function setup(routes: Routes = {}, account: Partial<AccountConfig> = {}, env: Record<string, string> = { META_ACCESS_TOKEN: TOKEN }) {
  const calls: HttpRequest[] = [];
  const replies: Required<Routes> = {
    me: routes.me ?? { body: { id: '1', name: 'Ada Lovelace' } },
    permissions: routes.permissions ?? perms('ads_read', 'ads_management', 'business_management'),
    account: routes.account ?? {
      body: ACCOUNT_BODY,
      headers: { 'x-ad-account-usage': '{"acc_id_util_pct":1,"ads_api_access_tier":"development_access"}' },
    },
  };
  const http: HttpClient = {
    async request<T>(req: HttpRequest): Promise<HttpResponse<T>> {
      calls.push(req);
      const reply = req.url.endsWith('/me/permissions')
        ? replies.permissions
        : req.url.endsWith('/me')
          ? replies.me
          : replies.account;
      if (reply instanceof Error) throw reply;
      return { status: 200, headers: reply.headers ?? {}, body: reply.body as T };
    },
  };
  const deps: ConnectorDeps = {
    account: { id: 'acme-meta', platform: 'meta_ads', externalId: '123', ...account },
    env,
    http,
    now: () => new Date('2026-10-04T00:00:00Z'),
  };
  return { deps, calls };
}

function byId(checks: DiagnosticCheck[], id: string): DiagnosticCheck {
  const found = checks.find((check) => check.id === id);
  if (found === undefined) throw new Error(`no check ${id}`);
  return found;
}

function statuses(checks: DiagnosticCheck[]): string[] {
  return checks.map((check) => `${check.id}:${check.status}`);
}

describe('diagnoseMetaAds', () => {
  it('reports every check ok with the tier from the header', async () => {
    const { deps, calls } = setup({}, { currency: 'EUR', timezone: 'Europe/Istanbul' });
    const checks = await diagnoseMetaAds(deps);
    expect(statuses(checks)).toEqual([
      'credentials:ok',
      'token:ok',
      'permissions:ok',
      'ad_account:ok',
      'config_match:ok',
      'access_tier:ok',
    ]);
    expect(byId(checks, 'token').detail).toBe('token belongs to Ada Lovelace');
    expect(byId(checks, 'permissions').detail).toBe('granted: ads_read, ads_management, business_management.');
    expect(byId(checks, 'ad_account').detail).toBe(
      'Acme Main, EUR, Europe/Istanbul. Read access works; write access is not tested here.',
    );
    expect(byId(checks, 'config_match').detail).toBe('config agrees with the platform');
    expect(byId(checks, 'access_tier').detail).toContain('access tier as "development_access"');
    expect(calls.map((call) => call.url)).toEqual([
      'https://graph.facebook.com/v26.0/me',
      'https://graph.facebook.com/v26.0/me/permissions',
      'https://graph.facebook.com/v26.0/act_123',
    ]);
    expect(calls[0]?.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(calls[2]?.query).toEqual({ fields: 'account_status,disable_reason,currency,timezone_name,name' });
  });

  it('cuts a long user name to 80 characters', async () => {
    const { deps } = setup({ me: { body: { id: '1', name: 'x'.repeat(200) } } });
    const checks = await diagnoseMetaAds(deps);
    expect(byId(checks, 'token').detail).toBe(`token belongs to ${'x'.repeat(80)}`);
  });

  it('fails credentials without a token and makes no call', async () => {
    const { deps, calls } = setup({}, { envPrefix: 'ACME_' }, {});
    const checks = await diagnoseMetaAds(deps);
    expect(calls).toHaveLength(0);
    expect(statuses(checks)).toEqual([
      'credentials:fail',
      'token:skipped',
      'permissions:skipped',
      'ad_account:skipped',
      'config_match:skipped',
    ]);
    expect(checks[0]?.detail).toContain('ACME_META_ACCESS_TOKEN');
    expect(checks[0]?.fix).toBe('Set it with `autopilot-marketing credentials set META_ACCESS_TOKEN` or in the .env file.');
    expect(checks[1]?.detail).toBe('not run: an earlier check failed');
  });

  it('explains code 190 with subcode 463', async () => {
    const { deps, calls } = setup({ me: graphError(190, 463) });
    const checks = await diagnoseMetaAds(deps);
    const token = byId(checks, 'token');
    expect(token.status).toBe('fail');
    expect(token.detail).toBe('The access token is expired or invalid (subcode 463: expired)');
    expect(token.fix).toBe('Create a new access token. A system user token of the business does not expire.');
    expect(calls).toHaveLength(1);
    expect(statuses(checks).slice(2)).toEqual(['permissions:skipped', 'ad_account:skipped', 'config_match:skipped']);
  });

  it('fails permissions when neither ads permission is granted', async () => {
    const { deps } = setup({
      permissions: { body: { data: [{ permission: 'ads_read', status: 'declined' }, { permission: 'email', status: 'granted' }] } },
    });
    const checks = await diagnoseMetaAds(deps);
    const permissions = byId(checks, 'permissions');
    expect(permissions.status).toBe('fail');
    expect(permissions.fix).toBe('Grant ads_read to read, and ads_management to apply changes.');
    expect(byId(checks, 'ad_account').status).toBe('skipped');
    expect(checks.some((check) => check.id === 'access_tier')).toBe(false);
  });

  it('accepts ads_read alone and notes what changes need', async () => {
    const { deps } = setup({ permissions: perms('ads_read') });
    const checks = await diagnoseMetaAds(deps);
    const permissions = byId(checks, 'permissions');
    expect(permissions.status).toBe('ok');
    expect(permissions.detail).toBe('granted: ads_read. Changes need ads_management.');
    expect(byId(checks, 'ad_account').status).toBe('ok');
  });

  it('maps code 100 to an unreachable ad account', async () => {
    const { deps } = setup({ account: graphError(100, 33, 'Unsupported get request.') });
    const checks = await diagnoseMetaAds(deps);
    const account = byId(checks, 'ad_account');
    expect(account.status).toBe('fail');
    expect(account.detail).toBe("The token's user cannot reach this ad account.");
    expect(account.fix).toBe('Add the user (or the system user) to the ad account in Business settings, or check externalId.');
    expect(byId(checks, 'config_match').status).toBe('skipped');
    expect(checks.some((check) => check.id === 'access_tier')).toBe(false);
  });

  it('names a disabled account and its disable reason', async () => {
    const { deps } = setup({ account: { body: { ...ACCOUNT_BODY, account_status: 2, disable_reason: 1 } } });
    const checks = await diagnoseMetaAds(deps);
    const account = byId(checks, 'ad_account');
    expect(account.status).toBe('fail');
    expect(account.detail).toBe('account status is DISABLED, disable_reason 1');
    expect(statuses(checks).slice(4)).toEqual(['config_match:skipped', 'access_tier:ok']);
  });

  it('prints an unknown account status as a number', async () => {
    const { deps } = setup({ account: { body: { ...ACCOUNT_BODY, account_status: 55 } } });
    const checks = await diagnoseMetaAds(deps);
    expect(byId(checks, 'ad_account').detail).toBe('account status is 55');
  });

  it('fails config_match on a currency mismatch', async () => {
    const { deps } = setup({}, { currency: 'USD', timezone: 'Europe/Istanbul' });
    const checks = await diagnoseMetaAds(deps);
    const match = byId(checks, 'config_match');
    expect(match.status).toBe('fail');
    expect(match.detail).toBe('config currency USD, platform EUR');
    expect(match.fix).toBe('Set currency to EUR in the config.');
    expect(checks.at(-1)?.id).toBe('access_tier');
  });

  it('has nothing to compare when the config sets neither value', async () => {
    const { deps } = setup();
    const checks = await diagnoseMetaAds(deps);
    expect(byId(checks, 'config_match')).toMatchObject({ status: 'ok', detail: 'nothing to compare' });
  });

  it('says so when the usage header is absent', async () => {
    const { deps } = setup({ account: { body: ACCOUNT_BODY } });
    const checks = await diagnoseMetaAds(deps);
    const tier = byId(checks, 'access_tier');
    expect(tier.status).toBe('ok');
    expect(tier.detail).toBe(
      "Meta did not report the app's access tier on this call. It is shown in the App Dashboard under App Review, Permissions and Features.",
    );
  });

  it('treats a malformed usage header as absent', async () => {
    const { deps } = setup({ account: { body: ACCOUNT_BODY, headers: { 'x-ad-account-usage': '{not json' } } });
    const checks = await diagnoseMetaAds(deps);
    expect(byId(checks, 'access_tier').detail).toContain('did not report');
  });

  it('never shows the token value', async () => {
    const leaky = new AutopilotError('platform_error', `GET /me -> 500: upstream echoed ${TOKEN} and access_token=${TOKEN}`);
    const runs = [
      setup({ me: leaky }),
      setup({ permissions: leaky }),
      setup({ account: leaky }),
      setup({ me: { body: { id: '1', name: `user ${TOKEN}` } }, account: { body: { ...ACCOUNT_BODY, name: TOKEN } } }),
    ];
    for (const run of runs) {
      const checks = await diagnoseMetaAds(run.deps);
      expect(JSON.stringify(checks)).not.toContain(TOKEN);
    }
  });

  it('reports a retryable failure on /me as unknown and skips the rest', async () => {
    const timeout = new AutopilotError('platform_error', 'GET https://graph.facebook.com/v26.0/me timed out', { retryable: true });
    const { deps, calls } = setup({ me: timeout });
    const checks = await diagnoseMetaAds(deps);
    expect(statuses(checks)).toEqual([
      'credentials:ok',
      'token:unknown',
      'permissions:skipped',
      'ad_account:skipped',
      'config_match:skipped',
    ]);
    const token = byId(checks, 'token');
    expect(token.detail).toBe('Could not be checked: GET https://graph.facebook.com/v26.0/me timed out');
    expect('fix' in token).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('reports a rate_limited failure as unknown', async () => {
    const { deps } = setup({ permissions: new AutopilotError('rate_limited', 'GET /me/permissions -> 429') });
    const checks = await diagnoseMetaAds(deps);
    const permissions = byId(checks, 'permissions');
    expect(permissions.status).toBe('unknown');
    expect('fix' in permissions).toBe(false);
    expect(byId(checks, 'ad_account').status).toBe('skipped');
  });

  it('reports a Graph rate-limit code in the body as unknown on the ad account call', async () => {
    const body = '{"error":{"code":17,"error_subcode":2446079,"message":"User request limit reached"}}';
    const limited = new AutopilotError('platform_error', 'GET https://graph.facebook.com/v26.0/act_123 -> 400', { status: 400, body });
    const { deps } = setup({ account: limited });
    const checks = await diagnoseMetaAds(deps);
    const account = byId(checks, 'ad_account');
    expect(account.status).toBe('unknown');
    expect(account.detail).toBe('Could not be checked: GET https://graph.facebook.com/v26.0/act_123 -> 400');
    expect('fix' in account).toBe(false);
    expect(account.detail).not.toContain('User request limit reached');
    expect(byId(checks, 'config_match').status).toBe('skipped');
    expect(checks.some((check) => check.id === 'access_tier')).toBe(false);
  });

  it('reads code 190 subcode 463 from the body when the message is cut short', async () => {
    const body = JSON.stringify({
      error: { message: 'Error validating access token: Session has expired', type: 'OAuthException', code: 190, error_subcode: 463 },
    });
    const cut = new AutopilotError('platform_error', 'GET https://graph.facebook.com/v26.0/me -> 400: {"error":{"message":"Error valid', {
      status: 400,
      body,
    });
    const { deps } = setup({ me: cut });
    const checks = await diagnoseMetaAds(deps);
    const token = byId(checks, 'token');
    expect(token.status).toBe('fail');
    expect(token.detail).toBe('The access token is expired or invalid (subcode 463: expired)');
    expect(token.fix).toBe('Create a new access token. A system user token of the business does not expire.');
  });

  it('never prints the response body in a detail', async () => {
    const body = '{"error":{"code":1,"message":"body-only marker text"}}';
    const failed = new AutopilotError('platform_error', 'GET /x -> 400', { status: 400, body });
    for (const run of [setup({ me: failed }), setup({ permissions: failed }), setup({ account: failed })]) {
      const checks = await diagnoseMetaAds(run.deps);
      expect(checks.some((check) => check.status === 'fail' && check.detail === 'GET /x -> 400')).toBe(true);
      expect(JSON.stringify(checks)).not.toContain('body-only marker text');
    }
  });

  it('falls back to the message when the body is not JSON', async () => {
    const failed = new AutopilotError('platform_error', 'GET /me -> 400: (#190) token problem', { status: 400, body: '<html>bad</html>' });
    const { deps } = setup({ me: failed });
    const checks = await diagnoseMetaAds(deps);
    expect(byId(checks, 'token').detail).toBe('The access token is expired or invalid');
  });

  it('resolves when the client throws a plain Error', async () => {
    const { deps } = setup({ me: new Error('socket hang up') });
    const checks = await diagnoseMetaAds(deps);
    expect(byId(checks, 'token')).toMatchObject({ status: 'fail', detail: 'socket hang up' });
    expect(byId(checks, 'permissions').status).toBe('skipped');
  });
});
