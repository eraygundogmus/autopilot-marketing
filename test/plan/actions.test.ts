import { describe, expect, it } from 'vitest';
import { AutopilotError } from '../../src/core/errors';
import { digest } from '../../src/core/ids';
import { ACTION_KINDS } from '../../src/core/types';
import type { ActionDraft, ActionKind, EntityLevel, JsonObject } from '../../src/core/types';
import { actionSpec, buildAction, planDigest, validateDraft } from '../../src/plan/actions';

function draft(kind: ActionKind, params: JsonObject = {}, level?: EntityLevel): ActionDraft {
  return {
    kind,
    target: { level: level ?? actionSpec(kind).targetLevel, id: '123' },
    params,
    rationale: 'Wasted spend with no conversions',
  };
}

describe('actionSpec', () => {
  it('has a spec for every kind', () => {
    expect(ACTION_KINDS).toHaveLength(23);
    for (const kind of ACTION_KINDS) {
      const spec = actionSpec(kind);
      expect(spec.kind).toBe(kind);
      expect(spec.platform).toBe(kind.split('.')[0]);
      expect(spec.fields.length).toBeGreaterThan(0);
    }
  });

  it('throws unsupported for a kind outside the allowlist', () => {
    try {
      actionSpec('google_ads.campaign.delete' as ActionKind);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AutopilotError);
      expect((error as AutopilotError).code).toBe('unsupported');
    }
  });

  it('maps target levels and fields', () => {
    expect(actionSpec('meta_ads.adset.pause').targetLevel).toBe('ad_group');
    expect(actionSpec('meta_ads.adset.set_daily_budget').targetLevel).toBe('ad_group');
    expect(actionSpec('google_ads.negative_keyword.add').targetLevel).toBe('campaign');
    expect(actionSpec('mautic.segment.add_contact').targetLevel).toBe('segment');
    expect(actionSpec('mautic.email.create_draft').targetLevel).toBe('account');
    expect(actionSpec('google_ads.keyword.set_bid').targetLevel).toBe('keyword');
    expect(actionSpec('google_ads.campaign.pause').fields).toEqual(['status', 'dailyBudget']);
    expect(actionSpec('meta_ads.adset.enable').fields).toEqual(['status', 'dailyBudget']);
    expect(actionSpec('google_ads.ad_group.pause').fields).toEqual(['status']);
    expect(actionSpec('meta_ads.ad.enable').fields).toEqual(['status']);
    expect(actionSpec('google_ads.keyword.set_bid').fields).toEqual(['bid']);
    expect(actionSpec('mautic.segment.remove_contact').fields).toEqual(['member']);
  });

  it('declares reversibility and cautions', () => {
    expect(actionSpec('google_ads.campaign.pause').reversible).toBe('exact');
    expect(actionSpec('meta_ads.campaign.set_daily_budget').reversible).toBe('exact');
    expect(actionSpec('google_ads.negative_keyword.add').reversible).toBe('compensating');
    expect(actionSpec('mautic.email.create_draft').reversible).toBe('none');
    expect(actionSpec('mautic.segment.add_contact').caution).toBe(
      'Segment membership can start campaigns and emails in Mautic.',
    );
    expect(actionSpec('google_ads.campaign.pause').caution).toBeUndefined();
  });

  it('computes after', () => {
    expect(actionSpec('google_ads.ad.pause').after(null, {})).toEqual({ status: 'PAUSED' });
    expect(actionSpec('meta_ads.ad.enable').after(null, {})).toEqual({ status: 'ENABLED' });
    expect(actionSpec('meta_ads.adset.set_daily_budget').after(null, { dailyBudget: 40 })).toEqual({ dailyBudget: 40 });
    expect(actionSpec('google_ads.keyword.set_bid').after(null, { bid: 1.5 })).toEqual({ bid: 1.5 });
    expect(actionSpec('google_ads.negative_keyword.add').after(null, {})).toEqual({ exists: true });
    expect(actionSpec('google_ads.negative_keyword.remove').after(null, {})).toEqual({ exists: false });
    expect(actionSpec('mautic.segment.add_contact').after(null, {})).toEqual({ member: true });
    expect(actionSpec('mautic.segment.remove_contact').after(null, {})).toEqual({ member: false });
    expect(actionSpec('mautic.email.create_draft').after(null, {})).toEqual({ exists: true });
  });
});

