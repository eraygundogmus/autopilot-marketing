import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AutopilotError } from '../../src/core/errors';
import { resolvePaths } from '../../src/core/paths';
import {
  createSecretStore,
  ensureCredentialIndex,
  loadStoredCredentials,
  readCredentialIndex,
  updateCredentialIndex,
  writeCredentialIndex,
} from '../../src/core/secrets';
import type { ExecFile, ExecResult } from '../../src/core/secrets';
import type { Paths } from '../../src/core/types';

interface Call {
  file: string;
  args: string[];
  input?: string;
  timeoutMs: number;
}

interface Fake {
  exec: ExecFile;
  calls: Call[];
  entries: Map<string, string>;
}

const ok = (stdout = ''): ExecResult => ({ status: 0, stdout, stderr: '' });

function record(calls: Call[], file: string, args: string[], options: { input?: string; timeoutMs: number }): void {
  calls.push({ file, args, timeoutMs: options.timeoutMs, ...(options.input === undefined ? {} : { input: options.input }) });
}

function fakeDarwin(behaviour: { dropWrites?: boolean } = {}): Fake {
  const calls: Call[] = [];
  const entries = new Map<string, string>();
  const missing: ExecResult = {
    status: 44,
    stdout: '',
    stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n',
  };
  const exec: ExecFile = (file, args, options) => {
    record(calls, file, args, options);
    if (file !== '/usr/bin/security') return { status: null, stdout: '', stderr: '', errorCode: 'ENOENT' };
    if (args[0] === '-i') {
      const match = /^add-generic-password -U -s "autopilot-marketing" -a "([^"]+)" -l "autopilot-marketing [^"]+ \([a-z0-9]{8}\)" -w "([^"]*)"\n$/.exec(
        options.input ?? '',
      );
      if (match === null) return { status: 1, stdout: '', stderr: 'bad line\n' };
      if (behaviour.dropWrites !== true) entries.set(match[1] ?? '', match[2] ?? '');
      return ok();
    }
    const name = args[args.indexOf('-a') + 1] ?? '';
    if (args[0] === 'find-generic-password') {
      const value = entries.get(name);
      return value === undefined ? missing : ok(`${value}\n`);
    }
    if (args[0] === 'delete-generic-password') return entries.delete(name) ? ok() : missing;
    return { status: 2, stdout: '', stderr: 'unknown command\n' };
  };
  return { exec, calls, entries };
}

function fakeLinux(behaviour: { dropWrites?: boolean } = {}): Fake {
  const calls: Call[] = [];
  const entries = new Map<string, string>();
  const exec: ExecFile = (file, args, options) => {
    record(calls, file, args, options);
    if (file !== 'secret-tool') return { status: null, stdout: '', stderr: '', errorCode: 'ENOENT' };
    const name = args[args.length - 1] ?? '';
    if (args[0] === 'store') {
      if (behaviour.dropWrites !== true) entries.set(name, options.input ?? '');
      return ok();
    }
    if (args[0] === 'lookup') {
      const value = entries.get(name);
      return value === undefined ? { status: 1, stdout: '', stderr: '' } : ok(value);
    }
    if (args[0] === 'clear') {
      entries.delete(name);
      return ok();
    }
    return { status: 2, stdout: '', stderr: 'unknown command\n' };
  };
  return { exec, calls, entries };
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof AutopilotError) return error.code;
    throw error;
  }
  return 'no error';
}

function tempPaths(): Paths {
  return resolvePaths({ AUTOPILOT_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'apm-')) });
}

const PROFILE = 'ab12cd34';
const OTHER_PROFILE = 'ef56ab78';

const SECRET = 'p"a\'ss\\word\nline two şğü 日本';

const platforms: Array<{ platform: NodeJS.Platform; kind: string; make: (b?: { dropWrites?: boolean }) => Fake }> = [
  { platform: 'darwin', kind: 'keychain', make: fakeDarwin },
  { platform: 'linux', kind: 'secret-service', make: fakeLinux },
];

