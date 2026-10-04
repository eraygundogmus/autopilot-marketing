import type { Answer, Band, ChoiceQuestion, JsonValue, NoulQuestion, ScoreAnswer, ScoreQuestion } from '../core/types';

export function noul(instructions: JsonValue, criteria?: { true?: JsonValue; false?: JsonValue }): NoulQuestion {
  return criteria === undefined ? { type: 'noul', instructions } : { type: 'noul', instructions, criteria };
}

export function choice(instructions: JsonValue, criteria: Record<string, JsonValue>): ChoiceQuestion {
  return { type: 'choice', instructions, criteria };
}

export function score(instructions: JsonValue, levels: JsonValue[]): ScoreQuestion {
  return { type: 'score', instructions, criteria: levels };
}

function levelCount(answer: ScoreAnswer): number {
  const legend = Object.keys(answer.legend).length;
  return legend > 0 ? legend : Object.keys(answer.probabilities).length;
}

/**
 * noul: `act` when p >= threshold or p <= 1 - threshold. choice: `act` when confidence >= threshold.
 * score: `act` when at least `threshold` of the probability mass lies on one side of the midpoint.
 */
export function bandOf(answer: Answer, threshold: number): Band {
  if (answer.type === 'noul') {
    return answer.noul >= threshold || answer.noul <= 1 - threshold ? 'act' : 'review';
  }
  if (answer.type === 'choice') {
    return answer.confidence >= threshold ? 'act' : 'review';
  }
  const entries = Object.entries(answer.probabilities);
  const levels = levelCount(answer);
  if (entries.length === 0 || levels < 2) {
    return answer.confidence >= threshold ? 'act' : 'review';
  }
  let upper = 0;
  for (const [level, probability] of entries) {
    const index = Number(level);
    if (Number.isFinite(index) && index / (levels - 1) >= 0.5) upper += probability;
  }
  return Math.max(upper, 1 - upper) >= threshold ? 'act' : 'review';
}

/** Score position scaled to 0..1 (score / (levels - 1)). */
export function normalizedScore(answer: ScoreAnswer): number {
  const levels = Object.keys(answer.legend).length;
  return levels > 1 ? answer.score / (levels - 1) : 0;
}
