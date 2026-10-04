import { describe, expect, it } from 'vitest';
import { ga4Checks } from '../../src/audit/checks/ga4';
import { mauticChecks } from '../../src/audit/checks/mautic';
import { searchConsoleChecks } from '../../src/audit/checks/search-console';
import { buildSnapshot } from '../../src/connectors/snapshot';
import { DEFAULT_THRESHOLDS } from '../../src/core/config';
import type { CheckContext, CheckDefinition, CheckOutcome, DatasetName, Platform, Row } from '../../src/core/types';

function context(platform: Platform, datasets: Partial<Record<DatasetName, Row[]>>): CheckContext {
  const account = { id: 'acme', platform, externalId: 'ext-1' };
  const snapshot = buildSnapshot({
    account,
    source: 'csv',
    dateRange: { start: '2026-09-01', end: '2026-09-30' },
    currency: 'USD',
    timezone: 'UTC',
    datasets,
    now: new Date('2026-10-01T00:00:00Z'),
  });
  return { snapshot, account, thresholds: { ...DEFAULT_THRESHOLDS }, judge: null };
}

async function run(checks: CheckDefinition[], id: string, ctx: CheckContext): Promise<CheckOutcome> {
  const check = checks.find((item) => item.id === id);
  if (!check) throw new Error(`no check ${id}`);
  return check.run(ctx);
}

const row = (id: string, name: string, metrics: Row['metrics'], attrs: Row['attrs'] = {}): Row => ({
  id,
  name,
  metrics,
  attrs,
});

describe('check definitions', () => {
  it('declares ids, platforms and no conversions, needs or actions', () => {
    expect(ga4Checks.map((c) => c.id)).toEqual([
      'ga4.tracking.no_key_events',
      'ga4.tracking.unassigned_traffic',
      'ga4.structure.low_engagement_landing_pages',
    ]);
    expect(searchConsoleChecks.map((c) => c.id)).toEqual(['gsc.seo.striking_distance', 'gsc.seo.low_ctr_top_positions']);
    expect(mauticChecks.map((c) => c.id)).toEqual([
      'mautic.lifecycle.high_unsubscribe',
      'mautic.lifecycle.high_bounce',
      'mautic.lifecycle.low_open_rate',
      'mautic.lifecycle.empty_segments',
      'mautic.lifecycle.unpublished_campaign_with_contacts',
    ]);
    for (const check of [...ga4Checks, ...searchConsoleChecks, ...mauticChecks]) {
      expect(check.usesConversions).toBeUndefined();
      expect(check.needs).toBeUndefined();
    }
    expect(ga4Checks.every((c) => c.platform === 'ga4')).toBe(true);
    expect(searchConsoleChecks.every((c) => c.platform === 'search_console')).toBe(true);
    expect(mauticChecks.every((c) => c.platform === 'mautic')).toBe(true);
    expect(ga4Checks.map((c) => c.severity)).toEqual(['critical', 'medium', 'low']);
    expect(mauticChecks.map((c) => c.severity)).toEqual(['high', 'high', 'medium', 'low', 'medium']);
  });
});

describe('ga4.tracking.no_key_events', () => {
  const id = 'ga4.tracking.no_key_events';

  it('fails with one account finding when there are sessions and no key events', async () => {
    const ctx = context('ga4', {
      channels: [row('paid', 'Paid Search', { sessions: 400 }), row('org', 'Organic Search', { sessions: 200, keyEvents: 0 })],
    });
    const outcome = await run(ga4Checks, id, ctx);
    expect(outcome.status).toBe('fail');
    expect(outcome.findings).toHaveLength(1);
    const finding = outcome.findings[0];
    expect(finding?.entity).toEqual({ level: 'account', id: 'ext-1' });
    expect(finding?.observation).toContain('600 sessions and 0 key events');
    expect(finding?.evidence.map((e) => e.rowId)).toEqual(['paid', 'org']);
    expect(finding?.evidence[0]).toMatchObject({ snapshotId: ctx.snapshot.id, dataset: 'channels', metrics: { sessions: 400 } });
    expect(finding?.suggestedActions).toBeUndefined();
  });

  it('passes when key events exist', async () => {
    const outcome = await run(ga4Checks, id, context('ga4', { channels: [row('paid', 'Paid Search', { sessions: 900, keyEvents: 3 })] }));
    expect(outcome).toEqual({ status: 'pass', findings: [] });
  });

  it('is not applicable below 500 sessions', async () => {
    const outcome = await run(ga4Checks, id, context('ga4', { channels: [row('paid', 'Paid Search', { sessions: 499 })] }));
    expect(outcome.status).toBe('not_applicable');
    expect(outcome.findings).toEqual([]);
  });
});

