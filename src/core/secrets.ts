import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AutopilotError } from './errors';
import { redact } from './redact';
import type { CredentialSources, Env, Paths, SecretStore, SecretStoreKind } from './types';

export const SECRET_SERVICE = 'autopilot-marketing';

export interface ExecResult {
  /** Null when the program was killed (timeout) or could not be started. */
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set when the program could not be started (`ENOENT`) or timed out (`ETIMEDOUT`). */
  errorCode?: string;
}

/** Runs a program synchronously without a shell. `input` is written to its stdin. */
export type ExecFile = (file: string, args: string[], options: { input?: string; timeoutMs: number }) => ExecResult;

const TIMEOUT_MS = 10000;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const PROFILE_PATTERN = /^[a-z0-9]{8}$/;
const STORED_PREFIX = 'b64:';
const SECURITY = '/usr/bin/security';
const SECRET_TOOL = 'secret-tool';
const MAX_SECURITY_LINE = 4000;
const SECURITY_NOT_FOUND_STATUS = 44;

const KEYCHAIN_HINT = 'Unlock the login keychain, or keep the credential in the .env file.';
const SECRET_SERVICE_HINT =
  'Install libsecret-tools (Debian, Ubuntu) or libsecret (Fedora) and run inside a desktop session, or keep the credential in the .env file.';
const NONE_MESSAGE = 'No supported credential store on this system';
const NONE_HINT = 'Keep credentials in the .env file of the home directory (mode 0600).';

function defaultExec(file: string, args: string[], options: { input?: string; timeoutMs: number }): ExecResult {
  const result = spawnSync(file, args, {
    ...(options.input === undefined ? {} : { input: options.input }),
    timeout: options.timeoutMs,
    encoding: 'utf8',
    shell: false,
  });
  const out: ExecResult = {
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string') out.errorCode = code;
  return out;
}

function assertName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new AutopilotError('invalid_input', 'Credential name must match /^[A-Za-z_][A-Za-z0-9_]{0,127}$/', {
      hint: 'Use a name such as GOOGLE_ADS_DEVELOPER_TOKEN.',
    });
  }
}

function assertValue(value: string): void {
  if (value.length === 0) throw new AutopilotError('invalid_input', 'Credential value must not be empty');
}

function encode(value: string): string {
  return STORED_PREFIX + Buffer.from(value, 'utf8').toString('base64');
}

function decode(stored: string): string {
  if (!stored.startsWith(STORED_PREFIX)) return stored;
  return Buffer.from(stored.slice(STORED_PREFIX.length), 'base64').toString('utf8');
}

