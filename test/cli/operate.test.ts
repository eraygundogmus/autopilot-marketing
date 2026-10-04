import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatClient, ChatMessage } from '../../src/agent/chat';
import { runLocalAgent } from '../../src/agent/runner';
import type { CommandContext } from '../../src/cli/commands';
import type { CliIo } from '../../src/cli/main';
import { operateCommands, OPERATE_USAGE } from '../../src/cli/operate';
import { AutopilotError } from '../../src/core/errors';
import type { DiagnosticCheck, Job, Runtime, SecretStore } from '../../src/core/types';
import { runDue, scheduleOverview } from '../../src/jobs/runner';
import type { TickResult } from '../../src/jobs/runner';
import { defaultConfig } from '../../src/core/config';
import { tempRuntime } from '../helpers/runtime';

// src/jobs/runner.ts and src/agent/runner.ts are written in the same wave; these fakes stand in for them.
vi.mock('../../src/jobs/runner', () => ({ runDue: vi.fn(), scheduleOverview: vi.fn() }));
vi.mock('../../src/agent/runner', () => ({ runLocalAgent: vi.fn() }));

const SECRET = 'sk-very-secret-value-123';

interface FakeIo extends CliIo {
  out: string[];
  err: string[];
  prompts: string[];
}

function fakeIo(options: { secret?: string; onStdout?: (text: string) => void } = {}): FakeIo {
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  return {
    out,
    err,
    prompts,
    stdout: (text) => {
      out.push(text);
      options.onStdout?.(text);
    },
    stderr: (text) => {
      err.push(text);
    },
    stdin: {},
    confirm: async () => false,
    readSecret: async (prompt) => {
      prompts.push(prompt);
      return options.secret ?? '';
    },
  };
}

type Extra = Partial<Pick<CommandContext, 'flags' | 'json' | 'secrets' | 'chat' | 'signal'>> & { io?: FakeIo };

async function call(name: string, runtime: Runtime, args: string[], extra: Extra = {}) {
  const handler = operateCommands[name];
  if (handler === undefined) throw new Error(`no command ${name}`);
  const io = extra.io ?? fakeIo();
  const code = await handler({
    runtime,
    io,
    args,
    flags: extra.flags ?? {},
    json: extra.json ?? false,
    ...(extra.secrets === undefined ? {} : { secrets: extra.secrets }),
    ...(extra.chat === undefined ? {} : { chat: extra.chat }),
    ...(extra.signal === undefined ? {} : { signal: extra.signal }),
  });
  return { code, text: io.out.join(''), errText: io.err.join('\n'), io };
}

async function failure(run: Promise<unknown>): Promise<AutopilotError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof AutopilotError) return error;
    throw error;
  }
  throw new Error('expected an AutopilotError');
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job_0123456789abcdef',
    scheduleId: 'daily',
    accountId: 'demo-google',
    task: 'audit',
    state: 'succeeded',
    dueAt: '2026-01-01T00:00:00.000Z',
    runAfter: '2026-01-01T00:00:00.000Z',
    attempts: 1,
    claimedBy: null,
    claimedUntil: null,
    startedAt: '2026-01-01T00:00:01.000Z',
    finishedAt: '2026-01-01T00:00:02.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    input: { days: 30 },
    result: { summary: 'Score 61, 9 findings.' },
    attention: ['First audit of demo-google:\nscore 61.'],
    ...overrides,
  };
}

function tick(overrides: Partial<TickResult> = {}): TickResult {
  const ran = overrides.ran ?? [job()];
  return {
    enqueued: ran.map((entry) => entry.id),
    reclaimed: [],
    ran,
    attention: ran.some((entry) => entry.attention.length > 0),
    notes: [],
    ...overrides,
  };
}

function memoryStore(): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    kind: 'keychain',
    profile: 'abcd1234',
    values,
    get: (name) => values.get(name),
    set: (name, value) => {
      values.set(name, value);
    },
    delete: (name) => values.delete(name),
  };
}

beforeEach(() => {
  vi.mocked(runDue).mockReset();
  vi.mocked(scheduleOverview).mockReset();
  vi.mocked(runLocalAgent).mockReset();
});

describe('operateCommands', () => {
  it('has the five handlers and keeps the usage texts', () => {
    expect(Object.keys(operateCommands).sort()).toEqual(['agent', 'connect', 'credentials', 'jobs', 'schedule']);
    expect(Object.keys(OPERATE_USAGE).sort()).toEqual(['agent', 'connect', 'credentials', 'jobs', 'schedule']);
  });
});

