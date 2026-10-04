import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/core/config';
import { openDatabase } from '../../src/core/db';
import type { Db } from '../../src/core/db';
import { AutopilotError } from '../../src/core/errors';
import { digest, shortId } from '../../src/core/ids';
import { createStore } from '../../src/core/store';
import type {
  AccountConfig, Action, ActionDraft, ActionResult, ApprovalReceipt, Connector,
  GateDecision, JsonObject, Judge, LedgerEntry, Paths, Plan, Runtime,
} from '../../src/core/types';
import { buildAction, planDigest } from '../../src/plan/actions';
import { createApprovalService } from '../../src/plan/approval';
import { applyPlan, createRevertPlan } from '../../src/plan/executor';
import type { ApplyOptions } from '../../src/plan/executor';
import { createLedger } from '../../src/plan/ledger';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) =>
      args[0] === '/executor-test/approval.key' ? 'a'.repeat(64) : fs.readFileSync(...args),
  };
});

const START = new Date('2026-10-04T09:00:00.000Z');
const ACTOR: LedgerEntry['actor'] = { kind: 'agent', id: 'executor-test' };
const LIVE: ApplyOptions = { dryRun: false, actor: ACTOR };
const DRY: ApplyOptions = { dryRun: true, actor: ACTOR };
const databases: Db[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
});

function action(id: string, overrides: Partial<Action> = {}): Action {
  return {
    ...buildAction({
      kind: 'google_ads.ad.pause',
      target: { level: 'ad', id },
      params: {},
      rationale: 'Pause the reviewed underperforming ad.',
    }, { status: 'ENABLED' }),
    ...overrides,
  };
}

function stateKey(draft: ActionDraft): string {
  return `${draft.target.level}:${draft.target.id}`;
}

type ApplyArgs = Parameters<Connector['apply']>[1];
type ReadStep = (draft: ActionDraft) => JsonObject | Promise<JsonObject>;
type ApplyStep = (action: Action, options: ApplyArgs) => ActionResult | Promise<ActionResult>;

function fixture(actions: Action[] = [action('one')]) {
  const paths: Paths = {
    home: '/executor-test', config: '/executor-test/config.json', envFile: '/executor-test/.env',
    db: ':memory:', brief: '/executor-test/brief.md', approvalKey: '/executor-test/approval.key',
    killFile: '/executor-test/KILL',
  };
  const db = openDatabase(paths);
  databases.push(db);
  const control = { now: new Date(START), killed: false };
  const now = () => new Date(control.now);
  const store = createStore(db);
  const ledger = createLedger(db, now);
  const account: AccountConfig = {
    id: 'test-account', platform: actions[0]?.platform ?? 'google_ads', externalId: '1234567890', source: 'api', currency: 'USD',
  };
  const config = defaultConfig();
  config.autonomy = 'approve';
  config.accounts = [account];
  const states = new Map<string, JsonObject>();
  for (const item of actions) states.set(stateKey(item), structuredClone(item.before ?? {}));
  const readSteps: ReadStep[] = [];
  const applySteps: ApplyStep[] = [];
  const calls: Array<{ method: 'read' | 'apply'; id: string; events: string[] }> = [];
  const readState = vi.fn(async (draft: ActionDraft): Promise<JsonObject> => {
    calls.push({ method: 'read', id: draft.target.id, events: ledger.read().map((entry) => entry.event) });
    const step = readSteps.shift();
    if (step !== undefined) return structuredClone(await step(draft));
    const state = states.get(stateKey(draft));
    if (state === undefined) throw new AutopilotError('not_found', 'Entity not found.');
    return structuredClone(state);
  });
  const apply = vi.fn(async (item: Action, options: ApplyArgs): Promise<ActionResult> => {
    calls.push({ method: 'apply', id: item.target.id, events: ledger.read().map((entry) => entry.event) });
    const step = applySteps.shift();
    if (step !== undefined) return step(item, options);
    if (!options.validateOnly) states.set(stateKey(item), { ...states.get(stateKey(item)), ...item.after });
    return { ok: true, dryRun: options.validateOnly, after: null };
  });
  const connector: Connector = {
    platform: account.platform,
    source: 'api',
    status: () => ({
      platform: account.platform, accountId: account.id, source: 'api', ready: true,
      missingEnv: [], datasets: [], actions: actions.map((item) => item.kind),
    }),
    fetchSnapshot: async () => { throw new Error('Not used by executor.'); },
    readState,
    apply,
  };
  const gateSteps: Array<(plan: Plan) => GateDecision | Promise<GateDecision>> = [];
  const gatePlan = vi.fn(async ({ plan: reviewed }: Parameters<Judge['gatePlan']>[0]): Promise<GateDecision> => {
    const step = gateSteps.shift();
    return step === undefined ? gate(reviewed) : step(reviewed);
  });
  const judge: Judge = {
    mode: 'jev',
    usage: () => ({
      mode: 'jev', model: 'test', requests: 0, failed: 0, skipped: 0,
      inputTokens: 0, outputTokens: 0, costUsd: 0,
    }),
    classifyTerms: async () => [],
    verifyClaims: async () => [],
    reviewCopy: async () => [],
    gatePlan,
  };
  const approvals = createApprovalService({ store, paths, ttlMinutes: config.policy.approvalTtlMinutes });
  const runtime: Runtime = {
    config, env: {}, paths, store, ledger, approvals, judge, autonomy: 'approve', now,
    account: (id) => {
      if (id !== account.id) throw new AutopilotError('not_found', 'Account not found.');
      return account;
    },
    connector: () => connector,
    killSwitch: () => control.killed,
  };
  const plan: Plan = {
    id: shortId('plan', actions), schemaVersion: 1, createdAt: START.toISOString(), createdBy: 'agent',
    accountId: account.id, platform: account.platform, snapshotId: null,
    title: 'Reviewed pauses', rationale: 'Reduce wasted spend.', actions,
    digest: planDigest({ accountId: account.id, platform: account.platform, actions }), status: 'proposed',
  };
  store.savePlan(plan);

  function approve(): ApprovalReceipt {
    return approvals.issue({
      plan: store.getPlan(plan.id), policyDigest: digest(config.policy), reviewDigest: digest('Exact review text'),
      method: 'tty', approver: 'human', now: now(),
    });
  }

  function oldIntent(item: Action, executionId = shortId('exec', 'earlier')): LedgerEntry {
    return ledger.append({
      ts: new Date(START.getTime() - 48 * 3600000).toISOString(),
      event: 'action.intent', actor: ACTOR, accountId: account.id,
      planId: shortId('plan', 'earlier'), executionId, actionId: item.id,
      idempotencyKey: `${executionId}:${item.id}`,
      data: {
        kind: item.kind, target: { ...item.target }, params: item.params,
        before: item.before, after: item.after, spendEffect: item.spendEffect,
        spendDeltaPerDay: item.spendDeltaPerDay,
      },
    });
  }

  return {
    runtime, plan, account, store, ledger, approvals, connector, control, states, calls,
    readState, apply, readSteps, applySteps, gatePlan, gateSteps, approve, oldIntent,
  };
}

function gate(plan: Plan, overrides: Partial<GateDecision> = {}): GateDecision {
  return {
    planDigest: plan.digest, mode: 'jev', verdict: 'allow', evaluatedAt: START.toISOString(),
    actions: plan.actions.map((item) => ({ actionId: item.id, verdict: 'allow', confidence: 0.9, band: 'act' })),
    ...overrides,
  };
}

