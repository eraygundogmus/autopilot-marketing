import { AsyncLocalStorage } from 'node:async_hooks';
import type { JudgmentUsage, Runtime } from '../core/types';

/** What the requests made inside one `meterJudgment` call used. */
interface Meter {
  /** Answers handed back, from the cache or from a request. */
  answered: number;
  model: string | null;
  requests: number;
  failed: number;
  skipped: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export type MeterCharge = Partial<Omit<Meter, 'model'>> & { model?: string | null };

const meters = new AsyncLocalStorage<Meter>();

function emptyMeter(): Meter {
  return { answered: 0, model: null, requests: 0, failed: 0, skipped: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

function add(meter: Meter, charge: MeterCharge): void {
  meter.answered += charge.answered ?? 0;
  meter.requests += charge.requests ?? 0;
  meter.failed += charge.failed ?? 0;
  meter.skipped += charge.skipped ?? 0;
  meter.inputTokens += charge.inputTokens ?? 0;
  meter.outputTokens += charge.outputTokens ?? 0;
  meter.costUsd += charge.costUsd ?? 0;
  if (typeof charge.model === 'string' && charge.model !== '') meter.model = charge.model;
}

/** Called by the TypeSafe client for every answer, request and skip. Does nothing outside `meterJudgment`. */
export function chargeMeter(charge: MeterCharge): void {
  const meter = meters.getStore();
  if (meter !== undefined) add(meter, charge);
}

function usageOf(meter: Meter): JudgmentUsage {
  const { answered, ...totals } = meter;
  return { ...totals, mode: answered > 0 ? 'jev' : 'fallback' };
}

/**
 * Runs `run` and returns what the Jev requests made inside it used. The client's own totals count
 * the whole process; this counts one operation, also when other operations run at the same time.
 */
export async function meterJudgment<T>(run: () => Promise<T>): Promise<{ value: T; usage: JudgmentUsage }> {
  const parent = meters.getStore();
  const meter = emptyMeter();
  try {
    const value = await meters.run(meter, run);
    return { value, usage: usageOf(meter) };
  } finally {
    if (parent !== undefined) add(parent, meter);
  }
}

export interface JudgmentUse {
  /** What asked: `audit`, `judge_terms`, `judge_copy`, `judge_claims` or `gate`. */
  operation: string;
  accountId?: string;
  planId?: string;
}

/**
 * `meterJudgment`, plus one `judgment.usage` ledger entry when the operation sent a request, also
 * when it throws. An operation answered from the cache or by the rules costs nothing and logs nothing.
 */
export async function withJudgmentUsage<T>(
  runtime: Runtime,
  use: JudgmentUse,
  run: () => Promise<T>,
): Promise<{ value: T; usage: JudgmentUsage }> {
  const parent = meters.getStore();
  const meter = emptyMeter();
  try {
    const value = await meters.run(meter, run);
    return { value, usage: usageOf(meter) };
  } finally {
    if (parent !== undefined) add(parent, meter);
    if (meter.requests > 0 || meter.failed > 0 || meter.inputTokens > 0) {
      runtime.ledger.append({
        event: 'judgment.usage',
        actor: { kind: 'system', id: 'autopilot' },
        ...(use.accountId === undefined ? {} : { accountId: use.accountId }),
        ...(use.planId === undefined ? {} : { planId: use.planId }),
        data: {
          operation: use.operation,
          model: meter.model,
          requests: meter.requests,
          failed: meter.failed,
          inputTokens: meter.inputTokens,
          costUsd: meter.costUsd,
        },
      });
    }
  }
}
