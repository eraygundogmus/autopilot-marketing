import { describe, expect, it } from 'vitest';
import { createChatClient, isLoopbackUrl } from '../../src/agent/chat';
import type { ChatMessage } from '../../src/agent/chat';
import { AutopilotError } from '../../src/core/errors';

interface Recorded {
  url: string;
  init: RequestInit;
}

function fakeFetch(reply: (url: string) => Response | Promise<Response>): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    return reply(url);
  };
  return { fetch: fn as typeof fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function replyWith(message: unknown): Response {
  return json({ choices: [{ message }] });
}

function bodyOf(call: Recorded | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.init.body)) as Record<string, unknown>;
}

function headersOf(call: Recorded | undefined): Record<string, string> {
  return (call?.init.headers ?? {}) as Record<string, string>;
}

async function failure(promise: Promise<unknown>): Promise<AutopilotError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AutopilotError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

const BASE = 'http://127.0.0.1:11434/v1';
const ASK: ChatMessage[] = [{ role: 'user', content: 'hi' }];

describe('isLoopbackUrl', () => {
  it.each([
    'http://127.0.0.1:11434/v1',
    'https://127.8.9.1/v1',
    'http://[::1]:8080/v1',
  ])('accepts %s', (url) => {
    expect(isLoopbackUrl(url)).toBe(true);
  });

  it.each([
    'http://0.0.0.0:11434/v1',
    'http://[::]:11434/v1',
    'http://10.0.0.1/v1',
    'https://example.com/v1',
    'http://localhost:11434/v1',
    'http://foo.localhost/v1',
    'http://[::ffff:127.0.0.1]/v1',
    'http://user:pw@127.0.0.1/v1',
    'ftp://127.0.0.1/v1',
    'http://localhost.example.com/v1',
    'not a url',
  ])('rejects %s', (url) => {
    expect(isLoopbackUrl(url)).toBe(false);
  });
});

