import { createVerify, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  GA4_SCOPE,
  GOOGLE_ADS_SCOPE,
  clearGoogleTokenCache,
  getGoogleAccessToken,
  googleAuthMissing,
} from '../../src/connectors/google-auth';
import { loadEnv } from '../../src/core/env';
import { AutopilotError } from '../../src/core/errors';
import { resolvePaths } from '../../src/core/paths';
import type { AccountConfig, Env, HttpClient, HttpRequest, HttpResponse, JsonValue } from '../../src/core/types';

const account: AccountConfig = { id: 'acme-google', platform: 'google_ads', externalId: '1234567890' };
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function fakeHttp(bodies: JsonValue[]): { http: HttpClient; requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  let index = 0;
  const http: HttpClient = {
    request<T = JsonValue>(request: HttpRequest): Promise<HttpResponse<T>> {
      requests.push(request);
      const body = bodies[Math.min(index, bodies.length - 1)] ?? null;
      index += 1;
      return Promise.resolve({ status: 200, headers: {}, body: body as T });
    },
  };
  return { http, requests };
}

function clock(startIso: string): { now: () => Date; advance: (seconds: number) => void } {
  let ms = Date.parse(startIso);
  return {
    now: () => new Date(ms),
    advance: (seconds) => {
      ms += seconds * 1000;
    },
  };
}

const refreshEnv = {
  GOOGLE_CLIENT_ID: 'client-id-1',
  GOOGLE_CLIENT_SECRET: 'client-secret-1',
  GOOGLE_REFRESH_TOKEN: 'refresh-token-1',
};

beforeEach(() => {
  clearGoogleTokenCache();
});

describe('googleAuthMissing', () => {
  it('lists the canonical names that are missing', () => {
    expect(googleAuthMissing({}, account)).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN']);
    expect(googleAuthMissing({ GOOGLE_CLIENT_ID: 'x', GOOGLE_ADS_CLIENT_SECRET: 'y' }, account)).toEqual([
      'GOOGLE_REFRESH_TOKEN',
    ]);
  });

  it('is empty when either flow is configured', () => {
    expect(googleAuthMissing(refreshEnv, account)).toEqual([]);
    expect(googleAuthMissing({ GOOGLE_APPLICATION_CREDENTIALS: '/some/key.json' }, account)).toEqual([]);
  });
});

describe('credential scope', () => {
  const prefixed: AccountConfig = { ...account, envPrefix: 'ACME_' };

  it('prefers a prefixed alias over a global canonical value', async () => {
    const { http, requests } = fakeHttp([{ access_token: 'token-a', expires_in: 3600 }]);
    const env = {
      ...refreshEnv,
      ACME_GOOGLE_ADS_CLIENT_ID: 'acme-client',
      ACME_GOOGLE_ADS_CLIENT_SECRET: 'acme-secret',
      ACME_GOOGLE_ADS_REFRESH_TOKEN: 'acme-refresh',
    };
    await getGoogleAccessToken({
      env,
      account: prefixed,
      http,
      scopes: [GOOGLE_ADS_SCOPE],
      now: clock('2026-01-01T00:00:00Z').now,
    });
    expect(requests[0]?.form).toEqual({
      grant_type: 'refresh_token',
      client_id: 'acme-client',
      client_secret: 'acme-secret',
      refresh_token: 'acme-refresh',
    });
  });

  it('prefers the prefixed canonical name over the prefixed alias', () => {
    const env = { ACME_GOOGLE_CLIENT_ID: 'a', ACME_GOOGLE_ADS_CLIENT_ID: 'b', ACME_GOOGLE_CLIENT_SECRET: 'c' };
    expect(googleAuthMissing(env, prefixed)).toEqual(['ACME_GOOGLE_REFRESH_TOKEN']);
  });

  it('reports a missing prefixed value instead of borrowing the global one', async () => {
    const { http, requests } = fakeHttp([{ access_token: 'token-a', expires_in: 3600 }]);
    const env = { ...refreshEnv, ACME_GOOGLE_CLIENT_ID: 'acme-client', ACME_GOOGLE_ADS_CLIENT_SECRET: 'acme-secret' };
    expect(googleAuthMissing(env, prefixed)).toEqual(['ACME_GOOGLE_REFRESH_TOKEN']);
    await expect(
      getGoogleAccessToken({
        env,
        account: prefixed,
        http,
        scopes: [GOOGLE_ADS_SCOPE],
        now: clock('2026-01-01T00:00:00Z').now,
      }),
    ).rejects.toMatchObject({ code: 'not_configured' });
    expect(requests).toHaveLength(0);
  });

  it('uses the global values when no prefixed value is set', () => {
    expect(googleAuthMissing(refreshEnv, prefixed)).toEqual([]);
  });
});

