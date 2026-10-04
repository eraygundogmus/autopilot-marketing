import type { Db } from '../core/db';
import { inTransaction } from '../core/db';
import { AutopilotError } from '../core/errors';
import type { Job, JobInput, JobOutcome, JobQueue, JobResult, JobState, JobTask, NewJob } from '../core/types';
import { JOB_TASKS } from '../core/types';

const JOB_ID = /^job_[0-9a-f]{16}$/;
const JOB_STATES: readonly JobState[] = ['queued', 'running', 'succeeded', 'failed', 'skipped'];
const COLUMNS =
  'id, schedule_id, account_id, task, state, due_at, run_after, attempts, claimed_by, claimed_until, started_at, finished_at, created_at, json';
const UNREADABLE = 'stored job data is unreadable';
const STOPPED = 'worker stopped before the job finished';
const STOPPED_FINAL = `${STOPPED}; attempt limit reached`;
const DEFAULT_MAX_ATTEMPTS = 3;
const INTERRUPTED =
  'interrupted: the worker stopped while the cycle was running; it is not retried because it may have applied changes';

interface JobPayload {
  input: JobInput;
  result?: JobResult;
  error?: string;
  attention: string[];
}

type Row = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function unreadablePayload(): JobPayload {
  return { input: { days: 30 }, attention: [], error: UNREADABLE };
}

function parsePayload(raw: unknown): JobPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text(raw));
  } catch {
    return unreadablePayload();
  }
  if (!isRecord(parsed) || !isRecord(parsed.input)) return unreadablePayload();
  const days = parsed.input.days;
  if (typeof days !== 'number' || !Number.isFinite(days)) return unreadablePayload();
  const input: JobInput = { days };
  if (typeof parsed.input.fingerprint === 'string') input.fingerprint = parsed.input.fingerprint;
  const payload: JobPayload = {
    input,
    attention: Array.isArray(parsed.attention)
      ? parsed.attention.filter((item): item is string => typeof item === 'string')
      : [],
  };
  if (isRecord(parsed.result)) payload.result = parsed.result as JobResult;
  if (typeof parsed.error === 'string') payload.error = parsed.error;
  return payload;
}

function toJob(row: Row): Job {
  const payload = parsePayload(row.json);
  const task = JOB_TASKS.find((item) => item === row.task) ?? 'audit';
  const state = JOB_STATES.find((item) => item === row.state) ?? 'failed';
  const job: Job = {
    id: text(row.id),
    scheduleId: nullableText(row.schedule_id),
    accountId: text(row.account_id),
    task,
    state,
    dueAt: text(row.due_at),
    runAfter: text(row.run_after),
    attempts: Number(row.attempts ?? 0),
    claimedBy: nullableText(row.claimed_by),
    claimedUntil: nullableText(row.claimed_until),
    startedAt: nullableText(row.started_at),
    finishedAt: nullableText(row.finished_at),
    createdAt: text(row.created_at),
    input: payload.input,
    attention: payload.attention,
  };
  if (payload.result !== undefined) job.result = payload.result;
  if (payload.error !== undefined) job.error = payload.error;
  return job;
}

function assertJobId(id: unknown): string {
  if (typeof id !== 'string' || !JOB_ID.test(id)) {
    throw new AutopilotError('invalid_input', 'job id must be "job_" followed by 16 hex characters');
  }
  return id;
}

function assertIsoTime(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new AutopilotError('invalid_input', `${label} must be an ISO time such as 2026-01-31T08:00:00.000Z`);
  }
  return value;
}

function claimEnd(now: Date, ttlSeconds: number): string {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new AutopilotError('invalid_input', 'ttlSeconds must be a positive number');
  }
  return new Date(now.getTime() + ttlSeconds * 1000).toISOString();
}

