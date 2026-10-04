import { describe, expect, it, vi } from 'vitest';
import { applyMauticAction, readMauticState } from '../../src/connectors/mautic-write';
import { AutopilotError } from '../../src/core/errors';
import type { Action, ActionDraft, ConnectorDeps, HttpRequest, JsonObject, JsonValue } from '../../src/core/types';

vi.mock('../../src/connectors/mautic-read', () => ({
  mauticRequest: async (_deps: unknown, path: string, init?: Record<string, unknown>) => ({
    url: `https://m.example/api${path}`,
    ...init,
  }),
}));

type Handler = (request: HttpRequest) => JsonValue;

function makeDeps(handler: Handler): { deps: ConnectorDeps; calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  const deps = {
    account: { id: 'm1', platform: 'mautic', externalId: 'https://m.example' },
    env: {},
    http: {
      request: async (request: HttpRequest) => {
        calls.push(request);
        return { status: 200, headers: {}, body: handler(request) };
      },
    },
    now: () => new Date('2026-01-01T00:00:00Z'),
  } as unknown as ConnectorDeps;
  return { deps, calls };
}

function segmentDraft(kind: ActionDraft['kind'], id = '7', contactId: JsonValue = '42'): ActionDraft {
  return { kind, target: { level: 'segment', id } as ActionDraft['target'], params: { contactId }, rationale: 'test' };
}

function emailDraft(params: JsonObject = { name: 'Welcome "A"', subject: 'Hi', html: '<p>Hi</p>' }): ActionDraft {
  return {
    kind: 'mautic.email.create_draft',
    target: { level: 'account', id: 'm1' } as ActionDraft['target'],
    params,
    rationale: 'test',
  };
}

function toAction(draft: ActionDraft): Action {
  return {
    ...draft,
    id: 'act_0000000000000000',
    platform: 'mautic',
    before: null,
    after: {},
    preconditionHash: null,
    spendEffect: 'none',
    spendDeltaPerDay: null,
    reversible: 'compensating',
    status: 'pending',
  } as Action;
}

function existing(overrides: JsonObject = {}): JsonObject {
  return { id: 12, name: 'Welcome "A"', subject: 'Hi', customHtml: '<p>Hi</p>', isPublished: false, ...overrides };
}

const live = { validateOnly: false, idempotencyKey: 'k' };
const dry = { validateOnly: true, idempotencyKey: 'k' };
const posts = (calls: HttpRequest[]): HttpRequest[] => calls.filter((call) => call.method === 'POST');

