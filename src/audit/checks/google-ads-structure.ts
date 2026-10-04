import { addDays } from '../../core/dates';
import { attrNumber, attrString, groupBy, metric, monthly } from '../../core/metrics';
import { formatMoney } from '../../core/money';
import type { CheckContext, CheckDefinition, CheckOutcome, EntityRef, FindingDraft, Row } from '../../core/types';
import { activeRows, draft, entity, evidence, referenceCpa } from '../helpers';

const MAX_FINDINGS = 25;
const MAX_RATIONALE = 199;
const WINDOW_DAYS = 7;
const MAX_LISTED_TERMS = 5;

/** A fraction 0..1 as a percentage with one decimal. */
function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function count(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** Account text is data: quoted as it is, never interpreted. */
function quoted(row: Row): string {
  return `"${row.name ?? row.id}"`;
}

function rationale(text: string): string {
  return text.length <= MAX_RATIONALE ? text : `${text.slice(0, MAX_RATIONALE - 3)}...`;
}

function wasteFloor(ctx: CheckContext): number {
  const cpa = referenceCpa(ctx);
  return cpa !== null ? cpa * ctx.thresholds.wasteCpaMultiple : ctx.thresholds.wasteMinCost;
}

function accountEntity(ctx: CheckContext): EntityRef {
  const ref: EntityRef = { level: 'account', id: ctx.account.id };
  if (ctx.account.label !== undefined) ref.name = ctx.account.label;
  return ref;
}

interface Ranked {
  finding: FindingDraft;
  /** Sort key, largest first. */
  weight: number;
}

function outcome(ranked: Ranked[]): CheckOutcome {
  if (ranked.length === 0) return { status: 'pass', findings: [] };
  const findings = [...ranked]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_FINDINGS)
    .map((item) => item.finding);
  return { status: 'fail', findings };
}

function notApplicable(reason: string): CheckOutcome {
  return { status: 'not_applicable', reason, findings: [] };
}

function runBudgetLimitedWinners(ctx: CheckContext): CheckOutcome {
  const { snapshot, thresholds } = ctx;
  const currency = snapshot.currency;
  const targetCpa = ctx.account.targets?.cpa;
  const targetRoas = ctx.account.targets?.roas;
  // The CPA target when one is set, otherwise the account CPA.
  const reference = referenceCpa(ctx);
  const candidates = activeRows(snapshot, 'campaigns').filter(
    (row) => attrNumber(row, 'lostIsBudget') !== null && metric(row, 'conversions') >= thresholds.minConversions,
  );
  if (candidates.length === 0) {
    return notApplicable(
      `no enabled campaign reports budget-lost impression share with at least ${thresholds.minConversions} conversions`,
    );
  }
  const ranked: Ranked[] = [];
  for (const row of candidates) {
    const lost = attrNumber(row, 'lostIsBudget') ?? 0;
    const conversions = metric(row, 'conversions');
    const cost = metric(row, 'cost');
    if (lost <= thresholds.budgetLostIs) continue;
    const cpa = cost / conversions;
    if (targetCpa !== undefined && cpa > targetCpa) continue;
    const value = row.metrics['conversionValue'];
    if (targetRoas !== undefined && value !== undefined && cost > 0 && value / cost < targetRoas) continue;

    // Without a CPA target, efficiency is only claimed at or below the account CPA,
    // and that claim is for a person to confirm.
    const efficient = targetCpa !== undefined || reference === null || cpa <= reference;
    const comparison =
      targetCpa !== undefined
        ? ` (target ${formatMoney(targetCpa, currency)}).`
        : reference !== null
          ? `, compared with the account average of ${formatMoney(reference, currency)}; no CPA target is set.`
          : '.';
    const observation =
      `Campaign ${quoted(row)} lost ${pct(lost)} of search impression share to budget while producing ` +
      `${count(conversions)} conversions at ${formatMoney(cpa, currency)} each` +
      comparison;
    const finding: FindingDraft = {
      entity: entity('campaign', row),
      title: efficient ? `Budget limits an efficient campaign: ${quoted(row)}` : `Budget limits a campaign: ${quoted(row)}`,
      observation,
      recommendation: efficient
        ? 'Raise the daily budget in small steps and confirm the cost per conversion holds after each step.'
        : 'Check whether this campaign is worth more budget before raising it: its cost per conversion is above the account average.',
      evidence: [evidence(snapshot, 'campaigns', row, ['cost', 'conversions', 'lostIsBudget', 'dailyBudget'])],
    };
    if (targetCpa === undefined) finding.needsReview = true;
    let weight = 0;
    // A lost share of 1 has no finite estimate.
    if (lost < 1) {
      weight = monthly((conversions * lost) / (1 - lost), snapshot.dateRange);
      finding.impact = {
        kind: 'missed_conversions',
        monthly: weight,
        basis: 'conversions * lostIsBudget / (1 - lostIsBudget), scaled to 30 days',
      };
    }
    const dailyBudget = row.attrs['dailyBudget'];
    if (efficient && typeof dailyBudget === 'number' && Number.isFinite(dailyBudget) && dailyBudget > 0 && row.attrs['sharedBudget'] !== true) {
      finding.suggestedActions = [
        draft(
          'google_ads.campaign.set_daily_budget',
          entity('campaign', row),
          { dailyBudget: Math.round(dailyBudget * 1.15 * 100) / 100 },
          rationale(observation),
        ),
      ];
    }
    ranked.push({ finding, weight });
  }
  return outcome(ranked);
}

