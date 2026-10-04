import { beforeEach, describe, expect, it } from 'vitest';
import { clearGoogleTokenCache } from '../../src/connectors/google-auth';
import { clearMauticTokenCache } from '../../src/connectors/mautic-read';
import { diagnoseGa4, diagnoseMautic, diagnoseSearchConsole } from '../../src/connectors/other-diagnose';
import { AutopilotError } from '../../src/core/errors';
import type { AccountConfig, ConnectorDeps, DiagnosticCheck, Env, HttpClient, HttpRequest } from '../../src/core/types';

const GOOGLE_ENV: Env = {
  GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'client-secret-value-123',
  GOOGLE_REFRESH_TOKEN: 'refresh-token-value-1234567890',
};
const MAUTIC_ENV: Env = {
  MAUTIC_CLIENT_ID: 'mautic-client-id-12345',
  MAUTIC_CLIENT_SECRET: 'mautic-client-secret-98765',
};
const ACCESS_TOKEN = 'ya29.access-token-value';
const SECRETS = [
  'client-secret-value-123',
  'refresh-token-value-1234567890',
  'mautic-client-secret-98765',
  ACCESS_TOKEN,
];
const READ_ONLY_NOTE = 'Read access works; write access is not tested here.';

type Reply = unknown | (() => unknown);

function fakeHttp(read?: Reply, token?: Reply): { http: HttpClient; calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  const resolve = (reply: Reply, fallback: unknown): unknown => {
    if (reply === undefined) return fallback;
    return typeof reply === 'function' ? (reply as () => unknown)() : reply;
  };
  const http: HttpClient = {
    request: async <T>(request: HttpRequest) => {
      calls.push(request);
      const isToken = request.url.includes('oauth2.googleapis.com') || request.url.endsWith('/oauth/v2/token');
      const body = isToken
        ? resolve(token, { access_token: ACCESS_TOKEN, expires_in: 3600 })
        : resolve(read, { permissionLevel: 'siteOwner', total: 0, lists: [] });
      return { status: 200, headers: {}, body: body as T };
    },
  };
  return { http, calls };
}

function thrower(error: Error): () => never {
  return () => {
    throw error;
  };
}

function httpError(status: number, body: string, message = `HTTP ${status}`): () => never {
  return thrower(new AutopilotError('platform_error', message, { status, body }));
}

const ACCOUNTS = {
  ga4: { id: 'acme-ga4', platform: 'ga4', externalId: '123456789' },
  gsc: { id: 'acme-gsc', platform: 'search_console', externalId: 'sc-domain:example.com' },
  mautic: { id: 'acme-mautic', platform: 'mautic', externalId: 'https://mautic.example.com/' },
} satisfies Record<string, AccountConfig>;

function deps(account: AccountConfig, http: HttpClient, env: Env): ConnectorDeps {
  return { account, env, http, now: () => new Date('2026-10-04T10:00:00Z') };
}

function statuses(checks: DiagnosticCheck[]): Record<string, string> {
  return Object.fromEntries(checks.map((check) => [check.id, check.status]));
}

function byId(checks: DiagnosticCheck[], id: string): DiagnosticCheck {
  const check = checks.find((item) => item.id === id);
  if (check === undefined) throw new Error(`no check ${id}`);
  return check;
}

