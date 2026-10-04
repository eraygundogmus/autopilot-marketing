import os from 'node:os';
import { AutopilotError } from '../core/errors';
import { DATASETS } from '../core/types';
import type { ApplyOutcome, DatasetName, Plan, Runtime, Snapshot } from '../core/types';
import { auditSnapshot } from '../ops/audit';
import { kpiReport, takeSnapshot } from '../ops/data';
import { proposePlan, runCycle } from '../ops/plans';
import { isInteractive } from '../plan/approval';
import { applyPlan, createRevertPlan } from '../plan/executor';
import { previewPlan } from '../plan/preview';
import { renderAudit, renderKpiReport } from '../report/render';
import type { CliIo } from './main';
import { startReviewServer } from './review';

export interface CommandContext {
  runtime: Runtime;
  io: CliIo;
  /** Positional arguments after the command name. */
  args: string[];
  flags: Record<string, string | boolean | string[] | undefined>;
  json: boolean;
}

export type CommandHandler = (ctx: CommandContext) => Promise<number>;

const USAGE: Record<string, string> = {
  snapshot: 'autopilot-marketing snapshot <accountId> [--days N] [--csv dataset=path ...]',
  audit: 'autopilot-marketing audit <accountId> [--days N] [--snapshot id] [--no-judgments]',
  report: 'autopilot-marketing report <accountId> [--days N]',
  plan: 'autopilot-marketing plan <auditId> [--findings id,id] [--title text]',
  preview: 'autopilot-marketing preview <planId>',
  approve: 'autopilot-marketing approve <planId>',
  review: 'autopilot-marketing review <planId> [--port N]',
  apply: 'autopilot-marketing apply <planId> [--live] [--receipt id]',
  revert: 'autopilot-marketing revert <planId>',
  run: 'autopilot-marketing run <accountId> [--days N]',
};

function usageOf(command: string): string {
  return `Usage: ${USAGE[command] ?? `autopilot-marketing ${command}`}`;
}

function positional(ctx: CommandContext, command: string, name: string): string {
  const value = ctx.args[0];
  if (value === undefined || value.trim() === '') {
    throw new AutopilotError('invalid_input', `Missing <${name}>.`, { hint: usageOf(command) });
  }
  return value;
}

function stringFlag(ctx: CommandContext, command: string, name: string): string | undefined {
  const value = ctx.flags[name];
  if (value === undefined || value === false) return undefined;
  const last = Array.isArray(value) ? value[value.length - 1] : value;
  if (typeof last !== 'string' || last === '') {
    throw new AutopilotError('invalid_input', `--${name} needs a value.`, { hint: usageOf(command) });
  }
  return last;
}

function intFlag(ctx: CommandContext, command: string, name: string): number | undefined {
  const value = stringFlag(ctx, command, name);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new AutopilotError('invalid_input', `--${name} must be a whole number.`, { hint: usageOf(command) });
  }
  return Number.parseInt(value, 10);
}

function isDataset(value: string): value is DatasetName {
  return (DATASETS as readonly string[]).includes(value);
}

function csvFlag(ctx: CommandContext): Array<{ dataset: DatasetName; path: string }> | undefined {
  const value = ctx.flags.csv;
  if (value === undefined || value === false) return undefined;
  const entries = Array.isArray(value) ? value : [value];
  const hint = `${usageOf('snapshot')}. Datasets: ${DATASETS.join(', ')}`;
  return entries.map((entry) => {
    const cut = typeof entry === 'string' ? entry.indexOf('=') : -1;
    if (typeof entry !== 'string' || cut < 1 || cut === entry.length - 1) {
      throw new AutopilotError('invalid_input', '--csv must be dataset=path.', { hint });
    }
    const dataset = entry.slice(0, cut);
    if (!isDataset(dataset)) {
      throw new AutopilotError('invalid_input', '--csv names an unknown dataset.', { hint });
    }
    return { dataset, path: entry.slice(cut + 1) };
  });
}

function emit(ctx: CommandContext, document: unknown, text: string): void {
  ctx.io.stdout(ctx.json ? `${JSON.stringify(document, null, 2)}\n` : text.endsWith('\n') ? text : `${text}\n`);
}

function snapshotSummary(snapshot: Snapshot): Record<string, unknown> {
  return {
    id: snapshot.id,
    accountId: snapshot.accountId,
    platform: snapshot.platform,
    source: snapshot.source,
    currency: snapshot.currency,
    dateRange: snapshot.dateRange,
    coverage: snapshot.coverage,
    warnings: snapshot.warnings,
  };
}

function snapshotText(snapshot: Snapshot): string {
  const lines = [
    `Snapshot: ${snapshot.id}`,
    `Source: ${snapshot.source}`,
    `Range: ${snapshot.dateRange.start} to ${snapshot.dateRange.end}`,
    'Coverage:',
  ];
  for (const [dataset, coverage] of Object.entries(snapshot.coverage)) {
    const note = coverage.note === undefined ? '' : ` (${coverage.note})`;
    lines.push(`- ${dataset}: ${coverage.status}, ${coverage.rows} rows${note}`);
  }
  for (const warning of snapshot.warnings) lines.push(`Warning: ${warning}`);
  return lines.join('\n');
}