function assertLockReleased(f: ReturnType<typeof fixture>): void {
  const next = shortId('exec', 'next');
  expect(f.store.acquireLock(f.account.id, next, f.runtime.now(), 900)).toBe(true);
  f.store.releaseLock(f.account.id, next);
}

function actionEntries(f: ReturnType<typeof fixture>): LedgerEntry[] {
  return f.ledger.read().filter((entry) => entry.event.startsWith('action.'));
}

describe('applyPlan authorization', () => {
  it('requires approval before making any mutation or action ledger entry', async () => {
    const f = fixture();
    await expect(applyPlan(f.plan.id, f.runtime, LIVE)).rejects.toMatchObject({ code: 'approval_required' });
    expect(f.apply).not.toHaveBeenCalled();
    expect(actionEntries(f)).toEqual([]);
    expect(f.store.getPlan(f.plan.id)).toEqual(f.plan);
  });

  it('does not accept caller flags, an actor named human, or empty elicitation as approval', async () => {
    const f = fixture();
    const forged = {
      dryRun: false, actor: { kind: 'human', id: 'administrator' }, elicitedBy: '',
      approved: true, authorized: true, autoApplicable: true, approval: { verdict: 'allow' },
    } as unknown as ApplyOptions;
    await expect(applyPlan(f.plan.id, f.runtime, forged)).rejects.toMatchObject({ code: 'approval_required' });
    expect(f.apply).not.toHaveBeenCalled();
    expect(actionEntries(f)).toEqual([]);
  });

  it.each([undefined, null, 'false', 'true', 0, 1])('requires a boolean dryRun, got %s', async (dryRun) => {
    const f = fixture();
    f.approve();
    await expect(applyPlan(f.plan.id, f.runtime, { ...LIVE, dryRun } as unknown as ApplyOptions))
      .rejects.toMatchObject({ code: 'invalid_input' });
    expect(f.apply).not.toHaveBeenCalled();
    expect(actionEntries(f)).toEqual([]);
  });

  it('refuses a modified stored plan before reading or applying entities', async () => {
    const f = fixture();
    f.approve();
    f.plan.actions[0]!.after = { status: 'ENABLED' };
    f.store.savePlan(f.plan);
    await expect(applyPlan(f.plan.id, f.runtime, LIVE)).rejects.toMatchObject({
      code: 'invalid_input', message: expect.stringContaining('stored plan does not match its digest'),
    });
    expect(f.readState).not.toHaveBeenCalled();
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.ledger.read()).toEqual([]);
  });

  it.each(['applying', 'applied', 'partial', 'failed', 'rejected', 'reverted'] as const)
  ('refuses a plan already in status %s', async (status) => {
    const f = fixture();
    f.plan.status = status;
    f.store.savePlan(f.plan);
    await expect(applyPlan(f.plan.id, f.runtime, LIVE)).rejects.toMatchObject({
      code: 'invalid_input', message: expect.stringContaining(status),
    });
    expect(f.apply).not.toHaveBeenCalled();
  });

  it('rejects a receipt claimed by another execution', async () => {
    const f = fixture();
    const receipt = f.approve();
    f.approvals.claim(receipt, shortId('exec', 'already-used'), f.runtime.now());
    await expect(applyPlan(f.plan.id, f.runtime, { ...LIVE, receiptId: receipt.id }))
      .rejects.toMatchObject({ code: 'approval_invalid' });
    expect(f.apply).not.toHaveBeenCalled();
    expect(actionEntries(f)).toEqual([]);
  });

  it('does not dispatch a completed plan a second time', async () => {
    const f = fixture();
    const receipt = f.approve();
    await applyPlan(f.plan.id, f.runtime, { ...LIVE, receiptId: receipt.id });
    await expect(applyPlan(f.plan.id, f.runtime, { ...LIVE, receiptId: receipt.id }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    expect(f.apply).toHaveBeenCalledTimes(1);
  });

  it('binds a receipt to the current policy', async () => {
    const f = fixture();
    f.approve();
    f.runtime.config.policy.maxActionsPerPlan += 1;
    await expect(applyPlan(f.plan.id, f.runtime, LIVE)).rejects.toMatchObject({ code: 'approval_invalid' });
    expect(f.apply).not.toHaveBeenCalled();
  });

  it('uses the elicitation review digest and records the claimed receipt', async () => {
    const f = fixture();
    const reviewDigest = digest('The human saw this review.');
    const outcome = await applyPlan(f.plan.id, f.runtime, { ...LIVE, elicitedBy: 'trusted-client', reviewDigest });
    expect(f.ledger.read()[0]).toMatchObject({
      event: 'execution.claimed', executionId: outcome.executionId,
      data: { method: 'elicitation', approver: 'trusted-client', reviewDigest, planDigest: f.plan.digest },
    });
    expect(f.store.findReceipts(f.plan.id)).toHaveLength(1);
  });

  it('refuses every policy denial live and reports them in dry run', async () => {
    const f = fixture([action('one'), action('two')]);
    f.runtime.config.policy.denyKinds = ['google_ads.ad.pause'];
    f.runtime.config.policy.maxActionsPerPlan = 1;
    f.approve();
    await expect(applyPlan(f.plan.id, f.runtime, LIVE)).rejects.toMatchObject({
      code: 'policy_denied', message: expect.stringMatching(/maximum action count[\s\S]*denied by policy/i),
    });
    expect(f.apply).not.toHaveBeenCalled();
    const outcome = await applyPlan(f.plan.id, f.runtime, DRY);
    expect(outcome.results).toHaveLength(2);
    for (const result of outcome.results) {
      expect(result.note).toContain('policy would deny:');
      expect(result.note).toContain('maximum action count');
      expect(result.note).toContain('denied by policy');
    }
    expect(f.ledger.read()).toEqual([]);
  });

  it('treats a missing referenced snapshot as a policy denial', async () => {
    const f = fixture();
    f.plan.snapshotId = shortId('snap', 'missing');
    f.plan.digest = planDigest(f.plan);
    f.store.savePlan(f.plan);
    await expect(applyPlan(f.plan.id, f.runtime, LIVE)).rejects.toMatchObject({ code: 'policy_denied' });
    const outcome = await applyPlan(f.plan.id, f.runtime, DRY);
    expect(outcome.results[0]?.note).toContain('snapshot');
  });
});

describe('applyPlan execution', () => {
  it('writes intent before dispatch, reads back state, persists progress, and releases the lock', async () => {
    const f = fixture([action('one'), action('two')]);
    const receipt = f.approve();
    const saved: Plan[] = [];
    const savePlan = f.store.savePlan.bind(f.store);
    vi.spyOn(f.store, 'savePlan').mockImplementation((plan) => {
      saved.push(structuredClone(plan));
      savePlan(plan);
    });
    f.applySteps.push((item) => {
      f.states.set(stateKey(item), { ...item.after, observed: 'read from platform' });
      return { ok: true, dryRun: false, after: null, resource: 'ads/one', platformRequestId: 'request-1' };
    });
    const outcome = await applyPlan(f.plan.id, f.runtime, { ...LIVE, receiptId: receipt.id });
    expect(outcome).toMatchObject({ dryRun: false, applied: 2, failed: 0, skipped: 0, unknown: 0, plan: { status: 'applied' } });
    expect(outcome.results[0]?.result?.after).toEqual({ status: 'PAUSED', observed: 'read from platform' });
    expect(f.calls.map((call) => `${call.method}:${call.id}`)).toEqual([
      'read:one', 'apply:one', 'read:one', 'read:two', 'apply:two', 'read:two',
    ]);
    expect(f.calls.filter((call) => call.method === 'apply').every((call) => call.events.at(-1) === 'action.intent')).toBe(true);
    const entries = f.ledger.read();
    expect(entries.map((entry) => entry.event)).toEqual([
      'execution.claimed', 'action.intent', 'action.applied', 'action.intent', 'action.applied', 'execution.closed',
    ]);
    expect(entries[1]?.idempotencyKey).toBe(`${outcome.executionId}:${f.plan.actions[0]!.id}`);
    expect(f.apply.mock.calls[0]?.[1]).toEqual({
      validateOnly: false, idempotencyKey: `${outcome.executionId}:${f.plan.actions[0]!.id}`,
    });
    expect(entries[2]?.data).toMatchObject({ resource: 'ads/one', platformRequestId: 'request-1' });
    expect(entries[5]?.data).toEqual({ applied: 2, failed: 0, skipped: 0, unknown: 0, status: 'applied' });
    expect(outcome.ledgerSeqs).toEqual(entries.map((entry) => entry.seq));
    expect(f.store.receiptClaim(receipt.id)?.executionId).toBe(outcome.executionId);
    expect(saved[0]?.status).toBe('applying');
    expect(saved.some((plan) => plan.actions[0]?.status === 'applied' && plan.actions[1]?.status === 'pending')).toBe(true);
    expect(f.store.getPlan(f.plan.id)).toEqual(outcome.plan);
    expect(f.ledger.verify().ok).toBe(true);
    assertLockReleased(f);
  });

  it('skips a stale precondition and continues with the other actions', async () => {
    const f = fixture([action('one'), action('two')]);
    f.approve();
    f.states.set('ad:one', { status: 'REMOVED' });
    const outcome = await applyPlan(f.plan.id, f.runtime, LIVE);
    expect(outcome).toMatchObject({ applied: 1, skipped: 1, failed: 0, plan: { status: 'partial' } });
    expect(outcome.results[0]).toMatchObject({ status: 'skipped', note: 'stale: the entity changed since the plan was created' });
    expect(f.apply.mock.calls.map(([item]) => item.target.id)).toEqual(['two']);
    expect(actionEntries(f).map((entry) => entry.event)).toEqual(['action.skipped', 'action.intent', 'action.applied']);
  });

  it('skips an unverifiable precondition and continues', async () => {
    const f = fixture([action('one'), action('two')]);
    f.approve();
    f.readSteps.push(() => { throw new AutopilotError('platform_error', 'State read failed.'); });
    const outcome = await applyPlan(f.plan.id, f.runtime, LIVE);
    expect(outcome.results[0]).toMatchObject({ status: 'skipped', note: expect.stringContaining('State read failed.') });
    expect(outcome.applied).toBe(1);
    expect(f.apply.mock.calls.map(([item]) => item.target.id)).toEqual(['two']);
  });

  it('stops after a definite platform refusal and records only error code and message', async () => {
    const f = fixture([action('one'), action('two')]);
    f.approve();
    const platformError = { code: 'rejected', message: 'The platform refused the change.', retryable: false, body: 'secret-body', token: 'secret-token' };
    f.applySteps.push(() => ({ ok: false, dryRun: false, after: null, error: platformError }));
    const outcome = await applyPlan(f.plan.id, f.runtime, LIVE);
    expect(outcome).toMatchObject({ failed: 1, skipped: 1, applied: 0, plan: { status: 'failed' } });
    expect(outcome.results[1]).toMatchObject({ status: 'skipped', note: 'a previous action failed' });
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect(f.readState).toHaveBeenCalledTimes(1);
    expect(f.ledger.read({ events: ['action.failed'] })[0]?.data?.error).toEqual({ code: 'rejected', message: 'The platform refused the change.' });
    expect(JSON.stringify(f.ledger.read())).not.toMatch(/secret-body|secret-token/);
    assertLockReleased(f);
  });

  it.each(['thrown', 'returned'] as const)('redacts secrets in a %s error and omits the full response body', async (mode) => {
    const f = fixture();
    f.approve();
    f.runtime.env.GOOGLE_ADS_REFRESH_TOKEN = 'environment-refresh-secret';
    const platformError = Object.assign(new Error(
      'Request failed: environment-refresh-secret; Authorization: Bearer bearer-token-secret',
    ), {
      code: 'platform_error', retryable: false,
      body: { private: 'full-platform-response-secret' }, rawResponse: 'unfiltered-response-payload',
    });
    f.applySteps.push(() => {
      if (mode === 'thrown') throw platformError;
      return { ok: false, dryRun: false, after: null, error: platformError };
    });
    expect((await applyPlan(f.plan.id, f.runtime, LIVE)).failed).toBe(1);
    const entries = f.ledger.read();
    expect(entries.find((entry) => entry.event === 'action.failed')?.data?.error).toEqual({
      code: 'platform_error',
      message: 'Request failed: [redacted:GOOGLE_ADS_REFRESH_TOKEN]; Authorization: Bearer [redacted]',
    });
    expect(JSON.stringify(entries)).not.toMatch(
      /environment-refresh-secret|bearer-token-secret|full-platform-response-secret|unfiltered-response-payload/,
    );
  });

  it('keeps a successful result when the post-apply read fails', async () => {
    const f = fixture();
    f.approve();
    f.readSteps.push(() => ({ status: 'ENABLED' }), () => { throw new Error('Read-back unavailable.'); });
    const outcome = await applyPlan(f.plan.id, f.runtime, LIVE);
    expect(outcome.results[0]).toMatchObject({ status: 'applied', result: { after: null } });
    expect(f.ledger.read({ events: ['action.applied'] })[0]?.data?.after).toEqual({ status: 'PAUSED' });
  });

  it.each(['throw', 'retryable'] as const)('never resends after %s and reconciles an observed change', async (mode) => {
    const f = fixture([action('one'), action('two')]);
    f.approve();
    f.applySteps.push((item) => {
      f.states.set(stateKey(item), { status: 'PAUSED', unrelated: 'changed independently' });
      if (mode === 'throw') throw new AutopilotError('platform_error', 'Connection lost.', { retryable: true, cause: { token: 'secret' } });
      return { ok: false, dryRun: false, after: null, error: { code: 'timeout', message: 'Connection lost.', retryable: true } };
    });
    const outcome = await applyPlan(f.plan.id, f.runtime, LIVE);
    expect(outcome).toMatchObject({ applied: 2, failed: 0, skipped: 0, unknown: 0 });
    expect(f.apply.mock.calls.map(([item]) => item.target.id)).toEqual(['one', 'two']);
    expect(f.ledger.read({ events: ['action.reconciled'] })[0]?.data?.outcome).toBe('applied');
    expect(outcome.results[0]?.result?.after).toMatchObject({ status: 'PAUSED' });
    expect(JSON.stringify(f.ledger.read())).not.toContain('secret');
  });

  it('marks a thrown mutation failed when only the old state is observed', async () => {
    const f = fixture([action('one'), action('two')]);
    f.approve();
    f.applySteps.push(() => { throw new Error('Connection lost.'); });
    const outcome = await applyPlan(f.plan.id, f.runtime, LIVE);
    expect(outcome).toMatchObject({ applied: 0, failed: 1, skipped: 1, unknown: 0 });
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect(f.ledger.read({ events: ['action.failed'] })).toHaveLength(1);
  });

  it.each(['different', 'read-error'] as const)('leaves %s ambiguous state unknown and stops', async (mode) => {
    const f = fixture([action('one'), action('two')]);
    f.approve();
    f.applySteps.push((item) => {
      f.states.set(stateKey(item), { status: 'REMOVED' });
      if (mode === 'read-error') f.readSteps.push(() => { throw new Error('Cannot reconcile.'); });
      throw new Error('Mutation timed out.');
    });
    const outcome = await applyPlan(f.plan.id, f.runtime, LIVE);
    expect(outcome).toMatchObject({ applied: 0, failed: 0, skipped: 1, unknown: 1, plan: { status: 'failed' } });
    expect(outcome.results.map((result) => result.status)).toEqual(['unknown', 'skipped']);
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect(f.ledger.read({ events: ['action.unknown'] })).toHaveLength(1);
    assertLockReleased(f);
  });

  it('does not dispatch without a durable intent and skips the remaining actions', async () => {
    const f = fixture([action('one'), action('two')]);
    f.approve();
    const append = f.ledger.append.bind(f.ledger);
    vi.spyOn(f.ledger, 'append').mockImplementation((entry) => {
      if (entry.event === 'action.intent') throw new Error('Intent storage unavailable.');
      return append(entry);
    });
    const outcome = await applyPlan(f.plan.id, f.runtime, LIVE);
    expect(f.apply).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ skipped: 2, applied: 0, plan: { status: 'failed' } });
    expect(f.ledger.read({ events: ['action.intent'] })).toEqual([]);
    assertLockReleased(f);
  });

  it('skips remaining actions when the kill switch turns on', async () => {
    const f = fixture([action('one'), action('two'), action('three')]);
    f.approve();
    f.applySteps.push((item) => {
      f.states.set(stateKey(item), item.after);
      f.control.killed = true;
      return { ok: true, dryRun: false, after: null };
    });
    const outcome = await applyPlan(f.plan.id, f.runtime, LIVE);
    expect(outcome).toMatchObject({ applied: 1, skipped: 2, plan: { status: 'partial' } });
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect(outcome.results.slice(1).every((result) => /kill/i.test(result.note ?? ''))).toBe(true);
    expect(f.ledger.read({ events: ['action.skipped'] })).toHaveLength(2);
  });

  it('skips remaining actions when approval expires mid-run', async () => {
    const f = fixture([action('one'), action('two')]);
    const receipt = f.approve();
    f.applySteps.push((item) => {
      f.states.set(stateKey(item), item.after);
      f.control.now = new Date(Date.parse(receipt.expiresAt) + 1);
      return { ok: true, dryRun: false, after: null };
    });
    const outcome = await applyPlan(f.plan.id, f.runtime, LIVE);
    expect(outcome).toMatchObject({ applied: 1, skipped: 1 });
    expect(outcome.results[1]?.note).toMatch(/expir/i);
    expect(f.apply).toHaveBeenCalledTimes(1);
  });

  it.each(['kill-switch', 'expiry'] as const)('rechecks %s after the precondition read', async (reason) => {
    const f = fixture([action('one'), action('two')]);
    const receipt = f.approve();
    f.readSteps.push(() => {
      if (reason === 'kill-switch') f.control.killed = true;
      else f.control.now = new Date(Date.parse(receipt.expiresAt) + 1);
      return { status: 'ENABLED' };
    });
    const outcome = await applyPlan(f.plan.id, f.runtime, LIVE);
    expect(outcome).toMatchObject({ skipped: 2, applied: 0, failed: 0 });
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.ledger.read({ events: ['action.intent'] })).toEqual([]);
    expect(f.ledger.read({ events: ['action.skipped'] })).toHaveLength(2);
  });

  it.each(['kill-switch', 'expiry'] as const)('rechecks %s after recording the intent', async (reason) => {
    const f = fixture([action('one'), action('two')]);
    const receipt = f.approve();
    const append = f.ledger.append.bind(f.ledger);
    vi.spyOn(f.ledger, 'append').mockImplementation((entry) => {
      const written = append(entry);
      if (entry.event === 'action.intent') {
        if (reason === 'kill-switch') f.control.killed = true;
        else f.control.now = new Date(Date.parse(receipt.expiresAt) + 1);
      }
      return written;
    });
    const outcome = await applyPlan(f.plan.id, f.runtime, LIVE);
    expect(outcome).toMatchObject({ skipped: 2, applied: 0, failed: 0 });
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.ledger.read({ events: ['action.intent'] })).toHaveLength(1);
    expect(f.ledger.read({ events: ['action.skipped'] })).toHaveLength(2);
  });

  it('never resends a successful mutation when recording its result fails', async () => {
    const f = fixture([action('one'), action('two')]);
    f.approve();
    const append = f.ledger.append.bind(f.ledger);
    vi.spyOn(f.ledger, 'append').mockImplementation((entry) => {
      if (entry.event === 'action.applied') throw new Error('Result storage unavailable.');
      return append(entry);
    });
    await expect(applyPlan(f.plan.id, f.runtime, LIVE)).rejects.toThrow('Result storage unavailable.');
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect(f.store.getPlan(f.plan.id).actions.map((item) => item.status)).toEqual(['applied', 'pending']);
    expect(f.store.getPlan(f.plan.id).status).toBe('partial');
    expect(f.ledger.read({ events: ['action.intent'] })).toHaveLength(1);
    expect(f.ledger.read({ events: ['action.applied', 'action.reconciled'] })).toEqual([]);
    assertLockReleased(f);
    expect((await createRevertPlan(f.plan.id, f.runtime)).actions.map((item) => item.target.id)).toEqual(['one']);
    const next: Plan = {
      ...f.plan, id: shortId('plan', 'next'), actions: [action('other')], status: 'proposed',
    };
    next.digest = planDigest(next);
    f.store.savePlan(next);
    f.approvals.issue({
      plan: next, policyDigest: digest(f.runtime.config.policy), reviewDigest: digest('Next review'),
      method: 'tty', approver: 'human', now: f.runtime.now(),
    });
    vi.spyOn(f.approvals, 'claim').mockImplementation(() => { throw new Error('Stop after reconciliation.'); });
    await expect(applyPlan(next.id, f.runtime, LIVE)).rejects.toThrow('Stop after reconciliation.');
    expect(f.ledger.read({ events: ['action.reconciled'] })[0]).toMatchObject({
      planId: f.plan.id, actionId: f.plan.actions[0]!.id, data: { outcome: 'applied' },
    });
    expect(f.store.getPlan(f.plan.id)).toMatchObject({ status: 'partial', actions: [{ status: 'applied' }, { status: 'pending' }] });
    expect(f.apply).toHaveBeenCalledTimes(1);
  });

  it.each([
    { event: 'action.applied', size: 1, status: 'applied' },
    { event: 'action.applied', size: 2, status: 'partial' },
    { event: 'action.skipped', size: 2, status: 'partial' },
    { event: 'execution.closed', size: 1, status: 'applied' },
  ] as const)('finalizes $status when $event cannot be saved', async ({ event, size, status }) => {
    const f = fixture([action('one'), action('two')].slice(0, size));
    f.approve();
    if (event === 'action.skipped') f.states.set('ad:two', { status: 'REMOVED' });
    const append = f.ledger.append.bind(f.ledger);
    vi.spyOn(f.ledger, 'append').mockImplementation((entry) => {
      if (entry.event === event) throw new Error('Ledger unavailable.');
      return append(entry);
    });
    await expect(applyPlan(f.plan.id, f.runtime, LIVE)).rejects.toThrow('Ledger unavailable.');
    expect(f.store.getPlan(f.plan.id).status).toBe(status);
    expect(f.apply).toHaveBeenCalledTimes(1);
    assertLockReleased(f);
  });

  it('finalizes failed and releases the lock if saving the applying status throws', async () => {
    const f = fixture();
    f.approve();
    const save = f.store.savePlan.bind(f.store);
    vi.spyOn(f.store, 'savePlan').mockImplementation((plan) => {
      save(plan);
      if (plan.status === 'applying') throw new Error('Progress storage unavailable.');
    });
    await expect(applyPlan(f.plan.id, f.runtime, LIVE)).rejects.toThrow('Progress storage unavailable.');
    expect(f.store.getPlan(f.plan.id).status).toBe('failed');
    expect(f.apply).not.toHaveBeenCalled();
    assertLockReleased(f);
  });

  it('marks a dispatched action unknown if processing its result throws before recording it', async () => {
    const f = fixture();
    f.approve();
    const result: ActionResult = { ok: false, dryRun: false, after: null };
    let reads = 0;
    Object.defineProperty(result, 'error', { get: () => {
      if (reads++ === 0) return { code: 'rejected', message: 'Rejected.', retryable: false };
      throw new Error('Unreadable result.');
    } });
    f.applySteps.push(() => result);
    await expect(applyPlan(f.plan.id, f.runtime, LIVE)).rejects.toThrow('Unreadable result.');
    expect(f.store.getPlan(f.plan.id)).toMatchObject({ status: 'failed', actions: [{ status: 'unknown' }] });
    expect(f.apply).toHaveBeenCalledTimes(1);
    assertLockReleased(f);
  });

  it('keeps the winner locked when concurrent calls share a plan, receipt, and clock tick', async () => {
    const f = fixture();
    const receipt = f.approve();
    let finish!: (result: ActionResult) => void;
    let entered!: () => void;
    const held = new Promise<ActionResult>((resolve) => { finish = resolve; });
    const dispatched = new Promise<void>((resolve) => { entered = resolve; });
    f.applySteps.push(() => { entered(); return held; });
    const acquire = vi.spyOn(f.store, 'acquireLock');
    const release = vi.spyOn(f.store, 'releaseLock');
    const first = applyPlan(f.plan.id, f.runtime, { ...LIVE, receiptId: receipt.id });
    const second = applyPlan(f.plan.id, f.runtime, { ...LIVE, receiptId: receipt.id })
      .then(() => null, (error: unknown) => error);
    try {
      const rejected = await second;
      await dispatched;
      expect(rejected).toMatchObject({ code: 'stale_state', retryable: true });
      const owners = acquire.mock.calls.slice(0, 2).map(([, owner]) => owner);
      expect(new Set(owners).size).toBe(2);
      expect(owners.every((owner) => /^exec_[0-9a-f]{16}$/.test(owner))).toBe(true);
      expect(release).not.toHaveBeenCalled();
      expect(f.store.acquireLock(f.account.id, shortId('exec', 'third'), f.runtime.now(), 900)).toBe(false);
      expect(f.apply).toHaveBeenCalledTimes(1);
    } finally {
      finish({ ok: true, dryRun: false, after: null });
      await first;
    }
    expect(release).toHaveBeenCalledTimes(1);
    assertLockReleased(f);
  });

  it('refuses a held account lock without claiming approval', async () => {
    const f = fixture();
    const receipt = f.approve();
    const holder = shortId('exec', 'holder');
    expect(f.store.acquireLock(f.account.id, holder, f.runtime.now(), 900)).toBe(true);
    await expect(applyPlan(f.plan.id, f.runtime, LIVE)).rejects.toMatchObject({ code: 'stale_state', retryable: true });
    expect(f.store.receiptClaim(receipt.id)).toBeNull();
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.store.acquireLock(f.account.id, shortId('exec', 'contender'), f.runtime.now(), 900)).toBe(false);
    f.store.releaseLock(f.account.id, holder);
    expect((await applyPlan(f.plan.id, f.runtime, LIVE)).applied).toBe(1);
  });

  it('releases the account lock when claiming approval throws', async () => {
    const f = fixture();
    f.approve();
    vi.spyOn(f.approvals, 'claim').mockImplementation(() => { throw new AutopilotError('approval_invalid', 'Receipt race.'); });
    await expect(applyPlan(f.plan.id, f.runtime, LIVE)).rejects.toMatchObject({ code: 'approval_invalid' });
    expect(f.apply).not.toHaveBeenCalled();
    assertLockReleased(f);
  });
});

