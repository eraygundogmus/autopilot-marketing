import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMauticConnector } from '../../src/connectors/mautic';
import {
  clearMauticTokenCache,
  fetchMauticSnapshot,
  mauticAuthMissing,
  mauticRequest,
} from '../../src/connectors/mautic-read';
import { loadEnv } from '../../src/core/env';
import { AutopilotError } from '../../src/core/errors';
import { resolvePaths } from '../../src/core/paths';
import type {
  AccountConfig,
  ConnectorDeps,
  Env,
  HttpClient,
  HttpRequest,
  HttpResponse,
  JsonValue,
} from '../../src/core/types';

vi.mock('../../src/connectors/mautic-write', () => ({
  readMauticState: vi.fn(async () => ({ from: 'write' })),
  applyMauticAction: vi.fn(),
}));

const BASIC: Env = { MAUTIC_USERNAME: 'ada', MAUTIC_PASSWORD: 'pw' };
const OAUTH: Env = { MAUTIC_CLIENT_ID: 'cid', MAUTIC_CLIENT_SECRET: 'sec' };
const RANGE = { start: '2026-09-01', end: '2026-09-30' };

type Handler = (request: HttpRequest) => JsonValue;

function setup(options: { env?: Env; account?: Partial<AccountConfig>; handler?: Handler; now?: () => Date } = {}) {
  const calls: HttpRequest[] = [];
  const handler = options.handler ?? (() => ({ total: 0 }));
  const http: HttpClient = {
    request: async <T = JsonValue>(request: HttpRequest): Promise<HttpResponse<T>> => {
      calls.push(request);
      const body = request.url.endsWith('/oauth/v2/token')
        ? { access_token: `tok${calls.filter((c) => c.url.endsWith('/oauth/v2/token')).length}`, expires_in: 3600 }
        : handler(request);
      return { status: 200, headers: {}, body: body as T };
    },
  };
  const account: AccountConfig = {
    id: 'acme-mautic',
    platform: 'mautic',
    externalId: 'https://m.example.com',
    ...options.account,
  };
  const deps: ConnectorDeps = {
    account,
    env: options.env ?? BASIC,
    http,
    now: options.now ?? (() => new Date('2026-10-01T00:00:00Z')),
  };
  return { deps, calls, account };
}

const pathOf = (request: HttpRequest): string => new URL(request.url).pathname;

function standard(overrides: Record<string, JsonValue> = {}): Handler {
  return (request) => {
    const path = pathOf(request);
    if (path in overrides) return overrides[path] as JsonValue;
    if (path === '/api/segments') {
      return { total: 1, lists: [{ id: 1, name: 'News', alias: 'news', isPublished: true }] };
    }
    if (path === '/api/contacts') return { total: '42', contacts: {} };
    if (path === '/api/emails') {
      return {
        total: 1,
        emails: [
          {
            id: 7,
            name: 'Welcome',
            subject: 'Hi',
            isPublished: true,
            emailType: 'template',
            sentCount: 100,
            readCount: 40,
            clickCount: 9,
            unsubscribeCount: 2,
            bounceCount: 1,
          },
        ],
      };
    }
    if (path === '/api/campaigns') return { total: 1, campaigns: [{ id: 3, name: 'Onboard', isPublished: false }] };
    throw new Error(`unexpected ${path}`);
  };
}

beforeEach(() => {
  clearMauticTokenCache();
});

describe('mauticAuthMissing', () => {
  it('is empty when either method is complete', () => {
    expect(mauticAuthMissing(setup({ env: BASIC }).deps)).toEqual([]);
    expect(mauticAuthMissing(setup({ env: OAUTH }).deps)).toEqual([]);
  });

  it('names the client credentials otherwise', () => {
    expect(mauticAuthMissing(setup({ env: { MAUTIC_USERNAME: 'ada' } }).deps)).toEqual([
      'MAUTIC_CLIENT_ID',
      'MAUTIC_CLIENT_SECRET',
    ]);
  });

  it('resolves through the account prefix', () => {
    const { deps } = setup({
      env: { ACME_MAUTIC_USERNAME: 'ada', ACME_MAUTIC_PASSWORD: 'pw' },
      account: { envPrefix: 'ACME_' },
    });
    expect(mauticAuthMissing(deps)).toEqual([]);
  });
});

