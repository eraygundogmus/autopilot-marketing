import { describe, expect, it, vi } from 'vitest';
import { workCommands } from '../../src/cli/commands';
import type { CommandContext } from '../../src/cli/commands';
import type { CliIo } from '../../src/cli/main';
import { AutopilotError } from '../../src/core/errors';
import type { ApplyOutcome, Runtime } from '../../src/core/types';
import { runCycle } from '../../src/ops/plans';
import type { CycleResult } from '../../src/ops/plans';
import { tempRuntime } from '../helpers/runtime';

vi.mock('../../src/cli/review', () => ({
  startReviewServer: vi.fn(async () => ({
    url: 'http://127.0.0.1:1/token/',
    done: Promise.resolve('rejected' as const),
    close: () => undefined,
  })),
}));

vi.mock('../../src/ops/plans', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ops/plans')>();
  return { ...actual, runCycle: vi.fn(actual.runCycle) };
});

interface FakeIo extends CliIo {
  out: string[];
  err: string[];
  questions: string[];
}

function fakeIo(options: { tty?: boolean; answer?: boolean } = {}): FakeIo {
  const out: string[] = [];
  const err: string[] = [];
  const questions: string[] = [];
  return {
    out,
    err,
    questions,
    stdout: (text) => {
      out.push(text);
    },
    stderr: (text) => {
      err.push(text);
    },
    stdin: options.tty === true ? { isTTY: true } : {},
    confirm: async (question) => {
      questions.push(question);
      return options.answer ?? false;
    },
    readSecret: async () => '',
  };
}

async function call(
  name: string,
  runtime: Runtime,
  args: string[],
  extra: Partial<Pick<CommandContext, 'flags' | 'json'>> & { io?: FakeIo } = {},
): Promise<{ code: number; text: string; io: FakeIo }> {
  const handler = workCommands[name];
  if (handler === undefined) throw new Error(`no command ${name}`);
  const io = extra.io ?? fakeIo();
  const code = await handler({ runtime, io, args, flags: extra.flags ?? {}, json: extra.json ?? false });
  return { code, text: io.out.join(''), io };
}

function idIn(text: string, prefix: string): string {
  const match = new RegExp(`${prefix}_[0-9a-f]{16}`).exec(text);
  if (match === null) throw new Error(`no ${prefix} id in output`);
  return match[0];
}

async function auditAndPlan(runtime: Runtime): Promise<{ auditId: string; planId: string; review: string }> {
  const audited = await call('audit', runtime, ['demo-google'], { flags: { 'no-judgments': true } });
  const auditId = idIn(audited.text, 'aud');
  const planned = await call('plan', runtime, [auditId]);
  return { auditId, planId: idIn(planned.text, 'plan'), review: planned.text };
}

