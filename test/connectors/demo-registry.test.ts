import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createDemoConnector } from '../../src/connectors/demo';
import { connectorStatuses, createConnector } from '../../src/connectors/registry';
import { AutopilotError } from '../../src/core/errors';
import { PLATFORMS } from '../../src/core/types';
import type {
  AccountConfig,
  ActionDraft,
  AutopilotConfig,
  ConnectorDeps,
  HttpClient,
  Platform,
} from '../../src/core/types';
import { buildAction } from '../../src/plan/actions';

const NOW = new Date('2026-03-15T12:00:00Z');
const RANGE = { start: '2026-02-13', end: '2026-03-14' };

const http: HttpClient = {
  request: () => Promise.reject(new Error('network is not available in tests')),
};

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apm-'));
}

function demoAccount(platform: Platform): AccountConfig {
  return { id: `demo-${platform}`, platform, externalId: `ext-${platform}`, source: 'demo' };
}

function depsFor(platform: Platform, home: string): ConnectorDeps {
  return { account: demoAccount(platform), env: { AUTOPILOT_HOME: home }, http, now: () => NOW };
}

const OPTIONS = { validateOnly: false, idempotencyKey: 'key-1' };

async function firstCampaign(deps: ConnectorDeps): Promise<{ id: string; status: unknown }> {
  const snapshot = await createDemoConnector(deps).fetchSnapshot({ account: deps.account, dateRange: RANGE });
  const row = (snapshot.datasets.campaigns ?? []).find((candidate) => candidate.attrs['status'] === 'ENABLED');
  if (row === undefined) throw new Error('the demo data has no enabled campaign');
  return { id: row.id, status: row.attrs['status'] };
}

