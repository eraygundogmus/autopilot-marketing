import { AutopilotError } from '../core/errors';
import type { AccountConfig, AttrValue, DatasetCoverage, DatasetName, DateRange, Metrics, Row, Snapshot } from '../core/types';
import { buildSnapshot } from './snapshot';

const DELIMITERS = [',', '\t', ';'] as const;

const SUPPORTED: readonly DatasetName[] = [
  'campaigns',
  'ad_groups',
  'ads',
  'keywords',
  'search_terms',
  'devices',
  'placements',
  'daily',
];

const AMOUNT_SPENT = /^amount spent \(([a-z]{3})\)$/;

const ALIASES = {
  campaign: ['campaign', 'campaign name'],
  adGroup: ['ad group', 'ad group name', 'ad set name'],
  ad: ['ad name', 'ad'],
  keyword: ['keyword', 'search keyword'],
  searchTerm: ['search term'],
  device: ['device'],
  placement: ['placement'],
  day: ['day', 'date', 'reporting starts'],
  campaignId: ['campaign id'],
  adGroupId: ['ad group id', 'ad set id'],
  adId: ['ad id'],
  keywordId: ['keyword id'],
  impressions: ['impr.', 'impressions'],
  clicks: ['clicks'],
  linkClicks: ['link clicks'],
  cost: ['cost', 'spend', 'amount spent'],
  conversions: ['conversions', 'results', 'purchases'],
  conversionValue: ['conv. value', 'conversion value', 'purchases conversion value', 'purchase conversion value'],
  landingPageViews: ['landing page views'],
  status: ['campaign status', 'ad group status', 'ad set delivery', 'delivery', 'status'],
  dailyBudget: ['budget', 'daily budget', 'ad set budget'],
  matchType: ['match type'],
  qualityScore: ['quality score'],
  lostIsBudget: ['search lost is (budget)'],
  lostIsRank: ['search lost is (rank)'],
  frequency: ['frequency'],
  reach: ['reach'],
  searchTermStatus: ['added/excluded'],
  currency: ['currency', 'currency code'],
} as const;

type Field = keyof typeof ALIASES;

const KNOWN_ALIASES: ReadonlySet<string> = new Set(Object.values(ALIASES).flat());

const STATUS: Readonly<Record<string, string>> = {
  enabled: 'ENABLED',
  active: 'ENABLED',
  eligible: 'ENABLED',
  paused: 'PAUSED',
  inactive: 'PAUSED',
  off: 'PAUSED',
  removed: 'REMOVED',
  deleted: 'REMOVED',
  archived: 'REMOVED',
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function normaliseHeader(cell: string): string {
  return cell.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isKnownHeader(cell: string): boolean {
  const key = normaliseHeader(cell);
  return KNOWN_ALIASES.has(key) || AMOUNT_SPENT.test(key);
}

function isEmptyRow(row: string[]): boolean {
  return row.every((cell) => cell.trim() === '');
}

function parseRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStarted = false;
  const endRow = (): void => {
    row.push(field);
    rows.push(row);
    row = [];
    field = '';
    fieldStarted = false;
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text.charAt(i + 1) === '"') {
        field += '"';
        i += 1;
      } else quoted = false;
    } else if (ch === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
      fieldStarted = false;
    } else if (ch === '\n') {
      endRow();
    } else if (ch === '\r' && text.charAt(i + 1) === '\n') {
      i += 1;
      endRow();
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  if (field !== '' || row.length > 0 || fieldStarted) endRow();
  return rows;
}

function findHeaderIndex(rows: string[][]): { index: number; matches: number } {
  for (const [index, row] of rows.entries()) {
    const matches = row.filter(isKnownHeader).length;
    if (matches >= 2) return { index, matches };
  }
  return { index: rows.findIndex((row) => !isEmptyRow(row)), matches: 0 };
}

/** RFC 4180 parser that also skips a BOM and the title lines ad platforms put above the header row. */
export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let best: { rows: string[][]; index: number; matches: number; width: number } | undefined;
  for (const delimiter of DELIMITERS) {
    const rows = parseRows(body, delimiter);
    const { index, matches } = findHeaderIndex(rows);
    if (index < 0) continue;
    const width = rows[index]?.length ?? 0;
    if (!best || matches > best.matches || (matches === best.matches && width > best.width)) {
      best = { rows, index, matches, width };
    }
  }
  if (!best) return { headers: [], rows: [] };
  const headers = (best.rows[best.index] ?? []).map((cell) => cell.trim());
  const rows: string[][] = [];
  for (const row of best.rows.slice(best.index + 1)) {
    if (isEmptyRow(row)) continue;
    // Summary rows read 'Total', 'Total: Account', 'Total - Search'; a campaign named 'Total Care' is data.
    if (/^Total(\s*$|\s*[:\-–—])/.test((row[0] ?? '').trim())) continue;
    rows.push(headers.map((_, i) => row[i] ?? ''));
  }
  return { headers, rows };
}

