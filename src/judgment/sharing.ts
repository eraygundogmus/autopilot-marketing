import type { AccountConfig, Judge, Runtime } from '../core/types';
import { createJudge } from './judge';
import { createTypeSafeClient } from './typesafe';

const local = new WeakMap<Runtime, Judge>();

/** A judge that never calls Jev: every answer comes from the labelled rule-based fallback. */
export function localJudge(runtime: Runtime): Judge {
  let judge = local.get(runtime);
  if (judge === undefined) {
    // Without a key the client is unavailable, so the judge can only use its fallback.
    const client = createTypeSafeClient({ env: {}, config: runtime.config.judgment });
    judge = createJudge({ client, config: runtime.config.judgment, now: runtime.now });
    local.set(runtime, judge);
  }
  return judge;
}

/** The judge to use for `account`: the local one when its owner turned judgments off for it. */
export function judgeFor(runtime: Runtime, account: AccountConfig): Judge {
  return account.sharing?.judgments === false ? localJudge(runtime) : runtime.judge;
}
