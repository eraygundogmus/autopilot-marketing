import { AutopilotError } from '../core/errors';
import { redact } from '../core/redact';
import type { Env, HttpClient, HttpRequest, HttpResponse } from '../core/types';

export interface HttpOptions {
  fetch?: typeof fetch;
  /** Default 4. */
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Used to redact secrets from error messages. */
  env?: Env;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 4;
const MAX_RETRY_AFTER_MS = 30_000;
const MAX_BACKOFF_MS = 8_000;
const ERROR_BODY_CHARS = 300;
const ERROR_DETAIL_CHARS = 4000;

const MIN_SECRET_CHARS = 6;
const REDACTED = '[redacted]';
const SECRET_FIELDS = new Set([
  'access_token',
  'refresh_token',
  'client_secret',
  'password',
  'api_key',
  'key',
  'token',
  'code',
  'assertion',
]);

/**
 * The credentials one request carries, longest first so that a value containing another is replaced
 * whole. Values shorter than MIN_SECRET_CHARS are left out: they would match ordinary text.
 */
function requestSecrets(url: URL, headers: Record<string, string>, form: Record<string, string> | undefined): string[] {
  const found = new Set<string>();
  const add = (value: string): void => {
    found.add(value);
    // A platform may echo the value as it travelled on the wire.
    found.add(encodeURIComponent(value));
    found.add(new URLSearchParams({ v: value }).toString().slice(2));
  };

  for (const [name, raw] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'authorization') continue;
    const value = raw.trim();
    add(value);
    const match = /^(\S+)\s+(.+)$/.exec(value);
    if (match === null) continue;
    const scheme = match[1] ?? '';
    const credential = match[2] ?? '';
    add(credential);
    if (scheme.toLowerCase() !== 'basic') continue;
    const decoded = Buffer.from(credential, 'base64').toString('utf8');
    add(decoded);
    const colon = decoded.indexOf(':');
    if (colon >= 0) add(decoded.slice(colon + 1));
  }
  for (const [name, value] of url.searchParams) {
    if (SECRET_FIELDS.has(name.toLowerCase())) add(value);
  }
  for (const [name, value] of Object.entries(form ?? {})) {
    if (SECRET_FIELDS.has(name.toLowerCase())) add(value);
  }

  return [...found].filter((value) => value.length >= MIN_SECRET_CHARS).sort((a, b) => b.length - a.length);
}

function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join(REDACTED);
  return out;
}

interface Attempt {
  response?: HttpResponse<unknown>;
  error?: AutopilotError;
  /** Milliseconds the server asked us to wait, when it said so. */
  retryAfterMs?: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

function retryAfterMs(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

/** `attempt` is the 1-based number of the attempt that just failed. */
function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

export function createHttpClient(options: HttpOptions = {}): HttpClient {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const clean = (text: string): string => (options.env === undefined ? redact(text) : redact(text, options.env));

  async function attemptOnce(
    url: URL,
    where: string,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
    timeoutMs: number,
    secrets: readonly string[],
  ): Promise<Attempt> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const init: RequestInit = { method, headers, signal: controller.signal };
      if (body !== undefined) init.body = body;
      const res = await doFetch(url, init);
      const text = await res.text();
      const resHeaders: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        resHeaders[key.toLowerCase()] = value;
      });

      if (res.status < 200 || res.status >= 300) {
        // Redaction sees the whole body: a secret cut by truncation would no longer be recognised.
        // The request's own credentials go first: one issued at run time is not in the environment.
        const cleaned = clean(scrub(text, secrets));
        const message = `${where} -> ${res.status}: ${cleaned.slice(0, ERROR_BODY_CHARS)}`;
        const wait = retryAfterMs(resHeaders['retry-after']);
        // The message stays short; the longer body is for code that classifies the failure.
        const details = { status: res.status, body: cleaned.slice(0, ERROR_DETAIL_CHARS) };
        const error =
          res.status === 429
            ? new AutopilotError('rate_limited', message, { retryable: true, ...details })
            : new AutopilotError('platform_error', message, { retryable: res.status >= 500, ...details });
        return wait === undefined ? { error } : { error, retryAfterMs: wait };
      }

      const isJson = (resHeaders['content-type'] ?? '').toLowerCase().includes('json');
      if (!isJson) return { response: { status: res.status, headers: resHeaders, body: text } };
      if (text.trim() === '') return { response: { status: res.status, headers: resHeaders, body: null } };
      try {
        const parsed: unknown = JSON.parse(text);
        return { response: { status: res.status, headers: resHeaders, body: parsed } };
      } catch {
        // The outcome is ambiguous, not failed: the platform answered 2xx and may have applied a
        // mutation. Retryable tells the caller to reconcile by reading state.
        return {
          error: new AutopilotError('platform_error', `${where} returned a success status with an unreadable body`, {
            retryable: true,
          }),
        };
      }
    } catch (cause) {
      // The cause is kept off the message: it can carry the full URL, query string included.
      const reason = timedOut ? 'timed out' : 'network error';
      return { error: new AutopilotError('platform_error', `${where}: ${reason}`, { retryable: true, cause }) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function request<T>(req: HttpRequest): Promise<HttpResponse<T>> {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      throw new AutopilotError('invalid_input', 'HTTP request URL is not a valid absolute URL');
    }
    for (const [key, value] of Object.entries(req.query ?? {})) {
      if (value !== undefined) url.searchParams.append(key, String(value));
    }

    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    let body: string | undefined;
    if (req.json !== undefined) {
      body = JSON.stringify(req.json);
      if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/json';
    } else if (req.form !== undefined) {
      body = new URLSearchParams(req.form).toString();
      if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    const method = req.method ?? (body === undefined ? 'GET' : 'POST');
    const secrets = requestSecrets(url, headers, req.form);
    // No query string, and no credential of this request, ever reaches a message.
    const where = scrub(`${method} ${url.origin}${url.pathname}`, secrets);
    const attempts = (req.retry ?? method === 'GET') ? maxAttempts : 1;
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    for (let attempt = 1; ; attempt += 1) {
      const result = await attemptOnce(url, where, method, headers, body, timeoutMs, secrets);
      if (result.response !== undefined) return result.response as HttpResponse<T>;
      const error = result.error ?? new AutopilotError('internal', `${where}: no response`);
      if (!error.retryable || attempt >= attempts) throw error;
      await sleep(result.retryAfterMs ?? backoffMs(attempt));
    }
  }

  return { request };
}
