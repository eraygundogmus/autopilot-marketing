import { envFor } from '../core/env';
import { AutopilotError } from '../core/errors';
import { fromMetaUnits, toMetaUnits } from '../core/money';
import type { Action, ActionDraft, ActionKind, ActionResult, ConnectorDeps, JsonObject, JsonValue } from '../core/types';
import { actionSpec } from '../plan/actions';

const DEFAULT_VERSION = 'v26.0';

type Operation = 'pause' | 'enable' | 'set_daily_budget';
type MetaEntity = 'campaign' | 'adset' | 'ad';

interface Context {
  base: string;
  headers: Record<string, string>;
  token: string;
}

function parseKind(kind: ActionKind): { entity: MetaEntity; operation: Operation } {
  const match = /^meta_ads\.(campaign|adset|ad)\.(pause|enable|set_daily_budget)$/.exec(kind);
  if (match === null) {
    throw new AutopilotError('unsupported', `The Meta Ads connector cannot handle action kind '${kind}'.`);
  }
  return { entity: match[1] as MetaEntity, operation: match[2] as Operation };
}

function context(deps: ConnectorDeps): Context {
  const token = envFor(deps.env, deps.account, 'META_ACCESS_TOKEN');
  if (token === undefined) {
    throw new AutopilotError('not_configured', `META_ACCESS_TOKEN is not set for account '${deps.account.id}'.`, {
      hint: 'Add META_ACCESS_TOKEN (with the account envPrefix, when one is configured) to the env file.',
    });
  }
  const version = envFor(deps.env, deps.account, 'META_GRAPH_API_VERSION') ?? DEFAULT_VERSION;
  if (!/^v\d+\.\d+$/.test(version)) {
    throw new AutopilotError('config_invalid', 'META_GRAPH_API_VERSION must look like v26.0.');
  }
  return {
    base: `https://graph.facebook.com/${version}`,
    headers: { Authorization: `Bearer ${token}` },
    token,
  };
}

function targetId(draft: ActionDraft): string {
  const id = draft.target.id;
  if (typeof id !== 'string' || !/^\d+$/.test(id)) {
    throw new AutopilotError('invalid_input', 'A Meta Ads target id must contain digits only.');
  }
  return id;
}

function adAccountId(deps: ConnectorDeps): string {
  const raw = deps.account.externalId.trim();
  const id = raw.startsWith('act_') ? raw : `act_${raw}`;
  if (!/^act_\d+$/.test(id)) {
    throw new AutopilotError('config_invalid', `Account '${deps.account.id}' has an invalid Meta ad account id.`, {
      hint: 'externalId must be the numeric ad account id, with or without the act_ prefix.',
    });
  }
  return id;
}

function asObject(value: JsonValue): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AutopilotError('platform_error', 'The Meta Graph API returned an unexpected response.');
  }
  return value;
}

async function accountCurrency(deps: ConnectorDeps, ctx: Context): Promise<string> {
  const configured = deps.account.currency;
  if (configured !== undefined && configured !== '') return configured;
  const response = await deps.http.request({
    url: `${ctx.base}/${adAccountId(deps)}`,
    method: 'GET',
    headers: ctx.headers,
    query: { fields: 'currency' },
  });
  const currency = asObject(response.body)['currency'];
  if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency)) {
    throw new AutopilotError('platform_error', 'The Meta Graph API did not return the ad account currency.', {
      hint: 'Set currency on the account in the config.',
    });
  }
  return currency.toUpperCase();
}

function mapStatus(value: JsonValue | undefined): string {
  switch (value) {
    case 'ACTIVE':
      return 'ENABLED';
    case 'PAUSED':
      return 'PAUSED';
    case 'ARCHIVED':
    case 'DELETED':
      return 'REMOVED';
    default:
      throw new AutopilotError('platform_error', 'The Meta Graph API returned an unknown entity status.');
  }
}

const LEVEL_NAMES: Record<MetaEntity, string> = { campaign: 'campaign', adset: 'ad set', ad: 'ad' };

/** Ads carry no budget fields: asking for them makes the Graph API reject the read. */
function readFields(entity: MetaEntity): string {
  return entity === 'ad' ? 'status,account_id' : 'status,daily_budget,lifetime_budget,account_id';
}

/**
 * A token often covers several ad accounts, so the target must be proven to belong to the
 * configured one. An absent or unreadable owner is refused like a foreign one.
 */
function assertOwnedByAccount(deps: ConnectorDeps, entity: MetaEntity, body: JsonObject): void {
  const expected = adAccountId(deps).slice('act_'.length);
  const raw = body['account_id'];
  const text = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '';
  const owner = text.startsWith('act_') ? text.slice('act_'.length) : text;
  if (!/^\d+$/.test(owner)) {
    throw new AutopilotError(
      'invalid_input',
      `The Meta Graph API did not say which ad account this ${LEVEL_NAMES[entity]} belongs to, so it cannot be changed.`,
    );
  }
  if (owner !== expected) {
    throw new AutopilotError(
      'invalid_input',
      `This ${LEVEL_NAMES[entity]} belongs to another ad account, not to account '${deps.account.id}'.`,
      { hint: 'Use a target id from the configured ad account.' },
    );
  }
}

