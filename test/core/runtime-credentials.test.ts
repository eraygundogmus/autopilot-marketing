import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AutopilotError } from '../../src/core/errors';
import { createRuntime } from '../../src/core/runtime';

describe('createRuntime and the credential index', () => {
  it('stops when the index exists but cannot be read, instead of using .env in its place', () => {
    const home = mkdtempSync(join(tmpdir(), 'apm-'));
    writeFileSync(join(home, 'credentials.json'), '{ not json');
    writeFileSync(join(home, '.env'), 'META_ACCESS_TOKEN=stale-token-from-file\n');
    let thrown: unknown;
    try {
      createRuntime({ env: { AUTOPILOT_HOME: home } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AutopilotError);
    expect((thrown as AutopilotError).code).toBe('config_invalid');
    expect((thrown as AutopilotError).message).toContain('credentials.json');
    expect((thrown as AutopilotError).message).not.toContain('stale-token-from-file');
  });

  it('starts without an index and reports that nothing came from the credential store', () => {
    const home = mkdtempSync(join(tmpdir(), 'apm-'));
    const runtime = createRuntime({ env: { AUTOPILOT_HOME: home } });
    expect(runtime.credentials.fromStore).toEqual([]);
    expect(runtime.credentials.unreadable).toEqual([]);
  });
});
