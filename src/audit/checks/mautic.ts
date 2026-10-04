import { metric } from '../../core/metrics';
import type { CheckContext, CheckDefinition, CheckOutcome, DatasetName, EntityLevel, FindingDraft, Row } from '../../core/types';
import { activeRows, entity, evidence } from '../helpers';

const MAX_FINDINGS = 25;
/** Emails sent before a rate is judged. */
const MIN_SENT = 200;

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function quote(text: string): string {
  return `"${text}"`;
}

/** `attrs.published` as a boolean; null when absent or not recognisable (CSV sources carry strings). */
function published(row: Row): boolean | null {
  const value = row.attrs['published'];
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === 'true' || value === '1') return true;
  if (value === 0 || value === 'false' || value === '0') return false;
  return null;
}

interface RateCheck {
  numerator: 'unsubscribed' | 'bounced' | 'read';
  threshold: number;
  direction: 'above' | 'below';
  title: string;
  /** Names the rate inside the observation, e.g. "an unsubscribe rate". */
  rateName: string;
  recommendation: string;
}

function emailRate(ctx: CheckContext, check: RateCheck): CheckOutcome {
  const judged: Array<{ row: Row; sent: number; count: number; rate: number }> = [];
  for (const row of activeRows(ctx.snapshot, 'emails')) {
    const sent = metric(row, 'sent');
    const count = row.metrics[check.numerator];
    if (sent < MIN_SENT || count === undefined) continue;
    judged.push({ row, sent, count, rate: count / sent });
  }
  if (judged.length === 0) {
    return {
      status: 'not_applicable',
      reason: `No email has ${MIN_SENT} sends or more with a '${check.numerator}' count.`,
      findings: [],
    };
  }
  const above = check.direction === 'above';
  const findings: FindingDraft[] = judged
    .filter((item) => (above ? item.rate > check.threshold : item.rate < check.threshold))
    .sort((a, b) => (above ? b.rate - a.rate : a.rate - b.rate))
    .slice(0, MAX_FINDINGS)
    .map(({ row, sent, count, rate }) => ({
      entity: entity('email', row),
      title: check.title,
      observation: `Email ${quote(row.name ?? row.id)} has ${check.rateName} of ${pct(
        rate,
      )} (${count} of ${sent} sent), ${check.direction} the ${pct(check.threshold)} threshold.`,
      recommendation: check.recommendation,
      evidence: [evidence(ctx.snapshot, 'emails', row, ['sent', check.numerator])],
    }));
  return { status: findings.length > 0 ? 'fail' : 'pass', findings };
}

function contactFindings(
  ctx: CheckContext,
  dataset: DatasetName,
  level: EntityLevel,
  judged: Row[],
  trips: (row: Row) => boolean,
  describe: (row: Row) => Pick<FindingDraft, 'title' | 'observation' | 'recommendation'>,
): CheckOutcome {
  const findings: FindingDraft[] = judged
    .filter(trips)
    .sort((a, b) => metric(b, 'contacts') - metric(a, 'contacts'))
    .slice(0, MAX_FINDINGS)
    .map((row) => ({
      entity: entity(level, row),
      ...describe(row),
      evidence: [evidence(ctx.snapshot, dataset, row, ['contacts'])],
    }));
  return { status: findings.length > 0 ? 'fail' : 'pass', findings };
}

function emptySegments(ctx: CheckContext): CheckOutcome {
  const judged = activeRows(ctx.snapshot, 'segments').filter(
    (row) => published(row) === true && row.metrics['contacts'] !== undefined,
  );
  if (judged.length === 0) {
    return { status: 'not_applicable', reason: 'No published segment reports a contact count.', findings: [] };
  }
  return contactFindings(
    ctx,
    'segments',
    'segment',
    judged,
    (row) => row.metrics['contacts'] === 0,
    (row) => ({
      title: 'Published segment is empty',
      observation: `Segment ${quote(row.name ?? row.id)} is published and holds 0 contacts.`,
      recommendation: 'Check the segment filters, or unpublish the segment if nothing depends on it.',
    }),
  );
}

function unpublishedCampaignWithContacts(ctx: CheckContext): CheckOutcome {
  const judged = activeRows(ctx.snapshot, 'lifecycle_campaigns').filter((row) => published(row) !== null);
  if (judged.length === 0) {
    return { status: 'not_applicable', reason: 'No campaign reports whether it is published.', findings: [] };
  }
  return contactFindings(
    ctx,
    'lifecycle_campaigns',
    'campaign',
    judged,
    (row) => published(row) === false && metric(row, 'contacts') > 0,
    (row) => ({
      title: 'Contacts wait in an unpublished campaign',
      observation: `Campaign ${quote(row.name ?? row.id)} is unpublished and holds ${metric(
        row,
        'contacts',
      )} contacts, who are waiting in a campaign that does not run.`,
      recommendation: 'Publish the campaign, or move its contacts to a campaign that runs.',
    }),
  );
}

export const mauticChecks: CheckDefinition[] = [
  {
    id: 'mautic.lifecycle.high_unsubscribe',
    platform: 'mautic',
    category: 'lifecycle',
    severity: 'high',
    title: 'Emails keep their subscribers',
    requires: ['emails'],
    run: (ctx) =>
      emailRate(ctx, {
        numerator: 'unsubscribed',
        threshold: ctx.thresholds.highUnsubscribeRate,
        direction: 'above',
        title: 'High unsubscribe rate',
        rateName: 'an unsubscribe rate',
        recommendation: 'Review who receives this email and how often, and narrow the segment to people who asked for it.',
      }),
  },
  {
    id: 'mautic.lifecycle.high_bounce',
    platform: 'mautic',
    category: 'lifecycle',
    severity: 'high',
    title: 'Emails reach the inbox',
    requires: ['emails'],
    run: (ctx) =>
      emailRate(ctx, {
        numerator: 'bounced',
        threshold: ctx.thresholds.highBounceRate,
        direction: 'above',
        title: 'High bounce rate',
        rateName: 'a bounce rate',
        recommendation: 'Clean the list of addresses that bounce and check sender authentication (SPF, DKIM, DMARC).',
      }),
  },
  {
    id: 'mautic.lifecycle.low_open_rate',
    platform: 'mautic',
    category: 'lifecycle',
    severity: 'medium',
    title: 'Emails are opened',
    requires: ['emails'],
    run: (ctx) =>
      emailRate(ctx, {
        numerator: 'read',
        threshold: ctx.thresholds.lowOpenRate,
        direction: 'below',
        title: 'Low open rate',
        rateName: 'an open rate',
        recommendation: 'Test a clearer subject line and sender name, and send to contacts who opened recently.',
      }),
  },
  {
    id: 'mautic.lifecycle.empty_segments',
    platform: 'mautic',
    category: 'lifecycle',
    severity: 'low',
    title: 'Published segments hold contacts',
    requires: ['segments'],
    run: emptySegments,
  },
  {
    id: 'mautic.lifecycle.unpublished_campaign_with_contacts',
    platform: 'mautic',
    category: 'lifecycle',
    severity: 'medium',
    title: 'Campaigns holding contacts are published',
    requires: ['lifecycle_campaigns'],
    run: unpublishedCampaignWithContacts,
  },
];
