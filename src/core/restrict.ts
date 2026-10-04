import { localJudge } from '../judgment/sharing';
import { AutopilotError } from './errors';
import { AUTONOMY_LEVELS } from './types';
import type { Autonomy, Job, JobQueue, Ledger, Runtime, Store } from './types';

export interface RuntimeLimits {
  /** Only these accounts exist for the caller. Omitted: every configured account. */
  accounts?: string[];
  /** The highest autonomy the caller gets, whatever the config says. */
  maxAutonomy?: Autonomy;
  /** False: every judgment comes from the rule-based fallback; nothing is sent to Jev. */
  judgments?: boolean;
}

function hidden(kind: string, id: string): AutopilotError {
  return new AutopilotError('not_found', `${kind} ${id} was not found`, {
    hint: 'It belongs to an account outside the scope of this run.',
  });
}

/** A store that shows only what belongs to the allowed accounts. Writes pass through unchanged. */
function scopedStore(store: Store, allowed: Set<string>): Store {
  return {
    ...store,
    getSnapshot(id) {
      const snapshot = store.getSnapshot(id);
      if (!allowed.has(snapshot.accountId)) throw hidden('snapshot', id);
      return snapshot;
    },
    listSnapshots(filter) {
      return store.listSnapshots(filter).filter((snapshot) => allowed.has(snapshot.accountId));
    },
    getAudit(id) {
      const audit = store.getAudit(id);
      if (!allowed.has(audit.accountId)) throw hidden('audit', id);
      return audit;
    },
    getPlan(id) {
      const plan = store.getPlan(id);
      if (!allowed.has(plan.accountId)) throw hidden('plan', id);
      return plan;
    },
    listPlans(filter) {
      return store.listPlans(filter).filter((plan) => allowed.has(plan.accountId));
    },
  };
}

/** A ledger whose reads leave out entries of other accounts. Appends and verification are unchanged. */
function scopedLedger(ledger: Ledger, allowed: Set<string>): Ledger {
  return {
    append: (entry) => ledger.append(entry),
    verify: () => ledger.verify(),
    read(filter) {
      if (filter?.accountId !== undefined && !allowed.has(filter.accountId)) return [];
      // The limit is applied after the scope, so a caller still gets up to `limit` of its own entries.
      const { limit, ...rest } = filter ?? {};
      const visible = ledger
        .read(rest)
        .filter((entry) => entry.accountId === undefined || allowed.has(entry.accountId));
      return limit === undefined ? visible : visible.slice(-limit).reverse();
    },
  };
}

/**
 * A job queue whose reads show only the runs of the allowed accounts. The methods a worker uses
 * (claim, heartbeat, finish, reclaim) are unchanged: no tool reaches them.
 */
function scopedJobs(jobs: JobQueue, allowed: Set<string>): JobQueue {
  const visible = (job: Job | null): Job | null => (job !== null && allowed.has(job.accountId) ? job : null);
  return {
    enqueue(job, now) {
      if (!allowed.has(job.accountId)) throw hidden('account', job.accountId);
      return jobs.enqueue(job, now);
    },
    reclaim: (now, maxAttempts) => jobs.reclaim(now, maxAttempts),
    claimDue: (workerId, now, ttlSeconds) => jobs.claimDue(workerId, now, ttlSeconds),
    heartbeat: (job, now, ttlSeconds) => jobs.heartbeat(job, now, ttlSeconds),
    finish: (job, now, outcome) => jobs.finish(job, now, outcome),
    get(id) {
      const job = jobs.get(id);
      if (!allowed.has(job.accountId)) throw hidden('job', id);
      return job;
    },
    list(filter) {
      if (filter?.accountId !== undefined) return allowed.has(filter.accountId) ? jobs.list(filter) : [];
      // Scoped before the limit, so the caller gets up to `limit` of its own runs.
      const limit = Math.min(Math.max(Math.floor(filter?.limit ?? 20), 1), 200);
      return [...allowed]
        .flatMap((accountId) => jobs.list({ ...filter, accountId, limit }))
        .sort((a, b) => b.dueAt.localeCompare(a.dueAt) || a.id.localeCompare(b.id))
        .slice(0, limit);
    },
    latest: (scheduleId) => visible(jobs.latest(scheduleId)),
    previousSucceeded: (job) => visible(jobs.previousSucceeded(job)),
  };
}

/**
 * A view of `runtime` with less authority, for a caller the owner trusts less than their own agent
 * (the local model runner). It never grants more than the runtime it wraps.
 */
export function restrictRuntime(runtime: Runtime, limits: RuntimeLimits): Runtime {
  let view: Runtime = runtime;

  if (limits.accounts !== undefined) {
    const allowed = new Set(limits.accounts);
    for (const id of allowed) runtime.account(id);
    const config = {
      ...runtime.config,
      accounts: runtime.config.accounts.filter((account) => allowed.has(account.id)),
      ...(runtime.config.schedules === undefined
        ? {}
        : { schedules: runtime.config.schedules.filter((schedule) => allowed.has(schedule.accountId)) }),
    };
    view = {
      ...view,
      config,
      store: scopedStore(runtime.store, allowed),
      ledger: scopedLedger(runtime.ledger, allowed),
      jobs: scopedJobs(runtime.jobs, allowed),
      account(accountId) {
        if (!allowed.has(accountId)) {
          throw new AutopilotError('not_found', `Unknown account '${accountId}'`, {
            hint: `Accounts in the scope of this run: ${[...allowed].join(', ') || 'none'}`,
          });
        }
        return runtime.account(accountId);
      },
    };
  }

  if (limits.maxAutonomy !== undefined) {
    const ceiling = AUTONOMY_LEVELS.indexOf(limits.maxAutonomy);
    if (AUTONOMY_LEVELS.indexOf(view.autonomy) > ceiling) view = { ...view, autonomy: limits.maxAutonomy };
  }

  if (limits.judgments === false) view = { ...view, judge: localJudge(runtime) };

  return view;
}
