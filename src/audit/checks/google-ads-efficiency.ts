import { attrString, groupBy, metric, monthly } from '../../core/metrics';
import { formatMoney } from '../../core/money';
import type { CheckContext, CheckDefinition, CheckOutcome, EntityRef, FindingDraft, Row, TermJudgment } from '../../core/types';
import { activeRows, draft, entity, evidence, referenceCpa, rows } from '../helpers';

const MAX_FINDINGS = 25;
const MAX_TERM_CANDIDATES = 60;
/** Clicks a zero-conversion keyword needs before pausing it is suggested. */
const KEYWORD_PAUSE_MIN_CLICKS = 30;
/** Device conversions below this (and above 0) make a CPA comparison a signal only. */
const DEVICE_MIN_CONVERSIONS = 5;

function wasteFloor(ctx: CheckContext): number {
  const cpa = referenceCpa(ctx);
  return cpa !== null ? cpa * ctx.thresholds.wasteCpaMultiple : ctx.thresholds.wasteMinCost;
}

/** A fraction as a percentage with one decimal. */
function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function quote(text: string): string {
  return `"${text}"`;
}

function label(row: Row): string {
  return quote(row.name ?? row.id);
}

function rationale(observation: string): string {
  return observation.length < 200 ? observation : `${observation.slice(0, 196)}...`;
}

function days(ctx: CheckContext): string {
  return `${ctx.snapshot.dateRange.start}..${ctx.snapshot.dateRange.end}`;
}

/** `searchTermStatus` as an enum-style word: API enum names and CSV UI words ('Excluded', 'Added/Excluded') compare equal. */
function searchTermStatus(row: Row): string {
  return (attrString(row, 'searchTermStatus') ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_');
}

/** A term that is already a negative keyword: its spend has stopped, so it is neither waste nor a row to judge. */
function isExcludedTerm(row: Row): boolean {
  const status = searchTermStatus(row);
  return status === 'EXCLUDED' || status === 'ADDED_EXCLUDED';
}

interface Ranked {
  finding: FindingDraft;
  weight: number;
}

function outcome(ranked: Ranked[], judged: number, emptyReason: string): CheckOutcome {
  if (ranked.length === 0) {
    return judged === 0 ? { status: 'not_applicable', reason: emptyReason, findings: [] } : { status: 'pass', findings: [] };
  }
  const findings = [...ranked]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_FINDINGS)
    .map((item) => item.finding);
  return { status: 'fail', findings };
}

const searchTerms: CheckDefinition = {
  id: 'gads.waste.search_terms',
  platform: 'google_ads',
  category: 'waste',
  severity: 'high',
  title: 'Search terms spending without conversions',
  requires: ['search_terms'],
  usesConversions: true,
  async run(ctx) {
    const { snapshot, account } = ctx;
    const all = activeRows(snapshot, 'search_terms').filter((row) => !isExcludedTerm(row));
    const floor = wasteFloor(ctx);
    const candidates = all
      .filter((row) => metric(row, 'cost') >= floor && metric(row, 'conversions') === 0)
      .sort((a, b) => metric(b, 'cost') - metric(a, 'cost'))
      .slice(0, MAX_TERM_CANDIDATES);

    const judgments = new Map<string, TermJudgment>();
    if (ctx.judge !== null && candidates.length > 0) {
      const terms = [...new Set(candidates.map((row) => row.name ?? row.id))];
      const answers = await ctx.judge.classifyTerms({
        business: account.business ?? '',
        brandTerms: account.brandTerms ?? [],
        terms,
      });
      for (const answer of answers) judgments.set(answer.term, answer);
    }

    const ranked: Ranked[] = [];
    for (const row of candidates) {
      const term = row.name ?? row.id;
      const judgment = judgments.get(term);
      const decisive = judgment !== undefined && judgment.band === 'act';
      if (decisive && judgment.label === 'brand') continue;

      const cost = metric(row, 'cost');
      const clicks = metric(row, 'clicks');
      const observation = `Search term ${quote(term)} cost ${formatMoney(cost, snapshot.currency)} over ${clicks} clicks with 0 conversions.`;
      const finding: FindingDraft = {
        entity: entity('search_term', row),
        title: `Search term ${quote(term)} spends without converting`,
        observation,
        recommendation: 'Review this search term and decide whether to exclude it.',
        evidence: [evidence(snapshot, 'search_terms', row, ['cost', 'clicks', 'conversions'])],
      };

      // A term that is also a keyword: a negative would block that keyword, and its spend is
      // counted by gads.waste.keywords, so it gets no action and no impact here.
      if (searchTermStatus(row) === 'ADDED') {
        finding.recommendation =
          'This term is already a keyword: review that keyword (bid, match type, landing page) rather than adding a negative, which would block it.';
        finding.needsReview = true;
        ranked.push({ finding, weight: cost });
        continue;
      }
      finding.impact = {
        kind: 'wasted_spend',
        monthly: monthly(cost, snapshot.dateRange),
        basis: `cost over ${days(ctx)} with 0 conversions, scaled to 30 days`,
      };

      if (decisive && (judgment.label === 'irrelevant' || judgment.label === 'competitor')) {
        if (row.campaignId !== undefined) {
          const target: EntityRef = { level: 'campaign', id: row.campaignId };
          const campaignName = attrString(row, 'campaignName');
          if (campaignName !== null) target.name = campaignName;
          finding.suggestedActions = [
            draft('google_ads.negative_keyword.add', target, { text: term, matchType: 'EXACT' }, rationale(observation)),
          ];
          finding.recommendation = `Add it as an exact-match negative keyword on its campaign (classified as ${judgment.label}).`;
        } else {
          finding.recommendation = `Add it as an exact-match negative keyword (classified as ${judgment.label}); its campaign is not known from this data.`;
        }
      } else if (decisive && judgment.label === 'relevant') {
        finding.recommendation = 'The term looks relevant to the business: review the landing page and bids rather than excluding it.';
        finding.needsReview = true;
      } else {
        finding.needsReview = true;
      }
      ranked.push({ finding, weight: cost });
    }
    return outcome(ranked, all.length, 'No active search terms to judge.');
  },
};

