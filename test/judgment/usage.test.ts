import { describe, expect, it } from 'vitest';
import type { JudgmentConfig, JsonObject, LedgerEntry, Question, Runtime } from '../../src/core/types';
import { noul } from '../../src/judgment/questions';
import { createTypeSafeClient } from '../../src/judgment/typesafe';
import { meterJudgment } from '../../src/judgment/usage';
import { auditSnapshot, judgeTerms } from '../../src/ops/audit';
import { takeSnapshot } from '../../src/ops/data';
import { tempRuntime } from '../helpers/runtime';

const config: JudgmentConfig = {
  model: 'jev',
  budgetUsd: 1,
  actThreshold: 0.8,
  gateThreshold: 0.9,
  usdPerMillionInputTokens: 2,
};

/** Answers every question of a request with a valid answer; `input_tokens` is the length of the request body. */
function jevFetch(delayMs: (body: string) => number = () => 0): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = String(init?.body ?? '');
    calls.push(body);
    const wait = delayMs(body);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    const questions = (JSON.parse(body) as { questions: Record<string, Question> }).questions;
    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(questions)) {
      if (question.type === 'noul') {
        answers[id] = { type: 'noul', noul: 0.95 };
      } else if (question.type === 'choice') {
        const picked = Object.keys(question.criteria)[0] ?? '';
        answers[id] = { type: 'choice', choice: picked, probabilities: { [picked]: 0.95 }, confidence: 0.95 };
      } else {
        answers[id] = { type: 'score', score: 0, probabilities: { '0': 0.95 }, confidence: 0.95 };
      }
    }
    return new Response(
      JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: body.length, output_tokens: 1 } }),
      { status: 200 },
    );
  };
  return { fetch: impl as typeof fetch, calls };
}

const question: Record<string, Question> = { ok: noul('Is it fine?') };

function memoryCache(): NonNullable<Parameters<typeof createTypeSafeClient>[0]['cache']> {
  const entries = new Map<string, Parameters<NonNullable<Parameters<typeof createTypeSafeClient>[0]['cache']>['set']>[1]>();
  return { get: (key) => entries.get(key), set: (key, answers) => void entries.set(key, answers) };
}

describe('meterJudgment', () => {
  it('counts only the requests made inside it, while the client keeps its running total', async () => {
    const { fetch, calls } = jevFetch();
    const client = createTypeSafeClient({ env: { TYPESAFE_API_KEY: 'k' }, config, fetch });

    const first = await meterJudgment(() => client.ask({ term: 'a' }, question));
    const second = await meterJudgment(() => client.ask({ term: 'a much longer state than the first' }, question));

    expect(first.usage).toMatchObject({ mode: 'jev', model: 'jev-1.13.0', requests: 1, failed: 0 });
    expect(first.usage.inputTokens).toBe(calls[0]?.length);
    expect(second.usage.requests).toBe(1);
    expect(second.usage.inputTokens).toBe(calls[1]?.length);
    expect(second.usage.costUsd).toBeCloseTo((second.usage.inputTokens / 1e6) * 2, 12);
    expect(client.usage().requests).toBe(2);
    expect(client.usage().inputTokens).toBe(first.usage.inputTokens + second.usage.inputTokens);
  });

  it('keeps two operations apart when they run at the same time', async () => {
    const { fetch } = jevFetch((body) => (body.includes('slow') ? 20 : 0));
    const client = createTypeSafeClient({ env: { TYPESAFE_API_KEY: 'k' }, config, fetch });

    const [slow, fast] = await Promise.all([
      meterJudgment(async () => {
        await client.ask({ term: 'slow one' }, question);
        return client.ask({ term: 'slow two' }, question);
      }),
      meterJudgment(() => client.ask({ term: 'quick' }, question)),
    ]);

    expect(slow.usage.requests).toBe(2);
    expect(fast.usage.requests).toBe(1);
    expect(slow.usage.inputTokens + fast.usage.inputTokens).toBe(client.usage().inputTokens);
  });

  it('adds a nested operation to the one around it', async () => {
    const { fetch } = jevFetch();
    const client = createTypeSafeClient({ env: { TYPESAFE_API_KEY: 'k' }, config, fetch });

    const outer = await meterJudgment(async () => {
      await client.ask({ term: 'outer' }, question);
      return meterJudgment(() => client.ask({ term: 'inner' }, question));
    });

    expect(outer.value.usage.requests).toBe(1);
    expect(outer.usage.requests).toBe(2);
  });

  it('reports a cached answer as a model answer that cost nothing, and no key as the fallback', async () => {
    const { fetch, calls } = jevFetch();
    const client = createTypeSafeClient({ env: { TYPESAFE_API_KEY: 'k' }, config, fetch, cache: memoryCache() });
    await client.ask({ term: 'a' }, question);

    const cached = await meterJudgment(() => client.ask({ term: 'a' }, question));
    expect(calls).toHaveLength(1);
    expect(cached.value).not.toBeNull();
    expect(cached.usage).toMatchObject({ mode: 'jev', requests: 0, inputTokens: 0, costUsd: 0 });

    const keyless = createTypeSafeClient({ env: {}, config, fetch });
    const none = await meterJudgment(() => keyless.ask({ term: 'a' }, question));
    expect(none.value).toBeNull();
    expect(none.usage).toMatchObject({ mode: 'fallback', model: null, requests: 0, costUsd: 0 });
  });

  it('charges a billed reply whose answers are rejected to the operation as a failure', async () => {
    const impl = async (): Promise<Response> =>
      new Response(JSON.stringify({ model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 40 } }), { status: 200 });
    const client = createTypeSafeClient({ env: { TYPESAFE_API_KEY: 'k' }, config, fetch: impl as typeof fetch });

    const rejected = await meterJudgment(() => client.ask({ term: 'a' }, question));

    expect(rejected.value).toBeNull();
    expect(rejected.usage).toMatchObject({ mode: 'fallback', requests: 0, failed: 1, inputTokens: 40 });
    expect(rejected.usage.costUsd).toBeCloseTo((40 / 1e6) * 2, 12);
  });
});

