import { describe, expect, it, vi } from 'vitest';
import { createHttpClient } from '../../src/connectors/http';
import { AutopilotError } from '../../src/core/errors';

interface Call {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string | undefined;
}

type Reply = Response | Error | ((signal: AbortSignal | undefined) => Promise<Response>);

function harness(replies: Reply[]) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (reply === undefined) throw new Error('no reply configured');
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'function') return reply(init?.signal ?? undefined);
    return reply.clone();
  });
  const sleep = async (ms: number): Promise<void> => {
    sleeps.push(ms);
  };
  return { calls, sleeps, fetch: fakeFetch as unknown as typeof fetch, sleep };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

async function failure(promise: Promise<unknown>): Promise<AutopilotError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AutopilotError);
    return error as AutopilotError;
  }
  throw new Error('expected the request to throw');
}

describe('createHttpClient', () => {
  it('builds the query string and skips undefined entries', async () => {
    const h = harness([json({ ok: true })]);
    const http = createHttpClient({ fetch: h.fetch, sleep: h.sleep });
    await http.request({ url: 'https://api.test/v1/items?a=1', query: { b: 'x y', c: 2, d: true, e: undefined } });
    expect(h.calls[0]?.url).toBe('https://api.test/v1/items?a=1&b=x+y&c=2&d=true');
    expect(h.calls[0]?.method).toBe('GET');
    expect(h.calls[0]?.body).toBeUndefined();
  });

  it('sends a JSON body as POST by default', async () => {
    const h = harness([json({ id: 1 })]);
    const http = createHttpClient({ fetch: h.fetch, sleep: h.sleep });
    await http.request({ url: 'https://api.test/v1/items', json: { name: 'a' }, headers: { Authorization: 'Bearer t' } });
    expect(h.calls[0]?.method).toBe('POST');
    expect(h.calls[0]?.headers['Content-Type']).toBe('application/json');
    expect(h.calls[0]?.headers['Authorization']).toBe('Bearer t');
    expect(h.calls[0]?.body).toBe('{"name":"a"}');
  });

  it('sends a form body and honours an explicit method', async () => {
    const h = harness([json({})]);
    const http = createHttpClient({ fetch: h.fetch, sleep: h.sleep });
    await http.request({ url: 'https://api.test/token', method: 'PUT', form: { grant_type: 'refresh', scope: 'a b' } });
    expect(h.calls[0]?.method).toBe('PUT');
    expect(h.calls[0]?.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(h.calls[0]?.body).toBe('grant_type=refresh&scope=a+b');
  });

  it('parses JSON responses and lower-cases headers', async () => {
    const h = harness([json({ a: [1, 2] }, 200, { 'X-Request-Id': 'r1' })]);
    const http = createHttpClient({ fetch: h.fetch, sleep: h.sleep });
    const res = await http.request({ url: 'https://api.test/x' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ a: [1, 2] });
    expect(res.headers['x-request-id']).toBe('r1');
    expect(res.headers['content-type']).toContain('json');
  });

  it('returns null for an empty JSON body and text for other content types', async () => {
    const empty = harness([new Response('', { status: 200, headers: { 'Content-Type': 'application/json' } })]);
    const a = await createHttpClient({ fetch: empty.fetch }).request({ url: 'https://api.test/x' });
    expect(a.body).toBeNull();

    const text = harness([new Response('a,b\n1,2', { status: 200, headers: { 'Content-Type': 'text/csv' } })]);
    const b = await createHttpClient({ fetch: text.fetch }).request<string>({ url: 'https://api.test/x' });
    expect(b.body).toBe('a,b\n1,2');
  });

  it('does not retry a 404 and marks it not retryable', async () => {
    const h = harness([json({ error: 'missing' }, 404)]);
    const http = createHttpClient({ fetch: h.fetch, sleep: h.sleep });
    const error = await failure(http.request({ url: 'https://api.test/v1/x' }));
    expect(error.code).toBe('platform_error');
    expect(error.retryable).toBe(false);
    expect(error.message).toBe('GET https://api.test/v1/x -> 404: {"error":"missing"}');
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it('retries a 500 for GET with backoff, then throws retryable', async () => {
    const h = harness([new Response('boom', { status: 500 })]);
    const http = createHttpClient({ fetch: h.fetch, sleep: h.sleep });
    const error = await failure(http.request({ url: 'https://api.test/v1/x' }));
    expect(error.code).toBe('platform_error');
    expect(error.retryable).toBe(true);
    expect(h.calls).toHaveLength(4);
    expect(h.sleeps).toEqual([500, 1000, 2000]);
  });

  it('caps backoff at 8 seconds and respects maxAttempts', async () => {
    const h = harness([new Response('boom', { status: 503 })]);
    const http = createHttpClient({ fetch: h.fetch, sleep: h.sleep, maxAttempts: 7 });
    await failure(http.request({ url: 'https://api.test/v1/x' }));
    expect(h.calls).toHaveLength(7);
    expect(h.sleeps).toEqual([500, 1000, 2000, 4000, 8000, 8000]);
  });

  it('recovers when a retry succeeds', async () => {
    const h = harness([new Response('boom', { status: 502 }), new TypeError('fetch failed'), json({ ok: 1 })]);
    const http = createHttpClient({ fetch: h.fetch, sleep: h.sleep });
    const res = await http.request({ url: 'https://api.test/v1/x' });
    expect(res.body).toEqual({ ok: 1 });
    expect(h.calls).toHaveLength(3);
  });

  it('sends a POST exactly once by default, and retries it only when asked', async () => {
    const h = harness([new Response('boom', { status: 500 })]);
    const http = createHttpClient({ fetch: h.fetch, sleep: h.sleep });
    const error = await failure(http.request({ url: 'https://api.test/v1/x', json: { a: 1 } }));
    expect(error.retryable).toBe(true);
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);

    const opted = harness([new Response('boom', { status: 500 })]);
    await failure(
      createHttpClient({ fetch: opted.fetch, sleep: opted.sleep }).request({
        url: 'https://api.test/v1/x',
        json: { a: 1 },
        retry: true,
      }),
    );
    expect(opted.calls).toHaveLength(4);

    const getOnce = harness([new Response('boom', { status: 500 })]);
    await failure(
      createHttpClient({ fetch: getOnce.fetch, sleep: getOnce.sleep }).request({ url: 'https://api.test/v1/x', retry: false }),
    );
    expect(getOnce.calls).toHaveLength(1);
  });

  it('honours Retry-After on 429, capped at 30 seconds', async () => {
    const h = harness([
      new Response('slow down', { status: 429, headers: { 'Retry-After': '3' } }),
      new Response('slow down', { status: 429, headers: { 'Retry-After': '120' } }),
      new Response('slow down', { status: 429, headers: { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' } }),
      new Response('slow down', { status: 429 }),
    ]);
    const http = createHttpClient({ fetch: h.fetch, sleep: h.sleep });
    const error = await failure(http.request({ url: 'https://api.test/v1/x' }));
    expect(error.code).toBe('rate_limited');
    expect(error.retryable).toBe(true);
    expect(h.sleeps).toEqual([3000, 30000, 2000]);
  });

  it('reports a network error without leaking the cause text', async () => {
    const h = harness([new TypeError('connect ECONNREFUSED https://api.test/v1/x?access_token=abc')]);
    const http = createHttpClient({ fetch: h.fetch, sleep: h.sleep });
    const error = await failure(http.request({ url: 'https://api.test/v1/x', method: 'DELETE' }));
    expect(error.code).toBe('platform_error');
    expect(error.retryable).toBe(true);
    expect(error.message).toBe('DELETE https://api.test/v1/x: network error');
    expect(h.calls).toHaveLength(1);
  });

  it('times out through the abort signal', async () => {
    const hang = (signal: AbortSignal | undefined): Promise<Response> =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const h = harness([hang]);
    const http = createHttpClient({ fetch: h.fetch, sleep: h.sleep });
    const error = await failure(http.request({ url: 'https://api.test/v1/slow?x=1', timeoutMs: 5, retry: false }));
    expect(error.code).toBe('platform_error');
    expect(error.retryable).toBe(true);
    expect(error.message).toBe('GET https://api.test/v1/slow: timed out');
    expect(h.calls).toHaveLength(1);
  });

  it('redacts env secrets found in an error body', async () => {
    const h = harness([json({ error: 'bad token sk-super-secret-123 rejected' }, 401)]);
    const http = createHttpClient({ fetch: h.fetch, sleep: h.sleep, env: { META_ACCESS_TOKEN: 'sk-super-secret-123' } });
    const error = await failure(http.request({ url: 'https://api.test/v1/x' }));
    expect(error.message).not.toContain('sk-super-secret-123');
    expect(error.message).toContain('[redacted:META_ACCESS_TOKEN]');
  });

  it('never puts the query string or request headers in an error message, and truncates the body', async () => {
    const h = harness([new Response('x'.repeat(1000), { status: 400 })]);
    const http = createHttpClient({ fetch: h.fetch, sleep: h.sleep, env: {} });
    const error = await failure(
      http.request({
        url: 'https://api.test/v1/x?inline=qs-inline-value',
        query: { customer: 'qs-param-value' },
        headers: { 'X-Api': 'header-value-xyz' },
      }),
    );
    expect(h.calls[0]?.url).toContain('qs-param-value');
    expect(error.message).not.toContain('qs-inline-value');
    expect(error.message).not.toContain('qs-param-value');
    expect(error.message).not.toContain('header-value-xyz');
    expect(error.message).not.toContain('?');
    expect(error.message).toBe(`GET https://api.test/v1/x -> 400: ${'x'.repeat(300)}`);
  });

  it('redacts a secret that crosses the truncation point of an error body', async () => {
    const secret = 'plainwordsecretvalue42';
    const h = harness([new Response(`${'x'.repeat(290)}${secret} trailing text`, { status: 400 })]);
    const http = createHttpClient({ fetch: h.fetch, sleep: h.sleep, env: { META_ACCESS_TOKEN: secret } });
    const error = await failure(http.request({ url: 'https://api.test/v1/x' }));
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain(secret.slice(0, 5));
    expect(error.message).toContain('x'.repeat(290));
    expect(error.message.length).toBeLessThanOrEqual('GET https://api.test/v1/x -> 400: '.length + 300);
  });

  it('reports an unreadable 2xx body on a POST as retryable and sends it once', async () => {
    const h = harness([new Response('{"id": 1', { status: 200, headers: { 'Content-Type': 'application/json' } })]);
    const http = createHttpClient({ fetch: h.fetch, sleep: h.sleep });
    const error = await failure(http.request({ url: 'https://api.test/v1/x?k=v', json: { a: 1 } }));
    expect(error.code).toBe('platform_error');
    expect(error.retryable).toBe(true);
    expect(error.message).toBe('POST https://api.test/v1/x returned a success status with an unreadable body');
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it('retries an unreadable 2xx body on a GET, then throws retryable', async () => {
    const h = harness([new Response('<html>', { status: 200, headers: { 'Content-Type': 'application/json' } })]);
    const http = createHttpClient({ fetch: h.fetch, sleep: h.sleep });
    const error = await failure(http.request({ url: 'https://api.test/v1/x' }));
    expect(error.code).toBe('platform_error');
    expect(error.retryable).toBe(true);
    expect(h.calls).toHaveLength(4);
    expect(h.sleeps).toEqual([500, 1000, 2000]);
  });

  it('removes the Bearer token of the request from an echoed error body', async () => {
    const token = 'ya29.runtime-issued-token';
    const h = harness([new Response(`Invalid token ${token} (Authorization: Bearer ${token})`, { status: 401 })]);
    const http = createHttpClient({ fetch: h.fetch, sleep: h.sleep, env: {} });
    const error = await failure(
      http.request({ url: 'https://api.test/v1/x', headers: { authorization: `Bearer ${token}` } }),
    );
    expect(error.message).not.toContain(token);
    expect(String(error.body)).not.toContain(token);
    expect(error.message).toContain('Invalid token [redacted]');
    expect(h.calls[0]?.headers['authorization']).toBe(`Bearer ${token}`);
  });

  it('removes an access_token query value from an echoed error body', async () => {
    const inline = 'inline-token-value';
    const param = 'param token/value';
    const h = harness([new Response(`bad ${inline} and ${param} and ${encodeURIComponent(param)}`, { status: 401 })]);
    const http = createHttpClient({ fetch: h.fetch, sleep: h.sleep, env: {} });
    const error = await failure(
      http.request({ url: `https://api.test/v1/x?access_token=${inline}`, query: { token: param } }),
    );
    for (const text of [error.message, String(error.body)]) {
      expect(text).not.toContain(inline);
      expect(text).not.toContain(param);
      expect(text).not.toContain(encodeURIComponent(param));
    }
    expect(error.message).toBe('GET https://api.test/v1/x -> 401: bad [redacted] and [redacted] and [redacted]');
  });

  it('removes a client_secret form field from an echoed error body', async () => {
    const secret = 'GOCSPX-form-secret';
    const h = harness([json({ error: 'invalid_client', detail: `client_secret=${secret}` }, 401)]);
    const http = createHttpClient({ fetch: h.fetch, sleep: h.sleep, env: {} });
    const error = await failure(
      http.request({ url: 'https://api.test/token', form: { grant_type: 'refresh_token', client_secret: secret } }),
    );
    expect(error.message).not.toContain(secret);
    expect(String(error.body)).not.toContain(secret);
    expect(error.message).toContain('client_secret=[redacted]');
    expect(h.calls[0]?.body).toContain(secret);
  });

  it('removes Basic credentials in encoded and decoded form', async () => {
    const password = 'mautic-pass-9';
    const encoded = Buffer.from(`admin:${password}`).toString('base64');
    const h = harness([new Response(`denied ${encoded} / admin:${password} / ${password}`, { status: 401 })]);
    const http = createHttpClient({ fetch: h.fetch, sleep: h.sleep, env: {} });
    const error = await failure(
      http.request({ url: 'https://api.test/v1/x', headers: { Authorization: `Basic ${encoded}` } }),
    );
    for (const text of [error.message, String(error.body)]) {
      expect(text).not.toContain(encoded);
      expect(text).not.toContain(password);
    }
    expect(error.message).toBe('GET https://api.test/v1/x -> 401: denied [redacted] / [redacted] / [redacted]');
  });

  it('removes a Basic password echoed in JSON-escaped form', async () => {
    const password = 'pa"ss\\word42';
    const escaped = JSON.stringify(password).slice(1, -1);
    const basic = { Authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}` };

    const asJson = harness([json({ error: { message: `bad password ${password}`, [password]: [password] } }, 401)]);
    const a = await failure(
      createHttpClient({ fetch: asJson.fetch, sleep: asJson.sleep, env: {} }).request({
        url: 'https://api.test/v1/x',
        headers: basic,
      }),
    );
    // A unicode escape decodes to the same value and matches no textual form of it.
    const unicode = harness([
      new Response(`{"error":"bad password pa\\u0022ss\\u005cword42"}`, { status: 401 }),
    ]);
    const b = await failure(
      createHttpClient({ fetch: unicode.fetch, sleep: unicode.sleep, env: {} }).request({
        url: 'https://api.test/v1/x',
        headers: basic,
      }),
    );
    // Escaped text inside a body that is not JSON.
    const asText = harness([new Response(`log: {"error":"bad ${escaped}"} (truncated`, { status: 401 })]);
    const c = await failure(
      createHttpClient({ fetch: asText.fetch, sleep: asText.sleep, env: {} }).request({
        url: 'https://api.test/v1/x',
        headers: basic,
      }),
    );

    for (const error of [a, b, c]) {
      for (const text of [error.message, String(error.body)]) {
        expect(text).not.toContain(password);
        expect(text).not.toContain(escaped);
        expect(text).not.toContain('word42');
        expect(text).toContain('[redacted]');
      }
    }
    expect(b.message).toBe('GET https://api.test/v1/x -> 401: {"error":"bad password [redacted]"}');
  });

  it('removes a credential shorter than 6 characters', async () => {
    const encoded = Buffer.from('admin:abcde').toString('base64');
    const h = harness([new Response('value abcde is not valid', { status: 400 })]);
    const http = createHttpClient({ fetch: h.fetch, sleep: h.sleep, env: {} });
    const error = await failure(
      http.request({ url: 'https://api.test/v1/x', headers: { Authorization: `Basic ${encoded}` } }),
    );
    expect(error.message).toBe('GET https://api.test/v1/x -> 400: value [redacted] is not valid');
    expect(error.body).toBe('value [redacted] is not valid');
  });

  it('withholds the response text when a credential is too short to remove by value', async () => {
    const withheld = '[response withheld: it may contain a credential that is too short to remove safely]';
    const encoded = Buffer.from('admin:pw').toString('base64');
    const h = harness([json({ error: 'password pw rejected' }, 401)]);
    const http = createHttpClient({ fetch: h.fetch, sleep: h.sleep, env: {} });
    const error = await failure(
      http.request({ url: 'https://api.test/v1/x', headers: { Authorization: `Basic ${encoded}` } }),
    );
    expect(error.message).toBe(`GET https://api.test/v1/x -> 401: ${withheld}`);
    expect(error.body).toBe(withheld);
    expect(error.status).toBe(401);
  });

  it('leaves a response without a credential echo as it was sent', async () => {
    const pretty = '{\n  "error": "missing",\n  "n": 1.0\n}';
    const h = harness([new Response(pretty, { status: 404 })]);
    const http = createHttpClient({ fetch: h.fetch, sleep: h.sleep, env: {} });
    const error = await failure(
      http.request({ url: 'https://api.test/v1/x', headers: { Authorization: 'Bearer ya29.runtime-issued-token' } }),
    );
    expect(error.message).toBe(`GET https://api.test/v1/x -> 404: ${pretty}`);
    expect(error.body).toBe(pretty);
  });

  it('does not alter a successful response that echoes a credential', async () => {
    const token = 'ya29.runtime-issued-token';
    const h = harness([json({ access_token: token })]);
    const http = createHttpClient({ fetch: h.fetch, sleep: h.sleep, env: {} });
    const res = await http.request({ url: 'https://api.test/token', form: { code: token } });
    expect(res.body).toEqual({ access_token: token });
  });

  it('rejects a URL that is not absolute', async () => {
    const h = harness([json({})]);
    const error = await failure(createHttpClient({ fetch: h.fetch }).request({ url: '/relative' }));
    expect(error.code).toBe('invalid_input');
    expect(h.calls).toHaveLength(0);
  });
});