describe('mauticRequest', () => {
  it('uses Basic auth, strips the trailing slash and preserves init', async () => {
    const { deps, calls } = setup({ account: { externalId: 'https://m.example.com/' } });
    const request = await mauticRequest(deps, '/segments', {
      method: 'POST',
      json: { a: 1 },
      headers: { 'X-Test': '1' },
    });
    expect(request).toEqual({
      url: 'https://m.example.com/api/segments',
      method: 'POST',
      json: { a: 1 },
      headers: { 'X-Test': '1', Authorization: `Basic ${Buffer.from('ada:pw').toString('base64')}` },
    });
    expect(calls).toHaveLength(0);
  });

  it('prefers OAuth2 client credentials and caches the token until 60 s before expiry', async () => {
    let now = new Date('2026-10-01T00:00:00Z');
    const { deps, calls } = setup({ env: { ...OAUTH, ...BASIC }, now: () => now });
    const first = await mauticRequest(deps, '/emails');
    expect(first.headers).toEqual({ Authorization: 'Bearer tok1' });
    expect(calls[0]).toEqual({
      url: 'https://m.example.com/oauth/v2/token',
      method: 'POST',
      form: { grant_type: 'client_credentials', client_id: 'cid', client_secret: 'sec' },
    });

    now = new Date('2026-10-01T00:58:59Z');
    expect((await mauticRequest(deps, '/emails')).headers).toEqual({ Authorization: 'Bearer tok1' });
    expect(calls).toHaveLength(1);

    now = new Date('2026-10-01T00:59:00Z');
    expect((await mauticRequest(deps, '/emails')).headers).toEqual({ Authorization: 'Bearer tok2' });
    expect(calls).toHaveLength(2);
  });

  it('caches per base URL and can be cleared', async () => {
    const a = setup({ env: OAUTH });
    const b = setup({ env: OAUTH, account: { externalId: 'https://other.example.com' } });
    await mauticRequest(a.deps, '/emails');
    await mauticRequest(b.deps, '/emails');
    expect(b.calls).toHaveLength(1);
    clearMauticTokenCache();
    await mauticRequest(a.deps, '/emails');
    expect(a.calls).toHaveLength(2);
  });

  it('throws not_configured naming the variables, never a value', async () => {
    const { deps } = setup({ env: { MAUTIC_PASSWORD: 'hunter2' } });
    const error = await mauticRequest(deps, '/emails').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AutopilotError);
    expect((error as AutopilotError).code).toBe('not_configured');
    expect((error as AutopilotError).message).toContain('MAUTIC_CLIENT_ID');
    expect((error as AutopilotError).message).toContain('MAUTIC_USERNAME');
    expect((error as AutopilotError).message).not.toContain('hunter2');
  });
});

