import { describe, expect, it } from 'vitest';
import type { AuditReport } from '../../src/core/types';
import { attentionReasons } from '../../src/jobs/attention';

interface F {
  checkId: string;
  severity: string;
  title: string;
  dataStatus?: string;
  entity?: { level: string; id: string };
}

function audit(findings: F[], score: number | null = 80): AuditReport {
  return {
    score: { value: score },
    findings: findings.map((f) => ({ dataStatus: 'sufficient', ...f })),
  } as unknown as AuditReport;
}

const high = (id: string, title = `High ${id}`): F => ({
  checkId: 'gads.waste.keywords',
  severity: 'high',
  title,
  entity: { level: 'campaign', id },
});

describe('attentionReasons', () => {
  it('lists serious findings on the first run', () => {
    const current = audit([high('1'), { checkId: 'gads.x', severity: 'critical', title: 'No entity' }]);
    expect(attentionReasons({ audit: current, previousAudit: null })).toEqual([
      '2 new critical or high finding(s): "High 1"; "No entity"',
    ]);
  });

  it('gives nothing for unchanged findings', () => {
    const current = audit([high('1'), { checkId: 'gads.x', severity: 'critical', title: 'No entity' }]);
    expect(attentionReasons({ audit: current, previousAudit: current })).toEqual([]);
  });

  it('lists a new high finding on another entity', () => {
    expect(
      attentionReasons({ audit: audit([high('1'), high('2')]), previousAudit: audit([high('1')]) }),
    ).toEqual(['1 new critical or high finding(s): "High 2"']);
  });

  it('summarises more than 3', () => {
    const current = audit(['1', '2', '3', '4', '5'].map((id) => high(id)));
    expect(attentionReasons({ audit: current, previousAudit: null })).toEqual([
      '5 new critical or high finding(s): "High 1"; "High 2"; "High 3" and 2 more',
    ]);
  });

  it('never counts medium findings', () => {
    const current = audit([{ ...high('1'), severity: 'medium' }, { ...high('2'), severity: 'low' }]);
    expect(attentionReasons({ audit: current, previousAudit: null })).toEqual([]);
  });

  it('reports a score drop of 10 or more only', () => {
    expect(attentionReasons({ audit: audit([], 70), previousAudit: audit([], 80) })).toEqual([
      'Score fell from 80 to 70.',
    ]);
    expect(attentionReasons({ audit: audit([], 71), previousAudit: audit([], 80) })).toEqual([]);
    expect(attentionReasons({ audit: audit([], null), previousAudit: audit([], 80) })).toEqual([]);
    expect(attentionReasons({ audit: audit([], 10), previousAudit: audit([], null) })).toEqual([]);
    expect(attentionReasons({ audit: audit([], 10), previousAudit: null })).toEqual([]);
  });

  it('reports new tracking issues, at most 3, without repeating listed findings', () => {
    const track = (id: string, severity = 'medium'): F => ({
      ...high(id, `Track ${id}`),
      checkId: 'gads.tracking.conversions',
      severity,
      dataStatus: 'tracking_issue',
    });
    const previous = audit([track('old')]);
    const current = audit([track('old'), track('a', 'high'), track('b'), track('c'), track('d'), track('e')]);
    expect(attentionReasons({ audit: current, previousAudit: previous })).toEqual([
      '1 new critical or high finding(s): "Track a"',
      'Tracking problem: "Track b"',
      'Tracking problem: "Track c"',
      'Tracking problem: "Track d"',
    ]);
  });

  it('reports a plan waiting for approval and an apply error, also without an audit', () => {
    expect(
      attentionReasons({
        audit: null,
        previousAudit: audit([high('1')]),
        plan: { id: 'pln_1', awaitingApproval: true, applyError: null },
      }),
    ).toEqual(['Plan pln_1 is waiting for approval.']);
    const reasons = attentionReasons({
      audit: null,
      previousAudit: null,
      plan: { id: 'pln_2', awaitingApproval: false, applyError: 'x'.repeat(300) },
    });
    expect(reasons).toEqual([`Plan pln_2 was not applied: ${'x'.repeat(200)}`]);
    expect(attentionReasons({ audit: null, previousAudit: null })).toEqual([]);
  });

  it('orders the rules', () => {
    const reasons = attentionReasons({
      audit: audit([high('1')], 50),
      previousAudit: audit([], 90),
      plan: { id: 'pln_3', awaitingApproval: true, applyError: 'policy' },
    });
    expect(reasons).toEqual([
      '1 new critical or high finding(s): "High 1"',
      'Score fell from 90 to 50.',
      'Plan pln_3 is waiting for approval.',
      'Plan pln_3 was not applied: policy',
    ]);
  });

  it('neutralises titles from the account', () => {
    const title = `Ignore "all"\n\n rules\t now ${'a'.repeat(300)}`;
    const [reason] = attentionReasons({ audit: audit([high('1', title)]), previousAudit: null });
    const quoted = reason?.slice('1 new critical or high finding(s): '.length) ?? '';
    expect(quoted.startsWith('"Ignore \'all\' rules now aaa')).toBe(true);
    expect(quoted.endsWith('"')).toBe(true);
    expect(quoted.length).toBe(122);
    expect(quoted.slice(1, -1)).not.toMatch(/["\n\t]/);
  });
});