describe('schedule', () => {
  it('lists none and one', async () => {
    const { runtime } = tempRuntime();
    vi.mocked(scheduleOverview).mockReturnValue([]);
    const none = await call('schedule', runtime, ['list']);
    expect(none.code).toBe(0);
    expect(none.text).toBe(`No schedules. Add them under "schedules" in ${runtime.paths.config}.\n`);

    vi.mocked(scheduleOverview).mockReturnValue([
      {
        schedule: { id: 'daily', accountId: 'demo-google', task: 'audit', every: '1d', at: '06:00', enabled: false },
        nextDueAt: '2026-01-02T06:00:00.000Z',
        lastJob: null,
      },
    ]);
    const one = await call('schedule', runtime, ['list']);
    expect(one.text).toBe(
      'daily  audit of demo-google  every 1d at 06:00  disabled  next 2026-01-02T06:00:00.000Z  last: never\n',
    );
    const asJson = await call('schedule', runtime, ['list'], { json: true });
    expect(JSON.parse(asJson.text).schedules).toHaveLength(1);
  });

  it('rejects an unknown subcommand', async () => {
    const { runtime } = tempRuntime();
    const error = await failure(call('schedule', runtime, ['nope']));
    expect(error.code).toBe('invalid_input');
    expect(error.hint).toContain(OPERATE_USAGE.schedule);
  });

  it('runs one pass: exit 3 on attention, 1 on failure, 0 otherwise', async () => {
    const { runtime } = tempRuntime();
    vi.mocked(runDue).mockResolvedValue(tick());
    const first = await call('schedule', runtime, ['run']);
    expect(first.code).toBe(3);
    expect(first.text).toBe(
      'Queued 1, ran 1.\njob_0123456789abcdef audit demo-google succeeded: Score 61, 9 findings.\n' +
        '  ! First audit of demo-google: score 61.\n',
    );
    // A cycle settles what an interrupted execution left behind before it starts.
    expect(typeof vi.mocked(runDue).mock.calls[0]?.[1]?.reconcile).toBe('function');

    const asJson = await call('schedule', runtime, ['run'], { json: true });
    expect(asJson.code).toBe(3);
    const parsed = JSON.parse(asJson.text) as TickResult;
    expect(Object.keys(parsed).sort()).toEqual(['attention', 'enqueued', 'notes', 'ran', 'reclaimed']);

    // A note about a reclaimed run is printed and counts as attention.
    vi.mocked(runDue).mockResolvedValue(tick({ ran: [], attention: true, notes: ['demo-google: Settled 1 change(s).'] }));
    const noted = await call('schedule', runtime, ['run']);
    expect(noted.code).toBe(3);
    expect(noted.text).toContain('! demo-google: Settled 1 change(s).');
    expect(parsed.ran[0]?.id).toBe('job_0123456789abcdef');

    vi.mocked(runDue).mockResolvedValue(tick({ ran: [job({ state: 'failed', error: 'boom', attention: ['Look.'] })] }));
    const failed = await call('schedule', runtime, ['run']);
    expect(failed.code).toBe(1);
    expect(failed.text).toContain('failed: boom');

    vi.mocked(runDue).mockResolvedValue(tick({ ran: [] }));
    const quiet = await call('schedule', runtime, ['run']);
    expect(quiet.code).toBe(0);
    expect(quiet.text).toBe('Queued 0, ran 0.\n');
  });

  it('--watch ends when the signal aborts and leaves no signal handlers', async () => {
    const { runtime } = tempRuntime();
    vi.mocked(runDue).mockResolvedValue(tick());
    const controller = new AbortController();
    const io = fakeIo({ onStdout: () => controller.abort() });
    const before = process.listenerCount('SIGINT');
    const result = await call('schedule', runtime, ['run'], { flags: { watch: true }, signal: controller.signal, io });
    expect(result.code).toBe(0);
    // The pass is printed in full, so what a run found is not lost in an unattended terminal.
    expect(result.text).toBe(
      'Queued 1, ran 1.\njob_0123456789abcdef audit demo-google succeeded: Score 61, 9 findings.\n' +
        '  ! First audit of demo-google: score 61.\n',
    );
    expect(vi.mocked(runDue)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runDue).mock.calls[0]?.[0]).toBe(runtime);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('--watch refuses an interval under ten seconds', async () => {
    const { runtime } = tempRuntime();
    const error = await failure(call('schedule', runtime, ['run'], { flags: { watch: true, interval: '5' } }));
    expect(error.code).toBe('invalid_input');
  });
});

describe('jobs', () => {
  it('lists runs, newest first, and filters by account', async () => {
    const { runtime } = tempRuntime();
    expect((await call('jobs', runtime, [])).text).toBe('No runs yet.\n');

    const now = new Date('2026-01-01T00:00:00.000Z');
    runtime.jobs.enqueue(
      { id: 'job_aaaaaaaaaaaaaaaa', scheduleId: null, accountId: 'demo-google', task: 'audit', dueAt: now.toISOString(), input: { days: 30 } },
      now,
    );
    runtime.jobs.enqueue(
      { id: 'job_bbbbbbbbbbbbbbbb', scheduleId: null, accountId: 'demo-meta', task: 'report', dueAt: now.toISOString(), input: { days: 7 } },
      now,
    );
    const all = await call('jobs', runtime, []);
    expect(all.text).toContain('job_aaaaaaaaaaaaaaaa  2026-01-01T00:00:00.000Z  audit demo-google  queued');
    expect(all.text).toContain('job_bbbbbbbbbbbbbbbb');

    const filtered = await call('jobs', runtime, [], { flags: { account: 'demo-meta', limit: '5' }, json: true });
    const parsed = JSON.parse(filtered.text) as { jobs: Job[] };
    expect(parsed.jobs.map((entry) => entry.id)).toEqual(['job_bbbbbbbbbbbbbbbb']);
  });
});

describe('credentials', () => {
  it('sets, lists and deletes without ever printing the value', async () => {
    const { runtime, home } = tempRuntime();
    writeFileSync(runtime.paths.envFile, `OTHER=1\nexport MY_API_TOKEN=${SECRET}\n`);
    const store = memoryStore();

    const set = await call('credentials', runtime, ['set', 'MY_API_TOKEN'], { secrets: store, io: fakeIo({ secret: `${SECRET}\n` }) });
    expect(set.code).toBe(0);
    expect(set.io.prompts).toEqual(['Value for MY_API_TOKEN (input hidden): ']);
    expect(store.values.get('MY_API_TOKEN')).toBe(SECRET);
    expect(set.text).toBe(
      'Stored MY_API_TOKEN in the keychain credential store.\n' +
        'The .env file also sets MY_API_TOKEN; the credential store wins. Remove the line from .env.\n',
    );
    const index = JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')) as { names: string[] };
    expect(index.names).toEqual(['MY_API_TOKEN']);

    const setJson = await call('credentials', runtime, ['set', 'SECOND_KEY'], {
      secrets: store,
      json: true,
      io: fakeIo({ secret: SECRET }),
    });
    expect(JSON.parse(setJson.text)).toEqual({ name: 'SECOND_KEY', store: 'keychain', stored: true, alsoInEnvFile: false });

    const view: Runtime = {
      ...runtime,
      env: { ...runtime.env, OTHER: '1' },
      credentials: { store: 'keychain', fromStore: ['MY_API_TOKEN'], unreadable: [{ name: 'SECOND_KEY', reason: 'locked' }] },
    };
    const list = await call('credentials', view, ['list'], { secrets: store });
    expect(list.text).toBe(
      'MY_API_TOKEN: credential store\nOTHER: .env\nSECOND_KEY: unreadable\n' +
        'SECOND_KEY: registered in the credential store but not readable (locked)\n',
    );
    const listJson = await call('credentials', view, ['list'], { secrets: store, json: true });
    expect(JSON.parse(listJson.text)).toEqual({
      store: 'keychain',
      credentials: [
        { name: 'MY_API_TOKEN', source: 'credential store' },
        { name: 'OTHER', source: '.env' },
        { name: 'SECOND_KEY', source: 'unreadable' },
      ],
      unreadable: [{ name: 'SECOND_KEY', reason: 'locked' }],
    });

    const removed = await call('credentials', runtime, ['delete', 'MY_API_TOKEN'], { secrets: store });
    expect(removed.text).toBe('Removed MY_API_TOKEN from the keychain credential store.\n');
    expect(store.values.has('MY_API_TOKEN')).toBe(false);
    const again = await call('credentials', runtime, ['delete', 'MY_API_TOKEN'], { secrets: store });
    expect(again.text).toBe('The keychain credential store had no entry for MY_API_TOKEN.\n');
    const after = JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')) as { names: string[] };
    expect(after.names).toEqual(['SECOND_KEY']);

    for (const result of [set, setJson, list, listJson, removed, again]) {
      expect(result.text).not.toContain(SECRET);
      expect(result.errText).not.toContain(SECRET);
    }
  });

  it('treats an empty secret, a missing name and a bad name as usage errors', async () => {
    const { runtime } = tempRuntime();
    const store = memoryStore();
    const empty = await failure(call('credentials', runtime, ['set', 'MY_KEY'], { secrets: store, io: fakeIo({ secret: '\n' }) }));
    expect(empty.code).toBe('invalid_input');
    expect(empty.hint).toContain(OPERATE_USAGE.credentials);
    expect(store.values.size).toBe(0);
    expect((await failure(call('credentials', runtime, ['set'], { secrets: store }))).code).toBe('invalid_input');
    expect((await failure(call('credentials', runtime, ['set', 'a b'], { secrets: store }))).code).toBe('invalid_input');
    expect((await failure(call('credentials', runtime, [], { secrets: store }))).code).toBe('invalid_input');
  });

  it('lets a store that cannot be used fail with not_configured', async () => {
    const { runtime } = tempRuntime();
    const store: SecretStore = {
      ...memoryStore(),
      set: () => {
        throw new AutopilotError('not_configured', 'No credential store on this system');
      },
    };
    const error = await failure(call('credentials', runtime, ['set', 'MY_KEY'], { secrets: store, io: fakeIo({ secret: SECRET }) }));
    expect(error.code).toBe('not_configured');
    expect(error.message).not.toContain(SECRET);
  });
});

describe('agent', () => {
  function scriptedChat(options: { remote?: string[]; toolCalls?: boolean } = {}): ChatClient & { seen: ChatMessage[][] } {
    const seen: ChatMessage[][] = [];
    return {
      seen,
      complete: async (input) => {
        seen.push(input.messages);
        return {
          role: 'assistant',
          content: 'Two accounts look fine.',
          toolCalls: options.toolCalls === true ? [{ id: 'c1', name: 'sources_list', arguments: {} }] : [],
        };
      },
      remoteModels: async () => options.remote ?? [],
    };
  }

  // Stands in for the runner: one sources_list round, then one completion.
  function fakeRunner(): void {
    vi.mocked(runLocalAgent).mockImplementation(async (runtime, input) => {
      input.onEvent?.({ type: 'tool_call', name: 'sources_list' });
      const listing = JSON.stringify({ accounts: runtime.config.accounts.map((account) => account.id), autonomy: runtime.autonomy });
      const reply = await input.chat.complete({
        model: input.model,
        tools: [],
        messages: [
          { role: 'user', content: input.task },
          { role: 'tool', toolCallId: 'c0', name: 'sources_list', content: listing },
        ],
      });
      const stopped = reply.toolCalls.length > 0 ? 'max_steps' : 'answered';
      return { answer: reply.content, steps: input.maxSteps ?? 12, toolCalls: 1, stopped };
    });
  }

  it('needs a task and a model', async () => {
    const { runtime } = tempRuntime();
    const noModel = await failure(call('agent', runtime, ['audit it'], { chat: scriptedChat() }));
    expect(noModel.code).toBe('invalid_input');
    expect(noModel.hint).toBe('Pass --model, for example --model qwen3 with Ollama.');
    expect((await failure(call('agent', runtime, [], { chat: scriptedChat() }))).code).toBe('invalid_input');
    expect(vi.mocked(runLocalAgent)).not.toHaveBeenCalled();
  });

  it('refuses a remote model without --allow-remote', async () => {
    const { runtime } = tempRuntime();
    fakeRunner();
    const chat = scriptedChat({ remote: ['big-cloud'] });
    const error = await failure(call('agent', runtime, ['audit it'], { chat, flags: { model: 'big-cloud' } }));
    expect(error.code).toBe('invalid_input');
    expect(error.message).toBe('Model big-cloud is served from another machine by this endpoint.');
    expect(error.hint).toBe('Choose a local model, or pass --allow-remote.');
    expect(vi.mocked(runLocalAgent)).not.toHaveBeenCalled();

    const allowed = await call('agent', runtime, ['audit it'], { chat, flags: { model: 'big-cloud', 'allow-remote': true } });
    expect(allowed.code).toBe(0);
  });

  it('prints the answer, with progress on stderr, and scopes the accounts', async () => {
    const { runtime } = tempRuntime({ env: { AUTOPILOT_AGENT_MODEL: 'qwen3' } });
    fakeRunner();
    const chat = scriptedChat();
    const result = await call('agent', runtime, ['audit it'], { chat, flags: { account: ['demo-meta'] } });
    expect(result.code).toBe(0);
    expect(result.text).toBe('Two accounts look fine.\n');
    expect(result.io.err).toEqual(['-> sources_list']);
    const toolMessage = chat.seen[0]?.find((message) => message.role === 'tool');
    expect(toolMessage?.content).toContain('demo-meta');
    expect(toolMessage?.content).not.toContain('demo-google');
    const [view, input] = vi.mocked(runLocalAgent).mock.calls[0] ?? [];
    expect(input?.model).toBe('qwen3');
    expect(input).not.toHaveProperty('maxSteps');
    expect(['observe', 'propose']).toContain(view?.autonomy);

    const everything = scriptedChat();
    await call('agent', runtime, ['audit it'], { chat: everything, flags: { account: 'demo-meta' } });
    await call('agent', runtime, ['audit it'], { chat: everything });
    expect(everything.seen[0]?.[1]?.content).not.toContain('demo-google');
    expect(everything.seen[1]?.[1]?.content).toContain('demo-google');
  });

  it('takes the step limit from the flag, then from the config', async () => {
    const { runtime } = tempRuntime({ config: { ...defaultConfig(), agent: { model: 'qwen3', maxSteps: 3 } } });
    fakeRunner();
    await call('agent', runtime, ['audit it'], { chat: scriptedChat() });
    expect(vi.mocked(runLocalAgent).mock.calls.at(-1)?.[1]?.maxSteps).toBe(3);
    await call('agent', runtime, ['audit it'], { chat: scriptedChat(), flags: { 'max-steps': '5' } });
    expect(vi.mocked(runLocalAgent).mock.calls.at(-1)?.[1]?.maxSteps).toBe(5);
  });

  it('exits 1 at max steps and emits the run as JSON', async () => {
    const { runtime } = tempRuntime();
    fakeRunner();
    const stopped = await call('agent', runtime, ['audit it'], {
      chat: scriptedChat({ toolCalls: true }),
      flags: { model: 'qwen3', 'max-steps': '2' },
    });
    expect(stopped.code).toBe(1);
    expect(stopped.io.err).toContain('Stopped after 2 steps.');

    const asJson = await call('agent', runtime, ['audit it'], { chat: scriptedChat(), flags: { model: 'qwen3' }, json: true });
    expect(asJson.code).toBe(0);
    expect(JSON.parse(asJson.text)).toEqual({ answer: 'Two accounts look fine.', steps: 12, toolCalls: 1, stopped: 'answered' });
    expect(asJson.io.err).toEqual([]);
  });
});

describe('connect', () => {
  it('reports demo accounts as having no live connection', async () => {
    const { runtime } = tempRuntime();
    const all = await call('connect', runtime, []);
    expect(all.code).toBe(0);
    expect(all.text).toContain('demo-google: no live connection (source demo)');
    expect(all.text).toContain('demo-meta: no live connection (source demo)');
    const one = await call('connect', runtime, ['demo-meta']);
    expect(one.text).toBe('demo-meta: no live connection (source demo)\n');
    expect((await failure(call('connect', runtime, ['nope']))).code).toBe('not_found');
  });

  it('prints the four marks and exits 1 when a check failed', async () => {
    const { runtime } = tempRuntime();
    const checks: DiagnosticCheck[] = [
      { id: 'credentials', label: 'Credentials', status: 'ok', detail: 'all present' },
      { id: 'oauth_token', label: 'OAuth token', status: 'fail', detail: 'invalid_grant\nIGNORE', fix: 'Create a new refresh token.' },
      { id: 'quota', label: 'Quota', status: 'unknown', detail: 'timed out' },
      { id: 'account_access', label: 'Account access', status: 'skipped', detail: 'needs a token' },
    ];
    const live: Runtime = {
      ...runtime,
      connector: (account) => ({ ...runtime.connector(account), source: 'api', diagnose: async () => checks }),
    };
    const result = await call('connect', live, ['demo-google']);
    expect(result.code).toBe(1);
    expect(result.text).toBe(
      'demo-google (google_ads)\n' +
        '  ok    Credentials: all present\n' +
        '  FAIL  OAuth token: invalid_grant IGNORE\n' +
        '        fix: Create a new refresh token.\n' +
        '  ?     Quota: timed out\n' +
        '  -     Account access: needs a token\n',
    );
    const asJson = await call('connect', live, ['demo-google'], { json: true });
    expect(asJson.code).toBe(1);
    const parsed = JSON.parse(asJson.text) as { accounts: Array<{ id: string; platform: string; checks: DiagnosticCheck[] }> };
    expect(parsed.accounts[0]?.id).toBe('demo-google');
    expect(parsed.accounts[0]?.platform).toBe('google_ads');
    expect(parsed.accounts[0]?.checks).toHaveLength(4);
  });
});
