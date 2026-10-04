import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { formatMoney } from '../../core/money';
import { DATASETS } from '../../core/types';
import type { AttrValue, JsonObject, KpiSet, Runtime, Snapshot } from '../../core/types';
import { queryData, snapshotTotals, takeSnapshot } from '../../ops/data';
import type { FlatRow, QueryInput, QueryResult, SnapshotInput } from '../../ops/data';
import { fail, ok } from '../result';

const MAX_COLUMNS = 12;
const MAX_CELL_CHARS = 60;
const MAX_WARNINGS_IN_TEXT = 20;

/** Column order used when the caller did not ask for specific fields. */
const USEFUL_FIELDS = [
  'date',
  'status',
  'cost',
  'impressions',
  'clicks',
  'conversions',
  'conversionValue',
  'ctr',
  'cpc',
  'cpa',
  'roas',
  'conversionRate',
  'campaignId',
  'adGroupId',
];

const datasetSchema = z.enum(DATASETS);

const snapshotCreateInput = z.object({
  accountId: z.string().min(1).describe('Id of a configured account, as listed by the sources overview (e.g. demo-google).'),
  days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe('Number of complete days ending yesterday. Default 30. Ignored when dateRange is given.'),
  dateRange: z
    .object({
      start: z.string().describe('First day, ISO date YYYY-MM-DD, inclusive.'),
      end: z.string().describe('Last day, ISO date YYYY-MM-DD, inclusive.'),
    })
    .optional()
    .describe('Explicit date range. Takes precedence over days.'),
  datasets: z
    .array(datasetSchema)
    .optional()
    .describe('Datasets to fetch. Default: every dataset the platform connector supports.'),
  csvFiles: z
    .array(
      z.object({
        dataset: datasetSchema.describe('Dataset the export file contains.'),
        path: z.string().min(1).describe('Absolute path of a platform CSV export on this machine.'),
      }),
    )
    .optional()
    .describe('Platform CSV exports to import instead of calling the API.'),
});

const snapshotCreateOutput = z.looseObject({
  snapshotId: z.string(),
  accountId: z.string(),
  platform: z.string(),
  source: z.string(),
  dateRange: z.looseObject({ start: z.string(), end: z.string() }),
  currency: z.string(),
  timezone: z.string(),
  coverage: z.record(z.string(), z.unknown()),
  warnings: z.array(z.string()),
  totals: z.unknown(),
});

const dataQueryInput = z.object({
  snapshotId: z.string().min(1).describe('Snapshot id returned by snapshot_create (snap_...).'),
  dataset: datasetSchema.describe('Dataset of the snapshot to read rows from.'),
  where: z
    .array(
      z.object({
        field: z.string().min(1).describe('Row field to compare, e.g. cost, status, name.'),
        op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains']).describe('Comparison operator.'),
        value: z.union([z.string(), z.number(), z.boolean()]).describe('Value to compare the field with.'),
      }),
    )
    .optional()
    .describe('Conditions a row must all satisfy.'),
  sortBy: z.string().min(1).optional().describe('Field to sort by, e.g. cost or cpa.'),
  order: z.enum(['asc', 'desc']).optional().describe('Sort direction. Default desc.'),
  limit: z.number().int().min(1).max(200).optional().describe('Maximum rows to return. Default 25.'),
  offset: z.number().int().min(0).optional().describe('Rows to skip before the first returned row. Default 0.'),
  fields: z.array(z.string().min(1)).optional().describe('Fields to keep on each row. id is always kept.'),
});

const dataQueryOutput = z.looseObject({
  snapshotId: z.string(),
  dataset: z.string(),
  total: z.number(),
  offset: z.number(),
  rows: z.array(z.looseObject({})),
});

