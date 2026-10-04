import { beforeEach, describe, expect, it } from 'vitest';
import { diagnoseGoogleAds } from '../../src/connectors/google-ads-diagnose';
import { clearGoogleTokenCache } from '../../src/connectors/google-auth';
import { AutopilotError } from '../../src/core/errors';
import type { AccountConfig, ConnectorDeps, DiagnosticCheck, Env, HttpClient, HttpRequest } from '../../src/core/types';

const REFRESH_TOKEN = 'refresh-token-value-1234567890';
const ENV: Env = {
  GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'client-secret-value-123',
  GOOGLE_REFRESH_TOKEN: REFRESH_TOKEN,
};

type Reply = unknown | (() => unknown);

interface FakeOptions {
  token?: Reply;
  list?: Reply;
  search?: Reply;
}

const CUSTOMER = {
  id: '1234567890',
  descriptiveName: 'Acme',
  currencyCode: 'EUR',
  timeZone: 'Europe/Istanbul',
  status: 'ENABLED',
  manager: false,
  testAccount: false,
};

function platformError(message: string): () => never {
  return () => {
    throw new AutopilotError('platform_error', message);
  };
}

function fakeHttp(options: FakeOptions = {}): { http: HttpClient; calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  const resolve = (reply: Reply, fallback: unknown): unknown => {
    if (reply === undefined) return fallback;
    return typeof reply === 'function' ? (reply as () => unknown)() : reply;
  };
  const http: HttpClient = {
    request: async <T>(request: HttpRequest) => {
      calls.push(request);
      let body: unknown;
      if (request.url.includes('oauth2.googleapis.com')) {
        body = resolve(options.token, { access_token: 'ya29.access-token-value', expires_in: 3600 });
      } else if (request.url.endsWith('customers:listAccessibleCustomers')) {
        body = resolve(options.list, { resourceNames: ['customers/1234567890', 'customers/1111111111'] });
      } else if (request.url.endsWith('googleAds:search')) {
        body = resolve(options.search, { results: [{ customer: CUSTOMER }] });
      } else {
        throw new AutopilotError('platform_error', `unexpected url ${request.url}`);
      }
      return { status: 200, headers: {}, body: body as T };
    },
  };
  return { http, calls };
}

function deps(http: HttpClient, account: Partial<AccountConfig> = {}, env: Env = ENV): ConnectorDeps {
  return {
    account: { id: 'acme-google', platform: 'google_ads', externalId: '123-456-7890', ...account },
    env,
    http,
    now: () => new Date('2026-10-04T10:00:00Z'),
  };
}

function byId(checks: DiagnosticCheck[], id: string): DiagnosticCheck {
  const check = checks.find((candidate) => candidate.id === id);
  if (check === undefined) throw new Error(`no check ${id}`);
  return check;
}

function statuses(checks: DiagnosticCheck[]): string[] {
  return checks.map((check) => `${check.id}:${check.status}`);
}

