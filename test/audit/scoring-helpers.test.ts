import { describe, expect, it } from 'vitest';
import { activeRows, draft, entity, evidence, referenceCpa, rows } from '../../src/audit/helpers';
import { SEVERITY_WEIGHT, scoreAudit } from '../../src/audit/scoring';
import type { CheckCategory, CheckContext, CheckResult, CheckStatus, Row, Severity, Snapshot, Thresholds } from '../../src/core/types';

let seq = 0;
function check(severity: Severity, status: CheckStatus, category: CheckCategory = 'waste'): CheckResult {
  seq += 1;
  return { checkId: `t.${category}.c${seq}`, category, severity, title: 'check', status, findingIds: [] };
}

function snapshot(datasets: Snapshot['datasets']): Snapshot {
  return {
    id: 'snap_0123456789abcdef',
    schemaVersion: 1,
    platform: 'google_ads',
    accountId: 'acme-google',
    externalAccountId: '1234567890',
    source: 'demo',
    currency: 'USD',
    timezone: 'UTC',
    dateRange: { start: '2026-01-01', end: '2026-01-30' },
    createdAt: '2026-01-31T00:00:00.000Z',
    datasets,
    coverage: {},
    warnings: [],
    contentHash: 'x',
  };
}

function context(snap: Snapshot, cpa?: number): CheckContext {
  return {
    snapshot: snap,
    account: {
      id: 'acme-google',
      platform: 'google_ads',
      externalId: '1234567890',
      ...(cpa === undefined ? {} : { targets: { cpa } }),
    },
    thresholds: {} as Thresholds,
    judge: null,
  };
}

describe('scoreAudit', () => {
  it('keeps the severity weights', () => {
    expect(SEVERITY_WEIGHT).toEqual({ critical: 5, high: 3, medium: 1, low: 0.5, info: 0 });
  });

  it('scores an all-pass audit 100, A, complete', () => {
    const score = scoreAudit([check('critical', 'pass'), check('high', 'pass'), check('low', 'pass')]);
    expect(score).toMatchObject({ value: 100, grade: 'A', coverage: 1, status: 'complete' });
  });

  it('weights mixed severities', () => {
    // fail 3 of evaluated 9.5 -> 68.4
    const score = scoreAudit([
      check('critical', 'pass'),
      check('high', 'fail'),
      check('medium', 'pass'),
      check('low', 'pass'),
    ]);
    expect(score.value).toBe(68);
    expect(score.grade).toBe('C');
    expect(score.status).toBe('complete');
  });

  it('assigns each grade at its boundary', () => {
    const grade = (pass: number, fail: number) =>
      scoreAudit([
        ...Array.from({ length: pass }, () => check('medium', 'pass')),
        ...Array.from({ length: fail }, () => check('medium', 'fail')),
      ]).grade;
    expect(grade(9, 1)).toBe('A');
    expect(grade(3, 1)).toBe('B');
    expect(grade(3, 2)).toBe('C');
    expect(grade(2, 3)).toBe('D');
    expect(grade(1, 3)).toBe('F');
    expect(scoreAudit([check('critical', 'fail')])).toMatchObject({ value: 0, grade: 'F' });
  });

  it('treats coverage of exactly 0.8 as complete', () => {
    const score = scoreAudit([
      ...Array.from({ length: 4 }, () => check('medium', 'pass')),
      check('medium', 'unknown'),
    ]);
    expect(score.coverage).toBe(0.8);
    expect(score.status).toBe('complete');
  });

  it('drops to provisional when unknown checks lower coverage below 0.8', () => {
    // evaluated 6 of 9
    const score = scoreAudit([check('critical', 'pass'), check('medium', 'fail'), check('high', 'unknown')]);
    expect(score.coverage).toBeCloseTo(6 / 9);
    expect(score.status).toBe('provisional');
    expect(score.value).toBe(83);
    expect(score.grade).toBe('B');
  });

  it('reports insufficient evidence with null value and grade below 0.6', () => {
    const score = scoreAudit([check('high', 'pass'), check('critical', 'unknown')]);
    expect(score.coverage).toBeCloseTo(3 / 8);
    expect(score).toMatchObject({ status: 'insufficient_evidence', value: null, grade: null });
  });

  it('is insufficient when every weighted check is unknown', () => {
    const score = scoreAudit([check('high', 'unknown'), check('info', 'pass')]);
    expect(score).toMatchObject({ coverage: 0, status: 'insufficient_evidence', value: null, grade: null });
  });

  it('ignores not_applicable checks', () => {
    const score = scoreAudit([
      check('medium', 'pass'),
      check('critical', 'not_applicable'),
      check('critical', 'not_applicable', 'seo'),
    ]);
    expect(score).toMatchObject({ value: 100, grade: 'A', coverage: 1, status: 'complete' });
    expect(score.byCategory).toEqual({ waste: { value: 100, evaluated: 1, total: 1 } });
  });

  it('gives an info-only audit no value', () => {
    const score = scoreAudit([check('info', 'pass'), check('info', 'fail'), check('info', 'unknown')]);
    expect(score).toMatchObject({ value: null, grade: null, coverage: 1, status: 'complete' });
    expect(score.byCategory).toEqual({ waste: { value: null, evaluated: 2, total: 3 } });
  });

  it('handles an empty audit', () => {
    expect(scoreAudit([])).toEqual({ value: null, grade: null, coverage: 1, status: 'complete', byCategory: {} });
  });

  it('breaks the score down by category', () => {
    const score = scoreAudit([
      check('critical', 'pass', 'waste'),
      check('high', 'fail', 'waste'),
      check('info', 'fail', 'waste'),
      check('medium', 'unknown', 'waste'),
      check('medium', 'pass', 'tracking'),
      check('high', 'unknown', 'budget'),
      check('high', 'not_applicable', 'seo'),
    ]);
    expect(score.byCategory).toEqual({
      waste: { value: 63, evaluated: 3, total: 4 },
      tracking: { value: 100, evaluated: 1, total: 1 },
      budget: { value: null, evaluated: 0, total: 1 },
    });
  });
});

