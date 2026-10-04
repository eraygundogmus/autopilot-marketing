import type { Db } from '../core/db';
import { inTransaction } from '../core/db';
import { AutopilotError } from '../core/errors';
import { canonicalJson, sha256 } from '../core/ids';
import { LEDGER_EVENTS } from '../core/types';
import type { Ledger, LedgerEntry, LedgerEvent, LedgerFilter, LedgerInput } from '../core/types';

const GENESIS_HASH = '0'.repeat(64);
const HASH_DOMAIN = 'autopilot-ledger:v1\n';
const MAX_ROLLBACK_MS = 5 * 60 * 1000;

type SqlValue = string | number | null;

function isLedgerEvent(value: unknown): value is LedgerEvent {
  return typeof value === 'string' && (LEDGER_EVENTS as readonly string[]).includes(value);
}

function hashEntry(entry: Omit<LedgerEntry, 'hash'>): string {
  return sha256(HASH_DOMAIN + canonicalJson(entry));
}

function parseEntry(json: unknown): LedgerEntry | null {
  if (typeof json !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record['seq'] !== 'number' || typeof record['hash'] !== 'string' || typeof record['prevHash'] !== 'string') {
    return null;
  }
  return value as LedgerEntry;
}

function withoutHash(entry: LedgerEntry): Omit<LedgerEntry, 'hash'> {
  const { hash: _hash, ...rest } = entry;
  return rest;
}

/** Append-only `ledger` table with a sha256 hash chain. Each append is one write transaction. */
export function createLedger(db: Db, now: () => Date = () => new Date()): Ledger {
  function append(input: LedgerInput): LedgerEntry {
    if (!isLedgerEvent(input.event)) {
      throw new AutopilotError('invalid_input', `Unknown ledger event: ${String(input.event)}`, {
        hint: `Use one of: ${LEDGER_EVENTS.join(', ')}`,
      });
    }
    const ts = input.ts ?? now().toISOString();
    const tsMs = Date.parse(ts);
    if (Number.isNaN(tsMs)) {
      throw new AutopilotError('invalid_input', `Ledger timestamp is not an ISO date: ${ts}`);
    }

    return inTransaction(db, () => {
      const last = db.prepare('SELECT seq, ts, hash FROM ledger ORDER BY seq DESC LIMIT 1').get();
      const lastSeq = last === undefined ? 0 : Number(last['seq']);
      const prevHash = last === undefined ? GENESIS_HASH : String(last['hash']);
      if (last !== undefined) {
        const lastMs = Date.parse(String(last['ts']));
        if (!Number.isNaN(lastMs) && tsMs < lastMs - MAX_ROLLBACK_MS) {
          throw new AutopilotError(
            'internal',
            `Ledger timestamp ${ts} is more than 5 minutes before the previous entry (${String(last['ts'])})`,
            { hint: 'The system clock appears to have moved backwards. Fix the clock, then retry.' },
          );
        }
      }

      const body: Omit<LedgerEntry, 'hash'> = {
        seq: lastSeq + 1,
        ts,
        prevHash,
        event: input.event,
        actor: input.actor,
        ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
        ...(input.planId !== undefined ? { planId: input.planId } : {}),
        ...(input.executionId !== undefined ? { executionId: input.executionId } : {}),
        ...(input.actionId !== undefined ? { actionId: input.actionId } : {}),
        ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
        ...(input.data !== undefined ? { data: input.data } : {}),
      };
      const entry: LedgerEntry = { ...body, hash: hashEntry(body) };

      db.prepare(
        `INSERT INTO ledger (seq, ts, prev_hash, hash, event, account_id, plan_id, execution_id, action_id, json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        entry.seq,
        entry.ts,
        entry.prevHash,
        entry.hash,
        entry.event,
        entry.accountId ?? null,
        entry.planId ?? null,
        entry.executionId ?? null,
        entry.actionId ?? null,
        JSON.stringify(entry),
      );
      return entry;
    });
  }

  function read(filter: LedgerFilter = {}): LedgerEntry[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (filter.accountId !== undefined) {
      where.push('account_id = ?');
      params.push(filter.accountId);
    }
    if (filter.planId !== undefined) {
      where.push('plan_id = ?');
      params.push(filter.planId);
    }
    if (filter.events !== undefined) {
      if (filter.events.length === 0) return [];
      where.push(`event IN (${filter.events.map(() => '?').join(', ')})`);
      params.push(...filter.events);
    }
    if (filter.since !== undefined) {
      where.push('ts >= ?');
      params.push(filter.since);
    }
    let sql = `SELECT seq, json FROM ledger${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''}`;
    if (filter.limit === undefined) {
      sql += ' ORDER BY seq ASC';
    } else {
      if (!Number.isInteger(filter.limit) || filter.limit < 0) {
        throw new AutopilotError('invalid_input', `Ledger limit must be a non-negative integer, got ${filter.limit}`);
      }
      sql += ' ORDER BY seq DESC LIMIT ?';
      params.push(filter.limit);
    }
    return db
      .prepare(sql)
      .all(...params)
      .map((row) => {
        const entry = parseEntry(row['json']);
        if (entry === null) {
          throw new AutopilotError('internal', `Ledger entry ${String(row['seq'])} is not readable`, {
            hint: 'The ledger has been modified outside autopilot. Run the ledger verification.',
          });
        }
        return entry;
      });
  }

  function verify(): { ok: boolean; entries: number; brokenAt: number | null } {
    const rows = db.prepare('SELECT seq, hash, json FROM ledger ORDER BY seq ASC').all();
    let prevSeq = 0;
    let prevHash = GENESIS_HASH;
    for (const row of rows) {
      const seq = Number(row['seq']);
      const entry = parseEntry(row['json']);
      const good =
        entry !== null &&
        seq === prevSeq + 1 &&
        entry.seq === seq &&
        entry.prevHash === prevHash &&
        entry.hash === row['hash'] &&
        hashEntry(withoutHash(entry)) === entry.hash;
      if (!good) return { ok: false, entries: rows.length, brokenAt: seq };
      prevSeq = seq;
      prevHash = entry.hash;
    }
    return { ok: true, entries: rows.length, brokenAt: null };
  }

  return { append, read, verify };
}
