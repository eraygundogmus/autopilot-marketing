import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Paths } from './types';

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, platform TEXT NOT NULL, source TEXT NOT NULL,
  range_start TEXT NOT NULL, range_end TEXT NOT NULL, created_at TEXT NOT NULL, json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshots_account ON snapshots (account_id, created_at);
CREATE TABLE IF NOT EXISTS audits (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, created_at TEXT NOT NULL, json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS plans_account ON plans (account_id, created_at);
CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, json TEXT NOT NULL, claimed_by TEXT, claimed_at TEXT
);
CREATE INDEX IF NOT EXISTS receipts_plan ON receipts (plan_id);
CREATE TABLE IF NOT EXISTS ledger (
  seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL, event TEXT NOT NULL,
  account_id TEXT, plan_id TEXT, execution_id TEXT, action_id TEXT, json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_account ON ledger (account_id, seq);
CREATE INDEX IF NOT EXISTS ledger_plan ON ledger (plan_id, seq);
CREATE TABLE IF NOT EXISTS locks (
  account_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS judgment_cache (
  key TEXT PRIMARY KEY, json TEXT NOT NULL, created_at TEXT NOT NULL
);
`;

/** Opens (and creates) the state database. Pass ':memory:' as `paths.db` in tests. */
export function openDatabase(paths: Paths): Db {
  if (paths.db !== ':memory:') mkdirSync(dirname(paths.db), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(paths.db);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  if (paths.db !== ':memory:') chmodSync(paths.db, 0o600);
  return db;
}

/** Runs `fn` in one write transaction (BEGIN IMMEDIATE), so concurrent processes serialise. */
export function inTransaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
