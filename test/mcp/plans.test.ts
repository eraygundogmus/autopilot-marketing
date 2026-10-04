import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../../src/core/types';
import { register, reviewFitsElicitation, reviewTooLongError } from '../../src/mcp/tools/plans';
import { auditSnapshot } from '../../src/ops/audit';
import { takeSnapshot } from '../../src/ops/data';
import { connectServer, connectTools } from '../helpers/mcp';
import type { ConnectOptions, TestClient, ToolCallResult } from '../helpers/mcp';
import { tempRuntime } from '../helpers/runtime';

// src/mcp/result.ts belongs to another module: use it when implemented, a faithful fake while it is a stub.
vi.mock('../../src/mcp/result', async (importActual) => {
  const actual = await importActual<typeof import('../../src/mcp/result')>();
  try {
    actual.ok({});
    return actual;
  } catch {
    return {
      ok: (structured: Record<string, unknown>, text?: string) => ({
        content: [{ type: 'text', text: text ?? JSON.stringify(structured) }],
        structuredContent: structured,
      }),
      fail: (error: unknown) => {
        const record = (typeof error === 'object' && error !== null ? error : {}) as {
          code?: string;
          message?: string;
          hint?: string;
        };
        const code = record.code ?? 'internal';
        return {
          content: [{ type: 'text', text: `${code}: ${record.message ?? ''}${record.hint ? `\n${record.hint}` : ''}` }],
          isError: true,
        };
      },
    };
  }
});

async function setup(): Promise<{ runtime: Runtime; client: TestClient }> {
  const { runtime } = tempRuntime();
  const client = await connectTools(runtime, register);
  return { runtime, client };
}

async function setupEliciting(options: ConnectOptions): Promise<{ runtime: Runtime; client: TestClient }> {
  const { runtime } = tempRuntime({ config: { autonomy: 'approve' } });
  const server = new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: { tools: {} } });
  register(server, runtime);
  return { runtime, client: await connectServer(server, options) };
}

async function callOrError(client: TestClient, name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  try {
    return await client.call(name, args);
  } catch (error) {
    return { structured: undefined, text: String(error), isError: true };
  }
}

function campaignId(runtime: Runtime, snapshotId: string): string {
  const row = runtime.store.getSnapshot(snapshotId).datasets.campaigns?.[0];
  if (!row) throw new Error('demo snapshot has no campaign');
  return row.id;
}

async function explicitPlan(runtime: Runtime, client: TestClient): Promise<ToolCallResult> {
  const snapshot = await takeSnapshot(runtime, { accountId: 'demo-google' });
  return client.call('plan_create', {
    accountId: 'demo-google',
    title: 'Pause one campaign',
    rationale: 'Spend without conversions in the period.',
    snapshotId: snapshot.id,
    actions: [
      {
        kind: 'google_ads.campaign.pause',
        target: { level: 'campaign', id: campaignId(runtime, snapshot.id) },
        params: {},
        rationale: 'Spend without conversions in the period.',
      },
    ],
  });
}

