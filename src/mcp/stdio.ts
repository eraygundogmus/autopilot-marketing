import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { toAutopilotError } from '../core/errors';
import { redact } from '../core/redact';
import { createRuntime } from '../core/runtime';
import { createServer } from './server';

/** Starts the stdio server. Diagnostics go to stderr; stdout carries only protocol messages. */
export function runStdio(): void {
  try {
    const runtime = createRuntime();
    serveStdio(() => createServer(runtime));
  } catch (error) {
    const e = toAutopilotError(error);
    const line = `autopilot-marketing mcp: ${e.code}: ${e.message}${e.hint ? ` (${e.hint})` : ''}`;
    process.stderr.write(`${redact(line).replace(/\s*\n\s*/g, ' ')}\n`);
    process.exitCode = 1;
  }
}