describe('param validation', () => {
  it('requires empty params for pause and enable', () => {
    expect(actionSpec('google_ads.campaign.pause').validate({})).toEqual([]);
    expect(actionSpec('meta_ads.ad.enable').validate({ status: 'ENABLED' })).toHaveLength(1);
  });

  it('validates budgets and bids', () => {
    const budget = actionSpec('google_ads.campaign.set_daily_budget');
    expect(budget.validate({ dailyBudget: 25 })).toEqual([]);
    for (const bad of [0, -5, '25', null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(budget.validate({ dailyBudget: bad })).toHaveLength(1);
    }
    expect(budget.validate({})).toHaveLength(1);
    expect(budget.validate({ dailyBudget: 25, bid: 1 })).toHaveLength(1);
    expect(budget.validate({ bid: 1 })).toHaveLength(2);
    const bid = actionSpec('google_ads.keyword.set_bid');
    expect(bid.validate({ bid: 0.4 })).toEqual([]);
    expect(bid.validate({ bid: 0 })).toHaveLength(1);
  });

  it('validates negative keywords', () => {
    const spec = actionSpec('google_ads.negative_keyword.add');
    expect(spec.validate({ text: 'free download', matchType: 'PHRASE' })).toEqual([]);
    expect(spec.validate({ text: '   ', matchType: 'EXACT' })).toHaveLength(1);
    expect(spec.validate({ text: 'a'.repeat(81), matchType: 'EXACT' })).toHaveLength(1);
    expect(spec.validate({ text: `  ${'a'.repeat(80)}  `, matchType: 'EXACT' })).toEqual([]);
    expect(spec.validate({ text: 'a b c d e f g h i j k', matchType: 'BROAD' })).toHaveLength(1);
    expect(spec.validate({ text: 'a b c d e f g h i j', matchType: 'BROAD' })).toEqual([]);
    for (const char of ['!', '@', '%', ',', '*']) {
      expect(spec.validate({ text: `cheap${char}shoes`, matchType: 'EXACT' })).toHaveLength(1);
    }
    expect(spec.validate({ text: 'jobs', matchType: 'exact' })).toHaveLength(1);
    expect(spec.validate({ text: 'jobs' })).toHaveLength(1);
    expect(spec.validate({})).toHaveLength(2);
    expect(spec.validate({ text: 'jobs', matchType: 'EXACT', level: 'x' })).toHaveLength(1);
    expect(actionSpec('google_ads.negative_keyword.remove').validate({ text: 'jobs', matchType: 'EXACT' })).toEqual([]);
  });

  it('validates mautic params', () => {
    const segment = actionSpec('mautic.segment.add_contact');
    expect(segment.validate({ contactId: '42' })).toEqual([]);
    expect(segment.validate({ contactId: 42 })).toHaveLength(1);
    expect(segment.validate({ contactId: '4a' })).toHaveLength(1);
    expect(segment.validate({ contactId: '' })).toHaveLength(1);
    expect(segment.validate({ contactId: '42', extra: true })).toHaveLength(1);

    const email = actionSpec('mautic.email.create_draft');
    expect(email.validate({ name: 'n', subject: 's', html: '<p>h</p>' })).toEqual([]);
    expect(email.validate({})).toHaveLength(3);
    expect(email.validate({ name: 'n'.repeat(201), subject: 's'.repeat(201), html: 'h'.repeat(200001) })).toHaveLength(3);
    expect(email.validate({ name: 'n'.repeat(200), subject: 's'.repeat(200), html: 'h'.repeat(200000) })).toEqual([]);
    expect(email.validate({ name: 'n', subject: 's', html: 'h', send: true })).toHaveLength(1);
  });
});

describe('spend', () => {
  it('pause and enable with and without a budget', () => {
    const pause = actionSpec('google_ads.campaign.pause');
    const enable = actionSpec('meta_ads.adset.enable');
    expect(pause.spend({ status: 'ENABLED', dailyBudget: 50 }, { status: 'PAUSED' })).toEqual({
      effect: 'decrease',
      deltaPerDay: -50,
    });
    expect(pause.spend({ status: 'ENABLED' }, { status: 'PAUSED' })).toEqual({ effect: 'decrease', deltaPerDay: null });
    expect(pause.spend(null, { status: 'PAUSED' })).toEqual({ effect: 'decrease', deltaPerDay: null });
    expect(pause.spend({ status: 'PAUSED', dailyBudget: 50 }, { status: 'PAUSED' })).toEqual({
      effect: 'none',
      deltaPerDay: 0,
    });
    expect(enable.spend({ status: 'PAUSED', dailyBudget: 30 }, { status: 'ENABLED' })).toEqual({
      effect: 'increase',
      deltaPerDay: 30,
    });
    expect(enable.spend({ status: 'PAUSED' }, { status: 'ENABLED' })).toEqual({ effect: 'increase', deltaPerDay: null });
    expect(enable.spend({ status: 'ENABLED', dailyBudget: 30 }, { status: 'ENABLED' })).toEqual({
      effect: 'none',
      deltaPerDay: 0,
    });
  });

  it('budget up, down, equal and unknown', () => {
    const spec = actionSpec('google_ads.campaign.set_daily_budget');
    expect(spec.spend({ dailyBudget: 10 }, { dailyBudget: 12.5 })).toEqual({ effect: 'increase', deltaPerDay: 2.5 });
    expect(spec.spend({ dailyBudget: 10 }, { dailyBudget: 4 })).toEqual({ effect: 'decrease', deltaPerDay: -6 });
    expect(spec.spend({ dailyBudget: 10 }, { dailyBudget: 10 })).toEqual({ effect: 'none', deltaPerDay: 0 });
    expect(spec.spend({ dailyBudget: 0.1 }, { dailyBudget: 0.3 })).toEqual({ effect: 'increase', deltaPerDay: 0.2 });
    expect(spec.spend(null, { dailyBudget: 10 })).toEqual({ effect: 'unknown', deltaPerDay: null });
    expect(spec.spend({ dailyBudget: null }, { dailyBudget: 10 })).toEqual({ effect: 'unknown', deltaPerDay: null });
  });

  it('entities without a budget of their own leave the daily ceiling unchanged', () => {
    for (const kind of ['google_ads.ad_group.enable', 'google_ads.ad.enable', 'google_ads.keyword.enable', 'meta_ads.ad.enable'] as const) {
      expect(actionSpec(kind).spend({ status: 'PAUSED' }, { status: 'ENABLED' })).toEqual({ effect: 'increase', deltaPerDay: 0 });
    }
    expect(actionSpec('google_ads.keyword.pause').spend({ status: 'ENABLED' }, { status: 'PAUSED' })).toEqual({
      effect: 'decrease',
      deltaPerDay: 0,
    });
    // A null budget means it is set one level up, shared or lifetime: enabling moves no ceiling.
    expect(actionSpec('meta_ads.adset.enable').spend({ status: 'PAUSED', dailyBudget: null }, { status: 'ENABLED' })).toEqual({
      effect: 'increase',
      deltaPerDay: 0,
    });
    // A budget that could not be read at all stays unknown.
    expect(actionSpec('meta_ads.adset.enable').spend({ status: 'PAUSED' }, { status: 'ENABLED' })).toEqual({
      effect: 'increase',
      deltaPerDay: null,
    });
  });

  it('bid direction without a daily amount', () => {
    const spec = actionSpec('google_ads.keyword.set_bid');
    // A bid moves spend inside the daily budget; the budget ceiling itself does not change.
    expect(spec.spend({ bid: 1 }, { bid: 2 })).toEqual({ effect: 'increase', deltaPerDay: 0 });
    expect(spec.spend({ bid: 2 }, { bid: 1 })).toEqual({ effect: 'decrease', deltaPerDay: 0 });
    expect(spec.spend({ bid: 2 }, { bid: 2 })).toEqual({ effect: 'none', deltaPerDay: 0 });
    expect(spec.spend(null, { bid: 2 })).toEqual({ effect: 'unknown', deltaPerDay: null });
    expect(spec.spend({}, { bid: 2 })).toEqual({ effect: 'unknown', deltaPerDay: null });
  });

  it('negative keywords and mautic', () => {
    const add = actionSpec('google_ads.negative_keyword.add');
    const remove = actionSpec('google_ads.negative_keyword.remove');
    expect(add.spend({ exists: false }, { exists: true })).toEqual({ effect: 'decrease', deltaPerDay: 0 });
    expect(add.spend(null, { exists: true })).toEqual({ effect: 'decrease', deltaPerDay: 0 });
    expect(add.spend({ exists: true }, { exists: true })).toEqual({ effect: 'none', deltaPerDay: 0 });
    expect(remove.spend({ exists: true }, { exists: false })).toEqual({ effect: 'increase', deltaPerDay: 0 });
    expect(remove.spend({ exists: false }, { exists: false })).toEqual({ effect: 'none', deltaPerDay: 0 });
    expect(actionSpec('mautic.segment.add_contact').spend(null, { member: true })).toEqual({
      effect: 'none',
      deltaPerDay: 0,
    });
    expect(actionSpec('mautic.email.create_draft').spend(null, { exists: true })).toEqual({
      effect: 'none',
      deltaPerDay: 0,
    });
  });
});

describe('inverse', () => {
  it('pause and enable revert to the opposite kind only when the status changed', () => {
    const paused = buildAction(draft('google_ads.campaign.pause'), { status: 'ENABLED', dailyBudget: 20 });
    expect(actionSpec(paused.kind).inverse(paused)).toEqual({
      kind: 'google_ads.campaign.enable',
      target: paused.target,
      params: {},
      rationale: 'Revert google_ads.campaign.pause',
    });
    const enabled = buildAction(draft('meta_ads.adset.enable'), { status: 'PAUSED' });
    expect(actionSpec(enabled.kind).inverse(enabled)?.kind).toBe('meta_ads.adset.pause');

    const noop = buildAction(draft('google_ads.campaign.pause'), { status: 'PAUSED' });
    expect(actionSpec(noop.kind).inverse(noop)).toBeNull();
    const blind = buildAction(draft('google_ads.campaign.pause'), null);
    expect(actionSpec(blind.kind).inverse(blind)).toBeNull();
    const untyped = buildAction(draft('google_ads.campaign.pause'), { dailyBudget: 5 });
    expect(actionSpec(untyped.kind).inverse(untyped)).toBeNull();
  });

  it('every pause and enable kind pairs with its opposite', () => {
    for (const kind of ACTION_KINDS) {
      const pausing = kind.endsWith('.pause');
      if (!pausing && !kind.endsWith('.enable')) continue;
      const action = buildAction(draft(kind), { status: pausing ? 'ENABLED' : 'PAUSED' });
      const expected = kind.replace(/\.(pause|enable)$/, pausing ? '.enable' : '.pause');
      expect(actionSpec(kind).inverse(action)?.kind).toBe(expected);
    }
  });

  it('budget and bid restore the previous value', () => {
    const budget = buildAction(draft('meta_ads.campaign.set_daily_budget', { dailyBudget: 80 }), { dailyBudget: 50 });
    expect(actionSpec(budget.kind).inverse(budget)).toEqual({
      kind: 'meta_ads.campaign.set_daily_budget',
      target: budget.target,
      params: { dailyBudget: 50 },
      rationale: 'Revert meta_ads.campaign.set_daily_budget',
    });
    const blind = buildAction(draft('meta_ads.campaign.set_daily_budget', { dailyBudget: 80 }), null);
    expect(actionSpec(blind.kind).inverse(blind)).toBeNull();

    const bid = buildAction(draft('google_ads.keyword.set_bid', { bid: 2 }), { bid: 1.2 });
    expect(actionSpec(bid.kind).inverse(bid)?.params).toEqual({ bid: 1.2 });
    const noBid = buildAction(draft('google_ads.keyword.set_bid', { bid: 2 }), {});
    expect(actionSpec(noBid.kind).inverse(noBid)).toBeNull();
  });

  it('negative keywords and segments compensate, email drafts cannot be undone', () => {
    const params = { text: 'free', matchType: 'BROAD' };
    const add = buildAction(draft('google_ads.negative_keyword.add', params), { exists: false });
    expect(actionSpec(add.kind).inverse(add)).toMatchObject({ kind: 'google_ads.negative_keyword.remove', params });
    const remove = buildAction(draft('google_ads.negative_keyword.remove', params), { exists: true });
    expect(actionSpec(remove.kind).inverse(remove)).toMatchObject({ kind: 'google_ads.negative_keyword.add', params });

    const join = buildAction(draft('mautic.segment.add_contact', { contactId: '7' }), { member: false });
    expect(actionSpec(join.kind).inverse(join)).toMatchObject({
      kind: 'mautic.segment.remove_contact',
      params: { contactId: '7' },
    });
    const leave = buildAction(draft('mautic.segment.remove_contact', { contactId: '7' }), { member: true });
    expect(actionSpec(leave.kind).inverse(leave)?.kind).toBe('mautic.segment.add_contact');

    const email = buildAction(draft('mautic.email.create_draft', { name: 'n', subject: 's', html: 'h' }), null);
    expect(actionSpec(email.kind).inverse(email)).toBeNull();
  });

  it('negative keywords and segments have no inverse when the action changed nothing', () => {
    const cases: Array<{ add: ActionKind; remove: ActionKind; field: string; params: JsonObject }> = [
      {
        add: 'google_ads.negative_keyword.add',
        remove: 'google_ads.negative_keyword.remove',
        field: 'exists',
        params: { text: 'free', matchType: 'BROAD' },
      },
      {
        add: 'mautic.segment.add_contact',
        remove: 'mautic.segment.remove_contact',
        field: 'member',
        params: { contactId: '7' },
      },
    ];
    for (const { add, remove, field, params } of cases) {
      const inverseOf = (kind: ActionKind, before: JsonObject | null) => {
        const action = buildAction(draft(kind, params), before);
        return actionSpec(kind).inverse(action);
      };
      expect(inverseOf(add, { [field]: true })).toBeNull();
      expect(inverseOf(add, { [field]: false })).toMatchObject({ kind: remove, params });
      expect(inverseOf(remove, { [field]: false })).toBeNull();
      expect(inverseOf(remove, { [field]: true })).toMatchObject({ kind: add, params });
      expect(inverseOf(add, null)).toBeNull();
      expect(inverseOf(remove, null)).toBeNull();
      expect(inverseOf(add, {})).toBeNull();
      expect(inverseOf(remove, {})).toBeNull();
    }
  });

  it('produces drafts that validate', () => {
    const paused = buildAction(draft('google_ads.keyword.pause'), { status: 'ENABLED' });
    const inverse = actionSpec(paused.kind).inverse(paused);
    expect(inverse).not.toBeNull();
    if (inverse !== null) expect(validateDraft(inverse)).toEqual([]);
  });
});

describe('validateDraft', () => {
  it('accepts a valid draft', () => {
    expect(validateDraft(draft('google_ads.campaign.pause'))).toEqual([]);
    expect(validateDraft(draft('meta_ads.adset.set_daily_budget', { dailyBudget: 15 }))).toEqual([]);
  });

  it('reports each problem', () => {
    expect(validateDraft({ ...draft('google_ads.campaign.pause'), kind: 'x.y.z' as ActionKind })).toHaveLength(1);
    expect(validateDraft(draft('meta_ads.adset.pause', {}, 'campaign'))).toHaveLength(1);
    expect(validateDraft({ ...draft('google_ads.ad.pause'), target: { level: 'ad', id: '' } })).toHaveLength(1);
    expect(validateDraft({ ...draft('google_ads.ad.pause'), rationale: '  too short  ' })).toHaveLength(1);
    expect(validateDraft(draft('google_ads.keyword.set_bid', { bid: -1 }))).toHaveLength(1);
    expect(
      validateDraft({
        kind: 'google_ads.campaign.set_daily_budget',
        target: { level: 'keyword', id: '' },
        params: { dailyBudget: 0, extra: 1 },
        rationale: '',
      }),
    ).toHaveLength(5);
  });
});

describe('buildAction', () => {
  it('fills the action from the spec', () => {
    const before = { status: 'ENABLED', dailyBudget: 20 };
    const action = buildAction({ ...draft('google_ads.campaign.pause'), findingIds: ['fnd_1'] }, before);
    expect(action).toMatchObject({
      platform: 'google_ads',
      before,
      after: { status: 'PAUSED' },
      preconditionHash: digest(before),
      spendEffect: 'decrease',
      spendDeltaPerDay: -20,
      reversible: 'exact',
      status: 'pending',
      rationale: 'Wasted spend with no conversions',
      findingIds: ['fnd_1'],
      params: {},
    });
    expect(action.id).toMatch(/^act_[0-9a-f]{16}$/);
  });

  it('omits findingIds and the precondition when absent', () => {
    const action = buildAction(draft('meta_ads.campaign.set_daily_budget', { dailyBudget: 9 }), null);
    expect('findingIds' in action).toBe(false);
    expect(action.preconditionHash).toBeNull();
    expect(action.spendEffect).toBe('unknown');
    expect(action.spendDeltaPerDay).toBeNull();
    expect(action.platform).toBe('meta_ads');
  });

  it('has an id that is stable and depends on kind, target and params', () => {
    const base = draft('google_ads.campaign.set_daily_budget', { dailyBudget: 10 });
    const id = buildAction(base, { dailyBudget: 5 }).id;
    expect(buildAction({ ...base, rationale: 'Another reason entirely' }, null).id).toBe(id);
    expect(buildAction({ ...base, target: { ...base.target, name: 'Brand' } }, null).id).toBe(id);
    expect(buildAction({ ...base, params: { dailyBudget: 11 } }, { dailyBudget: 5 }).id).not.toBe(id);
    expect(buildAction({ ...base, target: { ...base.target, id: '124' } }, null).id).not.toBe(id);
    expect(buildAction({ ...base, kind: 'meta_ads.campaign.set_daily_budget' }, null).id).not.toBe(id);
  });

  it('throws unsupported for an unknown kind', () => {
    expect(() => buildAction({ ...draft('google_ads.ad.pause'), kind: 'nope' as ActionKind }, null)).toThrow(
      AutopilotError,
    );
  });
});

describe('planDigest', () => {
  const first = buildAction(draft('google_ads.campaign.set_daily_budget', { dailyBudget: 10 }), { dailyBudget: 5 });
  const second = buildAction(draft('google_ads.keyword.pause'), { status: 'ENABLED' });
  const base = { accountId: 'acc_1', platform: 'google_ads' as const, actions: [first, second] };
  const reference = planDigest(base);

  it('is stable for equal content', () => {
    expect(reference).toMatch(/^[0-9a-f]{64}$/);
    expect(planDigest({ ...base, actions: [{ ...first }, { ...second }] })).toBe(reference);
    expect(planDigest({ ...base, actions: [{ ...first, rationale: 'Reworded reason', status: 'applied' }, second] })).toBe(
      reference,
    );
    expect(planDigest({ ...base, actions: [{ ...first, before: { dailyBudget: 5 } }, second] })).toBe(reference);
  });

  it('changes with before, after, params, order, account and platform', () => {
    const variants = [
      { ...base, actions: [{ ...first, before: { dailyBudget: 6 } }, second] },
      { ...base, actions: [{ ...first, before: null }, second] },
      { ...base, actions: [{ ...first, after: { dailyBudget: 11 } }, second] },
      { ...base, actions: [{ ...first, params: { dailyBudget: 11 } }, second] },
      { ...base, actions: [first, { ...second, target: { ...second.target, id: '999' } }] },
      { ...base, actions: [second, first] },
      { ...base, actions: [first] },
      { ...base, accountId: 'acc_2' },
      { ...base, platform: 'meta_ads' as const },
    ];
    const digests = variants.map((variant) => planDigest(variant));
    for (const value of digests) expect(value).not.toBe(reference);
    expect(new Set(digests).size).toBe(variants.length);
  });
});
