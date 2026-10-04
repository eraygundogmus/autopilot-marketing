import { describe, expect, it } from 'vitest';

import type { Plan } from '../../src/core/types';
import {
  brandMatcher,
  fallbackClassifyTerms,
  fallbackGate,
  fallbackReviewCopy,
  fallbackVerifyClaims,
} from '../../src/judgment/fallback';

const business = 'We sell expense management software for small companies';

describe('fallbackClassifyTerms', () => {
  it('applies each rule and keeps the input order', () => {
    const terms = ['Ledgerly pricing', 'expense tracker', 'accounting jobs', 'red shoes'];
    const result = fallbackClassifyTerms({ business, brandTerms: ['ledgerly'], terms });
    expect(result).toEqual([
      { term: 'Ledgerly pricing', label: 'brand', confidence: 0.95, band: 'act', mode: 'fallback' },
      { term: 'expense tracker', label: 'relevant', confidence: 0.5, band: 'review', mode: 'fallback' },
      { term: 'accounting jobs', label: 'irrelevant', confidence: 0.6, band: 'review', mode: 'fallback' },
      { term: 'red shoes', label: 'unclear', confidence: 0.3, band: 'review', mode: 'fallback' },
    ]);
  });

  it('lets a brand match beat the junk list, and junk beat relevance', () => {
    const result = fallbackClassifyTerms({
      business,
      brandTerms: ['Ledgerly'],
      terms: ['ledgerly login', 'free expense software'],
    });
    expect(result.map((r) => r.label)).toEqual(['brand', 'irrelevant']);
  });

  it('matches a brand term only as a whole word or phrase', () => {
    const result = fallbackClassifyTerms({
      business,
      brandTerms: ['ace', 'Big  Co'],
      terms: ['free marketplace template download', 'ace pricing', 'big co reviews', 'bigco reviews', 'ACE-app'],
    });
    expect(result.map((r) => r.label)).toEqual(['irrelevant', 'brand', 'brand', 'unclear', 'brand']);
  });

  it('builds a brand matcher that matches nothing for an empty list', () => {
    expect(brandMatcher([])('anything')).toBe(false);
    expect(brandMatcher(['', '  '])('anything')).toBe(false);
    expect(brandMatcher(['c++'])('learn c++ fast')).toBe(true);
  });

  it('matches junk only as a whole word or phrase', () => {
    const result = fallbackClassifyTerms({
      business,
      brandTerms: [],
      terms: ['freedom planner', 'Log In page', 'blogin', 'expense report PDF', 'wikis'],
    });
    expect(result.map((r) => r.label)).toEqual(['unclear', 'irrelevant', 'unclear', 'irrelevant', 'unclear']);
  });

  it('ignores stop words, short words and empty brand terms', () => {
    const result = fallbackClassifyTerms({
      business: 'Tools that work with your team for tax',
      brandTerms: ['', '  '],
      terms: ['with your', 'tax', 'TEAM chat'],
    });
    expect(result.map((r) => r.label)).toEqual(['unclear', 'unclear', 'relevant']);
  });

  it('returns nothing for no terms', () => {
    expect(fallbackClassifyTerms({ business, brandTerms: ['x'], terms: [] })).toEqual([]);
  });
});

describe('fallbackVerifyClaims', () => {
  const evidence = { spend: 12345.5, clicks: 1200, ctr: '4.2%', rows: [7, 30] };

  it('verifies a claim whose numbers all occur in the evidence', () => {
    const [judgment] = fallbackVerifyClaims({ claims: ['1,200 clicks at 4.2% CTR'], evidence });
    expect(judgment).toEqual({
      claim: '1,200 clicks at 4.2% CTR',
      verdict: 'verified',
      confidence: 0.6,
      band: 'review',
      mode: 'fallback',
    });
  });

  it('marks a claim with a missing number unsupported', () => {
    const [judgment] = fallbackVerifyClaims({ claims: ['1,200 clicks cost 999'], evidence });
    expect(judgment).toMatchObject({ verdict: 'unsupported', confidence: 0.6, band: 'review' });
  });

  it('does not match a number inside a longer one', () => {
    const [judgment] = fallbackVerifyClaims({ claims: ['200 clicks'], evidence });
    expect(judgment?.verdict).toBe('unsupported');
  });

  it('marks a claim without numbers unsupported with low confidence', () => {
    const [judgment] = fallbackVerifyClaims({ claims: ['Spend went up a lot'], evidence });
    expect(judgment).toMatchObject({ verdict: 'unsupported', confidence: 0.3, band: 'review', mode: 'fallback' });
  });

  it('removes thousands separators on both sides', () => {
    const result = fallbackVerifyClaims({
      claims: ['Spend was 12,345.50', 'Revenue was 2500000', 'Revenue was 2,500,001'],
      evidence: 'Spend 12345.5 and revenue 2,500,000 this month',
    });
    expect(result.map((r) => r.verdict)).toEqual(['verified', 'verified', 'unsupported']);
  });

  it('never returns contradicted and keeps the order', () => {
    const claims = ['a 1', 'b 7', 'c', 'd 30'];
    const result = fallbackVerifyClaims({ claims, evidence });
    expect(result.map((r) => r.claim)).toEqual(claims);
    expect(result.map((r) => r.verdict)).toEqual(['unsupported', 'verified', 'unsupported', 'verified']);
    expect(result.every((r) => r.band === 'review' && r.mode === 'fallback')).toBe(true);
  });
});

