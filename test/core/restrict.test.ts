import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config';
import { AutopilotError } from '../../src/core/errors';
import { restrictRuntime } from '../../src/core/restrict';
import { auditSnapshot } from '../../src/ops/audit';
import { queryData, takeSnapshot } from '../../src/ops/data';
import { tempRuntime } from '../helpers/runtime';

const now = () => new Date('2026-10-04T10:00:00Z');

function code(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof AutopilotError ? error.code : 'other';
  }
  return undefined;
}

describe('restrictRuntime', () => {
  it('hides other accounts, their snapshots, audits and ledger entries', async () => {
    const { runtime } = tempRuntime({ now });
    const google = await takeSnapshot(runtime, { accountId: 'demo-google' });
    const meta = await takeSnapshot(runtime, { accountId: 'demo-meta' });
    const audit = await auditSnapshot(runtime, { snapshotId: google.id, judgments: false });

    const view = restrictRuntime(runtime, { accounts: ['demo-meta'] });

    expect(view.config.accounts.map((account) => account.id)).toEqual(['demo-meta']);
    expect(view.account('demo-meta').id).toBe('demo-meta');
    expect(code(() => view.account('demo-google'))).toBe('not_found');
    expect(view.store.getSnapshot(meta.id).id).toBe(meta.id);
    expect(code(() => view.store.getSnapshot(google.id))).toBe('not_found');
    expect(code(() => view.store.getAudit(audit.id))).toBe('not_found');
    expect(code(() => queryData(view, { snapshotId: google.id, dataset: 'campaigns' }))).toBe('not_found');
    expect(view.store.listSnapshots().map((snapshot) => snapshot.accountId)).toEqual(['demo-meta']);

    const visible = view.ledger.read({});
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.every((entry) => entry.accountId === undefined || entry.accountId === 'demo-meta')).toBe(true);
    expect(view.ledger.read({ accountId: 'demo-google' })).toEqual([]);
    // A limit counts the caller's own entries, newest first, as the full ledger does.
    expect(view.ledger.read({ limit: 1 }).map((entry) => entry.seq)).toEqual([visible.at(-1)?.seq]);
    expect(view.ledger.verify()).toEqual(runtime.ledger.verify());
  });

  it('shows only the scheduled runs of its accounts', () => {
    const { runtime } = tempRuntime({ now });
    const due = now().toISOString();
    runtime.jobs.enqueue({ id: 'job_00000000000000a1', scheduleId: 's-google', accountId: 'demo-google', task: 'audit', dueAt: due, input: { days: 30 } }, now());
    runtime.jobs.enqueue({ id: 'job_00000000000000b2', scheduleId: 's-meta', accountId: 'demo-meta', task: 'audit', dueAt: due, input: { days: 30 } }, now());

    const view = restrictRuntime(runtime, { accounts: ['demo-meta'] });

    expect(view.jobs.list().map((job) => job.accountId)).toEqual(['demo-meta']);
    expect(view.jobs.list({ accountId: 'demo-google' })).toEqual([]);
    expect(view.jobs.list({ limit: 1 }).map((job) => job.id)).toEqual(['job_00000000000000b2']);
    expect(view.jobs.get('job_00000000000000b2').accountId).toBe('demo-meta');
    expect(code(() => view.jobs.get('job_00000000000000a1'))).toBe('not_found');
    expect(view.jobs.latest('s-google')).toBeNull();
    expect(view.jobs.latest('s-meta')?.id).toBe('job_00000000000000b2');
    expect(runtime.jobs.list()).toHaveLength(2);
  });

  it('refuses a scope that names an account the owner did not configure', () => {
    const { runtime } = tempRuntime({ now });
    expect(code(() => restrictRuntime(runtime, { accounts: ['someone-else'] }))).toBe('not_found');
  });

  it('lowers autonomy to the ceiling and never raises it', () => {
    const approve = tempRuntime({ now, config: { ...defaultConfig(), autonomy: 'approve' } }).runtime;
    expect(restrictRuntime(approve, { maxAutonomy: 'propose' }).autonomy).toBe('propose');
    expect(restrictRuntime(approve, { maxAutonomy: 'autopilot' }).autonomy).toBe('approve');
    const observe = tempRuntime({ now, config: { ...defaultConfig(), autonomy: 'observe' } }).runtime;
    expect(restrictRuntime(observe, { maxAutonomy: 'propose' }).autonomy).toBe('observe');
    expect(restrictRuntime(approve, {}).autonomy).toBe('approve');
  });

  it('replaces the judge with one that never calls Jev', async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return new Response('{}', { status: 500 });
    }) as typeof globalThis.fetch;
    const { runtime } = tempRuntime({ now, fetch, env: { TYPESAFE_API_KEY: 'k' } });
    const view = restrictRuntime(runtime, { judgments: false });
    const judged = await view.judge.classifyTerms({ business: 'tents', brandTerms: [], terms: ['free tent repair'] });
    expect(judged).toHaveLength(1);
    expect(view.judge.usage().mode).toBe('fallback');
    expect(calls).toBe(0);
  });
});
