import { describe, expect, it } from 'vitest';
import { AutopilotError } from '../../src/core/errors';
import { digest } from '../../src/core/ids';
import type {
  AccountConfig,
  ActionDraft,
  Connector,
  DatasetName,
  EntityRef,
  Finding,
  JsonObject,
  Snapshot,
} from '../../src/core/types';
import { createPlan, draftsFromFindings } from '../../src/plan/planner';

const account: AccountConfig = { id: 'acme-google', platform: 'google_ads', externalId: '123' };
const now = new Date('2026-03-01T10:00:00.000Z');

function pause(id: string, extra: Partial<ActionDraft> = {}): ActionDraft {
  return {
    kind: 'google_ads.campaign.pause',
    target: { level: 'campaign', id },
    params: {},
    rationale: 'Spends without converting',
    ...extra,
  };
}

function budget(id: string, dailyBudget: number): ActionDraft {
  return {
    kind: 'google_ads.campaign.set_daily_budget',
    target: { level: 'campaign', id },
    params: { dailyBudget },
    rationale: 'Budget limits an efficient campaign',
  };
}

function negative(id: string, text: string): ActionDraft {
  return {
    kind: 'google_ads.negative_keyword.add',
    target: { level: 'campaign', id },
    params: { text, matchType: 'EXACT' },
    rationale: 'Irrelevant search term with cost',
  };
}

function finding(id: string, monthly: number | null, actions: ActionDraft[], extra: Partial<Finding> = {}): Finding {
  return {
    id,
    checkId: 'gads.waste.test',
    category: 'waste',
    severity: 'high',
    platform: 'google_ads',
    accountId: account.id,
    snapshotId: 'snap_1',
    title: 't',
    observation: 'o',
    recommendation: 'r',
    evidence: [],
    suggestedActions: actions,
    needsReview: false,
    dataStatus: 'sufficient',
    ...(monthly === null ? {} : { impact: { kind: 'wasted_spend' as const, monthly, basis: 'b' } }),
    ...extra,
  };
}

function fakeConnector(states: Record<string, JsonObject | Error>): { connector: Connector; reads: string[] } {
  const reads: string[] = [];
  const connector: Connector = {
    platform: 'google_ads',
    source: 'demo',
    status: () => {
      throw new Error('not used');
    },
    fetchSnapshot: () => Promise.reject(new Error('not used')),
    readState: (draft) => {
      reads.push(draft.target.id);
      const state = states[draft.target.id];
      if (state === undefined) return Promise.resolve({});
      return state instanceof Error ? Promise.reject(state) : Promise.resolve(state);
    },
    apply: () => Promise.reject(new Error('not used')),
  };
  return { connector, reads };
}

function base(drafts: ActionDraft[], connector: Connector = fakeConnector({}).connector) {
  return {
    account,
    snapshot: null,
    drafts,
    title: ' Cut waste ',
    rationale: ' Stop spend that does not convert ',
    createdBy: 'agent' as const,
    connector,
    now,
  };
}

function snapshot(datasets: Snapshot['datasets']): Snapshot {
  return {
    id: 'snap_1',
    schemaVersion: 1,
    platform: account.platform,
    accountId: account.id,
    externalAccountId: account.externalId,
    source: 'api',
    currency: 'USD',
    timezone: 'UTC',
    dateRange: { start: '2026-02-01', end: '2026-02-28' },
    createdAt: now.toISOString(),
    datasets,
    coverage: {},
    warnings: [],
    contentHash: 'snapshot-content-hash',
  };
}

async function rejection(promise: Promise<unknown>): Promise<AutopilotError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AutopilotError);
    return error as AutopilotError;
  }
  throw new Error('expected a rejection');
}