describe('workCommands', () => {
  it('has the eleven work commands', () => {
    expect(Object.keys(workCommands).sort()).toEqual(
      ['apply', 'approve', 'audit', 'plan', 'preview', 'reconcile', 'report', 'revert', 'review', 'run', 'snapshot'],
    );
  });

  it('snapshot prints the id, source, range and coverage', async () => {
    const { runtime } = tempRuntime();
    const result = await call('snapshot', runtime, ['demo-google'], { flags: { days: '14' } });
    expect(result.code).toBe(0);
    expect(result.text).toMatch(/Snapshot: snap_[0-9a-f]{16}/);
    expect(result.text).toContain('Source: ');
    expect(result.text).toContain('Coverage:');
    expect(() => runtime.store.getSnapshot(idIn(result.text, 'snap'))).not.toThrow();
  });

  it('audit prints a score and the audit id', async () => {
    const { runtime } = tempRuntime();
    const result = await call('audit', runtime, ['demo-google'], { flags: { 'no-judgments': true } });
    expect(result.code).toBe(0);
    const stored = runtime.store.getAudit(idIn(result.text, 'aud'));
    expect(stored.score.value).not.toBeNull();
    expect(result.text).toContain(String(stored.score.value));
  });

  it('--json prints one parseable document', async () => {
    const { runtime } = tempRuntime();
    const snap = await call('snapshot', runtime, ['demo-google'], { json: true });
    const parsedSnap = JSON.parse(snap.text) as { id: string };
    expect(parsedSnap.id).toMatch(/^snap_/);
    const audited = await call('audit', runtime, ['demo-google'], {
      json: true,
      flags: { snapshot: parsedSnap.id, 'no-judgments': true },
    });
    const parsedAudit = JSON.parse(audited.text) as { id: string; snapshotId: string };
    expect(parsedAudit.id).toMatch(/^aud_/);
    expect(parsedAudit.snapshotId).toBe(parsedSnap.id);
  });

  it('a missing positional throws invalid_input with the usage as hint', async () => {
    const { runtime } = tempRuntime();
    for (const name of Object.keys(workCommands)) {
      const error = await call(name, runtime, []).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(AutopilotError);
      expect((error as AutopilotError).code).toBe('invalid_input');
      expect((error as AutopilotError).hint).toContain(`autopilot-marketing ${name} <`);
    }
  });

  it('rejects a non-integer --days and a malformed --csv', async () => {
    const { runtime } = tempRuntime();
    await expect(call('snapshot', runtime, ['demo-google'], { flags: { days: 'x' } })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(call('snapshot', runtime, ['demo-google'], { flags: { csv: ['nope'] } })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('plan from an audit prints a review and the plan id', async () => {
    const { runtime } = tempRuntime();
    const { auditId, planId, review } = await auditAndPlan(runtime);
    const plan = runtime.store.getPlan(planId);
    expect(plan.createdBy).toBe('cli');
    expect(plan.title).toBe(`Plan from audit ${auditId}`);
    expect(review).toContain(`Plan: ${planId}`);
    const preview = await call('preview', runtime, [planId]);
    expect(preview.text).toContain(planId);
  });

  it('approve refuses without a TTY and makes no receipt', async () => {
    const { runtime } = tempRuntime({ config: { autonomy: 'approve' } });
    const { planId } = await auditAndPlan(runtime);
    const io = fakeIo({ answer: true });
    await expect(call('approve', runtime, [planId], { io })).rejects.toMatchObject({ code: 'approval_required' });
    expect(io.questions).toEqual([]);
    expect(runtime.store.findReceipts(planId)).toEqual([]);
  });

  it('approve with yes issues a receipt and logs it', async () => {
    const { runtime } = tempRuntime({ config: { autonomy: 'approve' } });
    const { planId } = await auditAndPlan(runtime);
    const io = fakeIo({ tty: true, answer: true });
    const result = await call('approve', runtime, [planId], { io });
    expect(result.code).toBe(0);
    expect(io.questions).toEqual(['Approve exactly these changes? [y/N] ']);
    const receipts = runtime.store.findReceipts(planId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.method).toBe('tty');
    expect(result.text).toContain(receipts[0]?.id ?? 'missing');
    expect(result.text).toContain(`Now run: autopilot-marketing apply ${planId} --live`);
    const logged = runtime.ledger.read().filter((entry) => entry.event === 'plan.approved');
    expect(logged).toHaveLength(1);
    expect(logged[0]?.actor.kind).toBe('human');
    expect(logged[0]?.data?.receiptId).toBe(receipts[0]?.id);
  });

  it('approve with no rejects the plan', async () => {
    const { runtime } = tempRuntime({ config: { autonomy: 'approve' } });
    const { planId } = await auditAndPlan(runtime);
    const result = await call('approve', runtime, [planId], { io: fakeIo({ tty: true, answer: false }) });
    expect(result.code).toBe(1);
    expect(runtime.store.getPlan(planId).status).toBe('rejected');
    expect(runtime.store.findReceipts(planId)).toEqual([]);
    expect(runtime.ledger.read().some((entry) => entry.event === 'plan.rejected')).toBe(true);
  });

  it('a plan the policy denies (autonomy propose) is not approvable', async () => {
    const { runtime } = tempRuntime();
    const { planId } = await auditAndPlan(runtime);
    const io = fakeIo({ tty: true, answer: true });
    const result = await call('approve', runtime, [planId], { io });
    expect(result.code).toBe(1);
    expect(io.questions).toEqual([]);
    expect(result.text).toContain('policy denies');
    expect(runtime.store.findReceipts(planId)).toEqual([]);
  });

  it('apply without --live changes nothing', async () => {
    const { runtime } = tempRuntime({ config: { autonomy: 'approve' } });
    const { planId } = await auditAndPlan(runtime);
    const result = await call('apply', runtime, [planId]);
    expect(result.text).toContain('Nothing was changed. Add --live to apply after approval.');
    expect(result.text).toContain('Applied: 0');
  });

  it('review returns 1 unless approved', async () => {
    const { runtime } = tempRuntime();
    const result = await call('review', runtime, ['plan_0000000000000000'], { flags: { port: '0' } });
    expect(result.code).toBe(1);
    expect(result.text).toContain('http://127.0.0.1:1/token/');
    expect(result.text).toContain('Open it in your browser to approve or reject.');
    expect(result.text).toContain('rejected');
  });

  it('run exits 0 and prints what to do next', async () => {
    const { runtime } = tempRuntime();
    const result = await call('run', runtime, ['demo-google']);
    expect(result.code).toBe(0);
    expect(result.text).toContain('Score: ');
    expect(result.text).toMatch(/Findings: \d+/);
    expect(result.text).toMatch(/Next: \S+/);
    expect(result.text).toContain('Applied: nothing');
    expect(result.text).toMatch(/Plan: plan_[0-9a-f]{16}/);
  });

  // A real cycle that stopped for approval, with the apply result replaced by `over`.
  async function runWith(over: (cycle: CycleResult) => Partial<CycleResult>): Promise<{ code: number; text: string }> {
    const { runtime } = tempRuntime();
    const actual = await vi.importActual<typeof import('../../src/ops/plans')>('../../src/ops/plans');
    const cycle = await actual.runCycle(runtime, { accountId: 'demo-google' });
    vi.mocked(runCycle).mockResolvedValueOnce({ ...cycle, ...over(cycle) });
    return call('run', runtime, ['demo-google'], { json: true });
  }

  function outcomeOf(cycle: CycleResult, counts: Partial<ApplyOutcome>): ApplyOutcome {
    if (cycle.plan === null) throw new Error('the demo cycle made no plan');
    return {
      plan: cycle.plan,
      dryRun: false,
      executionId: 'exec_1',
      applied: 0,
      failed: 0,
      skipped: 0,
      unknown: 0,
      results: [],
      ledgerSeqs: [],
      ...counts,
    };
  }

  it('run exits 1 when the automatic apply has failed or unknown actions', async () => {
    const failed = await runWith((cycle) => ({ outcome: outcomeOf(cycle, { applied: 1, failed: 1 }) }));
    expect(failed.code).toBe(1);
    const unknown = await runWith((cycle) => ({ outcome: outcomeOf(cycle, { unknown: 1 }) }));
    expect(unknown.code).toBe(1);
    const clean = await runWith((cycle) => ({ outcome: outcomeOf(cycle, { applied: 2 }) }));
    expect(clean.code).toBe(0);
  });

  it('run exits 1 and reports the error when the automatic apply threw', async () => {
    const result = await runWith(() => ({
      applyError: 'connector unreachable',
      next: 'The plan was not applied: connector unreachable',
    }));
    expect(result.code).toBe(1);
    expect(JSON.parse(result.text)).toMatchObject({ outcome: null, applyError: 'connector unreachable' });
  });

  it('run exits 0 with a null applyError when the plan only awaits approval', async () => {
    const result = await runWith(() => ({}));
    expect(result.code).toBe(0);
    expect(JSON.parse(result.text)).toMatchObject({ outcome: null, applyError: null });
  });
});
