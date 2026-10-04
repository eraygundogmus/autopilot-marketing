import fs from 'node:fs';
import { AutopilotError } from './errors';
import type { AccountConfig, Env, Paths } from './types';

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

function parseEnvFile(text: string): Env {
  const parsed: Env = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const match = LINE.exec(line);
    const name = match?.[1];
    if (name === undefined) continue;
    let value = (match?.[2] ?? '').trim();
    const quote = value[0];
    if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    parsed[name] = value;
  }
  return parsed;
}

/**
 * Process environment overlaid on `<home>/.env` (the process wins). Accepts `NAME=value`,
 * `export NAME=value`, quotes and `#` comments.
 */
export function loadEnv(paths: Paths, base: Env = process.env): Env {
  let fromFile: Env = {};
  let text: string | undefined;
  try {
    text = fs.readFileSync(paths.envFile, 'utf8');
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw new AutopilotError('config_invalid', `Cannot read ${paths.envFile}`, {
        hint: 'Check that the file is readable by the current user.',
        cause: error,
      });
    }
  }
  if (text !== undefined) fromFile = parseEnvFile(text);
  const merged: Env = { ...fromFile };
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined) merged[name] = value;
  }
  return merged;
}

/** `${account.envPrefix}${name}` when set and non-empty, else `name`. */
export function envFor(env: Env, account: AccountConfig, name: string): string | undefined {
  if (account.envPrefix !== undefined && account.envPrefix !== '') {
    const prefixed = env[account.envPrefix + name];
    if (typeof prefixed === 'string' && prefixed !== '') return prefixed;
  }
  const plain = env[name];
  return typeof plain === 'string' && plain !== '' ? plain : undefined;
}

/** The names (never the values) from `names` that `envFor` cannot resolve. */
export function missingEnv(env: Env, account: AccountConfig, names: string[]): string[] {
  return names.filter((name) => envFor(env, account, name) === undefined);
}