describe('draftsFromFindings', () => {
  it('orders by monthly impact, with findings without impact last', () => {
    const drafts = draftsFromFindings([
      finding('fnd_none', null, [pause('c0')]),
      finding('fnd_small', 10, [pause('c1')]),
      finding('fnd_big', 500, [pause('c2'), negative('c2', 'free')]),
    ]);
    expect(drafts.map((d) => `${d.kind}:${d.target.id}`)).toEqual([
      'google_ads.campaign.pause:c2',
      'google_ads.negative_keyword.add:c2',
      'google_ads.campaign.pause:c1',
      'google_ads.campaign.pause:c0',
    ]);
  });

  it('drops duplicates and merges their finding ids into the first', () => {
    const first = pause('c1', { findingIds: ['fnd_extra'] });
    const drafts = draftsFromFindings([
      finding('fnd_b', 10, [pause('c1', { rationale: 'Second opinion on it' }), budget('c1', 5)]),
      finding('fnd_a', 90, [first, budget('c1', 7)]),
    ]);
    expect(drafts).toHaveLength(3);
    expect(drafts[0]?.rationale).toBe('Spends without converting');
    expect(drafts[0]?.findingIds).toEqual(['fnd_extra', 'fnd_a', 'fnd_b']);
    // Different params are different actions.
    expect(drafts.slice(1).map((d) => d.params)).toEqual([{ dailyBudget: 7 }, { dailyBudget: 5 }]);
    expect(first.findingIds).toEqual(['fnd_extra']);
  });

  it('skips findings whose data is not sufficient', () => {
    const drafts = draftsFromFindings([
      finding('fnd_1', 900, [pause('c1')], { dataStatus: 'limited' }),
      finding('fnd_2', 800, [pause('c2')], { dataStatus: 'tracking_issue' }),
      finding('fnd_3', 700, [pause('c3')], { dataStatus: 'undecidable' }),
      finding('fnd_4', 1, [pause('c4')]),
    ]);
    expect(drafts.map((d) => d.target.id)).toEqual(['c4']);
  });

  it('caps the result, 25 by default', () => {
    const findings = Array.from({ length: 30 }, (_, i) => finding(`fnd_${i}`, 100 - i, [pause(`c${i}`)]));
    expect(draftsFromFindings(findings)).toHaveLength(25);
    expect(draftsFromFindings(findings, 2).map((d) => d.target.id)).toEqual(['c0', 'c1']);
  });
});

describe('createPlan validation', () => {
  it('refuses a plan without drafts', async () => {
    const error = await rejection(createPlan(base([])));
    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain('at least one draft');
  });

  it('refuses more than 200 drafts', async () => {
    const drafts = Array.from({ length: 201 }, (_, i) => pause(`c${i}`));
    const error = await rejection(createPlan(base(drafts)));
    expect(error.message).toContain('at most 200 drafts, got 201');
  });

  it('lists every problem at once, one per line, with the draft position', async () => {
    const { connector, reads } = fakeConnector({});
    const error = await rejection(
      createPlan({
        ...base(
          [
            pause('c1'),
            { ...budget('c2', -5), rationale: 'short' },
            { ...pause(''), target: { level: 'ad', id: '' } },
            { ...pause('c9'), kind: 'google_ads.campaign.delete' as ActionDraft['kind'] },
          ],
          connector,
        ),
        title: '   ',
        rationale: '',
      }),
    );
    expect(error.code).toBe('invalid_input');
    const lines = error.message.split('\n');
    expect(lines).toContain('title must not be empty');
    expect(lines).toContain('rationale must not be empty');
    expect(lines).toContain('drafts[1]: rationale must be at least 10 characters');
    expect(lines).toContain('drafts[1]: params.dailyBudget must be a finite number greater than 0');
    expect(lines).toContain("drafts[2]: target.level must be 'campaign' for google_ads.campaign.pause, got 'ad'");
    expect(lines).toContain('drafts[2]: target.id must not be empty');
    expect(lines).toContain("drafts[3]: kind 'google_ads.campaign.delete' is not a supported action");
    expect(lines.some((line) => line.startsWith('drafts[0]'))).toBe(false);
    expect(reads).toEqual([]);
  });

  it('reports a malformed draft instead of crashing', async () => {
    const broken = { kind: 'google_ads.campaign.pause', rationale: 'Spends without converting' };
    const error = await rejection(createPlan(base([broken as unknown as ActionDraft])));
    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain('drafts[0]: target must be an object with level and id');
  });

  it('refuses a draft for another platform', async () => {
    const meta: ActionDraft = { ...pause('m1'), kind: 'meta_ads.campaign.pause' };
    const error = await rejection(createPlan(base([pause('c1'), meta])));
    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain(
      "drafts[1]: meta_ads.campaign.pause is a meta_ads action, but account 'acme-google' is google_ads",
    );
  });

  it('refuses conflicting changes to one entity', async () => {
    const enable: ActionDraft = { ...pause('c1'), kind: 'google_ads.campaign.enable' };
    const error = await rejection(createPlan(base([pause('c1'), budget('c1', 20), enable, budget('c1', 30)])));
    const lines = error.message.split('\n');
    expect(lines).toContain('drafts[2]: conflicts with drafts[0]: both change the same field of the same entity');
    expect(lines).toContain('drafts[3]: conflicts with drafts[1]: both change the same field of the same entity');
    expect(lines).toHaveLength(3);
  });

  it('allows different fields and different children of one entity, refuses the same child twice', async () => {
    const plan = await createPlan(
      base([pause('c1'), budget('c1', 20), negative('c1', 'free'), negative('c1', 'jobs'), pause('c2')]),
    );
    expect(plan.actions).toHaveLength(5);

    const remove: ActionDraft = { ...negative('c1', 'free'), kind: 'google_ads.negative_keyword.remove' };
    const error = await rejection(createPlan(base([negative('c1', 'free'), remove])));
    expect(error.message).toContain('drafts[1]: conflicts with drafts[0]');
  });

  it('refuses a snapshot of another account', async () => {
    const snapshot = { id: 'snap_other', accountId: 'someone-else' } as Snapshot;
    const error = await rejection(createPlan({ ...base([pause('c1')]), snapshot }));
    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain('snap_other');
  });
});

