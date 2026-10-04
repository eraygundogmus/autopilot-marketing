import type { Runtime } from '../core/types';
import { reconcileAccount } from '../plan/executor';
import type { ReconcileSummary } from '../plan/executor';

/** What a reconciliation found, as sentences for the person. Empty when there was nothing to settle. */
export function reconcileSentences(summary: ReconcileSummary): string[] {
  const sentences: string[] = [];
  if (summary.reconciled > 0) {
    sentences.push(
      `Settled ${summary.reconciled} change(s) an interrupted run left open: ${summary.applied} applied, ${summary.notApplied} not applied.`,
    );
  }
  if (summary.conflicts.length > 0) {
    sentences.push(
      `A person must check ${summary.conflicts.join(', ')}: the current state matches neither what was there before nor what was intended.`,
    );
  }
  if (summary.repairedPlans.length > 0) {
    sentences.push(`Repaired the stored state of plan(s) ${summary.repairedPlans.join(', ')} from the ledger.`);
  }
  return sentences;
}

/** The reconciliation a scheduled cycle runs before it starts, and after an interrupted one. */
export function reconcileForJobs(runtime: Runtime): (accountId: string) => Promise<string[]> {
  return async (accountId) =>
    reconcileSentences(await reconcileAccount(runtime, accountId, { kind: 'system', id: 'autopilot' }));
}
