import { metric } from '../../core/metrics';
import type { CheckContext, CheckDefinition, CheckOutcome, EntityRef, FindingDraft } from '../../core/types';
import { activeRows, entity, evidence } from '../helpers';

const MAX_FINDINGS = 25;
/** Sessions an account needs before the absence of key events means anything. */
const MIN_ACCOUNT_SESSIONS = 500;
/** Share of sessions without a channel above which tagging is flagged. */
const UNASSIGNED_SHARE = 0.1;
const MIN_PAGE_SESSIONS = 200;
const LOW_ENGAGEMENT_RATE = 0.3;
const UNASSIGNED_NAMES = new Set(['unassigned', '(other)']);

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function quote(text: string): string {
  return `"${text}"`;
}

function accountEntity(ctx: CheckContext): EntityRef {
  return { level: 'account', id: ctx.snapshot.externalAccountId };
}

function noKeyEvents(ctx: CheckContext): CheckOutcome {
  const channels = activeRows(ctx.snapshot, 'channels');
  let sessions = 0;
  let keyEvents = 0;
  for (const row of channels) {
    sessions += metric(row, 'sessions');
    keyEvents += metric(row, 'keyEvents');
  }
  if (sessions < MIN_ACCOUNT_SESSIONS) {
    return {
      status: 'not_applicable',
      reason: `Fewer than ${MIN_ACCOUNT_SESSIONS} sessions in the period (${sessions}).`,
      findings: [],
    };
  }
  if (keyEvents > 0) return { status: 'pass', findings: [] };
  const finding: FindingDraft = {
    entity: accountEntity(ctx),
    title: 'No key events recorded',
    observation: `The property recorded ${sessions} sessions and 0 key events across ${channels.length} channels.`,
    recommendation:
      'Mark the events that represent a lead or a sale as key events in GA4, because without them paid traffic cannot be evaluated.',
    evidence: channels.map((row) => evidence(ctx.snapshot, 'channels', row, ['sessions', 'keyEvents'])),
    impact: { kind: 'risk', monthly: 0, basis: `0 key events on ${sessions} sessions` },
  };
  return { status: 'fail', findings: [finding] };
}

function unassignedTraffic(ctx: CheckContext): CheckOutcome {
  const channels = activeRows(ctx.snapshot, 'channels');
  const total = channels.reduce((sum, row) => sum + metric(row, 'sessions'), 0);
  if (total <= 0) return { status: 'not_applicable', reason: 'No sessions in the period.', findings: [] };
  const unassigned = channels.filter(
    (row) => row.name !== undefined && UNASSIGNED_NAMES.has(row.name.trim().toLowerCase()),
  );
  const sessions = unassigned.reduce((sum, row) => sum + metric(row, 'sessions'), 0);
  const share = sessions / total;
  if (share <= UNASSIGNED_SHARE) return { status: 'pass', findings: [] };
  const finding: FindingDraft = {
    entity: accountEntity(ctx),
    title: 'Too much traffic has no channel',
    observation: `${sessions} of ${total} sessions (${pct(share)}) are in ${unassigned
      .map((row) => quote(row.name ?? row.id))
      .join(' and ')}, above the ${pct(UNASSIGNED_SHARE)} limit.`,
    recommendation:
      'Fix UTM tagging on ads, emails and other campaign links so that these sessions are assigned to a channel.',
    evidence: unassigned.map((row) => evidence(ctx.snapshot, 'channels', row, ['sessions'])),
  };
  return { status: 'fail', findings: [finding] };
}

function lowEngagementLandingPages(ctx: CheckContext): CheckOutcome {
  const pages = activeRows(ctx.snapshot, 'landing_pages').filter((row) => metric(row, 'sessions') >= MIN_PAGE_SESSIONS);
  if (pages.length === 0) {
    return {
      status: 'not_applicable',
      reason: `No landing page has ${MIN_PAGE_SESSIONS} sessions or more.`,
      findings: [],
    };
  }
  const findings: FindingDraft[] = pages
    .filter((row) => metric(row, 'engagedSessions') / metric(row, 'sessions') < LOW_ENGAGEMENT_RATE)
    .sort((a, b) => metric(b, 'sessions') - metric(a, 'sessions'))
    .slice(0, MAX_FINDINGS)
    .map((row) => {
      const sessions = metric(row, 'sessions');
      const engaged = metric(row, 'engagedSessions');
      return {
        entity: entity('page', row),
        title: 'Landing page with low engagement',
        observation: `Landing page ${quote(row.name ?? row.id)} had ${engaged} engaged sessions out of ${sessions} (${pct(
          engaged / sessions,
        )}), below ${pct(LOW_ENGAGEMENT_RATE)}.`,
        recommendation:
          'Check that the page matches what the traffic source promises, loads fast and shows the offer without scrolling.',
        evidence: [evidence(ctx.snapshot, 'landing_pages', row, ['sessions', 'engagedSessions'])],
      };
    });
  return { status: findings.length > 0 ? 'fail' : 'pass', findings };
}

export const ga4Checks: CheckDefinition[] = [
  {
    id: 'ga4.tracking.no_key_events',
    platform: 'ga4',
    category: 'tracking',
    severity: 'critical',
    title: 'Key events are recorded',
    requires: ['channels'],
    run: noKeyEvents,
  },
  {
    id: 'ga4.tracking.unassigned_traffic',
    platform: 'ga4',
    category: 'tracking',
    severity: 'medium',
    title: 'Traffic is assigned to a channel',
    requires: ['channels'],
    run: unassignedTraffic,
  },
  {
    id: 'ga4.structure.low_engagement_landing_pages',
    platform: 'ga4',
    category: 'structure',
    severity: 'low',
    title: 'Landing pages engage visitors',
    requires: ['landing_pages'],
    run: lowEngagementLandingPages,
  },
];
