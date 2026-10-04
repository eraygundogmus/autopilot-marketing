import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { workCommands } from '../../src/cli/commands';
import { main } from '../../src/cli/main';
import { AutopilotError } from '../../src/core/errors';
import { VERSION } from '../../src/version';

interface Captured {
  code: number;
  out: string;
  err: string;
}

async function run(...argv: string[]): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    stdin: { isTTY: false },
    confirm: async () => false,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SECRET = 'sk-test-super-secret-value-123456';
const saved: Record<string, string | undefined> = {};
let home = '';

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-'));
  for (const name of ['AUTOPILOT_HOME', 'AUTOPILOT_KILL', 'TYPESAFE_API_KEY', 'TYPESAFE_AI_KEY']) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  process.env.AUTOPILOT_HOME = home;
  process.env.TYPESAFE_API_KEY = SECRET;
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const name of Object.keys(workCommands)) {
    if (name.startsWith('test-')) delete workCommands[name];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe('main', () => {
  it('prints the version', async () => {
    expect(await run('--version')).toMatchObject({ code: 0, out: VERSION });
    expect(await run('version')).toMatchObject({ code: 0, out: VERSION });
  });

  it('lists every command in the help, without creating state', async () => {
    const result = await run('help');
    expect(result.code).toBe(0);
    for (const group of ['Setup', 'Read', 'Change', 'Operate']) expect(result.out).toContain(group);
    for (const command of [
      'init',
      'doctor',
      'mcp',
      'snapshot',
      'audit',
      'report',
      'ledger',
      'plan',
      'preview',
      'approve',
      'review',
      'apply',
      'revert',
      'run',
      'kill',
    ]) {
      expect(result.out).toMatch(new RegExp(`^  ${command}\\b`, 'm'));
    }
    expect((await run()).out).toBe(result.out);
    expect((await run('--help')).out).toBe(result.out);
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it('init creates config.json and brief.md and never overwrites without --force', async () => {
    const config = path.join(home, 'config.json');
    const first = await run('init');
    expect(first.code).toBe(0);
    expect(first.out).toContain(config);
    expect(first.out).toContain('autopilot-marketing doctor');
    expect(fs.existsSync(path.join(home, 'brief.md'))).toBe(true);

    const edited = { ...JSON.parse(fs.readFileSync(config, 'utf8')), autonomy: 'approve' };
    fs.writeFileSync(config, JSON.stringify(edited));
    expect((await run('init')).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(config, 'utf8')).autonomy).toBe('approve');

    expect((await run('init', '--force')).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(config, 'utf8')).autonomy).not.toBe('approve');
  });

  it('doctor on a fresh home shows five demo accounts and no secret values', async () => {
    const text = await run('doctor');
    expect(text.code).toBe(0);
    expect(text.out).toContain('Accounts (5)');
    expect(text.out).toContain(home);
    expect(text.out).toContain('Kill switch: off');
    expect(text.out + text.err).not.toContain(SECRET);

    const json = await run('doctor', '--json');
    expect(json.code).toBe(0);
    expect(json.out).not.toContain(SECRET);
    const parsed = JSON.parse(json.out) as { accounts: unknown[]; ledger: { ok: boolean }; killSwitch: boolean };
    expect(parsed.accounts).toHaveLength(5);
    expect(parsed.ledger.ok).toBe(true);
    expect(parsed.killSwitch).toBe(false);
  });

  it('doctor exits 1 on an invalid config', async () => {
    fs.writeFileSync(path.join(home, 'config.json'), '{ not json');
    const result = await run('doctor');
    expect(result.code).toBe(1);
    expect(result.err).toContain('Error (config_invalid):');
    expect(result.err).toContain('Next: ');
  });

  it('ledger --verify exits 0 on an empty ledger', async () => {
    const verify = await run('ledger', '--verify');
    expect(verify.code).toBe(0);
    expect(verify.out).toContain('Ledger ok: 0 entries');
    expect(await run('ledger')).toMatchObject({ code: 0, out: 'The ledger is empty.' });
    expect((await run('ledger', '--limit', 'many')).code).toBe(1);
  });

  it('shows each work command in the help with the argument form the command itself reports', async () => {
    const help = (await run('help')).out;
    const commands = Object.keys(workCommands);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      const result = await run(command, '--json');
      expect(result.code).toBe(1);
      const { error } = JSON.parse(result.out) as { error: { code: string; hint: string } };
      expect(error.code).toBe('invalid_input');
      const prefix = 'Usage: autopilot-marketing ';
      expect(error.hint.startsWith(prefix)).toBe(true);
      expect(help).toMatch(new RegExp(`^  ${escapeRegExp(error.hint.slice(prefix.length))}  `, 'm'));
    }
    expect(help).not.toContain('--csv file');
    expect(help).not.toContain('<execution>');
    expect(help).toContain('Create a compensating plan for an applied plan');
  });

  it('ledger rejects --account without an account id instead of listing every account', async () => {
    for (const argv of [['ledger', '--account'], ['ledger', '--account', ''], ['ledger', '--account=']]) {
      const result = await run(...argv);
      expect(result.code).toBe(1);
      expect(result.out).toBe('');
      expect(result.err).toContain('Error (invalid_input): --account needs an account id');
      expect(result.err).toContain('Next: Example: autopilot-marketing ledger --account <id>');
    }
    expect(await run('ledger', '--account', 'demo-google')).toMatchObject({ code: 0, out: 'The ledger is empty.' });
    expect((await run('ledger', '--account', 'no-such-account')).code).toBe(1);
  });

  it('kill on/off toggles the file and doctor reflects it', async () => {
    const killFile = path.join(home, 'KILL');
    expect((await run('kill', 'on')).code).toBe(0);
    expect(fs.existsSync(killFile)).toBe(true);
    expect((await run('doctor')).out).toContain('Kill switch: ON');
    expect((await run('kill', 'off')).code).toBe(0);
    expect(fs.existsSync(killFile)).toBe(false);
    expect((await run('doctor')).out).toContain('Kill switch: off');
    expect((await run('kill')).code).toBe(2);
  });

  it('returns 2 with the usage for an unknown command', async () => {
    const result = await run('frobnicate');
    expect(result.code).toBe(2);
    expect(result.err).toContain('Unknown command: frobnicate');
    expect(result.err).toContain('Usage: autopilot-marketing');
    expect((await run('constructor')).code).toBe(2);
  });

  it('dispatches work commands with positionals and flags', async () => {
    let seen: unknown;
    workCommands['test-echo'] = async (ctx) => {
      seen = { args: ctx.args, flags: ctx.flags, json: ctx.json, home: ctx.runtime.paths.home };
      return 0;
    };
    const result = await run('test-echo', 'plan_1', '--live', '--csv', 'a.csv', '--csv', 'b.csv', '--days', '7');
    expect(result.code).toBe(0);
    expect(seen).toEqual({
      args: ['plan_1'],
      flags: { live: true, csv: ['a.csv', 'b.csv'], days: '7' },
      json: false,
      home: fs.realpathSync(home) === home ? home : path.resolve(home),
    });
  });

  it('prints an AutopilotError with its hint, redacted, and returns 1', async () => {
    workCommands['test-fail'] = async () => {
      throw new AutopilotError('approval_required', `Plan needs approval (${SECRET})`, {
        hint: 'Run `autopilot-marketing approve plan_1`.',
      });
    };
    const result = await run('test-fail');
    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    expect(result.err).toContain('Error (approval_required): Plan needs approval');
    expect(result.err).toContain('Next: Run `autopilot-marketing approve plan_1`.');
    expect(result.err).not.toContain(SECRET);
  });

  it('prints errors as JSON on stdout with --json', async () => {
    workCommands['test-fail'] = async () => {
      throw new AutopilotError('stale_state', 'Budget changed since the plan was made', { hint: 'Plan again.' });
    };
    const withHint = await run('test-fail', '--json');
    expect(withHint.code).toBe(1);
    expect(withHint.err).toBe('');
    expect(JSON.parse(withHint.out)).toEqual({
      error: { code: 'stale_state', message: 'Budget changed since the plan was made', hint: 'Plan again.' },
    });

    workCommands['test-fail'] = async () => {
      throw new Error('boom');
    };
    expect(JSON.parse((await run('test-fail', '--json')).out)).toEqual({
      error: { code: 'internal', message: 'boom', hint: null },
    });
  });
});
