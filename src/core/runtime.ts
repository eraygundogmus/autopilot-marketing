import { createHttpClient } from '../connectors/http';
import { createConnector } from '../connectors/registry';
import { createJudge } from '../judgment/judge';
import { createTypeSafeClient } from '../judgment/typesafe';
import { createApprovalService } from '../plan/approval';
import { createLedger } from '../plan/ledger';
import { effectiveAutonomy, findAccount, killSwitchOn, loadConfig } from './config';
import { openDatabase } from './db';
import type { Db } from './db';
import { loadEnv } from './env';
import { ensureHome, resolvePaths } from './paths';
import { createStore } from './store';
import type { AccountConfig, Answer, Connector, Env, Runtime } from './types';

export interface RuntimeOptions {
  env?: Env;
  fetch?: typeof fetch;
  now?: () => Date;
}

/** Jev answers keyed by request hash, so a repeated question costs nothing. */
function judgmentCache(db: Db, now: () => Date) {
  const select = db.prepare('SELECT json FROM judgment_cache WHERE key = ?');
  const upsert = db.prepare('INSERT OR REPLACE INTO judgment_cache (key, json, created_at) VALUES (?, ?, ?)');
  return {
    get(key: string): Record<string, Answer> | undefined {
      const row = select.get(key) as { json: string } | undefined;
      if (!row) return undefined;
      try {
        return JSON.parse(row.json) as Record<string, Answer>;
      } catch {
        return undefined;
      }
    },
    set(key: string, answers: Record<string, Answer>): void {
      upsert.run(key, JSON.stringify(answers), now().toISOString());
    },
  };
}

/** Composition root: loads env and config, then wires store, ledger, approvals, judge and connectors. */
export function createRuntime(options: RuntimeOptions = {}): Runtime {
  const base = options.env ?? process.env;
  const paths = resolvePaths(base);
  ensureHome(paths);
  const env = loadEnv(paths, base);
  const config = loadConfig(paths);
  const now = options.now ?? (() => new Date());

  const db = openDatabase(paths);
  const store = createStore(db);
  const ledger = createLedger(db, now);
  const approvals = createApprovalService({ store, paths, ttlMinutes: config.policy.approvalTtlMinutes });

  const fetchOption = options.fetch ? { fetch: options.fetch } : {};
  const client = createTypeSafeClient({ env, config: config.judgment, cache: judgmentCache(db, now), ...fetchOption });
  const judge = createJudge({ client, config: config.judgment, now });
  const http = createHttpClient({ env, ...fetchOption });

  const connectors = new Map<string, Connector>();

  return {
    config,
    env,
    paths,
    store,
    ledger,
    approvals,
    judge,
    autonomy: effectiveAutonomy(config, judge.mode),
    now,
    account: (accountId: string) => findAccount(config, accountId),
    connector(account: AccountConfig): Connector {
      let connector = connectors.get(account.id);
      if (!connector) {
        connector = createConnector(account, { env, http, now });
        connectors.set(account.id, connector);
      }
      return connector;
    },
    // Evaluated on every call: a KILL file created while the process runs must take effect.
    killSwitch: () => killSwitchOn(config, paths, env),
  };
}
