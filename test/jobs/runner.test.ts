import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/core/config';
import { AutopilotError } from '../../src/core/errors';
import { createRuntime } from '../../src/core/runtime';
import type { AutopilotConfig, ScheduleConfig } from '../../src/core/types';
import { runDue, scheduleOverview } from '../../src/jobs/runner';
import { takeSnapshot } from '../../src/ops/data';
import { runCycle } from '../../src/ops/plans';
import { tempRuntime } from '../helpers/runtime';

vi.mock('../../src/ops/plans', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ops/plans')>();
  return { ...actual, runCycle: vi.fn(actual.runCycle) };
});
vi.mock('../../src/ops/data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ops/data')>();
  return { ...actual, takeSnapshot: vi.fn(actual.takeSnapshot) };
});

const DAY_MS = 86_400_000;
const daily: ScheduleConfig = { id: 'daily-google', accountId: 'demo-google', task: 'audit', every: '1d' };

function setup(config: Partial<AutopilotConfig> = { schedules: [daily] }) {
  const clock = { now: new Date('2026-03-10T12:00:00Z') };
  const offline = (async () => {
    throw new Error('no network in tests');
  }) as unknown as typeof fetch;
  const { runtime, home } = tempRuntime({ config, now: () => new Date(clock.now), fetch: offline });
  return { runtime, home, clock };
}