describe('fetchMauticSnapshot', () => {
  it('normalises the three datasets from array-shaped lists', async () => {
    const { deps, calls, account } = setup({ handler: standard(), account: { timezone: 'Europe/Istanbul' } });
    const snapshot = await fetchMauticSnapshot(deps, { account, dateRange: RANGE });

    expect(snapshot.platform).toBe('mautic');
    expect(snapshot.source).toBe('api');
    expect(snapshot.currency).toBe('XXX');
    expect(snapshot.timezone).toBe('Europe/Istanbul');
    expect(snapshot.datasets.segments).toEqual([
      { id: '1', name: 'News', metrics: { contacts: 42 }, attrs: { alias: 'news', published: true } },
    ]);
    expect(snapshot.datasets.emails).toEqual([
      {
        id: '7',
        name: 'Welcome',
        metrics: { sent: 100, read: 40, clicked: 9, unsubscribed: 2, bounced: 1 },
        attrs: { subject: 'Hi', published: true, emailType: 'template', scope: 'lifetime' },
      },
    ]);
    expect(snapshot.datasets.lifecycle_campaigns).toEqual([
      { id: '3', name: 'Onboard', metrics: {}, attrs: { published: false } },
    ]);
    expect(snapshot.coverage.segments).toEqual({ status: 'complete', rows: 1 });
    expect(snapshot.coverage.emails).toEqual({
      status: 'partial',
      rows: 1,
      note: 'Email counters are lifetime totals, not limited to the date range.',
    });
    expect(snapshot.warnings).toEqual(['Email counters are lifetime totals, not limited to the date range.']);

    const contacts = calls.find((c) => pathOf(c) === '/api/contacts');
    expect(contacts?.query).toEqual({ search: 'segment:news', limit: 1 });
    expect(calls.find((c) => pathOf(c) === '/api/segments')?.query).toEqual({ limit: 200 });
    expect(calls.every((c) => c.headers?.['Authorization']?.startsWith('Basic '))).toBe(true);
  });

  it('accepts lists keyed by id and defaults the timezone to UTC', async () => {
    const { deps, account } = setup({
      handler: standard({
        '/api/segments': {
          total: 2,
          lists: {
            '4': { id: 4, name: 'A', alias: 'a', isPublished: true },
            '9': { id: 9, name: 'B', alias: 'b', isPublished: false },
          },
        },
        '/api/campaigns': { total: 1, campaigns: { '3': { id: 3, name: 'Onboard', isPublished: true, contactCount: 12 } } },
      }),
    });
    const snapshot = await fetchMauticSnapshot(deps, { account, dateRange: RANGE });
    expect(snapshot.timezone).toBe('UTC');
    expect(snapshot.datasets.segments?.map((row) => row.id)).toEqual(['4', '9']);
    expect(snapshot.datasets.lifecycle_campaigns?.[0]?.metrics).toEqual({ contacts: 12 });
  });

  it('counts contacts for the first 50 segments only and marks the rest partial', async () => {
    const lists = Array.from({ length: 53 }, (_, i) => ({ id: i + 1, name: `S${i + 1}`, alias: `s${i + 1}`, isPublished: true }));
    const { deps, calls, account } = setup({ handler: standard({ '/api/segments': { total: 53, lists } }) });
    const snapshot = await fetchMauticSnapshot(deps, { account, dateRange: RANGE, datasets: ['segments'] });

    expect(calls.filter((c) => pathOf(c) === '/api/contacts')).toHaveLength(50);
    const rows = snapshot.datasets.segments ?? [];
    expect(rows).toHaveLength(53);
    expect(rows[49]?.metrics).toEqual({ contacts: 42 });
    expect(rows[50]?.metrics).toEqual({});
    expect(snapshot.coverage.segments?.status).toBe('partial');
    expect(snapshot.coverage.segments?.note).toContain('first 50 of 53');
    expect(snapshot.datasets.emails).toBeUndefined();
  });

  it('marks emails partial when no row has unsubscribe or bounce numbers', async () => {
    const { deps, account } = setup({
      handler: standard({
        '/api/emails': { total: 1, emails: [{ id: 7, name: 'Welcome', subject: 'Hi', sentCount: 10, readCount: 4 }] },
      }),
    });
    const snapshot = await fetchMauticSnapshot(deps, { account, dateRange: RANGE });
    expect(snapshot.datasets.emails?.[0]?.metrics).toEqual({ sent: 10, read: 4 });
    expect(snapshot.datasets.emails?.[0]?.attrs).toEqual({
      subject: 'Hi',
      published: null,
      emailType: null,
      scope: 'lifetime',
    });
    expect(snapshot.coverage.emails?.status).toBe('partial');
    expect(snapshot.coverage.emails?.note).toContain('unsubscribe or bounce');
    expect(snapshot.coverage.emails?.note).toContain('Email counters are lifetime totals, not limited to the date range.');
    expect(snapshot.warnings).toContain('Email counters are lifetime totals, not limited to the date range.');
    expect(snapshot.warnings.some((w) => w.startsWith('emails:'))).toBe(true);
  });

  it('records a failing dataset as missing and keeps the others', async () => {
    const base = standard();
    const { deps, account } = setup({
      handler: (request) => {
        if (pathOf(request) === '/api/emails') throw new AutopilotError('platform_error', 'Mautic 500');
        return base(request);
      },
    });
    const snapshot = await fetchMauticSnapshot(deps, { account, dateRange: RANGE });
    expect(snapshot.datasets.emails).toEqual([]);
    expect(snapshot.coverage.emails?.status).toBe('missing');
    expect(snapshot.coverage.emails?.note).toContain('Mautic 500');
    expect(snapshot.warnings).toHaveLength(1);
    expect(snapshot.datasets.segments).toHaveLength(1);
  });

  it('sends a bearer token with one token request for the whole snapshot', async () => {
    const { deps, calls, account } = setup({ env: OAUTH, handler: standard() });
    await fetchMauticSnapshot(deps, { account, dateRange: RANGE });
    expect(calls.filter((c) => c.url.endsWith('/oauth/v2/token'))).toHaveLength(1);
    const api = calls.filter((c) => !c.url.endsWith('/oauth/v2/token'));
    expect(api.every((c) => c.headers?.['Authorization'] === 'Bearer tok1')).toBe(true);
  });

  it('rejects with not_configured before any request', async () => {
    const { deps, calls, account } = setup({ env: {} });
    await expect(fetchMauticSnapshot(deps, { account, dateRange: RANGE })).rejects.toMatchObject({
      code: 'not_configured',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('unreadable credentials', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-mautic-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const stored = (values: Env, blocked: string[]): Env =>
    loadEnv(resolvePaths({ AUTOPILOT_HOME: home }), {}, { values, blocked });

  it('does not use the global identity when the prefixed secret is unreadable', async () => {
    const env = stored({ ...BASIC, ...OAUTH, ACME_MAUTIC_CLIENT_ID: 'own' }, ['ACME_MAUTIC_CLIENT_SECRET']);
    const { deps, calls, account } = setup({ env, account: { envPrefix: 'ACME_' }, handler: standard() });

    expect(mauticAuthMissing(deps)).toEqual(['ACME_MAUTIC_CLIENT_SECRET']);
    const error = await mauticRequest(deps, '/emails').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AutopilotError);
    expect((error as AutopilotError).code).toBe('not_configured');
    expect((error as AutopilotError).hint).toContain('ACME_MAUTIC_CLIENT_SECRET');
    await expect(fetchMauticSnapshot(deps, { account, dateRange: RANGE })).rejects.toMatchObject({
      code: 'not_configured',
    });
    expect(calls).toHaveLength(0);
  });

  it('does not use the prefixed Basic pair when a prefixed OAuth name is unreadable', async () => {
    const env = stored({ ACME_MAUTIC_USERNAME: 'ada', ACME_MAUTIC_PASSWORD: 'pw' }, ['ACME_MAUTIC_CLIENT_SECRET']);
    const { deps, calls } = setup({ env, account: { envPrefix: 'ACME_' } });
    expect(mauticAuthMissing(deps)).toEqual(['ACME_MAUTIC_CLIENT_SECRET']);
    await expect(mauticRequest(deps, '/emails')).rejects.toMatchObject({ code: 'not_configured' });
    expect(calls).toHaveLength(0);
  });

  it('does not complete a prefixed client id with a global secret', async () => {
    const { deps, calls } = setup({
      env: { ACME_MAUTIC_CLIENT_ID: 'own', MAUTIC_CLIENT_SECRET: 'sec', ...BASIC },
      account: { envPrefix: 'ACME_' },
    });
    expect(mauticAuthMissing(deps)).toEqual(['MAUTIC_CLIENT_ID', 'MAUTIC_CLIENT_SECRET']);
    await expect(mauticRequest(deps, '/emails')).rejects.toMatchObject({ code: 'not_configured' });
    expect(calls).toHaveLength(0);
  });

  it('uses the global names for a prefixed account that has no prefixed name', async () => {
    const { deps } = setup({ env: stored(BASIC, []), account: { envPrefix: 'ACME_' } });
    expect(mauticAuthMissing(deps)).toEqual([]);
    const request = await mauticRequest(deps, '/emails');
    expect(request.headers?.['Authorization']).toBe(`Basic ${Buffer.from('ada:pw').toString('base64')}`);
  });

  it('leaves an account without prefix unconfigured when a global name is unreadable', async () => {
    const env = stored({ ...OAUTH, MAUTIC_USERNAME: 'ada' }, ['MAUTIC_PASSWORD']);
    const { deps, calls } = setup({ env });
    expect(mauticAuthMissing(deps)).toEqual(['MAUTIC_PASSWORD']);
    await expect(mauticRequest(deps, '/emails')).rejects.toMatchObject({ code: 'not_configured' });
    expect(calls).toHaveLength(0);
  });

  it('ignores an unreadable global name once the account has its own complete pair', async () => {
    const env = stored({ ACME_MAUTIC_USERNAME: 'ada', ACME_MAUTIC_PASSWORD: 'pw' }, ['MAUTIC_CLIENT_SECRET']);
    const { deps } = setup({ env, account: { envPrefix: 'ACME_' } });
    expect(mauticAuthMissing(deps)).toEqual([]);
    const request = await mauticRequest(deps, '/emails');
    expect(request.headers?.['Authorization']).toBe(`Basic ${Buffer.from('ada:pw').toString('base64')}`);
  });
});

describe('createMauticConnector', () => {
  it('reports status and delegates', async () => {
    const { deps, account } = setup({ handler: standard() });
    const connector = createMauticConnector(deps);
    expect(connector.platform).toBe('mautic');
    expect(connector.source).toBe('api');
    expect(connector.status()).toEqual({
      platform: 'mautic',
      accountId: 'acme-mautic',
      source: 'api',
      ready: true,
      missingEnv: [],
      datasets: ['segments', 'emails', 'lifecycle_campaigns'],
      actions: ['mautic.segment.add_contact', 'mautic.segment.remove_contact', 'mautic.email.create_draft'],
    });
    const snapshot = await connector.fetchSnapshot({ account, dateRange: RANGE });
    expect(snapshot.accountId).toBe('acme-mautic');

    const unready = createMauticConnector(setup({ env: {} }).deps).status();
    expect(unready.ready).toBe(false);
    expect(unready.missingEnv).toEqual(['MAUTIC_CLIENT_ID', 'MAUTIC_CLIENT_SECRET']);
  });
});