function slug(...parts: Array<string | undefined>): string {
  return parts
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/** Percent cells become fractions in 0..1; an absent value returns undefined. */
function parseNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim();
  if (text === '' || /^-+$/.test(text)) return undefined;
  const percent = text.includes('%');
  const negative = /^[^\d]*-/.test(text) || /^\(.*\)$/.test(text);
  let digits = text.replace(/[^\d.,]/g, '');
  if (digits === '') return undefined;
  const lastComma = digits.lastIndexOf(',');
  const lastDot = digits.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    digits = lastComma > lastDot ? digits.replace(/\./g, '').replace(',', '.') : digits.replace(/,/g, '');
  } else if (lastComma >= 0) {
    const decimalComma = /^\d+,\d{1,2}$/.test(digits);
    digits = decimalComma ? digits.replace(',', '.') : digits.replace(/,/g, '');
  }
  const value = Number(digits);
  if (!Number.isFinite(value)) return undefined;
  const signed = negative ? -value : value;
  return percent ? signed / 100 : signed;
}

function parseDate(raw: string | undefined): string | undefined {
  const text = (raw ?? '').trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const named = /^([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
  if (!named) return undefined;
  const month = MONTHS.indexOf((named[1] ?? '').toLowerCase());
  if (month < 0) return undefined;
  return `${named[3]}-${String(month + 1).padStart(2, '0')}-${(named[2] ?? '').padStart(2, '0')}`;
}

function normaliseStatus(raw: string): string {
  const key = raw.trim().toLowerCase();
  return STATUS[key] ?? raw.trim().toUpperCase();
}

function normaliseMatchType(raw: string): string {
  const key = raw.trim().toLowerCase().replace(/\s*match$/, '');
  if (key === 'exact' || key === 'phrase' || key === 'broad') return key.toUpperCase();
  return raw.trim().toUpperCase();
}

/** A parent's status must not be read as the row's own, so the alias order depends on the dataset. */
function statusAliases(dataset: DatasetName): readonly string[] {
  if (dataset === 'campaigns') return ['campaign status', 'delivery', 'status'];
  if (dataset === 'ad_groups') return ['ad group status', 'ad set delivery', 'delivery', 'status'];
  return ['status', 'delivery'];
}

interface Columns {
  index: Partial<Record<Field, number>>;
  /** Currency code read from an 'Amount spent (USD)' header. */
  headerCurrency?: string;
}

function resolveColumns(headers: string[], dataset: DatasetName): Columns {
  const keys = headers.map(normaliseHeader);
  const index: Partial<Record<Field, number>> = {};
  for (const field of Object.keys(ALIASES) as Field[]) {
    const aliases: readonly string[] = field === 'status' ? statusAliases(dataset) : ALIASES[field];
    for (const alias of aliases) {
      const at = keys.indexOf(alias);
      if (at >= 0) {
        index[field] = at;
        break;
      }
    }
  }
  const columns: Columns = { index };
  const spentAt = keys.findIndex((key) => AMOUNT_SPENT.test(key));
  if (spentAt >= 0) {
    index.cost ??= spentAt;
    const code = AMOUNT_SPENT.exec(keys[spentAt] ?? '')?.[1];
    if (code) columns.headerCurrency = code.toUpperCase();
  }
  return columns;
}

function buildRow(dataset: DatasetName, columns: Columns, cells: string[], position: number): Row | undefined {
  const text = (field: Field): string | undefined => {
    const at = columns.index[field];
    const value = at === undefined ? undefined : cells[at]?.trim();
    return value === undefined || value === '' || value === '--' ? undefined : value;
  };
  const number = (field: Field): number | undefined => parseNumber(text(field));

  const campaign = text('campaign');
  const adGroup = text('adGroup');
  const campaignId = text('campaignId') ?? (campaign === undefined ? undefined : slug(campaign));
  const adGroupId = text('adGroupId') ?? (adGroup === undefined ? undefined : slug(adGroup));
  const date = parseDate(text('day'));
  const matchTypeRaw = text('matchType');
  const matchType = matchTypeRaw === undefined ? undefined : normaliseMatchType(matchTypeRaw);

  let id: string | undefined;
  let name: string | undefined;
  let withCampaign = true;
  let withAdGroup = true;
  const attrs: Record<string, AttrValue> = {};

  switch (dataset) {
    case 'campaigns':
      id = campaignId;
      name = campaign;
      withCampaign = false;
      withAdGroup = false;
      break;
    case 'ad_groups':
      id = adGroupId;
      name = adGroup;
      withAdGroup = false;
      break;
    case 'ads':
      name = text('ad');
      id = text('adId') ?? (name === undefined ? undefined : slug(name));
      break;
    case 'keywords':
      name = text('keyword');
      id = text('keywordId') ?? slug(campaign ?? campaignId, adGroup ?? adGroupId, name, matchTypeRaw);
      break;
    case 'search_terms':
      name = text('searchTerm');
      id = slug(campaign ?? campaignId, adGroup ?? adGroupId, name);
      break;
    case 'devices':
      name = text('device');
      id = [campaignId, name].filter((part) => part !== undefined).join(':');
      break;
    case 'placements':
      name = text('placement');
      id = [adGroupId, name].filter((part) => part !== undefined).join(':');
      break;
    case 'daily':
      if (date === undefined) return undefined;
      id = date;
      break;
    default:
      break;
  }

  const row: Row = { id: id === undefined || id === '' ? `row-${position + 1}` : id, metrics: {}, attrs };
  if (name !== undefined) row.name = name;
  if (withCampaign && campaignId !== undefined) row.campaignId = campaignId;
  if (withAdGroup && adGroupId !== undefined) row.adGroupId = adGroupId;
  if (date !== undefined) row.date = date;

  const metrics: Metrics = row.metrics;
  const linkClicks = number('linkClicks');
  const metricValues: Array<[string, number | undefined]> = [
    ['impressions', number('impressions')],
    ['clicks', number('clicks') ?? linkClicks],
    ['linkClicks', linkClicks],
    ['cost', number('cost')],
    ['conversions', number('conversions')],
    ['conversionValue', number('conversionValue')],
    ['landingPageViews', number('landingPageViews')],
  ];
  for (const [key, value] of metricValues) {
    if (value !== undefined) metrics[key] = value;
  }

  const status = text('status');
  if (status !== undefined) attrs.status = normaliseStatus(status);
  if (matchType !== undefined) attrs.matchType = matchType;
  const numericAttrs: Field[] = ['dailyBudget', 'qualityScore', 'lostIsBudget', 'lostIsRank', 'frequency', 'reach'];
  for (const field of numericAttrs) {
    const value = number(field);
    if (value !== undefined) attrs[field] = value;
  }
  const termStatus = text('searchTermStatus');
  if (termStatus !== undefined) attrs.searchTermStatus = termStatus.toUpperCase();
  if (dataset === 'devices' && name !== undefined) attrs.device = name;
  if (dataset === 'placements' && name !== undefined) attrs.placement = name;
  return row;
}

/** Builds one snapshot (source 'csv') from platform exports, one file per dataset. */
export function importCsv(input: {
  account: AccountConfig;
  dateRange: DateRange;
  files: Array<{ dataset: DatasetName; text: string }>;
  currency?: string;
  now: Date;
}): Snapshot {
  for (const file of input.files) {
    if (!SUPPORTED.includes(file.dataset)) {
      throw new AutopilotError('unsupported', `CSV import does not support the '${file.dataset}' dataset`, {
        hint: `Supported datasets: ${SUPPORTED.join(', ')}`,
      });
    }
  }

  const datasets: Partial<Record<DatasetName, Row[]>> = {};
  const coverage: Partial<Record<DatasetName, DatasetCoverage>> = {};
  const warnings: string[] = [];
  let columnCurrency: string | undefined;
  let headerCurrency: string | undefined;

  for (const file of input.files) {
    const { headers, rows: cells } = parseCsv(file.text);
    const columns = resolveColumns(headers, file.dataset);
    headerCurrency ??= columns.headerCurrency;
    const currencyAt = columns.index.currency;

    const rows = datasets[file.dataset] ?? [];
    const seen = new Set(rows.map((row) => row.id));
    let skipped = 0;
    let duplicates = 0;
    for (const [position, line] of cells.entries()) {
      if (currencyAt !== undefined && columnCurrency === undefined) {
        const code = line[currencyAt]?.trim().toUpperCase();
        if (code !== undefined && /^[A-Z]{3}$/.test(code)) columnCurrency = code;
      }
      const row = buildRow(file.dataset, columns, line, position);
      if (!row) {
        skipped += 1;
        continue;
      }
      if (seen.has(row.id)) duplicates += 1;
      seen.add(row.id);
      rows.push(row);
    }
    datasets[file.dataset] = rows;

    if (skipped > 0) warnings.push(`${file.dataset}: skipped ${skipped} row(s) without a readable date`);
    if (duplicates > 0) {
      warnings.push(`${file.dataset}: ${duplicates} row(s) share an id with another row; export the id columns`);
    }
    if (columns.index.cost === undefined && columns.index.impressions === undefined) {
      const note = `${file.dataset}: missing columns cost, impressions`;
      coverage[file.dataset] = { status: 'partial', rows: rows.length, note };
      if (!warnings.includes(note)) warnings.push(note);
    } else {
      const previous = coverage[file.dataset];
      coverage[file.dataset] =
        previous?.status === 'partial' ? { ...previous, rows: rows.length } : { status: 'complete', rows: rows.length };
    }
  }

  return buildSnapshot({
    account: input.account,
    source: 'csv',
    dateRange: input.dateRange,
    currency: columnCurrency ?? headerCurrency ?? input.currency ?? input.account.currency ?? 'XXX',
    timezone: input.account.timezone ?? 'UTC',
    datasets,
    coverage,
    warnings,
    now: input.now,
  });
}
