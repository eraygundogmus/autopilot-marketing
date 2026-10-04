import { randomBytes } from 'node:crypto';
import { lastNDays } from '../core/dates';
import { AutopilotError } from '../core/errors';
import { digest } from '../core/ids';
import { redact } from '../core/redact';
import { ACTION_KINDS } from '../core/types';
import type {
  AccountConfig, Action, ActionDraft, ActionResult, ApplyOutcome, ApprovalReceipt, Connector, DatasetName,
  EntityLevel, GateDecision, JsonObject, JsonValue, LedgerEntry, LedgerInput, Plan, Runtime, Snapshot,
} from '../core/types';
import { withJudgmentUsage } from '../judgment/usage';
import { actionSpec, planDigest } from './actions';
import { createPlan } from './planner';
import { evaluatePolicy } from './policy';

export interface ApplyOptions {
  /** True validates with the platform and changes nothing. */
  dryRun: boolean;
  actor: LedgerEntry['actor'];
  /** A receipt from `autopilot-marketing approve`. */
  receiptId?: string;
  /** Set by the MCP tool when the human confirmed through client elicitation. */
  elicitedBy?: string;
  reviewDigest?: string;
}

const STALE = 'stale: the entity changed since the plan was created';
type ExecutionResult = ApplyOutcome['results'][number];
type Append = (entry: LedgerInput) => void;

function errorDetails(error: unknown, runtime: Runtime): NonNullable<ActionResult['error']> {
  const record = typeof error === 'object' && error !== null ? error : {};
  return {
    code: redact('code' in record && typeof record.code === 'string' ? record.code : 'internal', runtime.env),
    message: redact('message' in record && typeof record.message === 'string'
      ? record.message : 'The operation failed.', runtime.env),
    retryable: 'retryable' in record && record.retryable === true,
  };
}

function failedResult(error: unknown, runtime: Runtime, dryRun = false): ActionResult {
  return { ok: false, dryRun, after: null, error: errorDetails(error, runtime) };
}

function object(value: JsonValue | undefined): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function sameFields(actual: JsonObject | null, expected: JsonObject | null, fields: JsonObject): boolean {
  if (actual === null || expected === null) return false;
  const keys = Object.keys(fields);
  if (keys.length === 0 || keys.some((key) => !Object.hasOwn(actual, key) || !Object.hasOwn(expected, key))) {
    return false;
  }
  return digest(Object.fromEntries(keys.map((key) => [key, actual[key]])))
    === digest(Object.fromEntries(keys.map((key) => [key, expected[key]])));
}

function assertDigest(plan: Plan): void {
  if (planDigest(plan) !== plan.digest) {
    throw new AutopilotError('invalid_input', 'The stored plan does not match its digest. Create and review a new plan.');
  }
}

function assertExecutable(plan: Plan): void {
  if (plan.status !== 'proposed' && plan.status !== 'approved') {
    throw new AutopilotError('invalid_input', `A plan with status '${plan.status}' cannot be executed. Make a new plan to retry.`);
  }
}

function gateAllows(gate: GateDecision, plan: Plan, threshold: number): boolean {
  const ids = new Set(plan.actions.map((action) => action.id));
  return gate.mode === 'jev' && gate.verdict === 'allow' && gate.planDigest === plan.digest
    && ids.size === plan.actions.length && gate.actions.length === ids.size
    && gate.actions.every((action) => ids.delete(action.actionId) && action.verdict === 'allow'
      && Number.isFinite(action.confidence) && action.confidence >= threshold)
    && ids.size === 0;
}

function counts(results: ExecutionResult[]): Pick<ApplyOutcome, 'applied' | 'failed' | 'skipped' | 'unknown'> {
  return {
    applied: results.filter((result) => result.status === 'applied').length,
    failed: results.filter((result) => result.status === 'failed').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    unknown: results.filter((result) => result.status === 'unknown').length,
  };
}

function finalizePlan(plan: Plan, runtime: Runtime): void {
  const applied = plan.actions.filter((action) => action.status === 'applied').length;
  plan.status = applied === plan.actions.length ? 'applied' : applied > 0 ? 'partial' : 'failed';
  runtime.store.savePlan(plan);
}

