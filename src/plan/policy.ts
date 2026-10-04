import { digest } from '../core/ids';
import type {
  AccountConfig, Action, Autonomy, JsonObject, JsonValue, LedgerEntry, Plan, Policy,
  PolicyDecision, PolicyRuleResult, Snapshot,
} from '../core/types';

export interface PolicyInput {
  plan: Plan;
  policy: Policy;
  account: AccountConfig;
  /** The snapshot the plan was built on, when there is one. */
  snapshot: Snapshot | null;
  /** Ledger entries for the account, used for cooldowns and rolling limits. */
  ledger: LedgerEntry[];
  autonomy: Autonomy;
  killSwitch: boolean;
  now: Date;
}

const HOUR_MS = 60 * 60 * 1000;
const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

interface TimedEntry {
  entry: LedgerEntry;
  time: number;
}

type Details = Pick<PolicyRuleResult, 'actionId' | 'observed' | 'limit'>;
type Deny = (message: string, details?: Details) => void;

function object(value: JsonValue | undefined): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function nonnegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function micros(value: unknown): bigint | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value * 1e6);
  return Number.isSafeInteger(rounded) ? BigInt(rounded) : null;
}

function positiveMicros(value: unknown): bigint | null {
  const amount = micros(value);
  return amount !== null && amount > 0n ? amount : null;
}

function cap(base: bigint, fraction: number): bigint | null {
  if (!nonnegative(fraction)) return null;
  // Decimal arithmetic floors the cap without floating-point rounding widening the limit.
  const [coefficient = '0', exponent = '0'] = fraction.toString().split('e');
  const [whole = '0', decimal = ''] = coefficient.split('.');
  const numerator = BigInt(whole + decimal);
  const scale = decimal.length - Number(exponent);
  return scale >= 0
    ? base * numerator / (10n ** BigInt(scale))
    : base * numerator * (10n ** BigInt(-scale));
}

function globMatches(pattern: string, name: string): boolean {
  const glob = pattern.toLowerCase();
  const text = name.toLowerCase();
  let p = 0;
  let t = 0;
  let star = -1;
  let retry = 0;
  while (t < text.length) {
    if (glob[p] === '*') {
      star = p++;
      retry = t;
    } else if (glob[p] === text[t]) {
      p++;
      t++;
    } else if (star >= 0) {
      p = star + 1;
      t = ++retry;
    } else {
      return false;
    }
  }
  while (glob[p] === '*') p++;
  return p === glob.length;
}

function applied(entry: LedgerEntry): boolean {
  return entry.event === 'action.applied'
    || (entry.event === 'action.reconciled' && entry.data?.outcome === 'applied');
}

function resolved(entry: LedgerEntry): boolean {
  return applied(entry) || entry.event === 'action.failed' || entry.event === 'action.skipped'
    || (entry.event === 'action.reconciled' && entry.data?.outcome === 'not_applied');
}

function effectiveEntries(entries: TimedEntry[]): TimedEntry[] {
  const groups = new Map<string, TimedEntry[]>();
  for (const item of entries) {
    if (!item.entry.event.startsWith('action.')) continue;
    const { executionId, actionId } = item.entry;
    const key = executionId !== undefined && actionId !== undefined
      ? JSON.stringify([executionId, actionId])
      : JSON.stringify([item.entry.seq]);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  const effective: TimedEntry[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.entry.seq - b.entry.seq);
    const confirmations = group.filter(({ entry }) => applied(entry));
    effective.push(...confirmations);
    const intents = group.filter(({ entry }) => entry.event === 'action.intent');
    const unresolved = intents.filter((intent) => !group.some(({ entry }) =>
      entry.seq > intent.entry.seq && resolved(entry)));
    if (unresolved.length > 0) {
      effective.push(...unresolved);
    } else if (intents.length === 0 && confirmations.length === 0) {
      // A truncated ledger may retain ambiguity without its original intent.
      const ambiguous = group.find((item) =>
        (item.entry.event === 'action.unknown'
          || (item.entry.event === 'action.reconciled' && !resolved(item.entry)))
        && !group.some(({ entry }) => entry.seq > item.entry.seq && resolved(entry)));
      if (ambiguous) effective.push(ambiguous);
    }
  }
  return effective.sort((a, b) => a.time - b.time || a.entry.seq - b.entry.seq);
}