/** Budget in Meta units, or null when the field is absent or zero (Meta reports an unused budget as "0"). */
function minorBudget(value: JsonValue | undefined): number | null {
  if (value === undefined || value === null || value === '') return null;
  const minor = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(minor) || minor < 0) {
    throw new AutopilotError('platform_error', 'The Meta Graph API returned an unreadable budget.');
  }
  return minor === 0 ? null : minor;
}

export async function readMetaAdsState(deps: ConnectorDeps, draft: ActionDraft): Promise<JsonObject> {
  const { entity, operation } = parseKind(draft.kind);
  const id = targetId(draft);
  const ctx = context(deps);
  const fields = actionSpec(draft.kind).fields;

  const response = await deps.http.request({
    url: `${ctx.base}/${id}`,
    method: 'GET',
    headers: ctx.headers,
    query: { fields: readFields(entity) },
  });
  const body = asObject(response.body);
  assertOwnedByAccount(deps, entity, body);
  const state: JsonObject = {};

  if (fields.includes('status')) state['status'] = mapStatus(body['status']);

  if (fields.includes('dailyBudget')) {
    const daily = minorBudget(body['daily_budget']);
    if (daily === null && operation === 'set_daily_budget') {
      if (minorBudget(body['lifetime_budget']) !== null) {
        throw new AutopilotError(
          'unsupported',
          `This ${entity === 'adset' ? 'ad set' : entity} runs on a lifetime budget, so it has no daily budget to change.`,
          { hint: 'Change the lifetime budget in Ads Manager, or switch the entity to a daily budget first.' },
        );
      }
      throw new AutopilotError(
        'unsupported',
        entity === 'campaign'
          ? 'This campaign has no campaign-level budget: its budgets are set on the ad sets.'
          : 'This ad set has no budget of its own: the budget is set on its campaign.',
        {
          hint:
            entity === 'campaign'
              ? 'Use meta_ads.adset.set_daily_budget on its ad sets.'
              : 'Use meta_ads.campaign.set_daily_budget on its campaign.',
        },
      );
    }
    state['dailyBudget'] = daily === null ? null : fromMetaUnits(daily, await accountCurrency(deps, ctx));
  }

  return state;
}

async function buildForm(
  deps: ConnectorDeps,
  ctx: Context,
  action: Action,
  operation: Operation,
): Promise<Record<string, string>> {
  if (operation === 'pause') return { status: 'PAUSED' };
  if (operation === 'enable') return { status: 'ACTIVE' };
  const amount = action.params['dailyBudget'];
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new AutopilotError('invalid_input', 'params.dailyBudget must be a positive number.');
  }
  // toMetaUnits throws rather than rounds: the amount sent is exactly the amount a person approved.
  const units = toMetaUnits(amount, await accountCurrency(deps, ctx));
  if (!Number.isSafeInteger(units) || units <= 0) {
    throw new AutopilotError('invalid_input', 'params.dailyBudget is below the smallest unit of the account currency.');
  }
  return { daily_budget: String(units) };
}

export async function applyMetaAdsAction(
  deps: ConnectorDeps,
  action: Action,
  options: { validateOnly: boolean; idempotencyKey: string },
): Promise<ActionResult> {
  const { validateOnly } = options;
  let token: string | undefined;
  try {
    const { entity, operation } = parseKind(action.kind);
    const id = targetId(action);
    const ctx = context(deps);
    token = ctx.token;
    const form = await buildForm(deps, ctx, action, operation);
    if (validateOnly) form['execution_options'] = '["validate_only"]';

    const owner = await deps.http.request({
      url: `${ctx.base}/${id}`,
      method: 'GET',
      headers: ctx.headers,
      query: { fields: 'account_id' },
    });
    assertOwnedByAccount(deps, entity, asObject(owner.body));

    const response = await deps.http.request({
      url: `${ctx.base}/${id}`,
      method: 'POST',
      headers: ctx.headers,
      form,
      retry: false,
    });

    const body = response.body;
    if (body !== null && typeof body === 'object' && !Array.isArray(body) && body['success'] === false) {
      return {
        ok: false,
        dryRun: validateOnly,
        after: null,
        resource: id,
        error: { code: 'platform_error', message: 'The Meta Graph API reported that the change was not applied.', retryable: false },
      };
    }

    const result: ActionResult = { ok: true, dryRun: validateOnly, after: null, resource: id };
    const traceId = response.headers['x-fb-trace-id'];
    if (typeof traceId === 'string' && traceId !== '') result.platformRequestId = traceId;
    return result;
  } catch (error) {
    if (!(error instanceof AutopilotError)) throw error;
    // A retryable failure on a live call may have reached the platform: the executor must reconcile it.
    if (error.retryable && !validateOnly) throw error;
    const message = token === undefined ? error.message : error.message.split(token).join('[redacted]');
    return {
      ok: false,
      dryRun: validateOnly,
      after: null,
      error: { code: error.code, message, retryable: error.retryable },
    };
  }
}