function outcomeLines(outcome: ApplyOutcome): string[] {
  const lines = [
    `Plan: ${outcome.plan.id}${outcome.dryRun ? ' (dry run)' : ''}`,
    `Applied: ${outcome.applied}  Failed: ${outcome.failed}  Skipped: ${outcome.skipped}  Unknown: ${outcome.unknown}`,
  ];
  for (const entry of outcome.results) {
    const action = outcome.plan.actions.find((candidate) => candidate.id === entry.actionId);
    const detail = entry.note ?? entry.result?.error?.message;
    lines.push(
      `- ${entry.actionId} ${action?.kind ?? ''} ${entry.status}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`
        .replace(/ {2,}/g, ' '),
    );
  }
  return lines;
}

function daysInput(ctx: CommandContext, command: string): { days?: number } {
  const days = intFlag(ctx, command, 'days');
  return days === undefined ? {} : { days };
}

const snapshot: CommandHandler = async (ctx) => {
  const accountId = positional(ctx, 'snapshot', 'accountId');
  const csvFiles = csvFlag(ctx);
  const taken = await takeSnapshot(ctx.runtime, {
    accountId,
    ...daysInput(ctx, 'snapshot'),
    ...(csvFiles === undefined ? {} : { csvFiles }),
  });
  emit(ctx, snapshotSummary(taken), snapshotText(taken));
  return 0;
};

const audit: CommandHandler = async (ctx) => {
  const accountId = positional(ctx, 'audit', 'accountId');
  let snapshotId = stringFlag(ctx, 'audit', 'snapshot');
  if (snapshotId === undefined) {
    snapshotId = (await takeSnapshot(ctx.runtime, { accountId, ...daysInput(ctx, 'audit') })).id;
  } else {
    const stored = ctx.runtime.store.getSnapshot(snapshotId);
    if (stored.accountId !== ctx.runtime.account(accountId).id) {
      throw new AutopilotError('invalid_input', `Snapshot ${stored.id} belongs to another account.`, {
        hint: usageOf('audit'),
      });
    }
  }
  const noJudgments = ctx.flags['no-judgments'] === true || ctx.flags.judgments === false;
  const report = await auditSnapshot(ctx.runtime, { snapshotId, ...(noJudgments ? { judgments: false } : {}) });
  emit(ctx, report, `${renderAudit(report)}\n\nAudit: ${report.id}`);
  return 0;
};

const report: CommandHandler = async (ctx) => {
  const accountId = positional(ctx, 'report', 'accountId');
  const kpi = await kpiReport(ctx.runtime, { accountId, ...daysInput(ctx, 'report') });
  emit(ctx, kpi, renderKpiReport(kpi));
  return 0;
};

const plan: CommandHandler = async (ctx) => {
  const auditId = positional(ctx, 'plan', 'auditId');
  const stored = ctx.runtime.store.getAudit(auditId);
  const findings = stringFlag(ctx, 'plan', 'findings');
  const findingIds = findings?.split(',').map((id) => id.trim()).filter((id) => id !== '');
  const created = await proposePlan(ctx.runtime, {
    accountId: stored.accountId,
    title: stringFlag(ctx, 'plan', 'title') ?? `Plan from audit ${stored.id}`,
    rationale: `Suggested actions of audit ${stored.id}.`,
    snapshotId: stored.snapshotId,
    auditId: stored.id,
    ...(findingIds === undefined ? {} : { findingIds }),
    createdBy: 'cli',
  });
  const preview = await previewPlan(created.id, ctx.runtime);
  emit(ctx, { planId: created.id, preview }, `${preview.review}\n\nPlan: ${created.id}`);
  return 0;
};

const preview: CommandHandler = async (ctx) => {
  const planId = positional(ctx, 'preview', 'planId');
  const result = await previewPlan(planId, ctx.runtime);
  emit(ctx, result, result.review);
  return 0;
};