function actionData(action: Action): JsonObject {
  return {
    kind: action.kind,
    target: { ...action.target },
    before: action.before,
    after: action.after,
    spendEffect: action.spendEffect,
    spendDeltaPerDay: action.spendDeltaPerDay,
  };
}

function resolved(entry: LedgerEntry): boolean {
  return entry.event === 'action.applied' || entry.event === 'action.failed' || entry.event === 'action.skipped'
    || (entry.event === 'action.reconciled'
      && (entry.data?.outcome === 'applied' || entry.data?.outcome === 'not_applied'));
}

function intentDraft(data: JsonObject | undefined): ActionDraft | null {
  const kind = ACTION_KINDS.find((candidate) => candidate === data?.kind);
  const target = object(data?.target);
  const params = object(data?.params);
  if (kind === undefined || target === null || params === null || typeof target.id !== 'string') return null;
  const spec = actionSpec(kind);
  if (target.level !== spec.targetLevel) return null;
  return {
    kind,
    target: {
      level: spec.targetLevel,
      id: target.id,
      ...(typeof target.name === 'string' ? { name: target.name } : {}),
      ...(typeof target.campaignId === 'string' ? { campaignId: target.campaignId } : {}),
      ...(typeof target.adGroupId === 'string' ? { adGroupId: target.adGroupId } : {}),
    },
    params,
    rationale: 'Reconcile a previously recorded intent.',
  };
}

function reconcilePlan(
  intent: LedgerEntry, runtime: Runtime, accountId: string,
  outcome: 'applied' | 'not_applied' | 'conflict', observed: JsonObject | null,
): void {
  if (intent.planId === undefined || intent.actionId === undefined) return;
  let original: Plan;
  try {
    original = runtime.store.getPlan(intent.planId);
  } catch (error) {
    if (error instanceof AutopilotError && error.code === 'not_found') return;
    throw error;
  }
  if (original.accountId !== accountId) return;
  const action = original.actions.find((candidate) => candidate.id === intent.actionId);
  if (action === undefined) return;
  action.status = outcome === 'applied' ? 'applied' : outcome === 'not_applied' ? 'failed' : 'unknown';
  if (outcome === 'applied') {
    const { error: _error, ...result } = action.result ?? {};
    action.result = { ...result, ok: true, dryRun: false, after: observed };
  } else {
    action.result = { ...action.result, ok: false, dryRun: false, after: null };
  }
  finalizePlan(original, runtime);
}

async function reconcileIntents(
  plan: Plan, runtime: Runtime, connector: Connector, actor: LedgerEntry['actor'], append: Append,
): Promise<void> {
  const entries = runtime.ledger.read({ accountId: plan.accountId });
  const intents = entries.filter((entry) => entry.event === 'action.intent' && !entries.some((later) =>
    later.seq > entry.seq && later.executionId === entry.executionId && later.actionId === entry.actionId
      && resolved(later)));
  const conflicts: string[] = [];
  for (const intent of intents) {
    const draft = intentDraft(intent.data);
    const after = object(intent.data?.after);
    const before = object(intent.data?.before);
    let outcome: 'applied' | 'not_applied' | 'conflict' = 'conflict';
    let observed: JsonObject | null = null;
    let reason = 'The current state does not match the recorded before or after state.';
    if (draft !== null && after !== null) {
      try {
        observed = await connector.readState(draft);
        if (sameFields(observed, after, after)) outcome = 'applied';
        else if (sameFields(observed, before, after)) outcome = 'not_applied';
      } catch (error) {
        reason = errorDetails(error, runtime).message;
      }
    } else {
      reason = 'The recorded intent cannot be read safely.';
    }
    // A resolved ledger entry must not precede repair of the original plan.
    reconcilePlan(intent, runtime, plan.accountId, outcome, observed);
    append({
      event: 'action.reconciled', actor, accountId: plan.accountId,
      ...(intent.planId === undefined ? {} : { planId: intent.planId }),
      ...(intent.executionId === undefined ? {} : { executionId: intent.executionId }),
      ...(intent.actionId === undefined ? {} : { actionId: intent.actionId }),
      ...(intent.idempotencyKey === undefined ? {} : { idempotencyKey: intent.idempotencyKey }),
      data: {
        ...Object.fromEntries(['kind', 'target', 'before', 'after', 'spendEffect', 'spendDeltaPerDay']
          .flatMap((key) => intent.data?.[key] === undefined ? [] : [[key, intent.data[key]]])),
        outcome,
        ...(outcome === 'conflict' ? { reason } : {}),
      },
    });
    const target = object(intent.data?.target);
    const unidentified = target === null || typeof target.level !== 'string' || typeof target.id !== 'string';
    if (outcome === 'conflict' && (unidentified || plan.actions.some((action) =>
      action.target.level === target.level && action.target.id === target.id))) {
      conflicts.push(unidentified ? 'an unidentified entity' : `${String(target.level)} ${String(target.id)}`);
    }
  }
  if (conflicts.length > 0) {
    throw new AutopilotError('stale_state',
      `A previous change to ${conflicts.join(', ')} has an unknown outcome; a person must check it before another change.`);
  }
}