describe('createPlan', () => {
  it.each<{
    kind: ActionDraft['kind'];
    level: EntityRef['level'];
    dataset: DatasetName;
  }>([
    { kind: 'google_ads.campaign.pause', level: 'campaign', dataset: 'campaigns' },
    { kind: 'google_ads.ad_group.pause', level: 'ad_group', dataset: 'ad_groups' },
    { kind: 'google_ads.ad.pause', level: 'ad', dataset: 'ads' },
    { kind: 'google_ads.keyword.pause', level: 'keyword', dataset: 'keywords' },
    { kind: 'google_ads.negative_keyword.add', level: 'campaign', dataset: 'campaigns' },
    { kind: 'google_ads.negative_keyword.remove', level: 'campaign', dataset: 'campaigns' },
  ])('takes target metadata only from its snapshot row for $kind', async ({ kind, level, dataset }) => {
    const data = snapshot({
      [dataset]: [
        { id: 'decoy', name: 'Unrelated row', metrics: {}, attrs: {} },
        { id: 'target', name: 'Protected Brand', campaignId: 'parent', adGroupId: 'group', metrics: {}, attrs: {} },
      ],
    });
    const confirmedTarget = { level, id: 'target', name: 'Protected Brand', campaignId: 'parent', adGroupId: 'group' };
    for (const metadata of [{}, { name: 'Safe name', campaignId: 'forged-parent', adGroupId: 'forged-group' }]) {
      const draft: ActionDraft = {
        kind,
        target: { level, id: 'target', ...metadata },
        params: kind.includes('.negative_keyword.') ? { text: 'free', matchType: 'EXACT' } : {},
        rationale: 'Remove irrelevant spend',
      };
      const original = structuredClone({ draft, data });
      const reads: EntityRef[] = [];
      const connector = {
        ...fakeConnector({}).connector,
        readState: (input: ActionDraft) => {
          reads.push(input.target);
          return Promise.resolve({ status: 'ENABLED' });
        },
      };
      const plan = await createPlan({ ...base([draft], connector), snapshot: data });
      expect(plan.actions[0]?.target).toEqual(confirmedTarget);
      expect(reads).toEqual([confirmedTarget]);
      expect({ draft, data }).toEqual(original);
    }
  });

  it.each([
    { reason: 'no snapshot', data: null },
    { reason: 'no target dataset', data: snapshot({}) },
    { reason: 'no matching row', data: snapshot({ ads: [{ id: 'other', name: 'Other', metrics: {}, attrs: {} }] }) },
    { reason: 'no row metadata', data: snapshot({ ads: [{ id: 'ad-1', metrics: {}, attrs: {} }] }) },
  ])('removes unconfirmed target metadata with $reason', async ({ data }) => {
    const draft = pause('ad-1', {
      kind: 'google_ads.ad.pause',
      target: { level: 'ad', id: 'ad-1', name: 'Safe name', campaignId: 'forged-parent', adGroupId: 'forged-group' },
    });
    const plan = await createPlan({ ...base([draft]), snapshot: data });
    expect(plan.actions[0]?.target).toEqual({ level: 'ad', id: 'ad-1' });
  });

  it('keeps only the target metadata fields the row confirms', async () => {
    const draft = pause('c1', {
      target: { level: 'campaign', id: 'c1', name: 'Safe name', campaignId: 'forged-parent', adGroupId: 'forged-group' },
    });
    const data = snapshot({ campaigns: [{ id: 'c1', name: 'Protected Brand', metrics: {}, attrs: {} }] });
    const plan = await createPlan({ ...base([draft]), snapshot: data });
    expect(plan.actions[0]?.target).toEqual({ level: 'campaign', id: 'c1', name: 'Protected Brand' });
  });

  it('takes a segment name from the segments dataset', async () => {
    const mautic: AccountConfig = { id: 'acme-mautic', platform: 'mautic', externalId: 'm1' };
    const draft: ActionDraft = {
      kind: 'mautic.segment.add_contact',
      target: { level: 'segment', id: 'segment-1', name: 'Forged name' },
      params: { contactId: '123' },
      rationale: 'Add the reviewed contact',
    };
    const data = {
      ...snapshot({ segments: [{ id: 'segment-1', name: 'Newsletter', metrics: {}, attrs: {} }] }),
      platform: mautic.platform,
      accountId: mautic.id,
    };
    const plan = await createPlan({ ...base([draft]), account: mautic, snapshot: data });
    expect(plan.actions[0]?.target).toEqual({ level: 'segment', id: 'segment-1', name: 'Newsletter' });
  });

  it('takes target metadata only from the snapshot and drops what the caller supplied', async () => {
    const forged = { name: 'Safe name', campaignId: 'forged-parent', adGroupId: 'forged-group' };
    const drafts = [
      pause('ad-1', { kind: 'google_ads.ad.pause', target: { level: 'ad', id: 'ad-1', ...forged } }),
      pause('ad-2', { kind: 'google_ads.ad.pause', target: { level: 'ad', id: 'ad-2', ...forged } }),
    ];
    const data = snapshot({ ads: [{ id: 'ad-2', name: 'Brand ad', campaignId: 'c2', metrics: {}, attrs: {} }] });
    const withSnapshot = await createPlan({ ...base(drafts), snapshot: data });
    expect(withSnapshot.actions.map((item) => item.target)).toEqual([
      { level: 'ad', id: 'ad-1' },
      { level: 'ad', id: 'ad-2', name: 'Brand ad', campaignId: 'c2' },
    ]);
    const withoutSnapshot = await createPlan(base(drafts));
    expect(withoutSnapshot.actions.map((item) => item.target)).toEqual([
      { level: 'ad', id: 'ad-1' },
      { level: 'ad', id: 'ad-2' },
    ]);
  });

  it('lets a connector error propagate', async () => {
    const failure = new AutopilotError('not_found', 'Campaign c2 does not exist');
    const { connector, reads } = fakeConnector({ c1: { status: 'ENABLED', dailyBudget: 40 }, c2: failure });
    await expect(createPlan(base([pause('c1'), pause('c2'), pause('c3')], connector))).rejects.toBe(failure);
    expect(reads).toEqual(['c1', 'c2']);
  });

  it('builds a proposed plan whose actions carry before, after, precondition and spend effect', async () => {
    const { connector, reads } = fakeConnector({
      c1: { status: 'ENABLED', dailyBudget: 40 },
      c2: { dailyBudget: 50 },
    });
    const snapshot = { id: 'snap_1', accountId: account.id } as Snapshot;
    const plan = await createPlan({ ...base([pause('c1'), budget('c2', 65)], connector), snapshot });

    expect(reads).toEqual(['c1', 'c2']);
    expect(plan).toMatchObject({
      schemaVersion: 1,
      createdAt: '2026-03-01T10:00:00.000Z',
      createdBy: 'agent',
      accountId: 'acme-google',
      platform: 'google_ads',
      snapshotId: 'snap_1',
      title: 'Cut waste',
      rationale: 'Stop spend that does not convert',
      status: 'proposed',
    });
    expect(plan.id).toMatch(/^plan_[0-9a-f]{16}$/);
    expect(plan.digest).toMatch(/^[0-9a-f]{64}$/);

    const [first, second] = plan.actions;
    expect(first).toMatchObject({
      kind: 'google_ads.campaign.pause',
      before: { status: 'ENABLED', dailyBudget: 40 },
      after: { status: 'PAUSED' },
      preconditionHash: digest({ status: 'ENABLED', dailyBudget: 40 }),
      spendEffect: 'decrease',
      spendDeltaPerDay: -40,
      status: 'pending',
    });
    expect(second).toMatchObject({
      before: { dailyBudget: 50 },
      after: { dailyBudget: 65 },
      preconditionHash: digest({ dailyBudget: 50 }),
      spendEffect: 'increase',
      spendDeltaPerDay: 15,
    });
  });

  it('has a stable digest, and an id that depends on createdAt', async () => {
    const states = { c1: { status: 'ENABLED', dailyBudget: 40 } };
    const one = await createPlan(base([pause('c1')], fakeConnector(states).connector));
    const two = await createPlan(base([pause('c1')], fakeConnector(states).connector));
    const later = await createPlan({
      ...base([pause('c1')], fakeConnector(states).connector),
      now: new Date('2026-03-01T10:00:01.000Z'),
    });
    const changed = await createPlan(
      base([pause('c1')], fakeConnector({ c1: { status: 'ENABLED', dailyBudget: 41 } }).connector),
    );

    expect(two.digest).toBe(one.digest);
    expect(two.id).toBe(one.id);
    expect(later.digest).toBe(one.digest);
    expect(later.id).not.toBe(one.id);
    expect(changed.digest).not.toBe(one.digest);
  });

  it('sets snapshotId to null and omits revertsPlanId unless given', async () => {
    const plain = await createPlan(base([pause('c1')]));
    expect(plain.snapshotId).toBeNull();
    expect('revertsPlanId' in plain).toBe(false);

    const revert = await createPlan({ ...base([pause('c1')]), revertsPlanId: 'plan_0123456789abcdef' });
    expect(revert.revertsPlanId).toBe('plan_0123456789abcdef');
  });
});
