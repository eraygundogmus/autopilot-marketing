import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/core/db';
import { AutopilotError } from '../../src/core/errors';
import { createStore } from '../../src/core/store';
import type { ApprovalReceipt, AuditReport, Paths, Plan, PlanStatus, Snapshot, Store } from '../../src/core/types';

function pathsFor(db: string): Paths {
  return {
    home: '/nonexistent/apm',
    config: '/nonexistent/apm/config.json',
    envFile: '/nonexistent/apm/.env',
    db,
    brief: '/nonexistent/apm/brief.md',
    approvalKey: '/nonexistent/apm/approval.key',
    killFile: '/nonexistent/apm/KILL',
  };
}

function memoryStore(): Store {
  return createStore(openDatabase(pathsFor(':memory:')));
}

function hex(n: number): string {
  return n.toString(16).padStart(16, '0');
}

function snapshot(n: number, accountId: string, createdAt: string): Snapshot {
  return {
    id: `snap_${hex(n)}`,
    schemaVersion: 1,
    platform: 'google_ads',
    accountId,
    externalAccountId: '123-456-7890',
    source: 'demo',
    currency: 'USD',
    timezone: 'UTC',
    dateRange: { start: '2026-01-01', end: '2026-01-31' },
    createdAt,
    datasets: {},
    coverage: {},
    warnings: ['w'],
    contentHash: 'abc',
  };
}

function plan(n: number, accountId: string, status: PlanStatus, createdAt: string): Plan {
  return {
    id: `plan_${hex(n)}`,
    schemaVersion: 1,
    createdAt,
    createdBy: 'agent',
    accountId,
    platform: 'google_ads',
    snapshotId: null,
    title: `Plan ${n}`,
    rationale: 'because',
    actions: [],
    digest: 'd',
    status,
  };
}

function receipt(n: number, planId: string, createdAt: string): ApprovalReceipt {
  return {
    id: `apr_${hex(n)}`,
    planId,
    planDigest: 'd',
    policyDigest: 'p',
    method: 'tty',
    reviewDigest: 'r',
    approver: 'tester',
    createdAt,
    expiresAt: '2026-02-01T01:00:00.000Z',
    signature: 's',
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof AutopilotError) return error.code;
    throw error;
  }
  return 'no_error';
}