/** Deterministic limits. Pure: same input, same decision. */
export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const { plan, policy, account, snapshot, autonomy, now } = input;
  const nowMs = now.getTime();
  const results: PolicyRuleResult[] = [];
  const clockViolations: Array<{ message: string; details: Details }> = [];
  const timed: TimedEntry[] = [];
  if (!Number.isFinite(nowMs)) {
    clockViolations.push({ message: 'The evaluation time is invalid.', details: {} });
  }
  for (const entry of input.ledger) {
    const time = Date.parse(entry.ts);
    const details: Details = entry.actionId === undefined ? {} : { actionId: entry.actionId };
    if (!Number.isFinite(time) || !Number.isSafeInteger(entry.seq) || entry.seq < 0) {
      clockViolations.push({ message: 'The ledger time or sequence is invalid.', details });
    } else if (time - nowMs > CLOCK_TOLERANCE_MS) {
      clockViolations.push({
        message: 'A ledger entry is more than five minutes in the future.',
        details: { ...details, observed: (time - nowMs) / 60000, limit: 5 },
      });
    } else if (entry.accountId === undefined || entry.accountId === account.id) {
      timed.push({ entry, time });
    }
  }
  const effective = effectiveEntries(timed);
  const recent = (hours: number): TimedEntry[] => effective.filter(({ time }) =>
    Number.isFinite(nowMs) && (nowMs - time) / HOUR_MS <= hours);
  const cooldownEntries = recent(policy.cooldownHours);

  function rule(ruleId: string, check: (deny: Deny) => void): void {
    const count = results.length;
    check((message, details = {}) => results.push({ ruleId, outcome: 'deny', message, ...details }));
    if (results.length === count) {
      results.push({ ruleId, outcome: 'pass', message: 'Rule passed.' });
    }
  }

  rule('kill_switch', (deny) => {
    if (input.killSwitch) deny('The kill switch is active.');
  });
  rule('autonomy', (deny) => {
    if (autonomy === 'observe' || autonomy === 'propose') {
      deny('live changes are off at this autonomy level; set "autonomy" to "approve" in the config to allow approved plans');
    }
  });
  rule('empty_plan', (deny) => {
    if (plan.actions.length === 0) deny('The plan has no actions.');
  });
  rule('max_actions', (deny) => {
    if (!Number.isSafeInteger(policy.maxActionsPerPlan) || policy.maxActionsPerPlan < 0) {
      deny('The maximum action count is invalid.');
    } else if (plan.actions.length > policy.maxActionsPerPlan) {
      deny('The plan exceeds the maximum action count.', {
        observed: plan.actions.length, limit: policy.maxActionsPerPlan,
      });
    }
  });
  rule('kind_denied', (deny) => {
    for (const action of plan.actions) {
      if (policy.denyKinds.includes(action.kind)) {
        deny('This action kind is denied by policy.', { actionId: action.id, observed: action.kind });
      }
    }
  });
  rule('protected_entity', (deny) => {
    const protectedEntities = account.protected ?? [];
    if (protectedEntities.length === 0) return;
    for (const action of plan.actions) {
      const { target } = action;
      const needsCampaign = target.level === 'ad_group' || target.level === 'ad' || target.level === 'keyword';
      // An account target carries no entity name by construction, so only its id can be protected.
      if (target.level === 'account') {
        if (protectedEntities.includes(target.id)) {
          deny('The action targets a protected entity.', { actionId: action.id, observed: target.id });
        }
        continue;
      }
      // Any entry may be a name, exact or glob, so a snapshot entity without a name cannot be cleared.
      if (!target.name || (needsCampaign && !target.campaignId)) {
        deny('The target could not be checked against the protected list; create the plan from a fresh snapshot.', {
          actionId: action.id, observed: target.id,
        });
        continue;
      }
      if (protectedEntities.some((pattern) => pattern === target.id || pattern === target.campaignId
        || pattern === target.adGroupId
        || (target.name !== undefined && globMatches(pattern, target.name)))) {
        deny('The action targets a protected entity.', { actionId: action.id, observed: target.id });
      }
    }
  });
  rule('conflicting_actions', (deny) => {
    const writers = new Map<string, Action[]>();
    for (const action of plan.actions) {
      const key = JSON.stringify([action.target.level, action.target.id]);
      const previous = writers.get(key) ?? [];
      for (const other of previous) {
        const overlap = Object.keys(action.after).filter((field) => Object.hasOwn(other.after, field));
        if (overlap.length > 0) {
          deny(`The action overlaps writes from action ${other.id}.`, {
            actionId: action.id, observed: overlap,
          });
        }
      }
      previous.push(action);
      writers.set(key, previous);
    }
  });
  rule('missing_before', (deny) => {
    for (const action of plan.actions) {
      if (action.before === null || action.preconditionHash === null) {
        deny('A live change needs a before state and precondition hash.', { actionId: action.id });
      }
    }
  });
  rule('spend_unknown', (deny) => {
    for (const action of plan.actions) {
      if (action.spendEffect === 'unknown') {
        deny('The action has an unknown spend effect.', { actionId: action.id });
      }
    }
  });
  rule('snapshot_age', (deny) => {
    if (snapshot === null) {
      if (plan.snapshotId !== null) deny('The snapshot used by this plan is missing.');
      return;
    }
    const age = (nowMs - Date.parse(snapshot.createdAt)) / HOUR_MS;
    if (!Number.isFinite(age) || !nonnegative(policy.maxSnapshotAgeHours)) {
      deny('The snapshot age limit cannot be evaluated.');
    } else if (age > policy.maxSnapshotAgeHours) {
      deny('The snapshot is too old.', { observed: age, limit: policy.maxSnapshotAgeHours });
    }
  });
  rule('snapshot_source', (deny) => {
    if (snapshot === null) return;
    if (snapshot.accountId !== plan.accountId || snapshot.platform !== plan.platform) {
      deny('The snapshot account and platform must match the plan.');
    }
    if (snapshot.externalAccountId !== account.externalId) {
      deny('The snapshot was read from a different platform account than the one configured; create a fresh snapshot.', {
        observed: snapshot.externalAccountId, limit: account.externalId,
      });
    }
    if (snapshot.source !== 'api' && account.source !== 'demo') {
      deny('Live changes need a snapshot read from the platform API; a CSV import can be audited but cannot back a change.');
    }
  });

  function changeRule(ruleId: string, field: string, fraction: number, matches: (action: Action) => boolean): void {
    rule(ruleId, (deny) => {
      for (const action of plan.actions.filter(matches)) {
        const details = { actionId: action.id };
        const before = positiveMicros(action.before?.[field]);
        const afterValue = action.after[field];
        const after = micros(afterValue);
        if (before === null || after === null || typeof afterValue !== 'number' || afterValue < 0
          || !nonnegative(fraction) || !nonnegative(policy.cooldownHours) || !Number.isFinite(nowMs)) {
          deny(`The ${field} change limit cannot be evaluated.`, details);
          continue;
        }
        if (cooldownEntries.some(({ entry }) => typeof entry.data?.kind !== 'string'
          || typeof object(entry.data?.target)?.id !== 'string')) {
          deny(`The historical ${field} changes cannot be identified.`, details);
          continue;
        }
        const history = cooldownEntries.filter(({ entry }) => {
          const target = object(entry.data?.target);
          return entry.data?.kind === action.kind && target?.id === action.target.id;
        });
        const oldest = history[0];
        const base = oldest ? positiveMicros(object(oldest.entry.data?.before)?.[field]) : before;
        const limit = base === null ? null : cap(base, fraction);
        if (base === null || limit === null) {
          deny(`The historical ${field} baseline is unavailable.`, details);
          continue;
        }
        const delta = after >= base ? after - base : base - after;
        if (delta > limit) {
          deny(`The ${field} change exceeds its limit.`, {
            ...details, observed: Number(delta) / Number(base), limit: fraction,
          });
        }
      }
    });
  }
  changeRule('budget_change', 'dailyBudget', policy.maxBudgetChangePct,
    (action) => action.kind.endsWith('.set_daily_budget'));
  changeRule('bid_change', 'bid', policy.maxBidChangePct,
    (action) => action.kind === 'google_ads.keyword.set_bid');

  rule('account_budget_increase', (deny) => {
    let increase = 0n;
    let hasIncrease = false;
    const readIncrease = (value: JsonValue | undefined, effect: JsonValue | undefined, details: Details): bigint => {
      if (value === null && (effect === 'none' || effect === 'decrease')) return 0n;
      const amount = micros(value);
      if (amount === null) {
        deny('The daily spend increase cannot be determined.', details);
        return 0n;
      }
      return typeof value === 'number' && value > 0 ? amount : 0n;
    };
    for (const action of plan.actions) {
      if (action.spendDeltaPerDay !== null && action.spendDeltaPerDay > 0) hasIncrease = true;
      increase += readIncrease(action.spendDeltaPerDay, action.spendEffect, { actionId: action.id });
    }
    if (!hasIncrease) return;
    for (const { entry } of recent(24)) {
      increase += readIncrease(entry.data?.spendDeltaPerDay, entry.data?.spendEffect,
        entry.actionId === undefined ? {} : { actionId: entry.actionId });
    }
    const campaigns = snapshot?.datasets.campaigns;
    if (!campaigns) {
      deny('An account budget increase needs a campaigns snapshot.');
      return;
    }
    let total = 0n;
    const countedBudgets = new Set<string>();
    for (const row of campaigns) {
      if (row.attrs.status !== 'ENABLED') continue;
      const budgetId = typeof row.attrs.budgetId === 'string' && row.attrs.budgetId.trim() !== ''
        ? row.attrs.budgetId : null;
      if (budgetId === null && row.attrs.sharedBudget === true) {
        deny('Shared budgets could not be de-duplicated; an enabled campaign is missing its budget id.', { observed: row.id });
        return;
      }
      const amount = micros(row.attrs.dailyBudget);
      if (amount === null || amount < 0n || (typeof row.attrs.dailyBudget === 'number' && row.attrs.dailyBudget < 0)) {
        deny('An enabled campaign has an invalid daily budget.', { observed: row.id });
        return;
      }
      if (budgetId !== null) {
        if (countedBudgets.has(budgetId)) continue;
        countedBudgets.add(budgetId);
      }
      total += amount;
    }
    const limit = cap(total, policy.maxAccountBudgetIncreasePct);
    if (total <= 0n || limit === null || !Number.isFinite(nowMs)) {
      deny('The account budget increase limit cannot be evaluated.');
    } else if (increase > limit) {
      deny('Gross daily budget increases exceed the account limit.', {
        observed: Number(increase) / 1e6, limit: Number(limit) / 1e6,
      });
    }
  });
  rule('cooldown', (deny) => {
    if (!nonnegative(policy.cooldownHours) || !Number.isFinite(nowMs)) {
      deny('The cooldown cannot be evaluated.');
      return;
    }
    for (const action of plan.actions) {
      const blocked = cooldownEntries.find(({ entry }) => {
        if (plan.revertsPlanId !== undefined && entry.planId === plan.revertsPlanId) return false;
        const target = object(entry.data?.target);
        return target === null || typeof target.level !== 'string' || typeof target.id !== 'string'
          || (target.level === action.target.level && target.id === action.target.id);
      });
      if (blocked) {
        deny('The target has an effective operation within the cooldown window.', {
          actionId: action.id,
          observed: Math.max(0, (nowMs - blocked.time) / HOUR_MS), limit: policy.cooldownHours,
        });
      }
    }
  });
  rule('clock', (deny) => {
    for (const { message, details } of clockViolations) deny(message, details);
  });

  const allowed = results.every((result) => result.outcome !== 'deny');
  return {
    planDigest: plan.digest,
    policyDigest: digest(policy),
    // Invalid Date has no ISO representation; report the clock denial without throwing.
    evaluatedAt: Number.isFinite(nowMs) ? now.toISOString() : '',
    allowed,
    autoApplicable: allowed && autonomy === 'autopilot' && plan.actions.every((action) =>
      policy.autoApply.includes(action.kind)
      && (action.spendEffect === 'none' || action.spendEffect === 'decrease')
      && action.reversible !== 'none'),
    results,
  };
}