describe('readMauticState', () => {
  it('reads membership from an object keyed by segment id', async () => {
    const { deps, calls } = makeDeps(() => ({ total: 1, lists: { '7': { id: 7, name: 'VIP' } } }));
    await expect(readMauticState(deps, segmentDraft('mautic.segment.add_contact'))).resolves.toEqual({ member: true });
    expect(calls[0]?.url).toBe('https://m.example/api/contacts/42/segments');
    await expect(readMauticState(deps, segmentDraft('mautic.segment.add_contact', '8'))).resolves.toEqual({
      member: false,
    });
  });

  it('reads membership from an array', async () => {
    const { deps } = makeDeps(() => ({ total: 2, lists: [{ id: '3' }, { id: 7 }] }));
    await expect(readMauticState(deps, segmentDraft('mautic.segment.remove_contact'))).resolves.toEqual({
      member: true,
    });
    await expect(readMauticState(deps, segmentDraft('mautic.segment.remove_contact', '9'))).resolves.toEqual({
      member: false,
    });
  });

  it('rejects non-numeric ids without a request', async () => {
    const { deps, calls } = makeDeps(() => null);
    await expect(readMauticState(deps, segmentDraft('mautic.segment.add_contact', '7/../1'))).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(readMauticState(deps, segmentDraft('mautic.segment.add_contact', '7', 'abc'))).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(readMauticState(deps, segmentDraft('mautic.segment.add_contact', '7', 42))).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(calls).toHaveLength(0);
  });

  it('maps a 404 to not_found', async () => {
    const { deps } = makeDeps(() => {
      throw new AutopilotError('platform_error', 'GET https://m.example/api/contacts/42/segments -> 404: {}');
    });
    await expect(readMauticState(deps, segmentDraft('mautic.segment.add_contact'))).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('looks an email up by encoded name', async () => {
    const { deps, calls } = makeDeps(() => ({
      total: '1',
      emails: [existing({ id: 5, name: ' Welcome "A" ' })],
    }));
    await expect(readMauticState(deps, emailDraft())).resolves.toEqual({ exists: true });
    expect(calls[0]?.url).toBe(
      `https://m.example/api/emails?search=${encodeURIComponent('name:"Welcome "A""')}&limit=100&start=0`,
    );
    const empty = makeDeps(() => ({ total: 0, emails: [] }));
    await expect(readMauticState(empty.deps, emailDraft())).resolves.toEqual({ exists: false });
  });

  it('reports exists only for the identical unpublished draft', async () => {
    const state = (email: JsonObject): Promise<JsonObject> =>
      readMauticState(makeDeps(() => ({ total: 1, emails: [email] })).deps, emailDraft());
    await expect(state(existing())).resolves.toEqual({ exists: true });
    await expect(state(existing({ subject: 'Other' }))).resolves.toEqual({ exists: false });
    await expect(state(existing({ customHtml: '<p>Other</p>' }))).resolves.toEqual({ exists: false });
    await expect(state(existing({ isPublished: true }))).resolves.toEqual({ exists: false });
  });

  it('compares against the email detail when the list entry lacks the fields', async () => {
    const state = (email: JsonObject): Promise<JsonObject> =>
      readMauticState(
        makeDeps((request) =>
          request.url.endsWith('/emails/12') ? { email } : { total: 1, emails: [{ id: 12, name: 'Welcome "A"' }] },
        ).deps,
        emailDraft(),
      );
    await expect(state(existing())).resolves.toEqual({ exists: true });
    await expect(state(existing({ isPublished: true }))).resolves.toEqual({ exists: false });
    await expect(state(existing({ subject: 'Other' }))).resolves.toEqual({ exists: false });
  });

  it('rejects instead of guessing when the email detail cannot be read', async () => {
    const failing = makeDeps((request) => {
      if (request.url.endsWith('/emails/12')) {
        throw new AutopilotError('platform_error', 'GET https://m.example/api/emails/12 -> 503: down', {
          retryable: true,
        });
      }
      return { total: 1, emails: [{ id: 12, name: 'Welcome "A"' }] };
    });
    await expect(readMauticState(failing.deps, emailDraft())).rejects.toMatchObject({
      code: 'platform_error',
      message: expect.stringContaining('503'),
    });
    const malformed = makeDeps((request) =>
      request.url.endsWith('/emails/12') ? {} : { total: 1, emails: [{ id: 12, name: 'Welcome "A"' }] },
    );
    await expect(readMauticState(malformed.deps, emailDraft())).rejects.toMatchObject({ code: 'platform_error' });
    const noId = makeDeps(() => ({ total: 1, emails: [{ name: 'Welcome "A"' }] }));
    await expect(readMauticState(noId.deps, emailDraft())).rejects.toMatchObject({ code: 'platform_error' });
    expect(noId.calls).toHaveLength(1);
  });
});

describe('applyMauticAction', () => {
  it('posts add and remove to the segment contact paths without retry', async () => {
    const { deps, calls } = makeDeps(() => ({ success: 1 }));
    const added = await applyMauticAction(deps, toAction(segmentDraft('mautic.segment.add_contact')), live);
    const removed = await applyMauticAction(deps, toAction(segmentDraft('mautic.segment.remove_contact')), live);
    expect(added).toMatchObject({ ok: true, dryRun: false });
    expect(removed).toMatchObject({ ok: true, dryRun: false });
    expect(calls.map((call) => [call.method, call.url, call.retry])).toEqual([
      ['POST', 'https://m.example/api/segments/7/contact/42/add', false],
      ['POST', 'https://m.example/api/segments/7/contact/42/remove', false],
    ]);
  });

  it('creates an unpublished draft', async () => {
    const { deps, calls } = makeDeps((request) =>
      request.method === 'POST' ? { email: { id: 31 } } : { total: 0, emails: [] },
    );
    const result = await applyMauticAction(deps, toAction(emailDraft()), live);
    expect(result).toMatchObject({ ok: true, dryRun: false, resource: '31' });
    const post = posts(calls)[0];
    expect(post?.url).toBe('https://m.example/api/emails/new');
    expect(post?.retry).toBe(false);
    expect(post?.json).toEqual({
      name: 'Welcome "A"',
      subject: 'Hi',
      customHtml: '<p>Hi</p>',
      emailType: 'template',
      isPublished: false,
    });
  });

  it('does not create a second email with the same name', async () => {
    const { deps, calls } = makeDeps(() => ({ total: 1, emails: { '12': existing() } }));
    const result = await applyMauticAction(deps, toAction(emailDraft()), live);
    expect(result).toMatchObject({ ok: true, dryRun: false, after: { exists: true }, resource: '12' });
    expect(posts(calls)).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  it('refuses a same-named email with a different subject or body', async () => {
    for (const change of [{ subject: 'Other' }, { customHtml: '<p>Other</p>' }]) {
      const { deps, calls } = makeDeps(() => ({ total: 1, emails: [existing(change)] }));
      await expect(readMauticState(deps, emailDraft())).resolves.toEqual({ exists: false });
      const result = await applyMauticAction(deps, toAction(emailDraft()), live);
      expect(posts(calls)).toHaveLength(0);
      expect(result).toEqual({
        ok: false,
        dryRun: false,
        after: null,
        error: {
          code: 'invalid_input',
          message: expect.stringContaining('An email named "Welcome "A"" already exists'),
          retryable: false,
        },
      });
      expect(result.error?.message).toContain('another name');
      expect(calls.every((call) => call.method === 'GET')).toBe(true);
    }
  });

  it('refuses a same-named email that is published', async () => {
    const { deps, calls } = makeDeps(() => ({ total: 1, emails: [existing({ isPublished: true })] }));
    const result = await applyMauticAction(deps, toAction(emailDraft()), live);
    expect(result).toMatchObject({ ok: false, dryRun: false, after: null, error: { code: 'invalid_input' } });
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('reads the email itself when the list entry lacks the compared fields', async () => {
    const handler = (email: JsonObject): Handler => (request) =>
      request.url.endsWith('/emails/12') ? { email } : { total: 1, emails: [{ id: 12, name: 'Welcome "A"' }] };
    const same = makeDeps(handler(existing()));
    await expect(applyMauticAction(same.deps, toAction(emailDraft()), live)).resolves.toMatchObject({
      ok: true,
      resource: '12',
    });
    const published = makeDeps(handler(existing({ isPublished: true })));
    await expect(applyMauticAction(published.deps, toAction(emailDraft()), live)).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(same.calls.map((call) => call.method)).toEqual(['GET', 'GET']);
    expect(published.calls.map((call) => call.method)).toEqual(['GET', 'GET']);
  });

  it('creates "Welcome" although "Welcome 2025" matches the substring search', async () => {
    const { deps, calls } = makeDeps((request) =>
      request.method === 'POST'
        ? { email: { id: 40 } }
        : { total: 2, emails: [{ id: 11, name: 'Welcome 2025' }, { id: 12, name: 'welcome' }] },
    );
    const draft = emailDraft({ name: 'Welcome', subject: 'Hi', html: '<p>Hi</p>' });
    await expect(readMauticState(deps, draft)).resolves.toEqual({ exists: false });
    const result = await applyMauticAction(deps, toAction(draft), live);
    expect(result).toMatchObject({ ok: true, dryRun: false, resource: '40' });
    expect(posts(calls)).toHaveLength(1);
  });

  it('short-circuits on an exact name found on a later page', async () => {
    const page = (from: number): JsonValue =>
      Array.from({ length: 100 }, (_, index) => ({ id: from + index, name: `Welcome ${from + index}` }));
    const { deps, calls } = makeDeps((request) =>
      request.url.endsWith('&start=0')
        ? { total: 101, emails: page(1) }
        : { total: 101, emails: { '500': existing({ id: 500, name: 'Welcome' }) } },
    );
    const draft = emailDraft({ name: 'Welcome', subject: 'Hi', html: '<p>Hi</p>' });
    await expect(readMauticState(deps, draft)).resolves.toEqual({ exists: true });
    const result = await applyMauticAction(deps, toAction(draft), live);
    expect(result).toMatchObject({ ok: true, dryRun: false, after: { exists: true }, resource: '500' });
    expect(posts(calls)).toHaveLength(0);
    expect(calls.map((call) => call.url.split('&').slice(1).join('&'))).toEqual([
      'limit=100&start=0',
      'limit=100&start=100',
      'limit=100&start=0',
      'limit=100&start=100',
    ]);
  });

  it('stops after five full pages and fails instead of creating', async () => {
    const { deps, calls } = makeDeps(() => ({
      total: 9999,
      emails: Array.from({ length: 100 }, (_, index) => ({ id: index + 1, name: `Welcome ${index}` })),
    }));
    const draft = emailDraft({ name: 'Welcome', subject: 'Hi', html: '<p>Hi</p>' });
    const result = await applyMauticAction(deps, toAction(draft), live);
    expect(result).toMatchObject({ ok: false, error: { code: 'platform_error' } });
    expect(calls).toHaveLength(5);
    expect(posts(calls)).toHaveLength(0);
  });

  it('rethrows as retryable when the create answer does not name the created email', async () => {
    for (const answer of [{ email: {} }, {}, '<html>ok</html>'] as JsonValue[]) {
      const { deps, calls } = makeDeps((request) => (request.method === 'POST' ? answer : { total: 0, emails: [] }));
      await expect(applyMauticAction(deps, toAction(emailDraft()), live)).rejects.toMatchObject({
        code: 'platform_error',
        retryable: true,
        message: 'Mautic accepted the request but its response does not say what was created.',
      });
      expect(posts(calls)).toHaveLength(1);
    }
  });

  it('rethrows as retryable when a segment write answer does not confirm success', async () => {
    for (const answer of [{}, { success: 0 }, '<html>ok</html>'] as JsonValue[]) {
      const { deps, calls } = makeDeps(() => answer);
      await expect(
        applyMauticAction(deps, toAction(segmentDraft('mautic.segment.add_contact')), live),
      ).rejects.toMatchObject({ code: 'platform_error', retryable: true });
      expect(posts(calls)).toHaveLength(1);
    }
  });

  it('rejects an unreadable email list instead of reading it as absent', async () => {
    const lists: JsonValue[] = [
      {},
      '<html>login</html>',
      { total: 1, emails: 'x' },
      { total: 1, emails: [null] },
      { total: 1, emails: [{ id: 12 }] },
    ];
    for (const list of lists) {
      const { deps, calls } = makeDeps((request) => (request.method === 'POST' ? { email: { id: 31 } } : list));
      const unreadable = {
        code: 'platform_error',
        retryable: true,
        message: 'Mautic returned an email list that cannot be read.',
      };
      await expect(readMauticState(deps, emailDraft())).rejects.toMatchObject(unreadable);
      await expect(applyMauticAction(deps, toAction(emailDraft()), live)).rejects.toMatchObject(unreadable);
      expect(posts(calls)).toHaveLength(0);
    }
  });

  it('reads a well-formed empty list as absent and creates', async () => {
    for (const emails of [[], {}] as JsonValue[]) {
      const { deps, calls } = makeDeps((request) =>
        request.method === 'POST' ? { email: { id: 31 } } : { total: 0, emails },
      );
      await expect(readMauticState(deps, emailDraft())).resolves.toEqual({ exists: false });
      await expect(applyMauticAction(deps, toAction(emailDraft()), live)).resolves.toMatchObject({
        ok: true,
        resource: '31',
      });
      expect(posts(calls)).toHaveLength(1);
    }
  });

  it('makes no POST on a dry run', async () => {
    const segment = makeDeps(() => ({ lists: [] }));
    await expect(
      applyMauticAction(segment.deps, toAction(segmentDraft('mautic.segment.add_contact')), dry),
    ).resolves.toEqual({ ok: true, dryRun: true, after: null });
    const email = makeDeps(() => ({ total: 0, emails: [] }));
    await expect(applyMauticAction(email.deps, toAction(emailDraft()), dry)).resolves.toEqual({
      ok: true,
      dryRun: true,
      after: null,
    });
    expect(segment.calls).toHaveLength(1);
    expect(email.calls).toHaveLength(1);
    expect(posts([...segment.calls, ...email.calls])).toHaveLength(0);
  });

  it('reports a 400 as a failed result', async () => {
    const { deps } = makeDeps(() => {
      throw new AutopilotError('platform_error', 'POST https://m.example/api/segments/7/contact/42/add -> 400: bad');
    });
    const result = await applyMauticAction(deps, toAction(segmentDraft('mautic.segment.add_contact')), live);
    expect(result).toEqual({
      ok: false,
      dryRun: false,
      after: null,
      error: { code: 'platform_error', message: expect.stringContaining('400'), retryable: false },
    });
  });

  it('reports invalid ids as a failed result without a request', async () => {
    const { deps, calls } = makeDeps(() => null);
    const result = await applyMauticAction(deps, toAction(segmentDraft('mautic.segment.add_contact', 'x')), live);
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(calls).toHaveLength(0);
  });

  it('rethrows a retryable error on a live call but not on a dry run', async () => {
    const failing: Handler = () => {
      throw new AutopilotError('platform_error', 'POST x -> 500: oops', { retryable: true });
    };
    const action = toAction(segmentDraft('mautic.segment.add_contact'));
    await expect(applyMauticAction(makeDeps(failing).deps, action, live)).rejects.toMatchObject({
      code: 'platform_error',
      retryable: true,
    });
    await expect(applyMauticAction(makeDeps(failing).deps, action, dry)).resolves.toMatchObject({
      ok: false,
      dryRun: true,
      error: { retryable: true },
    });
  });
});

describe('applyMauticAction beforeWrite', () => {
  function recording(): { deps: ConnectorDeps; calls: HttpRequest[]; events: string[] } {
    const events: string[] = [];
    const made = makeDeps((request) => {
      events.push(request.method ?? 'GET');
      if (request.method === 'POST') return { success: 1, email: { id: 31 } };
      return { total: 0, emails: [], lists: [] };
    });
    return { ...made, events };
  }

  it('calls beforeWrite once, directly before the segment POST', async () => {
    const { deps, events } = recording();
    const result = await applyMauticAction(deps, toAction(segmentDraft('mautic.segment.add_contact')), {
      ...live,
      beforeWrite: () => void events.push('beforeWrite'),
    });
    expect(result.ok).toBe(true);
    expect(events).toEqual(['beforeWrite', 'POST']);
  });

  it('calls beforeWrite once, after the name lookup and directly before the create POST', async () => {
    const { deps, events } = recording();
    const result = await applyMauticAction(deps, toAction(emailDraft()), {
      ...live,
      beforeWrite: () => void events.push('beforeWrite'),
    });
    expect(result).toMatchObject({ ok: true, resource: '31' });
    expect(events.filter((event) => event === 'beforeWrite')).toHaveLength(1);
    expect(events.slice(-2)).toEqual(['beforeWrite', 'POST']);
    expect(events.slice(0, -2).every((event) => event === 'GET')).toBe(true);
    expect(events.length).toBeGreaterThan(2);
  });

  it('lets a beforeWrite error through unchanged and sends no POST', async () => {
    for (const refusal of [new Error('lock lost'), new AutopilotError('platform_error', 'taken over')]) {
      for (const draft of [segmentDraft('mautic.segment.remove_contact'), emailDraft()]) {
        const { deps, calls } = recording();
        const pending = applyMauticAction(deps, toAction(draft), {
          ...live,
          beforeWrite: () => {
            throw refusal;
          },
        });
        await expect(pending).rejects.toBe(refusal);
        expect(posts(calls)).toHaveLength(0);
      }
    }
  });

  it('never calls beforeWrite on validateOnly', async () => {
    const { deps, calls } = recording();
    const beforeWrite = vi.fn();
    const result = await applyMauticAction(deps, toAction(emailDraft()), { ...dry, beforeWrite });
    expect(result).toMatchObject({ ok: true, dryRun: true });
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(posts(calls)).toHaveLength(0);
  });

  it('sends the same requests with and without beforeWrite', async () => {
    const without = recording();
    const withGuard = recording();
    const act = toAction(segmentDraft('mautic.segment.add_contact'));
    const a = await applyMauticAction(without.deps, act, live);
    const b = await applyMauticAction(withGuard.deps, act, { ...live, beforeWrite: () => undefined });
    expect(a).toEqual(b);
    expect(without.calls).toEqual(withGuard.calls);
  });
});