describe('reconciliation before execution', () => {
  it.each(['applied', 'not_applied', 'conflict'] as const)
  ('updates the original plan from a reconciled %s outcome without another mutation', async (outcome) => {
    const f = fixture();
    const prior = action('earlier', {
      status: 'unknown', result: {
        ok: false, dryRun: false, after: null, resource: 'ads/earlier',
        error: { code: 'timeout', message: 'Timed out.', retryable: true },
      },
    });
    const intent = f.oldIntent(prior);
    const original: Plan = {
      ...f.plan, id: intent.planId!, actions: [prior], status: 'applying',
    };
    original.digest = planDigest(original);
    f.store.savePlan(original);
    f.states.set('ad:earlier', { status: outcome === 'applied' ? 'PAUSED' : outcome === 'not_applied' ? 'ENABLED' : 'REMOVED' });
    f.approve();
    vi.spyOn(f.approvals, 'claim').mockImplementation(() => { throw new Error('Stop after reconciliation.'); });
    await expect(applyPlan(f.plan.id, f.runtime, LIVE)).rejects.toThrow('Stop after reconciliation.');
    expect(f.store.getPlan(original.id)).toMatchObject({
      status: outcome === 'applied' ? 'applied' : 'failed',
      actions: [{ status: outcome === 'applied' ? 'applied' : outcome === 'not_applied' ? 'failed' : 'unknown' }],
    });
    const repaired = f.store.getPlan(original.id).actions[0]!;
    expect(repaired.result).toMatchObject({
      ok: outcome === 'applied', dryRun: false,
      after: outcome === 'applied' ? { status: 'PAUSED' } : null,
    });
    if (outcome === 'applied') {
      expect(repaired.result?.resource).toBe('ads/earlier');
      expect(repaired.result?.error).toBeUndefined();
    }
    expect(f.store.getPlan(f.plan.id).status).toBe('proposed');
    expect(f.apply).not.toHaveBeenCalled();
    assertLockReleased(f);
  });

  it('repairs the original plan before a reconciliation ledger write can fail', async () => {
    const f = fixture();
    const prior = action('earlier', { status: 'unknown' });
    const intent = f.oldIntent(prior);
    const original: Plan = { ...f.plan, id: intent.planId!, actions: [prior], status: 'failed' };
    original.digest = planDigest(original);
    f.store.savePlan(original);
    f.states.set('ad:earlier', { status: 'PAUSED' });
    f.approve();
    const append = f.ledger.append.bind(f.ledger);
    vi.spyOn(f.ledger, 'append').mockImplementation((entry) => {
      if (entry.event === 'action.reconciled') throw new Error('Reconciliation ledger unavailable.');
      return append(entry);
    });
    await expect(applyPlan(f.plan.id, f.runtime, LIVE)).rejects.toThrow('Reconciliation ledger unavailable.');
    expect(f.store.getPlan(original.id)).toMatchObject({ status: 'applied', actions: [{ status: 'applied' }] });
    expect(f.ledger.read({ events: ['action.reconciled'] })).toEqual([]);
    expect(f.apply).not.toHaveBeenCalled();
    assertLockReleased(f);
  });

  it.each(['applied', 'not_applied'] as const)('never resends its own old intent reconciled as %s', async (outcome) => {
    const f = fixture();
    const prior = f.plan.actions[0]!;
    f.ledger.append({
      ts: new Date(START.getTime() - 48 * 3600000).toISOString(),
      event: 'action.intent', actor: ACTOR, accountId: f.account.id, planId: f.plan.id,
      executionId: shortId('exec', 'earlier'), actionId: prior.id,
      data: { kind: prior.kind, target: { ...prior.target }, params: prior.params, before: prior.before, after: prior.after },
    });
    f.states.set('ad:one', { status: outcome === 'applied' ? 'PAUSED' : 'ENABLED' });
    const receipt = f.approve();
    await expect(applyPlan(f.plan.id, f.runtime, LIVE)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(f.store.getPlan(f.plan.id).status).toBe(outcome === 'applied' ? 'applied' : 'failed');
    expect(f.store.receiptClaim(receipt.id)).toBeNull();
    expect(f.apply).not.toHaveBeenCalled();
    assertLockReleased(f);
  });

  it.each(['applied', 'not_applied'] as const)('settles old intents as %s before claiming new work', async (outcome) => {
    const f = fixture();
    const prior = action('earlier', {
      before: { status: 'ENABLED', metadata: 'old' }, after: { status: 'PAUSED' },
    });
    const intent = f.oldIntent(prior);
    f.states.set('ad:earlier', { status: outcome === 'applied' ? 'PAUSED' : 'ENABLED', metadata: 'new' });
    f.approve();
    const result = await applyPlan(f.plan.id, f.runtime, LIVE);
    const entries = f.ledger.read();
    expect(entries[1]).toMatchObject({
      event: 'action.reconciled', executionId: intent.executionId, actionId: prior.id, data: { outcome },
    });
    expect(entries[2]?.event).toBe('execution.claimed');
    expect(f.calls[0]).toMatchObject({ method: 'read', id: 'earlier' });
    expect(f.readState.mock.calls[0]?.[0]).toMatchObject({ kind: prior.kind, target: prior.target, params: prior.params });
    expect(result.ledgerSeqs).toEqual(entries.slice(1).map((entry) => entry.seq));
    expect(f.apply.mock.calls.map(([item]) => item.target.id)).toEqual(['one']);
  });

  it.each(['different', 'read-error'] as const)('blocks new work on an entity with %s reconciliation conflict', async (mode) => {
    const f = fixture();
    f.oldIntent(f.plan.actions[0]!);
    f.approve();
    f.states.set('ad:one', { status: 'REMOVED' });
    if (mode === 'read-error') f.readSteps.push(() => { throw new Error('Entity unavailable.'); });
    await expect(applyPlan(f.plan.id, f.runtime, LIVE)).rejects.toMatchObject({
      code: 'stale_state', message: expect.stringMatching(/unknown outcome[\s\S]*person|person[\s\S]*unknown outcome/i),
    });
    expect(f.ledger.read({ events: ['action.reconciled'] })[0]?.data?.outcome).toBe('conflict');
    expect(f.ledger.read({ events: ['execution.claimed'] })).toEqual([]);
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.store.getPlan(f.plan.id).status).toBe('proposed');
    assertLockReleased(f);
  });

  it('allows unrelated work while retaining a previous conflict', async () => {
    const f = fixture();
    f.oldIntent(action('other'));
    f.states.set('ad:other', { status: 'REMOVED' });
    f.approve();
    expect((await applyPlan(f.plan.id, f.runtime, LIVE)).applied).toBe(1);
    expect(f.ledger.read({ events: ['action.reconciled'] })[0]?.data?.outcome).toBe('conflict');
  });

  it('blocks an unresolved intent whose target cannot be identified', async () => {
    const f = fixture();
    const item = f.plan.actions[0]!;
    f.ledger.append({
      ts: new Date(START.getTime() - 48 * 3600000).toISOString(), event: 'action.intent',
      actor: ACTOR, accountId: f.account.id, planId: shortId('plan', 'unidentified'),
      executionId: shortId('exec', 'unidentified'), actionId: item.id,
      data: { kind: item.kind, target: { level: 'ad' }, params: {}, before: item.before, after: item.after },
    });
    const receipt = f.approve();
    await expect(applyPlan(f.plan.id, f.runtime, LIVE)).rejects.toMatchObject({
      code: 'stale_state', message: expect.stringContaining('unidentified entity'),
    });
    expect(f.ledger.read({ events: ['action.reconciled'] })[0]?.data?.outcome).toBe('conflict');
    expect(f.ledger.read({ events: ['execution.claimed'] })).toEqual([]);
    expect(f.store.receiptClaim(receipt.id)).toBeNull();
    expect(f.readState).not.toHaveBeenCalled();
    expect(f.apply).not.toHaveBeenCalled();
    assertLockReleased(f);
  });

  it.each(['action.applied', 'action.failed', 'action.skipped', 'action.reconciled'] as const)
  ('does not re-read an intent already resolved by a later %s entry', async (event) => {
    const f = fixture();
    const prior = action('other');
    const intent = f.oldIntent(prior);
    f.ledger.append({
      ts: intent.ts, event, actor: ACTOR, accountId: f.account.id,
      executionId: intent.executionId!, actionId: prior.id, data: { outcome: 'not_applied' },
    });
    f.approve();
    await applyPlan(f.plan.id, f.runtime, LIVE);
    expect(f.readState.mock.calls.every(([draft]) => draft.target.id === 'one')).toBe(true);
  });

  it('does not treat another execution of the same action as resolving an intent', async () => {
    const f = fixture();
    const prior = action('other');
    const intent = f.oldIntent(prior);
    f.ledger.append({
      ts: intent.ts, event: 'action.applied', actor: ACTOR, accountId: f.account.id,
      executionId: shortId('exec', 'different'), actionId: prior.id,
      data: { kind: prior.kind, target: { ...prior.target }, after: prior.after },
    });
    f.states.set(stateKey(prior), { status: 'PAUSED' });
    f.approve();
    await applyPlan(f.plan.id, f.runtime, LIVE);
    expect(f.readState.mock.calls[0]?.[0].target.id).toBe('other');
    expect(f.ledger.read({ events: ['action.reconciled'] })[0]).toMatchObject({
      executionId: intent.executionId, actionId: prior.id, data: { outcome: 'applied' },
    });
  });
});

