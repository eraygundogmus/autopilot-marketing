import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { credentialUnavailable, envFor, loadEnv, missingEnv } from '../../src/core/env';
import { resolvePaths } from '../../src/core/paths';
import type { AccountConfig } from '../../src/core/types';

function homeWithEnv(lines: string[]): ReturnType<typeof resolvePaths> {
  const home = mkdtempSync(join(tmpdir(), 'apm-'));
  writeFileSync(join(home, '.env'), lines.join('\n'));
  return resolvePaths({ AUTOPILOT_HOME: home });
}

const account: AccountConfig = { id: 'acme-meta', platform: 'meta_ads', externalId: 'act_1', envPrefix: 'ACME_' };

describe('loadEnv with the credential store', () => {
  it('lets the process win over the store, and the store over the .env file', () => {
    const paths = homeWithEnv(['A=file', 'B=file', 'C=file']);
    const env = loadEnv(paths, { A: 'process' }, { values: { A: 'store', B: 'store' }, blocked: [] });
    expect(env.A).toBe('process');
    expect(env.B).toBe('store');
    expect(env.C).toBe('file');
  });

  it('gives a registered credential that cannot be read no value from the .env file', () => {
    const paths = homeWithEnv(['META_ACCESS_TOKEN=stale-token-from-file']);
    const env = loadEnv(paths, {}, { values: {}, blocked: ['META_ACCESS_TOKEN'] });
    expect(env.META_ACCESS_TOKEN).toBeUndefined();
    expect(credentialUnavailable(env, 'META_ACCESS_TOKEN')).toBe(true);
    expect(missingEnv(env, { ...account, envPrefix: '' }, ['META_ACCESS_TOKEN'])).toEqual(['META_ACCESS_TOKEN']);
  });

  it('keeps an explicit process value for a name the store could not read', () => {
    const paths = homeWithEnv([]);
    const env = loadEnv(paths, { META_ACCESS_TOKEN: 'from-process' }, { values: {}, blocked: ['META_ACCESS_TOKEN'] });
    expect(env.META_ACCESS_TOKEN).toBe('from-process');
    expect(credentialUnavailable(env, 'META_ACCESS_TOKEN')).toBe(false);
  });

  it("does not fall back to the shared credential when the account's own one cannot be read", () => {
    const paths = homeWithEnv(['META_ACCESS_TOKEN=token-of-another-identity']);
    const readable = loadEnv(paths, {}, { values: {}, blocked: [] });
    expect(envFor(readable, account, 'META_ACCESS_TOKEN')).toBe('token-of-another-identity');

    const blocked = loadEnv(paths, {}, { values: {}, blocked: ['ACME_META_ACCESS_TOKEN'] });
    expect(envFor(blocked, account, 'META_ACCESS_TOKEN')).toBeUndefined();
    // Another account without the prefix still reads the shared credential.
    expect(envFor(blocked, { ...account, id: 'other', envPrefix: '' }, 'META_ACCESS_TOKEN')).toBe('token-of-another-identity');
  });
});
