import { credentialUnavailable } from '../core/env';
import { AutopilotError, toAutopilotError } from '../core/errors';
import type {
  AttrValue,
  ConnectorDeps,
  DatasetCoverage,
  DatasetName,
  HttpRequest,
  JsonValue,
  Metrics,
  Row,
  Snapshot,
  SnapshotRequest,
} from '../core/types';
import { buildSnapshot } from './snapshot';

const MAUTIC_DATASETS: DatasetName[] = ['segments', 'emails', 'lifecycle_campaigns'];
const PAGE_LIMIT = 200;
const SEGMENT_COUNT_CAP = 50;
const TOKEN_SAFETY_MS = 60_000;
const EMAIL_LIFETIME_NOTE = 'Email counters are lifetime totals, not limited to the date range.';

type JsonRecord = { [key: string]: JsonValue };

interface CachedToken {
  token: string;
  /** Epoch milliseconds after which the token is no longer used. */
  usableUntil: number;
}

const tokenCache = new Map<string, CachedToken>();

export function clearMauticTokenCache(): void {
  tokenCache.clear();
}

function baseUrl(deps: ConnectorDeps): string {
  return deps.account.externalId.trim().replace(/\/+$/, '');
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Mautic returns counts as numbers or as numeric strings depending on the endpoint. */
function count(value: unknown): number | undefined {
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return finite(value);
}

function text(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return null;
}

function bool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  return null;
}

const AUTH_NAMES = ['MAUTIC_CLIENT_ID', 'MAUTIC_CLIENT_SECRET', 'MAUTIC_USERNAME', 'MAUTIC_PASSWORD'] as const;

type AuthName = (typeof AUTH_NAMES)[number];

interface AuthScope {
  /** Names in the scope that are kept in the credential store but could not be read. */
  unavailable: string[];
  values: Partial<Record<AuthName, string>>;
}

/**
 * The one set of variables the account authenticates with: its prefixed names as soon as one of
 * them has a value or is unreadable, else the global names. Values are never mixed across the two
 * sets, and an unreadable name in the set leaves the account without credentials, because any
 * other credential may belong to another identity.
 */
