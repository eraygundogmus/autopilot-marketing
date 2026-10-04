import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/core/db';
import { openDatabase } from '../../src/core/db';
import { AutopilotError } from '../../src/core/errors';
import type { Job, JobQueue, JobTask, NewJob, Paths } from '../../src/core/types';
import { createJobQueue } from '../../src/jobs/queue';

const dirs: string[] = [];
const handles: Db[] = [];

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'apm-'));
  dirs.push(dir);
  return join(dir, 'state.db');
}

function open(file: string): Db {
  const db = openDatabase({ db: file } as Paths);
  handles.push(db);
  return db;
}

function jobId(n: number): string {
  return `job_${n.toString(16).padStart(16, '0')}`;
}

function newJob(n: number, dueAt: string, extra: Partial<NewJob> = {}): NewJob {
  return { id: jobId(n), scheduleId: 'daily', accountId: 'demo-google', task: 'audit', dueAt, input: { days: 30 }, ...extra };
}

const at = (iso: string): Date => new Date(iso);

function claim(queue: JobQueue, workerId: string, now: Date, ttlSeconds = 60): Job {
  const job = queue.claimDue(workerId, now, ttlSeconds);
  if (job === null) throw new Error('expected a due job');
  return job;
}
const NOW = at('2026-03-10T12:00:00.000Z');

