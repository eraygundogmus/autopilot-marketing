import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutopilotError } from '../../src/core/errors';
import { fail, ok } from '../../src/mcp/result';
import { register as registerLedger } from '../../src/mcp/tools/ledger';
import { register as registerSources } from '../../src/mcp/tools/sources';
import { connectTools } from '../helpers/mcp';
import { tempRuntime } from '../helpers/runtime';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('result', () => {
  it('ok returns the structured content and a text block', () => {
    expect(ok({ a: 1 })).toEqual({ content: [{ type: 'text', text: '{"a":1}' }], structuredContent: { a: 1 } });
    expect(ok({ a: 1 }, 'one').content).toEqual([{ type: 'text', text: 'one' }]);
  });

  it('fail carries code, message, retryable and hint', () => {
    const result = fail(new AutopilotError('not_found', 'no such plan', { hint: 'call plan_create' }));
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'Error (not_found): no such plan\nNext: call plan_create' }]);
    expect(result.structuredContent).toEqual({
      error: { code: 'not_found', message: 'no such plan', retryable: false, hint: 'call plan_create' },
    });
  });

  it('fail wraps unknown errors as internal, without a hint key', () => {
    const result = fail(new Error('boom'));
    expect(result.content[0]?.text).toBe('Error (internal): boom');
    expect(result.structuredContent).toEqual({ error: { code: 'internal', message: 'boom', retryable: false } });
    expect(fail(new AutopilotError('rate_limited', 'slow down')).structuredContent).toMatchObject({
      error: { retryable: true },
    });
  });

  it('fail redacts a secret env value in the message and the hint', () => {
    vi.stubEnv('APM_TEST_API_KEY', 'sk-very-secret-value-123');
    const result = fail(
      new AutopilotError('platform_error', 'request with sk-very-secret-value-123 failed', {
        hint: 'rotate sk-very-secret-value-123',
      }),
    );
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('sk-very-secret-value-123');
    expect(serialised).toContain('[redacted:APM_TEST_API_KEY]');
  });
});

describe('sources_list', () => {
  it('lists the five demo accounts and autonomy propose on a fresh runtime', async () => {
    const { runtime } = tempRuntime();
    const client = await connectTools(runtime, registerSources);
    try {
      const tools = await client.tools();
      expect(tools.map((tool) => tool.name)).toEqual(['sources_list']);
      expect(tools[0]?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });

      const result = await client.call('sources_list');
      expect(result.isError).toBe(false);
      const accounts = result.structured?.accounts as Array<Record<string, unknown>>;
      expect(accounts).toHaveLength(5);
      expect(result.structured?.autonomy).toBe('propose');
      expect(result.text).toContain('Autonomy: propose');
      expect(result.text).toContain('Kill switch: off');
      expect(result.text).toContain('Policy: ');
      for (const account of accounts) expect(result.text).toContain(`- ${String(account.id)} | `);
    } finally {
      await client.close();
    }
  });
});

describe('ledger_list', () => {
  it('returns appended entries, honours limit and reports integrity', async () => {
    const { runtime } = tempRuntime();
    const client = await connectTools(runtime, registerLedger);
    try {
      const empty = await client.call('ledger_list');
      expect(empty.isError).toBe(false);
      expect(empty.structured?.entries).toEqual([]);
      expect(empty.text).toContain('No matching ledger entries.');

      const actor = { kind: 'system' as const, id: 'test' };
      runtime.ledger.append({ event: 'snapshot.created', actor, accountId: 'acc_a' });
      runtime.ledger.append({ event: 'plan.created', actor, accountId: 'acc_a', planId: 'plan_1' });
      const last = runtime.ledger.append({ event: 'plan.previewed', actor, planId: 'plan_1' });

      const all = await client.call('ledger_list');
      expect(all.structured?.entries).toHaveLength(3);
      expect(all.structured?.integrity).toEqual({ ok: true, entries: 3, brokenAt: null });
      expect(all.text).toContain('Integrity: ok (3 entries)');
      expect(all.text).toContain(`#${last.seq} ${last.ts} plan.previewed plan=plan_1 action=-`);

      const limited = await client.call('ledger_list', { limit: 1 });
      const entries = limited.structured?.entries as Array<Record<string, unknown>>;
      expect(entries).toHaveLength(1);
      expect(entries[0]?.seq).toBe(last.seq);

      const filtered = await client.call('ledger_list', { events: ['plan.created'], planId: 'plan_1' });
      expect(filtered.structured?.entries).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it('rejects arguments outside the schema', async () => {
    const { runtime } = tempRuntime();
    const client = await connectTools(runtime, registerLedger);
    try {
      expect((await client.call('ledger_list', { limit: 0 })).isError).toBe(true);
      expect((await client.call('ledger_list', { events: ['not.an.event'] })).isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
