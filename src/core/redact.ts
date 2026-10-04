import type { Env } from './types';

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD)/i;
/** Shorter values would match ordinary words and numbers. */
const MIN_VALUE_LENGTH = 6;
const PARAMS = 'access_token|refresh_token|client_secret|api_key|password';
const BEARER = /\bBearer\s+\S+/gi;
const QUERY_PARAM = new RegExp(`\\b(${PARAMS})=[^&\\s]*`, 'gi');
const JSON_PARAM = new RegExp(`"(${PARAMS})"(\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'gi');

/**
 * Removes secrets from text bound for a log, an error or a tool result: values of environment
 * variables whose name contains KEY, TOKEN, SECRET or PASSWORD, bearer tokens, and
 * `access_token` / `client_secret` / `refresh_token` parameters.
 */
export function redact(text: string, env: Env = process.env): string {
  try {
    let out = String(text);
    const secrets: Array<[string, string]> = [];
    for (const [name, value] of Object.entries(env)) {
      if (typeof value === 'string' && value.length >= MIN_VALUE_LENGTH && SECRET_NAME.test(name)) {
        secrets.push([name, value]);
      }
    }
    // Longest first, so a secret that contains another is not left half-redacted.
    secrets.sort((a, b) => b[1].length - a[1].length);
    for (const [name, value] of secrets) out = out.split(value).join(`[redacted:${name}]`);
    out = out.replace(BEARER, 'Bearer [redacted]');
    out = out.replace(JSON_PARAM, '"$1"$2"[redacted]"');
    out = out.replace(QUERY_PARAM, '$1=[redacted]');
    return out;
  } catch {
    return '[redacted]';
  }
}
