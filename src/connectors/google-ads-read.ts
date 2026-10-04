import { assertRange } from '../core/dates';
import { envFor } from '../core/env';
import { toAutopilotError } from '../core/errors';
import { fromMicros } from '../core/money';
import type {
  AttrValue,
  ConnectorDeps,
  DatasetCoverage,
  DatasetName,
  DateRange,
  JsonValue,
  Metrics,
  Row,
  Snapshot,
  SnapshotRequest,
} from '../core/types';
import { GOOGLE_ADS_SCOPE, getGoogleAccessToken } from './google-auth';
import { buildSnapshot } from './snapshot';

const GOOGLE_ADS_DATASETS: DatasetName[] = [
  'campaigns',
  'ad_groups',
  'ads',
  'keywords',
  'search_terms',
  'devices',
  'daily',
  'conversion_actions',
];

const SEARCH_TERM_LIMIT = 2000;

const CORE_METRICS =
  'metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value';

type ApiRow = Record<string, unknown>;

interface DatasetSpec {
  /** GAQL for the range; the range is validated before it is interpolated. */
  query(range: DateRange): string;
  /** Null drops a row that lacks its identifying fields. */
  toRow(row: ApiRow): Row | null;
}

function dateFilter(range: DateRange): string {
  return `WHERE segments.date BETWEEN '${range.start}' AND '${range.end}'`;
}