describe('policy auto-apply', () => {
  it('requires human approval if autonomy drops while the gate is running', async () => {
    const f = fixture();
    f.runtime.autonomy = 'autopilot';
    f.runtime.config.policy.autoApply = ['google_ads.ad.pause'];
    f.gateSteps.push((plan) => {
      f.runtime.autonomy = 'approve';
      return gate(plan);
    });
    await expect(applyPlan(f.plan.id, f.runtime, LIVE)).rejects.toMatchObject({ code: 'approval_required' });
    expect(f.store.findReceipts(f.plan.id)).toEqual([]);
    expect(f.apply).not.toHaveBeenCalled();
    assertLockReleased(f);
  });

  it('leaves no automatic receipt if reconciliation aborts before the claim', async () => {
    const f = fixture();
    f.runtime.autonomy = 'autopilot';
    f.runtime.config.policy.autoApply = ['google_ads.ad.pause'];
    f.oldIntent(f.plan.actions[0]!);
    f.states.set('ad:one', { status: 'REMOVED' });
    await expect(applyPlan(f.plan.id, f.runtime, LIVE)).rejects.toMatchObject({ code: 'stale_state' });
    expect(f.store.findReceipts(f.plan.id)).toEqual([]);
    expect(f.apply).not.toHaveBeenCalled();
    assertLockReleased(f);
  });

  it('leaves no automatic receipt when an account lock prevents execution', async () => {
    const f = fixture();
    f.runtime.autonomy = 'autopilot';
    f.runtime.config.policy.autoApply = ['google_ads.ad.pause'];
    const holder = shortId('exec', 'holder');
    f.store.acquireLock(f.account.id, holder, f.runtime.now(), 900);
    await expect(applyPlan(f.plan.id, f.runtime, LIVE)).rejects.toMatchObject({ code: 'stale_state' });
    expect(f.store.findReceipts(f.plan.id)).toEqual([]);
    f.store.releaseLock(f.account.id, holder);
    f.runtime.autonomy = 'approve';
    await expect(applyPlan(f.plan.id, f.runtime, LIVE)).rejects.toMatchObject({ code: 'approval_required' });
    expect(f.apply).not.toHaveBeenCalled();
  });

  it.each(['autonomy-drop', 'gate-deny', 'gate-fallback'] as const)
  ('rejects an abandoned policy receipt returned by verification after %s', async (mode) => {
    const f = fixture();
    f.runtime.autonomy = 'autopilot';
    f.runtime.config.policy.autoApply = ['google_ads.ad.pause'];
    const abandoned = f.approvals.issue({
      plan: f.plan, policyDigest: digest(f.runtime.config.policy), reviewDigest: f.plan.digest,
      method: 'policy', approver: 'policy', now: f.runtime.now(),
    });
    vi.spyOn(f.approvals, 'verify').mockReturnValue(abandoned);
    if (mode === 'autonomy-drop') f.runtime.autonomy = 'approve';
    else f.gateSteps.push((plan) => gate(plan, mode === 'gate-deny' ? { verdict: 'deny' } : { mode: 'fallback' }));
    await expect(applyPlan(f.plan.id, f.runtime, { ...LIVE, receiptId: abandoned.id }))
      .rejects.toMatchObject({ code: 'approval_required' });
    expect(f.store.receiptClaim(abandoned.id)).toBeNull();
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.ledger.read()).toEqual([]);
  });

  it('issues policy approval only with an eligible policy and Jev allowing at the threshold', async () => {
    const f = fixture();
    f.runtime.autonomy = 'autopilot';
    f.runtime.config.policy.autoApply = ['google_ads.ad.pause'];
    const outcome = await applyPlan(f.plan.id, f.runtime, LIVE);
    expect(outcome.applied).toBe(1);
    expect(f.gatePlan).toHaveBeenCalledWith({
      plan: expect.objectContaining({ id: f.plan.id, digest: f.plan.digest }),
      policy: f.runtime.config.policy, findings: [],
    });
    expect(f.store.findReceipts(f.plan.id)[0]).toMatchObject({
      method: 'policy', approver: 'policy', reviewDigest: f.plan.digest,
    });
  });

  it.each(['fallback', 'abstain', 'deny', 'action-deny', 'low-confidence', 'throw'] as const)
  ('requires a receipt after gate outcome %s', async (mode) => {
    const f = fixture();
    f.runtime.autonomy = 'autopilot';
    f.runtime.config.policy.autoApply = ['google_ads.ad.pause'];
    f.gateSteps.push((plan) => {
      if (mode === 'throw') throw new Error('Judge unavailable.');
      if (mode === 'fallback') return gate(plan, { mode: 'fallback' });
      if (mode === 'abstain' || mode === 'deny') return gate(plan, { verdict: mode });
      return gate(plan, { actions: [{
        actionId: plan.actions[0]!.id, verdict: mode === 'action-deny' ? 'deny' : 'allow',
        confidence: mode === 'low-confidence' ? 0.899 : 1, band: 'act',
      }] });
    });
    await expect(applyPlan(f.plan.id, f.runtime, LIVE)).rejects.toMatchObject({ code: 'approval_required' });
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.store.findReceipts(f.plan.id)).toEqual([]);
    expect(f.ledger.read()).toEqual([]);
  });

  it('falls through to a valid receipt when the judge cannot authorize', async () => {
    const f = fixture();
    f.runtime.autonomy = 'autopilot';
    f.runtime.config.policy.autoApply = ['google_ads.ad.pause'];
    const receipt = f.approve();
    f.gateSteps.push((plan) => gate(plan, { mode: 'fallback' }));
    expect((await applyPlan(f.plan.id, f.runtime, LIVE)).applied).toBe(1);
    expect(f.store.findReceipts(f.plan.id)).toEqual([receipt]);
    expect(f.ledger.read()[0]?.data?.method).toBe('tty');
  });

  it('does not ask the gate when policy does not allow auto-apply', async () => {
    const f = fixture();
    f.runtime.autonomy = 'autopilot';
    await expect(applyPlan(f.plan.id, f.runtime, LIVE)).rejects.toMatchObject({ code: 'approval_required' });
    expect(f.gatePlan).not.toHaveBeenCalled();
  });

  it.each(['digest', 'empty', 'missing', 'duplicate', 'foreign'] as const)
  ('does not authorize a gate with %s action coverage or binding', async (mode) => {
    const f = fixture([action('one'), action('two')]);
    f.runtime.autonomy = 'autopilot';
    f.runtime.config.policy.autoApply = ['google_ads.ad.pause'];
    f.gateSteps.push((plan) => {
      const decision = gate(plan);
      if (mode === 'digest') decision.planDigest = digest('Another plan.');
      if (mode === 'empty') decision.actions = [];
      if (mode === 'missing') decision.actions = decision.actions.slice(0, 1);
      if (mode === 'duplicate') decision.actions = [decision.actions[0]!, decision.actions[0]!];
      if (mode === 'foreign') decision.actions[1]!.actionId = shortId('act', 'not-in-plan');
      return decision;
    });
    await expect(applyPlan(f.plan.id, f.runtime, LIVE)).rejects.toMatchObject({ code: 'approval_required' });
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.store.findReceipts(f.plan.id)).toEqual([]);
  });
});

