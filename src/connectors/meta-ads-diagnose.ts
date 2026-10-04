import { envFor } from '../core/env';
import { AutopilotError } from '../core/errors';
import { redact } from '../core/redact';
import type { ConnectorDeps, DiagnosticCheck, HttpResponse } from '../core/types';

const GRAPH_ORIGIN = 'https://graph.facebook.com';
const DEFAULT_VERSION = 'v26.0';
const NAME_CHARS = 80;
const MESSAGE_CHARS = 300;
const SKIPPED = 'not run: an earlier check failed';

const LABELS = {
  credentials: 'Access token is configured',
  token: 'Access token is valid',
  permissions: 'Granted permissions',
  ad_account: 'Ad account is reachable and active',
  config_match: 'Config matches the ad account',
  access_tier: 'Marketing API access tier',
} as const;

type CheckId = keyof typeof LABELS;

const ORDER: CheckId[] = ['credentials', 'token', 'permissions', 'ad_account', 'config_match'];

const SUBCODES: Record<number, string> = {
  463: 'expired',
  467: 'invalid',
  460: 'password changed',
  458: 'app not installed',
};

const ACCOUNT_STATUS: Record<number, string> = {
  1: 'ACTIVE',
  2: 'DISABLED',
  3: 'UNSETTLED',
  7: 'PENDING_RISK_REVIEW',
  8: 'PENDING_SETTLEMENT',
  9: 'IN_GRACE_PERIOD',
  100: 'PENDING_CLOSURE',
  101: 'CLOSED',
};

const TOKEN_FIX = 'Create a new access token. A system user token of the business does not expire.';
const ACCOUNT_UNREACHABLE = "The token's user cannot reach this ad account.";
const ACCOUNT_FIX = 'Add the user (or the system user) to the ad account in Business settings, or check externalId.';
const READ_ONLY_NOTE = 'Read access works; write access is not tested here.';
const UNKNOWN_PREFIX = 'Could not be checked: ';

interface GraphFailure {
  /** The short error message. The response body is never part of what is printed. */
  message: string;
  code?: number;
  subcode?: number;
  /** Graph's own message from the response body, used to classify and never printed. */
  platformMessage?: string;
  /** True when the failure says nothing about the configuration: timeout, network, 5xx, rate limit. */
  transient: boolean;
}

function isRateLimitCode(code: number | undefined): boolean {
  if (code === undefined) return false;
  return code === 4 || code === 17 || code === 613 || (code >= 80000 && code <= 80014);
}

function graphErrorOf(body: string | undefined): Record<string, unknown> | undefined {
  if (body === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) return undefined;
    return isRecord(parsed['error']) ? parsed['error'] : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function int(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value);
  return undefined;
}

function matchInt(source: string, pattern: RegExp): number | undefined {
  const found = pattern.exec(source);
  return found?.[1] === undefined ? undefined : Number(found[1]);
}

/**
 * The Graph code and subcode come from the error's response body when it parses as a Graph error.
 * Otherwise they are read from the message, which holds a cut copy of the body and may lack them.
 */
