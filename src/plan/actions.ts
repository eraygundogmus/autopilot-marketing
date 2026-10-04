import { AutopilotError } from '../core/errors';
import { canonicalJson, digest, sha256, shortId } from '../core/ids';
import { ACTION_KINDS } from '../core/types';
import type {
  Action,
  ActionDraft,
  ActionKind,
  EntityLevel,
  JsonObject,
  Platform,
  Reversibility,
  SpendEffect,
} from '../core/types';

export interface ActionSpec {
  kind: ActionKind;
  platform: Platform;
  targetLevel: EntityLevel;
  reversible: Reversibility;
  /** State fields captured in `before` and re-read as the precondition, e.g. ['status', 'dailyBudget']. */
  fields: string[];
  /** A side effect the reviewer must see, e.g. that segment membership can trigger campaigns. */
  caution?: string;
  /** Problems with `params`; empty when valid. */
  validate(params: JsonObject): string[];
  /** Intended state of `fields` after the action. */
  after(before: JsonObject | null, params: JsonObject): JsonObject;
  spend(before: JsonObject | null, after: JsonObject): { effect: SpendEffect; deltaPerDay: number | null };
  /** The draft that undoes an applied action, or null when there is none. */
  inverse(action: Action): ActionDraft | null;
}

type Spend = { effect: SpendEffect; deltaPerDay: number | null };
type SpecBody = Omit<ActionSpec, 'kind' | 'platform'>;

const MATCH_TYPES = ['EXACT', 'PHRASE', 'BROAD'];
const NEGATIVE_KEYWORD_FORBIDDEN = /[!@%,*]/;
const MAX_NEGATIVE_KEYWORD_CHARS = 80;
const MAX_NEGATIVE_KEYWORD_WORDS = 10;
const MAX_EMAIL_LABEL_CHARS = 200;
const MAX_EMAIL_HTML_CHARS = 200000;
const MIN_RATIONALE_CHARS = 10;
const SEGMENT_CAUTION = 'Segment membership can start campaigns and emails in Mautic.';

