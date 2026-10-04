import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { policyDigest } from '../../src/core/config';
import { createServer } from '../../src/mcp/server';
import type { AutopilotConfig, Runtime } from '../../src/core/types';
import { connectServer } from '../helpers/mcp';
import type { TestClient } from '../helpers/mcp';
import { tempRuntime } from '../helpers/runtime';

/**
 * What must hold through the public surface an agent actually has: the MCP tools. Each case drives
 * the real server over a real (in-memory) MCP connection against the demo account.
 */

const ACCOUNT = 'demo-google';

async function setup(config: Partial<AutopilotConfig> = {}): Promise<{ runtime: Runtime; home: string; mcp: TestClient }> {
  const { runtime, home } = tempRuntime({ config });
  const mcp = await connectServer(createServer(runtime));
  return { runtime, home, mcp };
}

function errorCode(result: { structured: Record<string, unknown> | undefined }): string | undefined {
  return (result.structured?.['error'] as { code?: string } | undefined)?.code;
}

async function snapshot(mcp: TestClient): Promise<string> {
  const result = await mcp.call('snapshot_create', { accountId: ACCOUNT, days: 30 });
  expect(result.isError).toBe(false);
  return result.structured?.['snapshotId'] as string;
}

/** A one-action plan pausing a demo keyword that spends without converting. */
async function pausePlan(mcp: TestClient, snapshotId: string, keywordId = 'c4-ag1~1'): Promise<string> {
  const result = await mcp.call('plan_create', {
    accountId: ACCOUNT,
    snapshotId,
    title: 'Pause a wasteful keyword',
    rationale: 'The keyword spent without converting in the last 30 days.',
    actions: [
      {
        kind: 'google_ads.keyword.pause',
        target: { level: 'keyword', id: keywordId },
        params: {},
        rationale: 'Spent without converting in the last 30 days.',
      },
    ],
  });
  expect(result.isError, result.text).toBe(false);
  return result.structured?.['planId'] as string;
}

