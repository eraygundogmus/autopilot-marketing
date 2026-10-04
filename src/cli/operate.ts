import fs from 'node:fs';
import { createChatClient } from '../agent/chat';
import { runLocalAgent } from '../agent/runner';
import { AutopilotError } from '../core/errors';
import { restrictRuntime } from '../core/restrict';
import type { RuntimeLimits } from '../core/restrict';
import { createRuntime } from '../core/runtime';
import { createSecretStore, ensureCredentialIndex, readCredentialIndex, updateCredentialIndex } from '../core/secrets';
import type { DiagnosticCheck, Job, Platform, Runtime, SecretStore } from '../core/types';
import { reconcileForJobs } from '../jobs/reconcile';
import { runDue, scheduleOverview } from '../jobs/runner';
import type { TickResult } from '../jobs/runner';
import type { CommandContext, CommandHandler } from './commands';

export const OPERATE_USAGE: Record<string, string> = {
  schedule: 'autopilot-marketing schedule list | run [--watch] [--interval seconds]',
  jobs: 'autopilot-marketing jobs [--account id] [--limit N]',
  credentials: 'autopilot-marketing credentials set <NAME> | list | delete <NAME>',
  agent:
    'autopilot-marketing agent "<task>" [--model name] [--base-url url] [--max-steps N] [--account id ...] [--allow-apply] [--jev] [--allow-remote]',
  connect: 'autopilot-marketing doctor --connect [accountId]',
};

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1';
const DEFAULT_INTERVAL_SECONDS = 60;
const MIN_INTERVAL_SECONDS = 10;
const CREDENTIAL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function usage(command: string, message: string, hint?: string): AutopilotError {
  return new AutopilotError('invalid_input', message, { hint: hint ?? `Usage: ${OPERATE_USAGE[command] ?? command}` });
}

function stringFlag(ctx: CommandContext, command: string, name: string): string | undefined {
  const value = ctx.flags[name];
  if (value === undefined || value === false) return undefined;
  const last = Array.isArray(value) ? value[value.length - 1] : value;
  if (typeof last !== 'string' || last === '') throw usage(command, `--${name} needs a value.`);
  return last;
}

function intFlag(ctx: CommandContext, command: string, name: string): number | undefined {
  const value = stringFlag(ctx, command, name);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw usage(command, `--${name} must be a whole number.`);
  return Number.parseInt(value, 10);
}

function listFlag(ctx: CommandContext, command: string, name: string): string[] | undefined {
  const value = ctx.flags[name];
  if (value === undefined || value === false) return undefined;
  const entries = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry === '') throw usage(command, `--${name} needs a value.`);
    out.push(entry);
  }
  return out;
}

function emit(ctx: CommandContext, document: unknown, text: string): void {
  ctx.io.stdout(ctx.json ? `${JSON.stringify(document, null, 2)}\n` : text.endsWith('\n') ? text : `${text}\n`);
}

/** Text from an account, a platform or a model server is data: it stays on one line. */
function oneLine(text: string): string {
  return text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();
}

/** One pass; a cycle first settles what an interrupted execution left behind for its account. */
async function runPass(runtime: Runtime): Promise<TickResult> {
  return runDue(runtime, { reconcile: reconcileForJobs(runtime) });
}

function passHeadline(result: TickResult): string {
  return `Queued ${result.enqueued.length}, ran ${result.ran.length}.`;
}

function jobDetailLines(job: Job): string[] {
  return job.attention.map((sentence) => `  ! ${oneLine(sentence)}`);
}

function passText(result: TickResult): string {
  const lines = [passHeadline(result)];
  for (const job of result.ran) {
    const note = job.state === 'failed' || job.result?.summary === undefined ? job.error : job.result.summary;
    lines.push(`${job.id} ${job.task} ${job.accountId} ${job.state}${note === undefined ? '' : `: ${oneLine(note)}`}`);
    lines.push(...jobDetailLines(job));
  }
  for (const note of result.notes) lines.push(`! ${oneLine(note)}`);
  return lines.join('\n');
}

