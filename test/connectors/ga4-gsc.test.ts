import { describe, expect, it, vi } from 'vitest';

import { createGa4Connector } from '../../src/connectors/ga4';
import { createSearchConsoleConnector } from '../../src/connectors/search-console';
import { AutopilotError } from '../../src/core/errors';
import type { AccountConfig, Action, ActionDraft, HttpClient, HttpRequest, JsonValue } from '../../src/core/types';

const auth = vi.hoisted(() => ({ missing: [] as string[], scopes: [] as string[][] }));

vi.mock('../../src/connectors/google-auth', () => ({
  GOOGLE_ADS_SCOPE: 'https://www.googleapis.com/auth/adwords',
  GA4_SCOPE: 'https://www.googleapis.com/auth/analytics.readonly',
  SEARCH_CONSOLE_SCOPE: 'https://www.googleapis.com/auth/webmasters.readonly',
  googleAuthMissing: () => auth.missing,
  getGoogleAccessToken: async (options: { scopes: string[] }) => {
    auth.scopes.push(options.scopes);
    return 'tok-123';
  },
}));

const NOW = new Date('2026-02-01T00:00:00.000Z');
const RANGE = { start: '2026-01-01', end: '2026-01-31' };

function fakeHttp(handler: (request: HttpRequest) => JsonValue): { http: HttpClient; calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  const http: HttpClient = {
    async request<T = JsonValue>(request: HttpRequest) {
      calls.push(request);
      return { status: 200, headers: {}, body: handler(request) as T };
    },
  };
  return { http, calls };
}

function dimensionOf(request: HttpRequest): string {
  const json = request.json as { dimensions: Array<{ name: string } | string> };
  const first = json.dimensions[0];
  return typeof first === 'string' ? first : (first?.name ?? '');
}

function ga4Row(dimension: string, values: string[]): JsonValue {
  return { dimensionValues: [{ value: dimension }], metricValues: values.map((value) => ({ value })) };
}

async function expectCode(run: () => Promise<unknown>, code: string, message?: string): Promise<void> {
  const error = await run().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(AutopilotError);
  expect((error as AutopilotError).code).toBe(code);
  if (message !== undefined) expect((error as AutopilotError).message).toBe(message);
}

