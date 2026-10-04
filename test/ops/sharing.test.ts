import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config';
import type { AutopilotConfig } from '../../src/core/types';
import { auditSnapshot, findingEvidence, judgeClaims, judgeCopy, judgeTerms } from '../../src/ops/audit';
import { queryData, takeSnapshot } from '../../src/ops/data';
import { tempRuntime } from '../helpers/runtime';

const now = () => new Date('2026-10-04T10:00:00Z');

function configWith(sharing: { judgments?: boolean; rows?: boolean }): AutopilotConfig {
  const config = defaultConfig();
  return {
    ...config,
    accounts: config.accounts.map((account) => (account.id === 'demo-google' ? { ...account, sharing } : account)),
  };
}

/** Counts requests; every reply is a server error, so a judge that asks falls back after asking. */
function countingFetch(): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  const impl = async (): Promise<Response> => {
    calls += 1;
    return new Response('{}', { status: 400 });
  };
  return { fetch: impl as typeof fetch, calls: () => calls };
}

describe('sharing.judgments: false', () => {
  it('sends nothing of that account to Jev from the audit, the judge tools or a claim check', async () => {
    const { fetch, calls } = countingFetch();
    const { runtime } = tempRuntime({ now, fetch, env: { TYPESAFE_API_KEY: 'k' }, config: configWith({ judgments: false }) });
    const snapshot = await takeSnapshot(runtime, { accountId: 'demo-google' });

    const audit = await auditSnapshot(runtime, { snapshotId: snapshot.id });
    expect(audit.judgment).toMatchObject({ mode: 'fallback', requests: 0 });
    const terms = await judgeTerms(runtime, { accountId: 'demo-google', snapshotId: snapshot.id });
    expect(terms.usage).toMatchObject({ mode: 'fallback', requests: 0 });
    const copy = await judgeCopy(runtime, { accountId: 'demo-google', variants: [{ id: 'a', body: 'Best tents, guaranteed.' }] });
    expect(copy.usage.requests).toBe(0);
    const claims = await judgeClaims(runtime, { claims: ['Cost went up.'], snapshotId: snapshot.id });
    expect(claims.usage.requests).toBe(0);
    await judgeClaims(runtime, { claims: ['The score is low.'], auditId: audit.id });

    expect(calls()).toBe(0);
  });

  it('still asks Jev for another account and for text that belongs to no account', async () => {
    const { fetch, calls } = countingFetch();
    const { runtime } = tempRuntime({ now, fetch, env: { TYPESAFE_API_KEY: 'k' }, config: configWith({ judgments: false }) });

    await judgeTerms(runtime, { accountId: 'demo-meta', terms: ['free tent repair'] });
    const afterOtherAccount = calls();
    expect(afterOtherAccount).toBeGreaterThan(0);

    await judgeClaims(runtime, { claims: ['Cost went up.'], evidence: 'Cost was 10 last week and 12 this week.' });
    expect(calls()).toBeGreaterThan(afterOtherAccount);
  });
});

describe('sharing.rows: false', () => {
  it('returns counts but no rows from data_query and evidence_get, and leaves the audit intact', async () => {
    const { runtime } = tempRuntime({ now, config: configWith({ rows: false }) });
    const snapshot = await takeSnapshot(runtime, { accountId: 'demo-google' });

    const page = queryData(runtime, { snapshotId: snapshot.id, dataset: 'campaigns', limit: 3 });
    expect(page.rows).toEqual([]);
    expect(page.total).toBeGreaterThan(0);
    expect(page.withheld).toBe(3);

    const audit = await auditSnapshot(runtime, { snapshotId: snapshot.id, judgments: false });
    expect(audit.findings.length).toBeGreaterThan(0);
    const finding = audit.findings.find((candidate) => candidate.evidence.length > 0);
    expect(finding).toBeDefined();
    const evidence = findingEvidence(runtime, { auditId: audit.id, findingId: finding!.id });
    expect(evidence.rows).toEqual([]);
    expect(evidence.withheld).toBe(finding!.evidence.length);
  });

  it('does not list the search terms of a snapshot, but still judges terms the caller supplies', async () => {
    const { runtime } = tempRuntime({ now, config: configWith({ rows: false }) });
    const snapshot = await takeSnapshot(runtime, { accountId: 'demo-google' });

    await expect(judgeTerms(runtime, { accountId: 'demo-google', snapshotId: snapshot.id })).rejects.toMatchObject({
      code: 'policy_denied',
    });
    const supplied = await judgeTerms(runtime, { accountId: 'demo-google', terms: ['free tent repair'] });
    expect(supplied.judgments).toHaveLength(1);
    expect(supplied.judgments[0]?.cost).toBeUndefined();
  });

  it('shares rows of an account without the setting', async () => {
    const { runtime } = tempRuntime({ now, config: configWith({ rows: false }) });
    const snapshot = await takeSnapshot(runtime, { accountId: 'demo-meta' });
    const page = queryData(runtime, { snapshotId: snapshot.id, dataset: 'campaigns', limit: 3 });
    expect(page.rows.length).toBeGreaterThan(0);
    expect(page.withheld).toBeUndefined();
  });
});