function expectNoSecret(checks: DiagnosticCheck[]): void {
  const text = JSON.stringify(checks);
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

beforeEach(() => {
  clearGoogleTokenCache();
  clearMauticTokenCache();
});

describe('diagnoseGa4', () => {
  const run = (read?: Reply, token?: Reply, env: Env = GOOGLE_ENV) => {
    const fake = fakeHttp(read, token);
    return diagnoseGa4(deps(ACCOUNTS.ga4, fake.http, env)).then((checks) => ({ checks, calls: fake.calls }));
  };

  it('reports every check ok', async () => {
    const { checks, calls } = await run();
    expect(statuses(checks)).toEqual({ credentials: 'ok', oauth_token: 'ok', property_access: 'ok' });
    expect(byId(checks, 'property_access').detail).toBe(`property 123456789 answered. ${READ_ONLY_NOTE}`);
    expect(calls[1]?.url).toBe('https://analyticsdata.googleapis.com/v1beta/properties/123456789/metadata');
    expect(calls[1]?.headers?.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expectNoSecret(checks);
  });

  it('fails a 200 whose body is not a JSON object', async () => {
    const { checks } = await run('<html><body>Sign in</body></html>');
    const check = byId(checks, 'property_access');
    expect(check.status).toBe('fail');
    expect(check.detail).toBe('The server answered, but not with the Google API: the response is not the expected JSON.');
    expect(check.fix).toBeUndefined();
  });

  it('strips the properties/ prefix of externalId', async () => {
    const fake = fakeHttp();
    const account: AccountConfig = { ...ACCOUNTS.ga4, externalId: 'properties/42' };
    const checks = await diagnoseGa4(deps(account, fake.http, GOOGLE_ENV));
    expect(byId(checks, 'property_access').detail).toContain('property 42 answered.');
  });

  it('stops without a call when credentials are missing', async () => {
    const { checks, calls } = await run(undefined, undefined, {});
    expect(calls).toHaveLength(0);
    expect(statuses(checks)).toEqual({ credentials: 'fail', oauth_token: 'skipped', property_access: 'skipped' });
    expect(byId(checks, 'credentials').detail).toContain('GOOGLE_REFRESH_TOKEN');
    expect(byId(checks, 'credentials').fix).toBeDefined();
  });

  it('maps invalid_grant to the refresh-token fix', async () => {
    const { checks } = await run(undefined, httpError(400, '{"error":"invalid_grant"}'));
    expect(statuses(checks)).toEqual({ credentials: 'ok', oauth_token: 'fail', property_access: 'skipped' });
    expect(byId(checks, 'oauth_token').fix).toContain('refresh token expired or was revoked');
  });

  it('maps 403 to the access fix', async () => {
    const { checks } = await run(httpError(403, '{"error":{"status":"PERMISSION_DENIED"}}'));
    const check = byId(checks, 'property_access');
    expect(check.status).toBe('fail');
    expect(check.fix).toContain('Viewer access to the GA4 property');
    expect(check.detail).toBe('HTTP 403');
  });

  it('maps 404, and a 400 naming the property, to the externalId fix', async () => {
    const notFound = await run(httpError(404, '{"error":{"status":"NOT_FOUND"}}'));
    expect(byId(notFound.checks, 'property_access').fix).toContain('numeric property id');
    const invalid = await run(httpError(400, '{"error":{"message":"Invalid property ID: G-ABC"}}'));
    expect(byId(invalid.checks, 'property_access').fix).toContain('numeric property id');
  });

  it('gives the message and no fix for another failure', async () => {
    const { checks } = await run(httpError(400, '{"error":{"message":"bad request"}}', 'bad request'));
    const check = byId(checks, 'property_access');
    expect(check.status).toBe('fail');
    expect(check.detail).toBe('bad request');
    expect(check.fix).toBeUndefined();
  });

  it('reports a retryable error as unknown without a fix', async () => {
    const error = new AutopilotError('platform_error', 'HTTP 503', { retryable: true, status: 503 });
    const { checks } = await run(thrower(error));
    const check = byId(checks, 'property_access');
    expect(check.status).toBe('unknown');
    expect(check.fix).toBeUndefined();
  });

  it('keeps secrets and the response body out of the result', async () => {
    const body = `{"error":{"status":"PERMISSION_DENIED","token":"${ACCESS_TOKEN}"}}`;
    const { checks } = await run(httpError(403, body, `denied for client-secret-value-123`));
    expectNoSecret(checks);
    expect(JSON.stringify(checks)).not.toContain('PERMISSION_DENIED');
  });

  it('resolves when the client throws a plain Error', async () => {
    const { checks } = await run(thrower(new Error('socket closed')));
    expect(byId(checks, 'property_access')).toMatchObject({ status: 'fail', detail: 'socket closed' });
    clearGoogleTokenCache();
    const early = await run(undefined, thrower(new Error('socket closed')));
    expect(statuses(early.checks)).toEqual({ credentials: 'ok', oauth_token: 'fail', property_access: 'skipped' });
  });
});

describe('diagnoseSearchConsole', () => {
  const run = (read?: Reply, token?: Reply, env: Env = GOOGLE_ENV) => {
    const fake = fakeHttp(read, token);
    return diagnoseSearchConsole(deps(ACCOUNTS.gsc, fake.http, env)).then((checks) => ({ checks, calls: fake.calls }));
  };

  it('reports every check ok with the permission level', async () => {
    const { checks, calls } = await run();
    expect(statuses(checks)).toEqual({ credentials: 'ok', oauth_token: 'ok', site_access: 'ok' });
    expect(byId(checks, 'site_access').detail).toBe(
      `site sc-domain:example.com answered, permission siteOwner. ${READ_ONLY_NOTE}`,
    );
    expect(calls[1]?.url).toBe('https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com');
    expect(calls[1]?.method).toBe('GET');
    expectNoSecret(checks);
  });

  it('fails a 200 whose body is not a JSON object', async () => {
    const { checks } = await run('<html><body>Sign in</body></html>');
    const check = byId(checks, 'site_access');
    expect(check.status).toBe('fail');
    expect(check.detail).toBe('The server answered, but not with the Google API: the response is not the expected JSON.');
    expect(check.fix).toBeUndefined();
  });

  it('leaves the permission out when the response has none', async () => {
    const { checks } = await run({ siteUrl: 'sc-domain:example.com' });
    expect(byId(checks, 'site_access').detail).toBe(`site sc-domain:example.com answered. ${READ_ONLY_NOTE}`);
  });

  it('stops without a call when credentials are missing', async () => {
    const { checks, calls } = await run(undefined, undefined, {});
    expect(calls).toHaveLength(0);
    expect(statuses(checks)).toEqual({ credentials: 'fail', oauth_token: 'skipped', site_access: 'skipped' });
  });

  it('maps invalid_grant to the refresh-token fix', async () => {
    const { checks } = await run(undefined, httpError(400, '{"error":"invalid_grant"}'));
    expect(byId(checks, 'oauth_token').fix).toContain('refresh token expired or was revoked');
    expect(byId(checks, 'site_access').status).toBe('skipped');
  });

  it('maps 403 and 404 to the property fix', async () => {
    for (const status of [403, 404]) {
      const { checks } = await run(httpError(status, '{}'));
      const check = byId(checks, 'site_access');
      expect(check.status).toBe('fail');
      expect(check.fix).toContain('Add the Google account as a user of the property in Search Console');
    }
  });

  it('gives no fix for another failure', async () => {
    const { checks } = await run(httpError(400, '{}', 'bad request'));
    expect(byId(checks, 'site_access')).toEqual({
      id: 'site_access',
      label: 'The Search Console site can be read',
      status: 'fail',
      detail: 'bad request',
    });
  });

  it('reports a retryable error as unknown without a fix', async () => {
    const { checks } = await run(thrower(new AutopilotError('rate_limited', 'HTTP 429', { status: 429 })));
    const check = byId(checks, 'site_access');
    expect(check.status).toBe('unknown');
    expect(check.fix).toBeUndefined();
  });

  it('keeps secrets out of the result', async () => {
    const { checks } = await run(httpError(403, `{"t":"${ACCESS_TOKEN}"}`, 'denied refresh-token-value-1234567890'));
    expectNoSecret(checks);
  });

  it('resolves when the client throws a plain Error', async () => {
    const { checks } = await run(thrower(new Error('socket closed')));
    expect(byId(checks, 'site_access')).toMatchObject({ status: 'fail', detail: 'socket closed' });
  });
});

describe('diagnoseMautic', () => {
  const run = (read?: Reply, token?: Reply, env: Env = MAUTIC_ENV) => {
    const fake = fakeHttp(read, token);
    return diagnoseMautic(deps(ACCOUNTS.mautic, fake.http, env)).then((checks) => ({ checks, calls: fake.calls }));
  };

  it('reports every check ok', async () => {
    const { checks, calls } = await run();
    expect(statuses(checks)).toEqual({ credentials: 'ok', api_access: 'ok' });
    expect(byId(checks, 'api_access').detail).toBe(`Mautic API answered. ${READ_ONLY_NOTE}`);
    expect(calls[1]?.url).toBe('https://mautic.example.com/api/segments');
    expect(calls[1]?.query).toEqual({ limit: 1 });
    expectNoSecret(checks);
  });

  it('fails a 200 that is an HTML page or JSON of another shape', async () => {
    for (const body of ['<html><body>Login</body></html>', { errors: [] }, []]) {
      clearMauticTokenCache();
      const { checks } = await run(body);
      expect(byId(checks, 'api_access')).toEqual({
        id: 'api_access',
        label: 'The Mautic API answers',
        status: 'fail',
        detail: 'The server answered, but not with the Mautic API: the response is not the expected JSON.',
        fix: 'Check externalId: it is the base URL of the Mautic instance, and the API must be enabled in the Mautic configuration.',
      });
    }
  });

  it('accepts the segments shape with either key', async () => {
    for (const body of [{ total: 3, lists: { 1: { id: 1 } } }, { lists: [] }, { total: '0' }]) {
      clearMauticTokenCache();
      const { checks } = await run(body);
      expect(byId(checks, 'api_access').status).toBe('ok');
    }
  });

  it('works with a user name and password, without a token call', async () => {
    const { checks, calls } = await run(undefined, undefined, { MAUTIC_USERNAME: 'admin', MAUTIC_PASSWORD: 'pass-word-123456' });
    expect(statuses(checks)).toEqual({ credentials: 'ok', api_access: 'ok' });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(checks)).not.toContain('pass-word-123456');
  });

  it('stops without a call when credentials are missing', async () => {
    const { checks, calls } = await run(undefined, undefined, {});
    expect(calls).toHaveLength(0);
    expect(statuses(checks)).toEqual({ credentials: 'fail', api_access: 'skipped' });
    expect(byId(checks, 'credentials').detail).toContain('MAUTIC_CLIENT_ID');
  });

  it('maps 401 to the credentials fix', async () => {
    const { checks } = await run(httpError(401, '{"errors":[{"code":401}]}'));
    const check = byId(checks, 'api_access');
    expect(check.status).toBe('fail');
    expect(check.fix).toContain('API access is enabled in the Mautic configuration');
  });

  it('maps 404 to the base URL fix', async () => {
    const { checks } = await run(httpError(404, '<html>404 Not Found</html>'));
    expect(byId(checks, 'api_access').fix).toContain('base URL of the Mautic instance, without /api');
  });

  it('gives the message and no fix for another failure', async () => {
    const { checks } = await run(httpError(400, '{}', 'bad request'));
    const check = byId(checks, 'api_access');
    expect(check.detail).toBe('bad request');
    expect(check.fix).toBeUndefined();
  });

  it('reports a retryable error as unknown without a fix', async () => {
    const error = new AutopilotError('platform_error', 'request timed out', { retryable: true });
    const { checks } = await run(undefined, thrower(error));
    const check = byId(checks, 'api_access');
    expect(check.status).toBe('unknown');
    expect(check.fix).toBeUndefined();
  });

  it('keeps secrets out of the result', async () => {
    const { checks } = await run(httpError(401, `{"s":"mautic-client-secret-98765"}`, 'denied mautic-client-secret-98765'));
    expectNoSecret(checks);
  });

  it('resolves when the client throws a plain Error', async () => {
    const { checks } = await run(thrower(new Error('socket closed')));
    expect(byId(checks, 'api_access')).toMatchObject({ status: 'fail', detail: 'socket closed' });
  });
});