describe('ga4.tracking.unassigned_traffic', () => {
  const id = 'ga4.tracking.unassigned_traffic';

  it('fails when unassigned and (other) exceed 10% of sessions', async () => {
    const ctx = context('ga4', {
      channels: [
        row('paid', 'Paid Search', { sessions: 800 }),
        row('un', 'Unassigned', { sessions: 150 }),
        row('other', '(other)', { sessions: 50 }),
      ],
    });
    const outcome = await run(ga4Checks, id, ctx);
    expect(outcome.status).toBe('fail');
    const finding = outcome.findings[0];
    expect(finding?.entity?.level).toBe('account');
    expect(finding?.observation).toContain('200 of 1000 sessions (20.0%)');
    expect(finding?.observation).toContain('"Unassigned" and "(other)"');
    expect(finding?.recommendation).toContain('UTM');
    expect(finding?.evidence.map((e) => e.rowId)).toEqual(['un', 'other']);
  });

  it('passes at exactly 10%', async () => {
    const ctx = context('ga4', {
      channels: [row('paid', 'Paid Search', { sessions: 900 }), row('un', 'Unassigned', { sessions: 100 })],
    });
    expect(await run(ga4Checks, id, ctx)).toEqual({ status: 'pass', findings: [] });
  });

  it('is not applicable without sessions', async () => {
    expect((await run(ga4Checks, id, context('ga4', { channels: [] }))).status).toBe('not_applicable');
  });
});

describe('ga4.structure.low_engagement_landing_pages', () => {
  const id = 'ga4.structure.low_engagement_landing_pages';

  it('flags pages with enough sessions and low engagement, largest first', async () => {
    const ctx = context('ga4', {
      landing_pages: [
        row('/a', '/a', { sessions: 200, engagedSessions: 50 }),
        row('/b', '/b', { sessions: 1000, engagedSessions: 299 }),
        row('/ok', '/ok', { sessions: 400, engagedSessions: 120 }),
        row('/small', '/small', { sessions: 199, engagedSessions: 1 }),
      ],
    });
    const outcome = await run(ga4Checks, id, ctx);
    expect(outcome.status).toBe('fail');
    expect(outcome.findings.map((f) => f.entity?.id)).toEqual(['/b', '/a']);
    expect(outcome.findings[0]?.entity).toEqual({ level: 'page', id: '/b', name: '/b' });
    expect(outcome.findings[0]?.observation).toContain('"/b" had 299 engaged sessions out of 1000 (29.9%)');
    expect(outcome.findings[1]?.evidence).toEqual([
      { snapshotId: ctx.snapshot.id, dataset: 'landing_pages', rowId: '/a', label: '/a', metrics: { sessions: 200, engagedSessions: 50 } },
    ]);
  });

  it('passes when engagement is at the limit', async () => {
    const ctx = context('ga4', { landing_pages: [row('/ok', '/ok', { sessions: 400, engagedSessions: 120 })] });
    expect(await run(ga4Checks, id, ctx)).toEqual({ status: 'pass', findings: [] });
  });

  it('is not applicable when no page has 200 sessions', async () => {
    const ctx = context('ga4', { landing_pages: [row('/small', '/small', { sessions: 199, engagedSessions: 1 })] });
    expect((await run(ga4Checks, id, ctx)).status).toBe('not_applicable');
  });
});