function passExitCode(result: TickResult): number {
  if (result.ran.some((job) => job.state === 'failed')) return 1;
  return result.attention ? 3 : 0;
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

async function watch(ctx: CommandContext, intervalSeconds: number): Promise<number> {
  const stop = new AbortController();
  const onSignal = (): void => stop.abort();
  const onOuterAbort = (): void => stop.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  if (ctx.signal?.aborted === true) stop.abort();
  ctx.signal?.addEventListener('abort', onOuterAbort);
  try {
    while (!stop.signal.aborted) {
      try {
        // A fresh runtime per pass picks up edits of the config file; tests keep their own runtime.
        const runtime = ctx.signal === undefined ? createRuntime() : ctx.runtime;
        const result = await runPass(runtime);
        if (result.enqueued.length > 0 || result.ran.length > 0) {
          ctx.io.stdout(ctx.json ? `${JSON.stringify(result)}\n` : `${passHeadline(result)}\n`);
        }
      } catch (error) {
        // One bad pass (a config file caught mid-edit, say) must not end the loop.
        const failure = error instanceof AutopilotError ? `${error.code}: ${error.message}` : 'unexpected error';
        ctx.io.stderr(`Pass failed (${oneLine(failure)}).`);
      }
      await pause(intervalSeconds * 1000, stop.signal);
    }
    return 0;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    ctx.signal?.removeEventListener('abort', onOuterAbort);
  }
}

const schedule: CommandHandler = async (ctx) => {
  const sub = ctx.args[0];
  if (sub === 'list') {
    const schedules = scheduleOverview(ctx.runtime);
    const lines = schedules.map((status) => {
      const { schedule: config } = status;
      const parts = [
        oneLine(config.id),
        `${config.task} of ${oneLine(config.accountId)}`,
        `every ${config.every}${config.at === undefined ? '' : ` at ${config.at}`}`,
      ];
      if (config.enabled === false) parts.push('disabled');
      parts.push(`next ${status.nextDueAt}`, `last: ${status.lastJob?.state ?? 'never'}`);
      return parts.join('  ');
    });
    const none = `No schedules. Add them under "schedules" in ${ctx.runtime.paths.config}.`;
    emit(ctx, { schedules }, lines.length === 0 ? none : lines.join('\n'));
    return 0;
  }
  if (sub === 'run') {
    const interval = intFlag(ctx, 'schedule', 'interval');
    if (ctx.flags.watch === true) {
      if (interval !== undefined && interval < MIN_INTERVAL_SECONDS) {
        throw usage('schedule', `--interval must be at least ${MIN_INTERVAL_SECONDS} seconds.`);
      }
      return watch(ctx, interval ?? DEFAULT_INTERVAL_SECONDS);
    }
    const result = await runPass(ctx.runtime);
    emit(ctx, result, passText(result));
    return passExitCode(result);
  }
  throw usage('schedule', sub === undefined ? 'Missing subcommand.' : 'Unknown subcommand.');
};

const jobs: CommandHandler = async (ctx) => {
  const accountId = stringFlag(ctx, 'jobs', 'account');
  const limit = intFlag(ctx, 'jobs', 'limit');
  const listed = ctx.runtime.jobs.list({
    ...(accountId === undefined ? {} : { accountId }),
    ...(limit === undefined ? {} : { limit }),
  });
  const lines: string[] = [];
  for (const job of listed) {
    lines.push(`${job.id}  ${job.dueAt}  ${job.task} ${oneLine(job.accountId)}  ${job.state}`);
    if (job.result?.summary !== undefined) lines.push(`  ${oneLine(job.result.summary)}`);
    if (job.result?.next !== undefined) lines.push(`  next: ${oneLine(job.result.next)}`);
    if (job.error !== undefined) lines.push(`  error: ${oneLine(job.error)}`);
    lines.push(...jobDetailLines(job));
  }
  emit(ctx, { jobs: listed }, lines.length === 0 ? 'No runs yet.' : lines.join('\n'));
  return 0;
};

/** Names a dotenv file assigns. Values are never returned. */
function envFileNames(file: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match?.[1] !== undefined && !names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

function credentialName(ctx: CommandContext): string {
  const name = ctx.args[1];
  if (name === undefined || name.trim() === '') throw usage('credentials', 'Missing <NAME>.');
  if (!CREDENTIAL_NAME.test(name)) {
    throw usage('credentials', 'A credential name has letters, digits and underscores only.');
  }
  return name;
}

function secretStore(ctx: CommandContext, profile: string): SecretStore {
  return ctx.secrets ?? createSecretStore({ profile });
}

const credentials: CommandHandler = async (ctx) => {
  const { runtime } = ctx;
  const sub = ctx.args[0];
  if (sub === 'set') {
    const name = credentialName(ctx);
    const value = (await ctx.io.readSecret(`Value for ${name} (input hidden): `)).replace(/\r?\n$/, '');
    if (value === '') throw usage('credentials', 'No value was given.');
    const index = ensureCredentialIndex(runtime.paths);
    const store = secretStore(ctx, index.profile);
    store.set(name, value);
    // Under a lock, on the names as they are now: another `credentials set` may run at the same time.
    updateCredentialIndex(runtime.paths, (names) => [...names, name]);
    const alsoInEnvFile = envFileNames(runtime.paths.envFile).includes(name);
    const lines = [`Stored ${name} in the ${store.kind} credential store.`];
    if (alsoInEnvFile) {
      lines.push(`The .env file also sets ${name}; the credential store wins. Remove the line from .env.`);
    }
    emit(ctx, { name, store: store.kind, stored: true, alsoInEnvFile }, lines.join('\n'));
    return 0;
  }
  if (sub === 'delete') {
    const name = credentialName(ctx);
    const index = ensureCredentialIndex(runtime.paths);
    const store = secretStore(ctx, index.profile);
    const removed = store.delete(name);
    updateCredentialIndex(runtime.paths, (names) => names.filter((entry) => entry !== name));
    emit(
      ctx,
      { name, store: store.kind, removed },
      removed
        ? `Removed ${name} from the ${store.kind} credential store.`
        : `The ${store.kind} credential store had no entry for ${name}.`,
    );
    return 0;
  }
  if (sub === 'list') {
    const index = readCredentialIndex(runtime.paths);
    const names = [...new Set([...(index?.names ?? []), ...envFileNames(runtime.paths.envFile)])].sort();
    const unreadable = runtime.credentials.unreadable;
    const listed = names.map((name) => {
      let source = 'not set';
      if (process.env[name] !== undefined && process.env[name] !== '') source = 'process';
      else if (runtime.credentials.fromStore.includes(name)) source = 'credential store';
      else if (unreadable.some((entry) => entry.name === name)) source = 'unreadable';
      else if (runtime.env[name] !== undefined && runtime.env[name] !== '') source = '.env';
      return { name, source };
    });
    const store = ctx.secrets?.kind ?? runtime.credentials.store;
    const lines = listed.map((entry) => `${entry.name}: ${entry.source}`);
    for (const entry of unreadable) {
      lines.push(`${oneLine(entry.name)}: registered in the credential store but not readable (${oneLine(entry.reason)})`);
    }
    emit(ctx, { store, credentials: listed, unreadable }, lines.length === 0 ? 'No credentials.' : lines.join('\n'));
    return 0;
  }
  throw usage('credentials', sub === undefined ? 'Missing subcommand.' : 'Unknown subcommand.');
};

const agent: CommandHandler = async (ctx) => {
  const { runtime } = ctx;
  const task = ctx.args.join(' ').trim();
  if (task === '') throw usage('agent', 'Missing <task>.');
  const model = stringFlag(ctx, 'agent', 'model') || runtime.env.AUTOPILOT_AGENT_MODEL || runtime.config.agent?.model;
  if (model === undefined || model === '') {
    throw usage('agent', 'No model was chosen.', 'Pass --model, for example --model qwen3 with Ollama.');
  }
  const baseUrl =
    stringFlag(ctx, 'agent', 'base-url') ||
    runtime.env.AUTOPILOT_AGENT_BASE_URL ||
    runtime.config.agent?.baseUrl ||
    DEFAULT_BASE_URL;
  const apiKey = runtime.env.AUTOPILOT_AGENT_API_KEY;
  const maxSteps = intFlag(ctx, 'agent', 'max-steps');
  if (maxSteps !== undefined && maxSteps < 1) throw usage('agent', '--max-steps must be at least 1.');
  const allowRemote = ctx.flags['allow-remote'] === true;
  const accounts = listFlag(ctx, 'agent', 'account');

  const chat =
    ctx.chat ??
    createChatClient({ baseUrl, ...(apiKey === undefined || apiKey === '' ? {} : { apiKey }), allowRemote });
  if (!allowRemote && (await chat.remoteModels()).includes(model)) {
    throw new AutopilotError('invalid_input', `Model ${oneLine(model)} is served from another machine by this endpoint.`, {
      hint: 'Choose a local model, or pass --allow-remote.',
    });
  }

  const limits: RuntimeLimits = {
    ...(accounts === undefined ? {} : { accounts }),
    ...(ctx.flags['allow-apply'] === true ? {} : { maxAutonomy: 'propose' as const }),
    ...(ctx.flags.jev === true ? {} : { judgments: false }),
  };
  const view = restrictRuntime(runtime, limits);
  const run = await runLocalAgent(view, {
    task,
    model,
    chat,
    ...(maxSteps === undefined ? {} : { maxSteps }),
    ...(ctx.json
      ? {}
      : {
          onEvent: (event) => {
            if (event.type === 'tool_call') ctx.io.stderr(`-> ${oneLine(event.name)}`);
          },
        }),
  });
  emit(ctx, run, run.answer);
  if (run.stopped === 'max_steps') {
    if (!ctx.json) ctx.io.stderr(`Stopped after ${run.steps} steps.`);
    return 1;
  }
  return 0;
};

const CHECK_MARKS: Record<DiagnosticCheck['status'], string> = { ok: 'ok', fail: 'FAIL', unknown: '?', skipped: '-' };

const connect: CommandHandler = async (ctx) => {
  const { runtime } = ctx;
  const only = ctx.args[0];
  const accounts = only === undefined ? runtime.config.accounts : [runtime.account(only)];
  const out: Array<{ id: string; platform: Platform; source: string; checks: DiagnosticCheck[] }> = [];
  const lines: string[] = [];
  let failed = false;
  for (const account of accounts) {
    const connector = runtime.connector(account);
    if (connector.diagnose === undefined) {
      lines.push(`${oneLine(account.id)}: no live connection (source ${connector.source})`);
      out.push({ id: account.id, platform: account.platform, source: connector.source, checks: [] });
      continue;
    }
    const checks = await connector.diagnose();
    out.push({ id: account.id, platform: account.platform, source: connector.source, checks });
    lines.push(`${oneLine(account.id)} (${account.platform})`);
    for (const check of checks) {
      if (check.status === 'fail') failed = true;
      lines.push(`  ${CHECK_MARKS[check.status].padEnd(4)}  ${oneLine(check.label)}: ${oneLine(check.detail)}`);
      if (check.status === 'fail' && check.fix !== undefined) lines.push(`        fix: ${oneLine(check.fix)}`);
    }
  }
  emit(ctx, { accounts: out }, lines.length === 0 ? 'No accounts are configured.' : lines.join('\n'));
  return failed ? 1 : 0;
};

/** schedule, jobs, credentials, agent, connect (`doctor --connect`). */
export const operateCommands: Record<string, CommandHandler> = { schedule, jobs, credentials, agent, connect };
