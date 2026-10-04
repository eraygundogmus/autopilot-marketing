import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/core/db';
import type { Db } from '../../src/core/db';
import { AutopilotError } from '../../src/core/errors';
import { canonicalJson, sha256 } from '../../src/core/ids';
import type { LedgerEvent, LedgerInput, Paths } from '../../src/core/types';
import { createLedger } from '../../src/plan/ledger';

const paths: Paths = {
  home: '/nonexistent/apm',
  config: '/nonexistent/apm/config.json',
  envFile: '/nonexistent/apm/.env',
  db: ':memory:',
  brief: '/nonexistent/apm/brief.md',
  approvalKey: '/nonexistent/apm/approval.key',
  killFile: '/nonexistent/apm/KILL',
  credentials: '/nonexistent/apm/credentials.json',
};

const actor = { kind: 'system', id: 'test' } as const;
const T0 = Date.parse('2026-01-01T00:00:00.000Z');

function setup(): { db: Db; ledger: ReturnType<typeof createLedger>; clock: { ms: number } } {
  const db = openDatabase(paths);
  const clock = { ms: T0 };
  const ledger = createLedger(db, () => new Date(clock.ms));
  return { db, ledger, clock };
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

describe('createLedger', () => {
  it('chains three entries and verifies them', () => {
    const { ledger, clock } = setup();
    const a = ledger.append({ event: 'snapshot.created', actor, accountId: 'acc_1' });
    clock.ms += 1000;
    const b = ledger.append({ event: 'plan.created', actor, accountId: 'acc_1', planId: 'plan_1' });
    clock.ms += 1000;
    const c = ledger.append({ event: 'plan.approved', actor, planId: 'plan_1', data: { n: 1 } });

    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    expect(a.prevHash).toBe('0'.repeat(64));
    expect(b.prevHash).toBe(a.hash);
    expect(c.prevHash).toBe(b.hash);
    expect(a.ts).toBe('2026-01-01T00:00:00.000Z');
    const { hash, ...rest } = b;
    expect(hash).toBe(sha256('autopilot-ledger:v1\n' + canonicalJson(rest)));
    expect(ledger.verify()).toEqual({ ok: true, entries: 3, brokenAt: null });
    expect(ledger.read()).toEqual([a, b, c]);
  });

  it('verifies an empty ledger', () => {
    expect(setup().ledger.verify()).toEqual({ ok: true, entries: 0, brokenAt: null });
  });

  it('reports the seq of a row whose json was tampered with', () => {
    const { db, ledger } = setup();
    ledger.append({ event: 'snapshot.created', actor });
    const b = ledger.append({ event: 'plan.created', actor, data: { budget: 10 } });
    ledger.append({ event: 'plan.approved', actor });

    db.prepare('UPDATE ledger SET json = ? WHERE seq = 2').run(JSON.stringify({ ...b, data: { budget: 9999 } }));
    expect(ledger.verify()).toEqual({ ok: false, entries: 3, brokenAt: 2 });

    db.prepare('UPDATE ledger SET json = ? WHERE seq = 2').run('{not json');
    expect(ledger.verify()).toEqual({ ok: false, entries: 3, brokenAt: 2 });
  });

  it('detects a deleted middle row', () => {
    const { db, ledger } = setup();
    for (const event of ['snapshot.created', 'audit.run', 'plan.created'] as const) ledger.append({ event, actor });
    db.exec('DELETE FROM ledger WHERE seq = 2');
    expect(ledger.verify()).toEqual({ ok: false, entries: 2, brokenAt: 3 });
  });

  it('filters by account, plan, events and since', () => {
    const { ledger, clock } = setup();
    const inputs: LedgerInput[] = [
      { event: 'snapshot.created', actor, accountId: 'acc_1' },
      { event: 'plan.created', actor, accountId: 'acc_1', planId: 'plan_1' },
      { event: 'plan.created', actor, accountId: 'acc_2', planId: 'plan_2' },
      { event: 'plan.approved', actor, accountId: 'acc_1', planId: 'plan_1' },
    ];
    const entries = inputs.map((input) => {
      const entry = ledger.append(input);
      clock.ms += 60_000;
      return entry;
    });

    expect(ledger.read({ accountId: 'acc_1' }).map((e) => e.seq)).toEqual([1, 2, 4]);
    expect(ledger.read({ planId: 'plan_2' }).map((e) => e.seq)).toEqual([3]);
    expect(ledger.read({ events: ['plan.created', 'plan.approved'] }).map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(ledger.read({ events: [] })).toEqual([]);
    expect(ledger.read({ since: entries[2]?.ts ?? '' }).map((e) => e.seq)).toEqual([3, 4]);
    expect(ledger.read({ accountId: 'acc_1', events: ['plan.created'] }).map((e) => e.seq)).toEqual([2]);
    expect(ledger.read({ accountId: "acc_1' OR '1'='1" })).toEqual([]);
  });

  it('returns the newest entries first when a limit is set', () => {
    const { ledger } = setup();
    for (let i = 0; i < 5; i += 1) ledger.append({ event: 'audit.run', actor, accountId: i % 2 === 0 ? 'a' : 'b' });
    expect(ledger.read({ limit: 2 }).map((e) => e.seq)).toEqual([5, 4]);
    expect(ledger.read({ accountId: 'a', limit: 2 }).map((e) => e.seq)).toEqual([5, 3]);
    expect(ledger.read({ limit: 10 }).map((e) => e.seq)).toEqual([5, 4, 3, 2, 1]);
    expect(codeOf(() => ledger.read({ limit: -1 }))).toBe('invalid_input');
  });

  it('rejects an unknown event and writes nothing', () => {
    const { ledger } = setup();
    expect(codeOf(() => ledger.append({ event: 'plan.exploded' as LedgerEvent, actor }))).toBe('invalid_input');
    expect(ledger.read()).toEqual([]);
  });

  it('fails closed when the clock rolls back more than five minutes', () => {
    const { ledger, clock } = setup();
    ledger.append({ event: 'audit.run', actor });

    clock.ms = T0 - 4 * 60_000;
    expect(ledger.append({ event: 'audit.run', actor }).seq).toBe(2);

    clock.ms = T0 - 10 * 60_000;
    let caught: unknown;
    try {
      ledger.append({ event: 'audit.run', actor });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AutopilotError);
    expect((caught as AutopilotError).code).toBe('internal');
    expect((caught as AutopilotError).hint).toMatch(/clock/i);
    expect(codeOf(() => ledger.append({ event: 'audit.run', actor, ts: '2025-12-31T00:00:00.000Z' }))).toBe('internal');

    // The failed appends rolled back, so the ledger is still writable and intact.
    clock.ms = T0 + 1000;
    expect(ledger.append({ event: 'audit.run', actor }).seq).toBe(3);
    expect(ledger.verify()).toEqual({ ok: true, entries: 3, brokenAt: null });
  });

  it('uses an explicit ts and omits optional fields that were not provided', () => {
    const { db, ledger } = setup();
    const entry = ledger.append({ event: 'audit.run', actor, ts: '2025-12-31T23:59:00.000Z' });
    expect(entry.ts).toBe('2025-12-31T23:59:00.000Z');
    expect(Object.keys(entry).sort()).toEqual(['actor', 'event', 'hash', 'prevHash', 'seq', 'ts']);

    const row = db.prepare('SELECT * FROM ledger WHERE seq = 1').get();
    expect(Object.keys(JSON.parse(String(row?.['json'])) as object).sort()).toEqual(Object.keys(entry).sort());
    expect(row?.['account_id']).toBeNull();
    expect(row?.['plan_id']).toBeNull();
    expect(row?.['hash']).toBe(entry.hash);

    const full = ledger.append({
      event: 'action.intent',
      actor,
      accountId: 'acc_1',
      planId: 'plan_1',
      executionId: 'exec_0123456789abcdef',
      actionId: 'act_1',
      idempotencyKey: 'key_1',
      data: { field: 'budget' },
    });
    const fullRow = db.prepare('SELECT * FROM ledger WHERE seq = 2').get();
    expect(fullRow?.['execution_id']).toBe('exec_0123456789abcdef');
    expect(fullRow?.['action_id']).toBe('act_1');
    expect(ledger.read({ limit: 1 })).toEqual([full]);
  });
});