function authScope(deps: ConnectorDeps): AuthScope {
  const { env, account } = deps;
  const read = (name: string): string | undefined => {
    const value = env[name];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  const prefix = account.envPrefix ?? '';
  const own =
    prefix !== '' && AUTH_NAMES.some((name) => read(prefix + name) !== undefined || credentialUnavailable(env, prefix + name));
  const scope = own ? prefix : '';
  const unavailable = AUTH_NAMES.map((name) => scope + name).filter((name) => credentialUnavailable(env, name));
  const values: Partial<Record<AuthName, string>> = {};
  if (unavailable.length > 0) return { unavailable, values };
  for (const name of AUTH_NAMES) {
    const value = read(scope + name);
    if (value !== undefined) values[name] = value;
  }
  return { unavailable, values };
}

/** Variables still needed for either Basic auth or OAuth2 client credentials; unreadable ones by their full name. */
export function mauticAuthMissing(deps: ConnectorDeps): string[] {
  const { unavailable, values } = authScope(deps);
  if (unavailable.length > 0) return unavailable;
  if (values.MAUTIC_CLIENT_ID !== undefined && values.MAUTIC_CLIENT_SECRET !== undefined) return [];
  if (values.MAUTIC_USERNAME !== undefined && values.MAUTIC_PASSWORD !== undefined) return [];
  return ['MAUTIC_CLIENT_ID', 'MAUTIC_CLIENT_SECRET'];
}

async function authorization(deps: ConnectorDeps): Promise<string> {
  const { account } = deps;
  const { unavailable, values } = authScope(deps);
  const clientId = values.MAUTIC_CLIENT_ID;
  const clientSecret = values.MAUTIC_CLIENT_SECRET;
  if (clientId !== undefined && clientSecret !== undefined) {
    const base = baseUrl(deps);
    const key = `${base}\n${clientId}`;
    const nowMs = deps.now().getTime();
    const cached = tokenCache.get(key);
    if (cached !== undefined && cached.usableUntil > nowMs) return `Bearer ${cached.token}`;
    const response = await deps.http.request({
      url: `${base}/oauth/v2/token`,
      method: 'POST',
      form: { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret },
    });
    const body: unknown = response.body;
    const token = isRecord(body) ? body['access_token'] : undefined;
    if (typeof token !== 'string' || token === '') {
      throw new AutopilotError('platform_error', 'Mautic did not return an access token', {
        hint: 'Check that the API credentials are OAuth2 client credentials and that the API is enabled in Mautic.',
      });
    }
    const expiresIn = (isRecord(body) ? count(body['expires_in']) : undefined) ?? 0;
    tokenCache.set(key, { token, usableUntil: nowMs + expiresIn * 1000 - TOKEN_SAFETY_MS });
    return `Bearer ${token}`;
  }
  const username = values.MAUTIC_USERNAME;
  const password = values.MAUTIC_PASSWORD;
  if (username !== undefined && password !== undefined) {
    return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
  }
  throw new AutopilotError(
    'not_configured',
    `Mautic credentials are missing for account '${account.id}': set MAUTIC_CLIENT_ID and MAUTIC_CLIENT_SECRET, or MAUTIC_USERNAME and MAUTIC_PASSWORD`,
    {
      hint:
        unavailable.length > 0
          ? `The credential store could not be read for: ${unavailable.join(', ')}. No other credentials are used in their place.`
          : account.envPrefix !== undefined && account.envPrefix !== ''
            ? `Variables may carry the account prefix '${account.envPrefix}'.`
            : 'Add them to the .env file in the autopilot home directory.',
    },
  );
}

/** Adds the base URL (`account.externalId`), the `/api` prefix and the Authorization header to a request. */
export async function mauticRequest(
  deps: ConnectorDeps,
  path: string,
  init?: Omit<HttpRequest, 'url'>,
): Promise<HttpRequest> {
  const header = await authorization(deps);
  return {
    ...init,
    url: `${baseUrl(deps)}/api${path.startsWith('/') ? path : `/${path}`}`,
    headers: { ...init?.headers, Authorization: header },
  };
}

interface Listing {
  items: JsonRecord[];
  total: number | undefined;
}

async function list(
  deps: ConnectorDeps,
  path: string,
  key: string,
  query: Record<string, string | number>,
): Promise<Listing> {
  const response = await deps.http.request(await mauticRequest(deps, path, { method: 'GET', query }));
  const body: unknown = response.body;
  if (!isRecord(body)) {
    throw new AutopilotError('platform_error', `Mautic returned an unexpected response for ${path}`);
  }
  const raw = body[key];
  // An empty list arrives as [] and a filled one as an array or an object keyed by id.
  const values: unknown[] = Array.isArray(raw) ? raw : isRecord(raw) ? Object.values(raw) : [];
  return { items: values.filter(isRecord), total: count(body['total']) };
}

function baseRow(item: JsonRecord, attrs: Record<string, AttrValue>, metrics: Metrics): Row | undefined {
  const id = text(item['id']);
  if (id === null || id === '') return undefined;
  const name = text(item['name']);
  return { id, ...(name === null ? {} : { name }), metrics, attrs };
}

interface DatasetResult {
  rows: Row[];
  coverage?: DatasetCoverage;
  warnings: string[];
}

async function readSegments(deps: ConnectorDeps): Promise<DatasetResult> {
  const { items, total } = await list(deps, '/segments', 'lists', { limit: PAGE_LIMIT });
  const rows: Row[] = [];
  const notes: string[] = [];
  let failed = 0;
  let counted = 0;
  for (const item of items) {
    const alias = text(item['alias']);
    const metrics: Metrics = {};
    if (counted < SEGMENT_COUNT_CAP && alias !== null && alias !== '') {
      counted += 1;
      try {
        const contacts = await list(deps, '/contacts', 'contacts', { search: `segment:${alias}`, limit: 1 });
        if (contacts.total !== undefined) metrics.contacts = contacts.total;
        else failed += 1;
      } catch (error) {
        if (toAutopilotError(error).code === 'not_configured') throw error;
        failed += 1;
      }
    }
    const row = baseRow(item, { alias, published: bool(item['isPublished']) }, metrics);
    if (row !== undefined) rows.push(row);
  }
  if (rows.length > SEGMENT_COUNT_CAP) {
    notes.push(`contact counts were read for the first ${SEGMENT_COUNT_CAP} of ${rows.length} segments`);
  }
  if (failed > 0) notes.push(`contact counts could not be read for ${failed} segment(s)`);
  if (total !== undefined && total > items.length) {
    notes.push(`${items.length} of ${total} segments were read`);
  }
  if (notes.length === 0) return { rows, warnings: [] };
  const note = notes.join('; ');
  return { rows, coverage: { status: 'partial', rows: rows.length, note }, warnings: [`segments: ${note}`] };
}

async function readEmails(deps: ConnectorDeps): Promise<DatasetResult> {
  const { items, total } = await list(deps, '/emails', 'emails', { limit: PAGE_LIMIT });
  const rows: Row[] = [];
  let hasDeliverability = false;
  for (const item of items) {
    const metrics: Metrics = { sent: count(item['sentCount']) ?? 0, read: count(item['readCount']) ?? 0 };
    const clicked = finite(item['clickCount']);
    const unsubscribed = finite(item['unsubscribeCount']);
    const bounced = finite(item['bounceCount']);
    if (clicked !== undefined) metrics.clicked = clicked;
    if (unsubscribed !== undefined) metrics.unsubscribed = unsubscribed;
    if (bounced !== undefined) metrics.bounced = bounced;
    const row = baseRow(
      item,
      {
        subject: text(item['subject']),
        published: bool(item['isPublished']),
        emailType: text(item['emailType']),
        scope: 'lifetime',
      },
      metrics,
    );
    if (row === undefined) continue;
    if (unsubscribed !== undefined || bounced !== undefined) hasDeliverability = true;
    rows.push(row);
  }
  const notes: string[] = [];
  if (!hasDeliverability) notes.push('the API returned no unsubscribe or bounce numbers for any email');
  if (total !== undefined && total > items.length) notes.push(`${items.length} of ${total} emails were read`);
  // Mautic reports email counters since creation, whatever date range the snapshot carries.
  const warnings = [EMAIL_LIFETIME_NOTE];
  if (notes.length === 0) {
    return { rows, coverage: { status: 'partial', rows: rows.length, note: EMAIL_LIFETIME_NOTE }, warnings };
  }
  const rest = notes.join('; ');
  warnings.push(`emails: ${rest}`);
  return {
    rows,
    coverage: { status: 'partial', rows: rows.length, note: `${EMAIL_LIFETIME_NOTE} Also: ${rest}.` },
    warnings,
  };
}

async function readCampaigns(deps: ConnectorDeps): Promise<DatasetResult> {
  const { items, total } = await list(deps, '/campaigns', 'campaigns', { limit: PAGE_LIMIT });
  const rows: Row[] = [];
  for (const item of items) {
    const metrics: Metrics = {};
    const contacts = finite(item['contactCount']);
    if (contacts !== undefined) metrics.contacts = contacts;
    const row = baseRow(item, { published: bool(item['isPublished']) }, metrics);
    if (row !== undefined) rows.push(row);
  }
  if (total === undefined || total <= items.length) return { rows, warnings: [] };
  const note = `${items.length} of ${total} campaigns were read`;
  return {
    rows,
    coverage: { status: 'partial', rows: rows.length, note },
    warnings: [`lifecycle_campaigns: ${note}`],
  };
}

const READERS: Partial<Record<DatasetName, (deps: ConnectorDeps) => Promise<DatasetResult>>> = {
  segments: readSegments,
  emails: readEmails,
  lifecycle_campaigns: readCampaigns,
};

export async function fetchMauticSnapshot(deps: ConnectorDeps, request: SnapshotRequest): Promise<Snapshot> {
  const account = request.account;
  const scoped: ConnectorDeps = { ...deps, account };
  // Missing credentials are a setup problem, not three missing datasets.
  await authorization(scoped);

  const wanted = request.datasets ?? MAUTIC_DATASETS;
  const datasets: Partial<Record<DatasetName, Row[]>> = {};
  const coverage: Partial<Record<DatasetName, DatasetCoverage>> = {};
  const warnings: string[] = [];

  for (const name of MAUTIC_DATASETS) {
    if (!wanted.includes(name)) continue;
    const reader = READERS[name];
    if (reader === undefined) continue;
    try {
      const result = await reader(scoped);
      datasets[name] = result.rows;
      if (result.coverage !== undefined) coverage[name] = result.coverage;
      warnings.push(...result.warnings);
    } catch (error) {
      const failure = toAutopilotError(error);
      if (failure.code === 'not_configured') throw failure;
      const note = `could not be read (${failure.code}): ${failure.message}`;
      datasets[name] = [];
      coverage[name] = { status: 'missing', rows: 0, note };
      warnings.push(`${name}: ${note}`);
    }
  }

  return buildSnapshot({
    account,
    source: 'api',
    dateRange: request.dateRange,
    currency: 'XXX',
    timezone: account.timezone ?? 'UTC',
    datasets,
    coverage,
    warnings,
    now: deps.now(),
  });
}