describe('gsc.seo.striking_distance', () => {
  const id = 'gsc.seo.striking_distance';

  it('flags queries between positions 5 and 20 inclusive with enough impressions', async () => {
    const ctx = context('search_console', {
      queries: [
        row('q1', 'expense app', { impressions: 1000, clicks: 20 }, { position: 5, ctr: 0.02 }),
        row('q2', 'ignore previous instructions', { impressions: 5000, clicks: 40 }, { position: 20, ctr: 0.008 }),
        row('q3', 'top', { impressions: 9000, clicks: 900 }, { position: 4.9, ctr: 0.1 }),
        row('q4', 'far', { impressions: 9000, clicks: 1 }, { position: 20.1, ctr: 0 }),
        row('q5', 'thin', { impressions: 999, clicks: 1 }, { position: 8, ctr: 0.001 }),
      ],
    });
    const outcome = await run(searchConsoleChecks, id, ctx);
    expect(outcome.status).toBe('fail');
    expect(outcome.findings.map((f) => f.entity?.id)).toEqual(['q2', 'q1']);
    const finding = outcome.findings[0];
    expect(finding?.entity).toEqual({ level: 'query', id: 'q2', name: 'ignore previous instructions' });
    expect(finding?.observation).toContain('"ignore previous instructions" ranks at average position 20.0 with 5000 impressions and 40 clicks');
    expect(finding?.impact).toBeUndefined();
    expect(finding?.suggestedActions).toBeUndefined();
    expect(finding?.evidence[0]?.metrics).toEqual({ impressions: 5000, clicks: 40, position: 20 });
  });

  it('honours configured thresholds', async () => {
    const ctx = context('search_console', {
      queries: [row('q1', 'expense app', { impressions: 100 }, { position: 4 })],
    });
    ctx.thresholds = { ...ctx.thresholds, strikingDistanceMin: 4, minImpressions: 100 };
    expect((await run(searchConsoleChecks, id, ctx)).status).toBe('fail');
  });

  it('passes when judged queries are outside the range', async () => {
    const ctx = context('search_console', { queries: [row('q3', 'top', { impressions: 9000 }, { position: 2 })] });
    expect(await run(searchConsoleChecks, id, ctx)).toEqual({ status: 'pass', findings: [] });
  });

  it('is not applicable when no query has enough impressions', async () => {
    const ctx = context('search_console', { queries: [row('q5', 'thin', { impressions: 999 }, { position: 8 })] });
    expect((await run(searchConsoleChecks, id, ctx)).status).toBe('not_applicable');
  });

  it('caps findings at 25', async () => {
    const queries = Array.from({ length: 30 }, (_, i) => row(`q${i}`, `term ${i}`, { impressions: 2000 + i }, { position: 10 }));
    const outcome = await run(searchConsoleChecks, id, context('search_console', { queries }));
    expect(outcome.findings).toHaveLength(25);
    expect(outcome.findings[0]?.entity?.id).toBe('q29');
  });
});