function usageEntries(runtime: Runtime): LedgerEntry[] {
  return runtime.ledger.read({}).filter((entry) => entry.event === 'judgment.usage');
}

function costOf(entry: LedgerEntry): number {
  return Number((entry.data as JsonObject).costUsd);
}

describe('judgment usage of an operation', () => {
  const now = () => new Date('2026-10-04T10:00:00Z');

  it('reports what each judge_terms call used and writes it to the ledger', async () => {
    const { fetch } = jevFetch();
    const { runtime } = tempRuntime({ now, fetch, env: { TYPESAFE_API_KEY: 'k' } });

    const first = await judgeTerms(runtime, { accountId: 'demo-google', terms: ['free tent repair'] });
    const second = await judgeTerms(runtime, { accountId: 'demo-google', terms: ['hiking boots', 'camping stove'] });

    expect(first.usage).toMatchObject({ mode: 'jev', requests: 1 });
    expect(second.usage).toMatchObject({ mode: 'jev', requests: 1 });
    expect(first.usage.costUsd).toBeGreaterThan(0);

    const logged = usageEntries(runtime);
    expect(logged).toHaveLength(2);
    expect(logged.map((entry) => entry.accountId)).toEqual(['demo-google', 'demo-google']);
    expect(logged.map((entry) => (entry.data as JsonObject).operation)).toEqual(['judge_terms', 'judge_terms']);
    expect(logged.map(costOf).sort()).toEqual([first.usage.costUsd, second.usage.costUsd].sort());
    expect(costOf(logged[0]!) + costOf(logged[1]!)).toBeCloseTo(runtime.judge.usage().costUsd, 12);
    expect(runtime.ledger.verify().ok).toBe(true);

    // The same question again is answered from the cache: a model answer, no request, nothing to log.
    const again = await judgeTerms(runtime, { accountId: 'demo-google', terms: ['free tent repair'] });
    expect(again.usage).toMatchObject({ mode: 'jev', requests: 0, costUsd: 0 });
    expect(usageEntries(runtime)).toHaveLength(2);
  });

  it('gives a second audit in the same process its own usage, not the running total', async () => {
    const { fetch } = jevFetch();
    const { runtime } = tempRuntime({ now, fetch, env: { TYPESAFE_API_KEY: 'k' } });
    const snapshot = await takeSnapshot(runtime, { accountId: 'demo-google' });

    const first = await auditSnapshot(runtime, { snapshotId: snapshot.id });
    const second = await auditSnapshot(runtime, { snapshotId: snapshot.id });

    expect(first.judgment.mode).toBe('jev');
    expect(first.judgment.requests).toBeGreaterThan(0);
    expect(second.judgment).toMatchObject({ mode: 'jev', requests: 0, costUsd: 0 });

    const audits = runtime.ledger.read({}).filter((entry) => entry.event === 'audit.run');
    expect(audits.map(costOf).sort()).toEqual([0, first.judgment.costUsd]);
    const logged = usageEntries(runtime);
    expect(logged).toHaveLength(1);
    expect((logged[0]!.data as JsonObject).operation).toBe('audit');
    expect(costOf(logged[0]!)).toBe(first.judgment.costUsd);
  });

  it('logs nothing without a key', async () => {
    const { runtime } = tempRuntime({ now });
    const result = await judgeTerms(runtime, { accountId: 'demo-google', terms: ['free tent repair'] });
    expect(result.usage).toMatchObject({ mode: 'fallback', requests: 0, costUsd: 0 });
    expect(usageEntries(runtime)).toHaveLength(0);
  });
});