describe('plan tools', () => {
  it('lists four tools with destructiveHint only on plan_apply', async () => {
    const { client } = await setup();
    const tools = await client.tools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(['plan_apply', 'plan_create', 'plan_preview', 'plan_revert']);
    const destructive = tools.filter((tool) => tool.annotations?.['destructiveHint'] === true).map((tool) => tool.name);
    expect(destructive).toEqual(['plan_apply']);
    await client.close();
  });

  it('creates a plan from the findings of a demo Google audit', async () => {
    const { runtime, client } = await setup();
    const snapshot = await takeSnapshot(runtime, { accountId: 'demo-google' });
    const audit = await auditSnapshot(runtime, { snapshotId: snapshot.id, judgments: false });
    const withActions = audit.findings.filter((finding) => (finding.suggestedActions ?? []).length > 0);
    expect(withActions.length).toBeGreaterThan(0);

    const result = await client.call('plan_create', {
      accountId: 'demo-google',
      title: 'From findings',
      rationale: 'Audit follow-up',
      auditId: audit.id,
      findingIds: withActions.slice(0, 2).map((finding) => finding.id),
    });
    expect(result.isError).toBe(false);
    expect(String(result.structured?.['planId'])).toMatch(/^plan_/);
    expect(result.structured?.['accountId']).toBe('demo-google');
    const actions = result.structured?.['actions'] as Array<Record<string, unknown>>;
    expect(actions.length).toBeGreaterThan(0);
    expect(Object.keys(actions[0] ?? {})).toEqual(
      expect.arrayContaining(['id', 'kind', 'target', 'before', 'after', 'spendEffect', 'reversible']),
    );
    expect(result.text).toContain('Next: plan_preview');
    await client.close();
  });

  it('creates a plan from explicit actions and rejects an unknown action kind', async () => {
    const { runtime, client } = await setup();
    const created = await explicitPlan(runtime, client);
    expect(created.isError).toBe(false);
    expect(created.text).toContain('google_ads.campaign.pause');
    expect(created.text).toContain('->');

    const rejected = await callOrError(client, 'plan_create', {
      accountId: 'demo-google',
      title: 'Bad',
      rationale: 'Bad',
      actions: [{ kind: 'google_ads.campaign.delete', target: { level: 'campaign', id: '1' }, params: {}, rationale: 'x' }],
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.structured?.['planId']).toBeUndefined();
    await client.close();
  });

  it('previews with the review text and an autonomy denial under the default config', async () => {
    const { runtime, client } = await setup();
    const created = await explicitPlan(runtime, client);
    const planId = String(created.structured?.['planId']);

    const preview = await client.call('plan_preview', { planId });
    expect(preview.isError).toBe(false);
    expect(preview.text.length).toBeGreaterThan(0);
    expect(preview.structured?.['planId']).toBe(planId);
    expect(typeof preview.structured?.['reviewDigest']).toBe('string');
    const policy = preview.structured?.['policy'] as { allowed: boolean; denials: Array<{ ruleId: string }> };
    expect(policy.allowed).toBe(false);
    expect(policy.denials.map((denial) => denial.ruleId)).toContain('autonomy');
    await client.close();
  });

  it('dry run reports that nothing was changed', async () => {
    const { runtime, client } = await setup();
    const created = await explicitPlan(runtime, client);
    const planId = String(created.structured?.['planId']);

    const result = await client.call('plan_apply', { planId });
    expect(result.isError).toBe(false);
    expect(result.structured?.['dryRun']).toBe(true);
    expect(result.structured?.['executionId']).toBeNull();
    expect(result.text).toContain('Nothing was changed.');
    await client.close();
  });

  it('refuses a live run without approval and never reports success', async () => {
    const { runtime, client } = await setup();
    const created = await explicitPlan(runtime, client);
    const planId = String(created.structured?.['planId']);

    const result = await client.call('plan_apply', { planId, dryRun: false });
    expect(result.isError).toBe(true);
    expect(`${result.text} ${JSON.stringify(result.structured ?? {})}`).toMatch(/approval_required|policy_denied/);
    expect(result.structured?.['applied']).toBeUndefined();
    expect(runtime.store.getPlan(planId).status).not.toBe('applied');
    await client.close();
  });

  it('refuses to revert a plan that was never applied, or returns a new plan', async () => {
    const { runtime, client } = await setup();
    const created = await explicitPlan(runtime, client);
    const planId = String(created.structured?.['planId']);

    const result = await client.call('plan_revert', { planId });
    if (result.isError) {
      expect(result.structured?.['planId']).toBeUndefined();
    } else {
      expect(result.structured?.['revertsPlanId']).toBe(planId);
      expect(result.structured?.['planId']).not.toBe(planId);
      expect(result.text).toContain('Money already spent is not recovered.');
    }
    await client.close();
  });

  it('never elicits a review it cannot send in full', () => {
    expect(reviewFitsElicitation('x'.repeat(6000))).toBe(true);
    expect(reviewFitsElicitation('x'.repeat(6001))).toBe(false);
    const error = reviewTooLongError('plan_abc');
    expect(error.code).toBe('approval_required');
    expect(error.hint).toContain('too long for an in-client confirmation');
    expect(error.hint).toContain('autopilot-marketing review plan_abc');
    expect(error.hint).toContain('approve plan_abc');
  });

  it('applies an unchanged plan the person accepted, with an elicitation receipt for the text shown', async () => {
    const shown: string[] = [];
    const { runtime, client } = await setupEliciting({
      elicit: (message) => {
        shown.push(message);
        return { action: 'accept', content: { confirm: true } };
      },
    });
    const planId = String((await explicitPlan(runtime, client)).structured?.['planId']);

    const result = await client.call('plan_apply', { planId, dryRun: false });
    expect(result.isError).toBe(false);
    expect(result.structured?.['dryRun']).toBe(false);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain('Apply exactly these changes?');
    const receipts = runtime.store.findReceipts(planId);
    expect(receipts.map((receipt) => receipt.method)).toEqual(['elicitation']);
    expect(receipts[0]?.reviewDigest).toBe(createHash('sha256').update(shown[0] ?? '', 'utf8').digest('hex'));
    await client.close();
  });

  it('applies nothing when the person declines', async () => {
    const { runtime, client } = await setupEliciting({ elicit: () => ({ action: 'decline' }) });
    const planId = String((await explicitPlan(runtime, client)).structured?.['planId']);

    const result = await callOrError(client, 'plan_apply', { planId, dryRun: false });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('approval_required');
    expect(runtime.store.findReceipts(planId)).toEqual([]);
    expect(runtime.store.getPlan(planId).status).not.toBe('applied');
    await client.close();
  });

  it('rejects an accepted answer when the policy changed after the review was shown', async () => {
    const policies: Array<{ maxActionsPerPlan: number }> = [];
    const { runtime, client } = await setupEliciting({
      elicit: () => {
        // The owner tightens the policy while the prompt is open: the answer was given for the earlier review.
        for (const policy of policies) policy.maxActionsPerPlan -= 1;
        return { action: 'accept', content: { confirm: true } };
      },
    });
    policies.push(runtime.config.policy);
    const planId = String((await explicitPlan(runtime, client)).structured?.['planId']);

    const result = await callOrError(client, 'plan_apply', { planId, dryRun: false });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('stale_state');
    expect(runtime.store.findReceipts(planId)).toEqual([]);
    expect(runtime.store.getPlan(planId).status).not.toBe('applied');
    await client.close();
  });
});
