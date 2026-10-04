import { describe, expect, it } from 'vitest';
import { digest } from '../../src/core/ids';
import type {
  AccountConfig,
  Action,
  Autonomy,
  LedgerEntry,
  Plan,
  Policy,
  PolicyDecision,
  Snapshot,
} from '../../src/core/types';
import { evaluatePolicy, type PolicyInput } from '../../src/plan/policy';

const NOW = new Date('2026-10-04T12:00:00.000Z');
const RULES = [
  'kill_switch',
  'autonomy',
  'empty_plan',
  'max_actions',
  'kind_denied',
  'protected_entity',
  'conflicting_actions',
  'missing_before',
  'spend_unknown',
  'snapshot_age',
  'snapshot_source',
  'budget_change',
  'bid_change',
  'account_budget_increase',
  'cooldown',
  'clock',
];

function ago(hours: number): string {
  return new Date(NOW.getTime() - hours * 3_600_000).toISOString();
}

function action(overrides: Partial<Action> = {}): Action {
  return {
    id: 'act_current',
    kind: 'google_ads.campaign.pause',
    platform: 'google_ads',
    target: { level: 'campaign', id: 'campaign-1', name: 'Search' },
    params: {},
    rationale: 'Pause inefficient spend.',
    before: { status: 'ENABLED' },
    after: { status: 'PAUSED' },
    preconditionHash: 'before-hash',
    spendEffect: 'decrease',
    spendDeltaPerDay: -100,
    reversible: 'exact',
    status: 'pending',
    ...overrides,
  };
}

function budget(before = 100, after = 110, overrides: Partial<Action> = {}): Action {
  return action({
    kind: 'google_ads.campaign.set_daily_budget',
    before: { dailyBudget: before },
    after: { dailyBudget: after },
    params: { dailyBudget: after },
    spendEffect: after > before ? 'increase' : after < before ? 'decrease' : 'none',
    spendDeltaPerDay: after - before,
    ...overrides,
  });
}

function bid(before = 10, after = 11, overrides: Partial<Action> = {}): Action {
  return action({
    kind: 'google_ads.keyword.set_bid',
    target: { level: 'keyword', id: 'keyword-1' },
    before: { bid: before },
    after: { bid: after },
    params: { bid: after },
    spendEffect: 'none',
    spendDeltaPerDay: 0,
    ...overrides,
  });
}

function plan(actions: Action[] = [action()], overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'plan_current',
    schemaVersion: 1,
    createdAt: ago(0),
    createdBy: 'agent',
    accountId: 'account-1',
    platform: 'google_ads',
    snapshotId: 'snapshot-1',
    title: 'Reviewed changes',
    rationale: 'Reduce waste.',
    actions,
    digest: 'current-plan-digest',
    status: 'approved',
    ...overrides,
  };
}

function policy(overrides: Partial<Policy> = {}): Policy {
  return {
    maxActionsPerPlan: 10,
    maxBudgetChangePct: 0.2,
    maxAccountBudgetIncreasePct: 0.1,
    maxBidChangePct: 0.2,
    cooldownHours: 24,
    maxSnapshotAgeHours: 48,
    approvalTtlMinutes: 30,
    autoApply: ['google_ads.campaign.pause'],
    denyKinds: [],
    killSwitch: false,
    ...overrides,
  };
}

function account(overrides: Partial<AccountConfig> = {}): AccountConfig {
  return {
    id: 'account-1',
    platform: 'google_ads',
    externalId: '123',
    ...overrides,
  };
}

function snapshot(total = 1_000, overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    id: 'snapshot-1',
    schemaVersion: 1,
    platform: 'google_ads',
    accountId: 'account-1',
    externalAccountId: '123',
    source: 'api',
    currency: 'USD',
    timezone: 'UTC',
    dateRange: { start: '2026-10-01', end: '2026-10-03' },
    createdAt: ago(1),
    datasets: {
      campaigns: [{ id: 'campaign-1', metrics: {}, attrs: { status: 'ENABLED', dailyBudget: total } }],
    },
    coverage: {},
    warnings: [],
    contentHash: 'snapshot-content-hash',
    ...overrides,
  };
}

function entry(item: Action = action(), overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    seq: 1,
    ts: ago(1),
    prevHash: 'previous-hash',
    hash: 'entry-hash',
    event: 'action.applied',
    actor: { kind: 'system', id: 'executor' },
    accountId: 'account-1',
    planId: 'plan_previous',
    executionId: 'exec_previous',
    actionId: item.id,
    data: {
      kind: item.kind,
      target: { ...item.target },
      before: item.before,
      after: item.after,
      spendEffect: item.spendEffect,
      spendDeltaPerDay: item.spendDeltaPerDay,
    },
    ...overrides,
  };
}

function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    plan: plan(),
    policy: policy(),
    account: account(),
    snapshot: snapshot(),
    ledger: [],
    autonomy: 'approve',
    killSwitch: false,
    now: new Date(NOW),
    ...overrides,
  };
}

function check(decision: PolicyDecision, ruleId: string, outcome: 'pass' | 'deny'): void {
  const results = decision.results.filter((result) => result.ruleId === ruleId);
  expect(results.length).toBeGreaterThan(0);
  expect(results.every((result) => result.outcome === outcome)).toBe(true);
  if (outcome === 'pass') expect(results).toHaveLength(1);
}

