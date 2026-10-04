import { createHash, createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { credentialUnavailable, envFor } from '../core/env';
import { AutopilotError } from '../core/errors';
import type { AccountConfig, Env, HttpClient } from '../core/types';

export const GOOGLE_ADS_SCOPE = 'https://www.googleapis.com/auth/adwords';
export const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
export const SEARCH_CONSOLE_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CREDENTIALS_VAR = 'GOOGLE_APPLICATION_CREDENTIALS';
const REFRESH_VARS = [
  ['GOOGLE_CLIENT_ID', 'GOOGLE_ADS_CLIENT_ID'],
  ['GOOGLE_CLIENT_SECRET', 'GOOGLE_ADS_CLIENT_SECRET'],
  ['GOOGLE_REFRESH_TOKEN', 'GOOGLE_ADS_REFRESH_TOKEN'],
] as const;
const JWT_LIFETIME_SECONDS = 3600;
const DEFAULT_EXPIRES_IN_SECONDS = 3600;
const REUSE_MARGIN_MS = 60_000;

interface CachedToken {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

interface ServiceAccountKey {
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}

const cache = new Map<string, CachedToken>();

export function clearGoogleTokenCache(): void {
  cache.clear();
}

function envValue(env: Env, name: string): string | undefined {
  const value = env[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The three refresh-flow values, all from one scope so that two identities never mix: when any
 * account-prefixed name (canonical or alias) is set or is unavailable, every value comes from
 * prefixed names; otherwise every value comes from the global names. The canonical name wins over
 * its alias. An unavailable name has no value and blocks its fallbacks: an unavailable canonical
 * name is not replaced by its alias, and an unavailable prefixed name is not replaced by a global one.
 */
function resolveRefreshVars(env: Env, account: AccountConfig): { prefix: string; values: (string | undefined)[] } {
  const read = (prefix: string): (string | undefined)[] =>
    REFRESH_VARS.map(([name, alias]) => {
      if (credentialUnavailable(env, prefix + name)) return undefined;
      const canonical = envValue(env, prefix + name);
      if (canonical !== undefined) return canonical;
      return credentialUnavailable(env, prefix + alias) ? undefined : envValue(env, prefix + alias);
    });
  const prefix = account.envPrefix ?? '';
  if (prefix !== '') {
    const values = read(prefix);
    const claimed =
      values.some((value) => value !== undefined) ||
      REFRESH_VARS.some((names) => names.some((name) => credentialUnavailable(env, prefix + name)));
    if (claimed) return { prefix, values };
  }
  return { prefix: '', values: read('') };
}

/**
 * Names of the variables still needed for either the refresh-token or the service-account flow.
 * A name carries the account prefix when the refresh values resolve from the prefixed scope.
 */
export function googleAuthMissing(env: Env, account: AccountConfig): string[] {
  if (envFor(env, account, CREDENTIALS_VAR) !== undefined) return [];
  const { prefix, values } = resolveRefreshVars(env, account);
  const missing: string[] = [];
  REFRESH_VARS.forEach(([name], index) => {
    if (values[index] === undefined) missing.push(prefix + name);
  });
  return missing;
}

function cacheKey(flow: string, identity: string, scopes: string[]): string {
  return createHash('sha256')
    .update(JSON.stringify([flow, identity, [...scopes].sort()]))
    .digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readServiceAccountKey(file: string): ServiceAccountKey {
  const hint = `Point ${CREDENTIALS_VAR} at a service-account JSON key file with client_email and private_key.`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // The cause is dropped on purpose: a JSON parse error can quote key material.
    throw new AutopilotError('config_invalid', `Cannot read the service-account key file named by ${CREDENTIALS_VAR}.`, {
      hint,
    });
  }
  if (!isRecord(parsed) || typeof parsed.client_email !== 'string' || typeof parsed.private_key !== 'string') {
    throw new AutopilotError('config_invalid', 'The service-account key file lacks client_email or private_key.', {
      hint,
    });
  }
  return {
    clientEmail: parsed.client_email,
    privateKey: parsed.private_key,
    tokenUri: typeof parsed.token_uri === 'string' && parsed.token_uri !== '' ? parsed.token_uri : TOKEN_URL,
  };
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function signJwt(key: ServiceAccountKey, scopes: string[], now: Date): string {
  const iat = Math.floor(now.getTime() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: key.clientEmail,
      scope: scopes.join(' '),
      aud: key.tokenUri,
      iat,
      exp: iat + JWT_LIFETIME_SECONDS,
    }),
  );
  const unsigned = `${header}.${claims}`;
  let signature: string;
  try {
    signature = createSign('RSA-SHA256').update(unsigned).sign(key.privateKey, 'base64url');
  } catch {
    throw new AutopilotError('config_invalid', 'The service-account private key cannot sign a token request.', {
      hint: `Download a fresh JSON key and point ${CREDENTIALS_VAR} at it.`,
    });
  }
  return `${unsigned}.${signature}`;
}

async function requestToken(
  http: HttpClient,
  url: string,
  form: Record<string, string>,
  now: () => Date,
): Promise<CachedToken> {
  const response = await http.request<unknown>({ method: 'POST', url, form, retry: true });
  const body = response.body;
  if (!isRecord(body) || typeof body.access_token !== 'string' || body.access_token === '') {
    throw new AutopilotError('platform_error', 'Google token endpoint returned no access_token.', {
      hint: 'Check that the Google credentials are valid and not revoked.',
    });
  }
  const expiresIn =
    typeof body.expires_in === 'number' && Number.isFinite(body.expires_in) && body.expires_in > 0
      ? body.expires_in
      : DEFAULT_EXPIRES_IN_SECONDS;
  return { token: body.access_token, expiresAt: now().getTime() + expiresIn * 1000 };
}

/** A cached OAuth access token for `scopes`. */
export async function getGoogleAccessToken(options: {
  env: Env;
  account: AccountConfig;
  http: HttpClient;
  scopes: string[];
  now: () => Date;
}): Promise<string> {
  const { env, account, http, scopes, now } = options;
  const [clientId, clientSecret, refreshToken] = resolveRefreshVars(env, account).values;
  const credentialsFile = envFor(env, account, CREDENTIALS_VAR);

  let key: string;
  let fetchToken: () => Promise<CachedToken>;
  if (clientId !== undefined && clientSecret !== undefined && refreshToken !== undefined) {
    key = cacheKey('refresh', `${clientId}\n${refreshToken}`, scopes);
    fetchToken = () =>
      requestToken(
        http,
        TOKEN_URL,
        {
          grant_type: 'refresh_token',
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
        },
        now,
      );
  } else if (credentialsFile !== undefined) {
    const serviceKey = readServiceAccountKey(credentialsFile);
    key = cacheKey('service_account', `${serviceKey.clientEmail}\n${serviceKey.tokenUri}`, scopes);
    fetchToken = () =>
      requestToken(
        http,
        serviceKey.tokenUri,
        {
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: signJwt(serviceKey, scopes, now()),
        },
        now,
      );
  } else {
    const names = REFRESH_VARS.map(([name]) => name);
    const prefix = account.envPrefix ?? '';
    throw new AutopilotError('not_configured', `Google credentials are not configured for account '${account.id}'.`, {
      hint:
        `Set ${names.map((name) => prefix + name).join(', ')} ` +
        `(missing: ${googleAuthMissing(env, account).join(', ')}), or set ${prefix}${CREDENTIALS_VAR} to a service-account key file.`,
    });
  }

  const cached = cache.get(key);
  if (cached !== undefined && now().getTime() < cached.expiresAt - REUSE_MARGIN_MS) return cached.token;
  const fresh = await fetchToken();
  cache.set(key, fresh);
  return fresh.token;
}