describe('getGoogleAccessToken: refresh flow', () => {
  it('posts the refresh grant and caches until 60 seconds before expiry', async () => {
    const { http, requests } = fakeHttp([
      { access_token: 'token-a', expires_in: 3600 },
      { access_token: 'token-b', expires_in: 3600 },
    ]);
    const time = clock('2026-01-01T00:00:00Z');
    const options = { env: refreshEnv, account, http, scopes: [GOOGLE_ADS_SCOPE], now: time.now };

    expect(await getGoogleAccessToken(options)).toBe('token-a');
    expect(requests).toEqual([
      {
        method: 'POST',
        url: TOKEN_URL,
        form: {
          grant_type: 'refresh_token',
          client_id: 'client-id-1',
          client_secret: 'client-secret-1',
          refresh_token: 'refresh-token-1',
        },
        retry: true,
      },
    ]);

    time.advance(3600 - 61);
    expect(await getGoogleAccessToken(options)).toBe('token-a');
    expect(requests).toHaveLength(1);

    time.advance(2);
    expect(await getGoogleAccessToken(options)).toBe('token-b');
    expect(requests).toHaveLength(2);
  });

  it('caches per scope set, regardless of scope order', async () => {
    const { http, requests } = fakeHttp([{ access_token: 'token-a', expires_in: 3600 }]);
    const time = clock('2026-01-01T00:00:00Z');
    const base = { env: refreshEnv, account, http, now: time.now };
    await getGoogleAccessToken({ ...base, scopes: [GOOGLE_ADS_SCOPE, GA4_SCOPE] });
    await getGoogleAccessToken({ ...base, scopes: [GA4_SCOPE, GOOGLE_ADS_SCOPE] });
    expect(requests).toHaveLength(1);
    await getGoogleAccessToken({ ...base, scopes: [GA4_SCOPE] });
    expect(requests).toHaveLength(2);
  });

  it('accepts the GOOGLE_ADS_ alias variables', async () => {
    const { http, requests } = fakeHttp([{ access_token: 'token-a', expires_in: 3600 }]);
    const env = {
      GOOGLE_ADS_CLIENT_ID: 'alias-id',
      GOOGLE_ADS_CLIENT_SECRET: 'alias-secret',
      GOOGLE_ADS_REFRESH_TOKEN: 'alias-refresh',
    };
    const token = await getGoogleAccessToken({
      env,
      account,
      http,
      scopes: [GOOGLE_ADS_SCOPE],
      now: clock('2026-01-01T00:00:00Z').now,
    });
    expect(token).toBe('token-a');
    expect(requests[0]?.form).toEqual({
      grant_type: 'refresh_token',
      client_id: 'alias-id',
      client_secret: 'alias-secret',
      refresh_token: 'alias-refresh',
    });
  });

  it('honours account.envPrefix', async () => {
    const { http, requests } = fakeHttp([{ access_token: 'token-a', expires_in: 3600 }]);
    const env = {
      ...refreshEnv,
      ACME_GOOGLE_CLIENT_ID: 'acme-id',
      ACME_GOOGLE_CLIENT_SECRET: 'acme-secret',
      ACME_GOOGLE_ADS_REFRESH_TOKEN: 'acme-refresh',
    };
    await getGoogleAccessToken({
      env,
      account: { ...account, envPrefix: 'ACME_' },
      http,
      scopes: [GOOGLE_ADS_SCOPE],
      now: clock('2026-01-01T00:00:00Z').now,
    });
    expect(requests[0]?.form?.client_id).toBe('acme-id');
    expect(requests[0]?.form?.client_secret).toBe('acme-secret');
  });

  it('throws platform_error when the response has no access_token', async () => {
    const { http } = fakeHttp([{ error: 'invalid_grant' }]);
    const error = await getGoogleAccessToken({
      env: refreshEnv,
      account,
      http,
      scopes: [GOOGLE_ADS_SCOPE],
      now: clock('2026-01-01T00:00:00Z').now,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AutopilotError);
    const typed = error as AutopilotError;
    expect(typed.code).toBe('platform_error');
    expect(`${typed.message} ${typed.hint ?? ''}`).not.toContain('client-secret-1');
    expect(`${typed.message} ${typed.hint ?? ''}`).not.toContain('refresh-token-1');
  });
});

describe('getGoogleAccessToken: service account flow', () => {
  function writeKey(tokenUri?: string): { file: string; publicKey: string } {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-'));
    const file = path.join(dir, 'key.json');
    const key: Record<string, string> = { client_email: 'robot@project.iam.gserviceaccount.com', private_key: privateKey };
    if (tokenUri !== undefined) key.token_uri = tokenUri;
    fs.writeFileSync(file, JSON.stringify(key));
    return { file, publicKey };
  }

  it('signs a JWT assertion with the key file and caches the token', async () => {
    const { file, publicKey } = writeKey('https://example.test/token');
    const { http, requests } = fakeHttp([{ access_token: 'sa-token', expires_in: 3600 }]);
    const time = clock('2026-01-01T00:00:00Z');
    const options = {
      env: { GOOGLE_APPLICATION_CREDENTIALS: file },
      account,
      http,
      scopes: [GA4_SCOPE, GOOGLE_ADS_SCOPE],
      now: time.now,
    };

    expect(await getGoogleAccessToken(options)).toBe('sa-token');
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('https://example.test/token');
    expect(request?.retry).toBe(true);
    expect(request?.form?.grant_type).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');

    const parts = (request?.form?.assertion ?? '').split('.');
    expect(parts).toHaveLength(3);
    const [header, claims, signature] = parts as [string, string, string];
    expect(JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))).toEqual({ alg: 'RS256', typ: 'JWT' });
    const iat = Date.parse('2026-01-01T00:00:00Z') / 1000;
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'))).toEqual({
      iss: 'robot@project.iam.gserviceaccount.com',
      scope: `${GA4_SCOPE} ${GOOGLE_ADS_SCOPE}`,
      aud: 'https://example.test/token',
      iat,
      exp: iat + 3600,
    });
    expect(createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, signature, 'base64url')).toBe(true);

    expect(await getGoogleAccessToken(options)).toBe('sa-token');
    expect(requests).toHaveLength(1);
  });

  it('defaults aud and the endpoint to the Google token URL', async () => {
    const { file } = writeKey();
    const { http, requests } = fakeHttp([{ access_token: 'sa-token', expires_in: 3600 }]);
    await getGoogleAccessToken({
      env: { GOOGLE_APPLICATION_CREDENTIALS: file },
      account,
      http,
      scopes: [GA4_SCOPE],
      now: clock('2026-01-01T00:00:00Z').now,
    });
    expect(requests[0]?.url).toBe(TOKEN_URL);
    const claims = (requests[0]?.form?.assertion ?? '').split('.')[1] ?? '';
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'))).toMatchObject({ aud: TOKEN_URL });
  });

  it('prefers the refresh flow when both are configured', async () => {
    const { file } = writeKey();
    const { http, requests } = fakeHttp([{ access_token: 'token-a', expires_in: 3600 }]);
    await getGoogleAccessToken({
      env: { ...refreshEnv, GOOGLE_APPLICATION_CREDENTIALS: file },
      account,
      http,
      scopes: [GOOGLE_ADS_SCOPE],
      now: clock('2026-01-01T00:00:00Z').now,
    });
    expect(requests[0]?.form?.grant_type).toBe('refresh_token');
  });

  it('reports an unreadable key file as config_invalid', async () => {
    const { http, requests } = fakeHttp([{ access_token: 'x' }]);
    const error = await getGoogleAccessToken({
      env: { GOOGLE_APPLICATION_CREDENTIALS: path.join(os.tmpdir(), 'apm-missing', 'none.json') },
      account,
      http,
      scopes: [GA4_SCOPE],
      now: clock('2026-01-01T00:00:00Z').now,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AutopilotError);
    expect((error as AutopilotError).code).toBe('config_invalid');
    expect(requests).toHaveLength(0);
  });
});

