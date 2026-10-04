import { AutopilotError } from '../core/errors';
import { shortId } from '../core/ids';
import { SEVERITIES } from '../core/types';
import type {
  AccountConfig,
  AuditReport,
  CheckDefinition,
  CheckOutcome,
  CheckResult,
  Finding,
  FindingDraft,
  Judge,
  JudgmentUsage,
  Snapshot,
  Thresholds,
} from '../core/types';
import { ga4Checks } from './checks/ga4';
import { googleAdsChecks } from './checks/google-ads';
import { mauticChecks } from './checks/mautic';
import { metaAdsChecks } from './checks/meta-ads';
import { searchConsoleChecks } from './checks/search-console';
import { scoreAudit } from './scoring';

/**
 * Keywords, search terms, devices and the campaign itself are different cuts of the same spend, so
 * their waste must not be added together. Per campaign, only the check with the largest total
 * counts; the result is a floor, not a sum of every finding.
 */
function nonOverlappingWaste(findings: Finding[]): number {
  const perCampaign = new Map<string, Map<string, number>>();
  for (const finding of findings) {
    if (finding.impact?.kind !== 'wasted_spend' || finding.dataStatus !== 'sufficient') continue;
    const entity = finding.entity;
    const campaign = entity?.campaignId ?? (entity?.level === 'campaign' ? entity.id : `${entity?.level ?? 'account'}:${entity?.id ?? ''}`);
    const perCheck = perCampaign.get(campaign) ?? new Map<string, number>();
    perCheck.set(finding.checkId, (perCheck.get(finding.checkId) ?? 0) + finding.impact.monthly);
    perCampaign.set(campaign, perCheck);
  }
  let total = 0;
  for (const perCheck of perCampaign.values()) total += Math.max(...perCheck.values());
  return total;
}

/** Every registered check, in a stable order. */
export function allChecks(): CheckDefinition[] {
  return [...googleAdsChecks, ...metaAdsChecks, ...ga4Checks, ...searchConsoleChecks, ...mauticChecks];
}

const NO_JUDGMENT: JudgmentUsage = {
  mode: 'fallback',
  model: null,
  requests: 0,
  failed: 0,
  skipped: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
};

/** The reason a check cannot be evaluated, or null when it can run. */
function blockedReason(check: CheckDefinition, snapshot: Snapshot, account: AccountConfig, judge: Judge | null): string | null {
  for (const dataset of check.requires) {
    if (snapshot.datasets[dataset] === undefined || snapshot.coverage[dataset]?.status === 'missing') {
      return `dataset ${dataset} is not in this snapshot`;
    }
  }
  for (const need of check.needs ?? []) {
    if (need === 'target_cpa' && account.targets?.cpa === undefined) return 'set targets.cpa for this account';
    if (need === 'target_roas' && account.targets?.roas === undefined) return 'set targets.roas for this account';
    if (need === 'brand_terms' && (account.brandTerms === undefined || account.brandTerms.length === 0)) {
      return 'set brandTerms for this account';
    }
    if (need === 'judgment' && judge === null) return 'judgments are disabled for this run';
  }
  return null;
}