describe.each(platforms)('createSecretStore on $platform', ({ platform, kind, make }) => {
  it('round trips a value and keeps it out of argv', () => {
    const fake = make();
    const store = createSecretStore({ profile: PROFILE, platform, exec: fake.exec });
    expect(store.kind).toBe(kind);
    expect(store.profile).toBe(PROFILE);
    store.set('META_TOKEN', SECRET);
    expect(store.get('META_TOKEN')).toBe(SECRET);

    const stored = `b64:${Buffer.from(SECRET, 'utf8').toString('base64')}`;
    expect(fake.entries.get(`${PROFILE}.META_TOKEN`)).toBe(stored);
    for (const call of fake.calls) {
      expect(call.timeoutMs).toBe(10000);
      expect(call.args.join(' ')).not.toContain(SECRET);
      expect(call.args.join(' ')).not.toContain(stored);
    }
    expect(fake.calls.some((call) => call.input?.includes(stored) === true)).toBe(true);
  });

  it('returns a value stored without the prefix as it is', () => {
    const fake = make();
    fake.entries.set(`${PROFILE}.LEGACY`, 'plain-value');
    expect(createSecretStore({ profile: PROFILE, platform, exec: fake.exec }).get('LEGACY')).toBe('plain-value');
  });

  it('returns undefined for a missing name', () => {
    const fake = make();
    expect(createSecretStore({ profile: PROFILE, platform, exec: fake.exec }).get('MISSING')).toBeUndefined();
  });

  it('deletes once: true, then false', () => {
    const fake = make();
    const store = createSecretStore({ profile: PROFILE, platform, exec: fake.exec });
    store.set('TOKEN', 'value');
    expect(store.delete('TOKEN')).toBe(true);
    expect(store.delete('TOKEN')).toBe(false);
    expect(store.get('TOKEN')).toBeUndefined();
  });

  it('throws not_configured when a set silently fails', () => {
    const fake = make({ dropWrites: true });
    const store = createSecretStore({ profile: PROFILE, platform, exec: fake.exec });
    expect(codeOf(() => store.set('TOKEN', 'value'))).toBe('not_configured');
  });

  it('throws not_configured on ENOENT and on timeout, with a hint and without the secret', () => {
    for (const errorCode of ['ENOENT', 'ETIMEDOUT']) {
      const exec: ExecFile = () => ({ status: null, stdout: '', stderr: '', errorCode });
      const store = createSecretStore({ profile: PROFILE, platform, exec });
      expect(codeOf(() => store.get('TOKEN'))).toBe('not_configured');
      expect(codeOf(() => store.delete('TOKEN'))).toBe('not_configured');
      let caught: unknown;
      try {
        store.set('TOKEN', SECRET);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AutopilotError);
      const error = caught as AutopilotError;
      expect(error.code).toBe('not_configured');
      expect(error.hint).toContain('.env file');
      expect(error.message).not.toContain(SECRET);
    }
  });

  it('throws not_configured when the tool reports another failure', () => {
    const exec: ExecFile = () => ({ status: 1, stdout: '', stderr: 'Cannot autolaunch D-Bus without X11\nmore\n' });
    const store = createSecretStore({ profile: PROFILE, platform, exec });
    let caught: unknown;
    try {
      store.get('TOKEN');
    } catch (error) {
      caught = error;
    }
    expect((caught as AutopilotError).code).toBe('not_configured');
    expect((caught as AutopilotError).message).toContain('Cannot autolaunch D-Bus without X11');
    expect((caught as AutopilotError).message).not.toContain('more');
  });

  it('keeps the same name of two profiles apart', () => {
    const fake = make();
    const first = createSecretStore({ profile: PROFILE, platform, exec: fake.exec });
    const second = createSecretStore({ profile: OTHER_PROFILE, platform, exec: fake.exec });
    first.set('META_ACCESS_TOKEN', 'first-value');
    expect(second.get('META_ACCESS_TOKEN')).toBeUndefined();
    second.set('META_ACCESS_TOKEN', 'second-value');
    expect(first.get('META_ACCESS_TOKEN')).toBe('first-value');
    expect(second.get('META_ACCESS_TOKEN')).toBe('second-value');
    expect(second.delete('META_ACCESS_TOKEN')).toBe(true);
    expect(first.get('META_ACCESS_TOKEN')).toBe('first-value');
    expect([...fake.entries.keys()]).toEqual([`${PROFILE}.META_ACCESS_TOKEN`]);
  });

  it('refuses an invalid profile', () => {
    const fake = make();
    for (const profile of ['', 'short', 'AB12CD34', 'ab12cd345', 'ab12.d34', 'ab12cd3"']) {
      expect(codeOf(() => createSecretStore({ profile, platform, exec: fake.exec }))).toBe('invalid_input');
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('never carries stdout of the tool in an error', () => {
    const exec: ExecFile = () => ({ status: 1, stdout: 'SECRETVALUE\n', stderr: 'store is locked\n' });
    const store = createSecretStore({ profile: PROFILE, platform, exec });
    const runs = [() => store.get('TOKEN'), () => store.set('TOKEN', 'value'), () => store.delete('TOKEN')];
    for (const run of runs) {
      let caught: unknown;
      try {
        run();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AutopilotError);
      const error = caught as AutopilotError;
      expect(error.message).toContain('store is locked');
      expect(`${error.message} ${error.hint ?? ''} ${JSON.stringify(error)}`).not.toContain('SECRETVALUE');
    }
  });

  it('refuses an invalid name and an empty value without calling the tool', () => {
    const fake = make();
    const store = createSecretStore({ profile: PROFILE, platform, exec: fake.exec });
    expect(codeOf(() => store.set('bad name', 'value'))).toBe('invalid_input');
    expect(codeOf(() => store.get('1ABC'))).toBe('invalid_input');
    expect(codeOf(() => store.delete('a"b'))).toBe('invalid_input');
    expect(codeOf(() => store.get('A'.repeat(129)))).toBe('invalid_input');
    expect(codeOf(() => store.set('TOKEN', ''))).toBe('invalid_input');
    expect(fake.calls).toHaveLength(0);
  });
});

describe('createSecretStore, platform specifics', () => {
  it('writes one quoted line to security -i on darwin', () => {
    const fake = fakeDarwin();
    createSecretStore({ profile: PROFILE, platform: 'darwin', exec: fake.exec }).set('TOKEN', 'value');
    const first = fake.calls[0];
    expect(first?.file).toBe('/usr/bin/security');
    expect(first?.args).toEqual(['-i']);
    expect(first?.input).toBe(
      `add-generic-password -U -s "autopilot-marketing" -a "ab12cd34.TOKEN" -l "autopilot-marketing TOKEN (ab12cd34)" -w "b64:${Buffer.from('value').toString('base64')}"\n`,
    );
    expect(fake.calls[1]?.args).toEqual(['find-generic-password', '-s', 'autopilot-marketing', '-a', 'ab12cd34.TOKEN', '-w']);
  });

  it('refuses an over-long line on darwin', () => {
    const fake = fakeDarwin();
    const store = createSecretStore({ profile: PROFILE, platform: 'darwin', exec: fake.exec });
    expect(codeOf(() => store.set('TOKEN', 'x'.repeat(4000)))).toBe('invalid_input');
    expect(fake.calls).toHaveLength(0);
  });

  it('passes the stored form on stdin without a newline on linux', () => {
    const fake = fakeLinux();
    createSecretStore({ profile: PROFILE, platform: 'linux', exec: fake.exec }).set('TOKEN', 'value');
    const first = fake.calls[0];
    expect(first?.args).toEqual([
      'store',
      '--label',
      'autopilot-marketing TOKEN (ab12cd34)',
      'service',
      'autopilot-marketing',
      'account',
      'ab12cd34.TOKEN',
    ]);
    expect(first?.input).toBe(`b64:${Buffer.from('value').toString('base64')}`);
  });

  it('throws on every operation on an unsupported platform', () => {
    const fake = fakeLinux();
    const store = createSecretStore({ profile: PROFILE, platform: 'win32', exec: fake.exec });
    expect(store.kind).toBe('none');
    expect(codeOf(() => store.get('TOKEN'))).toBe('not_configured');
    expect(codeOf(() => store.set('TOKEN', 'value'))).toBe('not_configured');
    expect(codeOf(() => store.delete('TOKEN'))).toBe('not_configured');
    expect(() => store.get('TOKEN')).toThrow('No supported credential store on this system');
    expect(fake.calls).toHaveLength(0);
  });
});

describe('credential index', () => {
  it('is null when the file is missing', () => {
    expect(readCredentialIndex(tempPaths())).toBeNull();
  });

  it('round trips sorted and unique, mode 0600', () => {
    const paths = tempPaths();
    writeCredentialIndex(paths, { profile: PROFILE, names: ['META_TOKEN', 'GOOGLE_TOKEN', 'META_TOKEN'] });
    expect(readCredentialIndex(paths)).toEqual({ profile: PROFILE, names: ['GOOGLE_TOKEN', 'META_TOKEN'] });
    expect(JSON.parse(fs.readFileSync(paths.credentials, 'utf8'))).toEqual({
      version: 1,
      profile: PROFILE,
      names: ['GOOGLE_TOKEN', 'META_TOKEN'],
    });
    expect(fs.statSync(paths.credentials).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(paths.home)).toEqual(['credentials.json']);
  });

  it('throws config_invalid for a malformed file', () => {
    const paths = tempPaths();
    for (const text of [
      '{not json',
      '[]',
      '{"version":2,"profile":"ab12cd34","names":[]}',
      '{"version":1,"profile":"ab12cd34","names":[1]}',
      '{"version":1,"names":[]}',
      '{"version":1,"profile":"AB12CD34","names":[]}',
    ]) {
      fs.writeFileSync(paths.credentials, text);
      expect(codeOf(() => readCredentialIndex(paths))).toBe('config_invalid');
    }
  });

  it('refuses to write an invalid profile', () => {
    const paths = tempPaths();
    expect(codeOf(() => writeCredentialIndex(paths, { profile: 'nope', names: [] }))).toBe('invalid_input');
    expect(fs.existsSync(paths.credentials)).toBe(false);
  });

  it('creates a profile once and returns the same one afterwards', () => {
    const paths = tempPaths();
    const first = ensureCredentialIndex(paths);
    expect(first.profile).toMatch(/^[0-9a-f]{8}$/);
    expect(first.names).toEqual([]);
    expect(fs.statSync(paths.credentials).mode & 0o777).toBe(0o600);
    writeCredentialIndex(paths, { profile: first.profile, names: ['TOKEN'] });
    expect(ensureCredentialIndex(paths)).toEqual({ profile: first.profile, names: ['TOKEN'] });
    expect(ensureCredentialIndex(tempPaths()).profile).not.toBe(first.profile);
  });
});

describe('updateCredentialIndex', () => {
  const lockOf = (paths: Paths): string => `${paths.credentials}.lock`;

  it('gives up with a retryable stale_state while a fresh lock is held, and changes nothing', () => {
    const paths = tempPaths();
    writeCredentialIndex(paths, { profile: PROFILE, names: ['FIRST'] });
    fs.writeFileSync(lockOf(paths), '');
    let caught: unknown;
    try {
      updateCredentialIndex(paths, (names) => [...names, 'SECOND'], { timeoutMs: 100 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AutopilotError);
    expect((caught as AutopilotError).code).toBe('stale_state');
    expect((caught as AutopilotError).retryable).toBe(true);
    expect((caught as AutopilotError).message).toBe('The credential index is being updated by another process.');
    expect(readCredentialIndex(paths)).toEqual({ profile: PROFILE, names: ['FIRST'] });
    expect(fs.existsSync(lockOf(paths))).toBe(true);
    expect(codeOf(() => ensureCredentialIndex(paths, { timeoutMs: 100 }))).toBe('no error');
  });

  it('makes a first run wait for the lock as well', () => {
    const paths = tempPaths();
    fs.writeFileSync(lockOf(paths), '');
    expect(codeOf(() => ensureCredentialIndex(paths, { timeoutMs: 100 }))).toBe('stale_state');
    expect(fs.existsSync(paths.credentials)).toBe(false);
  });

  it('removes a lock older than staleMs and succeeds', () => {
    const paths = tempPaths();
    writeCredentialIndex(paths, { profile: PROFILE, names: [] });
    fs.writeFileSync(lockOf(paths), '');
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(lockOf(paths), old, old);
    expect(updateCredentialIndex(paths, (names) => [...names, 'TOKEN'], { timeoutMs: 100 })).toEqual({
      profile: PROFILE,
      names: ['TOKEN'],
    });
    expect(fs.existsSync(lockOf(paths))).toBe(false);

    fs.writeFileSync(lockOf(paths), '');
    const recent = new Date(Date.now() - 2000);
    fs.utimesSync(lockOf(paths), recent, recent);
    expect(updateCredentialIndex(paths, (names) => [...names, 'OTHER'], { timeoutMs: 100, staleMs: 1000 }).names).toEqual([
      'OTHER',
      'TOKEN',
    ]);
    expect(fs.existsSync(lockOf(paths))).toBe(false);
  });

  it('releases the lock after a success and after a mutate that throws', () => {
    const paths = tempPaths();
    updateCredentialIndex(paths, (names) => {
      expect(fs.existsSync(lockOf(paths))).toBe(true);
      return [...names, 'TOKEN'];
    });
    expect(fs.existsSync(lockOf(paths))).toBe(false);
    expect(() =>
      updateCredentialIndex(paths, () => {
        throw new Error('mutate failed');
      }),
    ).toThrow('mutate failed');
    expect(fs.existsSync(lockOf(paths))).toBe(false);
    expect(codeOf(() => updateCredentialIndex(paths, () => ['bad name']))).toBe('invalid_input');
    expect(fs.existsSync(lockOf(paths))).toBe(false);
    expect(readCredentialIndex(paths)?.names).toEqual(['TOKEN']);
    expect(fs.readdirSync(paths.home)).toEqual(['credentials.json']);
  });

  it('creates the index with a profile and accumulates names over sequential updates', () => {
    const paths = tempPaths();
    const first = updateCredentialIndex(paths, (names) => [...names, 'META_TOKEN']);
    expect(first.profile).toMatch(/^[0-9a-f]{8}$/);
    expect(first.names).toEqual(['META_TOKEN']);
    const second = updateCredentialIndex(paths, (names) => [...names, 'GOOGLE_TOKEN', 'META_TOKEN']);
    expect(second).toEqual({ profile: first.profile, names: ['GOOGLE_TOKEN', 'META_TOKEN'] });
    const third = updateCredentialIndex(paths, (names) => names.filter((name) => name !== 'META_TOKEN'));
    expect(third).toEqual({ profile: first.profile, names: ['GOOGLE_TOKEN'] });
    expect(readCredentialIndex(paths)).toEqual(third);
    expect(fs.statSync(paths.credentials).mode & 0o777).toBe(0o600);
  });

  it('leaves one profile and no lock after two ensureCredentialIndex calls', () => {
    const paths = tempPaths();
    const first = ensureCredentialIndex(paths);
    const second = ensureCredentialIndex(paths);
    expect(second.profile).toBe(first.profile);
    expect(fs.readdirSync(paths.home)).toEqual(['credentials.json']);
  });
});

describe('loadStoredCredentials', () => {
  it('reports one good name and blocks a missing and a throwing one', () => {
    const paths = tempPaths();
    writeCredentialIndex(paths, { profile: PROFILE, names: ['GOOD', 'MISSING', 'THROWS'] });
    const fake = fakeDarwin();
    fake.entries.set(`${PROFILE}.GOOD`, 'value');
    fake.entries.set(`${OTHER_PROFILE}.MISSING`, 'value of another home');
    const exec: ExecFile = (file, args, options) =>
      args.includes(`${PROFILE}.THROWS`)
        ? { status: 51, stdout: 'SECRETVALUE\n', stderr: 'User interaction is not allowed.\n' }
        : fake.exec(file, args, options);
    const result = loadStoredCredentials(paths, { platform: 'darwin', exec });
    expect(result.values).toEqual({ GOOD: 'value' });
    expect(result.blocked).toEqual(['MISSING', 'THROWS']);
    expect(result.sources.store).toBe('keychain');
    expect(result.sources.fromStore).toEqual(['GOOD']);
    expect(result.sources.unreadable).toHaveLength(2);
    expect(result.sources.unreadable[0]).toEqual({ name: 'MISSING', reason: 'not in the credential store' });
    expect(result.sources.unreadable[1]?.name).toBe('THROWS');
    expect(result.sources.unreadable[1]?.reason).toContain('User interaction is not allowed.');
    expect(JSON.stringify(result)).not.toContain('SECRETVALUE');
    expect(fake.calls).toHaveLength(2);
  });

  it('blocks every name on a platform without a store', () => {
    const paths = tempPaths();
    writeCredentialIndex(paths, { profile: PROFILE, names: ['TOKEN'] });
    const fake = fakeLinux();
    const result = loadStoredCredentials(paths, { platform: 'win32', exec: fake.exec });
    expect(result.values).toEqual({});
    expect(result.blocked).toEqual(['TOKEN']);
    expect(result.sources.store).toBe('none');
    expect(fake.calls).toHaveLength(0);
  });

  it('runs no program when there is no index or the index has no names', () => {
    const fake = fakeDarwin();
    const empty = { values: {}, blocked: [], sources: { store: 'keychain', fromStore: [], unreadable: [] } };
    expect(loadStoredCredentials(tempPaths(), { platform: 'darwin', exec: fake.exec })).toEqual(empty);
    const paths = tempPaths();
    writeCredentialIndex(paths, { profile: PROFILE, names: [] });
    expect(loadStoredCredentials(paths, { platform: 'darwin', exec: fake.exec })).toEqual(empty);
    expect(fake.calls).toHaveLength(0);
  });

  it('reports a malformed index instead of throwing', () => {
    const paths = tempPaths();
    fs.writeFileSync(paths.credentials, 'nope');
    const fake = fakeLinux();
    const result = loadStoredCredentials(paths, { platform: 'linux', exec: fake.exec });
    expect(result.values).toEqual({});
    expect(result.blocked).toEqual([]);
    expect(result.sources.store).toBe('secret-service');
    expect(result.sources.fromStore).toEqual([]);
    expect(result.sources.unreadable).toHaveLength(1);
    expect(result.sources.unreadable[0]?.name).toBe('credentials.json');
    expect(result.sources.unreadable[0]?.reason).toContain('malformed');
    expect(fake.calls).toHaveLength(0);
  });
});
