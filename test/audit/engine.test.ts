import { describe, expect, it } from 'vitest';
import { allChecks, runAudit } from '../../src/audit/engine';
import { AutopilotError } from '../../src/core/errors';
import type {
  AccountConfig,
  ActionDraft,
  CheckDefinition,
  CheckOutcome,
  FindingDraft,
  Judge,
  Snapshot,
  Thresholds,
} from '../../src/core/types';

const NOW = new Date('2026-01-15T10:00:00.000Z');
const thresholds = {} as Thresholds;

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    id: 'snap_0000000000000001',
    schemaVersion: 1,
    platform: 'google_ads',
    accountId: 'acme-google',
    externalAccountId: '123',
    source: 'demo',
    currency: 'USD',
    timezone: 'UTC',
    dateRange: { start: '2026-01-01', end: '2026-01-14' },
    createdAt: '2026-01-15T00:00:00.000Z',
    datasets: { campaigns: [], search_terms: [] },
    coverage: { campaigns: { status: 'complete', rows: 0 }, search_terms: { status: 'complete', rows: 0 } },
    warnings: [],
    contentHash: 'h',
    ...overrides,
  };
}

const account: AccountConfig = { id: 'acme-google', platform: 'google_ads', externalId: '123' };

function check(overrides: Partial<CheckDefinition> & { id: string }, outcome?: CheckOutcome): CheckDefinition {
  return {
    platform: 'google_ads',
    category: 'waste',
    severity: 'medium',
    title: `Check ${overrides.id}`,
    requires: ['campaigns'],
    run: () => outcome ?? { status: 'pass', findings: [] },
    ...overrides,
  };
}

function pause(id: string): ActionDraft {
  return { kind: 'google_ads.campaign.pause', target: { level: 'campaign', id }, params: {}, rationale: 'r' };
}

function finding(overrides: Partial<FindingDraft> = {}): FindingDraft {
  return { title: 'Problem', observation: 'o', recommendation: 'r', evidence: [], ...overrides };
}

function fail(...findings: FindingDraft[]): CheckOutcome {
  return { status: 'fail', findings };
}

function run(checks: CheckDefinition[], extra: Partial<Parameters<typeof runAudit>[0]> = {}) {
  return runAudit({ snapshot: snapshot(), account, thresholds, judge: null, checks, now: NOW, ...extra });
}

describe('allChecks', () => {
  it('returns an array of check definitions', () => {
    expect(Array.isArray(allChecks())).toBe(true);
  });
});