function graphFailure(error: unknown): GraphFailure {
  const raw = error instanceof Error ? error.message : String(error);
  const known = error instanceof AutopilotError ? error : undefined;
  const graph = graphErrorOf(known?.body);
  const code =
    graph === undefined
      ? (matchInt(raw, /"code"\s*:\s*"?(\d+)/) ?? matchInt(raw, /\(#(\d+)\)/))
      : int(graph['code']);
  const subcode = graph === undefined ? matchInt(raw, /"error_subcode"\s*:\s*"?(\d+)/) : int(graph['error_subcode']);
  const failure: GraphFailure = {
    message: raw.slice(0, MESSAGE_CHARS),
    transient: known?.retryable === true || known?.code === 'rate_limited' || isRateLimitCode(code),
  };
  if (code !== undefined) failure.code = code;
  if (subcode !== undefined) failure.subcode = subcode;
  const platformMessage = graph === undefined ? undefined : text(graph['message']);
  if (platformMessage !== undefined) failure.platformMessage = platformMessage;
  return failure;
}

function parseTier(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(header);
    return isRecord(parsed) ? text(parsed['ads_api_access_tier']) : undefined;
  } catch {
    return undefined;
  }
}

/** Live checks of a Meta ad account's access, in the order a person would fix them. Never throws. */
export async function diagnoseMetaAds(deps: ConnectorDeps): Promise<DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = [];
  const clean = (value: string): string => {
    try {
      return redact(value, deps.env);
    } catch {
      return 'detail withheld: it could not be redacted';
    }
  };
  const add = (id: CheckId, status: DiagnosticCheck['status'], detail: string, fix?: string): void => {
    const check: DiagnosticCheck = { id, label: LABELS[id], status, detail: clean(detail) };
    if (fix !== undefined) check.fix = clean(fix);
    checks.push(check);
  };
  const skipRest = (): DiagnosticCheck[] => {
    for (const id of ORDER) {
      if (!checks.some((check) => check.id === id)) add(id, 'skipped', SKIPPED);
    }
    // The tier is always last, whatever happened to config_match.
    const tier = checks.findIndex((check) => check.id === 'access_tier');
    if (tier >= 0) checks.push(...checks.splice(tier, 1));
    return checks;
  };

  try {
    const { account, env, http } = deps;

    const token = envFor(env, account, 'META_ACCESS_TOKEN');
    if (token === undefined) {
      add(
        'credentials',
        'fail',
        `${account.envPrefix ?? ''}META_ACCESS_TOKEN is not set`,
        'Set it with `autopilot-marketing credentials set META_ACCESS_TOKEN` or in the .env file.',
      );
      return skipRest();
    }
    add('credentials', 'ok', 'META_ACCESS_TOKEN is set');

    const version = envFor(env, account, 'META_GRAPH_API_VERSION') ?? DEFAULT_VERSION;
    const base = `${GRAPH_ORIGIN}/${encodeURIComponent(version)}`;
    const headers = { Authorization: `Bearer ${token}` };
    const get = (path: string, fields?: string): Promise<HttpResponse<unknown>> =>
      http.request<unknown>({
        url: `${base}${path}`,
        method: 'GET',
        headers,
        ...(fields === undefined ? {} : { query: { fields } }),
      });

    try {
      const me = await get('/me', 'id,name');
      const body = isRecord(me.body) ? me.body : {};
      const name = text(body['name']) ?? text(body['id']) ?? 'an unnamed user';
      add('token', 'ok', `token belongs to ${name.slice(0, NAME_CHARS)}`);
    } catch (error) {
      const failure = graphFailure(error);
      if (failure.transient) {
        add('token', 'unknown', `${UNKNOWN_PREFIX}${failure.message}`);
      } else if (failure.code === 190) {
        const meaning = failure.subcode === undefined ? undefined : SUBCODES[failure.subcode];
        const suffix =
          failure.subcode === undefined ? '' : ` (subcode ${failure.subcode}${meaning === undefined ? '' : `: ${meaning}`})`;
        add('token', 'fail', `The access token is expired or invalid${suffix}`, TOKEN_FIX);
      } else {
        add('token', 'fail', failure.message);
      }
      return skipRest();
    }

    try {
      const res = await get('/me/permissions');
      const rows = isRecord(res.body) && Array.isArray(res.body['data']) ? res.body['data'] : [];
      const granted = new Set<string>();
      for (const row of rows) {
        if (isRecord(row) && row['status'] === 'granted' && typeof row['permission'] === 'string') {
          granted.add(row['permission']);
        }
      }
      const known = ['ads_read', 'ads_management', 'business_management'].filter((name) => granted.has(name));
      if (!granted.has('ads_read') && !granted.has('ads_management')) {
        add(
          'permissions',
          'fail',
          'neither ads_read nor ads_management is granted',
          'Grant ads_read to read, and ads_management to apply changes.',
        );
        return skipRest();
      }
      const note = granted.has('ads_management') ? '' : ' Changes need ads_management.';
      add('permissions', 'ok', `granted: ${known.join(', ')}.${note}`);
    } catch (error) {
      const failure = graphFailure(error);
      if (failure.transient) add('permissions', 'unknown', `${UNKNOWN_PREFIX}${failure.message}`);
      else add('permissions', 'fail', failure.message);
      return skipRest();
    }

    const externalId = account.externalId;
    const act = `/${encodeURIComponent(externalId.startsWith('act_') ? externalId : `act_${externalId}`)}`;
    let info: Record<string, unknown>;
    try {
      const res = await get(act, 'account_status,disable_reason,currency,timezone_name,name');
      info = isRecord(res.body) ? res.body : {};
      const tier = parseTier(res.headers['x-ad-account-usage']);
      // Added now, moved to the end by skipRest or by the push order below.
      const tierDetail =
        tier === undefined
          ? "Meta did not report the app's access tier on this call. It is shown in the App Dashboard under App Review, Permissions and Features."
          : `Meta reports the app's Marketing API access tier as "${tier.slice(0, NAME_CHARS)}". The tier limits how many calls an app may make per ad account and is separate from the permissions above; Limited Access is heavily rate limited.`;
      add('access_tier', 'ok', tierDetail);
    } catch (error) {
      const failure = graphFailure(error);
      const unreachable =
        failure.code === 100 ||
        failure.code === 200 ||
        failure.code === 10 ||
        failure.message.includes('does not have permission') ||
        failure.platformMessage?.includes('does not have permission') === true;
      if (failure.transient) add('ad_account', 'unknown', `${UNKNOWN_PREFIX}${failure.message}`);
      else if (unreachable) add('ad_account', 'fail', ACCOUNT_UNREACHABLE, ACCOUNT_FIX);
      else add('ad_account', 'fail', failure.message);
      return skipRest();
    }

    const status = int(info['account_status']);
    const currency = text(info['currency']);
    const timezone = text(info['timezone_name']);
    if (status !== 1) {
      const statusText =
        status === undefined ? (text(info['account_status']) ?? 'not reported').slice(0, NAME_CHARS) : (ACCOUNT_STATUS[status] ?? String(status));
      const reason = int(info['disable_reason']) ?? text(info['disable_reason']);
      const reasonText = reason === undefined || reason === 0 || reason === '0' ? '' : `, disable_reason ${String(reason).slice(0, NAME_CHARS)}`;
      add('ad_account', 'fail', `account status is ${statusText}${reasonText}`);
      return skipRest();
    }
    const summary = [text(info['name'])?.slice(0, NAME_CHARS), currency, timezone].filter(
      (part): part is string => part !== undefined,
    );
    add('ad_account', 'ok', summary.length === 0 ? READ_ONLY_NOTE : `${summary.join(', ')}. ${READ_ONLY_NOTE}`);

    const differences: string[] = [];
    const fixes: string[] = [];
    let compared = 0;
    if (account.currency !== undefined && currency !== undefined) {
      compared += 1;
      if (account.currency.trim().toUpperCase() !== currency.toUpperCase()) {
        differences.push(`config currency ${account.currency}, platform ${currency}`);
        fixes.push(`currency to ${currency}`);
      }
    }
    if (account.timezone !== undefined && timezone !== undefined) {
      compared += 1;
      if (account.timezone.trim() !== timezone) {
        differences.push(`config timezone ${account.timezone}, platform ${timezone}`);
        fixes.push(`timezone to ${timezone}`);
      }
    }
    if (differences.length > 0) {
      add('config_match', 'fail', differences.join('; '), `Set ${fixes.join(' and ')} in the config.`);
    } else {
      add('config_match', 'ok', compared > 0 ? 'config agrees with the platform' : 'nothing to compare');
    }
    return skipRest();
  } catch {
    try {
      if (checks.every((check) => check.status !== 'fail' && check.status !== 'unknown')) {
        const next = ORDER.find((id) => !checks.some((check) => check.id === id)) ?? 'config_match';
        add(next, 'fail', 'the check stopped on an unexpected error');
      }
      return skipRest();
    } catch {
      return checks;
    }
  }
}
