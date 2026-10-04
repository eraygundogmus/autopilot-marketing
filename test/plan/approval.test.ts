import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/core/db';
import { AutopilotError } from '../../src/core/errors';
import { createStore } from '../../src/core/store';
import type { ApprovalReceipt, ApprovalService, Paths, Plan, Store } from '../../src/core/types';
import { createApprovalService, isInteractive } from '../../src/plan/approval';

const T0 = new Date('2026-01-01T00:00:00.000Z');
const POLICY = 'policy-digest-1';
const REVIEW = 'review-digest-1';

const plan: Plan = {
  id: 'plan_0123456789abcdef',
  schemaVersion: 1,
  createdAt: T0.toISOString(),
  createdBy: 'agent',
  accountId: 'acc_1',
  platform: 'google_ads',
  snapshotId: null,
  title: 'Pause wasteful keywords',
  rationale: 'test',
  actions: [],
  digest: 'digest-a',
  status: 'proposed',
};

function setup(ttlMinutes = 30): { store: Store; service: ApprovalService; paths: Paths; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-'));
  const paths: Paths = {
    home: dir,
    config: path.join(dir, 'config.json'),
    envFile: path.join(dir, '.env'),
    db: ':memory:',
    brief: path.join(dir, 'brief.md'),
    approvalKey: path.join(dir, 'keys', 'approval.key'),
    killFile: path.join(dir, 'KILL'),
  };
  const store = createStore(openDatabase(paths));
  return { store, service: createApprovalService({ store, paths, ttlMinutes }), paths, dir };
}

function issue(service: ApprovalService, now: Date = T0): ApprovalReceipt {
  return service.issue({ plan, policyDigest: POLICY, reviewDigest: REVIEW, method: 'tty', approver: 'tester', now });
}

function caught(fn: () => unknown): AutopilotError {
  try {
    fn();
  } catch (error) {
    if (error instanceof AutopilotError) return error;
    throw error;
  }
  throw new Error('expected an AutopilotError');
}

function minutesAfter(minutes: number, extraMs = 0): Date {
  return new Date(T0.getTime() + minutes * 60_000 + extraMs);
}

