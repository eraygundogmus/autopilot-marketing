import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { JsonObject, JudgmentUsage, Runtime } from '../../core/types';
import { judgeClaims, judgeCopy, judgeTerms } from '../../ops/audit';
import { fail, ok } from '../result';

const FALLBACK_NOTE =
  'Jev is not configured (TYPESAFE_API_KEY): these are rule-based signals for review, not decisions.';
const MAX_TEXT_ROWS = 50;
const MAX_CELL_CHARS = 80;

const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true };

const usageSchema = z.looseObject({ mode: z.string(), requests: z.number(), costUsd: z.number() });
const recordsSchema = z.array(z.looseObject({}));

/** Account text is data shown inside a table cell: one line, no cell breaks, bounded length. */
function cell(value: string): string {
  const flat = value.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  return flat.length > MAX_CELL_CHARS ? `${flat.slice(0, MAX_CELL_CHARS - 3)}...` : flat;
}

function score(value: number): string {
  return value.toFixed(2);
}

function usageLines(usage: JudgmentUsage): string[] {
  const lines = [`Usage: mode ${usage.mode}, requests ${usage.requests}, cost $${usage.costUsd.toFixed(4)}`];
  if (usage.mode === 'fallback') lines.push(FALLBACK_NOTE);
  return lines;
}

function table(header: string[], rows: string[][]): string[] {
  if (rows.length === 0) return ['Nothing to judge.'];
  const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`];
  for (const row of rows.slice(0, MAX_TEXT_ROWS)) lines.push(`| ${row.join(' | ')} |`);
  if (rows.length > MAX_TEXT_ROWS) {
    lines.push(`${rows.length - MAX_TEXT_ROWS} more rows are in structuredContent.`);
  }
  return lines;
}

function toJson(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

/** Drops keys whose value is undefined, as exactOptionalPropertyTypes requires. */
function defined<T extends Record<string, unknown>>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out as { [K in keyof T]: Exclude<T[K], undefined> };
}

export function register(server: McpServer, runtime: Runtime): void {
  server.registerTool(
    'judge_terms',
    {
      title: 'Judge search terms',
      description:
        'Classifies search terms against what the business sells: relevant, irrelevant, competitor, brand or unclear. Pass `terms`, or a `snapshotId` to judge the costliest terms that had no conversions. Returns judgments, negative-keyword drafts and usage; only terms judged irrelevant or competitor in the act band become drafts, and review-band answers are signals for a person.',
      inputSchema: z.object({
        accountId: z.string().min(1).describe('Id of the configured account the terms belong to.'),
        snapshotId: z
          .string()
          .min(1)
          .optional()
          .describe('Snapshot of that account with a search_terms dataset. Used when `terms` is not given.'),
        terms: z
          .array(z.string())
          .min(1)
          .max(200)
          .optional()
          .describe('Search terms to judge, 1 to 200. Takes precedence over `snapshotId`.'),
        minCost: z
          .number()
          .min(0)
          .optional()
          .describe('Only judge snapshot terms that spent at least this much, in the account currency.'),
        limit: z.number().int().min(1).max(200).optional().describe('Maximum number of terms to judge, 1 to 200.'),
      }),
      outputSchema: z.looseObject({ judgments: recordsSchema, negatives: recordsSchema, usage: usageSchema }),
      annotations: ANNOTATIONS,
    },
    async (args) => {
      try {
        const result = await judgeTerms(runtime, defined(args));
        const withCost = result.judgments.some((judgment) => judgment.cost !== undefined);
        const header = ['term', 'label', 'confidence', 'band', ...(withCost ? ['cost'] : [])];
        const rows = result.judgments.map((judgment) => [
          cell(judgment.term),
          judgment.label,
          score(judgment.confidence),
          judgment.band,
          ...(withCost ? [judgment.cost === undefined ? '' : judgment.cost.toFixed(2)] : []),
        ]);
        const negatives =
          result.negatives.length === 0
            ? 'Proposed negatives: 0'
            : `Proposed negatives: ${result.negatives.length}. Pass \`negatives\` as \`actions\` to plan_create to have them reviewed.`;
        const text = [...table(header, rows), '', negatives, ...usageLines(result.usage)].join('\n');
        return ok(toJson(result), text);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'judge_copy',
    {
      title: 'Judge ad copy',
      description:
        'Screens ad copy for policy risk, clarity and match with the landing page before it is used. Pass up to 20 variants; give `landingText` to get a message-match score. Returns per variant policyRisk, clarity, messageMatch, flags and band, plus usage.',
      inputSchema: z.object({
        accountId: z.string().min(1).describe('Id of the configured account the copy is written for.'),
        variants: z
          .array(
            z.object({
              id: z.string().min(1).describe('Your identifier for this variant; echoed in the result.'),
              headline: z.string().optional().describe('Headline of the ad, when it has one.'),
              body: z.string().min(1).describe('Body text of the ad.'),
              landingText: z.string().optional().describe('Text of the landing page the ad should match.'),
            }),
          )
          .min(1)
          .max(20)
          .describe('Copy variants to screen, 1 to 20.'),
      }),
      outputSchema: z.looseObject({ judgments: recordsSchema, usage: usageSchema }),
      annotations: ANNOTATIONS,
    },
    async (args) => {
      try {
        const result = await judgeCopy(runtime, {
          accountId: args.accountId,
          variants: args.variants.map((variant) => defined(variant)),
        });
        const rows = result.judgments.map((judgment) => [
          cell(judgment.id),
          score(judgment.policyRisk),
          score(judgment.clarity),
          judgment.messageMatch === null ? 'n/a' : score(judgment.messageMatch),
          judgment.flags.length === 0 ? 'none' : cell(judgment.flags.join(', ')),
          judgment.band,
        ]);
        const header = ['variant', 'policyRisk', 'clarity', 'messageMatch', 'flags', 'band'];
        const text = [...table(header, rows), '', ...usageLines(result.usage)].join('\n');
        return ok(toJson(result), text);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'judge_claims',
    {
      title: 'Check claims against the data',
      description:
        'Checks statements you are about to report against the data: a snapshot, an audit or evidence text you supply (at least one is required). Use it before presenting numbers or conclusions to a person. Returns a verdict (verified, contradicted, unsupported), confidence and band per claim; anything not verified must be corrected or dropped.',
      inputSchema: z.object({
        claims: z.array(z.string().min(1)).min(1).max(30).describe('Statements to check, 1 to 30, one fact each.'),
        snapshotId: z.string().min(1).optional().describe('Snapshot whose totals and campaigns are the evidence.'),
        auditId: z.string().min(1).optional().describe('Audit whose score, totals and findings are the evidence.'),
        evidence: z.string().optional().describe('Free text to check the claims against.'),
      }),
      outputSchema: z.looseObject({ judgments: recordsSchema, usage: usageSchema }),
      annotations: ANNOTATIONS,
    },
    async (args) => {
      try {
        const result = await judgeClaims(runtime, defined(args));
        const rows = result.judgments.map((judgment) => [
          cell(judgment.claim),
          judgment.verdict,
          score(judgment.confidence),
          judgment.band,
        ]);
        const text = [
          ...table(['claim', 'verdict', 'confidence', 'band'], rows),
          '',
          ...usageLines(result.usage),
        ].join('\n');
        return ok(toJson(result), text);
      } catch (error) {
        return fail(error);
      }
    },
  );
}
