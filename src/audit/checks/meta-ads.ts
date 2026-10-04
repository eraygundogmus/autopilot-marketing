import { addDays, daysInRange } from '../../core/dates';
import { attrNumber, attrString, groupBy, metric, monthly, sumMetrics } from '../../core/metrics';
import { formatMoney } from '../../core/money';
import type { ActionDraft, CheckContext, CheckDefinition, CheckOutcome, FindingDraft, Row } from '../../core/types';
import { activeRows, draft, entity, evidence, referenceCpa, rows } from '../helpers';

const MAX_FINDINGS = 25;
/** Clicks an ad set needs before zero conversions justifies a pause. */
const PAUSE_MIN_CLICKS = 30;
/** Link clicks an ad set needs before its landing page view rate is judged. */
const LANDING_MIN_LINK_CLICKS = 100;
const WINDOW_DAYS = 7;

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function count(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function label(row: Row): string {
  return `"${row.name ?? row.id}"`;
}

function rationale(observation: string): string {
  return observation.length < 200 ? observation : `${observation.slice(0, 196)}...`;
}

function wasteFloor(ctx: CheckContext): number {
  const reference = referenceCpa(ctx);
  return reference !== null ? reference * ctx.thresholds.wasteCpaMultiple : ctx.thresholds.wasteMinCost;
}

function linkCtr(row: Row): number | null {
  const impressions = metric(row, 'impressions');
  return impressions > 0 ? metric(row, 'linkClicks') / impressions : null;
}

function outcome(findings: FindingDraft[], judged: number, reason: string): CheckOutcome {
  if (findings.length === 0) {
    return judged === 0 ? { status: 'not_applicable', reason, findings: [] } : { status: 'pass', findings: [] };
  }
  const sorted = [...findings].sort((a, b) => (b.impact?.monthly ?? 0) - (a.impact?.monthly ?? 0));
  return { status: 'fail', findings: sorted.slice(0, MAX_FINDINGS) };
}

function adsetsNoConversions(ctx: CheckContext): CheckOutcome {
  const { snapshot } = ctx;
  const floor = wasteFloor(ctx);
  const adSets = activeRows(snapshot, 'ad_groups');
  const findings: FindingDraft[] = [];
  for (const row of adSets) {
    const cost = metric(row, 'cost');
    if (cost < floor || metric(row, 'conversions') !== 0) continue;
    const clicks = metric(row, 'clicks');
    const observation = `Ad set ${label(row)} spent ${formatMoney(cost, snapshot.currency)} on ${count(clicks)} clicks with 0 conversions.`;
    const finding: FindingDraft = {
      entity: entity('ad_group', row),
      title: `Ad set ${label(row)} spends without conversions`,
      observation,
      recommendation:
        clicks >= PAUSE_MIN_CLICKS
          ? 'Pause the ad set and move its budget to ad sets that convert.'
          : 'Watch the ad set until it has enough clicks to judge, then pause it if it still has no conversions.',
      evidence: [evidence(snapshot, 'ad_groups', row, ['cost', 'clicks', 'conversions'])],
      impact: {
        kind: 'wasted_spend',
        monthly: monthly(cost, snapshot.dateRange),
        basis: 'cost with 0 conversions, scaled to 30 days',
      },
    };
    if (clicks >= PAUSE_MIN_CLICKS) {
      finding.suggestedActions = [draft('meta_ads.adset.pause', entity('ad_group', row), {}, rationale(observation))];
    } else {
      finding.dataStatus = 'limited';
    }
    findings.push(finding);
  }
  return outcome(findings, adSets.length, 'No active ad sets.');
}

function highCpaAdsets(ctx: CheckContext): CheckOutcome {
  const { snapshot, thresholds } = ctx;
  const target = ctx.account.targets?.cpa;
  if (target === undefined) return { status: 'unknown', reason: 'No target CPA is configured.', findings: [] };
  const judged = activeRows(snapshot, 'ad_groups').filter(
    (row) => metric(row, 'conversions') >= thresholds.minConversions && metric(row, 'conversions') > 0,
  );
  const findings: FindingDraft[] = [];
  for (const row of judged) {
    const cost = metric(row, 'cost');
    const conversions = metric(row, 'conversions');
    const cpa = cost / conversions;
    if (cpa <= target * thresholds.highCpaMultiple) continue;
    findings.push({
      entity: entity('ad_group', row),
      title: `Ad set ${label(row)} has a CPA far above target`,
      observation: `Ad set ${label(row)} has a CPA of ${formatMoney(cpa, snapshot.currency)} over ${count(conversions)} conversions, against a target of ${formatMoney(target, snapshot.currency)}.`,
      recommendation: 'Review the audience and creative of this ad set, and lower its budget until its CPA approaches the target.',
      evidence: [evidence(snapshot, 'ad_groups', row, ['cost', 'conversions'])],
      impact: {
        kind: 'wasted_spend',
        monthly: monthly((cpa - target) * conversions, snapshot.dateRange),
        basis: '(CPA - target CPA) x conversions, scaled to 30 days',
      },
    });
  }
  return outcome(findings, judged.length, 'No active ad set has enough conversions to compare its CPA.');
}

function lowRoasCampaigns(ctx: CheckContext): CheckOutcome {
  const { snapshot, thresholds } = ctx;
  const target = ctx.account.targets?.roas;
  if (target === undefined) return { status: 'unknown', reason: 'No target ROAS is configured.', findings: [] };
  const judged = activeRows(snapshot, 'campaigns').filter(
    (row) =>
      metric(row, 'conversions') >= thresholds.minConversions && metric(row, 'conversionValue') > 0 && metric(row, 'cost') > 0,
  );
  const findings: FindingDraft[] = [];
  for (const row of judged) {
    const cost = metric(row, 'cost');
    const value = metric(row, 'conversionValue');
    const roas = value / cost;
    if (roas >= target * thresholds.lowRoasMultiple) continue;
    findings.push({
      entity: entity('campaign', row),
      title: `Campaign ${label(row)} returns far less than the target ROAS`,
      observation: `Campaign ${label(row)} returned ${formatMoney(value, snapshot.currency)} on ${formatMoney(cost, snapshot.currency)} of spend, a ROAS of ${roas.toFixed(2)} against a target of ${target.toFixed(2)}.`,
      recommendation: 'Review the audiences, offer and creative of this campaign, and hold its budget until its ROAS recovers.',
      evidence: [evidence(snapshot, 'campaigns', row, ['cost', 'conversions', 'conversionValue'])],
      impact: {
        kind: 'missed_revenue',
        monthly: monthly(target * cost - value, snapshot.dateRange),
        basis: 'target ROAS x cost - conversion value, scaled to 30 days',
      },
    });
  }
  return outcome(findings, judged.length, 'No active campaign has enough conversions and conversion value to compare its ROAS.');
}

function lowLinkCtr(ctx: CheckContext): CheckOutcome {
  const { snapshot, thresholds } = ctx;
  const judged = activeRows(snapshot, 'ads').filter((row) => metric(row, 'impressions') >= 3 * thresholds.minImpressions);
  const flagged = judged
    .filter((row) => (linkCtr(row) ?? 0) < thresholds.lowLinkCtr)
    .sort((a, b) => metric(b, 'cost') - metric(a, 'cost'));
  const findings = flagged.map((row): FindingDraft => ({
    entity: entity('ad', row),
    title: `Ad ${label(row)} has a low link CTR`,
    observation: `Ad ${label(row)} has a link CTR of ${pct(linkCtr(row) ?? 0)} (${count(metric(row, 'linkClicks'))} link clicks on ${count(metric(row, 'impressions'))} impressions), below ${pct(thresholds.lowLinkCtr)}.`,
    recommendation: 'Test a new hook and a new creative for this ad.',
    evidence: [evidence(snapshot, 'ads', row, ['impressions', 'linkClicks'])],
  }));
  return outcome(findings, judged.length, 'No active ad has enough impressions to judge its link CTR.');
}

function fatigue(ctx: CheckContext): CheckOutcome {
  const { snapshot, thresholds } = ctx;
  const bySet = groupBy(
    rows(snapshot, 'ads').filter((row) => row.adGroupId !== undefined),
    (row) => row.adGroupId ?? '',
  );
  const judged = activeRows(snapshot, 'ads').filter(
    (row) => row.adGroupId !== undefined && attrNumber(row, 'frequency') !== null && linkCtr(row) !== null,
  );
  const flagged: Array<{ row: Row; finding: FindingDraft }> = [];
  for (const row of judged) {
    const frequency = attrNumber(row, 'frequency') ?? 0;
    const ctr = linkCtr(row) ?? 0;
    const siblings = bySet.get(row.adGroupId ?? '') ?? [];
    const pooled = sumMetrics(siblings);
    const pooledImpressions = pooled.impressions ?? 0;
    if (frequency < thresholds.fatigueFrequency || pooledImpressions <= 0) continue;
    const setCtr = (pooled['linkClicks'] ?? 0) / pooledImpressions;
    if (setCtr <= 0 || ctr > setCtr * (1 - thresholds.fatigueCtrDropPct)) continue;
    const observation = `Ad ${label(row)} has a frequency of ${frequency.toFixed(1)} and a link CTR of ${pct(ctr)}, ${pct(1 - ctr / setCtr)} below its ad set's ${pct(setCtr)}.`;
    const hasOtherEnabled = siblings.some((other) => other.id !== row.id && other.attrs['status'] === 'ENABLED');
    // Same volume floor as lowLinkCtr: below it the link CTR is noise, so the finding carries no action.
    const enoughVolume = metric(row, 'impressions') >= 3 * thresholds.minImpressions;
    const actions: ActionDraft[] =
      enoughVolume && hasOtherEnabled ? [draft('meta_ads.ad.pause', entity('ad', row), {}, rationale(observation))] : [];
    let recommendation = 'Wait until the ad has enough impressions to judge its link CTR before refreshing or pausing it.';
    if (enoughVolume) {
      recommendation = hasOtherEnabled
        ? 'Refresh the creative, and pause this ad while the other ads in the ad set keep delivering.'
        : 'Refresh the creative: add a new ad to the ad set before pausing this one.';
    }
    const finding: FindingDraft = {
      entity: entity('ad', row),
      title: `Ad ${label(row)} shows creative fatigue`,
      observation,
      recommendation,
      evidence: [evidence(snapshot, 'ads', row, ['impressions', 'linkClicks', 'frequency'])],
    };
    if (!enoughVolume) finding.dataStatus = 'limited';
    if (actions.length > 0) finding.suggestedActions = actions;
    flagged.push({ row, finding });
  }
  flagged.sort((a, b) => metric(b.row, 'cost') - metric(a.row, 'cost'));
  return outcome(
    flagged.map((item) => item.finding),
    judged.length,
    'No active ad reports a frequency.',
  );
}

function landingViewRate(ctx: CheckContext): CheckOutcome {
  const { snapshot, thresholds } = ctx;
  const judged = activeRows(snapshot, 'ad_groups').filter(
    (row) => row.metrics['landingPageViews'] !== undefined && metric(row, 'linkClicks') >= LANDING_MIN_LINK_CLICKS,
  );
  const flagged = judged
    .filter((row) => metric(row, 'landingPageViews') / metric(row, 'linkClicks') < thresholds.landingViewRate)
    .sort((a, b) => metric(b, 'linkClicks') - metric(a, 'linkClicks'));
  const findings = flagged.map((row): FindingDraft => {
    const views = metric(row, 'landingPageViews');
    const clicks = metric(row, 'linkClicks');
    return {
      entity: entity('ad_group', row),
      title: `Ad set ${label(row)} loses visitors before the landing page loads`,
      observation: `Ad set ${label(row)} recorded ${count(views)} landing page views from ${count(clicks)} link clicks, a rate of ${pct(views / clicks)} against a floor of ${pct(thresholds.landingViewRate)}.`,
      recommendation: "Check the landing page's speed, its redirects and the pixel's page-view event.",
      evidence: [evidence(snapshot, 'ad_groups', row, ['linkClicks', 'landingPageViews'])],
    };
  });
  return outcome(findings, judged.length, 'No active ad set has enough link clicks and a landing page view metric.');
}

function learningLimited(ctx: CheckContext): CheckOutcome {
  const { snapshot, thresholds } = ctx;
  const floor = wasteFloor(ctx);
  const days = daysInRange(snapshot.dateRange);
  const adSets = activeRows(snapshot, 'ad_groups');
  const flagged: Array<{ row: Row; finding: FindingDraft }> = [];
  for (const row of adSets) {
    const cost = metric(row, 'cost');
    const weekly = (metric(row, 'conversions') * WINDOW_DAYS) / days;
    const failed = attrString(row, 'learningStatus') === 'FAIL';
    const tooFew = weekly > 0 && weekly < thresholds.learningMinEvents && cost >= floor;
    if (!failed && !tooFew) continue;
    const pace = `${weekly.toFixed(1)} conversions per 7 days against the ${count(thresholds.learningMinEvents)} needed to leave the learning phase, on ${formatMoney(cost, snapshot.currency)} of spend`;
    flagged.push({
      row,
      finding: {
        entity: entity('ad_group', row),
        title: `Ad set ${label(row)} is learning limited`,
        observation: failed
          ? `Ad set ${label(row)} is reported as learning limited, with ${pace}.`
          : `Ad set ${label(row)} gets ${pace}.`,
        recommendation: 'Consolidate ad sets so each one gets more events, or optimise for a more frequent event.',
        evidence: [evidence(snapshot, 'ad_groups', row, ['cost', 'conversions'])],
      },
    });
  }
  flagged.sort((a, b) => metric(b.row, 'cost') - metric(a.row, 'cost'));
  return outcome(
    flagged.map((item) => item.finding),
    adSets.length,
    'No active ad sets.',
  );
}

function placementOutlier(ctx: CheckContext): CheckOutcome {
  const { snapshot, thresholds } = ctx;
  const floor = wasteFloor(ctx);
  const adSets = new Map(activeRows(snapshot, 'ad_groups').map((row) => [row.id, row]));
  let judged = 0;
  const findings: FindingDraft[] = [];
  for (const row of activeRows(snapshot, 'placements')) {
    const adSet = row.adGroupId !== undefined ? adSets.get(row.adGroupId) : undefined;
    if (adSet === undefined) continue;
    const setCost = metric(adSet, 'cost');
    const cost = metric(row, 'cost');
    if (setCost <= 0 || cost < thresholds.segmentMinCostShare * setCost) continue;
    judged += 1;
    const setConversions = metric(adSet, 'conversions');
    const conversions = metric(row, 'conversions');
    const setCpa = setConversions > 0 ? setCost / setConversions : null;
    const placement = `"${attrString(row, 'placement') ?? row.name ?? row.id}"`;
    const share = pct(cost / setCost);
    let observation: string;
    if (conversions >= 1 && setCpa !== null && cost / conversions > thresholds.segmentCpaMultiple * setCpa) {
      observation = `Placement ${placement} in ad set ${label(adSet)} has a CPA of ${formatMoney(cost / conversions, snapshot.currency)} against the ad set's ${formatMoney(setCpa, snapshot.currency)}, on ${share} of its spend.`;
    } else if (conversions === 0 && cost >= floor) {
      observation = `Placement ${placement} in ad set ${label(adSet)} spent ${formatMoney(cost, snapshot.currency)} (${share} of the ad set's spend) with 0 conversions.`;
    } else {
      continue;
    }
    findings.push({
      entity: entity('ad_group', adSet),
      title: `Placement ${placement} underperforms in ad set ${label(adSet)}`,
      observation,
      recommendation: 'Exclude this placement from the ad set.',
      evidence: [
        evidence(snapshot, 'placements', row, ['cost', 'conversions']),
        evidence(snapshot, 'ad_groups', adSet, ['cost', 'conversions']),
      ],
      impact: {
        kind: 'wasted_spend',
        monthly: monthly(Math.max(0, cost - conversions * (setCpa ?? 0)), snapshot.dateRange),
        basis: "placement cost - placement conversions x the ad set's CPA, scaled to 30 days",
      },
    });
  }
  return outcome(findings, judged, 'No placement carries a large enough share of its ad set\'s spend.');
}

function conversionDrop(ctx: CheckContext): CheckOutcome {
  const { snapshot, thresholds } = ctx;
  const end = addDays(snapshot.dateRange.end, -thresholds.conversionLagDays);
  const recentStart = addDays(end, -(WINDOW_DAYS - 1));
  const priorEnd = addDays(recentStart, -1);
  const priorStart = addDays(priorEnd, -(WINDOW_DAYS - 1));
  const daily = rows(snapshot, 'daily').filter((row) => row.date !== undefined);
  const dates = daily.map((row) => row.date ?? '').sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (first === undefined || last === undefined || first > priorStart || last < end) {
    return {
      status: 'not_applicable',
      reason: `Daily rows do not cover ${priorStart}..${end}.`,
      findings: [],
    };
  }
  // ISO dates compare correctly as strings.
  const recentRows = daily.filter((row) => (row.date ?? '') >= recentStart && (row.date ?? '') <= end);
  const priorRows = daily.filter((row) => (row.date ?? '') >= priorStart && (row.date ?? '') <= priorEnd);
  const recent = sumMetrics(recentRows);
  const prior = sumMetrics(priorRows);
  const recentConversions = recent.conversions ?? 0;
  const priorConversions = prior.conversions ?? 0;
  const recentClicks = recent.clicks ?? 0;
  const priorClicks = prior.clicks ?? 0;
  const dropped =
    priorConversions >= thresholds.minConversions &&
    priorConversions > 0 &&
    // Written as a subtraction: `prior * (1 - pct)` rounds below the exact boundary (35 * 0.2 < 7).
    recentConversions <= priorConversions - priorConversions * thresholds.conversionDropPct &&
    recentClicks >= 0.8 * priorClicks;
  if (!dropped) return { status: 'pass', findings: [] };
  return {
    status: 'fail',
    findings: [
      {
        title: 'Conversions collapsed while clicks held',
        observation: `Conversions fell ${pct(1 - recentConversions / priorConversions)}, from ${count(priorConversions)} in ${priorStart}..${priorEnd} to ${count(recentConversions)} in ${recentStart}..${end}, while clicks went from ${count(priorClicks)} to ${count(recentClicks)}.`,
        recommendation: 'Check the pixel and the Conversions API before changing budgets.',
        evidence: [...priorRows, ...recentRows].map((row) => evidence(snapshot, 'daily', row, ['clicks', 'conversions'])),
        impact: { kind: 'risk', monthly: 0, basis: 'conversion tracking may be broken; no spend estimate' },
      },
    ],
  };
}

export const metaAdsChecks: CheckDefinition[] = [
  {
    id: 'meta.waste.adsets_no_conversions',
    platform: 'meta_ads',
    category: 'waste',
    severity: 'high',
    title: 'Ad sets spending without conversions',
    requires: ['ad_groups'],
    usesConversions: true,
    run: adsetsNoConversions,
  },
  {
    id: 'meta.bidding.high_cpa_adsets',
    platform: 'meta_ads',
    category: 'bidding',
    severity: 'medium',
    title: 'Ad sets with a CPA far above target',
    requires: ['ad_groups'],
    needs: ['target_cpa'],
    usesConversions: true,
    run: highCpaAdsets,
  },
  {
    id: 'meta.bidding.low_roas_campaigns',
    platform: 'meta_ads',
    category: 'bidding',
    severity: 'medium',
    title: 'Campaigns with a ROAS far below target',
    requires: ['campaigns'],
    needs: ['target_roas'],
    usesConversions: true,
    run: lowRoasCampaigns,
  },
  {
    id: 'meta.creative.low_link_ctr',
    platform: 'meta_ads',
    category: 'creative',
    severity: 'low',
    title: 'Ads with a low link CTR',
    requires: ['ads'],
    run: lowLinkCtr,
  },
  {
    id: 'meta.creative.fatigue',
    platform: 'meta_ads',
    category: 'creative',
    severity: 'medium',
    title: 'Ads showing creative fatigue',
    requires: ['ads'],
    run: fatigue,
  },
  {
    id: 'meta.structure.landing_view_rate',
    platform: 'meta_ads',
    category: 'structure',
    severity: 'medium',
    title: 'Link clicks that never reach the landing page',
    requires: ['ad_groups'],
    run: landingViewRate,
  },
  {
    id: 'meta.budget.learning_limited',
    platform: 'meta_ads',
    category: 'budget',
    severity: 'medium',
    title: 'Ad sets stuck in the learning phase',
    requires: ['ad_groups'],
    usesConversions: true,
    run: learningLimited,
  },
  {
    id: 'meta.bidding.placement_outlier',
    platform: 'meta_ads',
    category: 'bidding',
    severity: 'medium',
    title: 'Placements far less efficient than their ad set',
    requires: ['placements', 'ad_groups'],
    usesConversions: true,
    run: placementOutlier,
  },
  {
    id: 'meta.tracking.conversion_drop',
    platform: 'meta_ads',
    category: 'tracking',
    severity: 'critical',
    title: 'Conversions dropped while clicks held',
    requires: ['daily'],
    run: conversionDrop,
  },
];
