import { describe, expect, it } from 'vitest';
import type { Answer, JudgmentConfig, Question } from '../../src/core/types';
import { bandOf, choice, normalizedScore, noul, score } from '../../src/judgment/questions';
import { createTypeSafeClient, TYPESAFE_URL } from '../../src/judgment/typesafe';

const KEY = 'sk-secret-test-key-123';
const config: JudgmentConfig = {
  model: 'jev',
  budgetUsd: 1,
  actThreshold: 0.8,
  gateThreshold: 0.9,
  usdPerMillionInputTokens: 2,
};

interface Call {
  url: string;
  init: RequestInit | undefined;
}

type Step = (() => Response) | Error;

function fakeFetch(steps: Step[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step === undefined) throw new Error('no step');
    if (step instanceof Error) throw step;
    return step();
  };
  return { fetch: impl as typeof fetch, calls };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): () => Response {
  return () => new Response(JSON.stringify(body), { status, headers });
}

function fakeSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

const questions: Record<string, Question> = {
  relevant: noul('Is the term relevant?'),
  label: choice('Pick a label', { brand: null, competitor: 'another company' }),
  quality: score('Rate the copy', ['bad', 'ok', 'good']),
};

const goodAnswers = {
  relevant: { type: 'noul', noul: 0.93 },
  label: { type: 'choice', choice: 'brand', probabilities: { brand: 0.9, competitor: 0.1 }, confidence: 0.9 },
  quality: {
    type: 'score',
    score: 2,
    legend: { '0': 'bad', '1': 'ok', '2': 'good' },
    probabilities: { '0': 0.05, '1': 0.1, '2': 0.85 },
    confidence: 0.85,
  },
};

function ok(answers: unknown = goodAnswers, usage: unknown = { input_tokens: 500, output_tokens: 7 }): () => Response {
  return json({ model: 'jev-1.13.0', answers, ...(usage === null ? {} : { usage }) });
}

describe('question builders', () => {
  it('builds typed questions and omits absent noul criteria', () => {
    expect(noul('q')).toEqual({ type: 'noul', instructions: 'q' });
    expect('criteria' in noul('q')).toBe(false);
    expect(noul('q', { true: 'yes' })).toEqual({ type: 'noul', instructions: 'q', criteria: { true: 'yes' } });
    expect(choice('q', { a: null })).toEqual({ type: 'choice', instructions: 'q', criteria: { a: null } });
    expect(score('q', ['lo', 'hi'])).toEqual({ type: 'score', instructions: 'q', criteria: ['lo', 'hi'] });
  });
});

describe('bandOf', () => {
  it('noul acts on either decisive side', () => {
    expect(bandOf({ type: 'noul', noul: 0.8 }, 0.8)).toBe('act');
    expect(bandOf({ type: 'noul', noul: 0.1 }, 0.8)).toBe('act');
    expect(bandOf({ type: 'noul', noul: 0.79 }, 0.8)).toBe('review');
    expect(bandOf({ type: 'noul', noul: 0.3 }, 0.8)).toBe('review');
  });

  it('choice uses confidence', () => {
    const base = { type: 'choice', choice: 'a', probabilities: { a: 0.9, b: 0.1 } } as const;
    expect(bandOf({ ...base, confidence: 0.8 }, 0.8)).toBe('act');
    expect(bandOf({ ...base, confidence: 0.79 }, 0.8)).toBe('review');
  });

  it('score uses the probability mass on one side of the midpoint', () => {
    const legend = { '0': 'a', '1': 'b', '2': 'c', '3': 'd' };
    const high: Answer = {
      type: 'score',
      score: 3,
      legend,
      probabilities: { '0': 0.05, '1': 0.05, '2': 0.4, '3': 0.5 },
      confidence: 0.5,
    };
    const low: Answer = {
      type: 'score',
      score: 0,
      legend,
      probabilities: { '0': 0.6, '1': 0.3, '2': 0.05, '3': 0.05 },
      confidence: 0.6,
    };
    const split: Answer = {
      type: 'score',
      score: 1,
      legend,
      probabilities: { '0': 0.1, '1': 0.4, '2': 0.4, '3': 0.1 },
      confidence: 0.95,
    };
    expect(bandOf(high, 0.8)).toBe('act');
    expect(bandOf(low, 0.8)).toBe('act');
    expect(bandOf(split, 0.8)).toBe('review');
  });

  it('score falls back to confidence without probabilities', () => {
    const base = { type: 'score', score: 1, legend: { '0': 'a', '1': 'b' }, probabilities: {} } as const;
    expect(bandOf({ ...base, confidence: 0.9 }, 0.8)).toBe('act');
    expect(bandOf({ ...base, confidence: 0.5 }, 0.8)).toBe('review');
  });

  it('normalizes the score to 0..1', () => {
    const base = { type: 'score', probabilities: {}, confidence: 1 } as const;
    expect(normalizedScore({ ...base, score: 1, legend: { '0': 'a', '1': 'b', '2': 'c' } })).toBe(0.5);
    expect(normalizedScore({ ...base, score: 2, legend: { '0': 'a', '1': 'b', '2': 'c' } })).toBe(1);
    expect(normalizedScore({ ...base, score: 0, legend: { '0': 'a' } })).toBe(0);
  });
});

