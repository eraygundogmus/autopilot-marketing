import { randomBytes } from 'node:crypto';
import { AutopilotError } from '../core/errors';
import { digest, shortId } from '../core/ids';
import { redact } from '../core/redact';
import type { AuditReport, Job, JobOutcome, JobResult, Runtime, ScheduleConfig, Snapshot } from '../core/types';
import { auditSnapshot } from '../ops/audit';
import { kpiReport, takeSnapshot } from '../ops/data';
import { runCycle } from '../ops/plans';
import { attentionReasons } from './attention';
import { latestSlot, nextSlot } from './schedule';

export interface TickResult {
  /** Ids of the jobs this pass put in the queue. */
  enqueued: string[];
  /** Ids of the jobs whose dead claim this pass settled. */
  reclaimed: string[];
  /**
   * The jobs this pass ended, as stored afterwards: first the ones `reclaim` failed, then the ones
   * the pass ran or skipped as obsolete.
   */
  ran: Job[];
  /**
   * What reconciling a reclaimed cycle's account found, as `'<accountId>: <sentence>'`. These are
   * not on any job: the reclaimed job had already ended.
   */
  notes: string[];
  /** True when any job of this pass has a non-empty `attention`, or `notes` is not empty. */
  attention: boolean;
}

export interface TickOptions {
  workerId?: string;
  /** Default 20. */
  maxJobs?: number;
  /**
   * Settles what an interrupted execution left behind for one account, and returns sentences for
   * the person when something needs a look. Called before every `cycle` job and for every `cycle`
   * job that `reclaim` failed as interrupted. Default: does nothing.
   */
  reconcile?: (accountId: string) => Promise<string[]>;
  /** A job's claim is not extended beyond this many seconds. Default 1800. */
  maxRunSeconds?: number;
}

const CLAIM_TTL_SECONDS = 600;
const HEARTBEAT_MS = 60_000;
const MAX_ATTEMPTS = 3;
const MAX_ERROR_CHARS = 300;
const MAX_SUMMARY_CHARS = 200;
const DEFAULT_DAYS = 30;
const SUPERSEDE_LOOKBACK = 50;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Null when the schedule's account is not configured. */
function fingerprintOf(runtime: Runtime, schedule: ScheduleConfig): { fingerprint: string; timezone: string | undefined } | null {
  let account;
  try {
    account = runtime.account(schedule.accountId);
  } catch {
    return null;
  }
  const fingerprint = digest({
    schedule: {
      accountId: schedule.accountId,
      task: schedule.task,
      every: schedule.every,
      ...(schedule.at !== undefined ? { at: schedule.at } : {}),
      ...(schedule.days !== undefined ? { days: schedule.days } : {}),
    },
    account: {
      platform: account.platform,
      externalId: account.externalId,
      ...(account.timezone !== undefined ? { timezone: account.timezone } : {}),
    },
  });
  return { fingerprint, timezone: account.timezone };
}

function enabledSchedules(runtime: Runtime): ScheduleConfig[] {
  return (runtime.config.schedules ?? []).filter((schedule) => schedule.enabled !== false);
}

function enqueueLatest(runtime: Runtime, now: Date): string[] {
  const enqueued: string[] = [];
  for (const schedule of enabledSchedules(runtime)) {
    const identity = fingerprintOf(runtime, schedule);
    if (!identity) continue;
    const slot = latestSlot(schedule, identity.timezone, now).toISOString();
    const id = shortId('job', { scheduleId: schedule.id, slot, fingerprint: identity.fingerprint });
    const inserted = runtime.jobs.enqueue(
      {
        id,
        scheduleId: schedule.id,
        accountId: schedule.accountId,
        task: schedule.task,
        dueAt: slot,
        input: { days: schedule.days ?? DEFAULT_DAYS, fingerprint: identity.fingerprint },
      },
      now,
    );
    if (inserted) enqueued.push(id);
  }
  return enqueued;
}

/** Why a claimed job must not run any more, or null. */
function obsoleteReason(runtime: Runtime, job: Job): string | null {
  if (job.scheduleId === null) return null;
  const schedule = enabledSchedules(runtime).find((candidate) => candidate.id === job.scheduleId);
  if (!schedule) return 'the schedule was removed or disabled';
  if (fingerprintOf(runtime, schedule)?.fingerprint !== job.input.fingerprint) {
    return 'the schedule changed after this run was queued';
  }
  // Only a later job queued under the schedule's present fingerprint supersedes this one: a job of
  // an earlier definition is obsolete itself, whatever its slot.
  const dueMs = Date.parse(job.dueAt);
  const superseded = runtime.jobs
    .list({ scheduleId: job.scheduleId, limit: SUPERSEDE_LOOKBACK })
    .some(
      (other) =>
        other.id !== job.id && other.input.fingerprint === job.input.fingerprint && Date.parse(other.dueAt) > dueMs,
    );
  return superseded ? 'a newer run of this schedule replaced it' : null;
}

