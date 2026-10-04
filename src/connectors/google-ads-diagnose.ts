import { envFor } from '../core/env';
import { AutopilotError } from '../core/errors';
import { redact } from '../core/redact';
import type { ConnectorDeps, DiagnosticCheck } from '../core/types';
import { GOOGLE_ADS_SCOPE, getGoogleAccessToken, googleAuthMissing } from './google-auth';

interface Outcome {
  status: 'ok' | 'fail' | 'unknown';
  detail: string;
  fix?: string;
  /** False when the following steps still run although this one is not ok. */
  blocking?: false;
}

interface Step {
  id: string;
  label: string;
  run: () => Promise<Outcome> | Outcome;
}

interface CustomerRow {
  name: string;
  currency: string;
  timeZone: string;
  status: string;
  manager: boolean;
  testAccount: boolean;
}

const SKIPPED_DETAIL = 'not run: an earlier check failed';
const READ_ONLY_NOTE = 'Read access works; write access is not tested here.';
const CUSTOMER_QUERY =
  'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, ' +
  'customer.status, customer.manager, customer.test_account FROM customer LIMIT 1';
const ACCESS_LEVEL_DETAIL =
  'The API does not report the access level of the Cloud project (Test, Explorer, Basic or Standard). ' +
  'See the Google Ads API page of the project in Cloud Console. ' +
  'Explorer allows 2,880 operations a day on production accounts.';
const MANAGER_ACCESS_FIX =
  'Check that loginCustomerId is the manager that has access to this customer, and that the user has access to that manager.';
const TEST_ACCESS_FIX =
  'The Google Cloud project has Test access only. Apply for Explorer or Basic access on the Google Ads API ' +
  'page of the project in Cloud Console.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function digits(value: string): string {
  return value.replace(/\D/g, '');
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

/** The text the documented enum strings are matched against: the whole response body when there is one. */
function classifiable(error: unknown): string {
  return error instanceof AutopilotError && error.body !== undefined ? error.body : messageOf(error);
}

/**
 * The outcome of a failed call. A transient failure is `unknown` and carries no fix; `detail` holds
 * the short message only, never the response body.
 */
function failed(error: unknown, fixFor: (evidence: string) => string | undefined): Outcome {
  const message = messageOf(error);
  if (isTransient(error)) return { status: 'unknown', detail: `Could not be checked: ${message}` };
  return fail(message, fixFor(classifiable(error)));
}

function text(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value === 'string') return value;
  return typeof value === 'number' ? String(value) : '';
}