function runRankLimited(ctx: CheckContext): CheckOutcome {
  const { snapshot, thresholds } = ctx;
  const candidates = activeRows(snapshot, 'campaigns').filter(
    (row) => attrNumber(row, 'lostIsRank') !== null && metric(row, 'impressions') >= thresholds.minImpressions,
  );
  if (candidates.length === 0) {
    return notApplicable(
      `no enabled campaign reports rank-lost impression share with at least ${thresholds.minImpressions} impressions`,
    );
  }
  const ranked: Ranked[] = [];
  for (const row of candidates) {
    const lost = attrNumber(row, 'lostIsRank') ?? 0;
    if (lost <= thresholds.rankLostIs) continue;
    const impressions = metric(row, 'impressions');
    ranked.push({
      weight: lost * impressions,
      finding: {
        entity: entity('campaign', row),
        title: `Ad rank limits impression share: ${quoted(row)}`,
        observation: `Campaign ${quoted(row)} lost ${pct(lost)} of search impression share to ad rank over ${count(impressions)} impressions.`,
        recommendation: 'Improve Quality Score (ad relevance, expected CTR, landing page experience) and review bids on the keywords that matter.',
        evidence: [evidence(snapshot, 'campaigns', row, ['impressions', 'lostIsRank'])],
      },
    });
  }
  return outcome(ranked);
}

function runLowQualityScore(ctx: CheckContext): CheckOutcome {
  const { snapshot, thresholds } = ctx;
  const scored = activeRows(snapshot, 'keywords').filter((row) => attrNumber(row, 'qualityScore') !== null);
  if (scored.length === 0) return notApplicable('no enabled keyword reports a Quality Score');
  const minCost = wasteFloor(ctx) / 2;
  const ranked: Ranked[] = [];
  for (const row of scored) {
    const score = attrNumber(row, 'qualityScore') ?? 0;
    const cost = metric(row, 'cost');
    if (score > thresholds.lowQualityScore || cost < minCost) continue;
    ranked.push({
      weight: cost,
      finding: {
        entity: entity('keyword', row),
        title: `Low Quality Score keyword: ${quoted(row)}`,
        observation: `Keyword ${quoted(row)} has Quality Score ${count(score)} and cost ${formatMoney(cost, snapshot.currency)} in the period.`,
        recommendation: 'Move the keyword into a tighter ad group with matching ad copy and make the landing page more relevant to it.',
        evidence: [evidence(snapshot, 'keywords', row, ['cost', 'qualityScore'])],
      },
    });
  }
  return outcome(ranked);
}

function runDisapprovedAds(ctx: CheckContext): CheckOutcome {
  const { snapshot } = ctx;
  const ads = activeRows(snapshot, 'ads');
  if (ads.length === 0) return notApplicable('no enabled ads');
  const ranked: Ranked[] = [];
  for (const row of ads) {
    if (attrString(row, 'approvalStatus') !== 'DISAPPROVED') continue;
    const impressions = metric(row, 'impressions');
    ranked.push({
      weight: impressions,
      finding: {
        entity: entity('ad', row),
        title: `Disapproved ad: ${quoted(row)}`,
        observation: `Ad ${quoted(row)} is enabled but disapproved, with ${count(impressions)} impressions in the period.`,
        recommendation: 'Read the policy reason in Google Ads, fix the ad or its landing page, and resubmit it for review.',
        evidence: [evidence(snapshot, 'ads', row, ['impressions'])],
        impact: { kind: 'risk', monthly: 0, basis: 'disapproved ads do not serve' },
      },
    });
  }
  return outcome(ranked);
}

