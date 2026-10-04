import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../../src/core/config';
import { createRuntime } from '../../src/core/runtime';
import type { AutopilotConfig, Env, Runtime } from '../../src/core/types';

export interface TempRuntimeOptions {
  /** Merged over `defaultConfig()` (demo accounts, autonomy 'propose') and written to the temp home. */
  config?: Partial<AutopilotConfig>;
  env?: Env;
  fetch?: typeof fetch;
  now?: () => Date;
}

/** A real runtime in a throwaway home directory. Never touches the user's own state. */
export function tempRuntime(options: TempRuntimeOptions = {}): { runtime: Runtime; home: string } {
  const home = mkdtempSync(join(tmpdir(), 'apm-'));
  if (options.config) {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ ...defaultConfig(), ...options.config }));
  }
  const runtime = createRuntime({
    env: { AUTOPILOT_HOME: home, ...options.env },
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  return { runtime, home };
}