describe('diagnoseGoogleAds', () => {
  beforeEach(() => {
    clearGoogleTokenCache();
  });

  it('reports every check ok and appends the access level note', async () => {
    const { http, calls } = fakeHttp();
    const checks = await diagnoseGoogleAds(deps(http));
    expect(statuses(checks)).toEqual([
      'credentials:ok',
      'oauth_token:ok',
      'api_access:ok',
      'account_access:ok',
      'account_query:ok',
      'account_state:ok',
      'config_match:ok',
      'access_level:ok',
    ]);
    expect(byId(checks, 'api_access').detail).toBe('2 accessible customer(s)');
    expect(byId(checks, 'account_state').detail).toBe('Acme, EUR, Europe/Istanbul');
    expect(byId(checks, 'config_match').detail).toBe('nothing to compare');
    expect(byId(checks, 'access_level').detail).toContain('2,880 operations a day');

    const list = calls.find((call) => call.url.endsWith('customers:listAccessibleCustomers'));
    expect(list?.url).toBe('https://googleads.googleapis.com/v25/customers:listAccessibleCustomers');
    expect(Object.keys(list?.headers ?? {})).toEqual(['Authorization']);
    const search = calls.find((call) => call.url.endsWith('googleAds:search'));
    expect(search?.url).toBe('https://googleads.googleapis.com/v25/customers/1234567890/googleAds:search');
    expect(search?.headers?.['login-customer-id']).toBeUndefined();
  });

  it('names a test account and agrees with a matching config', async () => {
    const { http } = fakeHttp({ search: { results: [{ customer: { ...CUSTOMER, testAccount: true } }] } });
    const checks = await diagnoseGoogleAds(deps(http, { currency: 'EUR', timezone: 'Europe/Istanbul' }));
    expect(byId(checks, 'account_state').detail).toBe('Acme, EUR, Europe/Istanbul, test account');
    expect(byId(checks, 'config_match').detail).toBe('config agrees with the platform');
  });

  it('stops at missing credentials without any HTTP call', async () => {
    const { http, calls } = fakeHttp();
    const checks = await diagnoseGoogleAds(deps(http, {}, { GOOGLE_CLIENT_ID: 'client-id' }));
    const first = byId(checks, 'credentials');
    expect(first.status).toBe('fail');
    expect(first.detail).toContain('GOOGLE_CLIENT_SECRET');
    expect(first.detail).toContain('GOOGLE_REFRESH_TOKEN');
    expect(first.fix).toContain('credentials set <NAME>');
    expect(checks.slice(1).every((check) => check.status === 'skipped')).toBe(true);
    expect(checks.slice(1).every((check) => check.detail === 'not run: an earlier check failed')).toBe(true);
    expect(checks.some((check) => check.id === 'access_level')).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('explains invalid_grant', async () => {
    const { http } = fakeHttp({
      token: platformError('POST https://oauth2.googleapis.com/token -> 400: {"error":"invalid_grant"}'),
    });
    const checks = await diagnoseGoogleAds(deps(http));
    const check = byId(checks, 'oauth_token');
    expect(check.status).toBe('fail');
    expect(check.fix).toContain('expire after 7 days');
    expect(byId(checks, 'api_access').status).toBe('skipped');
  });

  it('points other token failures at the OAuth client', async () => {
    const { http } = fakeHttp({ token: platformError('POST https://oauth2.googleapis.com/token -> 401: invalid_client') });
    const checks = await diagnoseGoogleAds(deps(http));
    expect(byId(checks, 'oauth_token').fix).toBe('Check the OAuth client id and secret.');
  });

  it('maps an insufficient scope', async () => {
    const { http } = fakeHttp({ list: platformError('GET https://googleads.googleapis.com/v25/x -> 403: ACCESS_TOKEN_SCOPE_INSUFFICIENT') });
    const checks = await diagnoseGoogleAds(deps(http));
    const check = byId(checks, 'api_access');
    expect(check.status).toBe('fail');
    expect(check.fix).toBe('Create the refresh token with the scope https://www.googleapis.com/auth/adwords.');
    expect(byId(checks, 'account_access').status).toBe('skipped');
  });

  it('gives no invented advice for an unknown API failure', async () => {
    const { http } = fakeHttp({ list: platformError('GET x -> 500: boom') });
    const check = byId(await diagnoseGoogleAds(deps(http)), 'api_access');
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('boom');
    expect('fix' in check).toBe(false);
  });

  it('fails when the customer is not listed and no manager is set', async () => {
    const { http, calls } = fakeHttp({ list: { resourceNames: ['customers/1111111111'] } });
    const checks = await diagnoseGoogleAds(deps(http));
    const check = byId(checks, 'account_access');
    expect(check.status).toBe('fail');
    expect(check.detail).toBe('Customer 1234567890 is not among the accounts this user can access directly.');
    expect(check.fix).toContain('set loginCustomerId to the manager id');
    expect(byId(checks, 'account_query').status).toBe('skipped');
    expect(calls.some((call) => call.url.endsWith('googleAds:search'))).toBe(false);
  });

  it('confirms access through a manager by the query, and sends the header', async () => {
    const { http, calls } = fakeHttp({ list: { resourceNames: ['customers/1111111111'] } });
    const checks = await diagnoseGoogleAds(deps(http, { loginCustomerId: '111-111-1111' }));
    expect(statuses(checks)).toEqual([
      'credentials:ok',
      'oauth_token:ok',
      'api_access:ok',
      'account_access:ok',
      'account_query:ok',
      'account_state:ok',
      'config_match:ok',
      'access_level:ok',
    ]);
    expect(byId(checks, 'account_access').detail).toBe('reached through manager account 1111111111.');
    const searches = calls.filter((call) => call.url.endsWith('googleAds:search'));
    expect(searches).toHaveLength(1);
    expect(searches[0]?.headers?.['login-customer-id']).toBe('1111111111');
  });

  it('fails access when the query through the manager is denied', async () => {
    const { http } = fakeHttp({
      list: { resourceNames: ['customers/1111111111'] },
      search: platformError('POST x -> 403: USER_PERMISSION_DENIED'),
    });
    const checks = await diagnoseGoogleAds(deps(http, { loginCustomerId: '111-111-1111' }));
    expect(byId(checks, 'account_access')).toEqual({
      id: 'account_access',
      label: 'The user can reach the configured customer',
      status: 'fail',
      detail: 'Customer 1234567890 could not be reached through manager account 1111111111.',
      fix: 'Check that loginCustomerId is the manager that has access to this customer, and that the user has access to that manager.',
    });
    expect(statuses(checks).slice(4)).toEqual(['account_query:skipped', 'account_state:skipped', 'config_match:skipped']);
  });

  it('leaves access unknown when the query through the manager fails for another reason', async () => {
    const { http, calls } = fakeHttp({
      list: { resourceNames: ['customers/1111111111'] },
      search: platformError('POST x -> 403: CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION'),
    });
    const checks = await diagnoseGoogleAds(deps(http, { loginCustomerId: '111-111-1111' }));
    const access = byId(checks, 'account_access');
    expect(access.status).toBe('unknown');
    expect(access.detail).toBe('Access through manager account 1111111111 could not be confirmed.');
    expect('fix' in access).toBe(false);
    const query = byId(checks, 'account_query');
    expect(query.status).toBe('fail');
    expect(query.fix).toContain('Test access only');
    expect(statuses(checks).slice(5)).toEqual(['account_state:skipped', 'config_match:skipped']);
    expect(calls.filter((call) => call.url.endsWith('googleAds:search'))).toHaveLength(1);
  });

  it('reports a listed customer as directly accessible even when a manager is set', async () => {
    const { http } = fakeHttp();
    const checks = await diagnoseGoogleAds(deps(http, { loginCustomerId: '111-111-1111' }));
    expect(byId(checks, 'account_access')).toMatchObject({
      status: 'ok',
      detail: 'Customer 1234567890 is directly accessible.',
    });
  });

  it('maps a Test-level Cloud project', async () => {
    const { http } = fakeHttp({ search: platformError('POST x -> 403: CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION') });
    const checks = await diagnoseGoogleAds(deps(http));
    const check = byId(checks, 'account_query');
    expect(check.status).toBe('fail');
    expect(check.fix).toContain('Test access only');
    expect(byId(checks, 'account_state').status).toBe('skipped');
    expect(checks.some((candidate) => candidate.id === 'access_level')).toBe(false);
  });

  it('reads ACTION_NOT_PERMITTED as Test access only on v24 and earlier', async () => {
    const search = platformError('POST x -> 403: ACTION_NOT_PERMITTED');
    const old = await diagnoseGoogleAds(deps(fakeHttp({ search }).http, {}, { ...ENV, GOOGLE_ADS_API_VERSION: 'v24' }));
    expect(byId(old, 'account_query').fix).toContain('Test access only');
    clearGoogleTokenCache();
    const current = await diagnoseGoogleAds(deps(fakeHttp({ search }).http));
    expect('fix' in byId(current, 'account_query')).toBe(false);
  });

  it('maps USER_PERMISSION_DENIED', async () => {
    const { http } = fakeHttp({ search: platformError('POST x -> 403: USER_PERMISSION_DENIED') });
    const check = byId(await diagnoseGoogleAds(deps(http)), 'account_query');
    expect(check.status).toBe('fail');
    expect(check.fix).toContain('Set loginCustomerId to the manager account');
  });

  it('fails a manager account', async () => {
    const { http } = fakeHttp({ search: { results: [{ customer: { ...CUSTOMER, manager: true } }] } });
    const checks = await diagnoseGoogleAds(deps(http));
    const check = byId(checks, 'account_state');
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('manager account');
    expect(byId(checks, 'config_match').status).toBe('skipped');
    expect(byId(checks, 'access_level').status).toBe('ok');
  });

  it('fails a cancelled account and names the status', async () => {
    const { http } = fakeHttp({ search: { results: [{ customer: { ...CUSTOMER, status: 'CANCELED' } }] } });
    const check = byId(await diagnoseGoogleAds(deps(http)), 'account_state');
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('CANCELED');
  });

  it('fails a currency mismatch with the platform value in the fix', async () => {
    const { http } = fakeHttp();
    const checks = await diagnoseGoogleAds(deps(http, { currency: 'USD', timezone: 'Europe/Istanbul' }));
    const check = byId(checks, 'config_match');
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('USD');
    expect(check.fix).toBe('Set currency to EUR in the config.');
    expect(checks.at(-1)?.id).toBe('access_level');
  });

  it('names both values when currency and timezone differ', async () => {
    const { http } = fakeHttp();
    const checks = await diagnoseGoogleAds(deps(http, { currency: 'USD', timezone: 'America/New_York' }));
    expect(byId(checks, 'config_match').fix).toBe('Set currency to EUR and timezone to Europe/Istanbul in the config.');
  });

  it('never shows the refresh token', async () => {
    const leak = platformError(`POST x -> 400: bad refresh_token=${REFRESH_TOKEN} and ${REFRESH_TOKEN} Bearer ya29.abc`);
    for (const options of [{ token: leak }, { list: leak }, { search: leak }]) {
      clearGoogleTokenCache();
      const checks = await diagnoseGoogleAds(deps(fakeHttp(options).http));
      expect(checks.some((check) => check.status === 'fail')).toBe(true);
      const all = JSON.stringify(checks);
      expect(all).not.toContain(REFRESH_TOKEN);
      expect(all).not.toContain('ya29');
    }
  });

  it('reports a transient failure as unknown, without advice', async () => {
    const timeout = (): never => {
      throw new AutopilotError('platform_error', 'timed out', { retryable: true });
    };
    const checks = await diagnoseGoogleAds(deps(fakeHttp({ list: timeout }).http));
    const check = byId(checks, 'api_access');
    expect(check.status).toBe('unknown');
    expect(check.detail).toBe('Could not be checked: timed out');
    expect('fix' in check).toBe(false);
    expect(statuses(checks).slice(3)).toEqual([
      'account_access:skipped',
      'account_query:skipped',
      'account_state:skipped',
      'config_match:skipped',
    ]);
  });

  it('reports a transient token failure as unknown and does not blame the OAuth client', async () => {
    const timeout = (): never => {
      throw new AutopilotError('platform_error', 'timed out', { retryable: true });
    };
    const checks = await diagnoseGoogleAds(deps(fakeHttp({ token: timeout }).http));
    const check = byId(checks, 'oauth_token');
    expect(check.status).toBe('unknown');
    expect('fix' in check).toBe(false);
    expect(byId(checks, 'api_access').status).toBe('skipped');
  });

  it('reports a rate limit on the account query as unknown', async () => {
    const limited = (): never => {
      throw new AutopilotError('rate_limited', 'POST x -> 429', {
        status: 429,
        body: 'RESOURCE_EXHAUSTED USER_PERMISSION_DENIED',
      });
    };
    const checks = await diagnoseGoogleAds(deps(fakeHttp({ search: limited }).http));
    const check = byId(checks, 'account_query');
    expect(check.status).toBe('unknown');
    expect(check.detail).toBe('Could not be checked: POST x -> 429');
    expect('fix' in check).toBe(false);
    expect(byId(checks, 'account_state').status).toBe('skipped');
    expect(checks.some((candidate) => candidate.id === 'access_level')).toBe(false);
  });

  it('classifies on the response body and keeps the body out of the detail', async () => {
    const denied = (): never => {
      throw new AutopilotError('platform_error', 'POST x -> 403', {
        status: 403,
        body: '{"error":{"details":[{"errors":[{"errorCode":{"authorizationError":"CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION"}}]}]}}',
      });
    };
    const check = byId(await diagnoseGoogleAds(deps(fakeHttp({ search: denied }).http)), 'account_query');
    expect(check.status).toBe('fail');
    expect(check.fix).toContain('Test access only');
    expect(check.detail).toBe('POST x -> 403');
    expect(check.detail).not.toContain('CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION');
  });

  it('says that only read access was tested', async () => {
    const checks = await diagnoseGoogleAds(deps(fakeHttp().http));
    expect(byId(checks, 'account_query').detail).toBe(
      'query answered. Read access works; write access is not tested here.',
    );
    expect(byId(checks, 'access_level').status).toBe('ok');
  });

  it('resolves when the client throws a plain Error', async () => {
    const boom = (): never => {
      throw new Error('socket hang up');
    };
    for (const [options, id] of [
      [{ token: boom }, 'oauth_token'],
      [{ list: boom }, 'api_access'],
      [{ search: boom }, 'account_query'],
    ] as const) {
      clearGoogleTokenCache();
      const checks = await diagnoseGoogleAds(deps(fakeHttp(options).http));
      const check = byId(checks, id);
      expect(check.status).toBe('fail');
      expect(check.detail).toContain('socket hang up');
    }
  });
});
