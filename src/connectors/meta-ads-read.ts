import { assertRange } from '../core/dates';
import { envFor } from '../core/env';
import { AutopilotError, toAutopilotError } from '../core/errors';
import { fromMetaUnits } from '../core/money';
import type {
  AttrValue,
  ConnectorDeps,
  DatasetCoverage,
  DatasetName,
  Metrics,
  Row,
  Snapshot,
  SnapshotRequest,
} from '../core/types';
import { buildSnapshot } from './snapshot';

const GRAPH_ORIGIN = 'https://graph.facebook.com';
const DEFAULT_VERSION = 'v26.0';
const MAX_PAGES = 20;
const SUPPORTED: DatasetName[] = ['campaigns', 'ad_groups', 'ads', 'placements', 'daily'];
const INSIGHT_FIELDS = 'impressions,clicks,spend,inline_link_clicks,reach,frequency,actions,action_values';
const DEFAULT_CONVERSION_ACTIONS = [
  'purchase',
  'offsite_conversion.fb_pixel_purchase',
  'lead',
  'offsite_conversion.fb_pixel_lead',
  'complete_registration',
];

type Raw = Record<string, unknown>;
type Query = Record<string, string | number>;

interface Paged {
  rows: Raw[];
  truncated: boolean;
}

interface Client {
  get(path: string, query: Query): Promise<unknown>;
  list(path: string, query: Query): Promise<Paged>;
}

interface Loaded {
  /** Raw Insights rows the dataset was fetched with; the snapshot's conversion action is chosen from these. */
  insights: Raw[];
  build(conversionAction: string | undefined): Row[];
  truncated: boolean;
  /** Rows whose entity is absent from the entity list. */
  unlisted: number;
  /** False when the entity list was cut off: an absent entity may then simply sit on an unread page. */
  listComplete: boolean;
}

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function num(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function numOrNull(value: unknown): number | null {
  return value === undefined || value === null || value === '' ? null : num(value);
}

function mapStatus(value: unknown): AttrValue {
  const status = text(value);
  if (status === undefined) return null;
  if (status === 'ACTIVE') return 'ENABLED';
  if (status === 'PAUSED') return 'PAUSED';
  if (status === 'ARCHIVED' || status === 'DELETED') return 'REMOVED';
  return status;
}

/** Value of one action type in an Insights `actions` / `action_values` list; undefined when absent. */
function actionValue(list: unknown, type: string): number | undefined {
  if (!Array.isArray(list)) return undefined;
  for (const item of list) {
    if (isRecord(item) && item['action_type'] === type) return num(item['value']);
  }
  return undefined;
}

function zeroMetrics(): Metrics {
  return {
    impressions: 0,
    clicks: 0,
    cost: 0,
    conversions: 0,
    conversionValue: 0,
    linkClicks: 0,
    landingPageViews: 0,
  };
}

function hasAction(rows: Raw[], type: string): boolean {
  return rows.some((row) => actionValue(row['actions'], type) !== undefined);
}

/** `conversionAction` is the one action type of the whole snapshot; a row without it has 0 conversions. */
function insightMetrics(row: Raw, conversionAction: string | undefined): Metrics {
  const metrics = zeroMetrics();
  metrics.impressions = num(row['impressions']);
  metrics.clicks = num(row['clicks']);
  // Insights `spend` is already in major units, unlike budgets.
  metrics.cost = num(row['spend']);
  metrics.linkClicks = num(row['inline_link_clicks']);
  metrics.landingPageViews = actionValue(row['actions'], 'landing_page_view') ?? 0;
  // One action type only: purchase and offsite_conversion.fb_pixel_purchase count the same events.
  if (conversionAction !== undefined) {
    metrics.conversions = actionValue(row['actions'], conversionAction) ?? 0;
    metrics.conversionValue = actionValue(row['action_values'], conversionAction) ?? 0;
  }
  return metrics;
}

function budgetAttrs(entity: Raw, currency: string): Record<string, AttrValue> {
  const daily = num(entity['daily_budget']);
  if (daily > 0) return { dailyBudget: fromMetaUnits(daily, currency), budgetType: 'daily' };
  if (num(entity['lifetime_budget']) > 0) return { dailyBudget: null, budgetType: 'lifetime' };
  return { dailyBudget: null };
}

function deliveryAttrs(insight: Raw | undefined): Record<string, AttrValue> {
  return {
    frequency: insight === undefined ? null : numOrNull(insight['frequency']),
    reach: insight === undefined ? null : numOrNull(insight['reach']),
  };
}

function createClient(deps: ConnectorDeps, token: string): Client {
  const version = envFor(deps.env, deps.account, 'META_GRAPH_API_VERSION') ?? DEFAULT_VERSION;
  const base = `${GRAPH_ORIGIN}/${encodeURIComponent(version)}`;
  // The token travels in a header only: query strings end up in logs.
  const headers = { Authorization: `Bearer ${token}` };

  const get = async (path: string, query: Query): Promise<unknown> => {
    const response = await deps.http.request<unknown>({ url: `${base}${path}`, method: 'GET', headers, query });
    return response.body;
  };

  const nextUrl = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || value === '') return undefined;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new AutopilotError('platform_error', 'Meta returned a paging link that is not a URL.');
    }
    // A paging link is response data: the token is never sent to another host.
    if (url.origin !== GRAPH_ORIGIN) {
      throw new AutopilotError('platform_error', 'Meta returned a paging link outside graph.facebook.com.');
    }
    url.searchParams.delete('access_token');
    return url.toString();
  };

  const list = async (path: string, query: Query): Promise<Paged> => {
    const rows: Raw[] = [];
    let body = await get(path, query);
    for (let page = 1; ; page += 1) {
      if (!isRecord(body)) throw new AutopilotError('platform_error', `Meta returned an unexpected body for ${path}.`);
      const data = body['data'];
      if (Array.isArray(data)) {
        for (const item of data) if (isRecord(item)) rows.push(item);
      }
      const paging = body['paging'];
      const next = nextUrl(isRecord(paging) ? paging['next'] : undefined);
      if (next === undefined) return { rows, truncated: false };
      if (page >= MAX_PAGES) return { rows, truncated: true };
      const response = await deps.http.request<unknown>({ url: next, method: 'GET', headers });
      body = response.body;
    }
  };

  return { get, list };
}

