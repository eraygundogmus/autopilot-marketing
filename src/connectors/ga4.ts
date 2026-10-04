import { assertRange } from '../core/dates';
import { AutopilotError } from '../core/errors';
import { redact } from '../core/redact';
import type {
  Connector,
  ConnectorDeps,
  DatasetCoverage,
  DatasetName,
  JsonValue,
  Row,
  SnapshotRequest,
} from '../core/types';
import { GA4_SCOPE, getGoogleAccessToken, googleAuthMissing } from './google-auth';
import { diagnoseGa4 } from './other-diagnose';
import { buildSnapshot } from './snapshot';

const DIMENSIONS = {
  channels: 'sessionDefaultChannelGroup',
  landing_pages: 'landingPagePlusQueryString',
  daily: 'date',
} as const;

type Ga4Dataset = keyof typeof DIMENSIONS;

const GA4_DATASETS = Object.keys(DIMENSIONS) as Ga4Dataset[];
const ROW_LIMIT = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cellValue(cells: unknown, index: number): unknown {
  if (!Array.isArray(cells)) return undefined;
  const cell: unknown = cells[index];
  return isRecord(cell) ? cell['value'] : undefined;
}

/** GA4 returns the date dimension as YYYYMMDD. */
function isoFromCompact(value: string): string {
  return /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : value;
}

function parseRows(body: unknown, dataset: Ga4Dataset): Row[] {
  const raw = isRecord(body) && Array.isArray(body['rows']) ? (body['rows'] as unknown[]) : [];
  const rows: Row[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const dimension = cellValue(entry['dimensionValues'], 0);
    if (typeof dimension !== 'string') continue;
    const id = dataset === 'daily' ? isoFromCompact(dimension) : dimension;
    const metricValues = entry['metricValues'];
    const row: Row = {
      id,
      name: id,
      metrics: {
        sessions: toNumber(cellValue(metricValues, 0)),
        engagedSessions: toNumber(cellValue(metricValues, 1)),
        keyEvents: toNumber(cellValue(metricValues, 2)),
        revenue: toNumber(cellValue(metricValues, 3)),
      },
      attrs: {},
    };
    if (dataset === 'daily') row.date = id;
    rows.push(row);
  }
  return rows;
}

function readOnly(): never {
  throw new AutopilotError('unsupported', 'ga4 is read-only');
}

export function createGa4Connector(deps: ConnectorDeps): Connector {
  const { account, env, http, now } = deps;

  return {
    platform: 'ga4',
    source: 'api',

    status() {
      const missingEnv = googleAuthMissing(env, account);
      return {
        platform: 'ga4',
        accountId: account.id,
        source: 'api',
        ready: missingEnv.length === 0,
        missingEnv,
        datasets: [...GA4_DATASETS],
        actions: [],
      };
    },

    diagnose: () => diagnoseGa4(deps),

    async fetchSnapshot(request: SnapshotRequest) {
      assertRange(request.dateRange);
      const propertyId = account.externalId.replace(/^properties\//, '');
      const wanted = GA4_DATASETS.filter((name) => request.datasets === undefined || request.datasets.includes(name));
      const token = await getGoogleAccessToken({ env, account, http, scopes: [GA4_SCOPE], now });

      const datasets: Partial<Record<DatasetName, Row[]>> = {};
      const coverage: Partial<Record<DatasetName, DatasetCoverage>> = {};
      const warnings: string[] = [];
      let currency: string | undefined;
      let timezone: string | undefined;

      for (const dataset of wanted) {
        try {
          const response = await http.request<JsonValue>({
            url: `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`,
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            json: {
              dateRanges: [{ startDate: request.dateRange.start, endDate: request.dateRange.end }],
              dimensions: [{ name: DIMENSIONS[dataset] }],
              metrics: [
                { name: 'sessions' },
                { name: 'engagedSessions' },
                { name: 'keyEvents' },
                { name: 'totalRevenue' },
              ],
              limit: ROW_LIMIT,
            },
          });
          const body: unknown = response.body;
          const rows = parseRows(body, dataset);
          datasets[dataset] = rows;
          // rowCount is the size of the full result, independent of the request limit.
          const rowCount = isRecord(body) ? toNumber(body['rowCount']) : 0;
          if (rowCount > rows.length) {
            const note = `${rows.length} of ${rowCount} rows were read`;
            coverage[dataset] = { status: 'partial', rows: rows.length, note };
            warnings.push(`ga4 ${dataset} is incomplete: ${note}`);
          }
          const metadata = isRecord(body) ? body['metadata'] : undefined;
          if (isRecord(metadata)) {
            if (currency === undefined && typeof metadata['currencyCode'] === 'string' && metadata['currencyCode'] !== '') {
              currency = metadata['currencyCode'];
            }
            if (timezone === undefined && typeof metadata['timeZone'] === 'string' && metadata['timeZone'] !== '') {
              timezone = metadata['timeZone'];
            }
          }
        } catch (error) {
          const message = redact(error instanceof Error ? error.message : String(error), env).replaceAll(token, '[redacted]');
          coverage[dataset] = { status: 'missing', rows: 0, note: message };
          warnings.push(`ga4 ${dataset} could not be fetched: ${message}`);
        }
      }

      return buildSnapshot({
        account,
        source: 'api',
        dateRange: request.dateRange,
        currency: currency ?? account.currency ?? 'XXX',
        timezone: timezone ?? account.timezone ?? 'UTC',
        datasets,
        coverage,
        warnings,
        now: now(),
      });
    },

    async readState() {
      return readOnly();
    },

    async apply() {
      return readOnly();
    },
  };
}