function at(row: unknown, path: string): unknown {
  let current: unknown = row;
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Ids and other int64 values arrive as strings; numbers are accepted too. */
function text(row: unknown, path: string): string | undefined {
  const value = at(row, path);
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function num(row: unknown, path: string): number | undefined {
  const value = at(row, path);
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function bool(row: unknown, path: string): boolean | null {
  const value = at(row, path);
  return typeof value === 'boolean' ? value : null;
}

function attr(value: string | number | undefined): AttrValue {
  return value ?? null;
}

function money(row: unknown, path: string): number | null {
  const micros = num(row, path);
  return micros === undefined ? null : fromMicros(micros);
}

function coreMetrics(row: ApiRow): Metrics {
  return {
    impressions: num(row, 'metrics.impressions') ?? 0,
    clicks: num(row, 'metrics.clicks') ?? 0,
    cost: fromMicros(num(row, 'metrics.costMicros') ?? 0),
    conversions: num(row, 'metrics.conversions') ?? 0,
    conversionValue: num(row, 'metrics.conversionsValue') ?? 0,
  };
}

function withParents(row: Row, source: ApiRow): Row {
  const campaignId = text(source, 'campaign.id');
  const adGroupId = text(source, 'adGroup.id');
  if (campaignId !== undefined) row.campaignId = campaignId;
  if (adGroupId !== undefined) row.adGroupId = adGroupId;
  return row;
}

function withName(row: Row, name: string | undefined): Row {
  if (name !== undefined) row.name = name;
  return row;
}

const SPECS: Partial<Record<DatasetName, DatasetSpec>> = {
  campaigns: {
    query: (range) =>
      'SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, ' +
      'campaign.bidding_strategy_type, campaign.campaign_budget, campaign_budget.amount_micros, ' +
      'campaign_budget.explicitly_shared, ' +
      `${CORE_METRICS}, metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share ` +
      `FROM campaign ${dateFilter(range)} AND campaign.status != 'REMOVED'`,
    toRow: (r) => {
      const id = text(r, 'campaign.id');
      if (id === undefined) return null;
      return withName(
        {
          id,
          metrics: coreMetrics(r),
          attrs: {
            status: attr(text(r, 'campaign.status')),
            channelType: attr(text(r, 'campaign.advertisingChannelType')),
            biddingStrategy: attr(text(r, 'campaign.biddingStrategyType')),
            dailyBudget: money(r, 'campaignBudget.amountMicros'),
            sharedBudget: bool(r, 'campaignBudget.explicitlyShared') ?? false,
            // The budget's resource name: campaigns on one shared budget carry the same value.
            budgetId: attr(text(r, 'campaign.campaignBudget')),
            lostIsBudget: attr(num(r, 'metrics.searchBudgetLostImpressionShare')),
            lostIsRank: attr(num(r, 'metrics.searchRankLostImpressionShare')),
          },
        },
        text(r, 'campaign.name'),
      );
    },
  },
  ad_groups: {
    query: (range) =>
      `SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id, ${CORE_METRICS} ` +
      `FROM ad_group ${dateFilter(range)}`,
    toRow: (r) => {
      const id = text(r, 'adGroup.id');
      if (id === undefined) return null;
      const row: Row = { id, metrics: coreMetrics(r), attrs: { status: attr(text(r, 'adGroup.status')) } };
      const campaignId = text(r, 'campaign.id');
      if (campaignId !== undefined) row.campaignId = campaignId;
      return withName(row, text(r, 'adGroup.name'));
    },
  },
  ads: {
    query: (range) =>
      'SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.status, ' +
      'ad_group_ad.policy_summary.approval_status, ad_group_ad.ad.final_urls, ad_group.id, campaign.id, ' +
      `${CORE_METRICS} FROM ad_group_ad ${dateFilter(range)}`,
    toRow: (r) => {
      const adId = text(r, 'adGroupAd.ad.id');
      const adGroupId = text(r, 'adGroup.id');
      if (adId === undefined || adGroupId === undefined) return null;
      const urls = at(r, 'adGroupAd.ad.finalUrls');
      const first: unknown = Array.isArray(urls) ? urls[0] : undefined;
      return withName(
        withParents(
          {
            id: `${adGroupId}~${adId}`,
            metrics: coreMetrics(r),
            attrs: {
              status: attr(text(r, 'adGroupAd.status')),
              approvalStatus: attr(text(r, 'adGroupAd.policySummary.approvalStatus')),
              finalUrl: typeof first === 'string' ? first : null,
            },
          },
          r,
        ),
        text(r, 'adGroupAd.ad.name'),
      );
    },
  },
  keywords: {
    query: (range) =>
      'SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ' +
      'ad_group_criterion.keyword.match_type, ad_group_criterion.status, ' +
      'ad_group_criterion.quality_info.quality_score, ad_group_criterion.effective_cpc_bid_micros, ' +
      `ad_group.id, campaign.id, ${CORE_METRICS} FROM keyword_view ${dateFilter(range)}`,
    toRow: (r) => {
      const criterionId = text(r, 'adGroupCriterion.criterionId');
      const adGroupId = text(r, 'adGroup.id');
      if (criterionId === undefined || adGroupId === undefined) return null;
      return withName(
        withParents(
          {
            id: `${adGroupId}~${criterionId}`,
            metrics: coreMetrics(r),
            attrs: {
              status: attr(text(r, 'adGroupCriterion.status')),
              matchType: attr(text(r, 'adGroupCriterion.keyword.matchType')),
              qualityScore: attr(num(r, 'adGroupCriterion.qualityInfo.qualityScore')),
              bid: money(r, 'adGroupCriterion.effectiveCpcBidMicros'),
            },
          },
          r,
        ),
        text(r, 'adGroupCriterion.keyword.text'),
      );
    },
  },
  search_terms: {
    query: (range) =>
      'SELECT search_term_view.search_term, search_term_view.status, ad_group.id, campaign.id, campaign.name, ' +
      `${CORE_METRICS} FROM search_term_view ${dateFilter(range)} ` +
      `ORDER BY metrics.cost_micros DESC LIMIT ${SEARCH_TERM_LIMIT}`,
    toRow: (r) => {
      const term = text(r, 'searchTermView.searchTerm');
      if (term === undefined) return null;
      return withParents(
        {
          id: `${text(r, 'campaign.id') ?? ''}:${text(r, 'adGroup.id') ?? ''}:${term}`,
          name: term,
          metrics: coreMetrics(r),
          attrs: {
            searchTermStatus: attr(text(r, 'searchTermView.status')),
            campaignName: attr(text(r, 'campaign.name')),
          },
        },
        r,
      );
    },
  },
  devices: {
    query: (range) => `SELECT campaign.id, segments.device, ${CORE_METRICS} FROM campaign ${dateFilter(range)}`,
    toRow: (r) => {
      const campaignId = text(r, 'campaign.id');
      const device = text(r, 'segments.device');
      if (campaignId === undefined || device === undefined) return null;
      return { id: `${campaignId}:${device}`, campaignId, metrics: coreMetrics(r), attrs: { device } };
    },
  },
  daily: {
    query: (range) => `SELECT segments.date, ${CORE_METRICS} FROM customer ${dateFilter(range)}`,
    toRow: (r) => {
      const date = text(r, 'segments.date');
      if (date === undefined) return null;
      return { id: date, date, metrics: coreMetrics(r), attrs: {} };
    },
  },
  conversion_actions: {
    query: () =>
      'SELECT conversion_action.id, conversion_action.name, conversion_action.status, conversion_action.type, ' +
      'conversion_action.category, conversion_action.primary_for_goal, conversion_action.counting_type ' +
      'FROM conversion_action',
    toRow: (r) => {
      const id = text(r, 'conversionAction.id');
      if (id === undefined) return null;
      return withName(
        {
          id,
          metrics: {},
          attrs: {
            status: attr(text(r, 'conversionAction.status')),
            type: attr(text(r, 'conversionAction.type')),
            category: attr(text(r, 'conversionAction.category')),
            primary: bool(r, 'conversionAction.primaryForGoal') ?? false,
            countingType: attr(text(r, 'conversionAction.countingType')),
          },
        },
        text(r, 'conversionAction.name'),
      );
    },
  },
};

function digits(value: string): string {
  return value.replace(/\D/g, '');
}

function flatten(body: JsonValue): ApiRow[] {
  const batches: JsonValue[] = Array.isArray(body) ? body : [body];
  const rows: ApiRow[] = [];
  for (const batch of batches) {
    const results = at(batch, 'results');
    if (!Array.isArray(results)) continue;
    for (const result of results) {
      if (typeof result === 'object' && result !== null && !Array.isArray(result)) rows.push(result as ApiRow);
    }
  }
  return rows;
}

async function search(deps: ConnectorDeps, query: string): Promise<ApiRow[]> {
  const { account, env, http, now } = deps;
  const token = await getGoogleAccessToken({ env, account, http, scopes: [GOOGLE_ADS_SCOPE], now });
  const version = envFor(env, account, 'GOOGLE_ADS_API_VERSION') ?? 'v25';
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (account.loginCustomerId !== undefined && digits(account.loginCustomerId) !== '') {
    headers['login-customer-id'] = digits(account.loginCustomerId);
  }
  const developerToken = envFor(env, account, 'GOOGLE_ADS_DEVELOPER_TOKEN');
  if (developerToken !== undefined) headers['developer-token'] = developerToken;
  const response = await http.request({
    url: `https://googleads.googleapis.com/${version}/customers/${digits(account.externalId)}/googleAds:searchStream`,
    method: 'POST',
    headers,
    json: { query },
    // A search changes nothing, so repeating it is safe.
    retry: true,
  });
  return flatten(response.body);
}

/** Reads every requested dataset with GAQL (`googleAds:searchStream`) and normalises it. */
export async function fetchGoogleAdsSnapshot(deps: ConnectorDeps, request: SnapshotRequest): Promise<Snapshot> {
  assertRange(request.dateRange);
  const account = request.account;
  const scoped: ConnectorDeps = { ...deps, account };
  const warnings: string[] = [];

  let currency = account.currency ?? 'XXX';
  let timezone = account.timezone ?? 'UTC';
  try {
    const rows = await search(scoped, 'SELECT customer.currency_code, customer.time_zone FROM customer LIMIT 1');
    currency = text(rows[0], 'customer.currencyCode') ?? currency;
    timezone = text(rows[0], 'customer.timeZone') ?? timezone;
  } catch (error) {
    warnings.push(`customer: currency and timezone could not be read (${toAutopilotError(error).message})`);
  }

  const names = [...new Set(request.datasets ?? GOOGLE_ADS_DATASETS)];
  const loaded = await Promise.all(
    names.map(async (name): Promise<{ name: DatasetName; rows: Row[] | null; note?: string }> => {
      const spec = SPECS[name];
      if (spec === undefined) return { name, rows: null, note: 'Google Ads does not provide this dataset.' };
      try {
        const raw = await search(scoped, spec.query(request.dateRange));
        const rows: Row[] = [];
        for (const item of raw) {
          const row = spec.toRow(item);
          if (row !== null) rows.push(row);
        }
        if (name === 'search_terms' && raw.length >= SEARCH_TERM_LIMIT) {
          return { name, rows, note: `Only the ${SEARCH_TERM_LIMIT} search terms with the highest cost were read.` };
        }
        return { name, rows };
      } catch (error) {
        return { name, rows: null, note: toAutopilotError(error).message };
      }
    }),
  );

  const datasets: Partial<Record<DatasetName, Row[]>> = {};
  const coverage: Partial<Record<DatasetName, DatasetCoverage>> = {};
  for (const item of loaded) {
    if (item.rows === null) {
      const note = item.note ?? 'The dataset could not be read.';
      coverage[item.name] = { status: 'missing', rows: 0, note };
      warnings.push(`${item.name}: ${note}`);
      continue;
    }
    datasets[item.name] = item.rows;
    if (item.note !== undefined) {
      coverage[item.name] = { status: 'partial', rows: item.rows.length, note: item.note };
      warnings.push(`${item.name}: ${item.note}`);
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
