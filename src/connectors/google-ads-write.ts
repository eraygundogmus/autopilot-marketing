import { envFor } from '../core/env';
import { AutopilotError, toAutopilotError } from '../core/errors';
import { fromMicros, toMicros } from '../core/money';
import type { Action, ActionDraft, ActionResult, ConnectorDeps, JsonObject, JsonValue } from '../core/types';
import { GOOGLE_ADS_SCOPE, getGoogleAccessToken } from './google-auth';

const DEFAULT_API_VERSION = 'v25';
const SIMPLE_ID = /^\d+$/;
const COMPOSITE_ID = /^\d+~\d+$/;
const MATCH_TYPES = ['EXACT', 'PHRASE', 'BROAD'];

interface Session {
  base: string;
  customerId: string;
  headers: Record<string, string>;
}

interface Operation {
  path: string;
  operation: JsonObject;
  resource: string;
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

async function openSession(deps: ConnectorDeps): Promise<Session> {
  const customerId = digitsOnly(deps.account.externalId);
  if (customerId === '') {
    throw new AutopilotError('config_invalid', `Account ${deps.account.id} has no Google Ads customer id`, {
      hint: 'Set externalId to the customer id, e.g. 123-456-7890.',
    });
  }
  const version = envFor(deps.env, deps.account, 'GOOGLE_ADS_API_VERSION') ?? DEFAULT_API_VERSION;
  const token = await getGoogleAccessToken({
    env: deps.env,
    account: deps.account,
    http: deps.http,
    scopes: [GOOGLE_ADS_SCOPE],
    now: deps.now,
  });
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (deps.account.loginCustomerId !== undefined) {
    const login = digitsOnly(deps.account.loginCustomerId);
    if (login !== '') headers['login-customer-id'] = login;
  }
  const developerToken = envFor(deps.env, deps.account, 'GOOGLE_ADS_DEVELOPER_TOKEN');
  if (developerToken !== undefined) headers['developer-token'] = developerToken;
  return { base: `https://googleads.googleapis.com/${version}`, customerId, headers };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(row: unknown, ...path: string[]): unknown {
  let current: unknown = row;
  for (const key of path) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

async function search(deps: ConnectorDeps, session: Session, query: string): Promise<unknown[]> {
  const response = await deps.http.request<JsonValue>({
    url: `${session.base}/customers/${session.customerId}/googleAds:searchStream`,
    method: 'POST',
    headers: session.headers,
    json: { query },
  });
  const body: unknown = response.body;
  const batches = Array.isArray(body) ? body : [body];
  const rows: unknown[] = [];
  for (const batch of batches) {
    const results = field(batch, 'results');
    if (Array.isArray(results)) rows.push(...results);
  }
  return rows;
}

function simpleId(id: string, what: string): string {
  if (!SIMPLE_ID.test(id)) {
    throw new AutopilotError('invalid_input', `The ${what} id must contain digits only`);
  }
  return id;
}

function compositeId(id: string, what: string): [string, string] {
  if (!COMPOSITE_ID.test(id)) {
    throw new AutopilotError('invalid_input', `The ${what} id must have the form <adGroupId>~<id>, digits only`);
  }
  const [first = '', second = ''] = id.split('~');
  return [first, second];
}

function firstRow(rows: unknown[], what: string, id: string): unknown {
  const row = rows[0];
  if (row === undefined) throw new AutopilotError('not_found', `Google Ads ${what} ${id} was not found`);
  return row;
}

function statusOf(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new AutopilotError('platform_error', `Google Ads returned no status for the ${what}`);
  }
  return value;
}

function microsOf(value: unknown, what: string): number {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new AutopilotError('platform_error', `Google Ads returned no ${what}`);
  }
  return fromMicros(value);
}

function amountParam(params: JsonObject, key: string): string {
  const value = params[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new AutopilotError('invalid_input', `params.${key} must be a finite number greater than 0`);
  }
  return String(toMicros(value));
}

function negativeParams(params: JsonObject): { text: string; matchType: string } {
  const { text, matchType } = params;
  if (typeof text !== 'string' || text.trim() === '') {
    throw new AutopilotError('invalid_input', 'params.text must be a non-empty string');
  }
  if (typeof matchType !== 'string' || !MATCH_TYPES.includes(matchType)) {
    throw new AutopilotError('invalid_input', 'params.matchType must be EXACT, PHRASE or BROAD');
  }
  return { text, matchType };
}

function gaqlString(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function splitKind(kind: string): { entity: string; verb: string } {
  const [platform, entity, verb] = kind.split('.');
  if (platform !== 'google_ads' || entity === undefined || verb === undefined) {
    throw new AutopilotError('unsupported', `${kind} is not a Google Ads action`);
  }
  return { entity, verb };
}

async function readCampaign(
  deps: ConnectorDeps,
  session: Session,
  id: string,
): Promise<{ status: string; budgetResource: string | null; amountMicros: unknown; shared: boolean }> {
  const campaignId = simpleId(id, 'campaign');
  const rows = await search(
    deps,
    session,
    'SELECT campaign.status, campaign.campaign_budget, campaign_budget.amount_micros, campaign_budget.explicitly_shared ' +
      `FROM campaign WHERE campaign.id = ${campaignId}`,
  );
  const row = firstRow(rows, 'campaign', campaignId);
  const budgetResource = field(row, 'campaign', 'campaignBudget');
  return {
    status: statusOf(field(row, 'campaign', 'status'), 'campaign'),
    budgetResource: typeof budgetResource === 'string' && budgetResource !== '' ? budgetResource : null,
    amountMicros: field(row, 'campaignBudget', 'amountMicros'),
    shared: field(row, 'campaignBudget', 'explicitlyShared') === true,
  };
}

function sharedBudgetError(): AutopilotError {
  return new AutopilotError('unsupported', 'This campaign uses a shared budget, which also funds other campaigns', {
    hint: 'Change the shared budget in Google Ads, or give the campaign its own budget first.',
  });
}

async function negativeCriterionIds(deps: ConnectorDeps, session: Session, draft: ActionDraft): Promise<string[]> {
  const campaignId = simpleId(draft.target.id, 'campaign');
  const { text, matchType } = negativeParams(draft.params);
  const rows = await search(
    deps,
    session,
    `SELECT campaign_criterion.criterion_id FROM campaign_criterion WHERE campaign.id = ${campaignId} ` +
      "AND campaign_criterion.negative = TRUE AND campaign_criterion.type = 'KEYWORD' " +
      `AND campaign_criterion.keyword.text = '${gaqlString(text)}' ` +
      `AND campaign_criterion.keyword.match_type = '${matchType}' ` +
      "AND campaign_criterion.status != 'REMOVED'",
  );
  const ids: string[] = [];
  for (const row of rows) {
    const id = field(row, 'campaignCriterion', 'criterionId');
    const text_ = typeof id === 'number' ? String(id) : id;
    if (typeof text_ === 'string' && SIMPLE_ID.test(text_)) ids.push(text_);
  }
  return ids;
}

async function readState(deps: ConnectorDeps, session: Session, draft: ActionDraft): Promise<JsonObject> {
  const { entity, verb } = splitKind(draft.kind);
  const id = draft.target.id;
  const isStatus = verb === 'pause' || verb === 'enable';

  if (entity === 'campaign' && isStatus) {
    const campaign = await readCampaign(deps, session, id);
    const known = campaign.amountMicros !== undefined && campaign.amountMicros !== null;
    return {
      status: campaign.status,
      dailyBudget: campaign.shared || !known ? null : microsOf(campaign.amountMicros, 'budget amount'),
    };
  }
  if (entity === 'campaign' && verb === 'set_daily_budget') {
    const campaign = await readCampaign(deps, session, id);
    if (campaign.shared) throw sharedBudgetError();
    return { dailyBudget: microsOf(campaign.amountMicros, 'budget amount') };
  }
  if (entity === 'ad_group' && isStatus) {
    const adGroupId = simpleId(id, 'ad group');
    const rows = await search(deps, session, `SELECT ad_group.status FROM ad_group WHERE ad_group.id = ${adGroupId}`);
    return { status: statusOf(field(firstRow(rows, 'ad group', id), 'adGroup', 'status'), 'ad group') };
  }
  if (entity === 'ad' && isStatus) {
    const [adGroupId, adId] = compositeId(id, 'ad');
    const rows = await search(
      deps,
      session,
      `SELECT ad_group_ad.status FROM ad_group_ad WHERE ad_group.id = ${adGroupId} AND ad_group_ad.ad.id = ${adId}`,
    );
    return { status: statusOf(field(firstRow(rows, 'ad', id), 'adGroupAd', 'status'), 'ad') };
  }
  if (entity === 'keyword' && (isStatus || verb === 'set_bid')) {
    const [adGroupId, criterionId] = compositeId(id, 'keyword');
    const column = isStatus ? 'status' : 'cpc_bid_micros';
    const rows = await search(
      deps,
      session,
      `SELECT ad_group_criterion.${column} FROM ad_group_criterion ` +
        `WHERE ad_group.id = ${adGroupId} AND ad_group_criterion.criterion_id = ${criterionId}`,
    );
    const row = firstRow(rows, 'keyword', id);
    if (isStatus) return { status: statusOf(field(row, 'adGroupCriterion', 'status'), 'keyword') };
    return { bid: microsOf(field(row, 'adGroupCriterion', 'cpcBidMicros'), 'keyword bid') };
  }
  if (entity === 'negative_keyword' && (verb === 'add' || verb === 'remove')) {
    return { exists: (await negativeCriterionIds(deps, session, draft)).length > 0 };
  }
  throw new AutopilotError('unsupported', `${draft.kind} is not supported by the Google Ads connector`);
}

/** Null means the account is already in the intended state and no call must be made. */
async function buildOperation(deps: ConnectorDeps, session: Session, action: Action): Promise<Operation | null> {
  const { entity, verb } = splitKind(action.kind);
  const customer = `customers/${session.customerId}`;
  const id = action.target.id;
  const isStatus = verb === 'pause' || verb === 'enable';
  const status = verb === 'pause' ? 'PAUSED' : 'ENABLED';
  const update = (path: string, resourceName: string, fields: JsonObject, updateMask: string): Operation => ({
    path,
    operation: { update: { resourceName, ...fields }, updateMask },
    resource: resourceName,
  });

  if (entity === 'campaign' && isStatus) {
    return update('campaigns:mutate', `${customer}/campaigns/${simpleId(id, 'campaign')}`, { status }, 'status');
  }
  if (entity === 'ad_group' && isStatus) {
    return update('adGroups:mutate', `${customer}/adGroups/${simpleId(id, 'ad group')}`, { status }, 'status');
  }
  if (entity === 'ad' && isStatus) {
    const [adGroupId, adId] = compositeId(id, 'ad');
    return update('adGroupAds:mutate', `${customer}/adGroupAds/${adGroupId}~${adId}`, { status }, 'status');
  }
  if (entity === 'keyword' && (isStatus || verb === 'set_bid')) {
    const [adGroupId, criterionId] = compositeId(id, 'keyword');
    const resourceName = `${customer}/adGroupCriteria/${adGroupId}~${criterionId}`;
    if (isStatus) return update('adGroupCriteria:mutate', resourceName, { status }, 'status');
    const cpcBidMicros = amountParam(action.params, 'bid');
    return update('adGroupCriteria:mutate', resourceName, { cpcBidMicros }, 'cpc_bid_micros');
  }
  if (entity === 'campaign' && verb === 'set_daily_budget') {
    const amountMicros = amountParam(action.params, 'dailyBudget');
    const campaign = await readCampaign(deps, session, id);
    if (campaign.shared) throw sharedBudgetError();
    const expected = new RegExp(`^customers/${session.customerId}/campaignBudgets/\\d+$`);
    if (campaign.budgetResource === null || !expected.test(campaign.budgetResource)) {
      throw new AutopilotError('platform_error', 'Google Ads returned no budget for this campaign');
    }
    return update('campaignBudgets:mutate', campaign.budgetResource, { amountMicros }, 'amount_micros');
  }
  if (entity === 'negative_keyword' && verb === 'add') {
    const campaignId = simpleId(id, 'campaign');
    const { text, matchType } = negativeParams(action.params);
    const existing = await negativeCriterionIds(deps, session, action);
    if (existing.length > 0) return null;
    const campaign = `${customer}/campaigns/${campaignId}`;
    return {
      path: 'campaignCriteria:mutate',
      operation: { create: { campaign, negative: true, keyword: { text, matchType } } },
      resource: campaign,
    };
  }
  if (entity === 'negative_keyword' && verb === 'remove') {
    const campaignId = simpleId(id, 'campaign');
    const criterionId = (await negativeCriterionIds(deps, session, action))[0];
    if (criterionId === undefined) return null;
    const resource = `${customer}/campaignCriteria/${campaignId}~${criterionId}`;
    return { path: 'campaignCriteria:mutate', operation: { remove: resource }, resource };
  }
  throw new AutopilotError('unsupported', `${action.kind} is not supported by the Google Ads connector`);
}

function header(headers: Record<string, string>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && value !== '') return value;
  }
  return undefined;
}

