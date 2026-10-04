import type {
  ClaimJudgment,
  CopyJudgment,
  CopyVariant,
  GateDecision,
  JsonValue,
  Plan,
  Platform,
  TermJudgment,
} from '../core/types';

const IRRELEVANT_PHRASES = [
  'free',
  'job',
  'jobs',
  'career',
  'careers',
  'salary',
  'hiring',
  'internship',
  'login',
  'log in',
  'sign in',
  'download',
  'torrent',
  'crack',
  'wikipedia',
  'wiki',
  'definition',
  'meaning',
  'pdf',
  'template',
];

const SUPERLATIVE_PHRASES = [
  'best',
  '#1',
  'number one',
  'guaranteed',
  'guarantee',
  'cheapest',
  '100%',
  'miracle',
  'risk-free',
];

const STOP_WORDS = new Set([
  'about', 'above', 'after', 'again', 'also', 'among', 'been', 'before', 'being', 'below', 'between', 'both',
  'does', 'down', 'during', 'each', 'every', 'from', 'have', 'here', 'into', 'just', 'like', 'made', 'make',
  'many', 'more', 'most', 'much', 'near', 'only', 'other', 'over', 'same', 'some', 'such', 'than', 'that',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'under', 'very', 'want',
  'were', 'what', 'when', 'where', 'which', 'while', 'will', 'with', 'your', 'yours',
]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches any phrase as a whole word or phrase: not preceded or followed by a letter or digit. */
function phraseMatcher(phrases: string[]): RegExp {
  const alternatives = phrases
    .map((phrase) => phrase.split(/\s+/).map(escapeRegExp).join('\\s+'))
    .join('|');
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, 'iu');
}

/**
 * Tests a search term against the account's brand list on word or phrase boundaries, so a short
 * brand ('ace') never matches inside a longer word ('marketplace'). Blank brand terms are ignored
 * and an empty list matches nothing.
 */
export function brandMatcher(brandTerms: string[]): (term: string) => boolean {
  const brands = brandTerms.map((brand) => brand.trim()).filter((brand) => brand.length > 0);
  if (brands.length === 0) return () => false;
  const matcher = phraseMatcher(brands);
  return (term) => matcher.test(term);
}

const IRRELEVANT_RE = phraseMatcher(IRRELEVANT_PHRASES);
const SUPERLATIVE_RE = phraseMatcher(SUPERLATIVE_PHRASES);

function longWords(text: string): string[] {
  return text.match(/\p{L}{4,}/gu) ?? [];
}

function longWordSet(text: string): Set<string> {
  return new Set(longWords(text).map((word) => word.toLowerCase()));
}

/** Deterministic rules used when Jev is unavailable. Every result carries mode 'fallback'. */
export function fallbackClassifyTerms(input: { business: string; brandTerms: string[]; terms: string[] }): TermJudgment[] {
  const isBrand = brandMatcher(input.brandTerms);
  const businessWords = longWordSet(input.business);
  for (const word of STOP_WORDS) businessWords.delete(word);

  return input.terms.map((term): TermJudgment => {
    const lower = term.toLowerCase();
    if (isBrand(term)) {
      return { term, label: 'brand', confidence: 0.95, band: 'act', mode: 'fallback' };
    }
    if (IRRELEVANT_RE.test(lower)) {
      return { term, label: 'irrelevant', confidence: 0.6, band: 'review', mode: 'fallback' };
    }
    if (longWords(lower).some((word) => businessWords.has(word))) {
      return { term, label: 'relevant', confidence: 0.5, band: 'review', mode: 'fallback' };
    }
    return { term, label: 'unclear', confidence: 0.3, band: 'review', mode: 'fallback' };
  });
}

/**
 * Numbers in canonical form: thousands separators, a trailing % and insignificant zeros removed,
 * so '1,200.50', '1200.5' and '1200.5%' all compare equal.
 */
function extractNumbers(text: string): string[] {
  const matches = text.match(/(?<![\d.])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?/g) ?? [];
  return matches.map((raw) => {
    const plain = raw.replace(/,/g, '').replace(/%$/, '');
    const value = Number(plain);
    return Number.isFinite(value) ? String(value) : plain;
  });
}

export function fallbackVerifyClaims(input: { claims: string[]; evidence: JsonValue }): ClaimJudgment[] {
  const evidenceText = typeof input.evidence === 'string' ? input.evidence : JSON.stringify(input.evidence);
  const evidenceNumbers = new Set(extractNumbers(evidenceText));

  return input.claims.map((claim): ClaimJudgment => {
    const numbers = extractNumbers(claim);
    if (numbers.length === 0) {
      return { claim, verdict: 'unsupported', confidence: 0.3, band: 'review', mode: 'fallback' };
    }
    const verdict = numbers.every((value) => evidenceNumbers.has(value)) ? 'verified' : 'unsupported';
    return { claim, verdict, confidence: 0.6, band: 'review', mode: 'fallback' };
  });
}

function isUpperCase(word: string): boolean {
  return word === word.toUpperCase() && word !== word.toLowerCase();
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const word of a) {
    if (b.has(word)) shared += 1;
  }
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : Math.round((shared / union) * 100) / 100;
}

export function fallbackReviewCopy(input: { platform: Platform; business: string; variants: CopyVariant[] }): CopyJudgment[] {
  return input.variants.map((variant): CopyJudgment => {
    const text = `${variant.headline ?? ''} ${variant.body}`;
    const flags: string[] = [];
    if (longWords(text).filter(isUpperCase).length >= 2) flags.push('all_caps');
    const exclamations = text.split('!').length - 1;
    if (text.includes('!!') || text.includes('?!') || exclamations > 2) flags.push('excessive_punctuation');
    if (SUPERLATIVE_RE.test(text)) flags.push('superlative_claim');

    return {
      id: variant.id,
      policyRisk: Math.min(1, 0.25 * flags.length),
      clarity: 0.5,
      messageMatch: variant.landingText === undefined ? null : jaccard(longWordSet(text), longWordSet(variant.landingText)),
      flags,
      band: 'review',
      mode: 'fallback',
    };
  });
}

/** Never allows: every action abstains, so nothing is auto-applied without Jev. */
export function fallbackGate(plan: Plan, now: Date): GateDecision {
  return {
    planDigest: plan.digest,
    mode: 'fallback',
    verdict: 'abstain',
    actions: plan.actions.map((action) => ({ actionId: action.id, verdict: 'abstain', confidence: 0, band: 'review' })),
    evaluatedAt: now.toISOString(),
  };
}
