import { describe, expect, it, vi } from 'vitest';
import type { AuditReport, Runtime } from '../../src/core/types';
import { auditSnapshot } from '../../src/ops/audit';
import { takeSnapshot } from '../../src/ops/data';
import { proposePlan, runCycle } from '../../src/ops/plans';
import { applyPlan } from '../../src/plan/executor';
import { previewPlan } from '../../src/plan/preview';
import { tempRuntime } from '../helpers/runtime';

vi.mock('../../src/plan/executor', () => ({ applyPlan: vi.fn() }));
vi.mock('../../src/plan/preview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/plan/preview')>();
  return { ...actual, previewPlan: vi.fn(actual.previewPlan) };
});

/** Makes the next preview report that the policy alone approves the plan. */
function policyApprovesNextPreview(): void {
  vi.mocked(previewPlan).mockImplementationOnce(async (planId, runtime) => {
    const actual = await vi.importActual<typeof import('../../src/plan/preview')>('../../src/plan/preview');
    const preview = await actual.previewPlan(planId, runtime);
    return { ...preview, approval: { required: false, satisfiedBy: 'policy', hint: '' } };
  });
}

const NOW = () => new Date('2026-03-15T12:00:00Z');

// The demo Meta account is the one whose audit suggests actions: the demo Google account has a
// conversion tracking issue, which strips the actions of every finding that relies on conversions.
async function demoAudit(runtime: Runtime, accountId = 'demo-meta'): Promise<AuditReport> {
  const snapshot = await takeSnapshot(runtime, { accountId });
  return auditSnapshot(runtime, { snapshotId: snapshot.id });
}