describe('evaluatePolicy', () => {
  it('passes every rule in order and binds the decision to the supplied policy, plan and time', () => {
    const request = input();
    const decision = evaluatePolicy(request);
    expect(decision).toMatchObject({
      allowed: true,
      autoApplicable: false,
      planDigest: request.plan.digest,
      policyDigest: digest(request.policy),
      evaluatedAt: NOW.toISOString(),
    });
    expect(decision.results.map((result) => result.ruleId)).toEqual(RULES);
    for (const rule of RULES) check(decision, rule, 'pass');
  });

  it('is deterministic and leaves its inputs unchanged', () => {
    const request = input({ ledger: [entry(action(), { ts: ago(25) })] });
    const original = structuredClone(request);
    expect(evaluatePolicy(request)).toEqual(evaluatePolicy(request));
    expect(request).toEqual(original);
  });

  it('denies the kill switch while still evaluating every other rule', () => {
    const decision = evaluatePolicy(input({ killSwitch: true }));
    expect(decision.allowed).toBe(false);
    check(decision, 'kill_switch', 'deny');
    expect(decision.results.map((result) => result.ruleId)).toEqual(RULES);
  });

  it.each<Autonomy>(['observe', 'propose'])('denies live changes at %s autonomy with remediation', (autonomy) => {
    const decision = evaluatePolicy(input({ autonomy }));
    check(decision, 'autonomy', 'deny');
    expect(decision.results.find((result) => result.ruleId === 'autonomy')?.message).toBe(
      'live changes are off at this autonomy level; set "autonomy" to "approve" in the config to allow approved plans',
    );
  });

  it('denies an empty plan', () => {
    check(evaluatePolicy(input({ plan: plan([]) })), 'empty_plan', 'deny');
  });

  it('allows exactly the action limit and denies more actions', () => {
    const first = action();
    const second = action({ id: 'act_second', target: { level: 'campaign', id: 'campaign-2' } });
    const allowed = input({ plan: plan([first]), policy: policy({ maxActionsPerPlan: 1 }) });
    check(evaluatePolicy(allowed), 'max_actions', 'pass');
    const decision = evaluatePolicy({ ...allowed, plan: plan([first, second]) });
    check(decision, 'max_actions', 'deny');
    expect(decision.results).toContainEqual(expect.objectContaining({
      ruleId: 'max_actions', observed: 2, limit: 1,
    }));
  });

  it('reports one denial for each denied action kind', () => {
    const actions = [action(), action({ id: 'act_second', target: { level: 'campaign', id: 'campaign-2' } })];
    const decision = evaluatePolicy(input({
      plan: plan(actions),
      policy: policy({ denyKinds: ['google_ads.campaign.pause'] }),
    }));
    expect(decision.results.filter((result) => result.ruleId === 'kind_denied')).toEqual([
      expect.objectContaining({ outcome: 'deny', actionId: 'act_current' }),
      expect.objectContaining({ outcome: 'deny', actionId: 'act_second' }),
    ]);
  });

  it.each([
    { pattern: 'campaign-1', target: { level: 'campaign' as const, id: 'campaign-1' } },
    { pattern: 'parent-1', target: { level: 'ad' as const, id: 'ad-1', campaignId: 'parent-1' } },
    { pattern: '*bRaNd*', target: { level: 'campaign' as const, id: 'campaign-1', name: 'US BRAND Search' } },
    { pattern: 'brand*search', target: { level: 'campaign' as const, id: 'campaign-1', name: 'Brand Search' } },
    { pattern: 'Brand.[US](1)+*', target: { level: 'campaign' as const, id: 'campaign-1', name: 'Brand.[US](1)+ Search' } },
  ])('protects exact ids, campaign ids and escaped name globs: $pattern', ({ pattern, target }) => {
    const decision = evaluatePolicy(input({
      account: account({ protected: [pattern] }),
      plan: plan([action({ target })]),
    }));
    check(decision, 'protected_entity', 'deny');
    expect(decision.results).toContainEqual(expect.objectContaining({
      ruleId: 'protected_entity', actionId: 'act_current',
    }));
  });

  it('anchors name globs and treats entity ids as case sensitive', () => {
    const decision = evaluatePolicy(input({
      account: account({ protected: ['brand', 'CAMPAIGN-1', 'Search.'] }),
      plan: plan([action({ target: { level: 'campaign', id: 'campaign-1', name: 'Nonbrand Search' } })]),
    }));
    check(decision, 'protected_entity', 'pass');
  });

  it('denies a nameless target when the protected list contains a glob', () => {
    const decision = evaluatePolicy(input({
      account: account({ protected: ['*brand*'] }),
      plan: plan([action({ target: { level: 'campaign', id: 'campaign-1' } })]),
    }));
    check(decision, 'protected_entity', 'deny');
    expect(decision.allowed).toBe(false);
    expect(decision.results).toContainEqual(expect.objectContaining({
      ruleId: 'protected_entity', actionId: 'act_current',
      message: expect.stringMatching(/could not be checked against the protected list.*fresh snapshot/i),
    }));
  });

  it.each(['ad_group', 'ad', 'keyword'] as const)(
    'denies a %s target with no campaign id when a campaign is protected',
    (level) => {
      const decision = evaluatePolicy(input({
        account: account({ protected: ['protected-campaign'] }),
        plan: plan([action({ target: { level, id: 'child-1', name: 'Child' } })]),
      }));
      check(decision, 'protected_entity', 'deny');
      expect(decision.allowed).toBe(false);
      expect(decision.results).toContainEqual(expect.objectContaining({
        ruleId: 'protected_entity', actionId: 'act_current',
        message: expect.stringMatching(/could not be checked against the protected list.*fresh snapshot/i),
      }));
    },
  );

  it('protects an ad group through a child target ancestry', () => {
    const decision = evaluatePolicy(input({
      account: account({ protected: ['protected-group'] }),
      plan: plan([action({ target: {
        level: 'ad', id: 'ad-1', campaignId: 'campaign-1', adGroupId: 'protected-group',
      } })]),
    }));
    check(decision, 'protected_entity', 'deny');
  });

  it.each(['Brand Search', 'another-campaign'])(
    'denies a nameless target when the protected list holds the exact entry %s',
    (pattern) => {
      const decision = evaluatePolicy(input({
        account: account({ protected: [pattern] }),
        plan: plan([action({ target: { level: 'campaign', id: 'campaign-1' } })]),
      }));
      check(decision, 'protected_entity', 'deny');
      expect(decision.allowed).toBe(false);
      expect(decision.results).toContainEqual(expect.objectContaining({
        ruleId: 'protected_entity', actionId: 'act_current',
        message: expect.stringMatching(/could not be checked against the protected list; create the plan from a fresh snapshot/i),
      }));
    },
  );

  it('matches an exact protected name case-insensitively and never as a substring', () => {
    const named = (name: string): PolicyDecision => evaluatePolicy(input({
      account: account({ protected: ['Brand Search'] }),
      plan: plan([action({ target: { level: 'campaign', id: 'campaign-1', name } })]),
    }));
    const decision = named('bRAND sEARCH');
    check(decision, 'protected_entity', 'deny');
    expect(decision.results).toContainEqual(expect.objectContaining({
      ruleId: 'protected_entity', message: 'The action targets a protected entity.',
    }));
    check(named('Brand Search US'), 'protected_entity', 'pass');
  });

  it('matches an account-level target by id only, while a nameless campaign stays denied', () => {
    const draft = (id: string): Action => action({
      kind: 'mautic.email.create_draft',
      platform: 'mautic',
      target: { level: 'account', id },
      before: {},
      after: { subject: 'Hello' },
      spendEffect: 'none',
      spendDeltaPerDay: 0,
    });
    const evaluate = (item: Action): PolicyDecision => evaluatePolicy(input({
      account: account({ protected: ['99'] }),
      plan: plan([item]),
    }));
    check(evaluate(draft('account-1')), 'protected_entity', 'pass');
    check(evaluate(action({ target: { level: 'campaign', id: 'campaign-1' } })), 'protected_entity', 'deny');
    const decision = evaluate(draft('99'));
    check(decision, 'protected_entity', 'deny');
    expect(decision.results).toContainEqual(expect.objectContaining({
      ruleId: 'protected_entity', actionId: 'act_current', message: 'The action targets a protected entity.',
    }));
  });

  it('denies a snapshot read from a different external account under the same local account id', () => {
    for (const source of ['api', 'demo'] as const) {
      const decision = evaluatePolicy(input({
        account: account({ source, externalId: '456' }),
        snapshot: snapshot(10_000, { source }),
        plan: plan([budget(100, 115)]),
      }));
      check(decision, 'snapshot_source', 'deny');
      expect(decision.allowed).toBe(false);
      expect(decision.results).toContainEqual(expect.objectContaining({
        ruleId: 'snapshot_source', observed: '123', limit: '456',
      }));
    }
  });

  it('requires ancestry only when there is a protected list', () => {
    const child = plan([action({ target: { level: 'ad', id: 'ad-1' } })]);
    for (const config of [account(), account({ protected: [] })]) {
      check(evaluatePolicy(input({ account: config, plan: child })), 'protected_entity', 'pass');
    }
    check(evaluatePolicy(input({
      account: account({ protected: ['*brand*', 'another-campaign'] }),
      plan: plan([action({ target: { level: 'ad', id: 'ad-1', name: 'Search', campaignId: 'campaign-1' } })]),
    })), 'protected_entity', 'pass');
  });

  it('denies overlapping writes to the same entity', () => {
    const decision = evaluatePolicy(input({ plan: plan([
      action(),
      action({ id: 'act_second', after: { status: 'ENABLED' } }),
    ]) }));
    check(decision, 'conflicting_actions', 'deny');
  });

  it('allows disjoint writes and the same id at different levels', () => {
    const decision = evaluatePolicy(input({ plan: plan([
      action(),
      action({ id: 'act_second', after: { label: 'reviewed' } }),
      action({ id: 'act_third', target: { level: 'ad', id: 'campaign-1' } }),
    ]) }));
    check(decision, 'conflicting_actions', 'pass');
  });

  it.each([
    { before: null },
    { preconditionHash: null },
  ])('denies an action missing its precondition: %j', (overrides) => {
    const decision = evaluatePolicy(input({ plan: plan([action(overrides)]) }));
    check(decision, 'missing_before', 'deny');
    expect(decision.results).toContainEqual(expect.objectContaining({
      ruleId: 'missing_before', actionId: 'act_current',
    }));
  });

  it('denies unknown spend effects', () => {
    const decision = evaluatePolicy(input({ plan: plan([action({ spendEffect: 'unknown' })]) }));
    check(decision, 'spend_unknown', 'deny');
  });

  it('collects separate violations instead of stopping at the first failure', () => {
    const decision = evaluatePolicy(input({
      killSwitch: true,
      autonomy: 'propose',
      policy: policy({ maxActionsPerPlan: 1, denyKinds: ['google_ads.campaign.pause'] }),
      account: account({ protected: ['campaign-1'] }),
      plan: plan([
        action({ before: null, preconditionHash: null, spendEffect: 'unknown' }),
        action({ id: 'act_second', before: null, spendEffect: 'unknown' }),
      ]),
    }));
    expect(decision.allowed).toBe(false);
    for (const rule of ['kill_switch', 'autonomy', 'max_actions', 'kind_denied', 'protected_entity',
      'conflicting_actions', 'missing_before', 'spend_unknown']) {
      check(decision, rule, 'deny');
    }
    expect(decision.results.filter((result) => result.ruleId === 'missing_before')).toHaveLength(2);
    expect(decision.results.filter((result) => result.ruleId === 'spend_unknown')).toHaveLength(2);
    expect([...new Set(decision.results.map((result) => result.ruleId))]).toEqual(RULES);
  });

  it('allows a snapshot at the age limit and denies one a millisecond older', () => {
    check(evaluatePolicy(input({ snapshot: snapshot(1_000, { createdAt: ago(48) }) })), 'snapshot_age', 'pass');
    const old = new Date(new Date(ago(48)).getTime() - 1).toISOString();
    check(evaluatePolicy(input({ snapshot: snapshot(1_000, { createdAt: old }) })), 'snapshot_age', 'deny');
  });

  it('denies a missing referenced snapshot but permits plans without a snapshot reference', () => {
    check(evaluatePolicy(input({ snapshot: null })), 'snapshot_age', 'deny');
    check(evaluatePolicy(input({ snapshot: null, plan: plan([action()], { snapshotId: null }) })), 'snapshot_age', 'pass');
  });

  it('denies an invalid snapshot timestamp', () => {
    check(evaluatePolicy(input({ snapshot: snapshot(1_000, { createdAt: 'invalid' }) })), 'snapshot_age', 'deny');
  });

  it.each(['api', undefined] as const)('denies CSV snapshots on an account with source %s', (source) => {
    const decision = evaluatePolicy(input({
      account: account(source === undefined ? {} : { source }),
      snapshot: snapshot(10_000, { source: 'csv' }),
      plan: plan([budget(100, 115)]),
    }));
    check(decision, 'account_budget_increase', 'pass');
    check(decision, 'snapshot_source', 'deny');
    expect(decision.allowed).toBe(false);
    expect(decision.results).toContainEqual(expect.objectContaining({
      ruleId: 'snapshot_source',
      message: 'Live changes need a snapshot read from the platform API; a CSV import can be audited but cannot back a change.',
    }));
  });

  it('denies a demo snapshot on an API account', () => {
    const decision = evaluatePolicy(input({
      account: account({ source: 'api' }), snapshot: snapshot(1_000, { source: 'demo' }),
    }));
    check(decision, 'snapshot_source', 'deny');
    expect(decision.allowed).toBe(false);
  });

  it.each(['csv', 'demo', 'api'] as const)('allows a %s snapshot for a demo account', (source) => {
    const decision = evaluatePolicy(input({
      account: account({ source: 'demo' }), snapshot: snapshot(1_000, { source }),
    }));
    check(decision, 'snapshot_source', 'pass');
    expect(decision.allowed).toBe(true);
  });

  it.each([
    { accountId: 'another-account' },
    { platform: 'meta_ads' as const },
  ])('denies a snapshot belonging to another account or platform: %j', (overrides) => {
    for (const source of ['api', 'demo'] as const) {
      const decision = evaluatePolicy(input({
        account: account({ source }), snapshot: snapshot(1_000, { ...overrides, source }),
      }));
      check(decision, 'snapshot_source', 'deny');
      expect(decision.allowed).toBe(false);
    }
  });

  it.each(['google_ads.campaign.set_daily_budget', 'meta_ads.campaign.set_daily_budget', 'meta_ads.adset.set_daily_budget'] as const)(
    'enforces exact micro boundaries for %s',
    (kind) => {
      check(evaluatePolicy(input({ plan: plan([budget(100, 120, { kind })]) })), 'budget_change', 'pass');
      const decision = evaluatePolicy(input({ plan: plan([budget(100, 120.000001, { kind })]) }));
      check(decision, 'budget_change', 'deny');
      expect(decision.results).toContainEqual(expect.objectContaining({
        ruleId: 'budget_change', actionId: 'act_current', observed: 0.20000001, limit: 0.2,
      }));
    },
  );

  it('bounds budget reductions as well as increases', () => {
    check(evaluatePolicy(input({ plan: plan([budget(100, 80)]) })), 'budget_change', 'pass');
    check(evaluatePolicy(input({ plan: plan([budget(100, 79.999999)]) })), 'budget_change', 'deny');
  });

  it('does not round a fractional-micro budget allowance upwards', () => {
    check(evaluatePolicy(input({ plan: plan([budget(0.000003, 0.000004)]) })), 'budget_change', 'deny');
  });

  it('preserves an exact decimal limit when floating-point multiplication would round down', () => {
    check(evaluatePolicy(input({
      policy: policy({ maxBudgetChangePct: 0.29 }),
      plan: plan([budget(0.0001, 0.000129)]),
    })), 'budget_change', 'pass');
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.0000001])(
    'denies a budget base that cannot be evaluated in micros: %s',
    (before) => {
      check(evaluatePolicy(input({ plan: plan([budget(before, 100)]) })), 'budget_change', 'deny');
    },
  );

  it.each([{}, { dailyBudget: '100' }, { dailyBudget: null }])('denies a missing or nonnumeric budget before: %j', (before) => {
    check(evaluatePolicy(input({ plan: plan([budget(100, 110, { before })]) })), 'budget_change', 'deny');
  });

  it.each([{}, { dailyBudget: '110' }, { dailyBudget: Number.NaN }, { dailyBudget: Number.POSITIVE_INFINITY }])(
    'denies an unevaluable budget after: %j',
    (after) => {
      check(evaluatePolicy(input({ plan: plan([budget(100, 110, { after })]) })), 'budget_change', 'deny');
    },
  );

  it('uses the oldest effective budget before to bound cumulative changes across plans', () => {
    const first = budget(100, 115);
    const second = budget(115, 132);
    check(evaluatePolicy(input({ plan: plan([first]) })), 'budget_change', 'pass');
    check(evaluatePolicy(input({ plan: plan([second]) })), 'budget_change', 'pass');
    const decision = evaluatePolicy(input({ plan: plan([second]), ledger: [entry(first)] }));
    check(decision, 'budget_change', 'deny');
    expect(decision.results).toContainEqual(expect.objectContaining({
      ruleId: 'budget_change', observed: 0.32, limit: 0.2,
    }));
  });

  it('selects the oldest matching budget history regardless of input ordering', () => {
    const oldest = entry(budget(100, 110), { seq: 1, ts: ago(3), actionId: 'act_oldest' });
    const newer = entry(budget(110, 120), { seq: 2, ts: ago(2), actionId: 'act_newer' });
    const unrelated = entry(budget(1, 2), {
      seq: 3,
      data: { ...oldest.data, kind: 'meta_ads.campaign.set_daily_budget', before: { dailyBudget: 1 } },
    });
    const decision = evaluatePolicy(input({
      plan: plan([budget(120, 125)]),
      ledger: [newer, unrelated, oldest],
    }));
    check(decision, 'budget_change', 'deny');
    expect(decision.results).toContainEqual(expect.objectContaining({ ruleId: 'budget_change', observed: 0.25 }));
  });

  it('ignores budget history outside the cooldown window', () => {
    check(evaluatePolicy(input({
      plan: plan([budget(115, 132)]),
      ledger: [entry(budget(100, 115), { ts: ago(25) })],
    })), 'budget_change', 'pass');
  });

  it('denies unidentified historical budget changes even when reverting their plan', () => {
    const historical = entry(budget(200, 110));
    const decision = evaluatePolicy(input({
      plan: plan([budget(110, 100)], { revertsPlanId: 'plan_previous' }),
      ledger: [{ ...historical, data: { ...historical.data, kind: null } }],
    }));
    check(decision, 'cooldown', 'pass');
    check(decision, 'budget_change', 'deny');
    expect(decision.allowed).toBe(false);
  });

  it('retains an earlier applied baseline when a later reconciliation confirms it', () => {
    const first = entry(budget(100, 110), { seq: 1, ts: ago(8), executionId: 'exec_first' });
    const second = entry(budget(110, 115), { seq: 2, ts: ago(6), executionId: 'exec_second' });
    const reconciled = entry(budget(100, 110), {
      seq: 3, ts: ago(3), executionId: 'exec_first', event: 'action.reconciled',
      data: { ...first.data, outcome: 'applied' },
    });
    const decision = evaluatePolicy(input({
      plan: plan([budget(115, 125)]), ledger: [reconciled, second, first],
    }));
    check(decision, 'budget_change', 'deny');
    expect(decision.results).toContainEqual(expect.objectContaining({ ruleId: 'budget_change', observed: 0.25 }));
  });

  it('enforces bid changes at the exact limit and one micro beyond', () => {
    check(evaluatePolicy(input({ plan: plan([bid(10, 12)]) })), 'bid_change', 'pass');
    const decision = evaluatePolicy(input({ plan: plan([bid(10, 12.000001)]) }));
    check(decision, 'bid_change', 'deny');
    expect(decision.results).toContainEqual(expect.objectContaining({
      ruleId: 'bid_change', actionId: 'act_current', observed: 0.2000001, limit: 0.2,
    }));
    check(evaluatePolicy(input({ plan: plan([bid(10, 7)]) })), 'bid_change', 'deny');
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('denies invalid bid bases: %s', (before) => {
    check(evaluatePolicy(input({ plan: plan([bid(before, 10)]) })), 'bid_change', 'deny');
  });

  it('denies missing bid amounts and cumulative changes across plans', () => {
    check(evaluatePolicy(input({ plan: plan([bid(10, 11, { before: {} })]) })), 'bid_change', 'deny');
    check(evaluatePolicy(input({ plan: plan([bid(10, 11, { after: {} })]) })), 'bid_change', 'deny');
    const second = bid(11, 12.1);
    check(evaluatePolicy(input({ plan: plan([second]) })), 'bid_change', 'pass');
    check(evaluatePolicy(input({ plan: plan([second]), ledger: [entry(bid(10, 11))] })), 'bid_change', 'deny');
  });

  it('bounds account increases at the exact limit and one micro beyond', () => {
    check(evaluatePolicy(input({ snapshot: snapshot(100), plan: plan([budget(100, 110)]) })), 'account_budget_increase', 'pass');
    const decision = evaluatePolicy(input({ snapshot: snapshot(100), plan: plan([budget(100, 110.000001)]) }));
    check(decision, 'account_budget_increase', 'deny');
  });

  it('does not let plan or ledger reductions finance gross increases', () => {
    const reduction = budget(100, 80, { id: 'act_reduction', target: { level: 'campaign', id: 'campaign-2' } });
    const request = input({ snapshot: snapshot(100), plan: plan([budget(100, 111), reduction]) });
    check(evaluatePolicy(request), 'account_budget_increase', 'deny');
    check(evaluatePolicy({ ...request, plan: plan([budget(100, 111)]), ledger: [entry(reduction)] }), 'account_budget_increase', 'deny');
  });

  it('adds enabled campaign budgets and excludes paused or removed budgets', () => {
    const data = snapshot(100, { datasets: { campaigns: [
      { id: 'one', metrics: {}, attrs: { status: 'ENABLED', dailyBudget: 50 } },
      { id: 'two', metrics: {}, attrs: { status: 'ENABLED', dailyBudget: 50 } },
      { id: 'paused', metrics: {}, attrs: { status: 'PAUSED', dailyBudget: 10_000 } },
      { id: 'removed', metrics: {}, attrs: { status: 'REMOVED', dailyBudget: 10_000 } },
    ] } });
    check(evaluatePolicy(input({ snapshot: data, plan: plan([budget(100, 110)]) })), 'account_budget_increase', 'pass');
    check(evaluatePolicy(input({ snapshot: data, plan: plan([budget(100, 111)]) })), 'account_budget_increase', 'deny');
  });

  it.each([true, false])('counts a budget id once even when sharedBudget is %s', (sharedBudget) => {
    const data = snapshot(100, { datasets: { campaigns: [
      { id: 'one', metrics: {}, attrs: { status: 'ENABLED', dailyBudget: 100, budgetId: 'budgets/shared', sharedBudget } },
      { id: 'two', metrics: {}, attrs: { status: 'ENABLED', dailyBudget: 100, budgetId: 'budgets/shared', sharedBudget } },
    ] } });
    const decision = evaluatePolicy(input({ snapshot: data, plan: plan([budget(100, 115)]) }));
    check(decision, 'account_budget_increase', 'deny');
    expect(decision.allowed).toBe(false);
    expect(decision.results).toContainEqual(expect.objectContaining({
      ruleId: 'account_budget_increase', observed: 15, limit: 10,
    }));
    check(evaluatePolicy(input({ snapshot: data, plan: plan([budget(100, 110)]) })), 'account_budget_increase', 'pass');
    check(evaluatePolicy(input({ snapshot: data, plan: plan([budget(100, 110.000001)]) })), 'account_budget_increase', 'deny');
  });

  it('counts distinct and unidentified nonshared budgets independently', () => {
    const data = snapshot(100, { datasets: { campaigns: [
      { id: 'one', metrics: {}, attrs: { status: 'ENABLED', dailyBudget: 40, budgetId: 'budgets/one' } },
      { id: 'two', metrics: {}, attrs: { status: 'ENABLED', dailyBudget: 40, budgetId: 'budgets/two' } },
      { id: 'budgets/one', metrics: {}, attrs: { status: 'ENABLED', dailyBudget: 10 } },
      { id: 'unidentified', metrics: {}, attrs: { status: 'ENABLED', dailyBudget: 10, sharedBudget: false } },
      { id: 'paused', metrics: {}, attrs: { status: 'PAUSED', dailyBudget: 10_000, sharedBudget: true } },
    ] } });
    check(evaluatePolicy(input({ snapshot: data, plan: plan([budget(100, 110)]) })), 'account_budget_increase', 'pass');
    check(evaluatePolicy(input({ snapshot: data, plan: plan([budget(100, 110.000001)]) })), 'account_budget_increase', 'deny');
  });

  it.each([undefined, null, '', 123])('denies an increase when a shared budget has no usable id: %s', (budgetId) => {
    const data = snapshot(100, { datasets: { campaigns: [{
      id: 'shared', metrics: {},
      attrs: {
        status: 'ENABLED', dailyBudget: 100, sharedBudget: true,
        ...(budgetId === undefined ? {} : { budgetId }),
      },
    }] } });
    const decision = evaluatePolicy(input({ snapshot: data, plan: plan([budget(100, 105)]) }));
    check(decision, 'account_budget_increase', 'deny');
    expect(decision.allowed).toBe(false);
    expect(decision.results).toContainEqual(expect.objectContaining({
      ruleId: 'account_budget_increase', message: expect.stringMatching(/shared budgets could not be de-duplicated/i),
    }));
    check(evaluatePolicy(input({ snapshot: data, plan: plan([budget(100, 95)]) })), 'account_budget_increase', 'pass');
  });

  it.each([
    null,
    snapshot(100, { datasets: {} }),
    snapshot(0),
    snapshot(100, { datasets: { campaigns: [] } }),
    snapshot(100, { datasets: { campaigns: [{ id: 'one', metrics: {}, attrs: { status: 'ENABLED' } }] } }),
    snapshot(Number.NaN),
    snapshot(Number.POSITIVE_INFINITY),
  ])('fails closed when an increase has no evaluable account budget (%#)', (data) => {
    check(evaluatePolicy(input({ snapshot: data, plan: plan([budget(100, 110)]) })), 'account_budget_increase', 'deny');
  });

  it('passes account increases when the plan has none even without snapshot data', () => {
    check(evaluatePolicy(input({ snapshot: null })), 'account_budget_increase', 'pass');
  });

  it('counts ledger increases over 24 hours independently of cooldown', () => {
    const historical = entry(budget(100, 108, { target: { level: 'campaign', id: 'another' } }), { ts: ago(23) });
    const request = input({
      plan: plan([budget(100, 103)]), snapshot: snapshot(100),
      policy: policy({ cooldownHours: 1 }), ledger: [historical],
    });
    check(evaluatePolicy(request), 'account_budget_increase', 'deny');
    check(evaluatePolicy({ ...request, ledger: [{ ...historical, ts: ago(25) }] }), 'account_budget_increase', 'pass');
  });

  it('counts an intent without a result as both cooldown and reserved spend', () => {
    const decision = evaluatePolicy(input({
      snapshot: snapshot(100),
      plan: plan([budget(110, 115)]),
      ledger: [entry(budget(100, 110), { event: 'action.intent' })],
    }));
    check(decision, 'cooldown', 'deny');
    check(decision, 'account_budget_increase', 'deny');
  });

  it.each(['action.failed', 'action.skipped', 'action.reconciled'] as const)(
    'releases an intent after %s with a definitive not-applied result',
    (event) => {
      const intent = entry(budget(100, 110), { event: 'action.intent' });
      const result = entry(budget(100, 110), {
        seq: 2, event, data: { ...intent.data, outcome: 'not_applied' },
      });
      const decision = evaluatePolicy(input({
        snapshot: snapshot(100), plan: plan([budget(100, 105)]), ledger: [result, intent],
      }));
      check(decision, 'cooldown', 'pass');
      check(decision, 'account_budget_increase', 'pass');
      expect(decision.allowed).toBe(true);
    },
  );

  it.each(['action.unknown', 'action.reconciled'] as const)('keeps ambiguous %s operations reserved exactly once', (event) => {
    const intent = entry(budget(100, 106), { event: 'action.intent' });
    const result = entry(budget(100, 106), { seq: 2, event, data: { ...intent.data, outcome: 'conflict' } });
    const request = input({ snapshot: snapshot(100), plan: plan([budget(106, 110)]), ledger: [intent, result] });
    check(evaluatePolicy(request), 'cooldown', 'deny');
    check(evaluatePolicy(request), 'account_budget_increase', 'pass');
    check(evaluatePolicy({ ...request, plan: plan([budget(106, 111)]) }), 'account_budget_increase', 'deny');
  });

  it.each(['action.applied', 'action.reconciled'] as const)('counts a resolved %s action once, not once per ledger event', (event) => {
    const intent = entry(budget(100, 106), { event: 'action.intent' });
    const result = entry(budget(100, 106), { seq: 2, event, data: { ...intent.data, outcome: 'applied' } });
    const decision = evaluatePolicy(input({
      snapshot: snapshot(100), plan: plan([budget(106, 110)]), ledger: [result, intent],
    }));
    check(decision, 'account_budget_increase', 'pass');
    check(decision, 'cooldown', 'deny');
  });

  it('only resolves intents with a later matching execution and action', () => {
    const intent = entry(budget(100, 110), { seq: 2, event: 'action.intent' });
    const failed = entry(budget(100, 110), { seq: 1, event: 'action.failed' });
    for (const result of [failed, { ...failed, seq: 3, executionId: 'exec_other' }, { ...failed, seq: 3, actionId: 'act_other' }]) {
      check(evaluatePolicy(input({ ledger: [intent, result] })), 'cooldown', 'deny');
    }
  });

  it('keeps a confirmed application effective despite a later failure record', () => {
    const applied = entry(budget(100, 110));
    const failed = entry(budget(100, 110), { seq: 2, event: 'action.failed' });
    const decision = evaluatePolicy(input({
      snapshot: snapshot(100), plan: plan([budget(110, 115)]), ledger: [applied, failed],
    }));
    check(decision, 'cooldown', 'deny');
    check(decision, 'account_budget_increase', 'deny');
  });

  it('does not reserve a resolved intent again when an unknown record follows its result', () => {
    const intent = entry(budget(100, 110), { event: 'action.intent' });
    const failed = entry(budget(100, 110), { seq: 2, event: 'action.failed' });
    const unknown = entry(budget(100, 110), { seq: 3, event: 'action.unknown' });
    const decision = evaluatePolicy(input({
      snapshot: snapshot(100), plan: plan([budget(100, 105)]), ledger: [unknown, failed, intent],
    }));
    check(decision, 'cooldown', 'pass');
    check(decision, 'account_budget_increase', 'pass');
  });

  it('ignores ledger operations explicitly belonging to another account', () => {
    const decision = evaluatePolicy(input({
      snapshot: snapshot(100), plan: plan([budget(100, 105)]),
      ledger: [entry(budget(1, 100), { accountId: 'account-2' })],
    }));
    expect(decision.allowed).toBe(true);
  });

  it('accepts scoped ledger operations with no optional account id', () => {
    const historical = entry(budget(100, 110));
    delete historical.accountId;
    const decision = evaluatePolicy(input({ snapshot: snapshot(100), plan: plan([budget(110, 115)]), ledger: [historical] }));
    check(decision, 'account_budget_increase', 'deny');
    check(decision, 'cooldown', 'deny');
  });

  it('enforces cooldown for a target and allows expired or different-level targets', () => {
    const recent = entry();
    check(evaluatePolicy(input({ ledger: [recent] })), 'cooldown', 'deny');
    check(evaluatePolicy(input({ ledger: [{ ...recent, ts: ago(25) }] })), 'cooldown', 'pass');
    check(evaluatePolicy(input({ ledger: [entry(action({ target: { level: 'ad', id: 'campaign-1' } }))] })), 'cooldown', 'pass');
  });

  it('exempts a revert from cooldown only for the plan it reverts', () => {
    const request = input({ plan: plan([action()], { revertsPlanId: 'plan_previous' }), ledger: [entry()] });
    check(evaluatePolicy(request), 'cooldown', 'pass');
    check(evaluatePolicy({ ...request, ledger: [entry(action(), { planId: 'plan_other' })] }), 'cooldown', 'deny');
    check(evaluatePolicy({ ...request, ledger: [entry(), entry(action(), { seq: 2, planId: 'plan_other' })] }), 'cooldown', 'deny');
  });

  it('denies future-dated ledger entries beyond five minutes and excludes their financial effects', () => {
    const future = new Date(NOW.getTime() + 300_001).toISOString();
    const decision = evaluatePolicy(input({
      snapshot: snapshot(100), plan: plan([budget(100, 105)]),
      ledger: [entry(budget(100, 110), { ts: future })],
    }));
    check(decision, 'clock', 'deny');
    check(decision, 'cooldown', 'pass');
    check(decision, 'account_budget_increase', 'pass');
    expect(decision.allowed).toBe(false);
  });

  it('includes clock-skewed ledger entries at the five-minute tolerance conservatively', () => {
    const decision = evaluatePolicy(input({ ledger: [entry(action(), { ts: ago(-5 / 60) })] }));
    check(decision, 'clock', 'pass');
    check(decision, 'cooldown', 'deny');
  });

  it('denies malformed ledger timestamps without throwing', () => {
    const decision = evaluatePolicy(input({ ledger: [entry(action(), { ts: 'invalid' })] }));
    check(decision, 'clock', 'deny');
    expect(decision.allowed).toBe(false);
  });

  it('fails closed without throwing when now is an invalid Date', () => {
    const request = input({ now: new Date(Number.NaN) });
    const decision = evaluatePolicy(request);
    check(decision, 'clock', 'deny');
    expect(decision.allowed).toBe(false);
    expect(evaluatePolicy(request)).toEqual(decision);
  });

  it.each([
    { key: 'maxActionsPerPlan' as const, rule: 'max_actions' },
    { key: 'maxSnapshotAgeHours' as const, rule: 'snapshot_age' },
    { key: 'maxBudgetChangePct' as const, rule: 'budget_change' },
    { key: 'maxBidChangePct' as const, rule: 'bid_change' },
    { key: 'maxAccountBudgetIncreasePct' as const, rule: 'account_budget_increase' },
    { key: 'cooldownHours' as const, rule: 'cooldown' },
  ])('fails closed when $key is nonfinite', ({ key, rule }) => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const decision = evaluatePolicy(input({
        policy: policy({ [key]: value }),
        plan: plan([budget(), bid()]),
      }));
      check(decision, rule, 'deny');
      expect(decision.allowed).toBe(false);
    }
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, null])('denies unbounded positive spend deltas: %s', (spendDeltaPerDay) => {
    check(evaluatePolicy(input({
      plan: plan([budget(100, 110, { spendDeltaPerDay })]),
    })), 'account_budget_increase', 'deny');
  });

  it.each<{
    name: string;
    autonomy: Autonomy;
    effect: Action['spendEffect'];
    reversible: Action['reversible'];
    listed: boolean;
    killSwitch: boolean;
    expected: boolean;
  }>([
    { name: 'autopilot reversible decrease', autonomy: 'autopilot', effect: 'decrease', reversible: 'exact', listed: true, killSwitch: false, expected: true },
    { name: 'autopilot compensating no-spend', autonomy: 'autopilot', effect: 'none', reversible: 'compensating', listed: true, killSwitch: false, expected: true },
    { name: 'approve', autonomy: 'approve', effect: 'decrease', reversible: 'exact', listed: true, killSwitch: false, expected: false },
    { name: 'observe', autonomy: 'observe', effect: 'decrease', reversible: 'exact', listed: true, killSwitch: false, expected: false },
    { name: 'propose', autonomy: 'propose', effect: 'decrease', reversible: 'exact', listed: true, killSwitch: false, expected: false },
    { name: 'increased spend', autonomy: 'autopilot', effect: 'increase', reversible: 'exact', listed: true, killSwitch: false, expected: false },
    { name: 'unknown spend', autonomy: 'autopilot', effect: 'unknown', reversible: 'exact', listed: true, killSwitch: false, expected: false },
    { name: 'irreversible', autonomy: 'autopilot', effect: 'decrease', reversible: 'none', listed: true, killSwitch: false, expected: false },
    { name: 'unlisted kind', autonomy: 'autopilot', effect: 'decrease', reversible: 'exact', listed: false, killSwitch: false, expected: false },
    { name: 'denied plan', autonomy: 'autopilot', effect: 'decrease', reversible: 'exact', listed: true, killSwitch: true, expected: false },
  ])('autoApplicable truth table: $name', ({ autonomy, effect, reversible, listed, killSwitch, expected }) => {
    const decision = evaluatePolicy(input({
      autonomy, killSwitch,
      policy: policy({ autoApply: listed ? ['google_ads.campaign.pause'] : [] }),
      plan: plan([action({ spendEffect: effect, spendDeltaPerDay: effect === 'increase' ? 1 : 0, reversible })]),
    }));
    expect(decision.autoApplicable).toBe(expected);
  });

  it('requires every action to meet auto-apply conditions', () => {
    const second = action({ id: 'act_second', target: { level: 'campaign', id: 'campaign-2' } });
    const request = input({ autonomy: 'autopilot', plan: plan([action(), second]) });
    expect(evaluatePolicy(request).autoApplicable).toBe(true);
    for (const overrides of [
      { kind: 'google_ads.campaign.enable' as const },
      { reversible: 'none' as const },
      { spendEffect: 'increase' as const, spendDeltaPerDay: 1 },
    ]) {
      expect(evaluatePolicy({ ...request, plan: plan([action(), { ...second, ...overrides }]) }).autoApplicable).toBe(false);
    }
  });
});