/** Drops undefined values so the result is plain JSON. */
function toJson(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function snapshotInput(args: z.infer<typeof snapshotCreateInput>): SnapshotInput {
  const input: SnapshotInput = { accountId: args.accountId };
  if (args.days !== undefined) input.days = args.days;
  if (args.dateRange !== undefined) input.dateRange = args.dateRange;
  if (args.datasets !== undefined) input.datasets = args.datasets;
  if (args.csvFiles !== undefined) input.csvFiles = args.csvFiles;
  return input;
}

function queryInput(args: z.infer<typeof dataQueryInput>): QueryInput {
  const input: QueryInput = { snapshotId: args.snapshotId, dataset: args.dataset };
  if (args.where !== undefined) input.where = args.where;
  if (args.sortBy !== undefined) input.sortBy = args.sortBy;
  if (args.order !== undefined) input.order = args.order;
  if (args.limit !== undefined) input.limit = args.limit;
  if (args.offset !== undefined) input.offset = args.offset;
  if (args.fields !== undefined) input.fields = args.fields;
  return input;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '';
  return String(Math.round(value * 10000) / 10000);
}

function formatRatio(value: number | null): string {
  return value === null ? 'n/a' : formatNumber(value);
}

function totalsLine(totals: KpiSet, currency: string): string {
  const cpa = totals.cpa === null ? 'n/a' : formatMoney(totals.cpa, currency);
  return [
    `Totals: cost ${formatMoney(totals.cost, currency)}`,
    `impressions ${formatNumber(totals.impressions)}`,
    `clicks ${formatNumber(totals.clicks)}`,
    `conversions ${formatNumber(totals.conversions)}`,
    `conversion value ${formatMoney(totals.conversionValue, currency)}`,
    `CTR ${formatRatio(totals.ctr)}`,
    `CPA ${cpa}`,
    `ROAS ${formatRatio(totals.roas)}`,
  ].join(', ');
}

function snapshotText(snapshot: Snapshot, totals: KpiSet | null): string {
  const lines = [
    `Snapshot ${snapshot.id} (${snapshot.source}) of ${snapshot.accountId}, ${snapshot.dateRange.start} to ${snapshot.dateRange.end}`,
  ];
  for (const [dataset, coverage] of Object.entries(snapshot.coverage)) {
    const note = coverage.note === undefined ? '' : ` (${coverage.note})`;
    lines.push(`- ${dataset}: ${coverage.rows} rows, ${coverage.status}${note}`);
  }
  if (totals !== null) lines.push(totalsLine(totals, snapshot.currency));
  if (snapshot.warnings.length > 0) {
    lines.push('Warnings:');
    for (const warning of snapshot.warnings.slice(0, MAX_WARNINGS_IN_TEXT)) lines.push(`- ${warning}`);
    const hidden = snapshot.warnings.length - MAX_WARNINGS_IN_TEXT;
    if (hidden > 0) lines.push(`- and ${hidden} more`);
  }
  return lines.join('\n');
}

function columnsFor(rows: FlatRow[], requested: string[] | undefined): string[] {
  const present = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) present.add(key);
  const columns: string[] = [];
  const add = (field: string): void => {
    if (present.has(field) && !columns.includes(field)) columns.push(field);
  };
  add('id');
  add('name');
  for (const field of requested ?? USEFUL_FIELDS) add(field);
  if (requested === undefined) for (const field of present) add(field);
  return columns.slice(0, MAX_COLUMNS);
}

/** Row values come from ad accounts: keep them inside one table cell. */
function cell(value: AttrValue | undefined): string {
  if (value === undefined || value === null) return '';
  const raw = typeof value === 'number' ? formatNumber(value) : String(value);
  const flat = raw.replace(/[\r\n\t]+/g, ' ').replace(/\|/g, '\\|');
  return flat.length > MAX_CELL_CHARS ? `${flat.slice(0, MAX_CELL_CHARS - 3)}...` : flat;
}

function queryText(result: QueryResult, requested: string[] | undefined): string {
  const summary = `${result.rows.length} of ${result.total} rows (${result.dataset}, offset ${result.offset})`;
  if (result.withheld !== undefined) {
    return `${result.total} rows match (${result.dataset}). The owner's sharing policy for this account keeps rows on this machine: use audit_run and report_build for findings and totals.`;
  }
  if (result.rows.length === 0) return summary;
  const columns = columnsFor(result.rows, requested);
  const lines = [
    summary,
    '',
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...result.rows.map((row) => `| ${columns.map((column) => cell(row[column])).join(' | ')} |`),
  ];
  return lines.join('\n');
}

export function register(server: McpServer, runtime: Runtime): void {
  server.registerTool(
    'snapshot_create',
    {
      title: 'Create a snapshot',
      description:
        "Takes a normalised, immutable copy of one account's data for a date range and returns its snapshot id with dataset coverage and totals. " +
        'Use it first: audits, data queries, reports and plans all work from a snapshot id. ' +
        'When there is no API access, pass csvFiles to import platform CSV exports instead.',
      inputSchema: snapshotCreateInput,
      outputSchema: snapshotCreateOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const snapshot = await takeSnapshot(runtime, snapshotInput(args));
        const totals = snapshotTotals(snapshot);
        const structured = toJson({
          snapshotId: snapshot.id,
          accountId: snapshot.accountId,
          platform: snapshot.platform,
          source: snapshot.source,
          dateRange: snapshot.dateRange,
          currency: snapshot.currency,
          timezone: snapshot.timezone,
          coverage: snapshot.coverage,
          warnings: snapshot.warnings,
          totals,
        });
        return ok(structured, snapshotText(snapshot, totals));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'data_query',
    {
      title: 'Query snapshot rows',
      description:
        'Filters, sorts and pages the rows of one dataset in a snapshot, and returns the matching rows with the total count. ' +
        'Use it to inspect campaigns, ad groups, keywords, search terms and other datasets after snapshot_create. ' +
        'Ratios such as ctr, cpc, cpa and roas are computed by the tool, so sort and filter on them directly.',
      inputSchema: dataQueryInput,
      outputSchema: dataQueryOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const result = queryData(runtime, queryInput(args));
        return ok(toJson(result), queryText(result, args.fields));
      } catch (error) {
        return fail(error);
      }
    },
  );
}
