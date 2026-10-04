import { attrNumber, metric } from '../../core/metrics';
import type { CheckContext, CheckDefinition, CheckOutcome, FindingDraft, Row } from '../../core/types';
import { activeRows, entity, evidence } from '../helpers';

const MAX_FINDINGS = 25;
const TOP_POSITION = 3;
/** CTR a query in the top three positions is expected to reach. */
const TOP_POSITION_CTR = 0.1;

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function quote(text: string): string {
  return `"${text}"`;
}

interface RankedQuery {
  row: Row;
  position: number;
  impressions: number;
}

/** Queries with a known position and enough impressions to be judged. */
function rankedQueries(ctx: CheckContext): RankedQuery[] {
  const ranked: RankedQuery[] = [];
  for (const row of activeRows(ctx.snapshot, 'queries')) {
    const position = attrNumber(row, 'position');
    const impressions = metric(row, 'impressions');
    if (position === null || impressions < ctx.thresholds.minImpressions) continue;
    ranked.push({ row, position, impressions });
  }
  return ranked;
}

function strikingDistance(ctx: CheckContext): CheckOutcome {
  const { strikingDistanceMin: min, strikingDistanceMax: max, minImpressions } = ctx.thresholds;
  const ranked = rankedQueries(ctx);
  if (ranked.length === 0) {
    return {
      status: 'not_applicable',
      reason: `No query has ${minImpressions} impressions or more with a known position.`,
      findings: [],
    };
  }
  const findings: FindingDraft[] = ranked
    .filter((query) => query.position >= min && query.position <= max)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, MAX_FINDINGS)
    .map(({ row, position, impressions }) => ({
      entity: entity('query', row),
      title: 'Query within striking distance',
      observation: `Query ${quote(row.name ?? row.id)} ranks at average position ${position.toFixed(
        1,
      )} with ${impressions} impressions and ${metric(row, 'clicks')} clicks, inside the ${min} to ${max} range.`,
      recommendation:
        'Strengthen the page that ranks for this query: deepen its content, add internal links to it and sharpen its title.',
      evidence: [evidence(ctx.snapshot, 'queries', row, ['impressions', 'clicks', 'position'])],
    }));
  return { status: findings.length > 0 ? 'fail' : 'pass', findings };
}

function lowCtrTopPositions(ctx: CheckContext): CheckOutcome {
  const top: Array<RankedQuery & { ctr: number }> = [];
  for (const query of rankedQueries(ctx)) {
    const ctr = attrNumber(query.row, 'ctr');
    if (ctr === null || query.position > TOP_POSITION) continue;
    top.push({ ...query, ctr });
  }
  if (top.length === 0) {
    return {
      status: 'not_applicable',
      reason: `No query in the top ${TOP_POSITION} positions has ${ctx.thresholds.minImpressions} impressions or more.`,
      findings: [],
    };
  }
  const missedClicks = (query: { impressions: number; ctr: number }): number =>
    query.impressions * (TOP_POSITION_CTR - query.ctr);
  const findings: FindingDraft[] = top
    .filter((query) => query.ctr < TOP_POSITION_CTR)
    .sort((a, b) => missedClicks(b) - missedClicks(a))
    .slice(0, MAX_FINDINGS)
    .map(({ row, position, impressions, ctr }) => ({
      entity: entity('query', row),
      title: 'Low click-through rate in a top position',
      observation: `Query ${quote(row.name ?? row.id)} ranks at average position ${position.toFixed(
        1,
      )} with ${impressions} impressions but a click-through rate of ${pct(ctr)}, below ${pct(TOP_POSITION_CTR)}.`,
      recommendation:
        'Rewrite the title and meta description of the ranking page so that the result answers this query more clearly.',
      evidence: [evidence(ctx.snapshot, 'queries', row, ['impressions', 'clicks', 'position', 'ctr'])],
    }));
  return { status: findings.length > 0 ? 'fail' : 'pass', findings };
}

export const searchConsoleChecks: CheckDefinition[] = [
  {
    id: 'gsc.seo.striking_distance',
    platform: 'search_console',
    category: 'seo',
    severity: 'medium',
    title: 'Queries within striking distance of the first positions',
    requires: ['queries'],
    run: strikingDistance,
  },
  {
    id: 'gsc.seo.low_ctr_top_positions',
    platform: 'search_console',
    category: 'seo',
    severity: 'medium',
    title: 'Top positions earn their clicks',
    requires: ['queries'],
    run: lowCtrTopPositions,
  },
];