/** Reads campaigns, ad sets, ads, placements and the daily series from the Marketing API and normalises them. */
export async function fetchMetaAdsSnapshot(deps: ConnectorDeps, request: SnapshotRequest): Promise<Snapshot> {
  assertRange(request.dateRange);
  const { account, env } = deps;
  const token = envFor(env, account, 'META_ACCESS_TOKEN');
  if (token === undefined) {
    const name = `${account.envPrefix ?? ''}META_ACCESS_TOKEN`;
    throw new AutopilotError('not_configured', `Meta Ads account "${account.id}" has no access token: ${name} is not set.`, {
      hint: `Set ${name} in the environment or in the home directory's .env file.`,
    });
  }

  const client = createClient(deps, token);
  const externalId = account.externalId.trim();
  const act = `/${encodeURIComponent(externalId.startsWith('act_') ? externalId : `act_${externalId}`)}`;

  let info: unknown;
  try {
    info = await client.get(act, { fields: 'currency,timezone_name' });
  } catch (error) {
    throw toAutopilotError(error);
  }
  const infoRecord = isRecord(info) ? info : {};
  const currency = (text(infoRecord['currency']) ?? account.currency ?? 'XXX').toUpperCase();
  const timezone = text(infoRecord['timezone_name']) ?? account.timezone ?? 'UTC';

  const override = envFor(env, account, 'META_CONVERSION_ACTION')?.trim();
  const timeRange = JSON.stringify({ since: request.dateRange.start, until: request.dateRange.end });

  const insights = (level: string, idField: string, extra: Query = {}): Promise<Paged> =>
    client.list(`${act}/insights`, {
      level,
      fields: idField === '' ? INSIGHT_FIELDS : `${INSIGHT_FIELDS},${idField}`,
      time_range: timeRange,
      limit: 500,
      ...extra,
    });

  const joined = async (
    edge: string,
    fields: string,
    level: string,
    idField: string,
    parentFields: string[],
    toRow: (entity: Raw, id: string, insight: Raw | undefined) => Row,
  ): Promise<Loaded> => {
    const entities = await client.list(`${act}/${edge}`, { fields, limit: 200 });
    const nameField = `${level}_name`;
    const stats = await insights(level, [idField, nameField, ...parentFields].join(','));
    const byId = new Map<string, Raw>();
    for (const row of stats.rows) {
      const id = text(row[idField]);
      if (id !== undefined) byId.set(id, row);
    }
    const listed = new Set<string>();
    for (const entity of entities.rows) {
      const id = text(entity['id']);
      if (id !== undefined) listed.add(id);
    }
    const unlistedIds = [...byId.keys()].filter((id) => !listed.has(id));
    // Every Insights row becomes a dataset row: the list edges omit archived entities, their spend still counts.
    // Absence from the list proves removal only when the list was read to its end. Otherwise the status is
    // 'UNKNOWN', never null: the audit reads a null or absent status as active and would act on the row.
    const unlistedStatus: AttrValue = entities.truncated ? 'UNKNOWN' : 'REMOVED';
    const build = (conversionAction: string | undefined): Row[] => {
      const rows: Row[] = [];
      for (const entity of entities.rows) {
        const id = text(entity['id']);
        if (id === undefined) continue;
        const insight = byId.get(id);
        const row = toRow(entity, id, insight);
        row.metrics = insight === undefined ? zeroMetrics() : insightMetrics(insight, conversionAction);
        rows.push(row);
      }
      for (const id of unlistedIds) {
        const insight = byId.get(id);
        if (insight === undefined) continue;
        const row: Row = {
          id,
          metrics: insightMetrics(insight, conversionAction),
          attrs: { status: unlistedStatus, ...deliveryAttrs(insight) },
        };
        const name = text(insight[nameField]);
        if (name !== undefined) row.name = name;
        if (level !== 'campaign') {
          const campaignId = text(insight['campaign_id']);
          if (campaignId !== undefined) row.campaignId = campaignId;
        }
        if (level === 'ad') {
          const adGroupId = text(insight['adset_id']);
          if (adGroupId !== undefined) row.adGroupId = adGroupId;
        }
        rows.push(row);
      }
      return rows;
    };
    return {
      insights: stats.rows,
      build,
      truncated: entities.truncated || stats.truncated,
      unlisted: unlistedIds.length,
      listComplete: !entities.truncated,
    };
  };

  const base = (entity: Raw, id: string): Row => {
    const row: Row = { id, metrics: {}, attrs: {} };
    const name = text(entity['name']);
    if (name !== undefined) row.name = name;
    return row;
  };

  const loaders: Record<string, () => Promise<Loaded>> = {
    campaigns: () =>
      joined(
        'campaigns',
        'id,name,status,objective,daily_budget,lifetime_budget',
        'campaign',
        'campaign_id',
        [],
        (entity, id, insight) => {
          const row = base(entity, id);
          row.attrs = {
            status: mapStatus(entity['status']),
            objective: text(entity['objective']) ?? null,
            ...budgetAttrs(entity, currency),
            ...deliveryAttrs(insight),
          };
          return row;
        },
      ),
    ad_groups: () =>
      joined(
        'adsets',
        'id,name,campaign_id,status,daily_budget,lifetime_budget,optimization_goal,learning_stage_info',
        'adset',
        'adset_id',
        ['campaign_id'],
        (entity, id, insight) => {
          const row = base(entity, id);
          const campaignId = text(entity['campaign_id']);
          if (campaignId !== undefined) row.campaignId = campaignId;
          const learning = entity['learning_stage_info'];
          row.attrs = {
            status: mapStatus(entity['status']),
            ...budgetAttrs(entity, currency),
            optimizationGoal: text(entity['optimization_goal']) ?? null,
            learningStatus: isRecord(learning) ? (text(learning['status']) ?? null) : null,
            ...deliveryAttrs(insight),
          };
          return row;
        },
      ),
    ads: () =>
      joined('ads', 'id,name,adset_id,campaign_id,status,creative{title,body}', 'ad', 'ad_id', ['adset_id', 'campaign_id'], (entity, id, insight) => {
        const row = base(entity, id);
        const campaignId = text(entity['campaign_id']);
        if (campaignId !== undefined) row.campaignId = campaignId;
        const adGroupId = text(entity['adset_id']);
        if (adGroupId !== undefined) row.adGroupId = adGroupId;
        const creative = isRecord(entity['creative']) ? entity['creative'] : {};
        row.attrs = {
          status: mapStatus(entity['status']),
          headline: text(creative['title']) ?? null,
          description: text(creative['body']) ?? null,
          ...deliveryAttrs(insight),
        };
        return row;
      }),
    placements: async () => {
      const stats = await insights('adset', 'adset_id,campaign_id', {
        breakdowns: 'publisher_platform,platform_position',
      });
      const build = (conversionAction: string | undefined): Row[] => {
        const rows: Row[] = [];
        for (const item of stats.rows) {
          const adsetId = text(item['adset_id']);
          if (adsetId === undefined) continue;
          const placement = `${text(item['publisher_platform']) ?? 'unknown'}:${text(item['platform_position']) ?? 'unknown'}`;
          const row: Row = {
            id: `${adsetId}:${placement}`,
            adGroupId: adsetId,
            metrics: insightMetrics(item, conversionAction),
            attrs: { placement, ...deliveryAttrs(item) },
          };
          const campaignId = text(item['campaign_id']);
          if (campaignId !== undefined) row.campaignId = campaignId;
          rows.push(row);
        }
        return rows;
      };
      return { insights: stats.rows, build, truncated: stats.truncated, unlisted: 0, listComplete: true };
    },
    daily: async () => {
      const stats = await insights('account', '', { time_increment: 1 });
      const build = (conversionAction: string | undefined): Row[] => {
        const rows: Row[] = [];
        for (const item of stats.rows) {
          const date = text(item['date_start']);
          if (date === undefined) continue;
          rows.push({ id: date, date, metrics: insightMetrics(item, conversionAction), attrs: deliveryAttrs(item) });
        }
        rows.sort((a, b) => a.id.localeCompare(b.id));
        return rows;
      };
      return { insights: stats.rows, build, truncated: stats.truncated, unlisted: 0, listComplete: true };
    },
  };

  const wanted = SUPPORTED.filter((name) => request.datasets === undefined || request.datasets.includes(name));
  const datasets: Partial<Record<DatasetName, Row[]>> = {};
  const coverage: Partial<Record<DatasetName, DatasetCoverage>> = {};
  const warnings: string[] = [];

  const loadedSets: Partial<Record<DatasetName, Loaded>> = {};
  for (const name of wanted) {
    const load = loaders[name];
    if (load === undefined) continue;
    try {
      loadedSets[name] = await load();
    } catch (error) {
      const note = toAutopilotError(error).message;
      coverage[name] = { status: 'missing', rows: 0, note };
      warnings.push(`${name}: could not be loaded (${note})`);
    }
  }

  // One conversion definition per snapshot: a per-row choice would add purchases to leads in the totals.
  let conversionAction: string | undefined;
  if (override !== undefined && override !== '') {
    conversionAction = override;
  } else {
    const account = loadedSets.daily;
    const pool = account !== undefined ? account.insights : wanted.flatMap((name) => loadedSets[name]?.insights ?? []);
    conversionAction = DEFAULT_CONVERSION_ACTIONS.find((type) => hasAction(pool, type));
  }
  warnings.push(
    conversionAction === undefined
      ? 'No conversion action was found in this period.'
      : `Conversions are counted as "${conversionAction}".`,
  );

  for (const name of wanted) {
    const loaded = loadedSets[name];
    if (loaded === undefined) continue;
    const rows = loaded.build(conversionAction);
    datasets[name] = rows;
    const notes: string[] = [];
    if (loaded.truncated) {
      const note = `Stopped after ${MAX_PAGES} pages; more rows exist.`;
      notes.push(note);
      warnings.push(`${name}: ${note}`);
    }
    if (loaded.unlisted > 0) {
      const subject = `${loaded.unlisted} ${loaded.unlisted === 1 ? 'row comes from an entity' : 'rows come from entities'}`;
      notes.push(
        loaded.listComplete
          ? `${subject} no longer listed (archived or deleted).`
          : `${subject} not in the listed pages; ${loaded.unlisted === 1 ? 'its' : 'their'} status is unknown.`,
      );
    }
    if (notes.length > 0) {
      coverage[name] = { status: loaded.truncated ? 'partial' : 'complete', rows: rows.length, note: notes.join(' ') };
    }
  }

  return buildSnapshot({
    account,
    source: 'api',
    dateRange: request.dateRange,
    currency,
    timezone,
    datasets,
    coverage,
    warnings,
    now: deps.now(),
  });
}
