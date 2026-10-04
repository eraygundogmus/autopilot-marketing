import { credentialUnavailable } from '../core/env';
import { canonicalJson, sha256 } from '../core/ids';
import type { Answer, Env, JudgmentConfig, JudgmentUsage, JsonValue, Question, TypeSafeClient } from '../core/types';
import { chargeMeter } from './usage';

export const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';

export interface TypeSafeOptions {
  /** Reads TYPESAFE_API_KEY (alias TYPESAFE_AI_KEY). */
  env: Env;
  config: JudgmentConfig;
  fetch?: typeof fetch;
  /** Default 5. */
  maxAttempts?: number;
  /** Default 60000. */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Answers keyed by sha256 of model, state and questions; a hit costs nothing. */
  cache?: {
    get(key: string): Record<string, Answer> | undefined;
    set(key: string, answers: Record<string, Answer>): void;
  };
}

const RETRY_STATUSES = new Set([429, 502, 503, 504, 529]);
const MAX_RETRY_AFTER_SECONDS = 30;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function inUnit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function numberMap(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) return null;
    out[key] = entry;
  }
  return out;
}

function maxOf(probabilities: Record<string, number>): number {
  const values = Object.values(probabilities);
  return values.length === 0 ? 0 : Math.min(1, Math.max(0, ...values));
}

function parseAnswer(question: Question, raw: unknown): Answer | null {
  if (!isRecord(raw) || raw.type !== question.type) return null;
  if (question.type === 'noul') {
    return inUnit(raw.noul) ? { type: 'noul', noul: raw.noul } : null;
  }
  const probabilities = numberMap(raw.probabilities);
  if (probabilities === null) return null;
  if (raw.confidence !== undefined && !inUnit(raw.confidence)) return null;
  if (question.type === 'choice') {
    const picked = raw.choice;
    if (typeof picked !== 'string' || !Object.hasOwn(question.criteria, picked)) return null;
    const confidence = inUnit(raw.confidence) ? raw.confidence : Math.min(1, Math.max(0, probabilities[picked] ?? 0));
    return { type: 'choice', choice: picked, probabilities, confidence };
  }
  const levels = question.criteria.length;
  const value = raw.score;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > levels - 1) return null;
  const legend: Record<string, string> = {};
  if (isRecord(raw.legend) && Object.values(raw.legend).every((entry) => typeof entry === 'string')) {
    for (const [key, entry] of Object.entries(raw.legend)) legend[key] = String(entry);
  } else {
    question.criteria.forEach((level, index) => {
      legend[String(index)] = typeof level === 'string' ? level : JSON.stringify(level);
    });
  }
  const confidence = inUnit(raw.confidence) ? raw.confidence : maxOf(probabilities);
  return { type: 'score', score: value, legend, probabilities, confidence };
}

function parseAnswers(questions: Record<string, Question>, raw: unknown): Record<string, Answer> | null {
  if (!isRecord(raw)) return null;
  const out: Record<string, Answer> = {};
  for (const [id, question] of Object.entries(questions)) {
    if (!Object.hasOwn(raw, id)) return null;
    const answer = parseAnswer(question, raw[id]);
    if (answer === null) return null;
    out[id] = answer;
  }
  return out;
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Milliseconds to wait before the attempt after `attempt` (1-based). */
function retryDelayMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter !== null && retryAfter.trim() !== '') {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, MAX_RETRY_AFTER_SECONDS) * 1000;
  }
  return 2 ** (attempt - 1) * 1000;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * TYPESAFE_API_KEY, or its alias TYPESAFE_AI_KEY. A name that is kept in the credential store but
 * cannot be read is missing: the other name may hold a stale key and is not used in its place.
 */
function apiKey(env: Env): string {
  if (credentialUnavailable(env, 'TYPESAFE_API_KEY') || credentialUnavailable(env, 'TYPESAFE_AI_KEY')) return '';
  return env.TYPESAFE_API_KEY || env.TYPESAFE_AI_KEY || '';
}

