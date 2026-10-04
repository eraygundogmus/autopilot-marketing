import { runAudit } from '../audit/engine';
import { AutopilotError } from '../core/errors';
import { kpis, metric } from '../core/metrics';
import { formatMoney } from '../core/money';
import type {
  AccountConfig,
  ActionDraft,
  AuditReport,
  ClaimJudgment,
  CopyJudgment,
  CopyVariant,
  Finding,
  JsonObject,
  JsonValue,
  JudgmentUsage,
  Row,
  Runtime,
  TermJudgment,
} from '../core/types';
import { judgeFor, localJudge } from '../judgment/sharing';
import { withJudgmentUsage } from '../judgment/usage';
import { rowsShared, snapshotTotals } from './data';

const DEFAULT_TERM_LIMIT = 60;
const MAX_TERM_LIMIT = 200;
const MAX_COPY_VARIANTS = 20;
const MAX_CLAIMS = 30;
const MAX_EVIDENCE_CAMPAIGNS = 50;

function businessOf(runtime: Runtime, account: AccountConfig): string | undefined {
  return account.business ?? runtime.config.business?.description;
}

/** Audits a stored snapshot, stores the report and logs it. */
export async function auditSnapshot(
  runtime: Runtime,
  input: { snapshotId: string; checkIds?: string[]; judgments?: boolean },
): Promise<AuditReport> {
  const snapshot = runtime.store.getSnapshot(input.snapshotId);
  const account = runtime.account(snapshot.accountId);
  const business = businessOf(runtime, account);
  const { value: report, usage } = await withJudgmentUsage(
    runtime,
    { operation: 'audit', accountId: account.id },
    () =>
      runAudit({
        snapshot,
        account: { ...account, ...(business === undefined ? {} : { business }) },
        thresholds: runtime.config.thresholds,
        judge: input.judgments === false ? null : judgeFor(runtime, account),
        ...(input.checkIds === undefined ? {} : { checkIds: input.checkIds }),
        now: runtime.now(),
      }),
  );
  // What this audit used, not what the process has used since it started.
  report.judgment = usage;
  runtime.store.saveAudit(report);
  runtime.ledger.append({
    event: 'audit.run',
    actor: { kind: 'system', id: 'autopilot' },
    accountId: report.accountId,
    data: {
      auditId: report.id,
      snapshotId: snapshot.id,
      score: report.score.value,
      findings: report.findings.length,
      judgmentMode: report.judgment.mode,
      costUsd: report.judgment.costUsd,
    },
  });
  return report;
}

/** A finding with the full rows its evidence points to. */
export function findingEvidence(
  runtime: Runtime,
  input: { auditId: string; findingId: string },
): { finding: Finding; rows: Array<{ dataset: string; row: Row }>; withheld?: number } {
  const audit = runtime.store.getAudit(input.auditId);
  const finding = audit.findings.find((candidate) => candidate.id === input.findingId);
  if (!finding) {
    throw new AutopilotError('not_found', `finding ${input.findingId} is not in audit ${input.auditId}`, {
      hint: 'use a finding id from this audit report',
    });
  }
  if (!rowsShared(runtime, finding.accountId)) return { finding, rows: [], withheld: finding.evidence.length };
  const snapshot = runtime.store.getSnapshot(finding.snapshotId);
  const rows: Array<{ dataset: string; row: Row }> = [];
  for (const ref of finding.evidence) {
    const row = (snapshot.datasets[ref.dataset] ?? []).find((candidate) => candidate.id === ref.rowId);
    if (row) rows.push({ dataset: ref.dataset, row });
  }
  return { finding, rows };
}

export interface TermsResult {
  judgments: Array<TermJudgment & { cost?: number; clicks?: number; conversions?: number; campaignId?: string }>;
  /** Negative keyword drafts for terms judged irrelevant or competitor in the `act` band. */
  negatives: ActionDraft[];
  usage: JudgmentUsage;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_TERM_LIMIT;
  return Math.min(MAX_TERM_LIMIT, Math.max(1, Math.floor(limit)));
}