export async function applyPlan(planId: string, runtime: Runtime, options: ApplyOptions): Promise<ApplyOutcome> {
  const plan = runtime.store.getPlan(planId);
  assertDigest(plan);
  const account = runtime.account(plan.accountId);
  const connector = runtime.connector(account);
  const now = runtime.now();
  let snapshot: Snapshot | null = null;
  if (plan.snapshotId !== null) {
    try {
      snapshot = runtime.store.getSnapshot(plan.snapshotId);
    } catch (error) {
      if (!(error instanceof AutopilotError) || error.code !== 'not_found') throw error;
    }
  }
  const policy = evaluatePolicy({
    plan, policy: runtime.config.policy, account, snapshot,
    ledger: runtime.ledger.read({ accountId: account.id }), autonomy: runtime.autonomy,
    killSwitch: runtime.killSwitch(), now,
  });
  if (options.dryRun !== true && options.dryRun !== false) {
    throw new AutopilotError('invalid_input', 'dryRun must be the boolean true or false.');
  }
  const denials = policy.results.filter((result) => result.outcome === 'deny').map((result) => result.message).join('; ');
  const results: ExecutionResult[] = [];
  if (options.dryRun) {
    for (const action of plan.actions) {
      let item: ExecutionResult;
      try {
        const fresh = await connector.readState(action);
        if (action.preconditionHash !== null && digest(fresh) !== action.preconditionHash) {
          item = { actionId: action.id, status: 'skipped', result: null, note: STALE };
        } else {
          const result = await connector.apply(action, { validateOnly: true, idempotencyKey: `dryrun:${action.id}` });
          item = { actionId: action.id, status: 'pending', result };
        }
      } catch (error) {
        item = { actionId: action.id, status: 'failed', result: failedResult(error, runtime, true) };
      }
      if (!policy.allowed) item.note = [item.note, `policy would deny: ${denials}`].filter(Boolean).join('; ');
      results.push(item);
    }
    return { plan, dryRun: true, executionId: null, ...counts(results), results, ledgerSeqs: [] };
  }

  assertExecutable(plan);
  if (!policy.allowed) throw new AutopilotError('policy_denied', `Policy denied this plan: ${denials}`);
  let receipt: ApprovalReceipt | undefined;
  let gate: GateDecision | null = null;
  if (policy.autoApplicable) {
    try {
      const asked = await withJudgmentUsage(
        runtime,
        { operation: 'gate', accountId: account.id, planId: plan.id },
        () => runtime.judge.gatePlan({ plan, policy: runtime.config.policy, findings: [] }),
      );
      gate = asked.value;
    } catch {
      // An unavailable semantic gate never delegates authority.
    }
  }
  const automatic = policy.autoApplicable && gate !== null && gateAllows(gate, plan, runtime.config.judgment.gateThreshold);
  if (!automatic) {
    if (typeof options.elicitedBy === 'string' && options.elicitedBy.trim() !== '') {
      receipt = runtime.approvals.issue({
        plan, policyDigest: policy.policyDigest, reviewDigest: options.reviewDigest ?? plan.digest,
        method: 'elicitation', approver: options.elicitedBy, now,
      });
    } else {
      receipt = runtime.approvals.verify({
        plan, policyDigest: policy.policyDigest, now,
        ...(options.receiptId === undefined ? {} : { receiptId: options.receiptId }),
      });
    }
    if (receipt.method === 'policy') {
      throw new AutopilotError('approval_required', 'An automatic receipt cannot authorize a later execution. Human approval is required.');
    }
  }
  let receiptExpiresAt = Number.NaN;
  const executionId = `exec_${randomBytes(8).toString('hex')}`;
  if (!runtime.store.acquireLock(account.id, executionId, runtime.now(), 900)) {
    throw new AutopilotError('stale_state', 'Another execution is running for this account.', { retryable: true });
  }
  const ledgerSeqs: number[] = [];
  const append: Append = (entry) => { ledgerSeqs.push(runtime.ledger.append(entry).seq); };
  const base = { actor: options.actor, accountId: account.id, planId: plan.id, executionId };
  let applying = false;
  function record(action: Action, status: Action['status'], result: ActionResult | null, note?: string): void {
    action.status = status;
    if (result === null) delete action.result;
    else action.result = result;
    results.push({ actionId: action.id, status, result, ...(note === undefined ? {} : { note }) });
  }
  function skip(actions: Action[], reason: string): void {
    for (const action of actions) record(action, 'skipped', null, reason);
    runtime.store.savePlan(plan);
    for (const action of actions) {
      append({ ...base, actionId: action.id, event: 'action.skipped', data: { kind: action.kind, target: { ...action.target }, reason } });
    }
  }
  function stopReason(): string | null {
    if (runtime.killSwitch()) return 'the kill switch is active';
    if (!(runtime.now().getTime() <= receiptExpiresAt)) return 'the approval receipt expired';
    return null;
  }

  try {
    // Gate calls can yield while another execution finishes this plan.
    const stored = runtime.store.getPlan(plan.id);
    assertDigest(stored);
    assertExecutable(stored);
    if (stored.digest !== plan.digest) throw new AutopilotError('stale_state', 'The stored plan changed during authorization.');
    await reconcileIntents(plan, runtime, connector, options.actor, append);
    assertExecutable(runtime.store.getPlan(plan.id));
    // The first evaluation ran before the lock: another execution may have used up a limit since.
    const underLock = evaluatePolicy({
      plan, policy: runtime.config.policy, account, snapshot,
      ledger: runtime.ledger.read({ accountId: account.id }), autonomy: runtime.autonomy,
      killSwitch: runtime.killSwitch(), now: runtime.now(),
    });
    if (!underLock.allowed || underLock.policyDigest !== policy.policyDigest) {
      const reasons = underLock.results.filter((result) => result.outcome === 'deny').map((result) => result.message).join('; ');
      throw new AutopilotError('policy_denied', `The policy no longer allows this plan: ${reasons || 'the policy changed'}.`);
    }
    const claimTime = runtime.now();
    if (automatic && (!underLock.autoApplicable || gate === null || !gateAllows(gate, plan, runtime.config.judgment.gateThreshold))) {
      throw new AutopilotError('approval_required', 'Automatic authorization no longer allows this plan. Human approval is required.');
    }
    if (!runtime.store.acquireLock(account.id, executionId, claimTime, 900)) {
      throw new AutopilotError('stale_state', 'The execution lock was lost before claiming approval.', { retryable: true });
    }
    if (receipt === undefined) {
      // Automatic receipts belong only to the execution that immediately claims them under lock.
      receipt = runtime.approvals.issue({
        plan, policyDigest: underLock.policyDigest, reviewDigest: plan.digest,
        method: 'policy', approver: 'policy', now: claimTime,
      });
    }
    runtime.approvals.claim(receipt, executionId, claimTime);
    receiptExpiresAt = Date.parse(receipt.expiresAt);
    append({
      ...base, event: 'execution.claimed', data: {
        receiptId: receipt.id, method: receipt.method, approver: receipt.approver,
        planDigest: receipt.planDigest, policyDigest: receipt.policyDigest, reviewDigest: receipt.reviewDigest,
      },
    });
    plan.status = 'applying';
    applying = true;
    runtime.store.savePlan(plan);

    for (const [index, action] of plan.actions.entries()) {
      try {
        let reason = stopReason();
        // Re-taking the lock extends it; losing it means another execution took over after an expiry.
        if (reason === null && !runtime.store.acquireLock(account.id, executionId, runtime.now(), 900)) {
          reason = 'the execution lock was lost';
        }
        if (reason !== null) { skip(plan.actions.slice(index), reason); break; }
        let fresh: JsonObject;
        try {
          fresh = await connector.readState(action);
        } catch (error) {
          skip([action], errorDetails(error, runtime).message);
          continue;
        }
        if (digest(fresh) !== action.preconditionHash) { skip([action], STALE); continue; }
        reason = stopReason();
        if (reason !== null) { skip(plan.actions.slice(index), reason); break; }
        const idempotencyKey = `${executionId}:${action.id}`;
        const actionBase = { ...base, actionId: action.id, idempotencyKey };
        try {
          append({ ...actionBase, event: 'action.intent', data: { ...actionData(action), params: action.params } });
        } catch (error) {
          skip(plan.actions.slice(index), `the action intent could not be recorded: ${errorDetails(error, runtime).message}`);
          break;
        }
        reason = stopReason();
        if (reason !== null) { skip(plan.actions.slice(index), reason); break; }
        let result: ActionResult;
        let ambiguous = false;
        // A dispatched mutation remains unknown until a result or a fresh read settles it.
        action.status = 'unknown';
        delete action.result;
        try {
          result = await connector.apply(action, { validateOnly: false, idempotencyKey });
          ambiguous = !result.ok && result.error?.retryable === true;
        } catch (error) {
          result = failedResult(error, runtime);
          ambiguous = true;
        }

        if (result.ok) {
          let observed: JsonObject | null = null;
          try { observed = await connector.readState(action); } catch { /* The platform already confirmed the write. */ }
          record(action, 'applied', { ...result, after: observed });
          append({
            ...actionBase, event: 'action.applied', data: {
              ...actionData(action), after: observed ?? action.after,
              ...(result.resource === undefined ? {} : { resource: redact(result.resource, runtime.env) }),
              ...(result.platformRequestId === undefined ? {} : { platformRequestId: redact(result.platformRequestId, runtime.env) }),
              ...(result.simulated === undefined ? {} : { simulated: result.simulated }),
            },
          });
          continue;
        }

        const error = errorDetails(result.error, runtime);
        const ledgerError = { code: error.code, message: error.message };
        result = { ...result, after: null, error };
        if (!ambiguous) {
          record(action, 'failed', result);
          append({ ...actionBase, event: 'action.failed', data: { kind: action.kind, target: { ...action.target }, error: ledgerError } });
          skip(plan.actions.slice(index + 1), 'a previous action failed');
          break;
        }

        let observed: JsonObject | null = null;
        let unknownReason = 'the action outcome is unknown: the state matches neither before nor after';
        try { observed = await connector.readState(action); } catch (readError) {
          unknownReason = `the action outcome is unknown: ${errorDetails(readError, runtime).message}`;
        }
        if (sameFields(observed, action.after, action.after)) {
          const { error: _error, ...confirmed } = result;
          record(action, 'applied', { ...confirmed, ok: true, after: observed });
          append({ ...actionBase, event: 'action.reconciled', data: { ...actionData(action), outcome: 'applied' } });
          continue;
        }
        if (sameFields(observed, action.before, action.after)) {
          record(action, 'failed', result);
          append({ ...actionBase, event: 'action.failed', data: { kind: action.kind, target: { ...action.target }, error: ledgerError } });
          skip(plan.actions.slice(index + 1), 'a previous action failed');
        } else {
          record(action, 'unknown', result, unknownReason);
          append({ ...actionBase, event: 'action.unknown', data: { ...actionData(action), reason: unknownReason, error: ledgerError } });
          skip(plan.actions.slice(index + 1), 'a previous action has an unknown outcome');
        }
        break;
      } finally {
        runtime.store.savePlan(plan);
      }
    }
    const totals = counts(results);
    finalizePlan(plan, runtime);
    append({ ...base, event: 'execution.closed', data: { ...totals, status: plan.status } });
    return { plan, dryRun: false, executionId, ...totals, results, ledgerSeqs };
  } finally {
    try {
      if (applying) finalizePlan(plan, runtime);
    } finally {
      runtime.store.releaseLock(account.id, executionId);
    }
  }
}

