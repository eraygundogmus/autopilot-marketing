import { afterEach, describe, expect, it, vi } from 'vitest';
import { register } from '../../src/mcp/tools/snapshots';
import { connectTools } from '../helpers/mcp';
import type { TestClient } from '../helpers/mcp';
import { tempRuntime } from '../helpers/runtime';

vi.mock('../../src/mcp/result', () => ({
  ok: (structured: Record<string, unknown>, text?: string) => ({
    content: [{ type: 'text', text: text ?? JSON.stringify(structured) }],
    structuredContent: structured,
  }),
  fail: (error: unknown) => {
    const source = error as { code?: unknown; message?: unknown; hint?: unknown };
    const code = typeof source.code === 'string' ? source.code : 'internal';
    const message = typeof source.message === 'string' ? source.message : String(error);
    const hint = typeof source.hint === 'string' ? source.hint : '';
    return { content: [{ type: 'text', text: `${code}: ${message}\nHint: ${hint}` }], isError: true };
  },
}));

const RANGE = { start: '2026-08-01', end: '2026-08-30' };
const NOW = (): Date => new Date('2026-09-15T12:00:00Z');

let open: TestClient | undefined;

async function connect(): Promise<TestClient> {
  const { runtime } = tempRuntime({ now: NOW });
  open = await connectTools(runtime, register);
  return open;
}

async function snapshotId(client: TestClient): Promise<string> {
  const created = await client.call('snapshot_create', { accountId: 'demo-google', dateRange: RANGE });
  expect(created.isError).toBe(false);
  return String(created.structured?.snapshotId);
}

type Rows = Array<Record<string, unknown>>;

afterEach(async () => {
  await open?.close();
  open = undefined;
});

describe('snapshot tools', () => {
  it('lists both tools with their annotations', async () => {
    const client = await connect();
    const tools = await client.tools();
    const byName = new Map(tools.map((tool) => [tool.name, tool.annotations]));
    expect([...byName.keys()].sort()).toEqual(['data_query', 'snapshot_create']);
    expect(byName.get('snapshot_create')).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(byName.get('data_query')).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });

  it('snapshot_create returns an id, coverage and totals, and is idempotent for a range', async () => {
    const client = await connect();
    const first = await client.call('snapshot_create', { accountId: 'demo-google', dateRange: RANGE });
    expect(first.isError).toBe(false);
    const structured = first.structured ?? {};
    expect(String(structured.snapshotId)).toMatch(/^snap_[0-9a-f]{16}$/);
    expect(structured.accountId).toBe('demo-google');
    expect(structured.dateRange).toEqual(RANGE);
    const coverage = structured.coverage as Record<string, { rows: number; status: string }>;
    expect(coverage.campaigns?.rows).toBeGreaterThan(0);
    const totals = structured.totals as { cost: number; clicks: number };
    expect(totals.cost).toBeGreaterThan(0);
    expect(structured).not.toHaveProperty('datasets');

    expect(first.text).toContain(String(structured.snapshotId));
    expect(first.text).toContain('2026-08-01 to 2026-08-30');
    expect(first.text).toMatch(/- campaigns: \d+ rows, /);
    expect(first.text).toContain(`Totals: cost `);
    expect(first.text).toContain(String(structured.currency));

    const second = await client.call('snapshot_create', { accountId: 'demo-google', dateRange: RANGE });
    expect(second.structured?.snapshotId).toBe(structured.snapshotId);
  });

  it('snapshot_create reports an unknown account with the known ids', async () => {
    const client = await connect();
    const result = await client.call('snapshot_create', { accountId: 'nope' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('not_found');
    expect(result.text).toContain('demo-google');
  });

  it('snapshot_create rejects days outside 1..365', async () => {
    const client = await connect();
    const result = await client.call('snapshot_create', { accountId: 'demo-google', days: 0 });
    expect(result.isError).toBe(true);
  });

  it('data_query sorts campaigns by cost', async () => {
    const client = await connect();
    const id = await snapshotId(client);
    const result = await client.call('data_query', { snapshotId: id, dataset: 'campaigns', sortBy: 'cost' });
    expect(result.isError).toBe(false);
    const rows = result.structured?.rows as Rows;
    const costs = rows.map((row) => Number(row.cost));
    expect(costs.length).toBeGreaterThan(1);
    expect(costs).toEqual([...costs].sort((a, b) => b - a));
    expect(result.text).toContain(`${rows.length} of ${String(result.structured?.total)} rows`);
    expect(result.text).toMatch(/\| id \| name \|/);
    const header = result.text.split('\n').find((line) => line.startsWith('| id'));
    expect((header?.split('|').length ?? 0) - 2).toBeLessThanOrEqual(12);

    const ascending = await client.call('data_query', {
      snapshotId: id,
      dataset: 'campaigns',
      sortBy: 'cost',
      order: 'asc',
    });
    const ascCosts = (ascending.structured?.rows as Rows).map((row) => Number(row.cost));
    expect(ascCosts).toEqual([...costs].reverse());
  });

  it('data_query filters with where and keeps the requested fields', async () => {
    const client = await connect();
    const id = await snapshotId(client);
    const all = await client.call('data_query', { snapshotId: id, dataset: 'campaigns', sortBy: 'cost' });
    const allRows = all.structured?.rows as Rows;
    const threshold = Number(allRows[1]?.cost);
    const expected = allRows.filter((row) => Number(row.cost) >= threshold).length;

    const result = await client.call('data_query', {
      snapshotId: id,
      dataset: 'campaigns',
      where: [{ field: 'cost', op: 'gte', value: threshold }],
      fields: ['cost'],
    });
    expect(result.isError).toBe(false);
    expect(result.structured?.total).toBe(expected);
    const rows = result.structured?.rows as Rows;
    for (const row of rows) {
      expect(Number(row.cost)).toBeGreaterThanOrEqual(threshold);
      expect(Object.keys(row).sort()).toEqual(['cost', 'id']);
    }
    expect(result.text).toContain('| id | cost |');
  });

  it('data_query pages', async () => {
    const client = await connect();
    const id = await snapshotId(client);
    const all = await client.call('data_query', { snapshotId: id, dataset: 'campaigns', sortBy: 'cost' });
    const allRows = all.structured?.rows as Rows;
    const page = await client.call('data_query', {
      snapshotId: id,
      dataset: 'campaigns',
      sortBy: 'cost',
      limit: 1,
      offset: 1,
    });
    const rows = page.structured?.rows as Rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(allRows[1]?.id);
    expect(page.structured?.offset).toBe(1);
    expect(page.structured?.total).toBe(all.structured?.total);
    expect(page.text).toContain(`1 of ${String(all.structured?.total)} rows`);
  });

  it('data_query names the available fields for an unknown field', async () => {
    const client = await connect();
    const id = await snapshotId(client);
    const result = await client.call('data_query', { snapshotId: id, dataset: 'campaigns', sortBy: 'nonsense' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('invalid_input');
    expect(result.text).toContain("Unknown field 'nonsense'");
    expect(result.text).toContain('Available fields:');
    expect(result.text).toContain('cost');
  });

  it('data_query reports an unknown snapshot as an error', async () => {
    const client = await connect();
    const result = await client.call('data_query', { snapshotId: 'snap_0000000000000000', dataset: 'campaigns' });
    expect(result.isError).toBe(true);
  });
});