describe('ga4 connector', () => {
  const account: AccountConfig = { id: 'acme-ga4', platform: 'ga4', externalId: 'properties/123', currency: 'EUR', timezone: 'Europe/Berlin' };

  it('sends one runReport per dataset and normalises rows', async () => {
    auth.scopes.length = 0;
    const { http, calls } = fakeHttp((request) => {
      const dimension = dimensionOf(request);
      if (dimension === 'date') {
        return { rows: [ga4Row('20260105', ['10', '6', '2', '99.5'])], metadata: { currencyCode: 'USD', timeZone: 'America/New_York' } };
      }
      if (dimension === 'sessionDefaultChannelGroup') {
        return { rows: [ga4Row('Organic Search', ['100', '60', '5', '250.25'])], metadata: { currencyCode: 'USD', timeZone: 'America/New_York' } };
      }
      return { metadata: { currencyCode: 'USD', timeZone: 'America/New_York' } };
    });
    const connector = createGa4Connector({ account, env: {}, http, now: () => NOW });
    const snapshot = await connector.fetchSnapshot({ account, dateRange: RANGE });

    expect(auth.scopes).toEqual([['https://www.googleapis.com/auth/analytics.readonly']]);
    expect(calls).toHaveLength(3);
    expect(calls.map(dimensionOf)).toEqual(['sessionDefaultChannelGroup', 'landingPagePlusQueryString', 'date']);
    const first = calls[0];
    expect(first?.url).toBe('https://analyticsdata.googleapis.com/v1beta/properties/123:runReport');
    expect(first?.method).toBe('POST');
    expect(first?.headers).toEqual({ Authorization: 'Bearer tok-123' });
    expect(first?.json).toEqual({
      dateRanges: [{ startDate: '2026-01-01', endDate: '2026-01-31' }],
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }, { name: 'engagedSessions' }, { name: 'keyEvents' }, { name: 'totalRevenue' }],
      limit: 1000,
    });

    expect(snapshot.platform).toBe('ga4');
    expect(snapshot.source).toBe('api');
    expect(snapshot.currency).toBe('USD');
    expect(snapshot.timezone).toBe('America/New_York');
    expect(snapshot.createdAt).toBe(NOW.toISOString());
    expect(snapshot.datasets.channels).toEqual([
      { id: 'Organic Search', name: 'Organic Search', metrics: { sessions: 100, engagedSessions: 60, keyEvents: 5, revenue: 250.25 }, attrs: {} },
    ]);
    expect(snapshot.datasets.daily).toEqual([
      { id: '2026-01-05', name: '2026-01-05', date: '2026-01-05', metrics: { sessions: 10, engagedSessions: 6, keyEvents: 2, revenue: 99.5 }, attrs: {} },
    ]);
    expect(snapshot.datasets.landing_pages).toEqual([]);
    expect(snapshot.coverage.landing_pages).toEqual({ status: 'complete', rows: 0 });
    expect(snapshot.warnings).toEqual([]);
  });

  it('falls back to the account currency and timezone, then to XXX and UTC', async () => {
    const { http } = fakeHttp(() => ({ rows: [] }));
    const withAccount = await createGa4Connector({ account, env: {}, http, now: () => NOW }).fetchSnapshot({ account, dateRange: RANGE });
    expect(withAccount.currency).toBe('EUR');
    expect(withAccount.timezone).toBe('Europe/Berlin');

    const bare: AccountConfig = { id: 'bare', platform: 'ga4', externalId: '456' };
    const { http: bareHttp, calls } = fakeHttp(() => ({ rows: [] }));
    const snapshot = await createGa4Connector({ account: bare, env: {}, http: bareHttp, now: () => NOW }).fetchSnapshot({
      account: bare,
      dateRange: RANGE,
      datasets: ['daily'],
    });
    expect(snapshot.currency).toBe('XXX');
    expect(snapshot.timezone).toBe('UTC');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://analyticsdata.googleapis.com/v1beta/properties/456:runReport');
  });

  it('marks a dataset partial when rowCount exceeds the rows returned', async () => {
    const { http } = fakeHttp((request) => {
      if (dimensionOf(request) === 'landingPagePlusQueryString') {
        return { rowCount: 1500, rows: Array.from({ length: 1000 }, (_, index) => ga4Row(`/p/${index}`, ['1', '1', '0', '0'])) };
      }
      return { rowCount: 1, rows: [ga4Row('Direct', ['1', '1', '0', '0'])] };
    });
    const snapshot = await createGa4Connector({ account, env: {}, http, now: () => NOW }).fetchSnapshot({ account, dateRange: RANGE });
    expect(snapshot.coverage.landing_pages).toEqual({ status: 'partial', rows: 1000, note: '1000 of 1500 rows were read' });
    expect(snapshot.coverage.channels).toEqual({ status: 'complete', rows: 1 });
    expect(snapshot.warnings).toEqual(['ga4 landing_pages is incomplete: 1000 of 1500 rows were read']);
  });

  it('marks a failing dataset missing with a note and a warning', async () => {
    const { http } = fakeHttp((request) => {
      if (dimensionOf(request) === 'landingPagePlusQueryString') {
        throw new AutopilotError('platform_error', 'GA4 said no');
      }
      return { rows: [ga4Row('Direct', ['1', '1', '0', '0'])] };
    });
    const snapshot = await createGa4Connector({ account, env: {}, http, now: () => NOW }).fetchSnapshot({ account, dateRange: RANGE });
    expect(snapshot.coverage.landing_pages).toEqual({ status: 'missing', rows: 0, note: 'GA4 said no' });
    expect(snapshot.datasets.landing_pages).toBeUndefined();
    expect(snapshot.warnings).toHaveLength(1);
    expect(snapshot.warnings[0]).toContain('landing_pages');
    expect(snapshot.coverage.channels).toEqual({ status: 'complete', rows: 1 });
  });

  it('rejects a bad range before any request', async () => {
    const { http, calls } = fakeHttp(() => ({}));
    const connector = createGa4Connector({ account, env: {}, http, now: () => NOW });
    await expectCode(() => connector.fetchSnapshot({ account, dateRange: { start: '2026-02-01', end: '2026-01-01' } }), 'invalid_input');
    expect(calls).toHaveLength(0);
  });

  it('reports status and is read-only', async () => {
    const { http } = fakeHttp(() => ({}));
    const connector = createGa4Connector({ account, env: {}, http, now: () => NOW });
    auth.missing = ['GOOGLE_REFRESH_TOKEN'];
    expect(connector.status()).toEqual({
      platform: 'ga4',
      accountId: 'acme-ga4',
      source: 'api',
      ready: false,
      missingEnv: ['GOOGLE_REFRESH_TOKEN'],
      datasets: ['channels', 'landing_pages', 'daily'],
      actions: [],
    });
    auth.missing = [];
    expect(connector.status().ready).toBe(true);
    await expectCode(() => connector.readState({} as ActionDraft), 'unsupported', 'ga4 is read-only');
    await expectCode(() => connector.apply({} as Action, { validateOnly: true, idempotencyKey: 'k' }), 'unsupported', 'ga4 is read-only');
  });
});