describe('proposePlan', () => {
  it('builds a stored, logged plan from the findings of an audit', async () => {
    const { runtime } = tempRuntime({ now: NOW });
    const report = await demoAudit(runtime);
    const plan = await proposePlan(runtime, {
      accountId: 'demo-meta',
      auditId: report.id,
      title: 'Fix waste',
      rationale: 'From the audit.',
      createdBy: 'agent',
    });
    expect(plan.auditId).toBe(report.id);
    expect(plan.snapshotId).toBe(report.snapshotId);
    expect(plan.actions.length).toBeGreaterThan(0);
    expect(plan.actions.length).toBeLessThanOrEqual(runtime.config.policy.maxActionsPerPlan);
    expect(runtime.store.getPlan(plan.id).auditId).toBe(report.id);
    const entries = runtime.ledger.read({ planId: plan.id, events: ['plan.created'] });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actor).toEqual({ kind: 'agent', id: 'agent' });
    expect(entries[0]?.data).toEqual({ digest: plan.digest, actions: plan.actions.length, auditId: report.id });
  });

  it('takes only the named findings', async () => {
    const { runtime } = tempRuntime({ now: NOW });
    const report = await demoAudit(runtime);
    const finding = report.findings.find((item) => item.suggestedActions.length > 0);
    if (!finding) throw new Error('the demo audit has no actionable finding');
    const plan = await proposePlan(runtime, {
      accountId: 'demo-meta',
      auditId: report.id,
      findingIds: [finding.id],
      title: 'One finding',
      rationale: 'r',
      createdBy: 'agent',
    });
    expect(plan.actions.length).toBeLessThanOrEqual(finding.suggestedActions.length);
    expect(plan.actions.length).toBeGreaterThan(0);
  });

  it('accepts explicit actions without an audit', async () => {
    const { runtime } = tempRuntime({ now: NOW });
    const report = await demoAudit(runtime);
    const draft = report.findings.flatMap((finding) => finding.suggestedActions)[0];
    if (!draft) throw new Error('the demo audit suggests no action');
    const plan = await proposePlan(runtime, {
      accountId: 'demo-meta',
      actions: [draft],
      title: 'Hand-written',
      rationale: 'r',
      createdBy: 'cli',
    });
    expect(plan.actions).toHaveLength(1);
    expect(plan.auditId).toBeUndefined();
    expect(plan.snapshotId).toBeNull();
    const entry = runtime.ledger.read({ planId: plan.id })[0];
    expect(entry?.actor).toEqual({ kind: 'human', id: 'cli' });
    expect(entry?.data).toEqual({ digest: plan.digest, actions: 1 });
  });

  it('needs actions or an audit', async () => {
    const { runtime } = tempRuntime({ now: NOW });
    await expect(
      proposePlan(runtime, { accountId: 'demo-meta', title: 't', rationale: 'r', createdBy: 'agent' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('refuses at autonomy observe', async () => {
    const { runtime } = tempRuntime({ now: NOW, config: { autonomy: 'observe' } });
    await expect(
      proposePlan(runtime, { accountId: 'demo-meta', actions: [], title: 't', rationale: 'r', createdBy: 'agent' }),
    ).rejects.toMatchObject({ code: 'policy_denied', hint: expect.stringContaining(runtime.paths.config) });
  });

  it('rejects an unknown finding id, naming it', async () => {
    const { runtime } = tempRuntime({ now: NOW });
    const report = await demoAudit(runtime);
    await expect(
      proposePlan(runtime, {
        accountId: 'demo-meta',
        auditId: report.id,
        findingIds: ['fnd_0000000000000000'],
        title: 't',
        rationale: 'r',
        createdBy: 'agent',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining('fnd_0000000000000000') });
  });

  it('rejects findings that carry no suggested actions', async () => {
    const { runtime } = tempRuntime({ now: NOW });
    const report = await demoAudit(runtime, 'demo-search-console');
    expect(report.findings.length).toBeGreaterThan(0);
    await expect(
      proposePlan(runtime, { accountId: 'demo-search-console', auditId: report.id, title: 't', rationale: 'r', createdBy: 'agent' }),
    ).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining('no suggested actions') });
    expect(runtime.store.listPlans()).toHaveLength(0);
  });

  it('refuses an audit of another account', async () => {
    const { runtime } = tempRuntime({ now: NOW });
    const report = await demoAudit(runtime);
    await expect(
      proposePlan(runtime, { accountId: 'demo-google', auditId: report.id, title: 't', rationale: 'r', createdBy: 'agent' }),
    ).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining('demo-meta') });
  });
});

describe('runCycle', () => {
  it('returns no plan when no finding suggests an action', async () => {
    vi.mocked(applyPlan).mockClear();
    const { runtime } = tempRuntime({ now: NOW });
    const result = await runCycle(runtime, { accountId: 'demo-search-console' });
    expect(result.audit.findings.length).toBeGreaterThan(0);
    expect(result.plan).toBeNull();
    expect(result.next).toBe('Nothing to change.');
    expect(applyPlan).not.toHaveBeenCalled();
  });

  it('at autonomy propose returns a plan awaiting approval and applies nothing', async () => {
    vi.mocked(applyPlan).mockClear();
    const { runtime } = tempRuntime({ now: NOW });
    const result = await runCycle(runtime, { accountId: 'demo-meta' });
    expect(result.audit.snapshotId).toBe(result.snapshot.id);
    expect(result.plan).not.toBeNull();
    expect(result.plan?.createdBy).toBe('autopilot');
    expect(result.plan?.auditId).toBe(result.audit.id);
    expect(result.plan?.title).toBe('Autopilot cycle 2026-03-15');
    expect(result.preview?.approval.satisfiedBy).not.toBe('policy');
    expect(result.outcome).toBeNull();
    expect(result.next).toBe(result.preview?.approval.hint);
    expect(applyPlan).not.toHaveBeenCalled();
  });

  it('at autonomy observe returns findings only', async () => {
    vi.mocked(applyPlan).mockClear();
    const { runtime } = tempRuntime({ now: NOW, config: { autonomy: 'observe' } });
    const result = await runCycle(runtime, { accountId: 'demo-meta', days: 14 });
    expect(result.plan).toBeNull();
    expect(result.preview).toBeNull();
    expect(result.outcome).toBeNull();
    expect(result.next).toBe('Autonomy is "observe": findings only.');
    expect(runtime.store.listPlans()).toHaveLength(0);
    expect(applyPlan).not.toHaveBeenCalled();
  });

  it('records why an automatic apply threw', async () => {
    vi.mocked(applyPlan).mockReset();
    vi.mocked(applyPlan).mockRejectedValueOnce(new Error('connector unreachable'));
    policyApprovesNextPreview();
    const { runtime } = tempRuntime({ now: NOW });
    const result = await runCycle(runtime, { accountId: 'demo-meta' });
    expect(applyPlan).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBeNull();
    expect(result.applyError).toBe('connector unreachable');
    expect(result.next).toBe('The plan was not applied: connector unreachable');
  });

  it('leaves applyError null when the apply returns an outcome or is not attempted', async () => {
    vi.mocked(applyPlan).mockReset();
    const { runtime } = tempRuntime({ now: NOW });
    const waiting = await runCycle(runtime, { accountId: 'demo-meta' });
    expect(waiting.applyError).toBeNull();
    expect((await runCycle(runtime, { accountId: 'demo-search-console' })).applyError).toBeNull();

    policyApprovesNextPreview();
    vi.mocked(applyPlan).mockImplementationOnce(async (planId, rt) => ({
      plan: rt.store.getPlan(planId),
      dryRun: false,
      executionId: 'exec_1',
      applied: 1,
      failed: 0,
      skipped: 0,
      unknown: 0,
      results: [],
      ledgerSeqs: [],
    }));
    const applied = await runCycle(runtime, { accountId: 'demo-meta' });
    expect(applied.outcome?.applied).toBe(1);
    expect(applied.applyError).toBeNull();
  });
});
