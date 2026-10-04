import { AutopilotError } from '../core/errors';
import type {
  ActionDraft,
  ApplyOutcome,
  AuditReport,
  Finding,
  JsonObject,
  Plan,
  PlanPreview,
  Runtime,
  Snapshot,
} from '../core/types';
import { applyPlan } from '../plan/executor';
import { createPlan, draftsFromFindings } from '../plan/planner';
import { previewPlan } from '../plan/preview';
import { auditSnapshot } from './audit';
import { takeSnapshot } from './data';

export interface ProposeInput {
  accountId: string;
  title: string;
  rationale: string;
  snapshotId?: string;
  /** Take the suggested actions of these findings from this audit. */
  auditId?: string;
  findingIds?: string[];
  /** Or state the actions directly. */
  actions?: ActionDraft[];
  createdBy: Plan['createdBy'];
}

function selectFindings(audit: AuditReport, findingIds: string[] | undefined): Finding[] {
  if (!findingIds) return audit.findings;
  const byId = new Map(audit.findings.map((finding) => [finding.id, finding]));
  const unknown = findingIds.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new AutopilotError('invalid_input', `Audit ${audit.id} has no finding ${unknown.join(', ')}.`, {
      hint: 'Use finding ids from this audit.',
    });
  }
  const wanted = new Set(findingIds);
  return audit.findings.filter((finding) => wanted.has(finding.id));
}

function storedSnapshotOrNull(runtime: Runtime, snapshotId: string): Snapshot | null {
  try {
    return runtime.store.getSnapshot(snapshotId);
  } catch (error) {
    if (error instanceof AutopilotError && error.code === 'not_found') return null;
    throw error;
  }
}

/** Creates, stores and logs a plan. Refused at autonomy `observe`. */
export async function proposePlan(runtime: Runtime, input: ProposeInput): Promise<Plan> {
  if (runtime.autonomy === 'observe') {
    throw new AutopilotError('policy_denied', 'Plans are off at autonomy "observe".', {
      hint: `Set "autonomy" to "propose" or higher in ${runtime.paths.config} to create plans.`,
    });
  }
  const account = runtime.account(input.accountId);

  let audit: AuditReport | null = null;
  let drafts: ActionDraft[];
  if (input.actions) {
    drafts = input.actions;
  } else {
    if (!input.auditId) {
      throw new AutopilotError('invalid_input', 'A plan needs either actions or an audit id.', {
        hint: 'Pass the id of an audit whose findings suggest actions, or state the actions directly.',
      });
    }
    audit = runtime.store.getAudit(input.auditId);
    if (audit.accountId !== account.id) {
      throw new AutopilotError(
        'invalid_input',
        `Audit ${audit.id} belongs to account ${audit.accountId}, not ${account.id}.`,
        { hint: 'Use an audit of the account the plan is for.' },
      );
    }
    drafts = draftsFromFindings(selectFindings(audit, input.findingIds), runtime.config.policy.maxActionsPerPlan);
    if (drafts.length === 0) {
      throw new AutopilotError('invalid_input', 'These findings carry no suggested actions.', {
        hint: 'Only findings with sufficient data carry suggested actions; pick others or state the actions directly.',
      });
    }
  }

  let snapshot: Snapshot | null = null;
  if (input.snapshotId) snapshot = runtime.store.getSnapshot(input.snapshotId);
  else if (audit) snapshot = storedSnapshotOrNull(runtime, audit.snapshotId);

  const plan = await createPlan({
    account,
    snapshot,
    drafts,
    title: input.title,
    rationale: input.rationale,
    createdBy: input.createdBy,
    connector: runtime.connector(account),
    now: runtime.now(),
  });
  // Not part of the digest, so it can be set after the plan is built.
  if (audit) plan.auditId = audit.id;
  runtime.store.savePlan(plan);

  const data: JsonObject = { digest: plan.digest, actions: plan.actions.length };
  if (plan.auditId) data.auditId = plan.auditId;
  runtime.ledger.append({
    event: 'plan.created',
    actor: { kind: input.createdBy === 'cli' ? 'human' : 'agent', id: input.createdBy },
    accountId: account.id,
    planId: plan.id,
    data,
  });
  return plan;
}

export interface CycleResult {
  snapshot: Snapshot;
  audit: AuditReport;
  plan: Plan | null;
  preview: PlanPreview | null;
  /** Set only when the plan was auto-applied under the policy. */
  outcome: ApplyOutcome | null;
  /** Why the automatic apply threw; null when it was not attempted or returned an outcome. */
  applyError: string | null;
  /** What a person has to do next, if anything. */
  next: string;
}

/** One unattended cycle: snapshot, audit, plan, preview, and apply only what the policy lets through. */
export async function runCycle(
  runtime: Runtime,
  /** `guard` throws when the caller may no longer write (a scheduled job that lost its claim). */
  input: { accountId: string; days?: number; guard?: () => void },
): Promise<CycleResult> {
  const snapshot = await takeSnapshot(runtime, {
    accountId: input.accountId,
    ...(input.days !== undefined ? { days: input.days } : {}),
  });
  const audit = await auditSnapshot(runtime, { snapshotId: snapshot.id });

  const idle = { snapshot, audit, plan: null, preview: null, outcome: null, applyError: null };
  if (runtime.autonomy === 'observe') return { ...idle, next: 'Autonomy is "observe": findings only.' };
  if (!audit.findings.some((finding) => finding.suggestedActions.length > 0)) {
    return { ...idle, next: 'Nothing to change.' };
  }

  const plan = await proposePlan(runtime, {
    accountId: input.accountId,
    auditId: audit.id,
    title: `Autopilot cycle ${runtime.now().toISOString().slice(0, 10)}`,
    rationale: `Suggested actions of audit ${audit.id}.`,
    createdBy: 'autopilot',
  });
  const preview = await previewPlan(plan.id, runtime);
  if (preview.approval.satisfiedBy !== 'policy') {
    return { snapshot, audit, plan, preview, outcome: null, applyError: null, next: preview.approval.hint };
  }

  try {
    const outcome = await applyPlan(plan.id, runtime, {
      dryRun: false,
      actor: { kind: 'system', id: 'autopilot' },
      ...(input.guard === undefined ? {} : { guard: input.guard }),
    });
    return {
      snapshot,
      audit,
      plan: outcome.plan,
      preview,
      outcome,
      applyError: null,
      next: `Applied ${outcome.applied} change(s) under the auto-apply policy.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      snapshot,
      audit,
      plan,
      preview,
      outcome: null,
      applyError: message,
      next: `The plan was not applied: ${message}`,
    };
  }
}