describe('search console connector', () => {
  const account: AccountConfig = { id: 'acme-gsc', platform: 'search_console', externalId: 'https://example.com/', currency: 'EUR' };

  it('queries both dimensions and normalises rows', async () => {
    auth.scopes.length = 0;
    const { http, calls } = fakeHttp((request) =>
      dimensionOf(request) === 'query'
        ? { rows: [{ keys: ['running shoes'], clicks: 12, impressions: 340, ctr: 0.0353, position: 4.2 }] }
        : {},
    );
    const connector = createSearchConsoleConnector({ account, env: {}, http, now: () => NOW });
    const snapshot = await connector.fetchSnapshot({ account, dateRange: RANGE });

    expect(auth.scopes).toEqual([['https://www.googleapis.com/auth/webmasters.readonly']]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com%2F/searchAnalytics/query');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers).toEqual({ Authorization: 'Bearer tok-123' });
    expect(calls[0]?.json).toEqual({ startDate: '2026-01-01', endDate: '2026-01-31', dimensions: ['query'], rowLimit: 1000 });
    expect(calls[1]?.json).toEqual({ startDate: '2026-01-01', endDate: '2026-01-31', dimensions: ['page'], rowLimit: 1000 });

    expect(snapshot.platform).toBe('search_console');
    expect(snapshot.currency).toBe('XXX');
    expect(snapshot.timezone).toBe('America/Los_Angeles');
    expect(snapshot.datasets.queries).toEqual([
      { id: 'running shoes', name: 'running shoes', metrics: { clicks: 12, impressions: 340 }, attrs: { ctr: 0.0353, position: 4.2 } },
    ]);
    expect(snapshot.datasets.pages).toEqual([]);
    expect(snapshot.coverage.queries).toEqual({ status: 'complete', rows: 1 });
  });

  it('marks a dataset partial at the row limit', async () => {
    const full = Array.from({ length: 1000 }, (_, index) => ({ keys: [`q${index}`], clicks: 1, impressions: 2, ctr: 0.5, position: 1 }));
    const { http } = fakeHttp((request) => (dimensionOf(request) === 'query' ? { rows: full } : { rows: full.slice(0, 999) }));
    const snapshot = await createSearchConsoleConnector({ account, env: {}, http, now: () => NOW }).fetchSnapshot({ account, dateRange: RANGE });
    expect(snapshot.coverage.queries?.status).toBe('partial');
    expect(snapshot.coverage.queries?.rows).toBe(1000);
    expect(snapshot.coverage.queries?.note).toContain('1000');
    expect(snapshot.coverage.pages).toEqual({ status: 'complete', rows: 999 });
  });

  it('marks a failing dataset missing with a note and a warning', async () => {
    const { http } = fakeHttp((request) => {
      if (dimensionOf(request) === 'page') throw new AutopilotError('platform_error', 'forbidden for Bearer tok-123');
      return { rows: [] };
    });
    const snapshot = await createSearchConsoleConnector({ account, env: {}, http, now: () => NOW }).fetchSnapshot({ account, dateRange: RANGE });
    expect(snapshot.coverage.pages?.status).toBe('missing');
    expect(snapshot.coverage.pages?.note).not.toContain('tok-123');
    expect(snapshot.warnings).toHaveLength(1);
    expect(snapshot.warnings[0]).toContain('pages');
    expect(snapshot.warnings[0]).not.toContain('tok-123');
  });

  it('reports status and is read-only', async () => {
    const { http } = fakeHttp(() => ({}));
    const connector = createSearchConsoleConnector({ account, env: {}, http, now: () => NOW });
    auth.missing = ['GOOGLE_CLIENT_ID'];
    expect(connector.status()).toEqual({
      platform: 'search_console',
      accountId: 'acme-gsc',
      source: 'api',
      ready: false,
      missingEnv: ['GOOGLE_CLIENT_ID'],
      datasets: ['queries', 'pages'],
      actions: [],
    });
    auth.missing = [];
    await expectCode(() => connector.readState({} as ActionDraft), 'unsupported', 'search_console is read-only');
    await expectCode(
      () => connector.apply({} as Action, { validateOnly: false, idempotencyKey: 'k' }),
      'unsupported',
      'search_console is read-only',
    );
  });
});
