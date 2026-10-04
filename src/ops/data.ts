import { existsSync, readFileSync, statSync } from 'node:fs';
import { importCsv } from '../connectors/csv';
import { assertRange, lastNDays, previousRange } from '../core/dates';
import { AutopilotError } from '../core/errors';
import { kpis, ratio, sumMetrics } from '../core/metrics';
import type { AttrValue, DatasetName, DateRange, KpiReport, KpiSet, Row, Runtime, Snapshot } from '../core/types';
import { buildKpiReport } from '../report/kpi';

export interface SnapshotInput {
  accountId: string;
  /** Complete days ending yesterday; default 30. Ignored when `dateRange` is given. */
  days?: number;
  dateRange?: DateRange;
  datasets?: DatasetName[];
  /** Platform exports to import instead of calling the API. */
  csvFiles?: Array<{ dataset: DatasetName; path: string }>;
}

const MAX_CSV_BYTES = 50 * 1024 * 1024;
const BRIEF_MAX_CHARS = 4000;

function resolveRange(runtime: Runtime, input: SnapshotInput): DateRange {
  if (input.dateRange !== undefined) {
    assertRange(input.dateRange);
    return input.dateRange;
  }
  const days = input.days ?? 30;
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new AutopilotError('invalid_input', 'days must be an integer between 1 and 365', {
      hint: 'Pass days from 1 to 365, or an explicit dateRange',
    });
  }
  return lastNDays(days, runtime.now());
}

function readCsvFile(path: string): string {
  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error('not a file');
    size = stat.size;
  } catch (error) {
    throw new AutopilotError('invalid_input', `CSV file not found: ${path}`, {
      hint: 'Pass the path of an existing platform export',
      cause: error,
    });
  }
  if (size > MAX_CSV_BYTES) {
    throw new AutopilotError('invalid_input', `CSV file is larger than 50 MB: ${path}`, {
      hint: 'Export a shorter date range or fewer columns',
    });
  }
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new AutopilotError('invalid_input', `CSV file could not be read: ${path}`, { cause: error });
  }
}

/** Takes, stores and logs a snapshot. The single path for the CLI and the MCP tool. */
export async function takeSnapshot(runtime: Runtime, input: SnapshotInput): Promise<Snapshot> {
  const account = runtime.account(input.accountId);
  const dateRange = resolveRange(runtime, input);
  let snapshot: Snapshot;
  if (input.csvFiles !== undefined && input.csvFiles.length > 0) {
    const files = input.csvFiles.map((file) => ({ dataset: file.dataset, text: readCsvFile(file.path) }));
    snapshot = importCsv({ account, dateRange, files, now: runtime.now() });
  } else {
    snapshot = await runtime.connector(account).fetchSnapshot({
      account,
      dateRange,
      ...(input.datasets === undefined ? {} : { datasets: input.datasets }),
    });
  }
  runtime.store.saveSnapshot(snapshot);
  runtime.ledger.append({
    event: 'snapshot.created',
    actor: { kind: 'system', id: 'autopilot' },
    accountId: account.id,
    data: {
      snapshotId: snapshot.id,
      source: snapshot.source,
      dateRange: { start: snapshot.dateRange.start, end: snapshot.dateRange.end },
      contentHash: snapshot.contentHash,
    },
  });
  return snapshot;
}