describe('dry run', () => {
  it('changes no persisted state, writes no ledger, claims no receipt, and creates no cooldown', async () => {
    const f = fixture();
    const receipt = f.approve();
    const save = vi.spyOn(f.store, 'savePlan');
    const claim = vi.spyOn(f.approvals, 'claim');
    const issue = vi.spyOn(f.approvals, 'issue');
    const lock = vi.spyOn(f.store, 'acquireLock');
    const outcome = await applyPlan(f.plan.id, f.runtime, { ...DRY, elicitedBy: 'client', receiptId: receipt.id });
    expect(outcome).toMatchObject({
      plan: f.plan, dryRun: true, executionId: null, applied: 0, failed: 0, skipped: 0, unknown: 0,
      ledgerSeqs: [], results: [{ status: 'pending', result: { ok: true, dryRun: true } }],
    });
    expect(f.apply.mock.calls[0]?.[1]).toEqual({ validateOnly: true, idempotencyKey: `dryrun:${f.plan.actions[0]!.id}` });
    expect(f.states.get('ad:one')).toEqual({ status: 'ENABLED' });
    expect(save).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
    expect(lock).not.toHaveBeenCalled();
    expect(f.ledger.read()).toEqual([]);
    expect(f.store.receiptClaim(receipt.id)).toBeNull();
    expect(f.store.getPlan(f.plan.id)).toEqual(f.plan);
    expect((await applyPlan(f.plan.id, f.runtime, LIVE)).applied).toBe(1);
  });

  it('skips stale entities, records validation errors, and continues', async () => {
    const f = fixture([action('one'), action('two'), action('three')]);
    f.states.set('ad:one', { status: 'PAUSED' });
    f.applySteps.push(() => { throw new AutopilotError('platform_error', 'Validation failed.'); });
    const outcome = await applyPlan(f.plan.id, f.runtime, DRY);
    expect(outcome).toMatchObject({ skipped: 1, failed: 1, applied: 0, unknown: 0 });
    expect(outcome.results.map((result) => result.status)).toEqual(['skipped', 'failed', 'pending']);
    expect(outcome.results[0]?.note).toBe('stale: the entity changed since the plan was created');
    expect(outcome.results[1]?.result?.error).toMatchObject({ code: 'platform_error', message: 'Validation failed.' });
    expect(f.store.getPlan(f.plan.id)).toEqual(f.plan);
    expect(f.ledger.read()).toEqual([]);
  });

  it('allows validation without a precondition but reports that policy denies live execution', async () => {
    const f = fixture([action('one', { before: null, preconditionHash: null })]);
    const outcome = await applyPlan(f.plan.id, f.runtime, DRY);
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect(outcome.results[0]).toMatchObject({ status: 'pending', note: expect.stringContaining('policy would deny:') });
  });
});