afterEach(() => {
  for (const db of handles.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('createJobQueue', () => {
  it('inserts a job once', () => {
    const queue = createJobQueue(open(tempFile()));
    const job = newJob(1, '2026-03-10T08:00:00.000Z');
    expect(queue.enqueue(job, NOW)).toBe(true);
    expect(queue.enqueue({ ...job, input: { days: 7 } }, NOW)).toBe(false);
    expect(queue.list()).toHaveLength(1);
    expect(queue.get(job.id)).toMatchObject({
      state: 'queued',
      attempts: 0,
      attention: [],
      input: { days: 30 },
      claimedBy: null,
      createdAt: NOW.toISOString(),
    });
  });

  it('rejects a malformed id and reports a missing job', () => {
    const queue = createJobQueue(open(tempFile()));
    expect(() => queue.enqueue({ ...newJob(1, NOW.toISOString()), id: 'job_1' }, NOW)).toThrowError(
      expect.objectContaining({ code: 'invalid_input' }),
    );
    let caught: unknown;
    try {
      queue.get(jobId(9));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AutopilotError);
    expect((caught as AutopilotError).code).toBe('not_found');
  });

  it('claims in order of due time and skips jobs due in the future', () => {
    const queue = createJobQueue(open(tempFile()));
    queue.enqueue(newJob(1, '2026-03-10T11:00:00.000Z'), NOW);
    queue.enqueue(newJob(2, '2026-03-10T09:00:00.000Z'), NOW);
    queue.enqueue(newJob(3, '2026-03-10T09:00:00.000Z'), NOW);
    queue.enqueue(newJob(4, '2026-03-10T12:00:00.001Z'), NOW);

    const first = queue.claimDue('w1', NOW, 60);
    expect(first).toMatchObject({
      id: jobId(2),
      state: 'running',
      attempts: 1,
      claimedBy: 'w1',
      claimedUntil: '2026-03-10T12:01:00.000Z',
      startedAt: NOW.toISOString(),
    });
    expect(queue.claimDue('w1', NOW, 60)?.id).toBe(jobId(3));
    expect(queue.claimDue('w1', NOW, 60)?.id).toBe(jobId(1));
    expect(queue.claimDue('w1', NOW, 60)).toBeNull();
    expect(queue.get(jobId(4)).state).toBe('queued');
  });

  it('gives one due job to exactly one of two handles', () => {
    const file = tempFile();
    const a = createJobQueue(open(file));
    const b = createJobQueue(open(file));
    a.enqueue(newJob(1, '2026-03-10T08:00:00.000Z'), NOW);
    const claims = [a.claimDue('wa', NOW, 60), b.claimDue('wb', NOW, 60)];
    expect(claims.filter((job) => job !== null)).toHaveLength(1);
    expect(b.get(jobId(1))).toMatchObject({ claimedBy: 'wa', attempts: 1 });
  });

  it('ignores heartbeat and finish from another worker', () => {
    const queue = createJobQueue(open(tempFile()));
    queue.enqueue(newJob(1, '2026-03-10T08:00:00.000Z'), NOW);
    const claimed = claim(queue, 'w1', NOW);
    const other: Job = { ...claimed, claimedBy: 'w2' };
    const before = queue.get(jobId(1));
    const later = at('2026-03-10T12:00:30.000Z');

    expect(queue.heartbeat(other, later, 60)).toBe(false);
    expect(queue.finish(other, later, { state: 'succeeded', result: { score: 80 }, attention: ['x'] })).toBe(false);
    expect(queue.finish(other, later, { state: 'queued', error: 'e', retryAt: later.toISOString() })).toBe(false);
    expect(queue.finish({ ...claimed, claimedBy: null }, later, { state: 'skipped', reason: 'r' })).toBe(false);
    expect(queue.get(jobId(1))).toEqual(before);

    expect(queue.heartbeat(claimed, later, 60)).toBe(true);
    expect(queue.get(jobId(1)).claimedUntil).toBe('2026-03-10T12:01:30.000Z');
    expect(
      queue.finish(claimed, later, {
        state: 'succeeded',
        result: { score: 80, summary: 'ok' },
        attention: ['score dropped'],
      }),
    ).toBe(true);
    const done = queue.get(jobId(1));
    expect(done).toMatchObject({
      state: 'succeeded',
      finishedAt: later.toISOString(),
      claimedBy: null,
      claimedUntil: null,
      result: { score: 80, summary: 'ok' },
      attention: ['score dropped'],
    });
    expect(done).not.toHaveProperty('hook');
    expect(queue.heartbeat(claimed, later, 60)).toBe(false);
    expect(queue.finish(claimed, later, { state: 'failed', error: 'late', attention: [] })).toBe(false);
  });

  it('refuses a stale attempt even when the same worker id claimed the job again', () => {
    const queue = createJobQueue(open(tempFile()));
    queue.enqueue(newJob(1, '2026-03-10T08:00:00.000Z'), NOW);
    const first = claim(queue, 'w1', NOW);
    const expired = at('2026-03-10T12:02:00.000Z');
    expect(queue.reclaim(expired).map((job) => job.state)).toEqual(['queued']);
    expect(queue.heartbeat(first, expired, 60)).toBe(false);

    const second = claim(queue, 'w1', expired);
    expect(second).toMatchObject({ id: first.id, claimedBy: 'w1', attempts: 2 });
    const before = queue.get(jobId(1));
    const later = at('2026-03-10T12:02:30.000Z');

    expect(queue.heartbeat(first, later, 600)).toBe(false);
    expect(queue.finish(first, later, { state: 'succeeded', result: { score: 1 }, attention: [] })).toBe(false);
    expect(queue.finish(first, later, { state: 'failed', error: 'stale', attention: [] })).toBe(false);
    expect(queue.finish(first, later, { state: 'skipped', reason: 'stale' })).toBe(false);
    expect(queue.finish(first, later, { state: 'queued', error: 'stale', retryAt: later.toISOString() })).toBe(false);
    expect(queue.get(jobId(1))).toEqual(before);

    expect(queue.heartbeat(second, later, 60)).toBe(true);
    expect(queue.finish(second, later, { state: 'succeeded', result: { score: 2 }, attention: [] })).toBe(true);
    expect(queue.get(jobId(1))).toMatchObject({ state: 'succeeded', result: { score: 2 }, attempts: 2 });
  });

  it('stores a failure', () => {
    const queue = createJobQueue(open(tempFile()));
    queue.enqueue(newJob(1, '2026-03-10T08:00:00.000Z'), NOW);
    const claimed = claim(queue, 'w1', NOW);
    expect(queue.finish(claimed, NOW, { state: 'failed', error: 'boom', attention: ['failed'] })).toBe(true);
    const job = queue.get(jobId(1));
    expect(job).toMatchObject({ state: 'failed', error: 'boom', attention: ['failed'], finishedAt: NOW.toISOString() });
    expect(job.result).toBeUndefined();
  });

  it('stores the result of a failure that carries one', () => {
    const queue = createJobQueue(open(tempFile()));
    queue.enqueue(newJob(1, '2026-03-10T08:00:00.000Z'), NOW);
    const claimed = claim(queue, 'w1', NOW);
    const result = { planId: 'plan_1', applied: 1, unknown: 2, next: 'check the account' };
    expect(queue.finish(claimed, NOW, { state: 'failed', error: 'partly applied', attention: ['look'], result })).toBe(
      true,
    );
    expect(queue.get(jobId(1))).toMatchObject({ state: 'failed', error: 'partly applied', attention: ['look'], result });
  });

  it('stores a skipped outcome with its reason and no attention', () => {
    const queue = createJobQueue(open(tempFile()));
    queue.enqueue(newJob(1, '2026-03-10T08:00:00.000Z'), NOW);
    const claimed = claim(queue, 'w1', NOW);
    expect(queue.finish(claimed, NOW, { state: 'skipped', reason: 'the schedule changed' })).toBe(true);
    const job = queue.get(jobId(1));
    expect(job).toMatchObject({
      state: 'skipped',
      finishedAt: NOW.toISOString(),
      claimedBy: null,
      claimedUntil: null,
      error: 'the schedule changed',
      attention: [],
    });
    expect(job.result).toBeUndefined();
    expect(queue.list({ state: 'skipped' }).map((item) => item.id)).toEqual([jobId(1)]);
    expect(queue.claimDue('w1', at('2026-03-11T00:00:00.000Z'), 60)).toBeNull();
  });

  it('keeps the fingerprint through storage', () => {
    const queue = createJobQueue(open(tempFile()));
    queue.enqueue(newJob(1, '2026-03-10T08:00:00.000Z', { input: { days: 7, fingerprint: 'abc123' } }), NOW);
    queue.enqueue(newJob(2, '2026-03-10T09:00:00.000Z'), NOW);
    expect(queue.get(jobId(1)).input).toEqual({ days: 7, fingerprint: 'abc123' });
    expect(queue.get(jobId(2)).input).toEqual({ days: 30 });

    const claimed = claim(queue, 'w1', NOW);
    expect(claimed.input).toEqual({ days: 7, fingerprint: 'abc123' });
    queue.finish(claimed, NOW, { state: 'queued', error: 'again', retryAt: NOW.toISOString() });
    const again = claim(queue, 'w1', NOW);
    expect(again.id).toBe(jobId(1));
    queue.finish(again, NOW, { state: 'succeeded', result: { score: 1 }, attention: [] });
    expect(queue.get(jobId(1)).input).toEqual({ days: 7, fingerprint: 'abc123' });
  });

  it('requeues on a retry outcome, keeps the slot time and waits for retryAt', () => {
    const queue = createJobQueue(open(tempFile()));
    const dueAt = '2026-03-10T08:00:00.000Z';
    queue.enqueue(newJob(1, dueAt), NOW);
    expect(queue.get(jobId(1)).runAfter).toBe(dueAt);
    const claimed = claim(queue, 'w1', NOW);
    const retryAt = '2026-03-10T12:05:00.000Z';
    expect(queue.finish(claimed, NOW, { state: 'queued', error: 'rate limited', retryAt })).toBe(true);
    expect(queue.get(jobId(1))).toMatchObject({
      state: 'queued',
      dueAt,
      runAfter: retryAt,
      attempts: 1,
      claimedBy: null,
      claimedUntil: null,
      finishedAt: null,
      error: 'rate limited',
    });
    expect(queue.claimDue('w1', NOW, 60)).toBeNull();
    expect(queue.claimDue('w1', at('2026-03-10T12:04:59.999Z'), 60)).toBeNull();
    expect(queue.claimDue('w2', at(retryAt), 60)).toMatchObject({
      id: jobId(1),
      attempts: 2,
      claimedBy: 'w2',
      dueAt,
      runAfter: retryAt,
    });
  });

  it('reclaims expired claims by task and leaves live ones alone', () => {
    const queue = createJobQueue(open(tempFile()));
    const tasks: JobTask[] = ['audit', 'cycle', 'report'];
    tasks.forEach((task, index) => {
      queue.enqueue(newJob(index + 1, `2026-03-10T08:0${index}:00.000Z`, { task }), NOW);
      queue.claimDue('dead', NOW, 60);
    });
    queue.enqueue(newJob(4, '2026-03-10T08:30:00.000Z', { task: 'cycle' }), NOW);
    queue.claimDue('alive', NOW, 3600);

    expect(queue.reclaim(at('2026-03-10T12:01:00.000Z'))).toEqual([]);

    const later = at('2026-03-10T12:02:00.000Z');
    const changed = queue.reclaim(later);
    expect(changed.map((job) => job.id).sort()).toEqual([jobId(1), jobId(2), jobId(3)]);

    expect(queue.get(jobId(1))).toMatchObject({
      state: 'queued',
      dueAt: '2026-03-10T08:00:00.000Z',
      runAfter: later.toISOString(),
      claimedBy: null,
      claimedUntil: null,
      attempts: 1,
      error: 'worker stopped before the job finished',
      attention: [],
    });
    expect(queue.get(jobId(3)).state).toBe('queued');
    const cycle = queue.get(jobId(2));
    expect(cycle).toMatchObject({ state: 'failed', finishedAt: later.toISOString(), claimedBy: null });
    expect(cycle.error).toMatch(/^interrupted: the worker stopped while the cycle was running/);
    expect(cycle.attention).toEqual([cycle.error]);
    expect(queue.get(jobId(4))).toMatchObject({ state: 'running', claimedBy: 'alive' });
    expect(queue.reclaim(later)).toEqual([]);
  });

  it('fails an audit job that was reclaimed at the attempt limit', () => {
    const queue = createJobQueue(open(tempFile()));
    queue.enqueue(newJob(1, '2026-03-10T08:00:00.000Z'), NOW);
    let now = NOW;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      expect(claim(queue, 'w1', now).attempts).toBe(attempt);
      now = new Date(now.getTime() + 120_000);
      expect(queue.reclaim(now).map((job) => job.state)).toEqual(['queued']);
    }
    expect(claim(queue, 'w1', now).attempts).toBe(3);
    now = new Date(now.getTime() + 120_000);
    const changed = queue.reclaim(now);
    const limit = 'worker stopped before the job finished; attempt limit reached';
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
      id: jobId(1),
      state: 'failed',
      finishedAt: now.toISOString(),
      claimedBy: null,
      claimedUntil: null,
      attempts: 3,
      error: limit,
      attention: [limit],
    });
    expect(queue.claimDue('w1', at('2026-03-11T00:00:00.000Z'), 60)).toBeNull();

    queue.enqueue(newJob(2, '2026-03-10T08:00:00.000Z', { task: 'report' }), NOW);
    claim(queue, 'w1', NOW);
    expect(queue.reclaim(at('2026-03-10T12:02:00.000Z'), 1)[0]).toMatchObject({ id: jobId(2), state: 'failed' });
  });

  it('filters and limits the list, newest first', () => {
    const queue = createJobQueue(open(tempFile()));
    for (let n = 1; n <= 5; n += 1) {
      queue.enqueue(
        newJob(n, `2026-03-0${n}T08:00:00.000Z`, {
          accountId: n % 2 === 0 ? 'demo-meta' : 'demo-google',
          scheduleId: n === 5 ? null : n < 3 ? 'daily' : 'weekly',
        }),
        NOW,
      );
    }
    queue.claimDue('w1', at('2026-03-01T09:00:00.000Z'), 60);

    expect(queue.list().map((job) => job.id)).toEqual([5, 4, 3, 2, 1].map(jobId));
    expect(queue.list({ limit: 2 }).map((job) => job.id)).toEqual([jobId(5), jobId(4)]);
    expect(queue.list({ limit: 0 })).toHaveLength(1);
    expect(queue.list({ limit: 5000 })).toHaveLength(5);
    expect(queue.list({ accountId: 'demo-meta' }).map((job) => job.id)).toEqual([jobId(4), jobId(2)]);
    expect(queue.list({ scheduleId: 'weekly', accountId: 'demo-google' }).map((job) => job.id)).toEqual([jobId(3)]);
    expect(queue.list({ state: 'running' }).map((job) => job.id)).toEqual([jobId(1)]);
    expect(queue.list({ state: 'succeeded' })).toEqual([]);
    expect(queue.latest('daily')?.id).toBe(jobId(2));
    expect(queue.latest('nope')).toBeNull();
  });

  it('finds the previous succeeded job, skipping failed jobs and later slots', () => {
    const queue = createJobQueue(open(tempFile()));
    const outcomes = ['succeeded', 'succeeded', 'failed', 'queued', 'succeeded'] as const;
    outcomes.forEach((state, index) => {
      const n = index + 1;
      if (state === 'queued') return;
      queue.enqueue(newJob(n, `2026-03-0${n}T08:00:00.000Z`), NOW);
      const claimTime = at(`2026-03-0${n}T08:00:00.000Z`);
      const claimed = claim(queue, 'w1', claimTime);
      expect(claimed.id).toBe(jobId(n));
      queue.finish(
        claimed,
        claimTime,
        state === 'succeeded' ? { state, result: { score: n }, attention: [] } : { state, error: 'x', attention: [] },
      );
    });
    queue.enqueue(newJob(4, '2026-03-04T08:00:00.000Z'), NOW);
    queue.enqueue(newJob(6, '2026-03-01T08:00:00.000Z', { scheduleId: 'other' }), NOW);

    expect(queue.previousSucceeded(queue.get(jobId(4)))?.id).toBe(jobId(2));
    expect(queue.previousSucceeded(queue.get(jobId(2)))?.id).toBe(jobId(1));
    expect(queue.previousSucceeded(queue.get(jobId(1)))).toBeNull();
    expect(queue.previousSucceeded(queue.get(jobId(6)))).toBeNull();
    expect(queue.previousSucceeded({ ...queue.get(jobId(4)), scheduleId: null })).toBeNull();
  });

  it('returns a row with unreadable json instead of throwing', () => {
    const db = open(tempFile());
    const queue = createJobQueue(db);
    queue.enqueue(newJob(1, '2026-03-10T08:00:00.000Z'), NOW);
    db.prepare('UPDATE jobs SET json = ? WHERE id = ?').run('{not json', jobId(1));
    expect(queue.get(jobId(1))).toMatchObject({
      id: jobId(1),
      state: 'queued',
      input: { days: 30 },
      attention: [],
      error: 'stored job data is unreadable',
    });
    expect(queue.list()).toHaveLength(1);
  });
});
