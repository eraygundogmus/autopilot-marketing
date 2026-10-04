import { AutopilotError } from '../core/errors';
import { redact } from '../core/redact';
import type { ConnectorDeps, DiagnosticCheck } from '../core/types';
import { GA4_SCOPE, SEARCH_CONSOLE_SCOPE, getGoogleAccessToken, googleAuthMissing } from './google-auth';
import { mauticAuthMissing, mauticRequest } from './mautic-read';

interface Outcome {
  status: 'ok' | 'fail' | 'unknown';
  detail: string;
  fix?: string;
}

interface Step {
  id: string;
  label: string;
  run: () => Promise<Outcome> | Outcome;
}

/** What a failed call offers for classification: the HTTP status, and the response body or the message. */
interface Evidence {
  status: number | undefined;
  text: string;
}

const SKIPPED_DETAIL = 'not run: an earlier check failed';
const READ_ONLY_NOTE = 'Read access works; write access is not tested here.';
const CREDENTIALS_FIX = 'Set them with `autopilot-marketing credentials set <NAME>` or in the .env file.';
const REFRESH_TOKEN_FIX =
  'The refresh token expired or was revoked. Create a new one. An OAuth consent screen in Testing ' +
  'status issues refresh tokens that expire after 7 days: publish the consent screen.';
const GA4_ACCESS_FIX =
  'Give the Google account Viewer access to the GA4 property, and enable the Google Analytics Data API ' +
  'in the Google Cloud project that owns the OAuth client.';
const GA4_ID_FIX = 'Check externalId: it is the numeric property id, not the measurement id (G-...).';
const SITE_FIX =
  'Add the Google account as a user of the property in Search Console, and write externalId exactly as ' +
  'the property is named there (https://example.com/ or sc-domain:example.com).';
const MAUTIC_AUTH_FIX =
  'Check the client id and secret or the user name and password, and that API access is enabled in the ' +
  'Mautic configuration (and Basic Auth, when a user name and password are used).';
const MAUTIC_SHAPE_DETAIL =
  'The server answered, but not with the Mautic API: the response is not the expected JSON.';
const MAUTIC_SHAPE_FIX =
  'Check externalId: it is the base URL of the Mautic instance, and the API must be enabled in the Mautic configuration.';
const GOOGLE_SHAPE_DETAIL = 'The server answered, but not with the Google API: the response is not the expected JSON.';
const MAUTIC_URL_FIX = 'Check externalId: it is the base URL of the Mautic instance, without /api.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'unknown error';
}

function fail(detail: string, fix?: string): Outcome {
  return fix === undefined ? { status: 'fail', detail } : { status: 'fail', detail, fix };
}

/** True for a failure that says nothing about the configuration: timeouts, network errors, 5xx, 429. */
function isTransient(error: unknown): boolean {
  return error instanceof AutopilotError && (error.retryable || error.code === 'rate_limited');
}

function evidenceOf(error: unknown): Evidence {
  if (error instanceof AutopilotError) {
    return { status: error.status, text: error.body ?? error.message };
  }
  return { status: undefined, text: messageOf(error) };
}

/**
 * The outcome of a failed call. A transient failure is `unknown` and carries no fix; `detail` holds
 * the short message only, never the response body.
 */
function failed(error: unknown, fixFor: (evidence: Evidence) => string | undefined): Outcome {
  const message = messageOf(error);
  if (isTransient(error)) return { status: 'unknown', detail: `Could not be checked: ${message}` };
  return fail(message, fixFor(evidenceOf(error)));
}

/** The HTTP status, read from the error or, failing that, from the status word of a Google error body. */
function has(evidence: Evidence, status: number, word: string): boolean {
  if (evidence.status !== undefined) return evidence.status === status;
  return evidence.text.includes(word);
}

function credentialsStep(label: string, missing: () => string[]): Step {
  return {
    id: 'credentials',
    label,
    run: () => {
      const names = missing();
      if (names.length > 0) return fail(`Missing: ${names.join(', ')}`, CREDENTIALS_FIX);
      return { status: 'ok', detail: 'all credential variables are set' };
    },
  };
}

function oauthStep(deps: ConnectorDeps, scope: string, keep: (token: string) => void): Step {
  const { env, account, http, now } = deps;
  return {
    id: 'oauth_token',
    label: 'OAuth access token can be obtained',
    run: async () => {
      try {
        keep(await getGoogleAccessToken({ env, account, http, scopes: [scope], now }));
      } catch (error) {
        return failed(error, (evidence) =>
          evidence.text.includes('invalid_grant') ? REFRESH_TOKEN_FIX : 'Check the OAuth client id and secret.',
        );
      }
      return { status: 'ok', detail: 'access token issued' };
    },
  };
}

