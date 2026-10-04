import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AutopilotError } from '../core/errors';
import { canonicalJson } from '../core/ids';
import type { ApprovalReceipt, ApprovalService, Paths, Plan, Store } from '../core/types';

const SIGNATURE_PREFIX = 'autopilot-receipt:v1\n';
const KEY_PATTERN = /^[0-9a-f]{64}$/;

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function readKey(file: string): string | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8').trim();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw new AutopilotError('internal', 'The approval key file could not be read.', {
      cause: error,
      hint: `Check the permissions of ${file}.`,
    });
  }
  if (!KEY_PATTERN.test(text)) {
    throw new AutopilotError('internal', 'The approval key file is malformed.', {
      hint: `Delete ${file} to generate a new key; receipts issued with the old key stop verifying.`,
    });
  }
  return text;
}

function loadOrCreateKey(file: string): string {
  const existing = readKey(file);
  if (existing !== null) return existing;
  const key = randomBytes(32).toString('hex');
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    // Exclusive create: a concurrent process that wins the race keeps its key.
    writeFileSync(file, `${key}\n`, { mode: 0o600, flag: 'wx' });
    return key;
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      const raced = readKey(file);
      if (raced !== null) return raced;
    }
    throw new AutopilotError('internal', 'The approval key file could not be created.', {
      cause: error,
      hint: `Check that ${dirname(file)} is writable.`,
    });
  }
}

function sign(key: string, receipt: Omit<ApprovalReceipt, 'signature'>): string {
  const unsigned: Omit<ApprovalReceipt, 'signature'> = {
    id: receipt.id,
    planId: receipt.planId,
    planDigest: receipt.planDigest,
    policyDigest: receipt.policyDigest,
    method: receipt.method,
    reviewDigest: receipt.reviewDigest,
    approver: receipt.approver,
    createdAt: receipt.createdAt,
    expiresAt: receipt.expiresAt,
  };
  return createHmac('sha256', key).update(SIGNATURE_PREFIX + canonicalJson(unsigned)).digest('hex');
}

function signatureMatches(key: string, receipt: ApprovalReceipt): boolean {
  if (typeof receipt.signature !== 'string') return false;
  const expected = Buffer.from(sign(key, receipt), 'utf8');
  const actual = Buffer.from(receipt.signature, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Approval receipts: a record that a specific plan, under a specific policy, was approved through
 * a specific channel after a specific review text was shown. The signature detects edits made
 * without the key; it does not distinguish a person from an agent running as the same OS user.
 */
export function createApprovalService(options: { store: Store; paths: Paths; ttlMinutes: number }): ApprovalService {
  const { store, paths, ttlMinutes } = options;
  let cachedKey: string | null = null;
  const key = (): string => {
    cachedKey ??= loadOrCreateKey(paths.approvalKey);
    return cachedKey;
  };

  /** Null when the receipt passes every check, otherwise the reason it does not. */
  const failure = (receipt: ApprovalReceipt, plan: Plan, policyDigest: string, now: Date): string | null => {
    if (!signatureMatches(key(), receipt)) return 'the receipt signature does not match';
    if (receipt.planId !== plan.id || receipt.planDigest !== plan.digest) return 'the plan changed after it was approved';
    if (receipt.policyDigest !== policyDigest) return 'the policy changed after approval';
    const expiresMs = Date.parse(receipt.expiresAt);
    if (!(now.getTime() <= expiresMs)) return `the approval expired at ${receipt.expiresAt}`;
    const claimed = store.receiptClaim(receipt.id);
    if (claimed !== null) return `the approval was already used by ${claimed.executionId}`;
    return null;
  };

  return {
    issue({ plan, policyDigest, reviewDigest, method, approver, now }) {
      const unsigned: Omit<ApprovalReceipt, 'signature'> = {
        id: `apr_${randomBytes(8).toString('hex')}`,
        planId: plan.id,
        planDigest: plan.digest,
        policyDigest,
        method,
        reviewDigest,
        approver,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMinutes * 60_000).toISOString(),
      };
      const receipt: ApprovalReceipt = { ...unsigned, signature: sign(key(), unsigned) };
      store.saveReceipt(receipt);
      return receipt;
    },

    verify({ plan, policyDigest, receiptId, now }) {
      // A 'policy' receipt records an automatic application decided for one execution; it is
      // never a candidate for a later request, whether looked up by plan or by id.
      const all = store.findReceipts(plan.id).filter((receipt) => receipt.method !== 'policy');
      const newestFirst = (receiptId === undefined ? all : all.filter((receipt) => receipt.id === receiptId)).reverse();
      const newest = newestFirst[0];
      if (newest === undefined) {
        throw new AutopilotError('approval_required', `Plan ${plan.id} has no approval.`, {
          hint: `Ask the person responsible to run \`autopilot-marketing approve ${plan.id}\` (or \`autopilot-marketing review ${plan.id}\`) in their own terminal, then call plan_apply again.`,
        });
      }
      let newestReason: string | null = null;
      for (const receipt of newestFirst) {
        const reason = failure(receipt, plan, policyDigest, now);
        if (reason === null) return receipt;
        newestReason ??= reason;
      }
      throw new AutopilotError('approval_invalid', `The approval for plan ${plan.id} cannot be used: ${newestReason ?? 'unknown reason'}.`, {
        hint: `Review the plan again and approve it with \`autopilot-marketing approve ${plan.id}\`.`,
      });
    },

    claim(receipt, executionId, now) {
      if (!store.claimReceipt(receipt.id, executionId, now.toISOString())) {
        throw new AutopilotError('approval_invalid', 'This approval was already used: a receipt authorises one execution.');
      }
    },
  };
}

/** True only when both streams are terminals: an agent's shell is not. */
export function isInteractive(stdin: { isTTY?: boolean } = process.stdin, stdout: { isTTY?: boolean } = process.stdout): boolean {
  return stdin.isTTY === true && stdout.isTTY === true;
}