function auditSummary(audit: AuditReport): Pick<JobResult, 'score' | 'findings' | 'summary'> {
  const score = audit.score.value;
  return {
    ...(typeof score === 'number' ? { score } : {}),
    findings: audit.findings.length,
    summary: `Score ${typeof score === 'number' ? score : 'n/a'}/100, ${audit.findings.length} finding(s)`,
  };
}

function previousAuditOf(runtime: Runtime, job: Job): AuditReport | null {
  const auditId = runtime.jobs.previousSucceeded(job)?.result?.auditId;
  if (!auditId) return null;
  try {
    return runtime.store.getAudit(auditId) ?? null;
  } catch {
    return null;
  }
}

/**
 * A snapshot without a single row means the account could not be read: the readers report missing
 * credentials, refused access and failed reads as warnings, not as errors. An unattended run must
 * not pass that off as a clean result. The cause may be temporary, so the error is retryable.
 */
function assertHasData(snapshot: Snapshot): void {
  const rows = Object.values(snapshot.datasets).reduce((sum, dataset) => sum + (dataset?.length ?? 0), 0);
  if (rows > 0) return;
  const why = snapshot.warnings[0];
  throw new AutopilotError(
    'platform_error',
    `The snapshot of ${snapshot.accountId} has no data${why === undefined ? '' : `: ${why.replace(/\s+/g, ' ').slice(0, 200)}`}`,
    { retryable: true, hint: 'Run `autopilot-marketing doctor --connect` to see what is wrong with the connection.' },
  );
}

async function runTask(
  runtime: Runtime,
  job: Job,
  options: TickOptions,
  /** Throws once this worker no longer owns the job. */
  guard: () => void,
): Promise<{ result: JobResult; attention: string[] }> {
  const input = { accountId: job.accountId, days: job.input.days };

  if (job.task === 'report') {
    const report = await kpiReport(runtime, input);
    assertHasData(runtime.store.getSnapshot(report.current.snapshotId));
    const fact = report.facts[0];
    return {
      result: {
        snapshotId: report.current.snapshotId,
        ...(fact !== undefined ? { summary: fact.slice(0, MAX_SUMMARY_CHARS) } : {}),
      },
      attention: attentionReasons({ audit: null, previousAudit: null }),
    };
  }

  if (job.task === 'audit') {
    const snapshot = await takeSnapshot(runtime, input);
    assertHasData(snapshot);
    const audit = await auditSnapshot(runtime, { snapshotId: snapshot.id });
    return {
      result: { snapshotId: snapshot.id, auditId: audit.id, ...auditSummary(audit) },
      attention: attentionReasons({ audit, previousAudit: previousAuditOf(runtime, job) }),
    };
  }

  const attention: string[] = [];
  try {
    attention.push(...((await options.reconcile?.(job.accountId)) ?? []));
  } catch (error) {
    if (error instanceof AutopilotError && error.code === 'stale_state') throw error;
    attention.push(`Reconciliation failed: ${redact(errorMessage(error), runtime.env).slice(0, MAX_ERROR_CHARS)}`);
  }

  const cycle = await runCycle(runtime, { ...input, guard });
  assertHasData(cycle.snapshot);
  const { audit, plan, preview, outcome, applyError } = cycle;
  attention.push(
    ...attentionReasons({
      audit,
      previousAudit: previousAuditOf(runtime, job),
      ...(plan
        ? {
            plan: {
              id: plan.id,
              awaitingApproval:
                outcome === null &&
                applyError === null &&
                preview !== null &&
                preview.policy.allowed &&
                preview.approval.required,
              applyError,
            },
          }
        : {}),
    }),
  );
  if (outcome) {
    if (outcome.failed > 0) attention.push(`${outcome.failed} change(s) failed.`);
    if (outcome.unknown > 0) {
      attention.push(
        `${outcome.unknown} change(s) have an unknown outcome; their entities are blocked until someone checks them.`,
      );
    }
    if (outcome.skipped > 0) {
      attention.push(
        `${outcome.skipped} change(s) were skipped because the account had changed since the plan was made.`,
      );
    }
  }

  return {
    result: {
      snapshotId: cycle.snapshot.id,
      auditId: audit.id,
      ...auditSummary(audit),
      ...(plan ? { planId: plan.id } : {}),
      ...(outcome
        ? { applied: outcome.applied, failed: outcome.failed, skipped: outcome.skipped, unknown: outcome.unknown }
        : {}),
      next: cycle.next,
    },
    attention: [...new Set(attention)],
  };
}

