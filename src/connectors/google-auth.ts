import { createHash, createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { credentialUnavailable } from '../core/env';
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

interface GoogleCredentials {
  /** The prefix of the one scope every value below comes from: the account's prefix, or ''. */
  prefix: string;
  /** Client id, client secret and refresh token, in `REFRESH_VARS` order. */
  refresh: (string | undefined)[];
  credentialsFile: string | undefined;
  /** Names of the scope that are needed and cannot be read. Non-empty means no flow may be selected. */
  unavailable: string[];
}

/**
 * Every Google credential of the account, from one scope so that two identities never mix. The
 * scope is the prefixed one when the account has a prefix and any prefixed Google name (refresh
 * names, their aliases, the credentials-file variable) has a value or is unavailable; otherwise it
 * is the global one. Nothing is ever read from the other scope.
 *
 * The canonical refresh name wins over its alias. An unavailable name has no value and blocks its
 * fallbacks: an unavailable canonical name is not replaced by its alias, and an unavailable alias
 * counts only when the canonical name has no value. An unavailable alias is reported under its
 * canonical name.
 */
function resolveGoogleCredentials(env: Env, account: AccountConfig): GoogleCredentials {
  const read = (prefix: string): GoogleCredentials => {
    const unavailable: string[] = [];
    const refresh = REFRESH_VARS.map(([name, alias]) => {
      if (!credentialUnavailable(env, prefix + name)) {
        const canonical = envValue(env, prefix + name);
        if (canonical !== undefined) return canonical;
        if (!credentialUnavailable(env, prefix + alias)) return envValue(env, prefix + alias);
      }
      unavailable.push(prefix + name);
      return undefined;
    });
    const fileUnavailable = credentialUnavailable(env, prefix + CREDENTIALS_VAR);
    if (fileUnavailable) unavailable.push(prefix + CREDENTIALS_VAR);
    const credentialsFile = fileUnavailable ? undefined : envValue(env, prefix + CREDENTIALS_VAR);
    return { prefix, refresh, credentialsFile, unavailable };
  };
  const prefix = account.envPrefix ?? '';
  if (prefix !== '') {
    const scoped = read(prefix);
    const claimed =
      scoped.unavailable.length > 0 ||
      scoped.credentialsFile !== undefined ||
      scoped.refresh.some((value) => value !== undefined) ||
      REFRESH_VARS.some(([, alias]) => credentialUnavailable(env, prefix + alias));
    if (claimed) return scoped;
  }
  return read('');
}

/**
 * Names of the variables still needed, all from the account's one scope. When any name of the scope
 * is unavailable these are the refresh names without a value plus the credentials-file variable if
 * it is unavailable, whatever else is set. Otherwise empty when either flow is complete, else the
 * refresh names without a value.
 */
export function googleAuthMissing(env: Env, account: AccountConfig): string[] {
  const { prefix, refresh, credentialsFile, unavailable } = resolveGoogleCredentials(env, account);
  if (unavailable.length === 0 && credentialsFile !== undefined) return [];
  const missing: string[] = [];
  REFRESH_VARS.forEach(([name], index) => {
    if (refresh[index] === undefined) missing.push(prefix + name);
  });
  if (unavailable.includes(prefix + CREDENTIALS_VAR)) missing.push(prefix + CREDENTIALS_VAR);
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
  const resolved = resolveGoogleCredentials(env, account);
  const usable = resolved.unavailable.length === 0;
  const [clientId, clientSecret, refreshToken] = usable ? resolved.refresh : [];
  const credentialsFile = usable ? resolved.credentialsFile : undefined;

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
    const prefix = resolved.prefix;
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