function runConversionDrop(ctx: CheckContext): CheckOutcome {
  const { snapshot, thresholds } = ctx;
  const end = addDays(snapshot.dateRange.end, -thresholds.conversionLagDays);
  const recentStart = addDays(end, -(WINDOW_DAYS - 1));
  const priorEnd = addDays(recentStart, -1);
  const priorStart = addDays(priorEnd, -(WINDOW_DAYS - 1));

  // Daily rows carry no entity status; every dated row counts.
  const dated = (snapshot.datasets.daily ?? []).filter((row) => row.date !== undefined);
  const dates = new Set(dated.map((row) => row.date ?? ''));
  for (let offset = 0; offset < WINDOW_DAYS * 2; offset += 1) {
    if (!dates.has(addDays(priorStart, offset))) {
      return notApplicable(`daily rows do not cover ${priorStart}..${end}`);
    }
  }
  // ISO dates order lexicographically.
  const prior = dated.filter((row) => (row.date ?? '') >= priorStart && (row.date ?? '') <= priorEnd);
  const recent = dated.filter((row) => (row.date ?? '') >= recentStart && (row.date ?? '') <= end);
  const sum = (list: Row[], key: string): number => list.reduce((total, row) => total + metric(row, key), 0);
  const priorConversions = sum(prior, 'conversions');
  const recentConversions = sum(recent, 'conversions');
  const priorClicks = sum(prior, 'clicks');
  const recentClicks = sum(recent, 'clicks');

  if (priorConversions < thresholds.minConversions) {
    return notApplicable(
      `only ${count(priorConversions)} conversions in ${priorStart}..${priorEnd}; ${thresholds.minConversions} are needed to compare weeks`,
    );
  }
  const dropped = recentConversions <= priorConversions - priorConversions * thresholds.conversionDropPct;
  const clicksHeld = recentClicks >= 0.8 * priorClicks;
  if (!dropped || !clicksHeld) return { status: 'pass', findings: [] };

  const fall = 1 - recentConversions / priorConversions;
  return {
    status: 'fail',
    findings: [
      {
        entity: accountEntity(ctx),
        title: 'Conversions fell while clicks held',
        observation:
          `Conversions fell ${pct(fall)}, from ${count(priorConversions)} in ${priorStart}..${priorEnd} to ` +
          `${count(recentConversions)} in ${recentStart}..${end}, while clicks went from ${count(priorClicks)} to ${count(recentClicks)}.`,
        recommendation: 'Check the conversion tag and the conversion action status before changing any bid or budget.',
        evidence: [...prior, ...recent].map((row) => evidence(snapshot, 'daily', row, ['conversions', 'clicks'])),
        impact: { kind: 'risk', monthly: 0, basis: 'conversion-based decisions are unreliable while tracking looks broken' },
      },
    ],
  };
}

function runConversionActions(ctx: CheckContext): CheckOutcome {
  const { snapshot } = ctx;
  const enabled = activeRows(snapshot, 'conversion_actions');
  if (enabled.length === 0) return notApplicable('no enabled conversion actions');
  const primary = enabled.filter((row) => row.attrs['primary'] === true);
  const findings: FindingDraft[] = [];
  if (primary.length === 0) {
    findings.push({
      entity: accountEntity(ctx),
      severity: 'critical',
      title: 'No primary conversion action',
      observation: `None of the ${enabled.length} enabled conversion actions is set as primary, so no primary conversion action feeds bidding.`,
      recommendation: 'Set the conversion action that represents a real business outcome as primary.',
      evidence: enabled.map((row) => evidence(snapshot, 'conversion_actions', row, ['conversions'])),
      impact: { kind: 'risk', monthly: 0, basis: 'bidding has no primary conversion to optimise for' },
    });
  }
  for (const row of primary) {
    const isPageView = attrString(row, 'category') === 'PAGE_VIEW' || /page ?view/i.test(row.name ?? '');
    if (!isPageView) continue;
    findings.push({
      entity: entity('account', row),
      severity: 'medium',
      title: `Page view counted as a primary conversion: ${quoted(row)}`,
      observation:
        `Conversion action ${quoted(row)} is a page view set as primary with ${count(metric(row, 'conversions'))} conversions in the period; ` +
        'a micro-conversion counted as a primary conversion inflates conversions.',
      recommendation: 'Change this conversion action to secondary so bidding and reports rest on real outcomes.',
      evidence: [evidence(snapshot, 'conversion_actions', row, ['conversions'])],
      impact: { kind: 'risk', monthly: 0, basis: 'reported conversions include page views' },
    });
  }
  if (findings.length === 0) return { status: 'pass', findings: [] };
  return { status: 'fail', findings: findings.slice(0, MAX_FINDINGS) };
}