const keywords: CheckDefinition = {
  id: 'gads.waste.keywords',
  platform: 'google_ads',
  category: 'waste',
  severity: 'high',
  title: 'Keywords spending without conversions',
  requires: ['keywords'],
  usesConversions: true,
  run(ctx) {
    const { snapshot } = ctx;
    const all = activeRows(snapshot, 'keywords');
    const floor = wasteFloor(ctx);
    const ranked: Ranked[] = [];
    for (const row of all) {
      const cost = metric(row, 'cost');
      if (cost < floor || metric(row, 'conversions') !== 0) continue;
      const clicks = metric(row, 'clicks');
      const observation = `Keyword ${label(row)} cost ${formatMoney(cost, snapshot.currency)} over ${clicks} clicks with 0 conversions.`;
      const finding: FindingDraft = {
        entity: entity('keyword', row),
        title: `Keyword ${label(row)} spends without converting`,
        observation,
        recommendation: 'Pause this keyword or lower its bid.',
        evidence: [evidence(snapshot, 'keywords', row, ['cost', 'clicks', 'conversions'])],
        impact: {
          kind: 'wasted_spend',
          monthly: monthly(cost, snapshot.dateRange),
          basis: `cost over ${days(ctx)} with 0 conversions, scaled to 30 days`,
        },
      };
      if (clicks >= KEYWORD_PAUSE_MIN_CLICKS) {
        finding.suggestedActions = [draft('google_ads.keyword.pause', entity('keyword', row), {}, rationale(observation))];
      } else {
        finding.dataStatus = 'limited';
        finding.recommendation = `Watch this keyword: under ${KEYWORD_PAUSE_MIN_CLICKS} clicks is too few to pause it on.`;
      }
      ranked.push({ finding, weight: cost });
    }
    return outcome(ranked, all.length, 'No active keywords to judge.');
  },
};

