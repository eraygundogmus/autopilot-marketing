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
import { SEARCH_CONSOLE_SCOPE, getGoogleAccessToken, googleAuthMissing } from './google-auth';
import { diagnoseSearchConsole } from './other-diagnose';
import { buildSnapshot } from './snapshot';

const DIMENSIONS = { queries: 'query', pages: 'page' } as const;

type GscDataset = keyof typeof DIMENSIONS;

const GSC_DATASETS = Object.keys(DIMENSIONS) as GscDataset[];
const ROW_LIMIT = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseRows(body: unknown): Row[] {
  const raw = isRecord(body) && Array.isArray(body['rows']) ? (body['rows'] as unknown[]) : [];
  const rows: Row[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const keys = entry['keys'];
    const key: unknown = Array.isArray(keys) ? keys[0] : undefined;
    if (typeof key !== 'string') continue;
    rows.push({
      id: key,
      name: key,
      metrics: { clicks: toNumber(entry['clicks']), impressions: toNumber(entry['impressions']) },
      attrs: { ctr: toNumber(entry['ctr']), position: toNumber(entry['position']) },
    });
  }
  return rows;
}

function readOnly(): never {
  throw new AutopilotError('unsupported', 'search_console is read-only');
}

export function createSearchConsoleConnector(deps: ConnectorDeps): Connector {
  const { account, env, http, now } = deps;

  return {
    platform: 'search_console',
    source: 'api',

    status() {
      const missingEnv = googleAuthMissing(env, account);
      return {
        platform: 'search_console',
        accountId: account.id,
        source: 'api',
        ready: missingEnv.length === 0,
        missingEnv,
        datasets: [...GSC_DATASETS],
        actions: [],
      };
    },

    diagnose: () => diagnoseSearchConsole(deps),

    async fetchSnapshot(request: SnapshotRequest) {
      assertRange(request.dateRange);
      const siteUrl = account.externalId;
      const wanted = GSC_DATASETS.filter((name) => request.datasets === undefined || request.datasets.includes(name));
      const token = await getGoogleAccessToken({ env, account, http, scopes: [SEARCH_CONSOLE_SCOPE], now });

      const datasets: Partial<Record<DatasetName, Row[]>> = {};
      const coverage: Partial<Record<DatasetName, DatasetCoverage>> = {};
      const warnings: string[] = [];

      for (const dataset of wanted) {
        try {
          const response = await http.request<JsonValue>({
            url: `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            json: {
              startDate: request.dateRange.start,
              endDate: request.dateRange.end,
              dimensions: [DIMENSIONS[dataset]],
              rowLimit: ROW_LIMIT,
            },
          });
          const rows = parseRows(response.body);
          datasets[dataset] = rows;
          if (rows.length >= ROW_LIMIT) {
            coverage[dataset] = {
              status: 'partial',
              rows: rows.length,
              note: `Row limit of ${ROW_LIMIT} reached; lower-volume ${dataset} are not included.`,
            };
          }
        } catch (error) {
          const message = redact(error instanceof Error ? error.message : String(error), env).replaceAll(token, '[redacted]');
          coverage[dataset] = { status: 'missing', rows: 0, note: message };
          warnings.push(`search_console ${dataset} could not be fetched: ${message}`);
        }
      }

      return buildSnapshot({
        account,
        source: 'api',
        dateRange: request.dateRange,
        currency: 'XXX',
        // Search Console reports in Pacific time.
        timezone: 'America/Los_Angeles',
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