describe('getGoogleAccessToken: not configured', () => {
  it('lists variable names and no values', async () => {
    const { http, requests } = fakeHttp([{ access_token: 'x' }]);
    const error = await getGoogleAccessToken({
      env: { GOOGLE_CLIENT_ID: 'client-id-1', GOOGLE_CLIENT_SECRET: 'client-secret-1' },
      account,
      http,
      scopes: [GOOGLE_ADS_SCOPE],
      now: clock('2026-01-01T00:00:00Z').now,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AutopilotError);
    const typed = error as AutopilotError;
    expect(typed.code).toBe('not_configured');
    const text = `${typed.message} ${typed.hint ?? ''}`;
    expect(text).toContain('GOOGLE_CLIENT_ID');
    expect(text).toContain('GOOGLE_CLIENT_SECRET');
    expect(text).toContain('GOOGLE_REFRESH_TOKEN');
    expect(text).toContain('GOOGLE_APPLICATION_CREDENTIALS');
    expect(text).not.toContain('client-id-1');
    expect(text).not.toContain('client-secret-1');
    expect(requests).toHaveLength(0);
  });
});

describe('unavailable credentials', () => {
  const prefixed: AccountConfig = { ...account, envPrefix: 'ACME_' };

  /** An environment on a temp home in which `blocked` names are registered but unreadable. */
  function envWith(base: Env, blocked: string[]): Env {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-home-'));
    return loadEnv(resolvePaths({ AUTOPILOT_HOME: dir }), base, { values: {}, blocked });
  }

  async function rejection(env: Env, target: AccountConfig): Promise<{ error: unknown; requests: HttpRequest[] }> {
    const { http, requests } = fakeHttp([{ access_token: 'token-a', expires_in: 3600 }]);
    const error = await getGoogleAccessToken({
      env,
      account: target,
      http,
      scopes: [GOOGLE_ADS_SCOPE],
      now: clock('2026-01-01T00:00:00Z').now,
    }).catch((caught: unknown) => caught);
    return { error, requests };
  }

  it('does not fall back to the global identity when the prefixed refresh token is unavailable', async () => {
    const env = envWith(refreshEnv, ['ACME_GOOGLE_REFRESH_TOKEN']);
    expect(googleAuthMissing(env, prefixed)).toEqual([
      'ACME_GOOGLE_CLIENT_ID',
      'ACME_GOOGLE_CLIENT_SECRET',
      'ACME_GOOGLE_REFRESH_TOKEN',
    ]);
    const { error, requests } = await rejection(env, prefixed);
    expect(error).toMatchObject({ code: 'not_configured' });
    expect((error as AutopilotError).hint ?? '').toContain('ACME_GOOGLE_REFRESH_TOKEN');
    expect(requests).toHaveLength(0);
  });

  it('selects the prefixed scope when only a prefixed alias is unavailable', () => {
    const env = envWith(refreshEnv, ['ACME_GOOGLE_ADS_CLIENT_ID']);
    expect(googleAuthMissing(env, prefixed)).toEqual([
      'ACME_GOOGLE_CLIENT_ID',
      'ACME_GOOGLE_CLIENT_SECRET',
      'ACME_GOOGLE_REFRESH_TOKEN',
    ]);
  });

  it('does not replace an unavailable canonical name with its alias', async () => {
    const env = envWith(
      {
        GOOGLE_CLIENT_ID: 'client-id-1',
        GOOGLE_CLIENT_SECRET: 'client-secret-1',
        GOOGLE_ADS_REFRESH_TOKEN: 'stale-refresh',
      },
      ['GOOGLE_REFRESH_TOKEN'],
    );
    expect(googleAuthMissing(env, account)).toEqual(['GOOGLE_REFRESH_TOKEN']);
    const { error, requests } = await rejection(env, account);
    expect(error).toMatchObject({ code: 'not_configured' });
    expect(requests).toHaveLength(0);
  });

  it('ignores an unavailable alias when the canonical name has a value', async () => {
    const env = envWith(refreshEnv, ['GOOGLE_ADS_REFRESH_TOKEN']);
    expect(googleAuthMissing(env, account)).toEqual([]);
    const { http, requests } = fakeHttp([{ access_token: 'token-a', expires_in: 3600 }]);
    await getGoogleAccessToken({
      env,
      account,
      http,
      scopes: [GOOGLE_ADS_SCOPE],
      now: clock('2026-01-01T00:00:00Z').now,
    });
    expect(requests[0]?.form?.refresh_token).toBe('refresh-token-1');
  });

  it('does not fall back to the global service-account file when the prefixed one is unavailable', async () => {
    const env = envWith({ GOOGLE_APPLICATION_CREDENTIALS: '/some/global-key.json' }, [
      'ACME_GOOGLE_APPLICATION_CREDENTIALS',
    ]);
    expect(googleAuthMissing(env, prefixed)).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN']);
    const { error, requests } = await rejection(env, prefixed);
    expect(error).toMatchObject({ code: 'not_configured' });
    expect(requests).toHaveLength(0);
  });

  it('behaves as before when nothing is unavailable', () => {
    const env = envWith(refreshEnv, []);
    expect(googleAuthMissing(env, prefixed)).toEqual([]);
    expect(googleAuthMissing(env, account)).toEqual([]);
  });
});