const highCpa: CheckDefinition = {
  id: 'gads.bidding.high_cpa_campaigns',
  platform: 'google_ads',
  category: 'bidding',
  severity: 'medium',
  title: 'Campaigns well above target CPA',
  requires: ['campaigns'],
  needs: ['target_cpa'],
  usesConversions: true,
  run(ctx) {
    const { snapshot, thresholds } = ctx;
    const target = ctx.account.targets?.cpa;
    if (target === undefined) return { status: 'not_applicable', reason: 'No target CPA is set.', findings: [] };
    const judged = activeRows(snapshot, 'campaigns').filter((row) => metric(row, 'conversions') >= thresholds.minConversions);
    const ranked: Ranked[] = [];
    for (const row of judged) {
      const cost = metric(row, 'cost');
      const conversions = metric(row, 'conversions');
      if (conversions <= 0) continue;
      const cpa = cost / conversions;
      if (!(cpa > target * thresholds.highCpaMultiple)) continue;
      const excess = (cpa - target) * conversions;
      const money = (amount: number): string => formatMoney(amount, snapshot.currency);
      ranked.push({
        weight: excess,
        finding: {
          entity: entity('campaign', row),
          title: `Campaign ${label(row)} is above target CPA`,
          observation: `Campaign ${label(row)} spent ${money(cost)} for ${conversions} conversions, a CPA of ${money(cpa)} against a target of ${money(target)}.`,
          recommendation: 'Tighten targeting, exclude poor search terms and lower bids until CPA approaches the target.',
          evidence: [evidence(snapshot, 'campaigns', row, ['cost', 'conversions'])],
          impact: {
            kind: 'wasted_spend',
            monthly: monthly(excess, snapshot.dateRange),
            basis: `(CPA - target CPA) x conversions over ${days(ctx)}, scaled to 30 days`,
          },
        },
      });
    }
    return outcome(ranked, judged.length, `No active campaign has at least ${thresholds.minConversions} conversions.`);
  },
};

const lowRoas: CheckDefinition = {
  id: 'gads.bidding.low_roas_campaigns',
  platform: 'google_ads',
  category: 'bidding',
  severity: 'medium',
  title: 'Campaigns well below target ROAS',
  requires: ['campaigns'],
  needs: ['target_roas'],
  usesConversions: true,
  run(ctx) {
    const { snapshot, thresholds } = ctx;
    const target = ctx.account.targets?.roas;
    if (target === undefined) return { status: 'not_applicable', reason: 'No target ROAS is set.', findings: [] };
    const judged = activeRows(snapshot, 'campaigns').filter(
      (row) => metric(row, 'conversions') >= thresholds.minConversions && metric(row, 'conversionValue') > 0 && metric(row, 'cost') > 0,
    );
    const ranked: Ranked[] = [];
    for (const row of judged) {
      const cost = metric(row, 'cost');
      const value = metric(row, 'conversionValue');
      const roas = value / cost;
      if (!(roas < target * thresholds.lowRoasMultiple)) continue;
      const missed = target * cost - value;
      const money = (amount: number): string => formatMoney(amount, snapshot.currency);
      ranked.push({
        weight: missed,
        finding: {
          entity: entity('campaign', row),
          title: `Campaign ${label(row)} is below target ROAS`,
          observation: `Campaign ${label(row)} returned ${money(value)} on ${money(cost)} of spend, a ROAS of ${roas.toFixed(2)} against a target of ${target.toFixed(2)}.`,
          recommendation: 'Shift spend to products and terms that return more, and tighten bids on the rest.',
          evidence: [evidence(snapshot, 'campaigns', row, ['cost', 'conversions', 'conversionValue'])],
          impact: {
            kind: 'missed_revenue',
            monthly: monthly(missed, snapshot.dateRange),
            basis: `target ROAS x cost - conversion value over ${days(ctx)}, scaled to 30 days`,
          },
        },
      });
    }
    return outcome(ranked, judged.length, `No active campaign has at least ${thresholds.minConversions} conversions with conversion value.`);
  },
};