describe('runAudit', () => {
  it('keeps only checks for the snapshot platform', async () => {
    const report = await run([check({ id: 'g.a' }), check({ id: 'm.a', platform: 'meta_ads' })]);
    expect(report.checks.map((c) => c.checkId)).toEqual(['g.a']);
    expect(report.platform).toBe('google_ads');
    expect(report.createdAt).toBe(NOW.toISOString());
    expect(report.id).toMatch(/^aud_[0-9a-f]{16}$/);
    expect(report.judgment).toEqual({
      mode: 'fallback',
      model: null,
      requests: 0,
      failed: 0,
      skipped: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it('filters by checkIds and rejects ids unknown for this platform', async () => {
    const checks = [check({ id: 'g.a' }), check({ id: 'g.b' }), check({ id: 'm.a', platform: 'meta_ads' })];
    const report = await run(checks, { checkIds: ['g.b'] });
    expect(report.checks.map((c) => c.checkId)).toEqual(['g.b']);

    const error = await run(checks, { checkIds: ['g.a', 'm.a', 'nope'] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AutopilotError);
    expect((error as AutopilotError).code).toBe('invalid_input');
    expect((error as AutopilotError).message).toContain('m.a');
    expect((error as AutopilotError).message).toContain('nope');
    expect((error as AutopilotError).message).not.toContain('g.a');
  });

  it('marks checks unknown when a dataset is absent or its coverage is missing', async () => {
    let ran = 0;
    const runFn = (): CheckOutcome => {
      ran += 1;
      return { status: 'pass', findings: [] };
    };
    const report = await run(
      [check({ id: 'g.absent', requires: ['keywords'], run: runFn }), check({ id: 'g.missing', requires: ['search_terms'], run: runFn })],
      {
        snapshot: snapshot({
          coverage: { campaigns: { status: 'complete', rows: 0 }, search_terms: { status: 'missing', rows: 0 } },
        }),
      },
    );
    expect(ran).toBe(0);
    expect(report.checks[0]).toMatchObject({ status: 'unknown', reason: 'dataset keywords is not in this snapshot' });
    expect(report.checks[1]).toMatchObject({ status: 'unknown', reason: 'dataset search_terms is not in this snapshot' });
  });

  it('marks checks unknown for each unmet need and runs them once met', async () => {
    const checks = [
      check({ id: 'g.cpa', needs: ['target_cpa'] }),
      check({ id: 'g.roas', needs: ['target_roas'] }),
      check({ id: 'g.brand', needs: ['brand_terms'] }),
      check({ id: 'g.judge', needs: ['judgment'] }),
    ];
    const report = await run(checks);
    expect(report.checks.map((c) => c.status)).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
    expect(report.checks[0]?.reason).toBe('set targets.cpa for this account');
    expect(report.checks[1]?.reason).toBe('set targets.roas for this account');
    expect(report.checks[2]?.reason).toBe('set brandTerms for this account');
    expect(report.checks[3]?.reason).toBeTruthy();

    const usage = { mode: 'jev' as const, model: 'm', requests: 2, failed: 0, skipped: 0, inputTokens: 5, outputTokens: 1, costUsd: 0.01 };
    const judge = { mode: 'jev', usage: () => usage } as unknown as Judge;
    const met = await run(checks, {
      account: { ...account, targets: { cpa: 10, roas: 3 }, brandTerms: ['acme'] },
      judge,
    });
    expect(met.checks.map((c) => c.status)).toEqual(['pass', 'pass', 'pass', 'pass']);
    expect(met.checks[0]).not.toHaveProperty('reason');
    expect(met.judgment).toEqual(usage);
  });

  it('turns a throwing check into unknown and still completes', async () => {
    const report = await run([
      check({
        id: 'g.boom',
        run: () => {
          throw new Error('kaput');
        },
      }),
      check({ id: 'g.async', run: () => Promise.reject(new Error('later')) }),
      check({ id: 'g.ok' }, fail(finding())),
    ]);
    expect(report.checks[0]).toMatchObject({ status: 'unknown', reason: 'check failed: kaput', findingIds: [] });
    expect(report.checks[1]).toMatchObject({ status: 'unknown', reason: 'check failed: later' });
    expect(report.checks[2]?.status).toBe('fail');
    expect(report.findings).toHaveLength(1);
  });

  it('builds findings with stable ids, defaults and attached finding ids', async () => {
    const checks = [
      check(
        { id: 'g.a', severity: 'high', category: 'budget' },
        fail(
          finding({ entity: { level: 'campaign', id: 'c1', name: 'One' }, suggestedActions: [pause('c1')] }),
          finding({ entity: { level: 'campaign', id: 'c2' }, severity: 'low' }),
          finding({ title: 'Account wide' }),
        ),
      ),
    ];
    const first = await run(checks);
    const second = await run(checks);
    expect(first.id).toBe(second.id);
    expect(first.findings.map((f) => f.id).sort()).toEqual(second.findings.map((f) => f.id).sort());
    expect(new Set(first.findings.map((f) => f.id)).size).toBe(3);
    for (const f of first.findings) expect(f.id).toMatch(/^fnd_[0-9a-f]{16}$/);
    expect(first.checks[0]?.findingIds.slice().sort()).toEqual(first.findings.map((f) => f.id).sort());

    const c1 = first.findings.find((f) => f.entity?.id === 'c1');
    expect(c1).toMatchObject({
      checkId: 'g.a',
      category: 'budget',
      platform: 'google_ads',
      accountId: 'acme-google',
      snapshotId: 'snap_0000000000000001',
      severity: 'high',
      dataStatus: 'sufficient',
      needsReview: false,
    });
    expect(c1?.suggestedActions).toHaveLength(1);
    expect(c1?.suggestedActions[0]?.findingIds).toEqual([c1?.id]);
    const c2 = first.findings.find((f) => f.entity?.id === 'c2');
    expect(c2?.severity).toBe('low');
    expect(c2?.suggestedActions).toEqual([]);

    const later = await run(checks, { now: new Date('2026-01-16T10:00:00.000Z') });
    expect(later.id).not.toBe(first.id);
  });

  it('does not demote on a tracking finding that is not critical', async () => {
    const report = await run([
      check({ id: 'g.conv', usesConversions: true }, fail(finding({ title: 'conv', suggestedActions: [pause('c1')] }))),
      check({ id: 'g.track', category: 'tracking' }, fail(finding({ title: 'track', severity: 'medium' }))),
    ]);
    const conv = report.findings.find((f) => f.title === 'conv');
    expect(conv).toMatchObject({ dataStatus: 'sufficient', needsReview: false });
    expect(conv?.suggestedActions).toHaveLength(1);
  });

  it('demotes conversion-based findings when a tracking check fails critically', async () => {
    const report = await run([
      check({ id: 'g.conv', usesConversions: true }, fail(finding({ title: 'conv', suggestedActions: [pause('c1')] }))),
      check({ id: 'g.plain' }, fail(finding({ title: 'plain', suggestedActions: [pause('c2')] }))),
      check({ id: 'g.track', category: 'tracking' }, fail(finding({ title: 'track', severity: 'critical' }))),
    ]);
    const conv = report.findings.find((f) => f.title === 'conv');
    const plain = report.findings.find((f) => f.title === 'plain');
    expect(conv).toMatchObject({ dataStatus: 'tracking_issue', needsReview: true, suggestedActions: [] });
    expect(plain?.dataStatus).toBe('sufficient');
    expect(plain?.suggestedActions).toHaveLength(1);
    expect(report.findings.find((f) => f.title === 'track')?.dataStatus).toBe('sufficient');
  });

  it('does not demote when the tracking check passes', async () => {
    const report = await run([
      check({ id: 'g.conv', usesConversions: true }, fail(finding({ suggestedActions: [pause('c1')] }))),
      check({ id: 'g.track', category: 'tracking' }),
    ]);
    expect(report.findings[0]).toMatchObject({ dataStatus: 'sufficient', needsReview: false });
    expect(report.findings[0]?.suggestedActions).toHaveLength(1);
  });

  it('counts overlapping waste once per campaign: the largest check wins', async () => {
    const waste = (monthly: number) => ({ kind: 'wasted_spend' as const, monthly, basis: 'test' });
    const report = await run([
      check(
        { id: 'g.keywords' },
        fail(
          finding({ title: 'k1', entity: { level: 'keyword', id: 'k1', campaignId: 'c1' }, impact: waste(300) }),
          finding({ title: 'k2', entity: { level: 'keyword', id: 'k2', campaignId: 'c1' }, impact: waste(200) }),
        ),
      ),
      check(
        { id: 'g.terms' },
        fail(
          finding({ title: 't1', entity: { level: 'search_term', id: 't1', campaignId: 'c1' }, impact: waste(400) }),
          finding({ title: 't2', entity: { level: 'search_term', id: 't2', campaignId: 'c2' }, impact: waste(50) }),
        ),
      ),
      check({ id: 'g.campaign' }, fail(finding({ title: 'c', entity: { level: 'campaign', id: 'c2' }, impact: waste(70) }))),
    ]);
    // c1: max(300 + 200, 400) = 500; c2: max(50, 70) = 70.
    expect(report.totals.wastedSpendMonthly).toBe(570);
  });

  it('empties suggested actions of non-sufficient findings', async () => {
    const report = await run([
      check({ id: 'g.a' }, fail(finding({ dataStatus: 'limited', suggestedActions: [pause('c1')] }))),
    ]);
    expect(report.findings[0]).toMatchObject({ dataStatus: 'limited', suggestedActions: [] });
  });

  it('sorts by monthly impact, then severity, and computes totals', async () => {
    const report = await run([
      check(
        { id: 'g.a' },
        fail(
          finding({ title: 'none-low', severity: 'low' }),
          finding({ title: 'small', impact: { kind: 'wasted_spend', monthly: 10.005, basis: 'b' } }),
          finding({ title: 'tie-medium', severity: 'medium', impact: { kind: 'missed_conversions', monthly: 50, basis: 'b' } }),
          finding({ title: 'big', impact: { kind: 'wasted_spend', monthly: 100.111, basis: 'b' }, needsReview: true }),
          finding({ title: 'tie-critical', severity: 'critical', impact: { kind: 'wasted_spend', monthly: 50, basis: 'b' }, dataStatus: 'limited' }),
          finding({ title: 'none-high', severity: 'high' }),
        ),
      ),
    ]);
    expect(report.findings.map((f) => f.title)).toEqual(['big', 'tie-critical', 'tie-medium', 'small', 'none-high', 'none-low']);
    expect(report.totals).toEqual({ wastedSpendMonthly: 110.12, findings: 6, needsReview: 1 });
  });

  it('sets needsReview on findings from a partially covered dataset', async () => {
    const report = await run(
      [
        check({ id: 'g.partial', requires: ['search_terms'] }, fail(finding({ title: 'partial' }))),
        check({ id: 'g.full', requires: ['campaigns'] }, fail(finding({ title: 'full' }))),
      ],
      {
        snapshot: snapshot({
          coverage: { campaigns: { status: 'complete', rows: 0 }, search_terms: { status: 'partial', rows: 0 } },
        }),
      },
    );
    expect(report.findings.find((f) => f.title === 'partial')?.needsReview).toBe(true);
    expect(report.findings.find((f) => f.title === 'full')?.needsReview).toBe(false);
    expect(report.totals.needsReview).toBe(1);
  });
});