const REVERT_DATASETS: Partial<Record<EntityLevel, DatasetName>> = {
  ad_group: 'ad_groups',
  ad: 'ads',
  keyword: 'keywords',
  segment: 'segments',
};

/**
 * Takes, stores and logs the snapshot a revert is judged on: campaigns for budget totals, plus the
 * dataset of each reverted target, so names and ancestry are the current ones.
 */
async function revertSnapshot(
  runtime: Runtime, account: AccountConfig, connector: Connector, drafts: ActionDraft[],
): Promise<Snapshot> {
  const wanted = new Set<DatasetName>(['campaigns']);
  for (const draft of drafts) {
    const dataset = REVERT_DATASETS[draft.target.level];
    if (dataset !== undefined) wanted.add(dataset);
  }
  const supported = connector.status().datasets;
  const datasets = [...wanted].filter((dataset) => supported.includes(dataset));
  const snapshot = await connector.fetchSnapshot({
    account, dateRange: lastNDays(7, runtime.now()),
    // Without a supported dataset to name, the connector's default applies: all it supports.
    ...(datasets.length === 0 ? {} : { datasets }),
  });
  runtime.store.saveSnapshot(snapshot);
  runtime.ledger.append({
    event: 'snapshot.created', actor: { kind: 'system', id: 'autopilot' }, accountId: account.id,
    data: {
      snapshotId: snapshot.id,
      source: snapshot.source,
      dateRange: { start: snapshot.dateRange.start, end: snapshot.dateRange.end },
      contentHash: snapshot.contentHash,
    },
  });
  return snapshot;
}

