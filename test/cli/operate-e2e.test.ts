import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config';
import type { AutopilotConfig } from '../../src/core/types';
import type { CommandContext } from '../../src/cli/commands';
import { operateCommands } from '../../src/cli/operate';
import { tempRuntime } from '../helpers/runtime';

// Nothing is mocked here: the real scheduler, the real runner loop, the real MCP server, and a
// model endpoint that speaks HTTP on the loopback interface.

function context(runtime: CommandContext['runtime'], args: string[], flags: CommandContext['flags'] = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CommandContext = {
    runtime,
    args,
    flags,
    json: flags.json === true,
    io: {
      stdout: (text) => void out.push(text),
      stderr: (text) => void err.push(text),
      stdin: {},
      confirm: async () => false,
      readSecret: async () => '',
    },
  };
  return { ctx, out, err };
}

async function run(name: string, ctx: CommandContext): Promise<number> {
  const handler = operateCommands[name];
  if (handler === undefined) throw new Error(`no command ${name}`);
  return handler(ctx);
}

interface Recorded {
  path: string;
  body: { model?: string; messages?: Array<{ role: string; content?: string }>; tools?: unknown[]; tool_choice?: unknown };
}

/** A model server that replies with the scripted assistant messages, in order. */
async function modelServer(replies: unknown[]): Promise<{ baseUrl: string; requests: Recorded[]; close: () => Promise<void> }> {
  const requests: Recorded[] = [];
  let next = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.url === '/api/tags') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ models: [{ name: 'local-model' }, { name: 'cloud-model', remote_host: 'https://example.com' }] }));
        return;
      }
      requests.push({ path: request.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Recorded['body'] });
      const message = replies[Math.min(next, replies.length - 1)];
      next += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

function scheduled(): AutopilotConfig {
  return {
    ...defaultConfig(),
    schedules: [{ id: 'daily-google', accountId: 'demo-google', task: 'audit', every: '1d' }],
  };
}

describe('schedule run, end to end', () => {
  it('runs the due audit once, reports attention with exit code 3, and lists the run', async () => {
    let clock = new Date('2026-10-04T10:00:00Z');
    const { runtime } = tempRuntime({ config: scheduled(), now: () => clock });

    const first = context(runtime, ['run'], { json: true });
    expect(await run('schedule', first.ctx)).toBe(3);
    const pass = JSON.parse(first.out.join('')) as { enqueued: string[]; ran: Array<{ state: string; attention: string[]; result: { auditId: string } }> };
    expect(pass.enqueued).toHaveLength(1);
    expect(pass.ran).toHaveLength(1);
    expect(pass.ran[0]?.state).toBe('succeeded');
    expect(pass.ran[0]?.attention.length).toBeGreaterThan(0);
    expect(runtime.store.getAudit(pass.ran[0]!.result.auditId).accountId).toBe('demo-google');

    // The same slot again: nothing to do.
    const second = context(runtime, ['run'], { json: true });
    expect(await run('schedule', second.ctx)).toBe(0);
    expect((JSON.parse(second.out.join('')) as { ran: unknown[] }).ran).toEqual([]);

    // The next day: the same findings as before are not news.
    clock = new Date('2026-10-05T10:00:00Z');
    const third = context(runtime, ['run'], { json: true });
    expect(await run('schedule', third.ctx)).toBe(0);
    const later = JSON.parse(third.out.join('')) as { ran: Array<{ state: string; attention: string[] }> };
    expect(later.ran[0]?.state).toBe('succeeded');
    expect(later.ran[0]?.attention).toEqual([]);

    const listing = context(runtime, []);
    expect(await run('jobs', listing.ctx)).toBe(0);
    expect(listing.out.join('\n')).toContain('demo-google');
    expect(listing.out.join('\n')).toContain('succeeded');
  });
});

describe('agent, end to end over HTTP', () => {
  it('lets a local model call the tools and prints its answer', async () => {
    const model = await modelServer([
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'sources_list', arguments: '{}' } }] },
      { role: 'assistant', content: 'There is one account in scope: demo-meta.' },
    ]);
    closers.push(model.close);
    const { runtime } = tempRuntime({ now: () => new Date('2026-10-04T10:00:00Z') });

    const { ctx, out } = context(runtime, ['Which accounts can you see?'], {
      model: 'local-model',
      'base-url': model.baseUrl,
      account: 'demo-meta',
    });
    expect(await run('agent', ctx)).toBe(0);
    expect(out.join('\n')).toContain('There is one account in scope: demo-meta.');

    expect(model.requests).toHaveLength(2);
    const [first, second] = model.requests;
    expect(first?.path).toBe('/v1/chat/completions');
    expect(first?.body.model).toBe('local-model');
    expect(first?.body.tool_choice).toBeUndefined();
    expect((first?.body.tools ?? []).length).toBe(15);
    const toolMessage = second?.body.messages?.find((message) => message.role === 'tool');
    expect(toolMessage?.content).toContain('demo-meta');
    // The account outside the scope does not exist for the model.
    expect(toolMessage?.content).not.toContain('demo-google');
  });

  it('refuses a model the endpoint serves from another machine', async () => {
    const model = await modelServer([{ role: 'assistant', content: 'never asked' }]);
    closers.push(model.close);
    const { runtime } = tempRuntime();
    const { ctx } = context(runtime, ['hello'], { model: 'cloud-model', 'base-url': model.baseUrl });
    await expect(run('agent', ctx)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(model.requests).toHaveLength(0);
  });

  it('refuses an endpoint that is not on this machine', async () => {
    const { runtime } = tempRuntime();
    const { ctx } = context(runtime, ['hello'], { model: 'm', 'base-url': 'https://example.com/v1' });
    await expect(run('agent', ctx)).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
