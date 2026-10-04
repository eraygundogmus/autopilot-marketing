import { toAutopilotError } from '../core/errors';
import { redact } from '../core/redact';
import type { JsonObject } from '../core/types';

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: JsonObject;
  isError?: boolean;
}

/** Structured content plus a text block: `text` when given, else the JSON. */
export function ok(structured: JsonObject, text?: string): ToolResult {
  return {
    content: [{ type: 'text', text: text ?? JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

/** A tool execution error an agent can act on: code, message, hint. Secrets are redacted. */
export function fail(error: unknown): ToolResult {
  const e = toAutopilotError(error);
  const message = redact(e.message);
  const hint = e.hint ? redact(e.hint) : undefined;
  return {
    content: [{ type: 'text', text: `Error (${e.code}): ${message}${hint ? `\nNext: ${hint}` : ''}` }],
    structuredContent: {
      error: { code: e.code, message, retryable: e.retryable, ...(hint ? { hint } : {}) },
    },
    isError: true,
  };
}