describe('fallbackReviewCopy', () => {
  const review = (body: string, extra: { headline?: string; landingText?: string } = {}) => {
    const [judgment] = fallbackReviewCopy({
      platform: 'google' as never,
      business,
      variants: [{ id: 'v1', body, ...extra }],
    });
    if (!judgment) throw new Error('missing judgment');
    return judgment;
  };

  it('returns a clean judgment for plain copy', () => {
    expect(review('Track team expenses in one place.', { headline: 'Expense software' })).toEqual({
      id: 'v1',
      policyRisk: 0,
      clarity: 0.5,
      messageMatch: null,
      flags: [],
      band: 'review',
      mode: 'fallback',
    });
  });

  it('flags all caps only from two upper-case words of 4+ letters', () => {
    expect(review('SAVE MONEY today').flags).toEqual(['all_caps']);
    expect(review('SAVE money today').flags).toEqual([]);
    expect(review('GET IT NOW for ROI').flags).toEqual([]);
    expect(review('money today', { headline: 'HUGE SALE' }).flags).toEqual(['all_caps']);
  });

  it('flags excessive punctuation', () => {
    expect(review('Hurry!! Ends soon').flags).toEqual(['excessive_punctuation']);
    expect(review('Really?! Yes').flags).toEqual(['excessive_punctuation']);
    expect(review('One! Two! Three! Go').flags).toEqual(['excessive_punctuation']);
    expect(review('One! Two! Go').flags).toEqual([]);
  });

  it('flags each superlative as a whole word or phrase', () => {
    for (const body of [
      'The Best tool',
      'Rated #1 by users',
      'The number one choice',
      'Results guaranteed',
      'We guarantee it',
      'Cheapest plans',
      '100% accurate',
      'A miracle cure',
      'Try it risk-free',
    ]) {
      expect(review(body).flags, body).toEqual(['superlative_claim']);
    }
    for (const body of ['Bestseller list', 'Ranked #12', 'Up to 1100% more', 'Guarantees apply']) {
      expect(review(body).flags, body).toEqual([]);
    }
  });

  it('scales policy risk with the number of flags', () => {
    const judgment = review('BEST DEAL EVER!! guaranteed');
    expect(judgment.flags).toEqual(['all_caps', 'excessive_punctuation', 'superlative_claim']);
    expect(judgment.policyRisk).toBe(0.75);
    expect(review('Hurry!! now').policyRisk).toBe(0.25);
  });

  it('computes message match as the Jaccard overlap of 4+ letter words', () => {
    // copy: expense, software, teams; landing: expense, software, small, companies -> 2 / 5
    expect(review('for teams', { headline: 'Expense Software', landingText: 'expense software for small companies' }).messageMatch).toBe(0.4);
    // 1 shared of 3 -> 0.33
    expect(review('fast invoices', { landingText: 'Invoices done by us' }).messageMatch).toBe(0.33);
    expect(review('fast invoices', { landingText: '' }).messageMatch).toBe(0);
    expect(review('fast invoices').messageMatch).toBeNull();
  });

  it('returns one judgment per variant in order', () => {
    const result = fallbackReviewCopy({
      platform: 'meta' as never,
      business,
      variants: [
        { id: 'a', body: 'one' },
        { id: 'b', body: 'two' },
      ],
    });
    expect(result.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('fallbackGate', () => {
  const plan = {
    digest: 'abc123',
    actions: [{ id: 'act_1' }, { id: 'act_2' }],
  } as unknown as Plan;
  const now = new Date('2026-01-02T03:04:05.000Z');

  it('abstains on every action and never allows', () => {
    const decision = fallbackGate(plan, now);
    expect(decision).toEqual({
      planDigest: 'abc123',
      mode: 'fallback',
      verdict: 'abstain',
      actions: [
        { actionId: 'act_1', verdict: 'abstain', confidence: 0, band: 'review' },
        { actionId: 'act_2', verdict: 'abstain', confidence: 0, band: 'review' },
      ],
      evaluatedAt: '2026-01-02T03:04:05.000Z',
    });
    expect(decision.actions.some((a) => a.verdict === 'allow')).toBe(false);
  });

  it('abstains on an empty plan too', () => {
    const decision = fallbackGate({ ...plan, actions: [] }, now);
    expect(decision.verdict).toBe('abstain');
    expect(decision.actions).toEqual([]);
  });
});