const approve: CommandHandler = async (ctx) => {
  const planId = positional(ctx, 'approve', 'planId');
  const { runtime, io } = ctx;
  // Both arguments are io.stdin: it is the terminal the person types in.
  if (!isInteractive(io.stdin, io.stdin)) {
    throw new AutopilotError('approval_required', 'approve must be run by a person in an interactive terminal.', {
      hint: 'Run it yourself in a terminal, or use: autopilot-marketing review <planId>',
    });
  }
  const result = await previewPlan(planId, runtime);
  // The review is shown as text even with --json: it is what the person approves.
  const say = ctx.json ? io.stderr : io.stdout;
  say(`${result.review}\n`);
  if (!result.policy.allowed) {
    const text = 'The policy denies this plan. It cannot be approved.';
    emit(ctx, { planId, approved: false, reason: 'policy_denied' }, text);
    return 1;
  }
  const approver = os.userInfo().username;
  const current: Plan = result.plan;
  if (!(await io.confirm('Approve exactly these changes? [y/N] '))) {
    runtime.ledger.append({
      event: 'plan.rejected',
      actor: { kind: 'human', id: approver },
      accountId: current.accountId,
      planId: current.id,
      data: { method: 'tty', planDigest: current.digest, reviewDigest: result.reviewDigest },
    });
    runtime.store.savePlan({ ...current, status: 'rejected' });
    emit(ctx, { planId, approved: false, reason: 'rejected' }, 'Rejected. Nothing was changed.');
    return 1;
  }
  const receipt = runtime.approvals.issue({
    plan: current,
    policyDigest: result.policy.policyDigest,
    reviewDigest: result.reviewDigest,
    method: 'tty',
    approver,
    now: runtime.now(),
  });
  runtime.ledger.append({
    event: 'plan.approved',
    actor: { kind: 'human', id: approver },
    accountId: current.accountId,
    planId: current.id,
    data: {
      receiptId: receipt.id,
      method: 'tty',
      planDigest: receipt.planDigest,
      reviewDigest: receipt.reviewDigest,
      expiresAt: receipt.expiresAt,
    },
  });
  emit(
    ctx,
    { planId, approved: true, receiptId: receipt.id, expiresAt: receipt.expiresAt },
    [
      `Receipt: ${receipt.id}`,
      `Expires: ${receipt.expiresAt}`,
      `Now run: autopilot-marketing apply ${planId} --live (or ask your agent to call plan_apply with dryRun false)`,
    ].join('\n'),
  );
  return 0;
};

const review: CommandHandler = async (ctx) => {
  const planId = positional(ctx, 'review', 'planId');
  const port = intFlag(ctx, 'review', 'port');
  const handle = await startReviewServer(planId, ctx.runtime, port === undefined ? {} : { port });
  const say = ctx.json ? ctx.io.stderr : ctx.io.stdout;
  say(`Review page: ${handle.url}\nOpen it in your browser to approve or reject.\n`);
  let result: 'approved' | 'rejected' | 'expired';
  try {
    result = await handle.done;
  } finally {
    handle.close();
  }
  emit(ctx, { planId, result }, `Result: ${result}`);
  return result === 'approved' ? 0 : 1;
};

const apply: CommandHandler = async (ctx) => {
  const planId = positional(ctx, 'apply', 'planId');
  const receiptId = stringFlag(ctx, 'apply', 'receipt');
  const dryRun = ctx.flags.live !== true;
  const outcome = await applyPlan(planId, ctx.runtime, {
    dryRun,
    actor: { kind: 'human', id: os.userInfo().username },
    ...(receiptId === undefined ? {} : { receiptId }),
  });
  const lines = outcomeLines(outcome);
  if (dryRun) lines.push('Nothing was changed. Add --live to apply after approval.');
  emit(ctx, outcome, lines.join('\n'));
  return outcome.failed > 0 || outcome.unknown > 0 ? 1 : 0;
};

const revert: CommandHandler = async (ctx) => {
  const planId = positional(ctx, 'revert', 'planId');
  const created = await createRevertPlan(planId, ctx.runtime);
  const result = await previewPlan(created.id, ctx.runtime);
  emit(ctx, { planId: created.id, revertsPlanId: planId, preview: result }, `Revert plan: ${created.id}\n\n${result.review}`);
  return 0;
};

const run: CommandHandler = async (ctx) => {
  const accountId = positional(ctx, 'run', 'accountId');
  const result = await runCycle(ctx.runtime, { accountId, ...daysInput(ctx, 'run') });
  const score = result.audit.score;
  const lines = [
    `Audit: ${result.audit.id}`,
    `Score: ${score.value === null ? 'n/a (insufficient evidence)' : `${score.value}/100${score.grade === null ? '' : ` (${score.grade})`}`}`,
    `Findings: ${result.audit.findings.length}`,
  ];
  if (result.plan !== null) lines.push(`Plan: ${result.plan.id} (${result.plan.actions.length} actions)`);
  if (result.outcome === null) {
    lines.push('Applied: nothing');
  } else {
    lines.push(...outcomeLines(result.outcome).slice(1));
  }
  lines.push(`Next: ${result.next}`);
  emit(
    ctx,
    {
      snapshotId: result.snapshot.id,
      auditId: result.audit.id,
      score: score.value,
      grade: score.grade,
      findings: result.audit.findings.length,
      planId: result.plan?.id ?? null,
      outcome: result.outcome,
      applyError: result.applyError,
      next: result.next,
    },
    lines.join('\n'),
  );
  // Idle cycles (observe, nothing to change, awaiting approval, policy denial) are not failures.
  if (result.applyError !== null) return 1;
  return result.outcome !== null && (result.outcome.failed > 0 || result.outcome.unknown > 0) ? 1 : 0;
};

/** snapshot, audit, report, plan, preview, approve, review, apply, revert, run. */
export const workCommands: Record<string, CommandHandler> = {
  snapshot,
  audit,
  report,
  plan,
  preview,
  approve,
  review,
  apply,
  revert,
  run,
};
