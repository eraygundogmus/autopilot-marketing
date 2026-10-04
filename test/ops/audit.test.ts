import { describe, expect, it, vi } from 'vitest';
import { AutopilotError } from '../../src/core/errors';
import type { Runtime, Snapshot } from '../../src/core/types';
import { auditSnapshot, findingEvidence, judgeClaims, judgeCopy, judgeTerms } from '../../src/ops/audit';
import { snapshotTotals, takeSnapshot } from '../../src/ops/data';
import { tempRuntime } from '../helpers/runtime';

const NOW = () => new Date('2026-03-15T12:00:00Z');

async function setup(): Promise<{ runtime: Runtime; snapshot: Snapshot }> {
  const { runtime } = tempRuntime({ now: NOW });
  const snapshot = await takeSnapshot(runtime, { accountId: 'demo-google' });
  return { runtime, snapshot };
}

async function codeOf(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AutopilotError) return error.code;
    throw error;
  }
  return 'no error';
}

describe('auditSnapshot', () => {
  it('audits the demo Google account, stores the report and logs it', async () => {
    const { runtime, snapshot } = await setup();
    const report = await auditSnapshot(runtime, { snapshotId: snapshot.id });

    expect(report.snapshotId).toBe(snapshot.id);
    expect(report.accountId).toBe('demo-google');
    expect(report.findings.length).toBeGreaterThan(0);
    expect(runtime.store.getAudit(report.id).id).toBe(report.id);

    const entries = runtime.ledger.read({ events: ['audit.run'] });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actor).toEqual({ kind: 'system', id: 'autopilot' });
    expect(entries[0]?.accountId).toBe('demo-google');
    expect(entries[0]?.data).toMatchObject({
      auditId: report.id,
      snapshotId: snapshot.id,
      findings: report.findings.length,
      judgmentMode: report.judgment.mode,
    });
    expect(runtime.ledger.verify().ok).toBe(true);
  });

  it('makes no judgment requests when judgments are off', async () => {
    const { runtime, snapshot } = await setup();
    const classify = vi.spyOn(runtime.judge, 'classifyTerms');
    const verify = vi.spyOn(runtime.judge, 'verifyClaims');
    const review = vi.spyOn(runtime.judge, 'reviewCopy');

    const report = await auditSnapshot(runtime, { snapshotId: snapshot.id, judgments: false });

    expect(classify).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(report.judgment.requests).toBe(0);
  });

  it('restricts the run to the given checks and rejects unknown ids', async () => {
    const { runtime, snapshot } = await setup();
    const full = await auditSnapshot(runtime, { snapshotId: snapshot.id, judgments: false });
    const checkId = full.checks[0]?.checkId ?? full.findings[0]?.checkId ?? '';
    const one = await auditSnapshot(runtime, { snapshotId: snapshot.id, judgments: false, checkIds: [checkId] });
    expect(one.checks).toHaveLength(1);

    expect(await codeOf(() => auditSnapshot(runtime, { snapshotId: snapshot.id, checkIds: ['nope'] }))).toBe(
      'invalid_input',
    );
    expect(await codeOf(() => auditSnapshot(runtime, { snapshotId: 'snap_0000000000000000' }))).toBe('not_found');
  });
});

describe('findingEvidence', () => {
  it('returns the full rows behind a finding', async () => {
    const { runtime, snapshot } = await setup();
    const report = await auditSnapshot(runtime, { snapshotId: snapshot.id, judgments: false });
    const finding = report.findings.find((candidate) => candidate.evidence.length > 0);
    expect(finding).toBeDefined();
    if (!finding) return;

    const result = findingEvidence(runtime, { auditId: report.id, findingId: finding.id });
    expect(result.finding.id).toBe(finding.id);
    expect(result.rows).toHaveLength(finding.evidence.length);
    result.rows.forEach((entry, index) => {
      const ref = finding.evidence[index];
      expect(entry.dataset).toBe(ref?.dataset);
      expect(entry.row.id).toBe(ref?.rowId);
      expect(entry.row.metrics).toBeDefined();
    });
  });

  it('throws not_found for a finding the audit does not hold', async () => {
    const { runtime, snapshot } = await setup();
    const report = await auditSnapshot(runtime, { snapshotId: snapshot.id, judgments: false });
    expect(await codeOf(() => findingEvidence(runtime, { auditId: report.id, findingId: 'fnd_missing' }))).toBe(
      'not_found',
    );
  });
});