/** The API's major version number, e.g. 25 for 'v25'; undefined when the string has another shape. */
function majorVersion(version: string): number | undefined {
  const match = /^v(\d+)/.exec(version);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function apiAccessFix(message: string): string | undefined {
  if (message.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT')) {
    return `Create the refresh token with the scope ${GOOGLE_ADS_SCOPE}.`;
  }
  if (message.includes('NOT_ADS_USER')) {
    return 'The Google account that authorised the token has no Google Ads account. Sign in with a user of the ad account.';
  }
  if (message.includes('SERVICE_DISABLED') || message.includes('has not been used in project')) {
    return 'Enable the Google Ads API in the Google Cloud project that owns the OAuth client.';
  }
  if (message.includes('OAUTH_TOKEN_INVALID') || message.includes('GOOGLE_ACCOUNT_COOKIE_INVALID')) {
    return 'The access token was rejected. Create a new refresh token.';
  }
  return undefined;
}

function accountQueryFix(message: string, version: string): string | undefined {
  if (message.includes('CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION')) return TEST_ACCESS_FIX;
  if (message.includes('USER_PERMISSION_DENIED')) {
    return 'The user cannot reach this customer. Set loginCustomerId to the manager account that has access, or ask for access.';
  }
  if (message.includes('CUSTOMER_NOT_ENABLED')) return 'The account has not finished signup or was deactivated.';
  if (message.includes('CUSTOMER_NOT_FOUND')) return 'No such customer id. Check externalId.';
  if (message.includes('CLIENT_CUSTOMER_ID_INVALID')) return 'Use ten digits without hyphens.';
  // v24 and earlier report a Test-level project with this broader enum.
  const major = majorVersion(version);
  if (message.includes('ACTION_NOT_PERMITTED') && major !== undefined && major <= 24) return TEST_ACCESS_FIX;
  return undefined;
}

/** The first row of a `googleAds:search` body (or of a `searchStream` array of batches). */
function firstCustomer(body: unknown): CustomerRow | undefined {
  const batches: unknown[] = Array.isArray(body) ? body : [body];
  for (const batch of batches) {
    if (!isRecord(batch) || !Array.isArray(batch.results)) continue;
    for (const result of batch.results) {
      if (!isRecord(result) || !isRecord(result.customer)) continue;
      const customer = result.customer;
      return {
        name: text(customer, 'descriptiveName'),
        currency: text(customer, 'currencyCode'),
        timeZone: text(customer, 'timeZone'),
        status: text(customer, 'status'),
        manager: customer.manager === true,
        testAccount: customer.testAccount === true,
      };
    }
  }
  return undefined;
}

/** Live checks of a Google Ads account's access, in the order a person would fix them. Never throws. */
export async function diagnoseGoogleAds(deps: ConnectorDeps): Promise<DiagnosticCheck[]> {
  const { account, env, http, now } = deps;
  const clean = (value: string): string => redact(value, env);

  let customerId = '';
  let version = 'v25';
  let token = '';
  let accessible: string[] = [];
  let customer: CustomerRow | undefined;
  let queryPassed = false;
  // Set when the query already ran as the test of access through a manager account.
  let queryOutcome: Outcome | undefined;
  let queryDenied = false;

  const managerId = account.loginCustomerId === undefined ? '' : digits(account.loginCustomerId);

  const runQuery = async (): Promise<Outcome> => {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (managerId !== '') headers['login-customer-id'] = managerId;
    let body: unknown;
    try {
      const response = await http.request<unknown>({
        url: `https://googleads.googleapis.com/${version}/customers/${customerId}/googleAds:search`,
        method: 'POST',
        headers,
        json: { query: CUSTOMER_QUERY },
        // A search changes nothing, so repeating it is safe.
        retry: true,
      });
      body = response.body;
    } catch (error) {
      queryDenied = !isTransient(error) && classifiable(error).includes('USER_PERMISSION_DENIED');
      return failed(error, (evidence) => accountQueryFix(evidence, version));
    }
    queryPassed = true;
    customer = firstCustomer(body);
    return { status: 'ok', detail: `query answered. ${READ_ONLY_NOTE}` };
  };

  const steps: Step[] = [
    {
      id: 'credentials',
      label: 'Google credentials are set',
      run: () => {
        const missing = googleAuthMissing(env, account);
        if (missing.length > 0) {
          return fail(
            `Missing: ${missing.join(', ')}`,
            'Set them with `autopilot-marketing credentials set <NAME>` or in the .env file.',
          );
        }
        return { status: 'ok', detail: 'all credential variables are set' };
      },
    },
    {
      id: 'oauth_token',
      label: 'OAuth access token can be obtained',
      run: async () => {
        try {
          token = await getGoogleAccessToken({ env, account, http, scopes: [GOOGLE_ADS_SCOPE], now });
        } catch (error) {
          return failed(error, (evidence) =>
            evidence.includes('invalid_grant')
              ? 'The refresh token expired or was revoked. Create a new one. An OAuth consent screen in Testing ' +
                'status issues refresh tokens that expire after 7 days: publish the consent screen.'
              : 'Check the OAuth client id and secret.',
          );
        }
        return { status: 'ok', detail: 'access token issued' };
      },
    },
    {
      id: 'api_access',
      label: 'Google Ads API accepts the token',
      run: async () => {
        version = envFor(env, account, 'GOOGLE_ADS_API_VERSION') ?? 'v25';
        let body: unknown;
        try {
          const response = await http.request<unknown>({
            url: `https://googleads.googleapis.com/${version}/customers:listAccessibleCustomers`,
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` },
          });
          body = response.body;
        } catch (error) {
          return failed(error, apiAccessFix);
        }
        const names = isRecord(body) && Array.isArray(body.resourceNames) ? body.resourceNames : [];
        accessible = names.filter((name): name is string => typeof name === 'string');
        return { status: 'ok', detail: `${accessible.length} accessible customer(s)` };
      },
    },
    {
      id: 'account_access',
      label: 'The user can reach the configured customer',
      // Access through a manager is not visible in the list of accessible customers: only the query proves it.
      run: async () => {
        customerId = digits(account.externalId);
        if (accessible.includes(`customers/${customerId}`)) {
          return { status: 'ok', detail: `Customer ${customerId} is directly accessible.` };
        }
        if (managerId === '') {
          return fail(
            `Customer ${customerId} is not among the accounts this user can access directly.`,
            'If it is reached through a manager account, set loginCustomerId to the manager id. ' +
              'Otherwise ask an admin of the account to give this user access.',
          );
        }
        try {
          queryOutcome = await runQuery();
        } catch (error) {
          queryOutcome = failed(error, () => undefined);
        }
        if (queryOutcome.status === 'ok') {
          return { status: 'ok', detail: `reached through manager account ${managerId}.` };
        }
        if (queryDenied) {
          return fail(
            `Customer ${customerId} could not be reached through manager account ${managerId}.`,
            MANAGER_ACCESS_FIX,
          );
        }
        return {
          status: 'unknown',
          detail: `Access through manager account ${managerId} could not be confirmed.`,
          blocking: false,
        };
      },
    },
    {
      id: 'account_query',
      label: 'A query against the customer succeeds',
      run: () => queryOutcome ?? runQuery(),
    },
    {
      id: 'account_state',
      label: 'The account is an enabled client account',
      run: () => {
        if (customer === undefined) return fail('The query returned no customer row.');
        if (customer.manager) {
          return fail('This is a manager account; it has no campaigns. Use the id of a client account.');
        }
        if (customer.status !== 'ENABLED') {
          return fail(`The account status is ${customer.status === '' ? 'not reported' : customer.status}.`);
        }
        const parts = [customer.name === '' ? `Customer ${customerId}` : customer.name, customer.currency, customer.timeZone];
        if (customer.testAccount) parts.push('test account');
        return { status: 'ok', detail: parts.join(', ') };
      },
    },
    {
      id: 'config_match',
      label: 'Config currency and time zone match the platform',
      run: () => {
        if (customer === undefined) return fail('The query returned no customer row.');
        if (account.currency === undefined && account.timezone === undefined) {
          return { status: 'ok', detail: 'nothing to compare' };
        }
        const differences: string[] = [];
        const changes: string[] = [];
        if (account.currency !== undefined && account.currency.toUpperCase() !== customer.currency.toUpperCase()) {
          differences.push(`config currency ${account.currency}, platform ${customer.currency}`);
          changes.push(`currency to ${customer.currency}`);
        }
        if (account.timezone !== undefined && account.timezone !== customer.timeZone) {
          differences.push(`config timezone ${account.timezone}, platform ${customer.timeZone}`);
          changes.push(`timezone to ${customer.timeZone}`);
        }
        if (differences.length === 0) return { status: 'ok', detail: 'config agrees with the platform' };
        return fail(differences.join('; '), `Set ${changes.join(' and ')} in the config.`);
      },
    },
  ];

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
    if (outcome.status !== 'ok' && outcome.blocking !== false) stopped = true;
    const check: DiagnosticCheck = {
      id: step.id,
      label: step.label,
      status: outcome.status,
      detail: clean(outcome.detail),
    };
    if (outcome.fix !== undefined) check.fix = clean(outcome.fix);
    checks.push(check);
  }

  if (queryPassed) {
    checks.push({
      id: 'access_level',
      label: 'Access level of the Cloud project',
      status: 'ok',
      detail: clean(ACCESS_LEVEL_DETAIL),
    });
  }
  return checks;
}