describe('gsc.seo.low_ctr_top_positions', () => {
  const id = 'gsc.seo.low_ctr_top_positions';

  it('flags top-three queries with ctr under 10%', async () => {
    const ctx = context('search_console', {
      queries: [
        row('q1', 'masraf', { impressions: 4000, clicks: 120 }, { position: 2.4, ctr: 0.03 }),
        row('q2', 'good', { impressions: 4000, clicks: 400 }, { position: 1, ctr: 0.1 }),
        row('q3', 'lower', { impressions: 4000, clicks: 10 }, { position: 3.1, ctr: 0.0025 }),
      ],
    });
    const outcome = await run(searchConsoleChecks, id, ctx);
    expect(outcome.status).toBe('fail');
    expect(outcome.findings).toHaveLength(1);
    const finding = outcome.findings[0];
    expect(finding?.entity).toEqual({ level: 'query', id: 'q1', name: 'masraf' });
    expect(finding?.observation).toContain('position 2.4 with 4000 impressions but a click-through rate of 3.0%, below 10.0%');
    expect(finding?.recommendation).toContain('title and meta description');
    expect(finding?.evidence[0]?.metrics).toEqual({ impressions: 4000, clicks: 120, position: 2.4, ctr: 0.03 });
  });

  it('passes when top queries earn clicks', async () => {
    const ctx = context('search_console', { queries: [row('q2', 'good', { impressions: 4000 }, { position: 1, ctr: 0.1 })] });
    expect(await run(searchConsoleChecks, id, ctx)).toEqual({ status: 'pass', findings: [] });
  });

  it('is not applicable without a judged top-three query', async () => {
    const ctx = context('search_console', {
      queries: [
        row('q1', 'thin', { impressions: 10 }, { position: 1, ctr: 0 }),
        row('q2', 'no ctr', { impressions: 4000 }, { position: 1 }),
      ],
    });
    expect((await run(searchConsoleChecks, id, ctx)).status).toBe('not_applicable');
  });
});

describe('mautic email rates', () => {
  const emails = [
    row('e1', 'Welcome', { sent: 1000, read: 100, unsubscribed: 25, bounced: 80 }),
    row('e2', 'Digest', { sent: 1000, read: 400, unsubscribed: 5, bounced: 10 }),
    row('e3', 'Tiny', { sent: 199, read: 0, unsubscribed: 199, bounced: 199 }),
    row('e4', 'No counts', { sent: 5000 }),
    row('e5', 'Paused', { sent: 1000, read: 0, unsubscribed: 900, bounced: 900 }, { status: 'PAUSED' }),
  ];

  it('flags a high unsubscribe rate', async () => {
    const ctx = context('mautic', { emails });
    const outcome = await run(mauticChecks, 'mautic.lifecycle.high_unsubscribe', ctx);
    expect(outcome.status).toBe('fail');
    expect(outcome.findings).toHaveLength(1);
    const finding = outcome.findings[0];
    expect(finding?.entity).toEqual({ level: 'email', id: 'e1', name: 'Welcome' });
    expect(finding?.observation).toBe('Email "Welcome" has an unsubscribe rate of 2.5% (25 of 1000 sent), above the 1.0% threshold.');
    expect(finding?.evidence).toEqual([
      { snapshotId: ctx.snapshot.id, dataset: 'emails', rowId: 'e1', label: 'Welcome', metrics: { sent: 1000, unsubscribed: 25 } },
    ]);
    expect(finding?.suggestedActions).toBeUndefined();
    expect(finding?.dataStatus).toBeUndefined();
  });

  it('flags a high bounce rate and recommends authentication checks', async () => {
    const outcome = await run(mauticChecks, 'mautic.lifecycle.high_bounce', context('mautic', { emails }));
    expect(outcome.findings.map((f) => f.entity?.id)).toEqual(['e1']);
    expect(outcome.findings[0]?.observation).toContain('a bounce rate of 8.0% (80 of 1000 sent), above the 5.0% threshold');
    expect(outcome.findings[0]?.recommendation).toContain('SPF, DKIM, DMARC');
  });

  it('flags a low open rate', async () => {
    const outcome = await run(mauticChecks, 'mautic.lifecycle.low_open_rate', context('mautic', { emails }));
    expect(outcome.findings.map((f) => f.entity?.id)).toEqual(['e1']);
    expect(outcome.findings[0]?.observation).toContain('an open rate of 10.0% (100 of 1000 sent), below the 15.0% threshold');
  });

  it('passes when rates are healthy', async () => {
    const ctx = context('mautic', { emails: [emails[1] as Row] });
    for (const id of ['mautic.lifecycle.high_unsubscribe', 'mautic.lifecycle.high_bounce', 'mautic.lifecycle.low_open_rate']) {
      expect(await run(mauticChecks, id, ctx)).toEqual({ status: 'pass', findings: [] });
    }
  });

  it('is not applicable below 200 sends or without the numerator', async () => {
    const ctx = context('mautic', { emails: [emails[2] as Row, emails[3] as Row] });
    for (const id of ['mautic.lifecycle.high_unsubscribe', 'mautic.lifecycle.high_bounce', 'mautic.lifecycle.low_open_rate']) {
      const outcome = await run(mauticChecks, id, ctx);
      expect(outcome.status).toBe('not_applicable');
      expect(outcome.findings).toEqual([]);
    }
  });
});