describe('judgeTerms', () => {
  it('judges non-converting snapshot terms, costliest first, with their costs', async () => {
    const { runtime, snapshot } = await setup();
    const result = await judgeTerms(runtime, { accountId: 'demo-google', snapshotId: snapshot.id, limit: 5 });

    expect(result.judgments.length).toBeGreaterThan(0);
    expect(result.judgments.length).toBeLessThanOrEqual(5);
    const costs = result.judgments.map((judgment) => judgment.cost ?? -1);
    expect(costs).toEqual([...costs].sort((a, b) => b - a));
    for (const judgment of result.judgments) {
      expect(judgment.conversions).toBe(0);
      expect(typeof judgment.clicks).toBe('number');
      expect(judgment.mode).toBe('fallback');
    }
    // Fallback rules only reach the act band for brand terms, which never become negatives.
    expect(result.negatives).toEqual([]);
    expect(result.usage.mode).toBe('fallback');
  });

  it('honours minCost', async () => {
    const { runtime, snapshot } = await setup();
    const all = await judgeTerms(runtime, { accountId: 'demo-google', snapshotId: snapshot.id });
    const top = all.judgments[0]?.cost ?? 0;
    const filtered = await judgeTerms(runtime, { accountId: 'demo-google', snapshotId: snapshot.id, minCost: top });
    expect(filtered.judgments.length).toBeGreaterThan(0);
    expect(filtered.judgments.every((judgment) => (judgment.cost ?? 0) >= top)).toBe(true);
  });

  it('judges explicit terms: trimmed, de-duplicated, limited, without costs', async () => {
    const { runtime } = await setup();
    const result = await judgeTerms(runtime, {
      accountId: 'demo-google',
      terms: [' free shoes ', 'free shoes', '', 'running shoes', 'third term'],
      limit: 2,
    });
    expect(result.judgments.map((judgment) => judgment.term)).toEqual(['free shoes', 'running shoes']);
    expect(result.judgments[0]).not.toHaveProperty('cost');
    expect(result.negatives).toEqual([]);
  });

  it('drafts an exact negative for an act-band irrelevant term with a known campaign', async () => {
    const { runtime, snapshot } = await setup();
    vi.spyOn(runtime.judge, 'classifyTerms').mockImplementation(async ({ terms }) =>
      terms.map((term, index) => ({
        term,
        label: index === 0 ? 'irrelevant' : index === 1 ? 'brand' : 'competitor',
        confidence: 0.99,
        band: index === 2 ? 'review' : 'act',
        mode: 'jev',
      })),
    );
    const result = await judgeTerms(runtime, { accountId: 'demo-google', snapshotId: snapshot.id, limit: 3 });
    const first = result.judgments[0];
    expect(result.negatives).toHaveLength(1);
    expect(result.negatives[0]).toMatchObject({
      kind: 'google_ads.negative_keyword.add',
      target: { level: 'campaign', id: first?.campaignId },
      params: { text: first?.term, matchType: 'EXACT' },
    });
    expect(result.negatives[0]?.rationale).toContain(`Search term "${first?.term}" spent `);
    expect(result.negatives[0]?.rationale).toContain('with no conversions and was judged irrelevant.');
  });

  it('needs terms or a snapshot, and a known account', async () => {
    const { runtime } = await setup();
    expect(await codeOf(() => judgeTerms(runtime, { accountId: 'demo-google' }))).toBe('invalid_input');
    expect(await codeOf(() => judgeTerms(runtime, { accountId: 'nobody', terms: ['x'] }))).toBe('not_found');
  });
});