describe('createApprovalService', () => {
  it('issues a receipt that verifies', () => {
    const { service } = setup();
    const receipt = issue(service);
    expect(receipt.id).toMatch(/^apr_[0-9a-f]{16}$/);
    expect(receipt).toMatchObject({
      planId: plan.id,
      planDigest: plan.digest,
      policyDigest: POLICY,
      reviewDigest: REVIEW,
      method: 'tty',
      approver: 'tester',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T00:30:00.000Z',
    });
    expect(receipt.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(service.verify({ plan, policyDigest: POLICY, now: minutesAfter(1) })).toEqual(receipt);
    expect(service.verify({ plan, policyDigest: POLICY, receiptId: receipt.id, now: minutesAfter(1) })).toEqual(receipt);
  });

  it('creates the key file once with mode 0600 and reuses it', () => {
    const { store, service, paths } = setup();
    expect(fs.existsSync(paths.approvalKey)).toBe(false);
    const receipt = issue(service);
    const key = fs.readFileSync(paths.approvalKey, 'utf8');
    expect(key.trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.statSync(paths.approvalKey).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(paths.approvalKey)).mode & 0o777).toBe(0o700);

    issue(service, minutesAfter(1));
    expect(fs.readFileSync(paths.approvalKey, 'utf8')).toBe(key);

    const second = createApprovalService({ store, paths, ttlMinutes: 30 });
    expect(second.verify({ plan, policyDigest: POLICY, receiptId: receipt.id, now: minutesAfter(2) })).toEqual(receipt);
    expect(fs.readFileSync(paths.approvalKey, 'utf8')).toBe(key);
  });

  it('rejects a receipt whose fields were changed under a copied signature', () => {
    const tampered: Array<Partial<ApprovalReceipt>> = [
      {},
      { reviewDigest: 'other-review' },
      { approver: 'someone-else' },
      { createdAt: '2025-12-31T00:00:00.000Z' },
      { expiresAt: '2030-01-01T00:00:00.000Z' },
      { policyDigest: 'other-policy' },
      { planDigest: 'other-digest' },
    ];
    tampered.forEach((change, index) => {
      const { store, service } = setup();
      const original = issue(service);
      const forged: ApprovalReceipt = { ...original, ...change, id: `apr_${String(index).padStart(16, '0')}` };
      store.saveReceipt(forged);
      const error = caught(() => service.verify({ plan, policyDigest: POLICY, receiptId: forged.id, now: minutesAfter(1) }));
      expect(error.code).toBe('approval_invalid');
      expect(error.message).toContain('the receipt signature does not match');
    });
  });

  it('rejects a plan whose digest changed after approval', () => {
    const { service } = setup();
    issue(service);
    const error = caught(() => service.verify({ plan: { ...plan, digest: 'digest-b' }, policyDigest: POLICY, now: minutesAfter(1) }));
    expect(error.code).toBe('approval_invalid');
    expect(error.message).toContain('the plan changed after it was approved');
  });

  it('rejects a changed policy digest', () => {
    const { service } = setup();
    issue(service);
    const error = caught(() => service.verify({ plan, policyDigest: 'policy-digest-2', now: minutesAfter(1) }));
    expect(error.code).toBe('approval_invalid');
    expect(error.message).toContain('the policy changed after approval');
  });

  it('accepts a receipt exactly at expiry and rejects it one millisecond later', () => {
    const { service } = setup(30);
    const receipt = issue(service);
    expect(service.verify({ plan, policyDigest: POLICY, now: minutesAfter(30) })).toEqual(receipt);
    const error = caught(() => service.verify({ plan, policyDigest: POLICY, now: minutesAfter(30, 1) }));
    expect(error.code).toBe('approval_invalid');
    expect(error.message).toContain('the approval expired at 2026-01-01T00:30:00.000Z');
  });

  it('skips a claimed receipt and uses an older unclaimed valid one', () => {
    const { service } = setup();
    const older = issue(service, T0);
    const newer = issue(service, minutesAfter(1));
    expect(service.verify({ plan, policyDigest: POLICY, now: minutesAfter(2) })).toEqual(newer);
    service.claim(newer, 'exec_0000000000000001', minutesAfter(2));
    expect(service.verify({ plan, policyDigest: POLICY, now: minutesAfter(3) })).toEqual(older);

    service.claim(older, 'exec_0000000000000002', minutesAfter(3));
    const error = caught(() => service.verify({ plan, policyDigest: POLICY, now: minutesAfter(4) }));
    expect(error.code).toBe('approval_invalid');
    expect(error.message).toContain('the approval was already used by exec_0000000000000001');
  });

  it('never lets a policy receipt satisfy a request for approval', () => {
    const { store, service } = setup();
    const policy = service.issue({ plan, policyDigest: POLICY, reviewDigest: REVIEW, method: 'policy', approver: 'policy', now: T0 });
    expect(store.receiptClaim(policy.id)).toBeNull();

    const byPlan = caught(() => service.verify({ plan, policyDigest: POLICY, now: minutesAfter(1) }));
    expect(byPlan.code).toBe('approval_required');
    const byId = caught(() => service.verify({ plan, policyDigest: POLICY, receiptId: policy.id, now: minutesAfter(1) }));
    expect(byId.code).toBe('approval_required');

    // A receipt relabelled as 'policy' under a copied signature is not a candidate either.
    const relabelled: ApprovalReceipt = { ...issue(service, minutesAfter(1)), method: 'policy', id: 'apr_0000000000000001' };
    store.saveReceipt(relabelled);
    const forged = caught(() => service.verify({ plan, policyDigest: POLICY, receiptId: relabelled.id, now: minutesAfter(2) }));
    expect(forged.code).toBe('approval_required');
  });

  it('returns the tty receipt when a newer policy receipt also exists', () => {
    const { service } = setup();
    const tty = issue(service, T0);
    service.issue({ plan, policyDigest: POLICY, reviewDigest: REVIEW, method: 'policy', approver: 'policy', now: minutesAfter(1) });
    expect(service.verify({ plan, policyDigest: POLICY, now: minutesAfter(2) })).toEqual(tty);
  });

  it('throws when a receipt is claimed twice', () => {
    const { store, service } = setup();
    const receipt = issue(service);
    service.claim(receipt, 'exec_0000000000000001', minutesAfter(1));
    const error = caught(() => service.claim(receipt, 'exec_0000000000000002', minutesAfter(2)));
    expect(error.code).toBe('approval_invalid');
    expect(error.message).toBe('This approval was already used: a receipt authorises one execution.');
    expect(store.receiptClaim(receipt.id)?.executionId).toBe('exec_0000000000000001');
  });

  it('requires approval when there are no receipts, naming the plan in the hint', () => {
    const { service } = setup();
    const none = caught(() => service.verify({ plan, policyDigest: POLICY, now: T0 }));
    expect(none.code).toBe('approval_required');
    expect(none.hint).toBe(
      'Ask the person responsible to run `autopilot-marketing approve plan_0123456789abcdef` (or `autopilot-marketing review plan_0123456789abcdef`) in their own terminal, then call plan_apply again.',
    );

    issue(service);
    const unknownId = caught(() => service.verify({ plan, policyDigest: POLICY, receiptId: 'apr_ffffffffffffffff', now: T0 }));
    expect(unknownId.code).toBe('approval_required');
  });
});

describe('isInteractive', () => {
  it('is true only when both streams are terminals', () => {
    expect(isInteractive({ isTTY: true }, { isTTY: true })).toBe(true);
    expect(isInteractive({ isTTY: true }, { isTTY: false })).toBe(false);
    expect(isInteractive({ isTTY: false }, { isTTY: true })).toBe(false);
    expect(isInteractive({ isTTY: false }, { isTTY: false })).toBe(false);
    expect(isInteractive({}, { isTTY: true })).toBe(false);
    expect(isInteractive({ isTTY: true }, {})).toBe(false);
  });
});