export function createTypeSafeClient(options: TypeSafeOptions): TypeSafeClient {
  const { config } = options;
  const key = apiKey(options.env);
  const available = key.length > 0;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
  const timeoutMs = options.timeoutMs ?? 60000;
  const sleep = options.sleep ?? defaultSleep;
  const totals = { requests: 0, failed: 0, skipped: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  // Answers handed back to the caller, from the cache or from a request; never part of JudgmentUsage.
  let answered = 0;
  let model: string | null = null;

  /**
   * `parsed` is the 200 body, or null when the request failed for good. `billedAttempts` counts
   * every attempt answered with HTTP 200, readable body or not; 429 and 5xx are not billed.
   */
  async function send(body: string): Promise<{ parsed: unknown; readable: boolean; billedAttempts: number }> {
    const doFetch = options.fetch ?? globalThis.fetch;
    let billedAttempts = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let retryAfter: string | null = null;
      try {
        const response = await doFetch(TYPESAFE_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        });
        if (response.status === 200) {
          billedAttempts += 1;
          const parsed: unknown = await response.json();
          return { parsed, readable: true, billedAttempts };
        }
        if (!RETRY_STATUSES.has(response.status)) return { parsed: null, readable: false, billedAttempts };
        retryAfter = response.headers.get('retry-after');
      } catch {
        // Network error, timeout or unreadable body: retried like a 5xx.
      } finally {
        clearTimeout(timer);
      }
      if (attempt < maxAttempts) await sleep(retryDelayMs(attempt, retryAfter));
    }
    return { parsed: null, readable: false, billedAttempts };
  }

  async function ask(state: JsonValue, questions: Record<string, Question>): Promise<Record<string, Answer> | null> {
    if (!available) return null;
    try {
      const cacheKey = sha256(canonicalJson({ model: config.model, state, questions }));
      const hit = options.cache?.get(cacheKey);
      if (hit !== undefined) {
        answered += 1;
        chargeMeter({ answered: 1 });
        return hit;
      }

      const body = JSON.stringify({ state, model: config.model, questions });
      const estimate = Math.ceil(body.length / 3);
      if (totals.costUsd + (estimate / 1e6) * config.usdPerMillionInputTokens > config.budgetUsd) {
        totals.skipped += 1;
        chargeMeter({ skipped: 1 });
        return null;
      }

      const { parsed, readable, billedAttempts } = await send(body);
      // Every 200 response is charged before its answers are validated, so a rejected or
      // unreadable response still counts against the budget.
      const reported = isRecord(parsed) && isRecord(parsed.usage) ? parsed.usage : {};
      const unreadable = readable ? billedAttempts - 1 : billedAttempts;
      // Counted per request, not as a difference of the totals: other requests run while this one waits.
      let inputTokens = unreadable * estimate;
      let outputTokens = 0;
      if (readable) {
        inputTokens += tokenCount(reported.input_tokens) ?? estimate;
        outputTokens = tokenCount(reported.output_tokens) ?? 0;
      }
      totals.inputTokens += inputTokens;
      totals.outputTokens += outputTokens;
      totals.costUsd = (totals.inputTokens / 1e6) * config.usdPerMillionInputTokens;
      chargeMeter({ inputTokens, outputTokens, costUsd: (inputTokens / 1e6) * config.usdPerMillionInputTokens });

      const answers = isRecord(parsed) ? parseAnswers(questions, parsed.answers) : null;
      if (!isRecord(parsed) || answers === null) {
        totals.failed += 1;
        chargeMeter({ failed: 1 });
        return null;
      }

      totals.requests += 1;
      answered += 1;
      if (typeof parsed.model === 'string' && parsed.model !== '') model = parsed.model;
      chargeMeter({ requests: 1, answered: 1, model });
      options.cache?.set(cacheKey, answers);
      return answers;
    } catch {
      totals.failed += 1;
      chargeMeter({ failed: 1 });
      return null;
    }
  }

  /** `mode` is 'jev' only once a model answer has been served; a key alone is not enough. */
  function usage(): JudgmentUsage {
    return { mode: available && answered > 0 ? 'jev' : 'fallback', model, ...totals };
  }

  return { available, ask, usage };
}