describe('judgeCopy', () => {
  it('reviews valid variants', async () => {
    const { runtime } = await setup();
    const result = await judgeCopy(runtime, {
      accountId: 'demo-google',
      variants: [{ id: 'a', headline: 'Trail shoes', body: 'Lightweight trail running shoes with free returns.' }],
    });
    expect(result.judgments).toHaveLength(1);
    expect(result.judgments[0]?.id).toBe('a');
    expect(result.usage.mode).toBe('fallback');
  });

  it('rejects empty, oversized and malformed variant lists', async () => {
    const { runtime } = await setup();
    const many = Array.from({ length: 21 }, (_, index) => ({ id: `v${index}`, body: 'text' }));
    expect(await codeOf(() => judgeCopy(runtime, { accountId: 'demo-google', variants: [] }))).toBe('invalid_input');
    expect(await codeOf(() => judgeCopy(runtime, { accountId: 'demo-google', variants: many }))).toBe('invalid_input');
    expect(await codeOf(() => judgeCopy(runtime, { accountId: 'demo-google', variants: [{ id: '', body: 'x' }] }))).toBe(
      'invalid_input',
    );
    expect(await codeOf(() => judgeCopy(runtime, { accountId: 'demo-google', variants: [{ id: 'a', body: ' ' }] }))).toBe(
      'invalid_input',
    );
  });
});

describe('judgeClaims', () => {
  it('verifies a number from the snapshot and marks an invented one unsupported', async () => {
    const { runtime, snapshot } = await setup();
    const clicks = snapshotTotals(snapshot)?.clicks ?? 0;
    expect(clicks).toBeGreaterThan(0);

    const result = await judgeClaims(runtime, {
      claims: [`The account received ${clicks} clicks.`, 'The account received 987654321 clicks.'],
      snapshotId: snapshot.id,
    });
    expect(result.judgments.map((judgment) => judgment.verdict)).toEqual(['verified', 'unsupported']);
    expect(result.usage.mode).toBe('fallback');
  });

  it('builds evidence from an audit, a snapshot and caller text', async () => {
    const { runtime, snapshot } = await setup();
    const report = await auditSnapshot(runtime, { snapshotId: snapshot.id, judgments: false });
    const verify = vi.spyOn(runtime.judge, 'verifyClaims');

    await judgeClaims(runtime, { claims: ['x 1'], auditId: report.id, snapshotId: snapshot.id, evidence: 'note 42' });

    const evidence = verify.mock.calls[0]?.[0].evidence as {
      audit: { findings: unknown[]; totals: unknown };
      snapshot: { currency: string; campaigns: Array<Record<string, unknown>> };
      text: string;
    };
    expect(evidence.audit.findings).toHaveLength(report.findings.length);
    expect(evidence.audit.totals).toEqual(report.totals);
    expect(evidence.snapshot.currency).toBe(snapshot.currency);
    expect(evidence.snapshot.campaigns.length).toBeGreaterThan(0);
    expect(evidence.snapshot.campaigns.length).toBeLessThanOrEqual(50);
    expect(evidence.snapshot.campaigns[0]).toHaveProperty('cpa');
    expect(evidence.text).toBe('note 42');
  });

  it('rejects bad claims and missing evidence', async () => {
    const { runtime } = await setup();
    const many = Array.from({ length: 31 }, (_, index) => `claim ${index}`);
    expect(await codeOf(() => judgeClaims(runtime, { claims: [], evidence: 'x' }))).toBe('invalid_input');
    expect(await codeOf(() => judgeClaims(runtime, { claims: many, evidence: 'x' }))).toBe('invalid_input');
    expect(await codeOf(() => judgeClaims(runtime, { claims: [' '], evidence: 'x' }))).toBe('invalid_input');
    expect(await codeOf(() => judgeClaims(runtime, { claims: ['a claim'] }))).toBe('invalid_input');
  });
});