export interface QueryInput {
  snapshotId: string;
  dataset: DatasetName;
  where?: Array<{ field: string; op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains'; value: string | number | boolean }>;
  sortBy?: string;
  order?: 'asc' | 'desc';
  /** Default 25, at most 200. */
  limit?: number;
  offset?: number;
  fields?: string[];
}

export type FlatRow = Record<string, AttrValue | undefined>;

export interface QueryResult {
  snapshotId: string;
  dataset: DatasetName;
  total: number;
  offset: number;
  rows: FlatRow[];
}

type Condition = NonNullable<QueryInput['where']>[number];

function flatten(row: Row): FlatRow {
  const flat: FlatRow = { id: row.id };
  if (row.name !== undefined) flat.name = row.name;
  if (row.campaignId !== undefined) flat.campaignId = row.campaignId;
  if (row.adGroupId !== undefined) flat.adGroupId = row.adGroupId;
  if (row.date !== undefined) flat.date = row.date;
  for (const [key, value] of Object.entries(row.metrics)) {
    if (value !== undefined) flat[key] = value;
  }
  for (const [key, value] of Object.entries(row.attrs)) {
    if (value !== undefined) flat[key] = value;
  }
  const m = row.metrics;
  flat.ctr = ratio(m.clicks, m.impressions);
  flat.cpc = ratio(m.cost, m.clicks);
  flat.cpa = ratio(m.cost, m.conversions);
  flat.roas = ratio(m.conversionValue, m.cost);
  flat.conversionRate = ratio(m.conversions, m.clicks);
  return flat;
}

function toNumber(value: AttrValue | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function looseEqual(actual: AttrValue | undefined, expected: string | number | boolean): boolean {
  if (actual === undefined || actual === null) return false;
  if (actual === expected) return true;
  if (typeof actual === 'boolean' || typeof expected === 'boolean') return String(actual) === String(expected);
  const a = toNumber(actual);
  const b = toNumber(expected);
  if (a !== null && b !== null) return a === b;
  return String(actual) === String(expected);
}

function matches(row: FlatRow, condition: Condition): boolean {
  const actual = row[condition.field];
  switch (condition.op) {
    case 'eq':
      return looseEqual(actual, condition.value);
    case 'ne':
      return !looseEqual(actual, condition.value);
    case 'contains':
      if (actual === undefined || actual === null) return false;
      return String(actual).toLowerCase().includes(String(condition.value).toLowerCase());
    default: {
      const a = toNumber(actual);
      const b = typeof condition.value === 'boolean' ? null : toNumber(condition.value);
      if (a === null || b === null) return false;
      if (condition.op === 'gt') return a > b;
      if (condition.op === 'gte') return a >= b;
      if (condition.op === 'lt') return a < b;
      return a <= b;
    }
  }
}

function compareValues(a: AttrValue, b: AttrValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Filters, sorts and pages rows of a stored snapshot. Derived ratios are computed here, never by a model. */
export function queryData(runtime: Runtime, input: QueryInput): QueryResult {
  const snapshot = runtime.store.getSnapshot(input.snapshotId);
  const source = snapshot.datasets[input.dataset];
  if (source === undefined) {
    const present = Object.keys(snapshot.datasets);
    throw new AutopilotError('invalid_input', `Snapshot ${snapshot.id} has no '${input.dataset}' dataset`, {
      hint: `Datasets in this snapshot: ${present.length > 0 ? present.join(', ') : 'none'}`,
    });
  }
  const flat = source.map(flatten);
  const available = new Set<string>(['id', 'ctr', 'cpc', 'cpa', 'roas', 'conversionRate']);
  for (const row of flat) for (const key of Object.keys(row)) available.add(key);
  const requireField = (field: string, where: string): void => {
    if (!available.has(field)) {
      throw new AutopilotError('invalid_input', `Unknown field '${field}' in ${where}`, {
        hint: `Available fields: ${[...available].sort().join(', ')}`,
      });
    }
  };

  const where = input.where ?? [];
  for (const condition of where) requireField(condition.field, 'where');
  if (input.sortBy !== undefined) requireField(input.sortBy, 'sortBy');

  let rows = flat.filter((row) => where.every((condition) => matches(row, condition)));
  const total = rows.length;

  if (input.sortBy !== undefined) {
    const key = input.sortBy;
    const direction = (input.order ?? 'desc') === 'asc' ? 1 : -1;
    rows = rows
      .map((row, index) => ({ row, index }))
      .sort((left, right) => {
        const a = left.row[key];
        const b = right.row[key];
        const aMissing = a === undefined || a === null;
        const bMissing = b === undefined || b === null;
        if (aMissing || bMissing) {
          if (aMissing && bMissing) return left.index - right.index;
          return aMissing ? 1 : -1;
        }
        return direction * compareValues(a, b) || left.index - right.index;
      })
      .map((entry) => entry.row);
  }

  const limit = clampInt(input.limit, 25, 1, 200);
  const offset = clampInt(input.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  let page = rows.slice(offset, offset + limit);

  if (input.fields !== undefined) {
    const keep = ['id', ...input.fields.filter((field) => field !== 'id')];
    page = page.map((row) => {
      const picked: FlatRow = {};
      for (const field of keep) {
        const value = row[field];
        if (value !== undefined) picked[field] = value;
      }
      return picked;
    });
  }

  return { snapshotId: snapshot.id, dataset: input.dataset, total, offset, rows: page };
}

/** Totals of a snapshot's main dataset, for a one-line summary. */
export function snapshotTotals(snapshot: Snapshot): KpiSet | null {
  const rows = snapshot.datasets.campaigns ?? snapshot.datasets.daily;
  if (rows === undefined) return null;
  return kpis(sumMetrics(rows));
}

export interface ReportInput {
  accountId: string;
  days?: number;
  snapshotId?: string;
  previousSnapshotId?: string;
}

/** Current period against the one before it; takes the snapshots it needs. */
export async function kpiReport(runtime: Runtime, input: ReportInput): Promise<KpiReport> {
  const account = runtime.account(input.accountId);
  // Every supplied snapshot is loaded and checked before any snapshot is taken,
  // so a rejected request fetches nothing, stores nothing and logs nothing.
  const supplied = (id: string | undefined): Snapshot | null => {
    if (id === undefined) return null;
    const snapshot = runtime.store.getSnapshot(id);
    if (snapshot.accountId !== account.id) {
      throw new AutopilotError('invalid_input', `Snapshot ${snapshot.id} belongs to account '${snapshot.accountId}', not '${account.id}'`, {
        hint: `Pass a snapshot of account '${account.id}'`,
      });
    }
    return snapshot;
  };
  const suppliedCurrent = supplied(input.snapshotId);
  const suppliedPrevious = supplied(input.previousSnapshotId);

  const current = suppliedCurrent ?? (await takeSnapshot(runtime, { accountId: account.id, days: input.days ?? 30 }));
  let previous: Snapshot | null;
  if (suppliedPrevious !== null) {
    previous = suppliedPrevious;
  } else if (current.source === 'csv') {
    previous = null;
  } else {
    previous = await takeSnapshot(runtime, { accountId: account.id, dateRange: previousRange(current.dateRange) });
  }
  return buildKpiReport({ current, previous, account });
}

export interface SourcesOverview {
  home: string;
  autonomy: string;
  configuredAutonomy: string;
  killSwitch: boolean;
  judgment: { mode: string; model: string };
  business: { name: string; description: string } | null;
  /** The human-written `brief.md`, capped; data, not instructions. */
  brief: string | null;
  accounts: Array<Record<string, unknown>>;
  policy: Record<string, unknown>;
  ledger: { ok: boolean; entries: number; brokenAt: number | null };
}

function readBrief(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf8').slice(0, BRIEF_MAX_CHARS);
  } catch {
    return null;
  }
}

export function sourcesOverview(runtime: Runtime): SourcesOverview {
  const { config } = runtime;
  const accounts = config.accounts.map((account): Record<string, unknown> => {
    let status: Record<string, unknown>;
    try {
      status = { ...runtime.connector(account).status() };
    } catch (error) {
      status = {
        platform: account.platform,
        accountId: account.id,
        ready: false,
        note: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      ...status,
      id: account.id,
      label: account.label ?? account.id,
      platform: account.platform,
      targets: account.targets ?? null,
      hasBrandTerms: (account.brandTerms?.length ?? 0) > 0,
    };
  });
  return {
    home: runtime.paths.home,
    autonomy: runtime.autonomy,
    configuredAutonomy: config.autonomy,
    killSwitch: runtime.killSwitch(),
    judgment: { mode: runtime.judge.mode, model: config.judgment.model },
    business: config.business ? { name: config.business.name, description: config.business.description } : null,
    brief: readBrief(runtime.paths.brief),
    accounts,
    policy: { ...config.policy },
    ledger: runtime.ledger.verify(),
  };
}