/**
 * Builds and stores the compensating plan for an applied plan. It is applied like any other plan,
 * and is bound to a snapshot taken now: a revert that cannot be checked on current facts is not created.
 */
export async function createRevertPlan(planId: string, runtime: Runtime): Promise<Plan> {
  const plan = runtime.store.getPlan(planId);
  if (plan.status !== 'applied' && plan.status !== 'partial') {
    throw new AutopilotError('invalid_input', `A plan with status '${plan.status}' cannot be reverted.`);
  }
  const account = runtime.account(plan.accountId);
  const connector = runtime.connector(account);
  const drafts: ActionDraft[] = [];
  const skipped: string[] = [];
  const verified: Action[] = [];
  for (const action of [...plan.actions].reverse()) {
    if (action.status !== 'applied') { skipped.push(`${action.id}: was not applied`); continue; }
    const draft = actionSpec(action.kind).inverse(action);
    if (draft === null) { skipped.push(`${action.id}: has no compensating action`); continue; }
    let fresh: JsonObject;
    try { fresh = await connector.readState(action); } catch (error) {
      skipped.push(`${action.id}: current state could not be verified (${errorDetails(error, runtime).message})`);
      continue;
    }
    if (!sameFields(fresh, action.result?.after ?? action.after, action.after)) {
      skipped.push(`${action.id}: the entity changed after apply`);
      continue;
    }
    drafts.push(draft);
    verified.push(action);
  }
  if (drafts.length === 0) {
    throw new AutopilotError('invalid_input',
      `Nothing in this plan can be reverted. Skipped ${skipped.length} action(s): ${skipped.join('; ')}.`);
  }
  const snapshot = await revertSnapshot(runtime, account, connector, drafts);
  const newPlan = await createPlan({
    account, snapshot, drafts, title: `Revert: ${plan.title}`,
    rationale: `Compensating changes for plan ${plan.id}. Money already spent is not recovered.`,
    createdBy: 'agent', connector, now: runtime.now(), revertsPlanId: plan.id,
  });
  // Planning reads again; a later change must not become permission to overwrite it.
  for (const [index, action] of newPlan.actions.entries()) {
    const original = verified[index];
    if (original === undefined || !sameFields(action.before, original.result?.after ?? original.after, original.after)) {
      throw new AutopilotError('stale_state', 'An entity changed while the revert plan was being created. Review it again.');
    }
  }
  runtime.store.savePlan(newPlan);
  runtime.ledger.append({
    event: 'plan.created', actor: { kind: 'agent', id: 'executor' }, planId: newPlan.id, accountId: account.id,
    data: { revertsPlanId: plan.id, digest: newPlan.digest, actions: newPlan.actions.length },
  });
  return newPlan;
}