export async function readGoogleAdsState(deps: ConnectorDeps, draft: ActionDraft): Promise<JsonObject> {
  splitKind(draft.kind);
  const session = await openSession(deps);
  return readState(deps, session, draft);
}

/** `idempotencyKey` is not sent: the Google Ads API has no idempotency key. */
export async function applyGoogleAdsAction(
  deps: ConnectorDeps,
  action: Action,
  options: { validateOnly: boolean; idempotencyKey: string; beforeWrite?: () => void },
): Promise<ActionResult> {
  const { validateOnly } = options;
  // An error thrown by `beforeWrite` leaves this function unchanged: it is never reported as a result.
  let refusal: { error: unknown } | undefined;
  const beforeWrite = (): void => {
    try {
      options.beforeWrite?.();
    } catch (error) {
      refusal = { error };
      throw error;
    }
  };
  try {
    const session = await openSession(deps);
    const built = await buildOperation(deps, session, action);
    if (built === null) return { ok: true, dryRun: validateOnly, after: null };
    if (!validateOnly) beforeWrite();
    const response = await deps.http.request<JsonValue>({
      url: `${session.base}/customers/${session.customerId}/${built.path}`,
      method: 'POST',
      headers: session.headers,
      json: { operations: [built.operation], validateOnly },
      retry: false,
    });
    const results = field(response.body, 'results');
    const returned = Array.isArray(results) ? field(results[0], 'resourceName') : undefined;
    const result: ActionResult = {
      ok: true,
      dryRun: validateOnly,
      after: null,
      resource: typeof returned === 'string' && returned !== '' ? returned : built.resource,
    };
    const requestId = header(response.headers, 'request-id');
    if (requestId !== undefined) result.platformRequestId = requestId;
    return result;
  } catch (error) {
    if (refusal !== undefined && refusal.error === error) throw error;
    const failure = toAutopilotError(error);
    // A retryable failure on a live call may or may not have changed the account: the executor must reconcile.
    if (failure.retryable && !validateOnly) throw failure;
    return {
      ok: false,
      dryRun: validateOnly,
      after: null,
      error: { code: failure.code, message: failure.message, retryable: failure.retryable },
    };
  }
}