const lowCtr: CheckDefinition = {
  id: 'gads.creative.low_ctr_ad_groups',
  platform: 'google_ads',
  category: 'creative',
  severity: 'low',
  title: 'Search ad groups with low click-through rate',
  requires: ['ad_groups', 'campaigns'],
  run(ctx) {
    const { snapshot, thresholds } = ctx;
    const searchCampaigns = new Map<string, Row>();
    for (const row of rows(snapshot, 'campaigns')) {
      if (attrString(row, 'channelType') === 'SEARCH') searchCampaigns.set(row.id, row);
    }
    if (searchCampaigns.size === 0) return { status: 'not_applicable', reason: 'No search campaign.', findings: [] };
    const judged = activeRows(snapshot, 'ad_groups').filter(
      (row) => row.campaignId !== undefined && searchCampaigns.has(row.campaignId) && metric(row, 'impressions') >= thresholds.minImpressions,
    );
    const ranked: Ranked[] = [];
    for (const row of judged) {
      const impressions = metric(row, 'impressions');
      if (impressions <= 0) continue;
      const clicks = metric(row, 'clicks');
      const ctr = clicks / impressions;
      if (!(ctr < thresholds.lowSearchCtr)) continue;
      const refs = [evidence(snapshot, 'ad_groups', row, ['impressions', 'clicks'])];
      const campaign = row.campaignId === undefined ? undefined : searchCampaigns.get(row.campaignId);
      if (campaign !== undefined) refs.push(evidence(snapshot, 'campaigns', campaign, []));
      ranked.push({
        weight: impressions,
        finding: {
          entity: entity('ad_group', row),
          title: `Ad group ${label(row)} has a low CTR`,
          observation: `Ad group ${label(row)} got ${clicks} clicks from ${impressions} impressions, a CTR of ${pct(ctr)} against a floor of ${pct(thresholds.lowSearchCtr)}.`,
          recommendation: 'Rewrite the ads and check that each keyword matches what its ad says.',
          evidence: refs,
        },
      });
    }
    return outcome(ranked, judged.length, `No search ad group has at least ${thresholds.minImpressions} impressions.`);
  },
};

const deviceOutlier: CheckDefinition = {
  id: 'gads.bidding.device_outlier',
  platform: 'google_ads',
  category: 'bidding',
  severity: 'medium',
  title: 'Devices converting far worse than their campaign',
  requires: ['devices'],
  usesConversions: true,
  run(ctx) {
    const { snapshot, thresholds } = ctx;
    const floor = wasteFloor(ctx);
    const money = (amount: number): string => formatMoney(amount, snapshot.currency);
    const groups = groupBy(
      activeRows(snapshot, 'devices').filter((row) => row.campaignId !== undefined),
      (row) => row.campaignId ?? '',
    );
    const ranked: Ranked[] = [];
    let judged = 0;
    for (const [campaignId, devices] of groups) {
      let campaignCost = 0;
      let campaignConversions = 0;
      for (const row of devices) {
        campaignCost += metric(row, 'cost');
        campaignConversions += metric(row, 'conversions');
      }
      if (campaignCost <= 0) continue;
      const campaignCpa = campaignConversions > 0 ? campaignCost / campaignConversions : null;
      for (const row of devices) {
        const cost = metric(row, 'cost');
        const share = cost / campaignCost;
        if (share < thresholds.segmentMinCostShare) continue;
        judged += 1;
        const conversions = metric(row, 'conversions');
        const device = quote(attrString(row, 'device') ?? row.name ?? row.id);
        const campaign = quote(attrString(row, 'campaignName') ?? campaignId);
        let observation: string;
        if (campaignCpa !== null && conversions >= 1 && cost / conversions > thresholds.segmentCpaMultiple * campaignCpa) {
          observation = `Device ${device} in campaign ${campaign} has a CPA of ${money(cost / conversions)} (${money(cost)} for ${conversions} conversions, ${pct(share)} of campaign cost) against a campaign CPA of ${money(campaignCpa)}.`;
        } else if (conversions === 0 && cost >= floor) {
          observation = `Device ${device} in campaign ${campaign} cost ${money(cost)} (${pct(share)} of campaign cost) with 0 conversions${campaignCpa !== null ? ` against a campaign CPA of ${money(campaignCpa)}` : ''}.`;
        } else {
          continue;
        }
        const excess = Math.max(0, cost - conversions * (campaignCpa ?? 0));
        const finding: FindingDraft = {
          entity: entity('device', row),
          title: `Device ${device} underperforms in campaign ${campaign}`,
          observation,
          recommendation: 'Apply a negative device bid adjustment for this device in the campaign.',
          evidence: devices.map((item) => evidence(snapshot, 'devices', item, ['cost', 'conversions'])),
          impact: {
            kind: 'wasted_spend',
            monthly: monthly(excess, snapshot.dateRange),
            basis: `device cost - device conversions x campaign CPA over ${days(ctx)}, scaled to 30 days`,
          },
        };
        if (conversions > 0 && conversions < DEVICE_MIN_CONVERSIONS) finding.dataStatus = 'limited';
        ranked.push({ finding, weight: excess });
      }
    }
    return outcome(ranked, judged, 'No device carries enough of its campaign cost to compare.');
  },
};

export const googleAdsEfficiencyChecks: CheckDefinition[] = [searchTerms, keywords, highCpa, lowRoas, lowCtr, deviceOutlier];