function unknownKeys(params: JsonObject, allowed: string[]): string[] {
  return Object.keys(params)
    .filter((key) => !allowed.includes(key))
    .map((key) => `params.${key} is not a parameter of this action`);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positiveNumberProblems(params: JsonObject, key: string): string[] {
  const value = params[key];
  const problems = isFiniteNumber(value) && value > 0 ? [] : [`params.${key} must be a finite number greater than 0`];
  return [...problems, ...unknownKeys(params, [key])];
}

function boundedStringProblems(params: JsonObject, key: string, max: number): string[] {
  const value = params[key];
  if (typeof value !== 'string' || value.trim() === '') return [`params.${key} must be a non-empty string`];
  if (value.length > max) return [`params.${key} must be at most ${max} characters`];
  return [];
}

function revert(action: Action, kind: ActionKind, params: JsonObject): ActionDraft {
  return { kind, target: action.target, params, rationale: `Revert ${action.kind}` };
}

/** The compensating draft, or null unless `before` records the opposite of the state the action set. */
function toggleInverse(action: Action, field: string, target: boolean, opposite: ActionKind): ActionDraft | null {
  // An unknown or already-matching prior state means the action changed nothing that can be undone.
  if (action.before === null || action.before[field] !== !target) return null;
  return revert(action, opposite, action.params);
}

function statusSpec(
  targetLevel: EntityLevel,
  hasBudget: boolean,
  status: 'PAUSED' | 'ENABLED',
  opposite: ActionKind,
): SpecBody {
  return {
    targetLevel,
    reversible: 'exact',
    fields: hasBudget ? ['status', 'dailyBudget'] : ['status'],
    validate: (params) => unknownKeys(params, []),
    after: () => ({ status }),
    spend: (before): Spend => {
      if (before !== null && before['status'] === status) return { effect: 'none', deltaPerDay: 0 };
      const budget = before === null ? undefined : before['dailyBudget'];
      const amount = isFiniteNumber(budget) ? budget : null;
      if (status === 'PAUSED') return { effect: 'decrease', deltaPerDay: amount === null ? null : 0 - amount };
      return { effect: 'increase', deltaPerDay: amount };
    },
    inverse: (action) => {
      const previous = action.before === null ? undefined : action.before['status'];
      if (typeof previous !== 'string' || previous === status) return null;
      return revert(action, opposite, {});
    },
  };
}

function direction(delta: number): SpendEffect {
  if (delta > 0) return 'increase';
  if (delta < 0) return 'decrease';
  return 'none';
}

function numericSpec(targetLevel: EntityLevel, field: 'dailyBudget' | 'bid', kind: ActionKind): SpecBody {
  return {
    targetLevel,
    reversible: 'exact',
    fields: [field],
    validate: (params) => positiveNumberProblems(params, field),
    after: (_before, params) => ({ [field]: params[field] ?? null }),
    spend: (before, after): Spend => {
      const from = before === null ? undefined : before[field];
      const to = after[field];
      if (!isFiniteNumber(from) || !isFiniteNumber(to)) return { effect: 'unknown', deltaPerDay: null };
      const delta = Math.round((to - from) * 1e6) / 1e6;
      // A bid is a per-click ceiling, so its change does not translate into a daily amount.
      return { effect: direction(delta), deltaPerDay: field === 'bid' ? null : delta === 0 ? 0 : delta };
    },
    inverse: (action) => {
      const previous = action.before === null ? undefined : action.before[field];
      return isFiniteNumber(previous) ? revert(action, kind, { [field]: previous }) : null;
    },
  };
}

function negativeKeywordProblems(params: JsonObject): string[] {
  const problems: string[] = [];
  const text = params['text'];
  if (typeof text !== 'string' || text.trim() === '') {
    problems.push('params.text must be a non-empty string');
  } else {
    const trimmed = text.trim();
    if (trimmed.length > MAX_NEGATIVE_KEYWORD_CHARS) {
      problems.push(`params.text must be at most ${MAX_NEGATIVE_KEYWORD_CHARS} characters`);
    }
    if (trimmed.split(/\s+/).length > MAX_NEGATIVE_KEYWORD_WORDS) {
      problems.push(`params.text must be at most ${MAX_NEGATIVE_KEYWORD_WORDS} words`);
    }
    if (NEGATIVE_KEYWORD_FORBIDDEN.test(trimmed)) {
      problems.push('params.text must not contain any of ! @ % , *');
    }
  }
  const matchType = params['matchType'];
  if (typeof matchType !== 'string' || !MATCH_TYPES.includes(matchType)) {
    problems.push(`params.matchType must be one of ${MATCH_TYPES.join(', ')}`);
  }
  return [...problems, ...unknownKeys(params, ['text', 'matchType'])];
}

function negativeKeywordSpec(exists: boolean, opposite: ActionKind): SpecBody {
  return {
    targetLevel: 'campaign',
    reversible: 'compensating',
    fields: ['exists'],
    validate: negativeKeywordProblems,
    after: () => ({ exists }),
    spend: (before): Spend => {
      if (before !== null && before['exists'] === exists) return { effect: 'none', deltaPerDay: 0 };
      return { effect: exists ? 'decrease' : 'increase', deltaPerDay: null };
    },
    inverse: (action) => toggleInverse(action, 'exists', exists, opposite),
  };
}

function segmentSpec(member: boolean, opposite: ActionKind): SpecBody {
  return {
    targetLevel: 'segment',
    reversible: 'compensating',
    fields: ['member'],
    caution: SEGMENT_CAUTION,
    validate: (params) => {
      const contactId = params['contactId'];
      const problems =
        typeof contactId === 'string' && /^\d+$/.test(contactId) ? [] : ['params.contactId must be a string of digits'];
      return [...problems, ...unknownKeys(params, ['contactId'])];
    },
    after: () => ({ member }),
    spend: (): Spend => ({ effect: 'none', deltaPerDay: 0 }),
    inverse: (action) => toggleInverse(action, 'member', member, opposite),
  };
}

const emailDraftSpec: SpecBody = {
  targetLevel: 'account',
  reversible: 'none',
  fields: ['exists'],
  validate: (params) => [
    ...boundedStringProblems(params, 'name', MAX_EMAIL_LABEL_CHARS),
    ...boundedStringProblems(params, 'subject', MAX_EMAIL_LABEL_CHARS),
    ...boundedStringProblems(params, 'html', MAX_EMAIL_HTML_CHARS),
    ...unknownKeys(params, ['name', 'subject', 'html']),
  ],
  after: () => ({ exists: true }),
  spend: (): Spend => ({ effect: 'none', deltaPerDay: 0 }),
  inverse: () => null,
};

const BODIES: Record<ActionKind, SpecBody> = {
  'google_ads.campaign.pause': statusSpec('campaign', true, 'PAUSED', 'google_ads.campaign.enable'),
  'google_ads.campaign.enable': statusSpec('campaign', true, 'ENABLED', 'google_ads.campaign.pause'),
  'google_ads.campaign.set_daily_budget': numericSpec('campaign', 'dailyBudget', 'google_ads.campaign.set_daily_budget'),
  'google_ads.ad_group.pause': statusSpec('ad_group', false, 'PAUSED', 'google_ads.ad_group.enable'),
  'google_ads.ad_group.enable': statusSpec('ad_group', false, 'ENABLED', 'google_ads.ad_group.pause'),
  'google_ads.ad.pause': statusSpec('ad', false, 'PAUSED', 'google_ads.ad.enable'),
  'google_ads.ad.enable': statusSpec('ad', false, 'ENABLED', 'google_ads.ad.pause'),
  'google_ads.keyword.pause': statusSpec('keyword', false, 'PAUSED', 'google_ads.keyword.enable'),
  'google_ads.keyword.enable': statusSpec('keyword', false, 'ENABLED', 'google_ads.keyword.pause'),
  'google_ads.keyword.set_bid': numericSpec('keyword', 'bid', 'google_ads.keyword.set_bid'),
  'google_ads.negative_keyword.add': negativeKeywordSpec(true, 'google_ads.negative_keyword.remove'),
  'google_ads.negative_keyword.remove': negativeKeywordSpec(false, 'google_ads.negative_keyword.add'),
  'meta_ads.campaign.pause': statusSpec('campaign', true, 'PAUSED', 'meta_ads.campaign.enable'),
  'meta_ads.campaign.enable': statusSpec('campaign', true, 'ENABLED', 'meta_ads.campaign.pause'),
  'meta_ads.campaign.set_daily_budget': numericSpec('campaign', 'dailyBudget', 'meta_ads.campaign.set_daily_budget'),
  'meta_ads.adset.pause': statusSpec('ad_group', true, 'PAUSED', 'meta_ads.adset.enable'),
  'meta_ads.adset.enable': statusSpec('ad_group', true, 'ENABLED', 'meta_ads.adset.pause'),
  'meta_ads.adset.set_daily_budget': numericSpec('ad_group', 'dailyBudget', 'meta_ads.adset.set_daily_budget'),
  'meta_ads.ad.pause': statusSpec('ad', false, 'PAUSED', 'meta_ads.ad.enable'),
  'meta_ads.ad.enable': statusSpec('ad', false, 'ENABLED', 'meta_ads.ad.pause'),
  'mautic.segment.add_contact': segmentSpec(true, 'mautic.segment.remove_contact'),
  'mautic.segment.remove_contact': segmentSpec(false, 'mautic.segment.add_contact'),
  'mautic.email.create_draft': emailDraftSpec,
};

function isActionKind(kind: unknown): kind is ActionKind {
  return typeof kind === 'string' && (ACTION_KINDS as readonly string[]).includes(kind);
}

export function actionSpec(kind: ActionKind): ActionSpec {
  if (!isActionKind(kind)) {
    throw new AutopilotError('unsupported', `Unsupported action kind: ${String(kind)}`, {
      hint: `Supported kinds: ${ACTION_KINDS.join(', ')}`,
    });
  }
  const platform = kind.slice(0, kind.indexOf('.')) as Platform;
  return { kind, platform, ...BODIES[kind] };
}

/** Problems with a draft (unknown kind, wrong target level, bad params, empty rationale); empty when valid. */
export function validateDraft(draft: ActionDraft): string[] {
  const problems: string[] = [];
  const known = isActionKind(draft.kind);
  if (!known) problems.push(`kind '${String(draft.kind)}' is not a supported action`);
  const spec = known ? actionSpec(draft.kind) : null;
  if (spec !== null && draft.target.level !== spec.targetLevel) {
    problems.push(`target.level must be '${spec.targetLevel}' for ${spec.kind}, got '${draft.target.level}'`);
  }
  if (typeof draft.target.id !== 'string' || draft.target.id === '') problems.push('target.id must not be empty');
  if (typeof draft.rationale !== 'string' || draft.rationale.trim().length < MIN_RATIONALE_CHARS) {
    problems.push(`rationale must be at least ${MIN_RATIONALE_CHARS} characters`);
  }
  if (spec !== null) problems.push(...spec.validate(draft.params));
  return problems;
}

export function buildAction(draft: ActionDraft, before: JsonObject | null): Action {
  const spec = actionSpec(draft.kind);
  const after = spec.after(before, draft.params);
  const spend = spec.spend(before, after);
  return {
    id: shortId('act', {
      kind: draft.kind,
      target: { level: draft.target.level, id: draft.target.id },
      params: draft.params,
    }),
    kind: draft.kind,
    target: draft.target,
    params: draft.params,
    rationale: draft.rationale,
    ...(draft.findingIds === undefined ? {} : { findingIds: draft.findingIds }),
    platform: spec.platform,
    before,
    after,
    preconditionHash: before === null ? null : digest(before),
    spendEffect: spend.effect,
    spendDeltaPerDay: spend.deltaPerDay,
    reversible: spec.reversible,
    status: 'pending',
  };
}

/** sha256 over account, platform, snapshot, reverted plan and each action's kind, target, params, before and after, in order. */
export function planDigest(input: {
  accountId: string;
  platform: Platform;
  actions: Action[];
  snapshotId?: string | null;
  revertsPlanId?: string;
}): string {
  const body = {
    accountId: input.accountId,
    platform: input.platform,
    // Both drive policy (snapshot age and limits, the revert's cooldown exemption), so an approval must cover them.
    snapshotId: input.snapshotId ?? null,
    revertsPlanId: input.revertsPlanId ?? null,
    actions: input.actions.map((a) => ({
      kind: a.kind,
      target: a.target,
      params: a.params,
      before: a.before,
      after: a.after,
    })),
  };
  return sha256(`autopilot-plan:v1\n${canonicalJson(body)}`);
}