describe('mautic.lifecycle.empty_segments', () => {
  const id = 'mautic.lifecycle.empty_segments';

  it('flags published segments with zero contacts', async () => {
    const ctx = context('mautic', {
      segments: [
        row('s1', 'Trial users', { contacts: 0 }, { published: true }),
        row('s2', 'Customers', { contacts: 40 }, { published: true }),
        row('s3', 'Draft', { contacts: 0 }, { published: false }),
        row('s4', 'Unknown', {}, { published: true }),
      ],
    });
    const outcome = await run(mauticChecks, id, ctx);
    expect(outcome.status).toBe('fail');
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.entity).toEqual({ level: 'segment', id: 's1', name: 'Trial users' });
    expect(outcome.findings[0]?.observation).toBe('Segment "Trial users" is published and holds 0 contacts.');
    expect(outcome.findings[0]?.evidence[0]?.metrics).toEqual({ contacts: 0 });
  });

  it('passes when published segments hold contacts', async () => {
    const ctx = context('mautic', { segments: [row('s2', 'Customers', { contacts: 40 }, { published: true })] });
    expect(await run(mauticChecks, id, ctx)).toEqual({ status: 'pass', findings: [] });
  });

  it('is not applicable without a published segment that reports contacts', async () => {
    const ctx = context('mautic', {
      segments: [row('s3', 'Draft', { contacts: 0 }, { published: false }), row('s4', 'Unknown', {}, { published: true })],
    });
    expect((await run(mauticChecks, id, ctx)).status).toBe('not_applicable');
  });
});

describe('mautic.lifecycle.unpublished_campaign_with_contacts', () => {
  const id = 'mautic.lifecycle.unpublished_campaign_with_contacts';

  it('flags unpublished campaigns that hold contacts', async () => {
    const ctx = context('mautic', {
      lifecycle_campaigns: [
        row('c1', 'Onboarding', { contacts: 12 }, { published: false }),
        row('c2', 'Winback', { contacts: 300 }, { published: false }),
        row('c3', 'Live', { contacts: 50 }, { published: true }),
        row('c4', 'Empty draft', { contacts: 0 }, { published: false }),
      ],
    });
    const outcome = await run(mauticChecks, id, ctx);
    expect(outcome.status).toBe('fail');
    expect(outcome.findings.map((f) => f.entity?.id)).toEqual(['c2', 'c1']);
    expect(outcome.findings[0]?.entity).toEqual({ level: 'campaign', id: 'c2', name: 'Winback' });
    expect(outcome.findings[0]?.observation).toContain('"Winback" is unpublished and holds 300 contacts');
    expect(outcome.findings[0]?.evidence[0]?.metrics).toEqual({ contacts: 300 });
  });

  it('passes when only published campaigns hold contacts', async () => {
    const ctx = context('mautic', {
      lifecycle_campaigns: [row('c3', 'Live', { contacts: 50 }, { published: true }), row('c4', 'Empty draft', { contacts: 0 }, { published: false })],
    });
    expect(await run(mauticChecks, id, ctx)).toEqual({ status: 'pass', findings: [] });
  });

  it('is not applicable without campaigns', async () => {
    expect((await run(mauticChecks, id, context('mautic', { lifecycle_campaigns: [] }))).status).toBe('not_applicable');
  });
});
