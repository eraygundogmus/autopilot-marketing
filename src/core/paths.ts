import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutopilotError } from './errors';
import type { Env, Paths } from './types';

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith(`~${path.sep}`)) return path.join(os.homedir(), value.slice(2));
  return value;
}

/** Resolves every state path under AUTOPILOT_HOME (default `~/.autopilot-marketing`). */
export function resolvePaths(env: Env = process.env): Paths {
  const override = env.AUTOPILOT_HOME;
  const home =
    override !== undefined && override !== ''
      ? path.resolve(expandHome(override))
      : path.join(os.homedir(), '.autopilot-marketing');
  return {
    home,
    config: path.join(home, 'config.json'),
    envFile: path.join(home, '.env'),
    db: path.join(home, 'state.db'),
    brief: path.join(home, 'brief.md'),
    approvalKey: path.join(home, 'approval.key'),
    killFile: path.join(home, 'KILL'),
    credentials: path.join(home, 'credentials.json'),
  };
}

/** Creates the home dir with mode 0700. */
export function ensureHome(paths: Paths): void {
  try {
    fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new AutopilotError('config_invalid', `Cannot create home directory ${paths.home}`, {
      hint: 'Set AUTOPILOT_HOME to a writable directory.',
      cause: error,
    });
  }
}