/** Runs the steps in order; after the first one that is not ok, the rest are `skipped`. Never throws. */
async function runSteps(deps: ConnectorDeps, steps: Step[]): Promise<DiagnosticCheck[]> {
  const clean = (value: string): string => {
    try {
      return redact(value, deps.env);
    } catch {
      return 'detail withheld: it could not be redacted';
    }
  };
  const checks: DiagnosticCheck[] = [];
  let stopped = false;
  for (const step of steps) {
    if (stopped) {
      checks.push({ id: step.id, label: step.label, status: 'skipped', detail: SKIPPED_DETAIL });
      continue;
    }
    let outcome: Outcome;
    try {
      outcome = await step.run();
    } catch (error) {
      outcome = failed(error, () => undefined);
    }
    if (outcome.status !== 'ok') stopped = true;
    const check: DiagnosticCheck = {
      id: step.id,
      label: step.label,
      status: outcome.status,
      detail: clean(outcome.detail),
    };
    if (outcome.fix !== undefined) check.fix = clean(outcome.fix);
    checks.push(check);
  }
  return checks;
}

function ga4Fix(evidence: Evidence): string | undefined {
  if (has(evidence, 403, 'PERMISSION_DENIED')) return GA4_ACCESS_FIX;
  if (has(evidence, 404, 'NOT_FOUND')) return GA4_ID_FIX;
  if (has(evidence, 400, 'INVALID_ARGUMENT') && /propert/i.test(evidence.text)) return GA4_ID_FIX;
  return undefined;
}

/** Live checks of a GA4 property's access. Never throws. */
export async function diagnoseGa4(deps: ConnectorDeps): Promise<DiagnosticCheck[]> {
  const { account, env, http } = deps;
  let token = '';
  return runSteps(deps, [
    credentialsStep('Google credentials are set', () => googleAuthMissing(env, account)),
    oauthStep(deps, GA4_SCOPE, (value) => {
      token = value;
    }),
    {
      id: 'property_access',
      label: 'The GA4 property can be read',
      run: async () => {
        const propertyId = account.externalId.trim().replace(/^properties\//, '');
        let body: unknown;
        try {
          const response = await http.request<unknown>({
            url: `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}/metadata`,
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` },
          });
          body = response.body;
        } catch (error) {
          return failed(error, ga4Fix);
        }
        if (!isRecord(body)) return fail(GOOGLE_SHAPE_DETAIL);
        return { status: 'ok', detail: `property ${propertyId} answered. ${READ_ONLY_NOTE}` };
      },
    },
  ]);
}

/** Live checks of a Search Console site's access. Never throws. */
export async function diagnoseSearchConsole(deps: ConnectorDeps): Promise<DiagnosticCheck[]> {
  const { account, env, http } = deps;
  let token = '';
  return runSteps(deps, [
    credentialsStep('Google credentials are set', () => googleAuthMissing(env, account)),
    oauthStep(deps, SEARCH_CONSOLE_SCOPE, (value) => {
      token = value;
    }),
    {
      id: 'site_access',
      label: 'The Search Console site can be read',
      run: async () => {
        const siteUrl = account.externalId;
        let body: unknown;
        try {
          const response = await http.request<unknown>({
            url: `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}`,
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` },
          });
          body = response.body;
        } catch (error) {
          return failed(error, (evidence) =>
            has(evidence, 403, 'PERMISSION_DENIED') || has(evidence, 404, 'NOT_FOUND') ? SITE_FIX : undefined,
          );
        }
        if (!isRecord(body)) return fail(GOOGLE_SHAPE_DETAIL);
        const level = typeof body.permissionLevel === 'string' ? body.permissionLevel : '';
        // The level comes from the platform: keep only the enum's own alphabet.
        const permission = /^[A-Za-z]{1,40}$/.test(level) ? `, permission ${level}` : '';
        return { status: 'ok', detail: `site ${siteUrl} answered${permission}. ${READ_ONLY_NOTE}` };
      },
    },
  ]);
}

/** Live checks of a Mautic instance's access. Never throws. */
export async function diagnoseMautic(deps: ConnectorDeps): Promise<DiagnosticCheck[]> {
  return runSteps(deps, [
    credentialsStep('Mautic credentials are set', () => mauticAuthMissing(deps)),
    {
      id: 'api_access',
      label: 'The Mautic API answers',
      run: async () => {
        let body: unknown;
        try {
          // With client credentials, building the request fetches the OAuth token first.
          const request = await mauticRequest(deps, '/segments', { method: 'GET', query: { limit: 1 } });
          body = (await deps.http.request<unknown>(request)).body;
        } catch (error) {
          return failed(error, (evidence) => {
            if (has(evidence, 401, 'invalid_client')) return MAUTIC_AUTH_FIX;
            if (has(evidence, 404, '404 Not Found')) return MAUTIC_URL_FIX;
            return undefined;
          });
        }
        // A 2xx alone proves nothing: a redirect to the login page answers 200 with HTML.
        if (!isRecord(body) || !('lists' in body || 'total' in body)) {
          return fail(MAUTIC_SHAPE_DETAIL, MAUTIC_SHAPE_FIX);
        }
        return { status: 'ok', detail: `Mautic API answered. ${READ_ONLY_NOTE}` };
      },
    },
  ]);
}
