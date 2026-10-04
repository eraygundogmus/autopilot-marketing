import { AutopilotError, toAutopilotError } from '../core/errors';
import type { Action, ActionDraft, ActionResult, ConnectorDeps, HttpRequest, JsonObject, JsonValue } from '../core/types';
import { mauticRequest } from './mautic-read';

const NUMERIC_ID = /^\d+$/;

function isRecord(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unsupported(kind: string): AutopilotError {
  return new AutopilotError('unsupported', `The Mautic connector cannot handle action kind '${kind}'.`);
}

function segmentIds(draft: ActionDraft): { segmentId: string; contactId: string } {
  const segmentId = draft.target.id;
  const contactId = draft.params['contactId'];
  if (typeof segmentId !== 'string' || !NUMERIC_ID.test(segmentId)) {
    throw new AutopilotError('invalid_input', `${draft.kind}: target.id must be a numeric Mautic segment id.`);
  }
  if (typeof contactId !== 'string' || !NUMERIC_ID.test(contactId)) {
    throw new AutopilotError('invalid_input', `${draft.kind}: params.contactId must be a numeric Mautic contact id.`, {
      hint: 'Pass the contact id as a string of digits, e.g. "42".',
    });
  }
  return { segmentId, contactId };
}

function draftParams(draft: ActionDraft): { name: string; subject: string; html: string } {
  const { name, subject, html } = draft.params;
  if (typeof name !== 'string' || name.trim() === '') {
    throw new AutopilotError('invalid_input', `${draft.kind}: params.name must be a non-empty string.`);
  }
  if (typeof subject !== 'string' || typeof html !== 'string') {
    throw new AutopilotError('invalid_input', `${draft.kind}: params.subject and params.html must be strings.`);
  }
  return { name, subject, html };
}

async function send(deps: ConnectorDeps, path: string, init: Omit<HttpRequest, 'url'>): Promise<JsonValue> {
  const request = await mauticRequest(deps, path, init);
  const response = await deps.http.request(request);
  return response.body;
}

/** The HTTP client reports a non-2xx status only inside the message, as `<METHOD> <url> -> <status>: <body>`. */
function isHttp404(error: unknown): boolean {
  return error instanceof AutopilotError && error.code === 'platform_error' && /-> 404(?::|$)/.test(error.message);
}

/** Segment ids a contact belongs to; Mautic answers with an object keyed by id or with an array. */
function memberSegmentIds(body: JsonValue): Set<string> {
  const ids = new Set<string>();
  const lists = isRecord(body) ? body['lists'] : undefined;
  const add = (value: JsonValue | undefined): void => {
    if (typeof value === 'string' || typeof value === 'number') ids.add(String(value));
  };
  if (Array.isArray(lists)) {
    for (const item of lists) add(isRecord(item) ? item['id'] : item);
  } else if (isRecord(lists)) {
    for (const [key, item] of Object.entries(lists)) {
      const id = isRecord(item) ? item['id'] : undefined;
      if (id === undefined || id === null) ids.add(key);
      else add(id);
    }
  }
  return ids;
}

async function readMembership(deps: ConnectorDeps, draft: ActionDraft): Promise<JsonObject> {
  const { segmentId, contactId } = segmentIds(draft);
  let body: JsonValue;
  try {
    body = await send(deps, `/contacts/${contactId}/segments`, { method: 'GET' });
  } catch (error) {
    if (isHttp404(error)) {
      throw new AutopilotError('not_found', `Mautic contact ${contactId} does not exist.`, { cause: error });
    }
    throw error;
  }
  return { member: memberSegmentIds(body).has(segmentId) };
}

interface ExistingEmail {
  exists: boolean;
  id: string | null;
}

const EMAIL_PAGE_LIMIT = 100;
const EMAIL_MAX_PAGES = 5;

/** Emails of one page; Mautic answers with an array or with an object keyed by id. */
function emailEntries(body: JsonValue): Array<{ id: string | null; name: string | null }> {
  const emails = isRecord(body) ? body['emails'] : undefined;
  const pairs: Array<[string | null, JsonValue]> = Array.isArray(emails)
    ? emails.map((item): [string | null, JsonValue] => [null, item])
    : isRecord(emails)
      ? Object.entries(emails)
      : [];
  return pairs.map(([key, item]) => {
    const value = isRecord(item) ? item['id'] : undefined;
    const name = isRecord(item) ? item['name'] : undefined;
    return {
      id: typeof value === 'string' || typeof value === 'number' ? String(value) : key,
      name: typeof name === 'string' ? name : null,
    };
  });
}

/**
 * Mautic's name search matches substrings, so only an email whose trimmed name equals the wanted one counts as
 * existing. A search that is still unfinished after the page cap fails rather than report the name as free.
 */
async function findEmailByName(deps: ConnectorDeps, name: string): Promise<ExistingEmail> {
  const wanted = name.trim();
  const search = encodeURIComponent(`name:"${name}"`);
  for (let page = 0; page < EMAIL_MAX_PAGES; page += 1) {
    const start = page * EMAIL_PAGE_LIMIT;
    const body = await send(deps, `/emails?search=${search}&limit=${EMAIL_PAGE_LIMIT}&start=${start}`, {
      method: 'GET',
    });
    const entries = emailEntries(body);
    const match = entries.find((entry) => entry.name !== null && entry.name.trim() === wanted);
    if (match !== undefined) return { exists: true, id: match.id };
    const rawTotal = isRecord(body) ? body['total'] : undefined;
    const total = typeof rawTotal === 'number' ? rawTotal : typeof rawTotal === 'string' ? Number(rawTotal) : NaN;
    if (entries.length < EMAIL_PAGE_LIMIT) return { exists: false, id: null };
    if (Number.isFinite(total) && start + entries.length >= total) return { exists: false, id: null };
  }
  throw new AutopilotError(
    'platform_error',
    `More than ${EMAIL_PAGE_LIMIT * EMAIL_MAX_PAGES} Mautic emails match the name '${wanted}'; an exact match could not be ruled out.`,
    { hint: 'Choose a more specific email name.' },
  );
}

export async function readMauticState(deps: ConnectorDeps, draft: ActionDraft): Promise<JsonObject> {
  switch (draft.kind) {
    case 'mautic.segment.add_contact':
    case 'mautic.segment.remove_contact':
      return readMembership(deps, draft);
    case 'mautic.email.create_draft': {
      const found = await findEmailByName(deps, draftParams(draft).name);
      return { exists: found.exists };
    }
    default:
      throw unsupported(draft.kind);
  }
}

async function applyLive(deps: ConnectorDeps, action: Action): Promise<ActionResult> {
  switch (action.kind) {
    case 'mautic.segment.add_contact':
    case 'mautic.segment.remove_contact': {
      const { segmentId, contactId } = segmentIds(action);
      const adding = action.kind === 'mautic.segment.add_contact';
      await send(deps, `/segments/${segmentId}/contact/${contactId}/${adding ? 'add' : 'remove'}`, {
        method: 'POST',
        retry: false,
      });
      return { ok: true, dryRun: false, after: { member: adding }, resource: segmentId };
    }
    case 'mautic.email.create_draft': {
      const { name, subject, html } = draftParams(action);
      const found = await findEmailByName(deps, name);
      if (found.exists) {
        const result: ActionResult = { ok: true, dryRun: false, after: { exists: true } };
        if (found.id !== null) result.resource = found.id;
        return result;
      }
      const body = await send(deps, '/emails/new', {
        method: 'POST',
        retry: false,
        json: { name, subject, customHtml: html, emailType: 'template', isPublished: false },
      });
      const email = isRecord(body) ? body['email'] : undefined;
      const id = isRecord(email) ? email['id'] : undefined;
      if (typeof id !== 'string' && typeof id !== 'number') {
        throw new AutopilotError('platform_error', 'Mautic did not return the id of the created email.', {
          hint: 'Check the Mautic email list before retrying: the draft may exist.',
        });
      }
      return { ok: true, dryRun: false, after: { exists: true }, resource: String(id) };
    }
    default:
      throw unsupported(action.kind);
  }
}

export async function applyMauticAction(
  deps: ConnectorDeps,
  action: Action,
  options: { validateOnly: boolean; idempotencyKey: string },
): Promise<ActionResult> {
  const dryRun = options.validateOnly;
  try {
    if (dryRun) {
      // Mautic has no validate-only mode: a dry run only proves the target can be read.
      await readMauticState(deps, action);
      return { ok: true, dryRun: true, after: null };
    }
    return await applyLive(deps, action);
  } catch (error) {
    const failure = toAutopilotError(error);
    if (failure.retryable && !dryRun) throw failure;
    return {
      ok: false,
      dryRun,
      after: null,
      error: { code: failure.code, message: failure.message, retryable: failure.retryable },
    };
  }
}
