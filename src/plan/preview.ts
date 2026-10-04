import { AutopilotError } from '../core/errors';
import { sha256 } from '../core/ids';
import type {
  ApprovalReceipt, Finding, GateDecision, Plan, PlanPreview, PolicyDecision, Runtime, Snapshot,
} from '../core/types';
import { withJudgmentUsage } from '../judgment/usage';
import { renderPlanPreview } from '../report/render';
import { evaluatePolicy } from './policy';

/** Says why, so the hint stands on its own wherever the full review is not shown. */
function deniedHint(policy: PolicyDecision): string {
  const reasons = [...new Set(policy.results.filter((result) => result.outcome === 'deny').map((result) => result.message))];
  return `The policy denies this plan, so it cannot be applied: ${reasons.join('; ')}`;
}
const HINT_AUTO = 'Within the auto-apply policy: plan_apply with dryRun false will run it.';

function orNullWhenMissing<T>(read: () => T): T | null {
  try {
    return read();
  } catch (error) {
    if (error instanceof AutopilotError && error.code === 'not_found') return null;
    throw error;
  }
}

function citedFindings(plan: Plan, runtime: Runtime): Finding[] {
  const auditId = plan.auditId;
  if (auditId === undefined) return [];
  const audit = orNullWhenMissing(() => runtime.store.getAudit(auditId));
  if (audit === null) return [];
  const cited = new Set(plan.actions.flatMap((action) => action.findingIds ?? []));
  return audit.findings.filter((finding) => cited.has(finding.id));
}

function gateAllowsAuto(gate: GateDecision | null, threshold: number): boolean {
  return gate !== null
    && gate.mode === 'jev'
    && gate.verdict === 'allow'
    && gate.actions.every((action) => action.verdict === 'allow' && action.confidence >= threshold);
}

function approvalFor(
  planId: string,
  policy: PolicyDecision,
  auto: boolean,
  receipt: ApprovalReceipt | null,
): PlanPreview['approval'] {
  if (!policy.allowed) return { required: false, satisfiedBy: null, hint: deniedHint(policy) };
  if (auto) return { required: false, satisfiedBy: 'policy', hint: HINT_AUTO };
  if (receipt !== null) {
    return { required: false, satisfiedBy: receipt.method, hint: `Approved; valid until ${receipt.expiresAt}.` };
  }
  return {
    required: true,
    satisfiedBy: null,
    hint: `A person must approve this exact plan: run \`autopilot-marketing approve ${planId}\` or \`autopilot-marketing review ${planId}\` in their own terminal.`,
  };
}

function totalsOf(plan: Plan): PlanPreview['totals'] {
  let spend = 0;
  for (const action of plan.actions) {
    if (action.spendDeltaPerDay !== null) spend += action.spendDeltaPerDay;
  }
  return {
    actions: plan.actions.length,
    spendDeltaPerDay: Math.round(spend * 100) / 100,
    increases: plan.actions.filter((action) => action.spendEffect === 'increase').length,
    irreversible: plan.actions.filter((action) => action.reversible === 'none').length,
  };
}

/** Policy first; the Jev gate is asked only for a plan the policy allows. Appends `plan.previewed`. */
export async function previewPlan(planId: string, runtime: Runtime): Promise<PlanPreview> {
  const plan = runtime.store.getPlan(planId);
  const account = runtime.account(plan.accountId);
  const snapshotId = plan.snapshotId;
  const snapshot: Snapshot | null =
    snapshotId === null ? null : orNullWhenMissing(() => runtime.store.getSnapshot(snapshotId));
  const now = runtime.now();

  const policy = evaluatePolicy({
    plan,
    policy: runtime.config.policy,
    account,
    snapshot,
    ledger: runtime.ledger.read({ accountId: account.id }),
    autonomy: runtime.autonomy,
    killSwitch: runtime.killSwitch(),
    now,
  });

  let gate: GateDecision | null = null;
  if (policy.allowed) {
    try {
      const asked = await withJudgmentUsage(
        runtime,
        { operation: 'gate', accountId: account.id, planId: plan.id },
        () => runtime.judge.gatePlan({ plan, policy: runtime.config.policy, findings: citedFindings(plan, runtime) }),
      );
      gate = asked.value;
    } catch {
      gate = null;
    }
  }

  const auto = policy.autoApplicable && gateAllowsAuto(gate, runtime.config.judgment.gateThreshold);
  let receipt: ApprovalReceipt | null = null;
  try {
    receipt = runtime.approvals.verify({ plan, policyDigest: policy.policyDigest, now });
  } catch {
    receipt = null;
  }

  const approval = approvalFor(plan.id, policy, auto, receipt);
  const totals = totalsOf(plan);
  const review = renderPlanPreview(
    { plan, policy, gate, approval, totals },
    snapshot?.currency ?? account.currency ?? 'XXX',
  );
  const reviewDigest = sha256(review);

  runtime.ledger.append({
    event: 'plan.previewed',
    actor: { kind: 'system', id: 'autopilot' },
    accountId: account.id,
    planId: plan.id,
    data: { planDigest: plan.digest, allowed: policy.allowed, gate: gate ? gate.verdict : null, reviewDigest },
  });

  return { plan, policy, gate, approval, totals, review, reviewDigest };
}
