import { inTransaction } from './db';
import type { Db } from './db';
import { AutopilotError } from './errors';
import type { ApprovalReceipt, AuditReport, Plan, PlanStatus, Snapshot, SnapshotSummary, Store } from './types';

const ID_PATTERN = /^[a-z]+_[0-9a-f]{16}$/;

function assertId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new AutopilotError('invalid_input', `Invalid ${label}: expected a prefix, an underscore and 16 hex characters.`);
  }
  return value;
}

function assertAccountId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AutopilotError('invalid_input', 'Invalid account id: expected a non-empty string.');
  }
  return value;
}

function parseJson<T>(row: unknown, what: string): T {
  if (typeof row === 'object' && row !== null) {
    const json = (row as Record<string, unknown>).json;
    if (typeof json === 'string') {
      try {
        return JSON.parse(json) as T;
      } catch (error) {
        throw new AutopilotError('internal', `Stored ${what} is not valid JSON.`, { cause: error });
      }
    }
  }
  throw new AutopilotError('internal', `Stored ${what} has no JSON body.`);
}

/**
 * Snapshots, audits, plans, receipts and execution locks in the state database. Ids are validated
 * against `^[a-z]+_[0-9a-f]{16}$` before use.
 */
export function createStore(db: Db): Store {
  const getOne = <T>(table: 'snapshots' | 'audits' | 'plans', id: string, what: string, hint: string): T => {
    assertId(id, `${what} id`);
    // `table` is one of three literals above, never caller input.
    const row = db.prepare(`SELECT json FROM ${table} WHERE id = ?`).get(id);
    if (row === undefined) throw new AutopilotError('not_found', `No ${what} with id ${id}.`, { hint });
    return parseJson<T>(row, what);
  };

  return {
    saveSnapshot(snapshot: Snapshot): void {
      assertId(snapshot.id, 'snapshot id');
      db.prepare(
        'INSERT OR REPLACE INTO snapshots (id, account_id, platform, source, range_start, range_end, created_at, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        snapshot.id,
        snapshot.accountId,
        snapshot.platform,
        snapshot.source,
        snapshot.dateRange.start,
        snapshot.dateRange.end,
        snapshot.createdAt,
        JSON.stringify(snapshot),
      );
    },

    getSnapshot(id: string): Snapshot {
      return getOne<Snapshot>('snapshots', id, 'snapshot', 'Call snapshot_create to take a snapshot; it returns the snapshot id.');
    },

    listSnapshots(filter?: { accountId?: string }): SnapshotSummary[] {
      const columns = 'SELECT id, account_id, platform, source, range_start, range_end, created_at FROM snapshots';
      const order = ' ORDER BY created_at DESC, rowid DESC';
      const rows =
        filter?.accountId === undefined
          ? db.prepare(columns + order).all()
          : db.prepare(`${columns} WHERE account_id = ?${order}`).all(assertAccountId(filter.accountId));
      return rows.map((row) => ({
        id: String(row.id),
        accountId: String(row.account_id),
        platform: String(row.platform) as SnapshotSummary['platform'],
        source: String(row.source) as SnapshotSummary['source'],
        dateRange: { start: String(row.range_start), end: String(row.range_end) },
        createdAt: String(row.created_at),
      }));
    },

    saveAudit(report: AuditReport): void {
      assertId(report.id, 'audit id');
      db.prepare('INSERT OR REPLACE INTO audits (id, account_id, snapshot_id, created_at, json) VALUES (?, ?, ?, ?, ?)').run(
        report.id,
        report.accountId,
        report.snapshotId,
        report.createdAt,
        JSON.stringify(report),
      );
    },

    getAudit(id: string): AuditReport {
      return getOne<AuditReport>('audits', id, 'audit', 'Call audit_run on a snapshot to create an audit; it returns the audit id.');
    },

    savePlan(plan: Plan): void {
      assertId(plan.id, 'plan id');
      db.prepare('INSERT OR REPLACE INTO plans (id, account_id, status, created_at, json) VALUES (?, ?, ?, ?, ?)').run(
        plan.id,
        plan.accountId,
        plan.status,
        plan.createdAt,
        JSON.stringify(plan),
      );
    },

    getPlan(id: string): Plan {
      return getOne<Plan>('plans', id, 'plan', 'Call plan_create to create a plan; it returns the plan id.');
    },

    listPlans(filter?: { accountId?: string; status?: PlanStatus }): Plan[] {
      const where: string[] = [];
      const params: string[] = [];
      if (filter?.accountId !== undefined) {
        where.push('account_id = ?');
        params.push(assertAccountId(filter.accountId));
      }
      if (filter?.status !== undefined) {
        where.push('status = ?');
        params.push(String(filter.status));
      }
      const clause = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`;
      const rows = db.prepare(`SELECT json FROM plans${clause} ORDER BY created_at DESC, rowid DESC`).all(...params);
      return rows.map((row) => parseJson<Plan>(row, 'plan'));
    },

    saveReceipt(receipt: ApprovalReceipt): void {
      assertId(receipt.id, 'receipt id');
      assertId(receipt.planId, 'plan id');
      const result = db
        .prepare('INSERT OR IGNORE INTO receipts (id, plan_id, json) VALUES (?, ?, ?)')
        .run(receipt.id, receipt.planId, JSON.stringify(receipt));
      if (Number(result.changes) !== 1) {
        throw new AutopilotError('internal', `Receipt ${receipt.id} already exists; receipts are never overwritten.`);
      }
    },

    findReceipts(planId: string): ApprovalReceipt[] {
      assertId(planId, 'plan id');
      const rows = db.prepare('SELECT json FROM receipts WHERE plan_id = ? ORDER BY rowid ASC').all(planId);
      const receipts = rows.map((row) => parseJson<ApprovalReceipt>(row, 'receipt'));
      // Stable sort: receipts with equal createdAt keep insertion order.
      return receipts.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    },

    claimReceipt(receiptId: string, executionId: string, at: string): boolean {
      assertId(receiptId, 'receipt id');
      assertId(executionId, 'execution id');
      if (typeof at !== 'string' || at.length === 0) {
        throw new AutopilotError('invalid_input', 'Invalid claim time: expected an ISO timestamp.');
      }
      const result = db
        .prepare('UPDATE receipts SET claimed_by = ?, claimed_at = ? WHERE id = ? AND claimed_by IS NULL')
        .run(executionId, at, receiptId);
      return Number(result.changes) === 1;
    },

    receiptClaim(receiptId: string): { executionId: string; at: string } | null {
      assertId(receiptId, 'receipt id');
      const row = db.prepare('SELECT claimed_by, claimed_at FROM receipts WHERE id = ?').get(receiptId) as
        | { claimed_by: string | null; claimed_at: string | null }
        | undefined;
      if (!row || row.claimed_by === null || row.claimed_at === null) return null;
      return { executionId: row.claimed_by, at: row.claimed_at };
    },

    acquireLock(accountId: string, executionId: string, now: Date, ttlSeconds: number): boolean {
      assertAccountId(accountId);
      assertId(executionId, 'execution id');
      if (!Number.isFinite(now.getTime()) || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
        throw new AutopilotError('invalid_input', 'Invalid lock request: expected a valid time and a positive ttl in seconds.');
      }
      // ISO-8601 UTC strings of equal length compare in time order.
      const nowIso = now.toISOString();
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
      return inTransaction(db, () => {
        db.prepare('DELETE FROM locks WHERE account_id = ? AND expires_at <= ?').run(accountId, nowIso);
        const row = db.prepare('SELECT execution_id FROM locks WHERE account_id = ?').get(accountId);
        if (row === undefined) {
          db.prepare('INSERT INTO locks (account_id, execution_id, expires_at) VALUES (?, ?, ?)').run(accountId, executionId, expiresAt);
          return true;
        }
        if (row.execution_id !== executionId) return false;
        db.prepare('UPDATE locks SET expires_at = ? WHERE account_id = ? AND execution_id = ?').run(expiresAt, accountId, executionId);
        return true;
      });
    },

    releaseLock(accountId: string, executionId: string): void {
      assertAccountId(accountId);
      assertId(executionId, 'execution id');
      db.prepare('DELETE FROM locks WHERE account_id = ? AND execution_id = ?').run(accountId, executionId);
    },
  };
}