describe('createChatClient', () => {
  it('refuses a remote base URL unless allowRemote is set', () => {
    let caught: unknown;
    try {
      createChatClient({ baseUrl: 'https://example.com/v1' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AutopilotError);
    expect((caught as AutopilotError).code).toBe('invalid_input');
    expect((caught as AutopilotError).hint).toBe(
      'The local runner sends account data to this endpoint. Pass --allow-remote only for an endpoint you trust.',
    );
    expect(() => createChatClient({ baseUrl: 'https://example.com/v1', allowRemote: true })).not.toThrow();
  });

  it('sends a conversation with a tool round trip in the OpenAI shape', async () => {
    const { fetch, calls } = fakeFetch(() => replyWith({ role: 'assistant', content: 'done' }));
    const client = createChatClient({ baseUrl: `${BASE}/`, fetch });
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'audit' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'audit_run', arguments: { snapshotId: 's1' } }] },
      { role: 'tool', toolCallId: 'c1', name: 'audit_run', content: '{"score":80}' },
      { role: 'assistant', content: 'thinking', toolCalls: [] },
    ];
    const tools = [{ name: 'audit_run', description: 'Run the audit', parameters: { type: 'object' } }];
    const result = await client.complete({ model: 'qwen3', messages, tools });

    expect(result).toEqual({ role: 'assistant', content: 'done', toolCalls: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/chat/completions`);
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.redirect).toBe('error');
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    const body = bodyOf(calls[0]);
    expect(body).not.toHaveProperty('tool_choice');
    expect(body['stream']).toBe(false);
    expect(body['model']).toBe('qwen3');
    expect(body['tools']).toEqual([
      { type: 'function', function: { name: 'audit_run', description: 'Run the audit', parameters: { type: 'object' } } },
    ]);
    expect(body['messages']).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'audit' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'audit_run', arguments: '{"snapshotId":"s1"}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', name: 'audit_run', content: '{"score":80}' },
      { role: 'assistant', content: 'thinking' },
    ]);
  });

  it('omits tools when the list is empty', async () => {
    const { fetch, calls } = fakeFetch(() => replyWith({ content: 'ok' }));
    await createChatClient({ baseUrl: BASE, fetch }).complete({ model: 'm', messages: ASK, tools: [] });
    expect(bodyOf(calls[0])).not.toHaveProperty('tools');
  });

  it('parses string, object, invalid and id-less tool calls, and null content', async () => {
    const { fetch } = fakeFetch(() =>
      replyWith({
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'one', arguments: '{"x":1}' } },
          { id: 'b', type: 'function', function: { name: 'two', arguments: { y: [2] } } },
          { id: 'c', type: 'function', function: { name: 'three', arguments: '{not json' } },
          { type: 'function', function: { name: 'four', arguments: '[1]' } },
          { id: '', type: 'function', function: { name: 'five' } },
        ],
      }),
    );
    const result = await createChatClient({ baseUrl: BASE, fetch }).complete({ model: 'm', messages: ASK, tools: [] });
    expect(result.content).toBe('');
    expect(result.toolCalls[0]).toEqual({ id: 'a', name: 'one', arguments: { x: 1 } });
    expect(result.toolCalls[1]).toEqual({ id: 'b', name: 'two', arguments: { y: [2] } });
    expect(result.toolCalls[2]?.id).toBe('c');
    expect(result.toolCalls[2]?.arguments).toEqual({});
    expect(result.toolCalls[2]?.argumentsError).toBeTypeOf('string');
    expect(result.toolCalls[2]?.argumentsError).not.toContain('not json');
    expect(result.toolCalls[3]?.id).toBe('call_3');
    expect(result.toolCalls[3]?.argumentsError).toBeTypeOf('string');
    expect(result.toolCalls[4]).toEqual({ id: 'call_4', name: 'five', arguments: {} });
  });

  it('treats a tool call without a function name as a malformed reply', async () => {
    const { fetch } = fakeFetch(() => replyWith({ content: '', tool_calls: [{ id: 'a', function: { name: '' } }] }));
    const error = await failure(
      createChatClient({ baseUrl: BASE, fetch }).complete({ model: 'm', messages: ASK, tools: [] }),
    );
    expect(error.code).toBe('platform_error');
  });

  it('sends Authorization only with an apiKey', async () => {
    const without = fakeFetch(() => replyWith({ content: 'ok' }));
    await createChatClient({ baseUrl: BASE, fetch: without.fetch }).complete({ model: 'm', messages: ASK, tools: [] });
    expect(headersOf(without.calls[0])).not.toHaveProperty('Authorization');

    const withKey = fakeFetch(() => replyWith({ content: 'ok' }));
    await createChatClient({ baseUrl: BASE, apiKey: 'k-1', fetch: withKey.fetch }).complete({
      model: 'm',
      messages: ASK,
      tools: [],
    });
    expect(headersOf(withKey.calls[0])['Authorization']).toBe('Bearer k-1');
  });

  it('reports a 500 with a redacted, bounded body', async () => {
    const { fetch } = fakeFetch(
      () => new Response(`boom Authorization: Bearer abc123456 ${'x'.repeat(1000)}`, { status: 500 }),
    );
    const error = await failure(
      createChatClient({ baseUrl: BASE, fetch }).complete({ model: 'm', messages: ASK, tools: [] }),
    );
    expect(error.code).toBe('platform_error');
    expect(error.message).toContain('500');
    expect(error.message).not.toContain('abc123456');
    expect(error.message.length).toBeLessThan(400);
  });

  it('throws on missing choices and on unreadable JSON', async () => {
    const missing = fakeFetch(() => json({ choices: [] }));
    const first = await failure(
      createChatClient({ baseUrl: BASE, fetch: missing.fetch }).complete({ model: 'm', messages: ASK, tools: [] }),
    );
    expect(first.code).toBe('platform_error');

    const unreadable = fakeFetch(() => new Response('<html>', { status: 200 }));
    const second = await failure(
      createChatClient({ baseUrl: BASE, fetch: unreadable.fetch }).complete({ model: 'm', messages: ASK, tools: [] }),
    );
    expect(second.code).toBe('platform_error');
    expect(second.message).toContain('200');
  });

  it('maps a rejected fetch to platform_error with the server hint', async () => {
    const { fetch } = fakeFetch(() => Promise.reject(new TypeError('fetch failed')));
    const error = await failure(
      createChatClient({ baseUrl: BASE, fetch }).complete({ model: 'm', messages: ASK, tools: [] }),
    );
    expect(error.code).toBe('platform_error');
    expect(error.hint).toBe('Is the model server running? For Ollama: ollama serve');
  });

  it('lists only models with a remote_host', async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({
        models: [
          { name: 'local:7b' },
          { name: 'cloud:120b', remote_host: 'https://ollama.com:443' },
          { name: 'empty', remote_host: '' },
          'junk',
        ],
      }),
    );
    const names = await createChatClient({ baseUrl: BASE, fetch }).remoteModels();
    expect(names).toEqual(['cloud:120b']);
    expect(calls[0]?.url).toBe('http://127.0.0.1:11434/api/tags');
  });

  it('returns no remote models on a 404, a thrown fetch and an unexpected shape', async () => {
    const notFound = fakeFetch(() => new Response('nope', { status: 404 }));
    expect(await createChatClient({ baseUrl: BASE, fetch: notFound.fetch }).remoteModels()).toEqual([]);
    const thrown = fakeFetch(() => Promise.reject(new Error('down')));
    expect(await createChatClient({ baseUrl: BASE, fetch: thrown.fetch }).remoteModels()).toEqual([]);
    const odd = fakeFetch(() => json({ models: 'none' }));
    expect(await createChatClient({ baseUrl: BASE, fetch: odd.fetch }).remoteModels()).toEqual([]);
  });
});

describe('the endpoint key in error text', () => {
  // The key can come from the .env file or the credential store, so it is not in process.env.
  const key = 'k-endpoint-key-not-in-process-env';

  it('never repeats the key an endpoint echoes back, in a failed or a malformed reply', async () => {
    const reply = (status: number, body: string) =>
      (async () => new Response(body, { status, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    const failed = createChatClient({ baseUrl: BASE, apiKey: key, fetch: reply(401, `{"error":"Invalid token ${key}"}`) });
    const failure = await failed.complete({ model: 'm', messages: ASK, tools: [] }).catch((error: unknown) => error);
    expect(String((failure as Error).message)).toContain('401');
    expect(String((failure as Error).message)).not.toContain(key);

    const malformed = createChatClient({ baseUrl: BASE, apiKey: key, fetch: reply(200, `{"note":"${key}"}`) });
    const bad = await malformed.complete({ model: 'm', messages: ASK, tools: [] }).catch((error: unknown) => error);
    expect(String((bad as Error).message)).toContain('Malformed');
    expect(String((bad as Error).message)).not.toContain(key);

    const unreadable = createChatClient({ baseUrl: BASE, apiKey: key, fetch: reply(200, `not json ${key}`) });
    const garbled = await unreadable.complete({ model: 'm', messages: ASK, tools: [] }).catch((error: unknown) => error);
    expect(String((garbled as Error).message)).not.toContain(key);
  });
});