function runBrandInNonBrand(ctx: CheckContext): CheckOutcome {
  const { snapshot } = ctx;
  const brandTerms = (ctx.account.brandTerms ?? []).map((term) => term.trim().toLowerCase()).filter((term) => term !== '');
  if (brandTerms.length === 0) return notApplicable('no brand terms configured');
  const branded = activeRows(snapshot, 'search_terms').filter((row) => {
    const text = (row.name ?? '').toLowerCase();
    return metric(row, 'cost') > 0 && brandTerms.some((term) => text.includes(term));
  });
  if (branded.length === 0) return notApplicable('no search term with cost contains a brand term');

  // Letter lookarounds, not \b: '_' is a word character and separates words in campaign names.
  const isBrandCampaign = (name: string): boolean =>
    /(?<![a-z])brand(ed|ing)?(?![a-z])/i.test(name) && !/(?<![a-z])(non|un|no|not)[\s_-]*brand/i.test(name);
  const leaked = branded.filter((row) => !isBrandCampaign(attrString(row, 'campaignName') ?? ''));
  const groups = groupBy(leaked, (row) => row.campaignId ?? attrString(row, 'campaignName') ?? '');
  const ranked: Ranked[] = [];
  for (const [key, group] of groups) {
    const sorted = [...group].sort((a, b) => metric(b, 'cost') - metric(a, 'cost'));
    const first = sorted[0];
    if (first === undefined) continue;
    const cost = sorted.reduce((total, row) => total + metric(row, 'cost'), 0);
    const campaignName = attrString(first, 'campaignName');
    const target: EntityRef = { level: 'campaign', id: key === '' ? 'unknown' : key };
    if (campaignName !== null) target.name = campaignName;
    const listed = sorted.slice(0, MAX_LISTED_TERMS).map(quoted).join(', ');
    const more = sorted.length > MAX_LISTED_TERMS ? ` and ${sorted.length - MAX_LISTED_TERMS} more` : '';
    ranked.push({
      weight: cost,
      finding: {
        entity: target,
        title: `Brand searches in a non-brand campaign: "${campaignName ?? target.id}"`,
        observation:
          `Campaign "${campaignName ?? target.id}" spent ${formatMoney(cost, snapshot.currency)} on ${sorted.length} ` +
          `search term${sorted.length === 1 ? '' : 's'} containing a brand term: ${listed}${more}.`,
        recommendation: 'Add the brand terms as negatives in that campaign so brand demand is reported in the brand campaign.',
        evidence: sorted.map((row) => evidence(snapshot, 'search_terms', row, ['cost', 'clicks', 'conversions'])),
        needsReview: true,
      },
    });
  }
  return outcome(ranked);
}

export const googleAdsStructureChecks: CheckDefinition[] = [
  {
    id: 'gads.budget.limited_winners',
    platform: 'google_ads',
    category: 'budget',
    severity: 'medium',
    title: 'Efficient campaigns limited by budget',
    requires: ['campaigns'],
    usesConversions: true,
    run: runBudgetLimitedWinners,
  },
  {
    id: 'gads.bidding.rank_limited',
    platform: 'google_ads',
    category: 'bidding',
    severity: 'low',
    title: 'Campaigns losing impression share to ad rank',
    requires: ['campaigns'],
    run: runRankLimited,
  },
  {
    id: 'gads.structure.low_quality_score',
    platform: 'google_ads',
    category: 'structure',
    severity: 'medium',
    title: 'Keywords with a low Quality Score',
    requires: ['keywords'],
    run: runLowQualityScore,
  },
  {
    id: 'gads.creative.disapproved_ads',
    platform: 'google_ads',
    category: 'creative',
    severity: 'high',
    title: 'Enabled ads that are disapproved',
    requires: ['ads'],
    run: runDisapprovedAds,
  },
  {
    id: 'gads.tracking.conversion_drop',
    platform: 'google_ads',
    category: 'tracking',
    severity: 'critical',
    title: 'Conversions dropped while clicks held',
    requires: ['daily'],
    run: runConversionDrop,
  },
  {
    id: 'gads.tracking.conversion_actions',
    platform: 'google_ads',
    category: 'tracking',
    severity: 'high',
    title: 'Conversion action setup',
    requires: ['conversion_actions'],
    run: runConversionActions,
  },
  {
    id: 'gads.structure.brand_in_nonbrand',
    platform: 'google_ads',
    category: 'structure',
    severity: 'low',
    title: 'Brand search terms in non-brand campaigns',
    requires: ['search_terms'],
    needs: ['brand_terms'],
    run: runBrandInNonBrand,
  },
];
