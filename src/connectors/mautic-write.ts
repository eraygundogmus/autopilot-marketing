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

/** `beforeWrite` is given for a request that changes Mautic; it runs after the request is built, directly before it is sent. */
async function send(
  deps: ConnectorDeps,
  path: string,
  init: Omit<HttpRequest, 'url'>,
  beforeWrite?: () => void,
): Promise<JsonValue> {
  const request = await mauticRequest(deps, path, init);
  beforeWrite?.();
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

type EmailFields = { [key: string]: JsonValue };

interface ExistingEmail {
  exists: boolean;
  id: string | null;
  fields: EmailFields | null;
}

const EMAIL_PAGE_LIMIT = 100;
const EMAIL_MAX_PAGES = 5;

/** Emails of one page; Mautic answers with an array or with an object keyed by id. */
function emailEntries(body: JsonValue): Array<{ id: string | null; name: string | null; fields: EmailFields | null }> {
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
      fields: isRecord(item) ? item : null,
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
    if (match !== undefined) return { exists: true, id: match.id, fields: match.fields };
    const rawTotal = isRecord(body) ? body['total'] : undefined;
    const total = typeof rawTotal === 'number' ? rawTotal : typeof rawTotal === 'string' ? Number(rawTotal) : NaN;
    if (entries.length < EMAIL_PAGE_LIMIT) return { exists: false, id: null, fields: null };
    if (Number.isFinite(total) && start + entries.length >= total) return { exists: false, id: null, fields: null };
  }
  throw new AutopilotError(
    'platform_error',
    `More than ${EMAIL_PAGE_LIMIT * EMAIL_MAX_PAGES} Mautic emails match the name '${wanted}'; an exact match could not be ruled out.`,
    { hint: 'Choose a more specific email name.' },
  );
}

const DRAFT_FIELDS = ['subject', 'customHtml', 'isPublished'] as const;

/** The fields of an existing email that the draft comparison needs; throws when they cannot be read. */
async function draftFields(deps: ConnectorDeps, found: ExistingEmail): Promise<EmailFields> {
  const listed = found.fields;
  if (listed !== null && DRAFT_FIELDS.every((key) => listed[key] !== undefined)) return listed;
  if (found.id === null) {
    throw new AutopilotError('platform_error', 'Mautic listed an email without an id; its content cannot be read.');
  }
  const body = await send(deps, `/emails/${encodeURIComponent(found.id)}`, { method: 'GET' });
  const email = isRecord(body) ? body['email'] : undefined;
  if (!isRecord(email)) {
    throw new AutopilotError('platform_error', `Mautic did not return the content of email ${found.id}.`);
  }
  return email;
}

/**
 * An existing email stands in for the requested draft only when its subject and body equal the requested ones and
 * it is unpublished. The detail endpoint is asked only when the list entry lacks one of the compared fields. When
 * the compared fields cannot be read at all the call throws: neither answer may be guessed.
 */
async function isSameDraft(
  deps: ConnectorDeps,
  found: ExistingEmail,
  wanted: { subject: string; html: string },
): Promise<boolean> {
  const fields = await draftFields(deps, found);
  return (
    fields['subject'] === wanted.subject && fields['customHtml'] === wanted.html && fields['isPublished'] === false
  );
}

export async function readMauticState(deps: ConnectorDeps, draft: ActionDraft): Promise<JsonObject> {
  switch (draft.kind) {
    case 'mautic.segment.add_contact':
    case 'mautic.segment.remove_contact':
      return readMembership(deps, draft);
    case 'mautic.email.create_draft': {
      // `exists` means the requested draft itself exists, not merely an email carrying its name.
      const { name, subject, html } = draftParams(draft);
      const found = await findEmailByName(deps, name);
      return { exists: found.exists && (await isSameDraft(deps, found, { subject, html })) };
    }
    default:
      throw unsupported(draft.kind);
  }
}

async function applyLive(deps: ConnectorDeps, action: Action, beforeWrite: () => void): Promise<ActionResult> {
  switch (action.kind) {
    case 'mautic.segment.add_contact':
    case 'mautic.segment.remove_contact': {
      const { segmentId, contactId } = segmentIds(action);
      const adding = action.kind === 'mautic.segment.add_contact';
      await send(
        deps,
        `/segments/${segmentId}/contact/${contactId}/${adding ? 'add' : 'remove'}`,
        { method: 'POST', retry: false },
        beforeWrite,
      );
      return { ok: true, dryRun: false, after: { member: adding }, resource: segmentId };
    }
    case 'mautic.email.create_draft': {
      const { name, subject, html } = draftParams(action);
      const found = await findEmailByName(deps, name);
      if (found.exists) {
        if (!(await isSameDraft(deps, found, { subject, html }))) {
          throw new AutopilotError(
            'invalid_input',
            `An email named "${name.trim()}" already exists with different content or is published; the draft needs another name.`,
          );
        }
        const result: ActionResult = { ok: true, dryRun: false, after: { exists: true } };
        if (found.id !== null) result.resource = found.id;
        return result;
      }
      const body = await send(
        deps,
        '/emails/new',
        {
          method: 'POST',
          retry: false,
          json: { name, subject, customHtml: html, emailType: 'template', isPublished: false },
        },
        beforeWrite,
      );
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
  options: { validateOnly: boolean; idempotencyKey: string; beforeWrite?: () => void },
): Promise<ActionResult> {
  const dryRun = options.validateOnly;
  // An error thrown by `beforeWrite` leaves this function unchanged: it is never reported as a result.
  let refusal: { error: unknown } | undefined;
  const beforeWrite = (): void => {
    try {
      options.beforeWrite?.();
    } catch (error) {
      refusal = { error };
      throw error;
    }
  };
  try {
    if (dryRun) {
      // Mautic has no validate-only mode: a dry run only proves the target can be read.
      await readMauticState(deps, action);
      return { ok: true, dryRun: true, after: null };
    }
    return await applyLive(deps, action, beforeWrite);
  } catch (error) {
    if (refusal !== undefined && refusal.error === error) throw error;
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