describe('createRevertPlan', () => {
  it('creates inverse drafts in reverse order and links a fresh proposed plan', async () => {
    const f = fixture([action('one'), action('two'), action('three')]);
    f.approve();
    await applyPlan(f.plan.id, f.runtime, LIVE);
    const revert = await createRevertPlan(f.plan.id, f.runtime);
    expect(revert).toMatchObject({
      status: 'proposed', revertsPlanId: f.plan.id, snapshotId: null, createdBy: 'agent',
      title: `Revert: ${f.plan.title}`,
      rationale: `Compensating changes for plan ${f.plan.id}. Money already spent is not recovered.`,
    });
    expect(revert.actions.map((item) => item.target.id)).toEqual(['three', 'two', 'one']);
    expect(revert.actions.every((item) => item.kind === 'google_ads.ad.enable')).toBe(true);
    expect(revert.actions.every((item) => item.preconditionHash === digest({ status: 'PAUSED' }))).toBe(true);
    expect(revert.digest).toBe(planDigest(revert));
    expect(f.store.getPlan(revert.id)).toEqual(revert);
    expect(f.ledger.read().at(-1)).toMatchObject({
      event: 'plan.created', planId: revert.id, accountId: f.account.id,
      data: { revertsPlanId: f.plan.id, digest: revert.digest, actions: 3 },
    });
    expect(f.store.findReceipts(revert.id)).toEqual([]);
    await expect(applyPlan(revert.id, f.runtime, LIVE)).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('requires fresh approval for a revert that passes policy', async () => {
    const membership = buildAction({
      kind: 'mautic.segment.add_contact', target: { level: 'segment', id: 'segment-1' },
      params: { contactId: '123' }, rationale: 'Add the reviewed contact to the segment.',
    }, { member: false });
    const f = fixture([membership]);
    f.approve();
    await applyPlan(f.plan.id, f.runtime, LIVE);
    const revert = await createRevertPlan(f.plan.id, f.runtime);
    expect(revert.actions[0]?.kind).toBe('mautic.segment.remove_contact');
    await expect(applyPlan(revert.id, f.runtime, LIVE)).rejects.toMatchObject({ code: 'approval_required' });
    expect(f.apply).toHaveBeenCalledTimes(1);
  });

  it('skips entities changed after apply while reverting the remaining applied actions', async () => {
    const f = fixture([action('one'), action('two'), action('three')]);
    f.approve();
    f.states.set('ad:three', { status: 'REMOVED' });
    expect((await applyPlan(f.plan.id, f.runtime, LIVE)).plan.status).toBe('partial');
    f.states.set('ad:one', { status: 'ENABLED' });
    const revert = await createRevertPlan(f.plan.id, f.runtime);
    expect(revert.actions.map((item) => item.target.id)).toEqual(['two']);
    expect(f.apply).toHaveBeenCalledTimes(2);
  });

  it('compares only changed keys against the observed applied state', async () => {
    const f = fixture();
    f.approve();
    f.applySteps.push((item) => {
      f.states.set(stateKey(item), { status: 'PAUSED', metadata: 'first' });
      return { ok: true, dryRun: false, after: null };
    });
    await applyPlan(f.plan.id, f.runtime, LIVE);
    f.states.set('ad:one', { status: 'PAUSED', metadata: 'later' });
    expect((await createRevertPlan(f.plan.id, f.runtime)).actions).toHaveLength(1);
  });

  it('does not save a revert when the entity changes during the planner read', async () => {
    const f = fixture();
    f.approve();
    await applyPlan(f.plan.id, f.runtime, LIVE);
    f.readSteps.push(() => ({ status: 'PAUSED' }), () => ({ status: 'REMOVED' }));
    await expect(createRevertPlan(f.plan.id, f.runtime)).rejects.toMatchObject({ code: 'stale_state' });
    expect(f.store.listPlans()).toHaveLength(1);
    expect(f.ledger.read({ events: ['plan.created'] })).toEqual([]);
    expect(f.apply).toHaveBeenCalledTimes(1);
  });

  it('refuses when every applied entity has since changed and explains the skip count', async () => {
    const f = fixture();
    f.approve();
    await applyPlan(f.plan.id, f.runtime, LIVE);
    f.states.set('ad:one', { status: 'REMOVED' });
    await expect(createRevertPlan(f.plan.id, f.runtime)).rejects.toMatchObject({
      code: 'invalid_input', message: expect.stringMatching(/Nothing in this plan can be reverted[\s\S]*1[\s\S]*chang/i),
    });
    expect(f.ledger.read({ events: ['plan.created'] })).toEqual([]);
  });

  it('refuses actions without a compensating inverse and explains the skip', async () => {
    const irreversible = buildAction({
      kind: 'mautic.email.create_draft', target: { level: 'account', id: 'mautic-account' },
      params: { name: 'Draft', subject: 'A reviewed draft', html: '<p>Hello</p>' }, rationale: 'Create reviewed email copy.',
    }, { exists: false });
    irreversible.status = 'applied';
    const f = fixture([irreversible]);
    f.plan.status = 'applied';
    f.store.savePlan(f.plan);
    await expect(createRevertPlan(f.plan.id, f.runtime)).rejects.toMatchObject({
      code: 'invalid_input', message: expect.stringMatching(/Nothing in this plan can be reverted[\s\S]*1[\s\S]*(inverse|compensat|revert)/i),
    });
    expect(f.readState).not.toHaveBeenCalled();
  });

  it.each(['proposed', 'approved', 'applying', 'failed', 'rejected', 'reverted'] as const)
  ('refuses to revert a plan in status %s', async (status) => {
    const f = fixture();
    f.plan.status = status;
    f.store.savePlan(f.plan);
    await expect(createRevertPlan(f.plan.id, f.runtime)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(f.readState).not.toHaveBeenCalled();
  });
});