function toFinding(check: CheckDefinition, draft: FindingDraft, snapshot: Snapshot): Finding {
  const id = shortId('fnd', {
    checkId: check.id,
    snapshotId: snapshot.id,
    entity: draft.entity ? { level: draft.entity.level, id: draft.entity.id } : null,
    title: draft.title,
  });
  const partial = [...check.requires, ...draft.evidence.map((ref) => ref.dataset)].some(
    (dataset) => snapshot.coverage[dataset]?.status === 'partial',
  );
  return {
    ...draft,
    id,
    checkId: check.id,
    category: check.category,
    platform: snapshot.platform,
    accountId: snapshot.accountId,
    snapshotId: snapshot.id,
    severity: draft.severity ?? check.severity,
    dataStatus: draft.dataStatus ?? 'sufficient',
    needsReview: partial || (draft.needsReview ?? false),
    suggestedActions: (draft.suggestedActions ?? []).map((action) => ({ ...action, findingIds: [id] })),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Runs the checks for the snapshot's platform. A check whose required dataset is missing, or whose
 * `needs` are unmet, is `unknown` with a reason; a check that throws is `unknown` too.
 */
export async function runAudit(input: {
  snapshot: Snapshot;
  account: AccountConfig;
  thresholds: Thresholds;
  judge: Judge | null;
  checkIds?: string[];
  /** Defaults to `allChecks()`. */
  checks?: CheckDefinition[];
  now: Date;
}): Promise<AuditReport> {
  const { snapshot, account, thresholds, judge, checkIds, now } = input;
  let pool = (input.checks ?? allChecks()).filter((check) => check.platform === snapshot.platform);
  if (checkIds !== undefined) {
    const known = new Set(pool.map((check) => check.id));
    const missing = checkIds.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new AutopilotError('invalid_input', `unknown check id for ${snapshot.platform}: ${missing.join(', ')}`, {
        hint: 'list the available checks for this platform and pass their ids',
      });
    }
    const wanted = new Set(checkIds);
    pool = pool.filter((check) => wanted.has(check.id));
  }

  const results: CheckResult[] = [];
  const findings: Finding[] = [];
  const conversionFindingIds = new Set<string>();
  const seen = new Set<string>();
  let trackingFailed = false;

  for (const check of pool) {
    let outcome: CheckOutcome;
    const blocked = blockedReason(check, snapshot, account, judge);
    if (blocked !== null) {
      outcome = { status: 'unknown', reason: blocked, findings: [] };
    } else {
      try {
        outcome = await check.run({ snapshot, account, thresholds, judge });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outcome = { status: 'unknown', reason: `check failed: ${message}`, findings: [] };
      }
    }

    const findingIds: string[] = [];
    for (const draft of outcome.findings) {
      const finding = toFinding(check, draft, snapshot);
      // The id is the identity: a check that reports the same entity and title twice yields one finding.
      if (seen.has(finding.id)) continue;
      seen.add(finding.id);
      findings.push(finding);
      findingIds.push(finding.id);
      if (check.usesConversions === true) conversionFindingIds.add(finding.id);
    }
    // A critical tracking finding (conversions stopped, nothing is counted) makes conversion counts
    // untrustworthy. A lesser one (a micro-conversion counted as primary) is reported on its own.
    if (
      check.category === 'tracking' &&
      outcome.status === 'fail' &&
      findings.some((finding) => finding.checkId === check.id && finding.severity === 'critical')
    ) {
      trackingFailed = true;
    }

    results.push({
      checkId: check.id,
      category: check.category,
      severity: check.severity,
      title: check.title,
      status: outcome.status,
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      findingIds,
    });
  }

  for (const finding of findings) {
    if (trackingFailed && conversionFindingIds.has(finding.id)) {
      finding.dataStatus = 'tracking_issue';
      finding.needsReview = true;
    }
    if (finding.dataStatus !== 'sufficient') finding.suggestedActions = [];
  }

  const sorted = [...findings].sort((a, b) => {
    const aImpact = a.impact?.monthly ?? Number.NEGATIVE_INFINITY;
    const bImpact = b.impact?.monthly ?? Number.NEGATIVE_INFINITY;
    if (aImpact !== bImpact) return bImpact > aImpact ? 1 : -1;
    return SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity);
  });

  const wasted = nonOverlappingWaste(sorted);

  return {
    id: shortId('aud', {
      snapshotId: snapshot.id,
      checks: results.map((result) => `${result.checkId}:${result.status}`),
      at: now.toISOString(),
    }),
    accountId: snapshot.accountId,
    platform: snapshot.platform,
    snapshotId: snapshot.id,
    dateRange: snapshot.dateRange,
    currency: snapshot.currency,
    createdAt: now.toISOString(),
    score: scoreAudit(results),
    checks: results,
    findings: sorted,
    totals: {
      wastedSpendMonthly: round2(wasted),
      findings: sorted.length,
      needsReview: sorted.filter((finding) => finding.needsReview).length,
    },
    judgment: judge?.usage() ?? { ...NO_JUDGMENT },
  };
}