function demoState(home: string): string {
  const file = join(home, 'demo-state.json');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

function actionEvents(runtime: Runtime): string[] {
  return runtime.ledger
    .read({ accountId: ACCOUNT })
    .map((entry) => entry.event)
    .filter((event) => event.startsWith('action.') || event.startsWith('execution.'));
}

/** What `autopilot-marketing approve` does after a person says yes. */
async function approveAsPerson(runtime: Runtime, mcp: TestClient, planId: string): Promise<string> {
  const preview = await mcp.call('plan_preview', { planId });
  const receipt = runtime.approvals.issue({
    plan: runtime.store.getPlan(planId),
    policyDigest: policyDigest(runtime.config.policy),
    reviewDigest: preview.structured?.['reviewDigest'] as string,
    method: 'tty',
    approver: 'test-person',
    now: runtime.now(),
  });
  return receipt.id;
}

describe('an agent cannot change a live account on its own', () => {
  it('refuses a live run at the default autonomy level and changes nothing', async () => {
    const { runtime, home, mcp } = await setup();
    const planId = await pausePlan(mcp, await snapshot(mcp));
    const live = await mcp.call('plan_apply', { planId, dryRun: false });
    expect(live.isError).toBe(true);
    expect(errorCode(live)).toBe('policy_denied');
    expect(demoState(home)).toBe('');
    expect(actionEvents(runtime)).toEqual([]);
  });

  it('defaults to a dry run', async () => {
    const { runtime, home, mcp } = await setup({ autonomy: 'approve' });
    const planId = await pausePlan(mcp, await snapshot(mcp));
    const dry = await mcp.call('plan_apply', { planId });
    expect(dry.isError).toBe(false);
    expect(dry.structured?.['dryRun']).toBe(true);
    expect(dry.structured?.['applied']).toBe(0);
    expect(demoState(home)).toBe('');
    expect(actionEvents(runtime)).toEqual([]);
  });

  it('refuses a live run without an approval, even when autonomy allows approved plans', async () => {
    const { runtime, home, mcp } = await setup({ autonomy: 'approve' });
    const planId = await pausePlan(mcp, await snapshot(mcp));
    const live = await mcp.call('plan_apply', { planId, dryRun: false });
    expect(live.isError).toBe(true);
    expect(errorCode(live)).toBe('approval_required');
    expect(live.text).toContain(`autopilot-marketing approve ${planId}`);
    expect(demoState(home)).toBe('');
    expect(actionEvents(runtime)).toEqual([]);
  });

  it('offers no tool that approves a plan or changes the policy', async () => {
    const { mcp } = await setup();
    const names = (await mcp.tools()).map((tool) => tool.name);
    expect(names).toHaveLength(14);
    expect(names.filter((name) => /approv|receipt|policy|config|autonomy/i.test(name))).toEqual([]);
  });

  it('rejects an action kind outside the allowlist', async () => {
    const { mcp } = await setup({ autonomy: 'approve' });
    const result = await mcp.call('plan_create', {
      accountId: ACCOUNT,
      title: 'Delete a campaign',
      rationale: 'Deleting is not something this tool can do.',
      actions: [
        { kind: 'google_ads.campaign.delete', target: { level: 'campaign', id: 'c4' }, params: {}, rationale: 'Remove it entirely.' },
      ],
    });
    expect(result.isError).toBe(true);
  });
});

describe('an approval covers exactly one plan, once', () => {
  it('applies an approved plan, records it, and refuses a second run', async () => {
    const { runtime, home, mcp } = await setup({ autonomy: 'approve' });
    const planId = await pausePlan(mcp, await snapshot(mcp));
    const receiptId = await approveAsPerson(runtime, mcp, planId);

    const live = await mcp.call('plan_apply', { planId, dryRun: false, receiptId });
    expect(live.isError, live.text).toBe(false);
    expect(live.structured?.['applied']).toBe(1);
    expect(live.structured?.['status']).toBe('applied');
    expect(demoState(home)).toContain('"PAUSED"');

    const events = actionEvents(runtime);
    expect(events).toEqual(['execution.claimed', 'action.intent', 'action.applied', 'execution.closed']);
    expect(runtime.ledger.verify().ok).toBe(true);

    const again = await mcp.call('plan_apply', { planId, dryRun: false, receiptId });
    expect(again.isError).toBe(true);
    expect(actionEvents(runtime)).toEqual(events);
  });

  it('does not let the approval of one plan apply another', async () => {
    const { runtime, home, mcp } = await setup({ autonomy: 'approve' });
    const snapshotId = await snapshot(mcp);
    const approved = await pausePlan(mcp, snapshotId, 'c4-ag1~1');
    const other = await pausePlan(mcp, snapshotId, 'c4-ag1~2');
    const receiptId = await approveAsPerson(runtime, mcp, approved);

    const live = await mcp.call('plan_apply', { planId: other, dryRun: false, receiptId });
    expect(live.isError).toBe(true);
    expect(['approval_required', 'approval_invalid']).toContain(errorCode(live));
    expect(demoState(home)).toBe('');
  });

  it('refuses a stored plan that was edited after it was approved', async () => {
    const { runtime, home, mcp } = await setup({ autonomy: 'approve' });
    const planId = await pausePlan(mcp, await snapshot(mcp));
    const receiptId = await approveAsPerson(runtime, mcp, planId);

    const plan = runtime.store.getPlan(planId);
    const first = plan.actions[0];
    if (!first) throw new Error('the plan has no action');
    first.target = { ...first.target, id: 'c4-ag2~1' };
    runtime.store.savePlan(plan);

    const live = await mcp.call('plan_apply', { planId, dryRun: false, receiptId });
    expect(live.isError).toBe(true);
    expect(demoState(home)).toBe('');
  });
});

describe('an applied change can be undone, under the same rules', () => {
  it('reverts through a new plan that needs its own approval', async () => {
    const { runtime, home, mcp } = await setup({ autonomy: 'approve' });
    const planId = await pausePlan(mcp, await snapshot(mcp));
    await mcp.call('plan_apply', { planId, dryRun: false, receiptId: await approveAsPerson(runtime, mcp, planId) });
    expect(demoState(home)).toContain('"PAUSED"');

    const revert = await mcp.call('plan_revert', { planId });
    expect(revert.isError, revert.text).toBe(false);
    const revertId = revert.structured?.['planId'] as string;
    expect(revertId).not.toBe(planId);

    const unapproved = await mcp.call('plan_apply', { planId: revertId, dryRun: false });
    expect(errorCode(unapproved)).toBe('approval_required');
    expect(demoState(home)).toContain('"PAUSED"');

    const applied = await mcp.call('plan_apply', {
      planId: revertId,
      dryRun: false,
      receiptId: await approveAsPerson(runtime, mcp, revertId),
    });
    expect(applied.isError, applied.text).toBe(false);
    expect(applied.structured?.['applied']).toBe(1);
    expect(demoState(home)).toContain('"ENABLED"');
    expect(runtime.ledger.verify().ok).toBe(true);
  });
});

describe('the policy is enforced by the server', () => {
  it('denies a budget change above the limit, whatever the caller says', async () => {
    const { mcp } = await setup({ autonomy: 'approve' });
    const snapshotId = await snapshot(mcp);
    const created = await mcp.call('plan_create', {
      accountId: ACCOUNT,
      snapshotId,
      title: 'Double a budget',
      rationale: 'An increase far above the 20% limit.',
      actions: [
        {
          kind: 'google_ads.campaign.set_daily_budget',
          target: { level: 'campaign', id: 'c2' },
          params: { dailyBudget: 240 },
          rationale: 'Raise the daily budget from 120 to 240.',
        },
      ],
    });
    expect(created.isError, created.text).toBe(false);
    const preview = await mcp.call('plan_preview', { planId: created.structured?.['planId'] });
    const policy = preview.structured?.['policy'] as { allowed: boolean; denials: Array<{ ruleId: string }> };
    expect(policy.allowed).toBe(false);
    expect(policy.denials.map((denial) => denial.ruleId)).toContain('budget_change');
  });

  it('lets one plan add several different negative keywords to a campaign, but not the same one twice', async () => {
    const { mcp } = await setup({ autonomy: 'approve' });
    const snapshotId = await snapshot(mcp);
    const negative = (text: string) => ({
      kind: 'google_ads.negative_keyword.add',
      target: { level: 'campaign', id: 'c3' },
      params: { text, matchType: 'EXACT' },
      rationale: `The search term "${text}" spent without converting.`,
    });
    const created = await mcp.call('plan_create', {
      accountId: ACCOUNT,
      snapshotId,
      title: 'Negatives for one campaign',
      rationale: 'Three search terms that spent without converting.',
      actions: [negative('how to make a tent diy'), negative('tent rental near me'), negative('rei camping tents')],
    });
    expect(created.isError, created.text).toBe(false);
    const preview = await mcp.call('plan_preview', { planId: created.structured?.['planId'] });
    const policy = preview.structured?.['policy'] as { allowed: boolean; denials: Array<{ ruleId: string }> };
    expect(policy.denials.map((denial) => denial.ruleId)).not.toContain('conflicting_actions');
    expect(policy.allowed).toBe(true);

    const twice = await mcp.call('plan_create', {
      accountId: ACCOUNT,
      snapshotId,
      title: 'The same negative twice',
      rationale: 'A duplicate is a mistake in the plan.',
      actions: [negative('tent rental near me'), negative('tent rental near me')],
    });
    expect(twice.isError).toBe(true);
  });

  it('refuses every live change while the kill switch is on', async () => {
    const { runtime, home, mcp } = await setup({ autonomy: 'approve' });
    const planId = await pausePlan(mcp, await snapshot(mcp));
    const receiptId = await approveAsPerson(runtime, mcp, planId);
    writeFileSync(runtime.paths.killFile, '');

    const live = await mcp.call('plan_apply', { planId, dryRun: false, receiptId });
    expect(live.isError).toBe(true);
    expect(errorCode(live)).toBe('policy_denied');
    expect(demoState(home)).toBe('');
  });

  it('skips an action whose target changed after the plan was made', async () => {
    const { runtime, mcp } = await setup({ autonomy: 'approve', policy: { ...tempPolicy(), cooldownHours: 0 } });
    const snapshotId = await snapshot(mcp);
    const first = await pausePlan(mcp, snapshotId);
    // A plan id is derived from the plan's content and its creation time in milliseconds, so the
    // same change planned again in the same millisecond is the same plan. Let the clock move on.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await pausePlan(mcp, snapshotId);
    // The same change, planned twice: once the first is applied, the second rests on a stale state.
    expect(second).not.toBe(first);
    await mcp.call('plan_apply', { planId: first, dryRun: false, receiptId: await approveAsPerson(runtime, mcp, first) });

    const live = await mcp.call('plan_apply', {
      planId: second,
      dryRun: false,
      receiptId: await approveAsPerson(runtime, mcp, second),
    });
    expect(live.structured?.['applied'] ?? 0).toBe(0);
  });
});

describe('findings do not outrun their data', () => {
  it('never attaches an action to a finding without sufficient data', async () => {
    const { mcp } = await setup();
    const audit = await mcp.call('audit_run', { snapshotId: await snapshot(mcp), judgments: false, maxFindings: 50 });
    expect(audit.isError).toBe(false);
    const findings = audit.structured?.['findings'] as Array<{ dataStatus: string; suggestedActions: unknown[] }>;
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      if (finding.dataStatus !== 'sufficient') expect(finding.suggestedActions).toEqual([]);
    }
    expect(findings.some((finding) => finding.dataStatus === 'limited')).toBe(true);
  });

  it('names the configured accounts when asked for one that does not exist', async () => {
    const { mcp } = await setup();
    const result = await mcp.call('snapshot_create', { accountId: 'someone-elses-account' });
    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe('not_found');
    expect(result.text).toContain('demo-google');
  });
});

function tempPolicy(): AutopilotConfig['policy'] {
  return {
    maxActionsPerPlan: 25,
    maxBudgetChangePct: 0.2,
    maxAccountBudgetIncreasePct: 0.1,
    maxBidChangePct: 0.25,
    cooldownHours: 24,
    maxSnapshotAgeHours: 24,
    approvalTtlMinutes: 30,
    autoApply: [],
    denyKinds: [],
    killSwitch: false,
  };
}