function stripNewline(text: string): string {
  if (text.endsWith('\r\n')) return text.slice(0, -2);
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

function describeFailure(result: ExecResult): string {
  if (result.errorCode === 'ENOENT') return 'the program was not found';
  if (result.errorCode === 'ETIMEDOUT') return 'the program timed out';
  const line = redact(result.stderr).split('\n').map((part) => part.trim()).find((part) => part.length > 0);
  if (line !== undefined) return line;
  if (result.errorCode !== undefined) return result.errorCode;
  return result.status === null ? 'the program was killed' : `exit status ${result.status}`;
}

function storeError(action: string, name: string, result: ExecResult, hint: string): AutopilotError {
  return new AutopilotError('not_configured', `Credential store ${action} of ${name} failed: ${describeFailure(result)}`, {
    hint,
  });
}

function mismatchError(name: string, hint: string): AutopilotError {
  return new AutopilotError('not_configured', `Credential store did not keep ${name}`, { hint });
}

function createKeychainStore(exec: ExecFile, profile: string): SecretStore {
  const account = (name: string): string => `${profile}.${name}`;
  const notFound = (result: ExecResult): boolean =>
    result.errorCode === undefined &&
    (result.status === SECURITY_NOT_FOUND_STATUS || result.stderr.includes('could not be found'));

  const getStored = (name: string): string | undefined => {
    const result = exec(SECURITY, ['find-generic-password', '-s', SECRET_SERVICE, '-a', account(name), '-w'], {
      timeoutMs: TIMEOUT_MS,
    });
    if (result.errorCode === undefined && result.status === 0) return stripNewline(result.stdout);
    if (notFound(result)) return undefined;
    throw storeError('read', name, result, KEYCHAIN_HINT);
  };

  return {
    kind: 'keychain',
    profile,
    get(name) {
      assertName(name);
      const stored = getStored(name);
      return stored === undefined ? undefined : decode(stored);
    },
    set(name, value) {
      assertName(name);
      assertValue(value);
      const stored = encode(value);
      // Profile, name and stored form hold no quote, backslash or whitespace, so double quotes are enough for `security -i`.
      const line = `add-generic-password -U -s "${SECRET_SERVICE}" -a "${account(name)}" -l "${SECRET_SERVICE} ${name} (${profile})" -w "${stored}"\n`;
      if (line.length > MAX_SECURITY_LINE) {
        throw new AutopilotError('invalid_input', `Credential value of ${name} is too long for the keychain`, {
          hint: 'Keep this credential in the .env file.',
        });
      }
      const result = exec(SECURITY, ['-i'], { input: line, timeoutMs: TIMEOUT_MS });
      if (result.errorCode !== undefined || result.status !== 0) throw storeError('write', name, result, KEYCHAIN_HINT);
      // `security -i` does not document its exit status for a failed command: read the entry back.
      if (getStored(name) !== stored) throw mismatchError(name, KEYCHAIN_HINT);
    },
    delete(name) {
      assertName(name);
      const result = exec(SECURITY, ['delete-generic-password', '-s', SECRET_SERVICE, '-a', account(name)], {
        timeoutMs: TIMEOUT_MS,
      });
      if (result.errorCode === undefined && result.status === 0) return true;
      if (notFound(result)) return false;
      throw storeError('delete', name, result, KEYCHAIN_HINT);
    },
  };
}

function createSecretServiceStore(exec: ExecFile, profile: string): SecretStore {
  const account = (name: string): string => `${profile}.${name}`;
  const failed = (result: ExecResult): boolean =>
    result.errorCode !== undefined || result.status === null || (result.status !== 0 && result.stderr.trim() !== '');

  const getStored = (name: string): string | undefined => {
    const result = exec(SECRET_TOOL, ['lookup', 'service', SECRET_SERVICE, 'account', account(name)], { timeoutMs: TIMEOUT_MS });
    if (failed(result)) throw storeError('read', name, result, SECRET_SERVICE_HINT);
    if (result.status !== 0) return undefined;
    const stored = stripNewline(result.stdout);
    return stored === '' ? undefined : stored;
  };

  return {
    kind: 'secret-service',
    profile,
    get(name) {
      assertName(name);
      const stored = getStored(name);
      return stored === undefined ? undefined : decode(stored);
    },
    set(name, value) {
      assertName(name);
      assertValue(value);
      const stored = encode(value);
      const result = exec(
        SECRET_TOOL,
        ['store', '--label', `${SECRET_SERVICE} ${name} (${profile})`, 'service', SECRET_SERVICE, 'account', account(name)],
        { input: stored, timeoutMs: TIMEOUT_MS },
      );
      if (result.errorCode !== undefined || result.status !== 0) {
        throw storeError('write', name, result, SECRET_SERVICE_HINT);
      }
      if (getStored(name) !== stored) throw mismatchError(name, SECRET_SERVICE_HINT);
    },
    delete(name) {
      assertName(name);
      const found = getStored(name) !== undefined;
      const result = exec(SECRET_TOOL, ['clear', 'service', SECRET_SERVICE, 'account', account(name)], { timeoutMs: TIMEOUT_MS });
      if (failed(result)) throw storeError('delete', name, result, SECRET_SERVICE_HINT);
      return found && result.status === 0;
    },
  };
}

function createNoStore(profile: string): SecretStore {
  const refuse = (): never => {
    throw new AutopilotError('not_configured', NONE_MESSAGE, { hint: NONE_HINT });
  };
  return {
    kind: 'none',
    profile,
    get: () => refuse(),
    set: () => refuse(),
    delete: () => refuse(),
  };
}

function assertProfile(profile: string): void {
  if (!PROFILE_PATTERN.test(profile)) {
    throw new AutopilotError('invalid_input', 'Credential profile must match /^[a-z0-9]{8}$/', {
      hint: 'Use the profile of the credential index of the home directory.',
    });
  }
}

function kindOf(platform: NodeJS.Platform): SecretStoreKind {
  if (platform === 'darwin') return 'keychain';
  return platform === 'linux' ? 'secret-service' : 'none';
}

/**
 * The store of this operating system, reached through its own command line tool.
 * Every entry is named `<profile>.<NAME>`, so two home directories never share an entry.
 */
export function createSecretStore(options: { profile: string; platform?: NodeJS.Platform; exec?: ExecFile }): SecretStore {
  assertProfile(options.profile);
  const kind = kindOf(options.platform ?? process.platform);
  const exec = options.exec ?? defaultExec;
  if (kind === 'keychain') return createKeychainStore(exec, options.profile);
  if (kind === 'secret-service') return createSecretServiceStore(exec, options.profile);
  return createNoStore(options.profile);
}

export interface CredentialIndex {
  profile: string;
  names: string[];
}

/** Null when the file does not exist. Throws `config_invalid` when it is malformed. */
export function readCredentialIndex(paths: Paths): CredentialIndex | null {
  let text: string;
  try {
    text = fs.readFileSync(paths.credentials, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new AutopilotError('config_invalid', 'The credential index could not be read', {
      hint: `Check the permissions of ${paths.credentials}.`,
      cause: error,
    });
  }
  const malformed = (): AutopilotError =>
    new AutopilotError('config_invalid', 'The credential index is malformed', {
      hint: `Fix ${paths.credentials}; expected { "version": 1, "profile": "<8 characters>", "names": [...] }.`,
    });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw malformed();
  }
  if (typeof parsed !== 'object' || parsed === null) throw malformed();
  const { version, profile, names } = parsed as { version?: unknown; profile?: unknown; names?: unknown };
  if (version !== 1 || typeof profile !== 'string' || !PROFILE_PATTERN.test(profile) || !Array.isArray(names)) {
    throw malformed();
  }
  const out: string[] = [];
  for (const name of names as unknown[]) {
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) throw malformed();
    out.push(name);
  }
  return { profile, names: out };
}

