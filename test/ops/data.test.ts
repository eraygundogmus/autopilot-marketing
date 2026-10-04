import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addDays } from '../../src/core/dates';
import { AutopilotError } from '../../src/core/errors';
import { kpiReport, queryData, snapshotTotals, sourcesOverview, takeSnapshot } from '../../src/ops/data';
import { tempRuntime } from '../helpers/runtime';

const now = () => new Date('2026-06-15T12:00:00Z');

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof AutopilotError) return error.code;
    throw error;
  }
  return 'no error';
}

describe('takeSnapshot', () => {
  it('stores and logs a demo snapshot', async () => {
    const { runtime } = tempRuntime({ now });
    const snapshot = await takeSnapshot(runtime, { accountId: 'demo-google', days: 7 });
    expect(snapshot.source).toBe('demo');
    expect(runtime.store.getSnapshot(snapshot.id).id).toBe(snapshot.id);
    const entries = runtime.ledger.read().filter((entry) => entry.event === 'snapshot.created');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.accountId).toBe('demo-google');
    expect(entries[0]?.data).toMatchObject({ snapshotId: snapshot.id, source: 'demo', contentHash: snapshot.contentHash });
    expect(snapshotTotals(snapshot)).not.toBeNull();
  });

  it('validates days', async () => {
    const { runtime } = tempRuntime({ now });
    for (const days of [0, 366, 1.5]) {
      await expect(takeSnapshot(runtime, { accountId: 'demo-google', days })).rejects.toMatchObject({ code: 'invalid_input' });
    }
    await expect(takeSnapshot(runtime, { accountId: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('imports a CSV file and rejects a missing one', async () => {
    const { runtime, home } = tempRuntime({ now });
    const path = join(home, 'campaigns.csv');
    writeFileSync(path, 'Campaign ID,Campaign,Impressions,Clicks,Cost,Conversions\n1,Brand,1000,100,50,5\n2,Generic,2000,50,80,0\n');
    const snapshot = await takeSnapshot(runtime, { accountId: 'demo-google', days: 7, csvFiles: [{ dataset: 'campaigns', path }] });
    expect(snapshot.source).toBe('csv');
    expect(snapshot.datasets.campaigns).toHaveLength(2);
    expect(runtime.store.getSnapshot(snapshot.id).source).toBe('csv');

    const missing = join(home, 'missing.csv');
    await expect(
      takeSnapshot(runtime, { accountId: 'demo-google', csvFiles: [{ dataset: 'campaigns', path: missing }] }),
    ).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining(missing) });
  });
});

describe('queryData', () => {
  it('filters, sorts, pages, selects fields and derives ratios', async () => {
    const { runtime } = tempRuntime({ now });
    const snapshot = await takeSnapshot(runtime, { accountId: 'demo-google', days: 30 });
    const all = queryData(runtime, { snapshotId: snapshot.id, dataset: 'campaigns', limit: 500 });
    const count = snapshot.datasets.campaigns?.length ?? 0;
    expect(count).toBeGreaterThan(1);
    expect(all.total).toBe(count);
    expect(all.rows.length).toBe(Math.min(count, 200));

    const first = all.rows[0];
    const source = snapshot.datasets.campaigns?.[0];
    expect(first?.id).toBe(source?.id);
    const clicks = source?.metrics.clicks ?? 0;
    const cost = source?.metrics.cost ?? 0;
    expect(first?.cpc).toBe(clicks === 0 ? null : cost / clicks);

    const sorted = queryData(runtime, { snapshotId: snapshot.id, dataset: 'campaigns', sortBy: 'cost', limit: 200 });
    const costs = sorted.rows.map((row) => Number(row.cost));
    expect(costs).toEqual([...costs].sort((a, b) => b - a));
    const asc = queryData(runtime, { snapshotId: snapshot.id, dataset: 'campaigns', sortBy: 'cost', order: 'asc', limit: 200 });
    expect(asc.rows.map((row) => row.id)).toEqual(sorted.rows.map((row) => row.id).reverse());

    const page = queryData(runtime, { snapshotId: snapshot.id, dataset: 'campaigns', sortBy: 'cost', limit: 1, offset: 1 });
    expect(page.total).toBe(count);
    expect(page.offset).toBe(1);
    expect(page.rows.map((row) => row.id)).toEqual([sorted.rows[1]?.id]);

    const threshold = costs[1] ?? 0;
    const filtered = queryData(runtime, {
      snapshotId: snapshot.id,
      dataset: 'campaigns',
      where: [{ field: 'cost', op: 'gte', value: threshold }],
      fields: ['cost'],
    });
    expect(filtered.total).toBe(costs.filter((value) => value >= threshold).length);
    expect(Object.keys(filtered.rows[0] ?? {}).sort()).toEqual(['cost', 'id']);

    const target = String(sorted.rows[0]?.id);
    const eq = queryData(runtime, { snapshotId: snapshot.id, dataset: 'campaigns', where: [{ field: 'id', op: 'eq', value: target }] });
    expect(eq.total).toBe(1);
    const ne = queryData(runtime, { snapshotId: snapshot.id, dataset: 'campaigns', where: [{ field: 'id', op: 'ne', value: target }] });
    expect(ne.total).toBe(count - 1);
    const name = String(sorted.rows[0]?.name ?? '');
    const contains = queryData(runtime, {
      snapshotId: snapshot.id,
      dataset: 'campaigns',
      where: [{ field: 'name', op: 'contains', value: name.toUpperCase() }],
    });
    expect(contains.total).toBeGreaterThanOrEqual(1);
    const nonNumeric = queryData(runtime, { snapshotId: snapshot.id, dataset: 'campaigns', where: [{ field: 'name', op: 'gt', value: 0 }] });
    expect(nonNumeric.total).toBe(0);
  });

  it('rejects unknown fields and absent datasets', async () => {
    const { runtime, home } = tempRuntime({ now });
    const snapshot = await takeSnapshot(runtime, { accountId: 'demo-google', days: 7 });
    const base = { snapshotId: snapshot.id, dataset: 'campaigns' as const };
    expect(codeOf(() => queryData(runtime, { ...base, where: [{ field: 'bogus', op: 'eq', value: 1 }] }))).toBe('invalid_input');
    expect(codeOf(() => queryData(runtime, { ...base, sortBy: 'bogus' }))).toBe('invalid_input');
    try {
      queryData(runtime, { ...base, sortBy: 'bogus' });
    } catch (error) {
      expect((error as AutopilotError).hint).toContain('cost');
    }

    const path = join(home, 'c.csv');
    writeFileSync(path, 'Campaign ID,Campaign,Impressions,Clicks,Cost,Conversions\n1,Brand,1000,0,50,5\n');
    const csv = await takeSnapshot(runtime, { accountId: 'demo-google', days: 7, csvFiles: [{ dataset: 'campaigns', path }] });
    expect(codeOf(() => queryData(runtime, { snapshotId: csv.id, dataset: 'keywords' }))).toBe('invalid_input');
    const row = queryData(runtime, { snapshotId: csv.id, dataset: 'campaigns' }).rows[0];
    expect(row?.cpc).toBeNull();
    expect(row?.ctr).toBe(0);
  });
});

describe('kpiReport', () => {
  it('takes two snapshots with adjacent ranges', async () => {
    const { runtime } = tempRuntime({ now });
    const report = await kpiReport(runtime, { accountId: 'demo-google', days: 7 });
    expect(report).toBeDefined();
    const snapshots = runtime.store.listSnapshots({ accountId: 'demo-google' });
    expect(snapshots).toHaveLength(2);
    const ranges = snapshots.map((summary) => runtime.store.getSnapshot(summary.id).dateRange).sort((a, b) => (a.start < b.start ? -1 : 1));
    expect(addDays(ranges[0]?.end ?? '', 1)).toBe(ranges[1]?.start);
    expect(runtime.ledger.read().filter((entry) => entry.event === 'snapshot.created')).toHaveLength(2);
  });

  it('rejects a snapshot of another account before taking any snapshot', async () => {
    const { runtime } = tempRuntime({ now });
    const foreign = await takeSnapshot(runtime, { accountId: 'demo-meta', days: 7 });
    expect(foreign.source).not.toBe('csv');
    const created = () => runtime.ledger.read().filter((entry) => entry.event === 'snapshot.created').length;
    const before = created();

    await expect(kpiReport(runtime, { accountId: 'demo-google', snapshotId: foreign.id })).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('demo-meta'),
    });
    await expect(kpiReport(runtime, { accountId: 'demo-google', days: 7, previousSnapshotId: foreign.id })).rejects.toMatchObject({
      code: 'invalid_input',
    });

    expect(runtime.store.listSnapshots({ accountId: 'demo-google' })).toHaveLength(0);
    expect(created()).toBe(before);
  });
});

describe('sourcesOverview', () => {
  it('lists the accounts, the brief and no secret values', () => {
    const secret = 'sk-very-secret-value-123';
    const { runtime, home } = tempRuntime({ now, env: { TYPESAFE_API_KEY: secret, GOOGLE_ADS_DEVELOPER_TOKEN: secret } });
    expect(sourcesOverview(runtime).brief).toBeNull();
    writeFileSync(runtime.paths.brief, 'x'.repeat(5000));
    const overview = sourcesOverview(runtime);
    expect(overview.home).toBe(home);
    expect(overview.accounts).toHaveLength(5);
    expect(overview.accounts[0]).toMatchObject({ id: 'demo-google', platform: 'google_ads' });
    expect(typeof overview.accounts[0]?.hasBrandTerms).toBe('boolean');
    expect(overview.brief).toHaveLength(4000);
    expect(overview.ledger.ok).toBe(true);
    expect(overview.killSwitch).toBe(false);
    expect(JSON.stringify(overview)).not.toContain(secret);
  });
});
