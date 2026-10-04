import fs from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { defaultConfig, saveConfig } from '../core/config';
import { AutopilotError, toAutopilotError } from '../core/errors';
import { ensureHome, resolvePaths } from '../core/paths';
import { redact } from '../core/redact';
import { createRuntime } from '../core/runtime';
import type { LedgerFilter, Runtime } from '../core/types';
import { runStdio } from '../mcp/stdio';
import { sourcesOverview } from '../ops/data';
import { VERSION } from '../version';
import { workCommands } from './commands';
import { operateCommands } from './operate';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  stdin: { isTTY?: boolean };
  /** Asks a yes/no question on the terminal. */
  confirm: (question: string) => Promise<boolean>;
  /** Reads a secret: the whole of a piped stdin, or one line typed on the terminal without echo. */
  readSecret: (prompt: string) => Promise<string>;
}

type Flags = Record<string, string | boolean | string[] | undefined>;

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;
const DEFAULT_LEDGER_LIMIT = 20;

/**
 * One row per command: the argument form the command accepts and what it does.
 * The work-command forms equal the per-command usage in commands.ts.
 */
const COMMAND_GROUPS: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, string]>]> = [
  [
    'Setup',
    [
      ['init [--force]', 'Create the home directory, config.json and brief.md'],
      ['doctor [--connect [accountId]]', 'Check configuration, credentials, kill switch and ledger; --connect tests live access'],
      ['credentials set <NAME> | list | delete <NAME>', "Keep a credential in the operating system's credential store"],
      ['mcp', 'Start the MCP server on stdio for your AI agent'],
    ],
  ],
  [
    'Read',
    [
      ['snapshot <accountId> [--days N] [--csv dataset=path ...]', 'Fetch account data into a snapshot'],
      ['audit <accountId> [--days N] [--snapshot id] [--no-judgments]', 'Audit an account and list findings'],
      ['report <accountId> [--days N]', 'Print the KPI report'],
      ['ledger [--verify] [--limit N] [--account id]', 'Show the change ledger or verify its integrity'],
    ],
  ],
  [
    'Change',
    [
      ['plan <auditId> [--findings id,id] [--title text]', 'Build a change plan from an audit'],
      ['preview <planId>', 'Show what a plan would change, with policy and gate decisions'],
      ['approve <planId>', 'Approve a plan on the terminal and issue a receipt'],
      ['review <planId> [--port N]', 'Open the local review page to approve a plan'],
      ['apply <planId> [--live] [--receipt id]', 'Apply a plan (dry run unless --live)'],
      ['revert <planId>', 'Create a compensating plan for an applied plan'],
    ],
  ],
  [
    'Operate',
    [
      ['run <accountId> [--days N]', 'Snapshot, audit, plan and apply within the configured autonomy'],
      ['schedule list | run [--watch] [--interval seconds]', 'Show the schedules, or run what is due'],
      ['jobs [--account id] [--limit N]', 'Show recent scheduled runs and what needs attention'],
      ['reconcile <accountId>', 'Settle changes an interrupted run left with an unknown outcome'],
      ['agent "<task>" [--model name] [--account id]', 'Run a task with a local model (Ollama) and the same tools'],
      ['kill on|off', 'Turn the kill switch on or off'],
      ['help', 'Show this text'],
      ['version', 'Show the version'],
    ],
  ],
];

const USAGE_COLUMN = 31;

function usageRow(form: string, description: string): string {
  // A form wider than the column keeps its description on the same line, two spaces after it.
  return `  ${form.padEnd(USAGE_COLUMN - 1)} ${form.length < USAGE_COLUMN - 1 ? '' : ' '}${description}`;
}

const USAGE = [
  `autopilot-marketing ${VERSION}: audit ad accounts and apply reviewed changes safely`,
  '',
  'Usage: autopilot-marketing <command> [options]',
  ...COMMAND_GROUPS.flatMap(([group, rows]) => ['', group, ...rows.map(([form, text]) => usageRow(form, text))]),
  '',
  'Global options: --json, --help, --version',
].join('\n');

