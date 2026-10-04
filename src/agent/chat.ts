import { AutopilotError } from '../core/errors';
import { redact } from '../core/redact';
import type { JsonObject } from '../core/types';

export interface ChatToolCall {
  id: string;
  name: string;
  /** Parsed arguments; `{}` when the model sent none or sent something that is not a JSON object. */
  arguments: JsonObject;
  /** Set when the model's arguments were not a JSON object; the raw text is not kept. */
  argumentsError?: string;
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls: ChatToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export type AssistantMessage = Extract<ChatMessage, { role: 'assistant' }>;

export interface ChatTool {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: JsonObject;
}

export interface ChatClient {
  /** One completion, not streamed. Throws `platform_error` on a failed or malformed reply. */
  complete(input: { model: string; messages: ChatMessage[]; tools: ChatTool[] }): Promise<AssistantMessage>;
  /**
   * Names of models the server serves from another machine (Ollama marks them with `remote_host`).
   * Best effort: empty when the server has no such listing.
   */
  remoteModels(): Promise<string[]>;
}

const REMOTE_HINT =
  'The local runner sends account data to this endpoint. Pass --allow-remote only for an endpoint you trust.';
const SERVER_HINT = 'Is the model server running? For Ollama: ollama serve';
const BODY_LIMIT = 300;

/**
 * True for http(s) URLs whose host is a loopback address written as a literal: `127.0.0.0/8` or
 * `[::1]`. A name, `localhost` included, is resolved elsewhere and can point anywhere, so it is not accepted.
 */
export function isLoopbackUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  const host = parsed.hostname.toLowerCase();
  if (host === '[::1]') return true;
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (octets === null) return false;
  return octets[1] === '127' && octets.slice(1).every((part) => Number(part) <= 255);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A short piece of a server reply for an error message. The endpoint's own key is removed by
 * value: it may come from the `.env` file or the credential store, which `redact` cannot see.
 */
function excerpt(text: string, secret: string | undefined): string {
  const cleaned = secret !== undefined && secret !== '' ? text.split(secret).join('[redacted]') : text;
  return redact(cleaned).slice(0, BODY_LIMIT);
}

function wireMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'assistant') {
    const wire: Record<string, unknown> = { role: 'assistant', content: message.content };
    if (message.toolCalls.length > 0) {
      wire['tool_calls'] = message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      }));
    }
    return wire;
  }
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId, name: message.name, content: message.content };
  }
  return { role: message.role, content: message.content };
}

function parseArguments(raw: unknown): { arguments: JsonObject; argumentsError?: string } {
  if (raw === undefined || raw === null || raw === '') return { arguments: {} };
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return { arguments: {}, argumentsError: 'arguments were not valid JSON' };
    }
  }
  if (!isRecord(value)) return { arguments: {}, argumentsError: 'arguments were not a JSON object' };
  // The value came from JSON.parse or from a parsed JSON reply, so it holds JSON values only.
  return { arguments: value as JsonObject };
}

function parseReply(body: unknown, status: number, text: string, secret: string | undefined): AssistantMessage {
  const malformed = (reason: string): AutopilotError =>
    new AutopilotError('platform_error', `Malformed chat reply (status ${status}, ${reason}): ${excerpt(text, secret)}`);
  if (!isRecord(body) || !Array.isArray(body['choices'])) throw malformed('no choices');
  const choice: unknown = body['choices'][0];
  if (!isRecord(choice) || !isRecord(choice['message'])) throw malformed('no choices[0].message');
  const message = choice['message'];
  const content = typeof message['content'] === 'string' ? message['content'] : '';
  const rawCalls: unknown = message['tool_calls'];
  const toolCalls: ChatToolCall[] = [];
  if (Array.isArray(rawCalls)) {
    rawCalls.forEach((raw: unknown, index) => {
      const fn = isRecord(raw) ? raw['function'] : undefined;
      if (!isRecord(raw) || !isRecord(fn) || typeof fn['name'] !== 'string' || fn['name'] === '') {
        throw malformed(`tool call ${index} has no function name`);
      }
      const id = typeof raw['id'] === 'string' && raw['id'] !== '' ? raw['id'] : `call_${index}`;
      toolCalls.push({ id, name: fn['name'], ...parseArguments(fn['arguments']) });
    });
  } else if (rawCalls !== undefined && rawCalls !== null) {
    throw malformed('tool_calls is not a list');
  }
  return { role: 'assistant', content, toolCalls };
}

/** A client for an OpenAI-compatible chat completions endpoint (Ollama, llama.cpp, LM Studio). */
export function createChatClient(options: {
  /** Ends in `/v1`, e.g. `http://127.0.0.1:11434/v1`. */
  baseUrl: string;
  apiKey?: string;
  /** Accept a base URL that is not loopback. Default false: throws `invalid_input`. */
  allowRemote?: boolean;
  fetch?: typeof fetch;
  /** Default 300000. */
  timeoutMs?: number;
}): ChatClient {
  if (!isLoopbackUrl(options.baseUrl) && options.allowRemote !== true) {
    throw new AutopilotError('invalid_input', 'The chat endpoint is not a loopback address.', { hint: REMOTE_HINT });
  }
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.apiKey !== undefined && options.apiKey !== '') headers['Authorization'] = `Bearer ${options.apiKey}`;

  return {
    async complete(input) {
      const payload: Record<string, unknown> = {
        model: input.model,
        messages: input.messages.map(wireMessage),
      };
      if (input.tools.length > 0) {
        payload['tools'] = input.tools.map((tool) => ({
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        }));
      }
      payload['stream'] = false;

      let status: number;
      let ok: boolean;
      let text: string;
      try {
        const response = await doFetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
        status = response.status;
        ok = response.ok;
        text = await response.text();
      } catch (error) {
        const reason = error instanceof Error ? error.name : 'error';
        throw new AutopilotError('platform_error', `The chat request failed (${reason}).`, {
          hint: SERVER_HINT,
          retryable: true,
          cause: error,
        });
      }
      if (!ok) {
        throw new AutopilotError('platform_error', `The chat endpoint answered ${status}: ${excerpt(text, options.apiKey)}`, {
          retryable: status >= 500 || status === 429,
        });
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new AutopilotError(
          'platform_error',
          `The chat endpoint answered ${status} with unreadable JSON: ${excerpt(text, options.apiKey)}`,
        );
      }
      return parseReply(body, status, text, options.apiKey);
    },

    async remoteModels() {
      try {
        const response = await doFetch(`${new URL(baseUrl).origin}/api/tags`, {
          method: 'GET',
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) return [];
        const body: unknown = await response.json();
        if (!isRecord(body) || !Array.isArray(body['models'])) return [];
        const names: string[] = [];
        for (const entry of body['models'] as unknown[]) {
          if (!isRecord(entry)) continue;
          const name = entry['name'];
          const remoteHost = entry['remote_host'];
          if (typeof name === 'string' && name !== '' && typeof remoteHost === 'string' && remoteHost !== '') {
            names.push(name);
          }
        }
        return names;
      } catch {
        return [];
      }
    },
  };
}