/** The job queue over the `jobs` table of the state database. */
export function createJobQueue(db: Db): JobQueue {
  const readRow = (id: string): Row | undefined =>
    db.prepare(`SELECT ${COLUMNS} FROM jobs WHERE id = ?`).get(id) as Row | undefined;

  const get = (id: string): Job => {
    const row = typeof id === 'string' ? readRow(id) : undefined;
    if (row === undefined) {
      throw new AutopilotError('not_found', 'no job with this id', { hint: 'List the jobs to see the ids that exist.' });
    }
    return toJob(row);
  };

  // One attempt is (id, claimedBy, attempts): `attempts` grows on every claim, so a worker whose
  // claim was reclaimed never matches again, even when the same worker id holds the job now.
  const FENCE = `id = ? AND state = 'running' AND claimed_by = ? AND attempts = ?`;

  const fence = (job: Job): [string, string, number] | undefined => {
    if (!isRecord(job) || typeof job.id !== 'string' || typeof job.claimedBy !== 'string') return undefined;
    if (!Number.isInteger(job.attempts)) return undefined;
    return [job.id, job.claimedBy, job.attempts];
  };

  return {
    enqueue(job: NewJob, now: Date): boolean {
      assertJobId(job.id);
      assertIsoTime(job.dueAt, 'dueAt');
      if (!JOB_TASKS.includes(job.task)) {
        throw new AutopilotError('invalid_input', `task must be one of ${JOB_TASKS.join(', ')}`);
      }
      if (typeof job.accountId !== 'string' || job.accountId === '') {
        throw new AutopilotError('invalid_input', 'accountId is required');
      }
      const days = job.input?.days;
      if (!Number.isInteger(days) || days < 1) {
        throw new AutopilotError('invalid_input', 'input.days must be a positive whole number');
      }
      const fingerprint: unknown = job.input.fingerprint;
      if (fingerprint !== undefined && typeof fingerprint !== 'string') {
        throw new AutopilotError('invalid_input', 'input.fingerprint must be a string');
      }
      const input: JobInput = { days };
      if (fingerprint !== undefined) input.fingerprint = fingerprint;
      const payload: JobPayload = { input, attention: [] };
      const done = db
        .prepare(
          `INSERT OR IGNORE INTO jobs (id, schedule_id, account_id, task, state, due_at, run_after, attempts, created_at, json)
           VALUES (?, ?, ?, ?, 'queued', ?, ?, 0, ?, ?)`,
        )
        .run(job.id, job.scheduleId, job.accountId, job.task, job.dueAt, job.dueAt, now.toISOString(), JSON.stringify(payload));
      return Number(done.changes) === 1;
    },

    reclaim(now: Date, maxAttempts: number = DEFAULT_MAX_ATTEMPTS): Job[] {
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
        throw new AutopilotError('invalid_input', 'maxAttempts must be a positive whole number');
      }
      const nowIso = now.toISOString();
      return inTransaction(db, () => {
        const rows = db
          .prepare(
            `SELECT ${COLUMNS} FROM jobs WHERE state = 'running' AND claimed_until < ? ORDER BY due_at, id`,
          )
          .all(nowIso) as Row[];
        const changed: Job[] = [];
        for (const row of rows) {
          const id = text(row.id);
          const payload = parsePayload(row.json);
          const task: JobTask | undefined = JOB_TASKS.find((item) => item === row.task);
          if (task === 'cycle') {
            payload.error = INTERRUPTED;
            if (!payload.attention.includes(INTERRUPTED)) payload.attention.push(INTERRUPTED);
            db.prepare(
              `UPDATE jobs SET state = 'failed', finished_at = ?, claimed_by = NULL, claimed_until = NULL, json = ?
               WHERE id = ?`,
            ).run(nowIso, JSON.stringify(payload), id);
          } else if (Number(row.attempts ?? 0) < maxAttempts) {
            payload.error = STOPPED;
            db.prepare(
              `UPDATE jobs SET state = 'queued', run_after = ?, claimed_by = NULL, claimed_until = NULL, json = ?
               WHERE id = ?`,
            ).run(nowIso, JSON.stringify(payload), id);
          } else {
            payload.error = STOPPED_FINAL;
            if (!payload.attention.includes(STOPPED_FINAL)) payload.attention.push(STOPPED_FINAL);
            db.prepare(
              `UPDATE jobs SET state = 'failed', finished_at = ?, claimed_by = NULL, claimed_until = NULL, json = ?
               WHERE id = ?`,
            ).run(nowIso, JSON.stringify(payload), id);
          }
          changed.push(get(id));
        }
        return changed;
      });
    },

    claimDue(workerId: string, now: Date, ttlSeconds: number): Job | null {
      if (typeof workerId !== 'string' || workerId === '') {
        throw new AutopilotError('invalid_input', 'workerId is required');
      }
      const nowIso = now.toISOString();
      const until = claimEnd(now, ttlSeconds);
      return inTransaction(db, () => {
        const row = db
          .prepare(`SELECT id FROM jobs WHERE state = 'queued' AND run_after <= ? ORDER BY due_at, id LIMIT 1`)
          .get(nowIso) as Row | undefined;
        if (row === undefined) return null;
        const id = text(row.id);
        db.prepare(
          `UPDATE jobs SET state = 'running', claimed_by = ?, claimed_until = ?, attempts = attempts + 1, started_at = ?
           WHERE id = ? AND state = 'queued'`,
        ).run(workerId, until, nowIso, id);
        return get(id);
      });
    },

    heartbeat(job: Job, now: Date, ttlSeconds: number): boolean {
      const until = claimEnd(now, ttlSeconds);
      const attempt = fence(job);
      if (attempt === undefined) return false;
      const done = db.prepare(`UPDATE jobs SET claimed_until = ? WHERE ${FENCE}`).run(until, ...attempt);
      return Number(done.changes) === 1;
    },

    finish(job: Job, now: Date, outcome: JobOutcome): boolean {
      if (outcome.state === 'queued') assertIsoTime(outcome.retryAt, 'retryAt');
      const attempt = fence(job);
      if (attempt === undefined) return false;
      return inTransaction(db, () => {
        const row = db.prepare(`SELECT json FROM jobs WHERE ${FENCE}`).get(...attempt) as Row | undefined;
        if (row === undefined) return false;
        const stored = parsePayload(row.json);
        if (outcome.state === 'queued') {
          const payload: JobPayload = { input: stored.input, attention: stored.attention, error: outcome.error };
          const done = db
            .prepare(
              `UPDATE jobs SET state = 'queued', run_after = ?, claimed_by = NULL, claimed_until = NULL, json = ?
               WHERE ${FENCE}`,
            )
            .run(outcome.retryAt, JSON.stringify(payload), ...attempt);
          return Number(done.changes) === 1;
        }
        const payload: JobPayload = { input: stored.input, attention: [] };
        if (outcome.state === 'skipped') {
          payload.error = outcome.reason;
        } else {
          payload.attention = [...outcome.attention];
          if (outcome.result !== undefined) payload.result = outcome.result;
          if (outcome.state === 'failed') payload.error = outcome.error;
        }
        const done = db
          .prepare(
            `UPDATE jobs SET state = ?, finished_at = ?, claimed_by = NULL, claimed_until = NULL, json = ?
             WHERE ${FENCE}`,
          )
          .run(outcome.state, now.toISOString(), JSON.stringify(payload), ...attempt);
        return Number(done.changes) === 1;
      });
    },

    get,

    list(filter = {}): Job[] {
      const where: string[] = [];
      const values: string[] = [];
      if (filter.accountId !== undefined) {
        where.push('account_id = ?');
        values.push(filter.accountId);
      }
      if (filter.scheduleId !== undefined) {
        where.push('schedule_id = ?');
        values.push(filter.scheduleId);
      }
      if (filter.state !== undefined) {
        where.push('state = ?');
        values.push(filter.state);
      }
      const asked = filter.limit;
      const limit =
        asked === undefined || !Number.isFinite(asked) ? 20 : Math.min(200, Math.max(1, Math.trunc(asked)));
      const rows = db
        .prepare(
          `SELECT ${COLUMNS} FROM jobs ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
           ORDER BY due_at DESC, id DESC LIMIT ?`,
        )
        .all(...values, limit) as Row[];
      return rows.map(toJob);
    },

    latest(scheduleId: string): Job | null {
      const row = db
        .prepare(`SELECT ${COLUMNS} FROM jobs WHERE schedule_id = ? ORDER BY due_at DESC, id DESC LIMIT 1`)
        .get(scheduleId) as Row | undefined;
      return row === undefined ? null : toJob(row);
    },

    previousSucceeded(job: Job): Job | null {
      if (job.scheduleId === null) return null;
      const row = db
        .prepare(
          `SELECT ${COLUMNS} FROM jobs WHERE schedule_id = ? AND state = 'succeeded' AND due_at < ?
           ORDER BY due_at DESC, id DESC LIMIT 1`,
        )
        .get(job.scheduleId, job.dueAt) as Row | undefined;
      return row === undefined ? null : toJob(row);
    },
  };
}
