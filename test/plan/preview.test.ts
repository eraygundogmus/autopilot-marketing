import { describe, expect, it, vi } from 'vitest';
import { defaultConfig, findAccount } from '../../src/core/config';
import { openDatabase } from '../../src/core/db';
import { AutopilotError } from '../../src/core/errors';
import { canonicalJson, sha256 } from '../../src/core/ids';
import { createStore } from '../../src/core/store';
import type {
  Action, ActionKind, ApprovalReceipt, ApprovalService, AuditReport, Autonomy, Finding, GateDecision,
  Judge, Paths, Plan, Runtime,
} from '../../src/core/types';
import { buildAction, planDigest } from '../../src/plan/actions';
import { createLedger } from '../../src/plan/ledger';
import { previewPlan } from '../../src/plan/preview';

const NOW = new Date('2026-10-04T12:00:00.000Z');
const ACCOUNT = 'demo-google';
const PAUSE: ActionKind = 'google_ads.campaign.pause';
const BUDGET: ActionKind = 'google_ads.campaign.set_daily_budget';
const PATHS: Paths = {
  home: '/nonexistent/apm',
  config: '/nonexistent/apm/config.json',
  envFile: '/nonexistent/apm/.env',
  db: ':memory:',
  brief: '/nonexistent/apm/brief.md',
  approvalKey: '/nonexistent/apm/approval.key',
  killFile: '/nonexistent/apm/KILL',
  credentials: '/nonexistent/apm/credentials.json',
};

function pause(findingIds?: string[]): Action {
  return buildAction(
    {
      kind: PAUSE,
      target: { level: 'campaign', id: 'c1', name: 'Generic search' },
      params: {},
      rationale: 'Spend without conversions over the last thirty days.',
      ...(findingIds === undefined ? {} : { findingIds }),
    },
    { status: 'ENABLED' },
  );
}

function budget(from: number, to: number): Action {
  return buildAction(
    {
      kind: BUDGET,
      target: { level: 'campaign', id: 'c2', name: 'Brand search' },
      params: { dailyBudget: to },
      rationale: 'Adjust the daily budget to match measured demand.',
    },
    { dailyBudget: from },
  );
}

function makePlan(actions: Action[], extra: Partial<Plan> = {}): Plan {
  return {
    id: 'plan_0123456789abcdef',
    schemaVersion: 1,
    createdAt: NOW.toISOString(),
    createdBy: 'agent',
    accountId: ACCOUNT,
    platform: 'google_ads',
    snapshotId: null,
    title: 'Trim wasted spend',
    rationale: 'Two campaigns spend without converting.',
    actions,
    digest: planDigest({ accountId: ACCOUNT, platform: 'google_ads', actions }),
    status: 'proposed',
    ...extra,
  };
}