describe('helpers', () => {
  const enabled: Row = { id: 'c1', name: 'Brand', metrics: { cost: 100, conversions: 4 }, attrs: { status: 'ENABLED' } };
  const paused: Row = { id: 'c2', metrics: { cost: 50, conversions: 1 }, attrs: { status: 'PAUSED' } };
  const noStatus: Row = { id: 'c3', metrics: {}, attrs: {} };
  const snap = snapshot({ campaigns: [enabled, paused, noStatus] });

  it('rows returns the dataset or an empty array', () => {
    expect(rows(snap, 'campaigns')).toHaveLength(3);
    expect(rows(snap, 'keywords')).toEqual([]);
  });

  it('activeRows keeps ENABLED rows and rows without a status', () => {
    expect(activeRows(snap, 'campaigns').map((row) => row.id)).toEqual(['c1', 'c3']);
    expect(activeRows(snap, 'ads')).toEqual([]);
  });

  it('evidence prefers metrics, falls back to numeric attrs and skips missing keys', () => {
    const row: Row = {
      id: 'k1',
      name: 'shoes',
      metrics: { cost: 12.5, clicks: 0, bid: 9 },
      attrs: { bid: 1.2, qualityScore: 4, matchType: 'EXACT', lostIsBudget: Number.NaN, primary: true, reach: null },
    };
    expect(evidence(snap, 'keywords', row, ['cost', 'clicks', 'bid', 'qualityScore', 'matchType', 'lostIsBudget', 'primary', 'reach', 'missing'])).toEqual({
      snapshotId: 'snap_0123456789abcdef',
      dataset: 'keywords',
      rowId: 'k1',
      label: 'shoes',
      metrics: { cost: 12.5, clicks: 0, bid: 9, qualityScore: 4 },
    });
  });

  it('evidence omits the label when the row has no name', () => {
    const ref = evidence(snap, 'campaigns', paused, ['cost']);
    expect(ref).toEqual({ snapshotId: snap.id, dataset: 'campaigns', rowId: 'c2', metrics: { cost: 50 } });
    expect('label' in ref).toBe(false);
  });

  it('entity omits absent keys', () => {
    const bare = entity('campaign', paused);
    expect(bare).toEqual({ level: 'campaign', id: 'c2' });
    expect(Object.keys(bare)).toEqual(['level', 'id']);
    const full: Row = { id: 'k1', name: 'shoes', campaignId: 'c1', adGroupId: 'g1', metrics: {}, attrs: {} };
    expect(entity('keyword', full)).toEqual({ level: 'keyword', id: 'k1', name: 'shoes', campaignId: 'c1', adGroupId: 'g1' });
  });

  it('draft builds an ActionDraft', () => {
    const target = entity('campaign', enabled);
    const action = draft('google_ads.campaign.set_daily_budget', target, { dailyBudget: 20 }, 'limited by budget');
    expect(action).toEqual({
      kind: 'google_ads.campaign.set_daily_budget',
      target: { level: 'campaign', id: 'c1', name: 'Brand' },
      params: { dailyBudget: 20 },
      rationale: 'limited by budget',
    });
    expect('findingIds' in action).toBe(false);
  });

  it('referenceCpa prefers the account target', () => {
    expect(referenceCpa(context(snap, 12))).toBe(12);
  });

  it('referenceCpa falls back to account-wide cost per conversion', () => {
    expect(referenceCpa(context(snap))).toBe(30);
  });

  it('referenceCpa is null without conversions or campaigns', () => {
    const noConversions = snapshot({ campaigns: [{ id: 'c1', metrics: { cost: 80, conversions: 0 }, attrs: {} }] });
    expect(referenceCpa(context(noConversions))).toBeNull();
    expect(referenceCpa(context(snapshot({})))).toBeNull();
  });
});