describe('demo connector', () => {
  it.each(PLATFORMS)('builds a demo snapshot for %s', async (platform) => {
    const deps = depsFor(platform, tempHome());
    const connector = createDemoConnector(deps);
    const status = connector.status();
    expect(connector.platform).toBe(platform);
    expect(connector.source).toBe('demo');
    expect(status.ready).toBe(true);
    expect(status.source).toBe('demo');
    expect(status.datasets.length).toBeGreaterThan(0);
    expect(status.actions.every((kind) => kind.startsWith(`${platform}.`))).toBe(true);
    if (platform === 'ga4' || platform === 'search_console') expect(status.actions).toEqual([]);
    else expect(status.actions.length).toBeGreaterThan(0);

    const snapshot = await connector.fetchSnapshot({ account: deps.account, dateRange: RANGE });
    expect(snapshot.source).toBe('demo');
    expect(snapshot.currency).toBe('USD');
    expect(snapshot.timezone).toBe('UTC');
    expect(Object.keys(snapshot.datasets).sort()).toEqual([...status.datasets].sort());

    const only = status.datasets[0];
    if (only === undefined) throw new Error('no dataset');
    const partial = await connector.fetchSnapshot({ account: deps.account, dateRange: RANGE, datasets: [only] });
    expect(Object.keys(partial.datasets)).toEqual([only]);
  });

  it('rejects an invalid range', async () => {
    const deps = depsFor('google_ads', tempHome());
    await expect(
      createDemoConnector(deps).fetchSnapshot({ account: deps.account, dateRange: { start: '2026-03-10', end: '2026-03-01' } }),
    ).rejects.toBeInstanceOf(AutopilotError);
  });

  it('applies a change that a fresh connector instance sees', async () => {
    const home = tempHome();
    const deps = depsFor('google_ads', home);
    const campaign = await firstCampaign(deps);
    const draft: ActionDraft = {
      kind: 'google_ads.campaign.pause',
      target: { level: 'campaign', id: campaign.id },
      params: {},
      rationale: 'test',
    };
    const connector = createDemoConnector(deps);
    const before = await connector.readState(draft);
    expect(before['status']).toBe('ENABLED');
    expect(typeof before['dailyBudget']).toBe('number');

    const result = await connector.apply(buildAction(draft, before), OPTIONS);
    expect(result).toEqual({ ok: true, dryRun: false, simulated: true, after: null, resource: campaign.id });
    expect((await connector.readState(draft))['status']).toBe('PAUSED');

    const fresh = createDemoConnector(depsFor('google_ads', home));
    expect((await fresh.readState(draft))['status']).toBe('PAUSED');
    const snapshot = await fresh.fetchSnapshot({ account: deps.account, dateRange: RANGE });
    expect(snapshot.datasets.campaigns?.find((row) => row.id === campaign.id)?.attrs['status']).toBe('PAUSED');

    const file = path.join(home, 'demo-state.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const stored: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(stored).toEqual({
      [deps.account.id]: {
        entities: { [`campaign:${campaign.id}`]: { status: 'PAUSED' } },
        negatives: {},
        members: {},
        emails: [],
      },
    });
  });

  it('sets a daily budget', async () => {
    const deps = depsFor('google_ads', tempHome());
    const campaign = await firstCampaign(deps);
    const draft: ActionDraft = {
      kind: 'google_ads.campaign.set_daily_budget',
      target: { level: 'campaign', id: campaign.id },
      params: { dailyBudget: 77.5 },
      rationale: 'test',
    };
    const connector = createDemoConnector(deps);
    await connector.apply(buildAction(draft, await connector.readState(draft)), OPTIONS);
    expect(await connector.readState(draft)).toEqual({ dailyBudget: 77.5 });
  });

  it('changes nothing on validateOnly', async () => {
    const home = tempHome();
    const deps = depsFor('google_ads', home);
    const campaign = await firstCampaign(deps);
    const draft: ActionDraft = {
      kind: 'google_ads.campaign.pause',
      target: { level: 'campaign', id: campaign.id },
      params: {},
      rationale: 'test',
    };
    const connector = createDemoConnector(deps);
    const before = await connector.readState(draft);
    const result = await connector.apply(buildAction(draft, before), { validateOnly: true, idempotencyKey: 'k' });
    expect(result).toEqual({ ok: true, dryRun: true, after: null });
    expect(await connector.readState(draft)).toEqual(before);
    expect(fs.existsSync(path.join(home, 'demo-state.json'))).toBe(false);
  });

  it('adds and removes a negative keyword', async () => {
    const deps = depsFor('google_ads', tempHome());
    const campaign = await firstCampaign(deps);
    const target = { level: 'campaign' as const, id: campaign.id };
    const params = { text: 'free', matchType: 'EXACT' };
    const add: ActionDraft = { kind: 'google_ads.negative_keyword.add', target, params, rationale: 'test' };
    const remove: ActionDraft = { kind: 'google_ads.negative_keyword.remove', target, params, rationale: 'test' };
    const connector = createDemoConnector(deps);

    expect(await connector.readState(add)).toEqual({ exists: false });
    await connector.apply(buildAction(add, { exists: false }), OPTIONS);
    expect(await connector.readState(add)).toEqual({ exists: true });
    expect(await connector.readState({ ...add, params: { text: 'free', matchType: 'PHRASE' } })).toEqual({
      exists: false,
    });
    await connector.apply(buildAction(remove, { exists: true }), OPTIONS);
    expect(await createDemoConnector(deps).readState(remove)).toEqual({ exists: false });
  });

  it('tracks segment membership and email drafts for mautic', async () => {
    const deps = depsFor('mautic', tempHome());
    const connector = createDemoConnector(deps);
    const member: ActionDraft = {
      kind: 'mautic.segment.add_contact',
      target: { level: 'segment', id: '7' },
      params: { contactId: '42' },
      rationale: 'test',
    };
    expect(await connector.readState(member)).toEqual({ member: false });
    await connector.apply(buildAction(member, { member: false }), OPTIONS);
    expect(await connector.readState(member)).toEqual({ member: true });
    const leave: ActionDraft = { ...member, kind: 'mautic.segment.remove_contact' };
    await connector.apply(buildAction(leave, { member: true }), OPTIONS);
    expect(await connector.readState(member)).toEqual({ member: false });

    const email: ActionDraft = {
      kind: 'mautic.email.create_draft',
      target: { level: 'account', id: deps.account.id },
      params: { name: 'Welcome', subject: 'Hello', html: '<p>Hi</p>' },
      rationale: 'test',
    };
    expect(await connector.readState(email)).toEqual({ exists: false });
    await connector.apply(buildAction(email, { exists: false }), OPTIONS);
    expect(await connector.readState(email)).toEqual({ exists: true });
  });

  it('throws not_found for an unknown target', async () => {
    const connector = createDemoConnector(depsFor('google_ads', tempHome()));
    const draft: ActionDraft = {
      kind: 'google_ads.campaign.pause',
      target: { level: 'campaign', id: 'no-such-campaign' },
      params: {},
      rationale: 'test',
    };
    await expect(connector.readState(draft)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('treats an unparseable state file as an empty overlay', async () => {
    const home = tempHome();
    fs.writeFileSync(path.join(home, 'demo-state.json'), '{not json');
    const deps = depsFor('google_ads', home);
    const campaign = await firstCampaign(deps);
    expect(campaign.status).toBe('ENABLED');
  });
});

describe('connector registry', () => {
  const base = { env: { AUTOPILOT_HOME: tempHome() }, http, now: () => NOW };

  it.each(PLATFORMS)('picks the demo connector for a demo %s account', (platform) => {
    const connector = createConnector(demoAccount(platform), base);
    expect(connector.platform).toBe(platform);
    expect(connector.source).toBe('demo');
  });

  it.each(PLATFORMS)('picks the api connector for %s', (platform) => {
    const connector = createConnector({ id: `live-${platform}`, platform, externalId: '123' }, base);
    expect(connector.platform).toBe(platform);
    expect(connector.source).toBe('api');
  });

  it('lists one status per account, in order, and survives a failing status', async () => {
    const accounts: AccountConfig[] = [
      demoAccount('google_ads'),
      { id: 'live-meta', platform: 'meta_ads', externalId: 'act_1' },
      demoAccount('mautic'),
    ];
    const config = { accounts } as AutopilotConfig;
    const statuses = connectorStatuses(config, base);
    expect(statuses.map((status) => status.accountId)).toEqual(['demo-google_ads', 'live-meta', 'demo-mautic']);
    expect(statuses[0]?.ready).toBe(true);
    expect(statuses[1]?.source).toBe('api');
    expect(statuses[1]?.ready).toBe(false);

    vi.resetModules();
    vi.doMock('../../src/connectors/meta-ads', () => ({
      createMetaAdsConnector: () => ({
        platform: 'meta_ads',
        source: 'api',
        status: () => {
          throw new Error('status exploded');
        },
      }),
    }));
    const registry = await import('../../src/connectors/registry');
    const failing = registry.connectorStatuses(config, base);
    vi.doUnmock('../../src/connectors/meta-ads');
    expect(failing[1]).toEqual({
      platform: 'meta_ads',
      accountId: 'live-meta',
      source: 'api',
      ready: false,
      missingEnv: [],
      datasets: [],
      actions: [],
      note: 'status exploded',
    });
    expect(failing[2]?.ready).toBe(true);
  });
});