function decision(plan: Plan, overrides: Partial<GateDecision> = {}, confidence = 0.99): GateDecision {
  return {
    planDigest: plan.digest,
    mode: 'jev',
    verdict: 'allow',
    actions: plan.actions.map((action) => ({ actionId: action.id, verdict: 'allow', confidence, band: 'act' })),
    evaluatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function notUsed(): never {
  throw new Error('not used in this test');
}

interface Setup {
  runtime: Runtime;
  gatePlan: ReturnType<typeof vi.fn<Judge['gatePlan']>>;
  verify: ReturnType<typeof vi.fn<ApprovalService['verify']>>;
}

function setup(options: {
  plan: Plan;
  autonomy: Autonomy;
  autoApply?: ActionKind[];
  gate?: GateDecision | Error;
  receipt?: ApprovalReceipt;
}): Setup {
  const db = openDatabase(PATHS);
  const store = createStore(db);
  const ledger = createLedger(db, () => NOW);
  const config = { ...defaultConfig(), autonomy: options.autonomy };
  config.policy = { ...config.policy, autoApply: options.autoApply ?? [] };
  store.savePlan(options.plan);

  const gatePlan = vi.fn<Judge['gatePlan']>(async () => {
    const gate = options.gate ?? decision(options.plan);
    if (gate instanceof Error) throw gate;
    return gate;
  });
  const verify = vi.fn<ApprovalService['verify']>(() => {
    if (options.receipt) return options.receipt;
    throw new AutopilotError('approval_required', 'No approval for this plan.');
  });
  const judge: Judge = {
    mode: 'jev',
    usage: notUsed,
    classifyTerms: notUsed,
    verifyClaims: notUsed,
    reviewCopy: notUsed,
    gatePlan,
  };
  const runtime: Runtime = {
    config,
    env: {},
    paths: PATHS,
    store,
    ledger,
    approvals: { issue: notUsed, verify, claim: notUsed },
    judge,
    autonomy: options.autonomy,
    now: () => NOW,
    account: (id) => findAccount(config, id),
    connector: notUsed,
    killSwitch: () => false,
    jobs: undefined as unknown as Runtime['jobs'],
    credentials: { store: 'none', fromStore: [], unreadable: [] },
  };
  return { runtime, gatePlan, verify };
}

describe('previewPlan', () => {
  it('does not ask the gate about a plan the policy denies', async () => {
    const plan = makePlan([pause()]);
    const { runtime, gatePlan } = setup({ plan, autonomy: 'propose' });
    const preview = await previewPlan(plan.id, runtime);

    expect(preview.policy.allowed).toBe(false);
    expect(preview.gate).toBeNull();
    expect(gatePlan).not.toHaveBeenCalled();
    expect(preview.approval.required).toBe(false);
    expect(preview.approval.satisfiedBy).toBeNull();
    // The hint names the reason itself: it is shown in places that do not print the full review.
    expect(preview.approval.hint).toMatch(/^The policy denies this plan, so it cannot be applied: .*autonomy/);
    expect(preview.review).toContain('Policy: deny');
  });

  it('requires a person for an allowed plan without a receipt', async () => {
    const plan = makePlan([pause(), budget(100, 90)]);
    const { runtime, gatePlan, verify } = setup({ plan, autonomy: 'approve' });
    const preview = await previewPlan(plan.id, runtime);

    expect(preview.policy.allowed).toBe(true);
    expect(gatePlan).toHaveBeenCalledTimes(1);
    expect(preview.gate?.verdict).toBe('allow');
    expect(preview.approval.required).toBe(true);
    expect(preview.approval.satisfiedBy).toBeNull();
    expect(preview.approval.hint).toContain(`autopilot-marketing approve ${plan.id}`);
    expect(preview.approval.hint).toContain(`autopilot-marketing review ${plan.id}`);
    expect(verify).toHaveBeenCalledWith({ plan, policyDigest: preview.policy.policyDigest, now: NOW });
  });

  it('keeps going with a null gate when the judge throws', async () => {
    const plan = makePlan([pause()]);
    const { runtime } = setup({ plan, autonomy: 'approve', gate: new Error('judge down') });
    const preview = await previewPlan(plan.id, runtime);

    expect(preview.gate).toBeNull();
    expect(preview.approval.required).toBe(true);
    expect(runtime.ledger.read({ planId: plan.id })[0]?.data?.gate).toBeNull();
  });

  it('accepts a valid receipt as approval', async () => {
    const plan = makePlan([pause()]);
    const receipt: ApprovalReceipt = {
      id: 'apr_0123456789abcdef',
      planId: plan.id,
      planDigest: plan.digest,
      policyDigest: 'p',
      method: 'tty',
      reviewDigest: 'r',
      approver: 'tester',
      createdAt: NOW.toISOString(),
      expiresAt: '2026-10-04T12:30:00.000Z',
      signature: 's',
    };
    const { runtime } = setup({ plan, autonomy: 'approve', receipt });
    const preview = await previewPlan(plan.id, runtime);

    expect(preview.approval).toEqual({
      required: false,
      satisfiedBy: 'tty',
      hint: 'Approved; valid until 2026-10-04T12:30:00.000Z.',
    });
  });

  describe('auto-apply', () => {
    const plan = makePlan([pause()]);
    const auto = { required: false, satisfiedBy: 'policy', hint: 'Within the auto-apply policy: plan_apply with dryRun false will run it.' };

    it('is granted under autopilot with the kind listed and a confident jev allow', async () => {
      const { runtime } = setup({ plan, autonomy: 'autopilot', autoApply: [PAUSE] });
      expect((await previewPlan(plan.id, runtime)).approval).toEqual(auto);
    });

    it('is refused when the gate ran in fallback mode', async () => {
      const { runtime } = setup({
        plan, autonomy: 'autopilot', autoApply: [PAUSE], gate: decision(plan, { mode: 'fallback' }),
      });
      expect((await previewPlan(plan.id, runtime)).approval.required).toBe(true);
    });

    it('is refused below the gate threshold', async () => {
      const { runtime } = setup({ plan, autonomy: 'autopilot', autoApply: [PAUSE], gate: decision(plan, {}, 0) });
      expect((await previewPlan(plan.id, runtime)).approval.required).toBe(true);
    });

    it('is refused when the gate does not allow', async () => {
      const { runtime } = setup({
        plan, autonomy: 'autopilot', autoApply: [PAUSE], gate: decision(plan, { verdict: 'abstain' }),
      });
      expect((await previewPlan(plan.id, runtime)).approval.required).toBe(true);
    });

    it('is refused when the kind is not listed or autonomy is approve', async () => {
      const unlisted = setup({ plan, autonomy: 'autopilot' });
      expect((await previewPlan(plan.id, unlisted.runtime)).approval.required).toBe(true);
      const approve = setup({ plan, autonomy: 'approve', autoApply: [PAUSE] });
      expect((await previewPlan(plan.id, approve.runtime)).approval.required).toBe(true);
    });
  });

  it('passes the gate only the findings the actions cite', async () => {
    const plan = makePlan([pause(['fnd_cited'])], { auditId: 'aud_0123456789abcdef' });
    const { runtime, gatePlan } = setup({ plan, autonomy: 'approve' });
    const findings = [{ id: 'fnd_cited' }, { id: 'fnd_other' }] as Finding[];
    runtime.store.saveAudit({
      id: 'aud_0123456789abcdef',
      accountId: ACCOUNT,
      snapshotId: 'snap_0123456789abcdef',
      createdAt: NOW.toISOString(),
      findings,
    } as AuditReport);
    await previewPlan(plan.id, runtime);

    expect(gatePlan.mock.calls[0]?.[0].findings.map((finding) => finding.id)).toEqual(['fnd_cited']);
    expect(gatePlan.mock.calls[0]?.[0].policy).toBe(runtime.config.policy);
  });

  it('passes no findings when the audit is gone', async () => {
    const plan = makePlan([pause(['fnd_cited'])], { auditId: 'aud_ffffffffffffffff' });
    const { runtime, gatePlan } = setup({ plan, autonomy: 'approve' });
    await previewPlan(plan.id, runtime);

    expect(gatePlan.mock.calls[0]?.[0].findings).toEqual([]);
  });

  it('treats a missing snapshot as null and lets the policy deny it', async () => {
    const plan = makePlan([pause()], { snapshotId: 'snap_ffffffffffffffff' });
    const { runtime } = setup({ plan, autonomy: 'approve' });
    const preview = await previewPlan(plan.id, runtime);

    expect(preview.policy.allowed).toBe(false);
    expect(preview.gate).toBeNull();
  });

  it('sums the totals', async () => {
    const actions: Action[] = [
      { ...pause(), spendEffect: 'decrease', spendDeltaPerDay: -10.004, reversible: 'none' },
      { ...budget(100, 110.1), spendEffect: 'increase', spendDeltaPerDay: 10.1 },
      { ...budget(50, 50), id: 'act_null', spendEffect: 'none', spendDeltaPerDay: null },
    ];
    const plan = makePlan(actions);
    const { runtime } = setup({ plan, autonomy: 'propose' });

    expect((await previewPlan(plan.id, runtime)).totals).toEqual({
      actions: 3,
      spendDeltaPerDay: 0.1,
      increases: 1,
      irreversible: 1,
    });
  });

  it('renders every before and after value and binds the digest to the text', async () => {
    const plan = makePlan([pause(), budget(100, 90)]);
    const { runtime } = setup({ plan, autonomy: 'approve' });
    const preview = await previewPlan(plan.id, runtime);

    for (const action of plan.actions) {
      expect(preview.review).toContain(`before: ${canonicalJson(action.before)}`);
      expect(preview.review).toContain(`after: ${canonicalJson(action.after)}`);
    }
    expect(preview.review).toContain('Currency: USD');
    expect(preview.reviewDigest).toBe(sha256(preview.review));
    expect(preview.plan).toEqual(plan);
  });

  it('appends plan.previewed to the ledger', async () => {
    const plan = makePlan([pause()]);
    const { runtime } = setup({ plan, autonomy: 'approve' });
    const preview = await previewPlan(plan.id, runtime);
    const entries = runtime.ledger.read({ planId: plan.id });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      event: 'plan.previewed',
      actor: { kind: 'system', id: 'autopilot' },
      accountId: ACCOUNT,
      planId: plan.id,
      data: { planDigest: plan.digest, allowed: true, gate: 'allow', reviewDigest: preview.reviewDigest },
    });
    expect(runtime.ledger.verify().ok).toBe(true);
  });

  it('throws not_found for an unknown plan', async () => {
    const plan = makePlan([pause()]);
    const { runtime } = setup({ plan, autonomy: 'approve' });

    await expect(previewPlan('plan_ffffffffffffffff', runtime)).rejects.toMatchObject({ code: 'not_found' });
  });
});