function failureOutcome(runtime: Runtime, job: Job, error: unknown): JobOutcome {
  const message = redact(errorMessage(error), runtime.env).slice(0, MAX_ERROR_CHARS);
  const retry =
    job.task !== 'cycle' && error instanceof AutopilotError && error.retryable && job.attempts < MAX_ATTEMPTS;
  if (retry) {
    const delaySeconds = job.attempts === 1 ? 60 : 300;
    return {
      state: 'queued',
      error: message,
      retryAt: new Date(runtime.now().getTime() + delaySeconds * 1000).toISOString(),
    };
  }
  return { state: 'failed', error: message, attention: [`Job failed: ${message}`] };
}

/**
 * One pass of the scheduler: queue the latest slot of every enabled schedule, settle dead claims,
 * then run every due job, one at a time. Safe to call from several processes at once.
 */
export async function runDue(runtime: Runtime, options: TickOptions = {}): Promise<TickResult> {
  const now = runtime.now();
  const workerId = options.workerId ?? `worker_${process.pid}_${randomBytes(4).toString('hex')}`;
  const maxJobs = options.maxJobs ?? 20;
  const maxRunMs = (options.maxRunSeconds ?? 1800) * 1000;

  const enqueued = enqueueLatest(runtime, now);

  const reclaimedJobs = runtime.jobs.reclaim(now);
  const interrupted = new Set(
    reclaimedJobs.filter((job) => job.task === 'cycle').map((job) => job.accountId),
  );
  const notes: string[] = [];
  for (const accountId of interrupted) {
    try {
      for (const sentence of (await options.reconcile?.(accountId)) ?? []) notes.push(`${accountId}: ${sentence}`);
    } catch (error) {
      notes.push(
        `${accountId}: reconciliation failed: ${redact(errorMessage(error), runtime.env).slice(0, MAX_ERROR_CHARS)}`,
      );
    }
  }

  // A job that `reclaim` failed ended in this pass, although the pass never ran it. The jobs are
  // taken as `reclaim` returned them: whatever happens to a requeued job afterwards belongs to the
  // worker that claims it.
  const ran: Job[] = reclaimedJobs.filter((job) => job.state === 'failed');
  for (let claimed = 0; claimed < maxJobs; claimed += 1) {
    const job = runtime.jobs.claimDue(workerId, runtime.now(), CLAIM_TTL_SECONDS);
    if (!job) break;

    const reason = obsoleteReason(runtime, job);
    if (reason !== null) {
      if (runtime.jobs.finish(job, runtime.now(), { state: 'skipped', reason })) ran.push(runtime.jobs.get(job.id));
      continue;
    }

    let claimLost = false;
    // Wall time, not runtime.now(): the limit is about a hung process, whatever clock was injected.
    const startedMs = Date.now();
    const timer = setInterval(() => {
      if (claimLost || Date.now() - startedMs > maxRunMs) return;
      try {
        if (!runtime.jobs.heartbeat(job, runtime.now(), CLAIM_TTL_SECONDS)) claimLost = true;
      } catch {
        claimLost = true;
      }
    }, HEARTBEAT_MS);
    timer.unref();
    // A heartbeat is an ownership check that also extends the claim. Past the run limit the claim
    // is not extended, so the guard refuses without asking.
    const guard = (): void => {
      let owned = false;
      if (!claimLost && Date.now() - startedMs <= maxRunMs) {
        try {
          owned = runtime.jobs.heartbeat(job, runtime.now(), CLAIM_TTL_SECONDS);
        } catch {
          owned = false;
        }
        if (!owned) claimLost = true;
      }
      if (!owned) {
        throw new AutopilotError('stale_state', 'This run lost its job claim to another worker; it writes nothing more.');
      }
    };

    let outcome: JobOutcome;
    try {
      const done = await runTask(runtime, job, options, guard);
      outcome = { state: 'succeeded', result: done.result, attention: done.attention };
    } catch (error) {
      outcome = failureOutcome(runtime, job, error);
    } finally {
      clearInterval(timer);
    }

    if (claimLost) continue;
    if (runtime.jobs.finish(job, runtime.now(), outcome)) ran.push(runtime.jobs.get(job.id));
  }

  return {
    enqueued,
    reclaimed: reclaimedJobs.map((job) => job.id),
    ran,
    notes,
    attention: notes.length > 0 || ran.some((job) => job.attention.length > 0),
  };
}

export interface ScheduleStatus {
  schedule: ScheduleConfig;
  /** ISO time of the first slot after now. */
  nextDueAt: string;
  lastJob: Job | null;
}

/** Every configured schedule with its next slot and its newest job. */
export function scheduleOverview(runtime: Runtime): ScheduleStatus[] {
  const now = runtime.now();
  const overview: ScheduleStatus[] = [];
  for (const schedule of runtime.config.schedules ?? []) {
    let timezone: string | undefined;
    try {
      timezone = runtime.account(schedule.accountId).timezone;
    } catch {
      continue;
    }
    overview.push({
      schedule,
      nextDueAt: nextSlot(schedule, timezone, now).toISOString(),
      lastJob: runtime.jobs.latest(schedule.id),
    });
  }
  return overview;
}