/** Sorted, unique names; mode 0600; temp file then rename. */
export function writeCredentialIndex(paths: Paths, index: CredentialIndex): void {
  assertProfile(index.profile);
  for (const name of index.names) assertName(name);
  const sorted = [...new Set(index.names)].sort();
  const dir = path.dirname(paths.credentials);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.credentials.${process.pid}.${Date.now()}.tmp`);
  try {
    const body = { version: 1, profile: index.profile, names: sorted };
    fs.writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, paths.credentials);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

export interface IndexLockOptions {
  /** How long to wait for another holder before giving up. */
  timeoutMs?: number;
  /** Age after which a lock file is taken to be left behind by a dead process. */
  staleMs?: number;
  /** For tests: called right before the check that this process still owns the lock. */
  beforeWrite?: () => void;
}

const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30000;
const LOCK_RETRY_MS = 25;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The content of the lock file; undefined when it does not exist or cannot be read. */
function readLockToken(lockPath: string): string | undefined {
  try {
    return fs.readFileSync(lockPath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Runs `run` while holding `<paths.credentials>.lock`. The lock file holds a token unique to this
 * acquisition. `run` receives `assertOwned`, which throws `stale_state` when the file no longer
 * holds that token; on release the file is removed only while it still holds it, so a holder that
 * lost a stale lock neither writes over its successor nor removes the successor's lock.
 */
function withIndexLock<T>(paths: Paths, options: IndexLockOptions, run: (assertOwned: () => void) => T): T {
  const lockPath = `${paths.credentials}.lock`;
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const token = randomBytes(8).toString('hex');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let held = false;
  while (!held) {
    let fd: number;
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new AutopilotError('config_invalid', 'The credential index could not be locked', {
          hint: `Check the permissions of ${path.dirname(lockPath)}.`,
          cause: error,
        });
      }
      const seen = readLockToken(lockPath);
      let ageMs: number | undefined;
      try {
        ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch {
        // The holder released the lock between the open and the stat: try again at once.
        continue;
      }
      if (ageMs > staleMs) {
        // Remove only the lock that was judged stale: a lock another process created since holds another token.
        if (seen !== undefined && readLockToken(lockPath) === seen) fs.rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new AutopilotError('stale_state', 'The credential index is being updated by another process.', {
          retryable: true,
        });
      }
      sleepSync(LOCK_RETRY_MS);
      continue;
    }
    try {
      fs.writeSync(fd, token);
    } finally {
      fs.closeSync(fd);
    }
    held = true;
  }
  const assertOwned = (): void => {
    if (readLockToken(lockPath) !== token) {
      throw new AutopilotError(
        'stale_state',
        'The credential index lock was taken over by another process; nothing was written.',
        { retryable: true },
      );
    }
  };
  try {
    return run(assertOwned);
  } finally {
    if (readLockToken(lockPath) === token) fs.rmSync(lockPath, { force: true });
  }
}

function newCredentialIndex(): CredentialIndex {
  return { profile: randomBytes(4).toString('hex'), names: [] };
}

/**
 * Reads the index (creating it with a new profile when it does not exist), applies `mutate` to
 * its names and writes it back, all under an exclusive lock, so concurrent updates do not lose
 * each other. Returns the index as written. Throws `stale_state` and writes nothing when the lock
 * was taken over before the write.
 */
export function updateCredentialIndex(
  paths: Paths,
  mutate: (names: string[]) => string[],
  options: IndexLockOptions = {},
): CredentialIndex {
  return withIndexLock(paths, options, (assertOwned) => {
    const current = readCredentialIndex(paths) ?? newCredentialIndex();
    const next: CredentialIndex = { profile: current.profile, names: [...new Set(mutate([...current.names]))].sort() };
    options.beforeWrite?.();
    assertOwned();
    writeCredentialIndex(paths, next);
    return next;
  });
}

/**
 * The existing index, or a new one with a random profile that is written to disk.
 * Creation happens under the index lock and re-reads first, so two first runs agree on one profile.
 */
export function ensureCredentialIndex(paths: Paths, options: IndexLockOptions = {}): CredentialIndex {
  const existing = readCredentialIndex(paths);
  if (existing !== null) return existing;
  return withIndexLock(paths, options, (assertOwned) => {
    const raced = readCredentialIndex(paths);
    if (raced !== null) return raced;
    const created = newCredentialIndex();
    options.beforeWrite?.();
    assertOwned();
    writeCredentialIndex(paths, created);
    return created;
  });
}

/**
 * Reads every indexed name from the store once. Never throws.
 * A name in `blocked` is registered for the store but has no readable value: no other source may supply it.
 */
export function loadStoredCredentials(
  paths: Paths,
  options: { platform?: NodeJS.Platform; exec?: ExecFile } = {},
): { values: Env; blocked: string[]; sources: CredentialSources } {
  const platform = options.platform ?? process.platform;
  const values: Env = {};
  const blocked: string[] = [];
  const sources: CredentialSources = { store: kindOf(platform), fromStore: [], unreadable: [] };
  const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
  let index: CredentialIndex | null;
  try {
    index = readCredentialIndex(paths);
  } catch (error) {
    sources.unreadable.push({ name: 'credentials.json', reason: reasonOf(error) });
    return { values, blocked, sources };
  }
  if (index === null || index.names.length === 0) return { values, blocked, sources };
  const block = (name: string, reason: string): void => {
    blocked.push(name);
    sources.unreadable.push({ name, reason });
  };
  let store: SecretStore | undefined;
  for (const name of index.names) {
    try {
      store ??= createSecretStore({
        profile: index.profile,
        platform,
        ...(options.exec === undefined ? {} : { exec: options.exec }),
      });
      const value = store.get(name);
      if (value === undefined) {
        block(name, 'not in the credential store');
      } else {
        values[name] = value;
        sources.fromStore.push(name);
      }
    } catch (error) {
      block(name, reasonOf(error));
    }
  }
  return { values, blocked, sources };
}