describe('runDue', () => {
  it('enqueues and runs the latest slot once, then compares with the previous run', async () => {
    const { runtime, clock } = setup();

    const first = await runDue(runtime);
    expect(first.enqueued).toHaveLength(1);
    expect(first.ran).toHaveLength(1);
    const job = first.ran[0]!;
    expect(job.state).toBe('succeeded');
    expect(job.result?.snapshotId).toBeTruthy();
    expect(job.result?.auditId).toBeTruthy();
    expect(typeof job.result?.score).toBe('number');
    expect(job.result?.summary).toMatch(/^Score \d+\/100, \d+ finding\(s\)$/);
    expect(job.attention.length).toBeGreaterThan(0);
    expect(first.attention).toBe(true);

    const second = await runDue(runtime);
    expect(second.enqueued).toEqual([]);
    expect(second.ran).toEqual([]);
    expect(second.attention).toBe(false);

    clock.now = new Date(clock.now.getTime() + DAY_MS);
    const third = await runDue(runtime);
    expect(third.enqueued).toHaveLength(1);
    expect(third.ran).toHaveLength(1);
    expect(third.ran[0]!.id).not.toBe(job.id);
    expect(third.ran[0]!.state).toBe('succeeded');
    expect(third.ran[0]!.attention.some((line) => line.includes('new critical or high'))).toBe(false);
  });

  it('runs a report schedule', async () => {
    const { runtime } = setup({ schedules: [{ ...daily, id: 'weekly-report', task: 'report', every: '7d' }] });
    const tick = await runDue(runtime);
    expect(tick.ran[0]!.state).toBe('succeeded');
    expect(tick.ran[0]!.result?.snapshotId).toBeTruthy();
    expect(tick.ran[0]!.result?.summary?.length).toBeGreaterThan(0);
    expect(tick.ran[0]!.result?.summary?.length).toBeLessThanOrEqual(200);
  });

  it('runs a cycle under autonomy propose after reconciling', async () => {
    const { runtime } = setup({ schedules: [{ ...daily, id: 'cycle-google', task: 'cycle' }] });
    const reconcile = vi.fn(async () => ['An earlier run was interrupted: check campaign c1.']);
    const tick = await runDue(runtime, { reconcile });
    const job = tick.ran[0]!;
    expect(reconcile).toHaveBeenCalledWith('demo-google');
    expect(job.state).toBe('succeeded');
    expect(job.result?.planId).toBeTruthy();
    expect(job.result?.next).toBeTruthy();
    expect(job.attention[0]).toBe('An earlier run was interrupted: check campaign c1.');
    expect(job.attention.some((line) => line.includes('waiting for approval'))).toBe(false);
  });

  it('keeps going when reconcile fails, and fails the cycle on stale_state', async () => {
    const { runtime, clock } = setup({ schedules: [{ ...daily, id: 'cycle-google', task: 'cycle' }] });
    const broken = await runDue(runtime, {
      reconcile: async () => {
        throw new Error('ledger unreadable');
      },
    });
    expect(broken.ran[0]!.state).toBe('succeeded');
    expect(broken.ran[0]!.attention).toContain('Reconciliation failed: ledger unreadable');

    clock.now = new Date(clock.now.getTime() + DAY_MS);
    const stale = await runDue(runtime, {
      reconcile: async () => {
        throw new AutopilotError('stale_state', 'the account changed underneath', { retryable: true });
      },
    });
    expect(stale.ran[0]!.state).toBe('failed');
    expect(stale.ran[0]!.attention).toEqual(['Job failed: the account changed underneath']);
  });

  it('skips a job whose schedule changed after it was queued', async () => {
    const { runtime, home, clock } = setup();
    const queued = await runDue(runtime, { maxJobs: 0 });
    expect(queued.enqueued).toHaveLength(1);
    expect(queued.ran).toEqual([]);

    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ ...defaultConfig(), schedules: [{ ...daily, days: 7 }] }),
    );
    const changed = createRuntime({ env: { AUTOPILOT_HOME: home }, now: () => new Date(clock.now) });
    const tick = await runDue(changed);
    expect(tick.enqueued).toHaveLength(1);
    const old = tick.ran.find((job) => job.id === queued.enqueued[0]);
    expect(old?.state).toBe('skipped');
    expect(old?.error).toBe('the schedule changed after this run was queued');
    const fresh = tick.ran.find((job) => job.id === tick.enqueued[0]);
    expect(fresh?.state).toBe('succeeded');
    expect(fresh?.input.days).toBe(7);
  });

  it('skips a job of a removed schedule', async () => {
    const { runtime, home, clock } = setup();
    await runDue(runtime, { maxJobs: 0 });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ ...defaultConfig(), schedules: [{ ...daily, enabled: false }] }));
    const disabled = createRuntime({ env: { AUTOPILOT_HOME: home }, now: () => new Date(clock.now) });
    const tick = await runDue(disabled);
    expect(tick.enqueued).toEqual([]);
    expect(tick.ran[0]!.state).toBe('skipped');
    expect(tick.ran[0]!.error).toBe('the schedule was removed or disabled');
  });

  it('skips an older slot when a newer run exists', async () => {
    const { runtime, clock } = setup();
    const queued = await runDue(runtime, { maxJobs: 0 });
    clock.now = new Date(clock.now.getTime() + DAY_MS);
    const tick = await runDue(runtime);
    expect(tick.ran).toHaveLength(2);
    const old = tick.ran.find((job) => job.id === queued.enqueued[0]);
    expect(old?.state).toBe('skipped');
    expect(old?.error).toBe('a newer run of this schedule replaced it');
    expect(tick.ran.find((job) => job.id === tick.enqueued[0])?.state).toBe('succeeded');
  });

  it('fails a job whose task throws, and retries only a retryable read', async () => {
    const { runtime, clock } = setup();
    const connector = vi.spyOn(runtime, 'connector').mockImplementation(() => {
      throw new AutopilotError('invalid_input', 'the account id is malformed');
    });
    const tick = await runDue(runtime);
    const job = tick.ran[0]!;
    expect(job.state).toBe('failed');
    expect(job.attempts).toBe(1);
    expect(job.attention).toEqual(['Job failed: the account id is malformed']);
    expect(tick.attention).toBe(true);
    expect((await runDue(runtime)).ran).toEqual([]);

    clock.now = new Date(clock.now.getTime() + DAY_MS);
    connector.mockImplementation(() => {
      throw new AutopilotError('rate_limited', 'slow down');
    });
    const retried = await runDue(runtime);
    expect(retried.ran).toHaveLength(1);
    expect(retried.ran[0]!.state).toBe('queued');
    expect(retried.ran[0]!.error).toBe('slow down');
    expect(Date.parse(retried.ran[0]!.runAfter)).toBe(clock.now.getTime() + 60_000);
    expect(retried.attention).toBe(false);

    connector.mockRestore();
    expect((await runDue(runtime)).ran).toEqual([]);
    clock.now = new Date(clock.now.getTime() + 60_000);
    const again = await runDue(runtime);
    expect(again.ran[0]!.state).toBe('succeeded');
    expect(again.ran[0]!.attempts).toBe(2);
  });

  it('gives a cycle a guard that refuses once the claim is lost', async () => {
    const { runtime } = setup({ schedules: [{ ...daily, id: 'cycle-google', task: 'cycle' }] });
    const real = (await vi.importActual<typeof import('../../src/ops/plans')>('../../src/ops/plans')).runCycle;
    let thrown: unknown;
    let ownedCallThrew = true;
    vi.mocked(runCycle).mockImplementationOnce(async (rt, input) => {
      const cycle = await real(rt, input);
      const guard = input.guard!;
      guard();
      ownedCallThrew = false;
      vi.spyOn(runtime.jobs, 'heartbeat').mockReturnValue(false);
      try {
        guard();
      } catch (error) {
        thrown = error;
      }
      return cycle;
    });

    const tick = await runDue(runtime);
    const input = vi.mocked(runCycle).mock.calls.at(-1)![1];
    expect(input.accountId).toBe('demo-google');
    expect(typeof input.guard).toBe('function');
    expect(ownedCallThrew).toBe(false);
    expect(thrown).toBeInstanceOf(AutopilotError);
    expect((thrown as AutopilotError).code).toBe('stale_state');
    expect(() => input.guard!()).toThrow('lost its job claim');
    // A run that lost its claim stores nothing.
    expect(tick.ran).toEqual([]);
    expect(runtime.jobs.get(tick.enqueued[0]!).state).toBe('running');
    vi.restoreAllMocks();
  });

  it('refuses through the guard past the run limit without extending the claim', async () => {
    const { runtime } = setup({ schedules: [{ ...daily, id: 'cycle-google', task: 'cycle' }] });
    const heartbeat = vi.spyOn(runtime.jobs, 'heartbeat');
    vi.mocked(runCycle).mockImplementationOnce(async (_rt, input) => {
      input.guard!();
      throw new Error('unreachable');
    });
    const tick = await runDue(runtime, { maxRunSeconds: -1 });
    expect(heartbeat).not.toHaveBeenCalled();
    expect(tick.ran[0]!.state).toBe('failed');
    expect(tick.ran[0]!.error).toContain('lost its job claim');
    vi.restoreAllMocks();
  });

  it('reports a reclaimed cycle as failed, with what reconciling found', async () => {
    const { runtime, clock } = setup({ schedules: [{ ...daily, id: 'cycle-google', task: 'cycle' }] });
    const queued = await runDue(runtime, { maxJobs: 0 });
    expect(runtime.jobs.claimDue('dead-worker', clock.now, 600)?.id).toBe(queued.enqueued[0]);

    clock.now = new Date(clock.now.getTime() + 601_000);
    const tick = await runDue(runtime, { reconcile: async () => ['check campaign c1.'] });
    expect(tick.reclaimed).toEqual(queued.enqueued);
    expect(tick.ran.map((job) => [job.id, job.state])).toEqual([[queued.enqueued[0], 'failed']]);
    expect(tick.ran[0]!.attention.length).toBeGreaterThan(0);
    expect(tick.notes).toEqual(['demo-google: check campaign c1.']);
    expect(tick.attention).toBe(true);
  });

  it('notes a reconcile that throws for a reclaimed cycle', async () => {
    const { runtime, clock } = setup({ schedules: [{ ...daily, id: 'cycle-google', task: 'cycle' }] });
    await runDue(runtime, { maxJobs: 0 });
    runtime.jobs.claimDue('dead-worker', clock.now, 600);
    clock.now = new Date(clock.now.getTime() + 601_000);
    const tick = await runDue(runtime, {
      reconcile: async () => {
        throw new Error('ledger unreadable');
      },
    });
    expect(tick.notes).toEqual(['demo-google: reconciliation failed: ledger unreadable']);
    expect(tick.attention).toBe(true);
  });

  it('skips a job queued under another time zone and queues its replacement', async () => {
    const zoned = (timezone: string) => ({
      schedules: [daily],
      accounts: defaultConfig().accounts.map((account) =>
        account.id === 'demo-google' ? { ...account, timezone } : account,
      ),
    });
    const { runtime, home, clock } = setup(zoned('UTC'));
    const queued = await runDue(runtime, { maxJobs: 0 });
    expect(queued.enqueued).toHaveLength(1);

    writeFileSync(join(home, 'config.json'), JSON.stringify({ ...defaultConfig(), ...zoned('Etc/GMT') }));
    const moved = createRuntime({ env: { AUTOPILOT_HOME: home }, now: () => new Date(clock.now) });
    const tick = await runDue(moved);
    expect(tick.enqueued).toHaveLength(1);
    expect(tick.enqueued[0]).not.toBe(queued.enqueued[0]);
    expect(runtime.jobs.get(tick.enqueued[0]!).dueAt).toBe(runtime.jobs.get(queued.enqueued[0]!).dueAt);
    const old = tick.ran.find((job) => job.id === queued.enqueued[0]);
    expect(old?.state).toBe('skipped');
    expect(old?.error).toBe('the schedule changed after this run was queued');
    expect(tick.ran.find((job) => job.id === tick.enqueued[0])?.state).toBe('succeeded');
  });

  it('runs the replacement when the old-zone job has a later slot', async () => {
    const now = (): Date => new Date('2026-10-04T08:00:00Z');
    const at7: ScheduleConfig = { ...daily, at: '07:00' };
    const zoned = (timezone: string) => ({
      schedules: [at7],
      accounts: defaultConfig().accounts.map((account) =>
        account.id === 'demo-google' ? { ...account, timezone } : account,
      ),
    });
    const { runtime, home } = tempRuntime({ config: zoned('UTC'), now });
    const first = await runDue(runtime);
    expect(first.ran).toHaveLength(1);
    expect(first.ran[0]!.dueAt).toBe('2026-10-04T07:00:00.000Z');
    expect(first.ran[0]!.state).toBe('succeeded');

    writeFileSync(join(home, 'config.json'), JSON.stringify({ ...defaultConfig(), ...zoned('America/New_York') }));
    const moved = createRuntime({ env: { AUTOPILOT_HOME: home }, now });
    const tick = await runDue(moved);
    expect(tick.enqueued).toHaveLength(1);
    expect(tick.ran).toHaveLength(1);
    expect(tick.ran[0]!.id).toBe(tick.enqueued[0]);
    expect(tick.ran[0]!.dueAt).toBe('2026-10-03T11:00:00.000Z');
    expect(tick.ran[0]!.state).toBe('succeeded');
  });

  it('does not report a requeued job that another worker then fails', async () => {
    const { runtime, clock } = setup();
    const queued = await runDue(runtime, { maxJobs: 0 });
    const id = queued.enqueued[0]!;
    expect(runtime.jobs.claimDue('dead-worker', clock.now, 600)?.id).toBe(id);
    clock.now = new Date(clock.now.getTime() + 601_000);

    const reclaim = runtime.jobs.reclaim.bind(runtime.jobs);
    vi.spyOn(runtime.jobs, 'reclaim').mockImplementationOnce((now, maxAttempts) => {
      const reclaimed = reclaim(now, maxAttempts);
      const theirs = runtime.jobs.claimDue('other-worker', clock.now, 600);
      expect(theirs?.id).toBe(id);
      expect(runtime.jobs.finish(theirs!, clock.now, { state: 'failed', error: 'boom', attention: ['Job failed: boom'] })).toBe(true);
      return reclaimed;
    });
    const tick = await runDue(runtime);
    expect(tick.reclaimed).toEqual([id]);
    expect(tick.ran).toEqual([]);
    expect(tick.attention).toBe(false);
    expect(runtime.jobs.get(id).state).toBe('failed');
    vi.restoreAllMocks();
  });

  it('reports a requeued job once when this pass claims and ends it', async () => {
    const { runtime, clock } = setup();
    const queued = await runDue(runtime, { maxJobs: 0 });
    const id = queued.enqueued[0]!;
    runtime.jobs.claimDue('dead-worker', clock.now, 600);
    clock.now = new Date(clock.now.getTime() + 601_000);

    const idle = await runDue(runtime, { maxJobs: 0 });
    expect(idle.reclaimed).toEqual([id]);
    expect(idle.ran).toEqual([]);
    expect(runtime.jobs.get(id).state).toBe('queued');

    runtime.jobs.claimDue('dead-worker', clock.now, 600);
    clock.now = new Date(clock.now.getTime() + 601_000);
    const tick = await runDue(runtime);
    expect(tick.reclaimed).toEqual([id]);
    expect(tick.ran.map((job) => [job.id, job.state])).toEqual([[id, 'succeeded']]);
  });

  it('retries an audit whose snapshot is empty, then fails it with attention', async () => {
    const { runtime, clock } = setup();
    const real = (await vi.importActual<typeof import('../../src/ops/data')>('../../src/ops/data')).takeSnapshot;
    vi.mocked(takeSnapshot).mockImplementation(async (rt, input) => ({
      ...(await real(rt, input)),
      datasets: {},
      warnings: ['campaigns: the read timed out'],
    }));
    try {
      const first = await runDue(runtime);
      expect(first.ran[0]!.state).toBe('queued');
      expect(first.ran[0]!.error).toContain('has no data: campaigns: the read timed out');
      expect(Date.parse(first.ran[0]!.runAfter)).toBe(clock.now.getTime() + 60_000);
      expect(first.attention).toBe(false);

      clock.now = new Date(clock.now.getTime() + 60_000);
      const second = await runDue(runtime);
      expect(second.ran[0]!.state).toBe('queued');
      expect(Date.parse(second.ran[0]!.runAfter)).toBe(clock.now.getTime() + 300_000);

      clock.now = new Date(clock.now.getTime() + 300_000);
      const third = await runDue(runtime);
      expect(third.ran[0]!.state).toBe('failed');
      expect(third.ran[0]!.attempts).toBe(3);
      expect(third.ran[0]!.attention[0]).toMatch(/^Job failed: The snapshot of demo-google has no data/);
      expect(third.attention).toBe(true);
    } finally {
      vi.mocked(takeSnapshot).mockImplementation(real);
    }
  });
});

describe('scheduleOverview', () => {
  it('lists every schedule whose account exists', async () => {
    const { runtime, clock } = setup({
      schedules: [daily, { ...daily, id: 'off', enabled: false }],
    });
    // The config loader rejects a schedule without an account; one can still appear in memory.
    runtime.config.schedules?.push({ ...daily, id: 'orphan', accountId: 'nobody' });
    const before = scheduleOverview(runtime);
    expect(before.map((entry) => entry.schedule.id)).toEqual(['daily-google', 'off']);
    expect(Date.parse(before[0]!.nextDueAt)).toBeGreaterThan(clock.now.getTime());
    expect(before[0]!.lastJob).toBeNull();

    const tick = await runDue(runtime);
    expect(tick.enqueued).toHaveLength(1);
    expect(scheduleOverview(runtime)[0]!.lastJob?.id).toBe(tick.ran[0]!.id);
  });
});