/** The whole of a piped stdin without its last newline, or one line typed on the terminal without echo. */
function readSecret(prompt: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const input = process.stdin;
    if (input.isTTY !== true) {
      const chunks: Buffer[] = [];
      input.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      input.once('end', () => resolve(Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')));
      input.once('error', reject);
      return;
    }
    process.stderr.write(prompt);
    input.setRawMode(true);
    input.resume();
    let value = '';
    const done = (finish: () => void): void => {
      input.setRawMode(false);
      input.pause();
      input.off('data', onData);
      process.stderr.write('\n');
      finish();
    };
    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n' || char === '\u0004') return done(() => resolve(value));
        if (char === '\u0003') return done(() => reject(new AutopilotError('invalid_input', 'Cancelled.')));
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    input.on('data', onData);
  });
}

function defaultIo(): CliIo {
  return {
    readSecret,
    stdout: (text) => {
      process.stdout.write(`${text}\n`);
    },
    stderr: (text) => {
      process.stderr.write(`${text}\n`);
    },
    stdin: process.stdin,
    confirm: (question) =>
      new Promise<boolean>((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question(`${question} [y/N] `, (answer) => {
          rl.close();
          const normalized = answer.trim().toLowerCase();
          resolve(normalized === 'y' || normalized === 'yes');
        });
      }),
  };
}

function normalizeFlags(values: Record<string, unknown>): Flags {
  const flags: Flags = {};
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === 'string' || typeof value === 'boolean') flags[name] = value;
    else if (Array.isArray(value)) flags[name] = value.filter((item): item is string => typeof item === 'string');
  }
  return flags;
}

function usageError(message: string, hint: string): AutopilotError {
  return new AutopilotError('invalid_input', message, { hint });
}

function reportError(io: CliIo, error: unknown, json: boolean): void {
  const failure = toAutopilotError(error);
  const message = redact(failure.message);
  const hint = failure.hint === undefined ? null : redact(failure.hint);
  if (json) {
    io.stdout(JSON.stringify({ error: { code: failure.code, message, hint } }, null, 2));
    return;
  }
  io.stderr(`Error (${failure.code}): ${message}`);
  if (hint !== null) io.stderr(`Next: ${hint}`);
}

function emit(io: CliIo, json: boolean, data: unknown, lines: string[]): void {
  io.stdout(json ? JSON.stringify(data, null, 2) : redact(lines.join('\n')));
}