describe('createStore', () => {
  it('round-trips snapshots and lists summaries newest first', () => {
    const store = memoryStore();
    const older = snapshot(1, 'acme', '2026-02-01T00:00:00.000Z');
    const newer = snapshot(2, 'acme', '2026-02-02T00:00:00.000Z');
    const other = snapshot(3, "o'brien; DROP TABLE snapshots", '2026-02-03T00:00:00.000Z');
    store.saveSnapshot(older);
    store.saveSnapshot(newer);
    store.saveSnapshot(other);

    expect(store.getSnapshot(older.id)).toEqual(older);
    expect(store.listSnapshots().map((s) => s.id)).toEqual([other.id, newer.id, older.id]);
    expect(store.listSnapshots({ accountId: 'acme' })).toEqual([
      { id: newer.id, accountId: 'acme', platform: 'google_ads', source: 'demo', dateRange: newer.dateRange, createdAt: newer.createdAt },
      { id: older.id, accountId: 'acme', platform: 'google_ads', source: 'demo', dateRange: older.dateRange, createdAt: older.createdAt },
    ]);
    expect(store.listSnapshots({ accountId: other.accountId }).map((s) => s.id)).toEqual([other.id]);
    expect(store.listSnapshots({ accountId: 'nobody' })).toEqual([]);
  });

  it('upserts a snapshot saved twice', () => {
    const store = memoryStore();
    const first = snapshot(1, 'acme', '2026-02-01T00:00:00.000Z');
    store.saveSnapshot(first);
    store.saveSnapshot({ ...first, warnings: ['changed'], source: 'csv' });
    expect(store.getSnapshot(first.id).warnings).toEqual(['changed']);
    expect(store.listSnapshots()).toHaveLength(1);
    expect(store.listSnapshots()[0]?.source).toBe('csv');
  });

  it('round-trips audits', () => {
    const store = memoryStore();
    const report: AuditReport = {
      id: `aud_${hex(7)}`,
      accountId: 'acme',
      platform: 'google_ads',
      snapshotId: `snap_${hex(1)}`,
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
      currency: 'USD',
      createdAt: '2026-02-01T00:00:00.000Z',
      score: { byCategory: {} } as AuditReport['score'],
      checks: [],
      findings: [],
      totals: { wastedSpendMonthly: 12.5, findings: 0, needsReview: 0 },
      judgment: {} as AuditReport['judgment'],
    };
    store.saveAudit(report);
    expect(store.getAudit(report.id)).toEqual(report);
  });

  it('throws not_found with a hint for missing entities', () => {
    const store = memoryStore();
    const calls = [
      () => store.getSnapshot(`snap_${hex(9)}`),
      () => store.getAudit(`aud_${hex(9)}`),
      () => store.getPlan(`plan_${hex(9)}`),
    ];
    for (const call of calls) {
      let caught: unknown;
      try {
        call();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AutopilotError);
      const error = caught as AutopilotError;
      expect(error.code).toBe('not_found');
      expect(error.hint).toBeTruthy();
    }
  });

  it('rejects malformed ids, including path traversal and injection strings', () => {
    const store = memoryStore();
    const bad = ['../../etc/passwd', '', 'plan_123', 'PLAN_0000000000000001', `plan_${hex(1)}x`, "plan_' OR '1'='1", `plan_${hex(1)}\n`];
    for (const id of bad) {
      expect(codeOf(() => store.getSnapshot(id))).toBe('invalid_input');
      expect(codeOf(() => store.getAudit(id))).toBe('invalid_input');
      expect(codeOf(() => store.getPlan(id))).toBe('invalid_input');
      expect(codeOf(() => store.findReceipts(id))).toBe('invalid_input');
      expect(codeOf(() => store.claimReceipt(id, `exec_${hex(1)}`, '2026-02-01T00:00:00.000Z'))).toBe('invalid_input');
      expect(codeOf(() => store.claimReceipt(`apr_${hex(1)}`, id, '2026-02-01T00:00:00.000Z'))).toBe('invalid_input');
      expect(codeOf(() => store.acquireLock('acme', id, new Date(0), 60))).toBe('invalid_input');
      expect(codeOf(() => store.releaseLock('acme', id))).toBe('invalid_input');
    }
  });

  it('round-trips plans, keeps status in sync and filters by account and status', () => {
    const store = memoryStore();
    const a = plan(1, 'acme', 'proposed', '2026-02-01T00:00:00.000Z');
    const b = plan(2, 'acme', 'approved', '2026-02-02T00:00:00.000Z');
    const c = plan(3, 'globex', 'proposed', '2026-02-03T00:00:00.000Z');
    store.savePlan(a);
    store.savePlan(b);
    store.savePlan(c);

    expect(store.getPlan(a.id)).toEqual(a);
    expect(store.listPlans().map((p) => p.id)).toEqual([c.id, b.id, a.id]);
    expect(store.listPlans({ status: 'proposed' }).map((p) => p.id)).toEqual([c.id, a.id]);
    expect(store.listPlans({ accountId: 'acme' }).map((p) => p.id)).toEqual([b.id, a.id]);
    expect(store.listPlans({ accountId: 'acme', status: 'proposed' })).toEqual([a]);

    store.savePlan({ ...a, status: 'applied' });
    expect(store.getPlan(a.id).status).toBe('applied');
    expect(store.listPlans({ status: 'proposed' }).map((p) => p.id)).toEqual([c.id]);
    expect(store.listPlans({ status: 'applied' }).map((p) => p.id)).toEqual([a.id]);
    expect(store.listPlans()).toHaveLength(3);
  });

  it('saves receipts once and returns a plan\'s receipts oldest first', () => {
    const store = memoryStore();
    const planId = `plan_${hex(1)}`;
    const late = receipt(1, planId, '2026-02-01T00:10:00.000Z');
    const early = receipt(2, planId, '2026-02-01T00:05:00.000Z');
    const foreign = receipt(3, `plan_${hex(2)}`, '2026-02-01T00:01:00.000Z');
    store.saveReceipt(late);
    store.saveReceipt(early);
    store.saveReceipt(foreign);

    expect(store.findReceipts(planId)).toEqual([early, late]);
    expect(store.findReceipts(`plan_${hex(5)}`)).toEqual([]);
    expect(codeOf(() => store.saveReceipt({ ...late, approver: 'someone else' }))).toBe('internal');
    expect(store.findReceipts(planId)[1]?.approver).toBe('tester');
  });

  it('claims a receipt exactly once', () => {
    const store = memoryStore();
    const r = receipt(1, `plan_${hex(1)}`, '2026-02-01T00:00:00.000Z');
    store.saveReceipt(r);
    expect(store.claimReceipt(r.id, `exec_${hex(1)}`, '2026-02-01T00:00:01.000Z')).toBe(true);
    expect(store.claimReceipt(r.id, `exec_${hex(2)}`, '2026-02-01T00:00:02.000Z')).toBe(false);
    expect(store.claimReceipt(r.id, `exec_${hex(1)}`, '2026-02-01T00:00:03.000Z')).toBe(false);
    expect(store.claimReceipt(`apr_${hex(99)}`, `exec_${hex(1)}`, '2026-02-01T00:00:04.000Z')).toBe(false);
  });

  it('holds one lock per account across two connections', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apm-'));
    const paths = pathsFor(join(dir, 'state.db'));
    const dbA = openDatabase(paths);
    const dbB = openDatabase(paths);
    try {
      const a = createStore(dbA);
      const b = createStore(dbB);
      const execA = `exec_${hex(1)}`;
      const execB = `exec_${hex(2)}`;
      const t0 = new Date('2026-02-01T00:00:00.000Z');
      const at = (seconds: number): Date => new Date(t0.getTime() + seconds * 1000);

      expect(a.acquireLock('acme', execA, t0, 60)).toBe(true);
      expect(b.acquireLock('acme', execB, at(1), 60)).toBe(false);
      // A different account is independent.
      expect(b.acquireLock('globex', execB, at(1), 60)).toBe(true);

      // Re-entrant for the holder, and the expiry moves to 30 + 60 = 90s.
      expect(a.acquireLock('acme', execA, at(30), 60)).toBe(true);
      expect(b.acquireLock('acme', execB, at(89), 60)).toBe(false);

      // Expired exactly at expires_at.
      expect(b.acquireLock('acme', execB, at(90), 60)).toBe(true);
      expect(a.acquireLock('acme', execA, at(91), 60)).toBe(false);

      // Release by a non-holder is a no-op.
      a.releaseLock('acme', execA);
      expect(a.acquireLock('acme', execA, at(92), 60)).toBe(false);

      b.releaseLock('acme', execB);
      expect(a.acquireLock('acme', execA, at(93), 60)).toBe(true);
    } finally {
      dbA.close();
      dbB.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