export async function judgeTerms(
  runtime: Runtime,
  input: { accountId: string; snapshotId?: string; terms?: string[]; minCost?: number; limit?: number },
): Promise<TermsResult> {
  const account = runtime.account(input.accountId);
  const limit = clampLimit(input.limit);

  let terms: string[];
  let currency = account.currency ?? 'XXX';
  // First row per term text; a term can appear in several campaigns, the costliest one wins.
  const source = new Map<string, Row>();

  if (input.terms !== undefined) {
    terms = [...new Set(input.terms.map((term) => term.trim()).filter((term) => term.length > 0))].slice(0, limit);
  } else if (input.snapshotId !== undefined) {
    const snapshot = runtime.store.getSnapshot(input.snapshotId);
    if (snapshot.accountId !== account.id) {
      throw new AutopilotError(
        'invalid_input',
        `snapshot ${snapshot.id} belongs to account ${snapshot.accountId}, not ${account.id}`,
      );
    }
    if (!rowsShared(runtime, account.id)) {
      throw new AutopilotError(
        'policy_denied',
        "The owner's sharing policy keeps the rows of this account on this machine, so its search terms are not listed.",
        { hint: 'Pass the terms to judge in `terms`, or work from the findings of audit_run.' },
      );
    }
    currency = snapshot.currency;
    const minCost = input.minCost ?? 0;
    const candidates = (snapshot.datasets.search_terms ?? [])
      .filter((row) => metric(row, 'conversions') === 0 && metric(row, 'cost') >= minCost)
      .sort((a, b) => metric(b, 'cost') - metric(a, 'cost'));
    for (const row of candidates) {
      const text = (row.name ?? '').trim();
      if (text.length === 0 || source.has(text)) continue;
      source.set(text, row);
      if (source.size >= limit) break;
    }
    terms = [...source.keys()];
  } else {
    throw new AutopilotError('invalid_input', 'either terms or snapshotId is required', {
      hint: 'pass a list of search terms, or the id of a snapshot that has a search_terms dataset',
    });
  }

  const { value: judged, usage } = await withJudgmentUsage(
    runtime,
    { operation: 'judge_terms', accountId: account.id },
    async () =>
      terms.length === 0
        ? []
        : judgeFor(runtime, account).classifyTerms({
            business: businessOf(runtime, account) ?? '',
            brandTerms: account.brandTerms ?? [],
            terms,
          }),
  );

  const judgments: TermsResult['judgments'] = judged.map((judgment) => {
    const row = source.get(judgment.term);
    if (!row) return judgment;
    return {
      ...judgment,
      cost: metric(row, 'cost'),
      clicks: metric(row, 'clicks'),
      conversions: metric(row, 'conversions'),
      ...(row.campaignId === undefined ? {} : { campaignId: row.campaignId }),
    };
  });

  const negatives: ActionDraft[] = [];
  if (account.platform === 'google_ads') {
    for (const judgment of judgments) {
      if (judgment.band !== 'act') continue;
      if (judgment.label !== 'irrelevant' && judgment.label !== 'competitor') continue;
      if (judgment.campaignId === undefined) continue;
      negatives.push({
        kind: 'google_ads.negative_keyword.add',
        target: { level: 'campaign', id: judgment.campaignId },
        params: { text: judgment.term, matchType: 'EXACT' },
        rationale: `Search term "${judgment.term}" spent ${formatMoney(judgment.cost ?? 0, currency)} with no conversions and was judged ${judgment.label}.`,
      });
    }
  }

  return { judgments, negatives, usage };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export async function judgeCopy(
  runtime: Runtime,
  input: { accountId: string; variants: CopyVariant[] },
): Promise<{ judgments: CopyJudgment[]; usage: JudgmentUsage }> {
  const account = runtime.account(input.accountId);
  const variants: unknown = input.variants;
  if (!Array.isArray(variants) || variants.length < 1 || variants.length > MAX_COPY_VARIANTS) {
    throw new AutopilotError('invalid_input', `variants must hold 1 to ${MAX_COPY_VARIANTS} entries`);
  }
  input.variants.forEach((variant, index) => {
    if (!isNonEmptyString(variant?.id) || !isNonEmptyString(variant?.body)) {
      throw new AutopilotError('invalid_input', `variant ${index + 1} needs a non-empty id and body`);
    }
  });
  const { value: judgments, usage } = await withJudgmentUsage(
    runtime,
    { operation: 'judge_copy', accountId: account.id },
    () =>
      judgeFor(runtime, account).reviewCopy({
        platform: account.platform,
        business: businessOf(runtime, account) ?? '',
        variants: input.variants,
      }),
  );
  return { judgments, usage };
}

function flattenCampaign(row: Row): JsonObject {
  const flat: JsonObject = { id: row.id };
  if (row.name !== undefined) flat.name = row.name;
  for (const [key, value] of Object.entries(row.attrs)) flat[key] = value;
  for (const [key, value] of Object.entries(kpis(row.metrics))) flat[key] = value;
  return flat;
}

/** Checks statements against a snapshot's KPIs, an audit's findings, or text the caller supplies. */
export async function judgeClaims(
  runtime: Runtime,
  input: { claims: string[]; snapshotId?: string; auditId?: string; evidence?: string },
): Promise<{ judgments: ClaimJudgment[]; usage: JudgmentUsage }> {
  const claims: unknown = input.claims;
  if (
    !Array.isArray(claims) ||
    claims.length < 1 ||
    claims.length > MAX_CLAIMS ||
    !claims.every((claim) => isNonEmptyString(claim))
  ) {
    throw new AutopilotError('invalid_input', `claims must hold 1 to ${MAX_CLAIMS} non-empty statements`);
  }

  const evidence: JsonObject = {};
  // Stored data of an account whose owner turned judgments off never goes to Jev.
  const sources: string[] = [];
  if (input.auditId !== undefined) {
    const audit = runtime.store.getAudit(input.auditId);
    sources.push(audit.accountId);
    // The JSON round trip drops absent impacts and yields a plain JSON value.
    evidence.audit = JSON.parse(
      JSON.stringify({
        score: audit.score,
        totals: audit.totals,
        findings: audit.findings.map((finding) => ({
          title: finding.title,
          observation: finding.observation,
          impact: finding.impact,
        })),
      }),
    ) as JsonValue;
  }
  if (input.snapshotId !== undefined) {
    const snapshot = runtime.store.getSnapshot(input.snapshotId);
    sources.push(snapshot.accountId);
    const totals = snapshotTotals(snapshot);
    evidence.snapshot = {
      dateRange: { ...snapshot.dateRange },
      currency: snapshot.currency,
      totals: totals === null ? null : { ...totals },
      campaigns: (snapshot.datasets.campaigns ?? []).slice(0, MAX_EVIDENCE_CAMPAIGNS).map(flattenCampaign),
    };
  }
  if (isNonEmptyString(input.evidence)) evidence.text = input.evidence;

  if (Object.keys(evidence).length === 0) {
    throw new AutopilotError('invalid_input', 'no evidence to check the claims against', {
      hint: 'pass a snapshotId, an auditId or evidence text',
    });
  }

  const restricted = sources.some(
    (id) => runtime.config.accounts.find((account) => account.id === id)?.sharing?.judgments === false,
  );
  const judge = restricted ? localJudge(runtime) : runtime.judge;
  const { value: judgments, usage } = await withJudgmentUsage(runtime, { operation: 'judge_claims' }, () =>
    judge.verifyClaims({ claims: input.claims, evidence }),
  );
  return { judgments, usage };
}