function runInit(io: CliIo, flags: Flags, json: boolean): number {
  const paths = resolvePaths();
  ensureHome(paths);
  const configExisted = fs.existsSync(paths.config);
  const wroteConfig = !configExisted || flags.force === true;
  if (wroteConfig) saveConfig(defaultConfig(), paths);
  const wroteBrief = !fs.existsSync(paths.brief);
  if (wroteBrief) {
    fs.writeFileSync(
      paths.brief,
      '<!-- Notes about the business for your agent: products, margins, seasons, what must never change. -->\n',
      { mode: 0o600 },
    );
  }
  emit(
    io,
    json,
    { home: paths.home, config: paths.config, envFile: paths.envFile, brief: paths.brief, wroteConfig, wroteBrief },
    [
      `Home:   ${paths.home}`,
      `Config: ${paths.config} (${wroteConfig ? (configExisted ? 'overwritten' : 'created') : 'kept, use --force to overwrite'})`,
      `Brief:  ${paths.brief} (${wroteBrief ? 'created' : 'kept'})`,
      `Env:    ${paths.envFile}`,
      '',
      'Next steps:',
      `  1. Edit ${paths.config} to add accounts and set autonomy.`,
      `  2. Store credentials with \`autopilot-marketing credentials set <NAME>\`, or put them in ${paths.envFile}.`,
      '  3. Run `autopilot-marketing doctor`.',
    ],
  );
  return EXIT_OK;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function runDoctor(runtime: Runtime, io: CliIo, json: boolean): number {
  const overview = sourcesOverview(runtime);
  const ledgerOk = overview.ledger.ok;
  const accounts = overview.accounts.map((account) => ({
    id: String(account.id),
    platform: String(account.platform),
    source: typeof account.source === 'string' ? account.source : null,
    ready: account.ready === true,
    missingEnv: stringList(account.missingEnv),
    note: typeof account.note === 'string' ? account.note : null,
  }));
  const lines = [
    `Node:        ${process.version}`,
    `Home:        ${overview.home}`,
    `Config:      valid (${fs.existsSync(runtime.paths.config) ? runtime.paths.config : 'defaults, run `autopilot-marketing init`'})`,
    `Autonomy:    ${overview.configuredAutonomy} configured, ${overview.autonomy} effective`,
    `Judgment:    ${overview.judgment.mode} (${overview.judgment.model})`,
    `Kill switch: ${overview.killSwitch ? 'ON (no live change will be applied)' : 'off'}`,
    `Ledger:      ${ledgerOk ? `ok, ${overview.ledger.entries} entries` : `BROKEN at entry ${overview.ledger.brokenAt}`}`,
    `Credentials: ${runtime.credentials.fromStore.length} from the credential store (${runtime.credentials.store})`,
    ...runtime.credentials.unreadable.map((entry) => `  NOT READABLE ${entry.name}: ${redact(entry.reason)}`),
    `Schedules:   ${(runtime.config.schedules ?? []).length} configured`,
    '',
    `Accounts (${accounts.length}):`,
    ...accounts.map((account) => {
      const state = account.ready
        ? 'ready'
        : account.missingEnv.length > 0
          ? `not ready, missing ${account.missingEnv.join(', ')}`
          : `not ready${account.note === null ? '' : `, ${account.note}`}`;
      return `  ${account.id} [${account.platform}${account.source === null ? '' : `, ${account.source}`}] ${state}`;
    }),
  ];
  emit(
    io,
    json,
    {
      node: process.version,
      home: overview.home,
      configValid: true,
      autonomy: { configured: overview.configuredAutonomy, effective: overview.autonomy },
      judgment: overview.judgment,
      killSwitch: overview.killSwitch,
      accounts,
      ledger: overview.ledger,
      credentials: runtime.credentials,
      schedules: (runtime.config.schedules ?? []).length,
    },
    lines,
  );
  return ledgerOk ? EXIT_OK : EXIT_FAILURE;
}

function runLedger(runtime: Runtime, io: CliIo, flags: Flags, json: boolean): number {
  if (flags.verify === true) {
    const result = runtime.ledger.verify();
    emit(io, json, result, [
      result.ok
        ? `Ledger ok: ${result.entries} entries, hash chain intact.`
        : `Ledger BROKEN at entry ${result.brokenAt} (${result.entries} entries).`,
    ]);
    return result.ok ? EXIT_OK : EXIT_FAILURE;
  }
  let limit = DEFAULT_LEDGER_LIMIT;
  if (flags.limit !== undefined) {
    limit = typeof flags.limit === 'string' ? Number(flags.limit) : Number.NaN;
    if (!Number.isInteger(limit) || limit < 1) {
      throw usageError('--limit must be a positive integer', 'Example: autopilot-marketing ledger --limit 50');
    }
  }
  const filter: LedgerFilter = { limit };
  if (flags.account !== undefined) {
    // A valueless --account must never widen the listing to every account.
    if (typeof flags.account !== 'string' || flags.account.trim() === '') {
      throw usageError('--account needs an account id', 'Example: autopilot-marketing ledger --account <id>');
    }
    filter.accountId = runtime.account(flags.account).id;
  }
  const entries = runtime.ledger.read(filter);
  emit(
    io,
    json,
    { entries },
    entries.length === 0
      ? ['The ledger is empty.']
      : entries.map((entry) =>
          [
            `#${entry.seq}`,
            entry.ts,
            entry.event,
            `${entry.actor.kind}:${entry.actor.id}`,
            ...(entry.accountId === undefined ? [] : [`account=${entry.accountId}`]),
            ...(entry.planId === undefined ? [] : [`plan=${entry.planId}`]),
            ...(entry.executionId === undefined ? [] : [`execution=${entry.executionId}`]),
            ...(entry.actionId === undefined ? [] : [`action=${entry.actionId}`]),
          ].join('  '),
        ),
  );
  return EXIT_OK;
}

function runKill(io: CliIo, args: string[], json: boolean): number {
  const state = args[0];
  if (state !== 'on' && state !== 'off') {
    throw usageError('kill needs "on" or "off"', 'Run `autopilot-marketing kill on` or `autopilot-marketing kill off`.');
  }
  // Works from the paths alone, so the switch can be thrown even when config.json is broken.
  const paths = resolvePaths();
  ensureHome(paths);
  if (state === 'on') {
    fs.writeFileSync(paths.killFile, `Kill switch turned on ${new Date().toISOString()}\n`, { mode: 0o600 });
  } else {
    fs.rmSync(paths.killFile, { force: true });
  }
  emit(io, json, { killSwitch: state === 'on', killFile: paths.killFile }, [
    state === 'on'
      ? `Kill switch ON: no live change will be applied (${paths.killFile}).`
      : `Kill switch file removed (${paths.killFile}). policy.killSwitch and AUTOPILOT_KILL still apply when set.`,
  ]);
  return EXIT_OK;
}

/** Runs one CLI command and returns the process exit code. */
export async function main(argv: string[], io?: Partial<CliIo>): Promise<number> {
  const cli: CliIo = { ...defaultIo(), ...io };
  let json = argv.includes('--json');
  try {
    const parsed = parseArgs({
      args: argv,
      strict: false,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        days: { type: 'string' },
        snapshot: { type: 'string' },
        findings: { type: 'string' },
        title: { type: 'string' },
        live: { type: 'boolean' },
        receipt: { type: 'string' },
        verify: { type: 'boolean' },
        limit: { type: 'string' },
        account: { type: 'string', multiple: true },
        watch: { type: 'boolean' },
        interval: { type: 'string' },
        connect: { type: 'boolean' },
        model: { type: 'string' },
        'base-url': { type: 'string' },
        'max-steps': { type: 'string' },
        'allow-remote': { type: 'boolean' },
        'allow-apply': { type: 'boolean' },
        jev: { type: 'boolean' },
        force: { type: 'boolean' },
        csv: { type: 'string', multiple: true },
        'no-judgments': { type: 'boolean' },
        port: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
    const flags = normalizeFlags(parsed.values);
    // --account may repeat (the local runner's scope); one value stays a plain string.
    if (Array.isArray(flags.account) && flags.account.length === 1) flags.account = flags.account[0];
    json = flags.json === true;
    const [command, ...args] = parsed.positionals;

    if (flags.version === true || command === 'version') {
      cli.stdout(json ? JSON.stringify({ version: VERSION }) : VERSION);
      return EXIT_OK;
    }
    if (flags.help === true || command === undefined || command === 'help') {
      cli.stdout(USAGE);
      return EXIT_OK;
    }
    switch (command) {
      case 'mcp':
        runStdio();
        // The process ends when the client closes stdin.
        return await new Promise<number>(() => {});
      case 'init':
        return runInit(cli, flags, json);
      case 'kill':
        try {
          return runKill(cli, args, json);
        } catch (error) {
          reportError(cli, error, json);
          return error instanceof AutopilotError && error.code === 'invalid_input' ? EXIT_USAGE : EXIT_FAILURE;
        }
      case 'doctor': {
        const connect = operateCommands.connect;
        if (flags.connect === true && connect !== undefined) {
          return await connect({ runtime: createRuntime(), io: cli, args, flags, json });
        }
        return runDoctor(createRuntime(), cli, json);
      }
      case 'ledger':
        return runLedger(createRuntime(), cli, flags, json);
      default: {
        const handler = Object.hasOwn(workCommands, command)
          ? workCommands[command]
          : Object.hasOwn(operateCommands, command) && command !== 'connect'
            ? operateCommands[command]
            : undefined;
        if (!handler) {
          if (json) {
            reportError(cli, usageError(`Unknown command: ${command}`, 'Run `autopilot-marketing help`.'), true);
          } else {
            cli.stderr(redact(`Unknown command: ${command}`));
            cli.stderr(USAGE);
          }
          return EXIT_USAGE;
        }
        return await handler({ runtime: createRuntime(), io: cli, args, flags, json });
      }
    }
  } catch (error) {
    reportError(cli, error, json);
    return EXIT_FAILURE;
  }
}