describe('createTypeSafeClient', () => {
  it('sends one request and records usage on success', async () => {
    const { fetch, calls } = fakeFetch([ok()]);
    const client = createTypeSafeClient({ env: { TYPESAFE_API_KEY: KEY }, config, fetch });
    expect(client.available).toBe(true);
    const answers = await client.ask({ term: 'shoes' }, questions);
    expect(answers).toEqual(goodAnswers);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(TYPESAFE_URL);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toEqual({ Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ state: { term: 'shoes' }, model: 'jev', questions });
    expect(client.usage()).toEqual({
      mode: 'jev',
      model: 'jev-1.13.0',
      requests: 1,
      failed: 0,
      skipped: 0,
      inputTokens: 500,
      outputTokens: 7,
      costUsd: 0.001,
    });
  });

  it('accepts the alias key and estimates tokens when usage is missing', async () => {
    const { fetch, calls } = fakeFetch([ok(goodAnswers, null)]);
    const client = createTypeSafeClient({ env: { TYPESAFE_API_KEY: '', TYPESAFE_AI_KEY: KEY }, config, fetch });
    expect(await client.ask('s', questions)).not.toBeNull();
    const estimate = Math.ceil(String(calls[0]?.init?.body).length / 3);
    expect(client.usage().inputTokens).toBe(estimate);
    expect(client.usage().outputTokens).toBe(0);
  });

  it('returns null without calling fetch when the key is missing', async () => {
    const { fetch, calls } = fakeFetch([ok()]);
    const client = createTypeSafeClient({ env: {}, config, fetch });
    expect(client.available).toBe(false);
    expect(await client.ask('s', questions)).toBeNull();
    expect(calls).toHaveLength(0);
    expect(client.usage()).toMatchObject({ mode: 'fallback', model: null, requests: 0, failed: 0, skipped: 0 });
  });

  it('does not retry a 401 and counts it as failed', async () => {
    const { fetch, calls } = fakeFetch([json({ error: `bad key ${KEY}` }, 401)]);
    const { sleep, waits } = fakeSleep();
    const client = createTypeSafeClient({ env: { TYPESAFE_API_KEY: KEY }, config, fetch, sleep });
    expect(await client.ask('s', questions)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(client.usage()).toMatchObject({ requests: 0, failed: 1 });
  });

  it('waits the Retry-After header after a 429, then succeeds', async () => {
    const { fetch, calls } = fakeFetch([json({}, 429, { 'Retry-After': '7' }), ok()]);
    const { sleep, waits } = fakeSleep();
    const client = createTypeSafeClient({ env: { TYPESAFE_API_KEY: KEY }, config, fetch, sleep });
    expect(await client.ask('s', questions)).toEqual(goodAnswers);
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([7000]);
    expect(client.usage()).toMatchObject({ requests: 1, failed: 0 });
  });

  it('caps Retry-After at 30 seconds', async () => {
    const { fetch } = fakeFetch([json({}, 429, { 'Retry-After': '600' }), ok()]);
    const { sleep, waits } = fakeSleep();
    const client = createTypeSafeClient({ env: { TYPESAFE_API_KEY: KEY }, config, fetch, sleep });
    await client.ask('s', questions);
    expect(waits).toEqual([30000]);
  });

  it('gives up after maxAttempts of 529 with exponential backoff', async () => {
    const { fetch, calls } = fakeFetch([json({}, 529)]);
    const { sleep, waits } = fakeSleep();
    const client = createTypeSafeClient({ env: { TYPESAFE_API_KEY: KEY }, config, fetch, sleep });
    expect(await client.ask('s', questions)).toBeNull();
    expect(calls).toHaveLength(5);
    expect(waits).toEqual([1000, 2000, 4000, 8000]);
    expect(client.usage()).toMatchObject({ requests: 0, failed: 1 });
  });

  it('retries a network error and never surfaces the key', async () => {
    const { fetch, calls } = fakeFetch([new Error(`connect failed for Bearer ${KEY}`)]);
    const { sleep } = fakeSleep();
    const client = createTypeSafeClient({ env: { TYPESAFE_API_KEY: KEY }, config, fetch, sleep, maxAttempts: 3 });
    let thrown: unknown = null;
    let result: unknown = null;
    try {
      result = await client.ask('s', questions);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeNull();
    expect(result).toBeNull();
    expect(calls).toHaveLength(3);
    expect(JSON.stringify(client.usage())).not.toContain(KEY);
    expect(JSON.stringify(client)).not.toContain(KEY);
  });

  it('does not put the key in returned answers', async () => {
    const { fetch } = fakeFetch([ok()]);
    const client = createTypeSafeClient({ env: { TYPESAFE_API_KEY: KEY }, config, fetch });
    expect(JSON.stringify(await client.ask('s', questions))).not.toContain(KEY);
  });

  it.each([
    ['choice outside the options', { ...goodAnswers, label: { ...goodAnswers.label, choice: 'other' } }],
    ['noul out of range', { ...goodAnswers, relevant: { type: 'noul', noul: 1.2 } }],
    ['missing id', { relevant: goodAnswers.relevant, label: goodAnswers.label }],
    ['wrong type', { ...goodAnswers, relevant: goodAnswers.label }],
    ['score above the top level', { ...goodAnswers, quality: { ...goodAnswers.quality, score: 3 } }],
    ['confidence out of range', { ...goodAnswers, label: { ...goodAnswers.label, confidence: 1.5 } }],
    ['non-numeric probabilities', { ...goodAnswers, label: { ...goodAnswers.label, probabilities: { brand: 'x' } } }],
  ])('rejects invalid answers: %s', async (_name, answers) => {
    const { fetch, calls } = fakeFetch([ok(answers)]);
    const client = createTypeSafeClient({ env: { TYPESAFE_API_KEY: KEY }, config, fetch });
    expect(await client.ask('s', questions)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(client.usage()).toMatchObject({ requests: 0, failed: 1, inputTokens: 500, outputTokens: 7, costUsd: 0.001 });
  });

  it('rejects a 200 body that is not JSON', async () => {
    const { fetch } = fakeFetch([() => new Response('<html>', { status: 200 })]);
    const { sleep } = fakeSleep();
    const client = createTypeSafeClient({ env: { TYPESAFE_API_KEY: KEY }, config, fetch, sleep, maxAttempts: 1 });
    expect(await client.ask('s', questions)).toBeNull();
    expect(client.usage().failed).toBe(1);
  });

  it('skips the request when the budget would be exceeded', async () => {
    const { fetch, calls } = fakeFetch([ok()]);
    const client = createTypeSafeClient({
      env: { TYPESAFE_API_KEY: KEY },
      config: { ...config, budgetUsd: 0.00001 },
      fetch,
    });
    expect(await client.ask('s', questions)).toBeNull();
    expect(calls).toHaveLength(0);
    expect(client.usage()).toMatchObject({ requests: 0, failed: 0, skipped: 1, costUsd: 0 });
  });

  it('skips once earlier spend has used the budget', async () => {
    const { fetch, calls } = fakeFetch([ok(goodAnswers, { input_tokens: 400000, output_tokens: 1 })]);
    const client = createTypeSafeClient({ env: { TYPESAFE_API_KEY: KEY }, config: { ...config, budgetUsd: 0.8 }, fetch });
    expect(await client.ask('first', questions)).not.toBeNull();
    expect(client.usage().costUsd).toBeCloseTo(0.8, 10);
    expect(await client.ask('second', questions)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(client.usage()).toMatchObject({ requests: 1, skipped: 1 });
  });

  it('serves a repeated question from the cache without a second request', async () => {
    const { fetch, calls } = fakeFetch([ok()]);
    const store = new Map<string, Record<string, Answer>>();
    const cache = {
      get: (key: string) => store.get(key),
      set: (key: string, answers: Record<string, Answer>) => {
        store.set(key, answers);
      },
    };
    const client = createTypeSafeClient({ env: { TYPESAFE_API_KEY: KEY }, config, fetch, cache });
    const first = await client.ask({ b: 1, a: 2 }, questions);
    const second = await client.ask({ a: 2, b: 1 }, questions);
    expect(second).toEqual(first);
    expect(calls).toHaveLength(1);
    expect(store.size).toBe(1);
    expect([...store.keys()][0]).toMatch(/^[0-9a-f]{64}$/);
    expect(client.usage()).toMatchObject({ requests: 1, inputTokens: 500 });
  });

  it('charges every 200 response whose body is unreadable and stops at the budget', async () => {
    const { fetch, calls } = fakeFetch([() => new Response('<html>', { status: 200 })]);
    const { sleep } = fakeSleep();
    const client = createTypeSafeClient({ env: { TYPESAFE_API_KEY: KEY }, config, fetch, sleep, maxAttempts: 3 });
    expect(await client.ask('s', questions)).toBeNull();
    expect(calls).toHaveLength(3);
    const estimate = Math.ceil(String(calls[0]?.init?.body).length / 3);
    expect(client.usage()).toMatchObject({ requests: 0, failed: 1, inputTokens: estimate * 3 });
    expect(client.usage().costUsd).toBeCloseTo(((estimate * 3) / 1e6) * 2, 12);
  });

  it('does not charge attempts that were answered with 429, 5xx or 401', async () => {
    const { fetch } = fakeFetch([json({}, 529)]);
    const { sleep } = fakeSleep();
    const client = createTypeSafeClient({ env: { TYPESAFE_API_KEY: KEY }, config, fetch, sleep });
    await client.ask('s', questions);
    expect(client.usage()).toMatchObject({ failed: 1, inputTokens: 0, costUsd: 0 });
  });

  it('counts rejected responses against the budget', async () => {
    const bad = { ...goodAnswers, label: { ...goodAnswers.label, choice: 'other' } };
    const { fetch, calls } = fakeFetch([ok(bad, { input_tokens: 400000, output_tokens: 1 })]);
    const client = createTypeSafeClient({ env: { TYPESAFE_API_KEY: KEY }, config: { ...config, budgetUsd: 0.8 }, fetch });
    expect(await client.ask('first', questions)).toBeNull();
    expect(client.usage().costUsd).toBeCloseTo(0.8, 10);
    expect(await client.ask('second', questions)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(client.usage()).toMatchObject({ requests: 0, failed: 1, skipped: 1 });
  });

  it('reports mode fallback when a key is set but no answer was served', async () => {
    const { fetch } = fakeFetch([json({ error: 'revoked' }, 401)]);
    const client = createTypeSafeClient({ env: { TYPESAFE_API_KEY: KEY }, config, fetch });
    expect(client.usage().mode).toBe('fallback');
    expect(await client.ask('s', questions)).toBeNull();
    expect(client.available).toBe(true);
    expect(client.usage()).toMatchObject({ mode: 'fallback', requests: 0, failed: 1 });
  });

  it('reports mode jev for answers served only from the cache', async () => {
    const { fetch, calls } = fakeFetch([ok()]);
    const cache = { get: () => goodAnswers as Record<string, Answer>, set: () => {} };
    const client = createTypeSafeClient({ env: { TYPESAFE_API_KEY: KEY }, config, fetch, cache });
    expect(await client.ask('s', questions)).toEqual(goodAnswers);
    expect(calls).toHaveLength(0);
    expect(client.usage()).toMatchObject({ mode: 'jev', requests: 0 });
  });
});
