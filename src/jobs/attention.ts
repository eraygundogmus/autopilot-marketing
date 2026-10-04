import type { AuditReport, Finding } from '../core/types';

export interface AttentionInput {
  /** This run's audit, when the task made one. */
  audit: AuditReport | null;
  /** The audit of the previous succeeded run of the same schedule, when there is one. */
  previousAudit: AuditReport | null;
  /** Set for a `cycle` run that created a plan. */
  plan?: { id: string; awaitingApproval: boolean; applyError: string | null };
}

const MAX_LISTED = 3;
const MAX_TITLE_CHARS = 120;
const MAX_ERROR_CHARS = 200;
const SCORE_DROP_POINTS = 10;

function findingKey(finding: Finding): string {
  const entity = finding.entity;
  return `${finding.checkId}|${entity?.level ?? ''}|${entity?.id ?? ''}`;
}

/** Titles come from the ad account: they are quoted as data, never as part of the sentence. */
function quoteTitle(title: string): string {
  const clean = title.replace(/\s+/g, ' ').trim().replace(/"/g, "'").slice(0, MAX_TITLE_CHARS);
  return `"${clean}"`;
}

/** Why a person should look at this run, decided by rules. Empty when nothing stands out. */
export function attentionReasons(input: AttentionInput): string[] {
  const reasons: string[] = [];
  const { audit, previousAudit, plan } = input;

  if (audit) {
    const previousKeys = new Set((previousAudit?.findings ?? []).map(findingKey));
    const fresh = audit.findings.filter((finding) => !previousKeys.has(findingKey(finding)));

    const serious = fresh.filter(
      (finding) => finding.severity === 'critical' || finding.severity === 'high',
    );
    const listed = serious.slice(0, MAX_LISTED);
    if (serious.length > 0) {
      const more = serious.length - listed.length;
      reasons.push(
        `${serious.length} new critical or high finding(s): ` +
          listed.map((finding) => quoteTitle(finding.title)).join('; ') +
          (more > 0 ? ` and ${more} more` : ''),
      );
    }

    const before = previousAudit?.score.value ?? null;
    const now = audit.score.value;
    if (before !== null && now !== null && before - now >= SCORE_DROP_POINTS) {
      reasons.push(`Score fell from ${before} to ${now}.`);
    }

    const listedSet = new Set<Finding>(listed);
    const tracking = fresh
      .filter((finding) => finding.dataStatus === 'tracking_issue' && !listedSet.has(finding))
      .slice(0, MAX_LISTED);
    for (const finding of tracking) {
      reasons.push(`Tracking problem: ${quoteTitle(finding.title)}`);
    }
  }

  if (plan) {
    if (plan.awaitingApproval) reasons.push(`Plan ${plan.id} is waiting for approval.`);
    if (plan.applyError !== null) {
      reasons.push(`Plan ${plan.id} was not applied: ${plan.applyError.slice(0, MAX_ERROR_CHARS)}`);
    }
  }

  return [...new Set(reasons)];
}
