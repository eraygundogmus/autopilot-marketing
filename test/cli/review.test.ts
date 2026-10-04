import { request } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startReviewServer } from '../../src/cli/review';
import type { ReviewHandle } from '../../src/cli/review';
import type { Autonomy, Plan, Runtime } from '../../src/core/types';
import { proposePlan } from '../../src/ops/plans';
import { previewPlan } from '../../src/plan/preview';
import { tempRuntime } from '../helpers/runtime';

// Runs before each previewPlan call; a test sets it to hold the server inside an approval.
const gate: { before: (() => Promise<void>) | null } = { before: null };

vi.mock('../../src/plan/preview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/plan/preview')>();
  return {
    ...actual,
    previewPlan: async (planId: string, runtime: Runtime) => {
      if (gate.before !== null) await gate.before();
      return actual.previewPlan(planId, runtime);
    },
  };
});

const TITLE = 'Pause <b>generic</b> & "wasteful" campaign';
const open: ReviewHandle[] = [];

async function setup(
  autonomy: Autonomy = 'approve',
  options: { timeoutMs?: number } = {},
): Promise<{ runtime: Runtime; plan: Plan; handle: ReviewHandle; origin: string; token: string }> {
  const { runtime } = tempRuntime({ config: { autonomy } });
  const plan = await proposePlan(runtime, {
    accountId: 'demo-google',
    title: TITLE,
    rationale: 'Spend without conversions.',
    actions: [{
      kind: 'google_ads.campaign.pause',
      target: { level: 'campaign', id: 'c4' },
      params: {},
      rationale: 'No conversions in the period.',
    }],
    createdBy: 'cli',
  });
  const handle = await startReviewServer(plan.id, runtime, { approver: 'tester', ...options });
  open.push(handle);
  const url = new URL(handle.url);
  return { runtime, plan, handle, origin: url.origin, token: url.pathname.split('/')[1] ?? '' };
}

function post(handle: ReviewHandle, action: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`${handle.url}${action}`, { method: 'POST', headers });
}

function statusWithHost(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET', headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

afterEach(() => {
  gate.before = null;
  for (const handle of open.splice(0)) handle.close();
});

describe('startReviewServer', () => {
  it('serves the escaped review on a loopback url with strict headers', async () => {
    const { runtime, plan, handle, token } = await setup();
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/$/);
    const preview = await previewPlan(plan.id, runtime);

    const res = await fetch(handle.url);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const csp = res.headers.get('content-security-policy') ?? '';
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(nonce).toBeTruthy();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain('Pause &lt;b&gt;generic&lt;/b&gt; &amp; &quot;wasteful&quot; campaign');
    expect(html).not.toContain('<b>generic</b>');
    expect(html).toContain(preview.reviewDigest);
    expect(html).toContain('id="approve"');
    expect(html).toContain('id="reject"');
    expect(html).toContain(token);
    expect(html).not.toMatch(/(src|href)=/);
  });

  it('answers 404 for a wrong token or unknown route and 403 for a wrong Host', async () => {
    const { handle, origin, token } = await setup();
    expect((await fetch(`${origin}/${'0'.repeat(32)}/`)).status).toBe(404);
    expect((await fetch(`${origin}/`)).status).toBe(404);
    expect((await fetch(`${origin}/${token}`)).status).toBe(404);
    expect((await fetch(`${handle.url}other`)).status).toBe(404);
    expect((await fetch(`${handle.url}approve`)).status).toBe(404);
    expect(await statusWithHost(handle.url, 'evil.example')).toBe(403);
    expect(await statusWithHost(handle.url, `localhost:${new URL(origin).port}`)).toBe(403);
  });

  it('refuses a POST without the token header or with a foreign Origin', async () => {
    const { runtime, plan, handle, origin, token } = await setup();
    expect((await post(handle, 'approve', { origin })).status).toBe(403);
    expect((await post(handle, 'approve', { origin, 'x-autopilot-token': 'f'.repeat(32) })).status).toBe(403);
    expect((await post(handle, 'approve', { 'x-autopilot-token': token })).status).toBe(403);
    expect((await post(handle, 'reject', { origin: 'http://evil.example', 'x-autopilot-token': token })).status).toBe(403);
    expect(runtime.store.findReceipts(plan.id)).toHaveLength(0);
    expect(runtime.store.getPlan(plan.id).status).not.toBe('rejected');
  });

  it('approves once: issues a verifiable receipt and logs plan.approved', async () => {
    const { runtime, plan, handle, origin, token } = await setup();
    const preview = await previewPlan(plan.id, runtime);
    const headers = { origin, 'x-autopilot-token': token };

    const res = await post(handle, 'approve', headers);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; receiptId: string; expiresAt: string };
    expect(body.status).toBe('approved');
    expect(await handle.done).toBe('approved');

    const receipt = runtime.approvals.verify({
      plan: runtime.store.getPlan(plan.id),
      policyDigest: preview.policy.policyDigest,
      receiptId: body.receiptId,
      now: runtime.now(),
    });
    expect(receipt.method).toBe('local_ui');
    expect(receipt.approver).toBe('tester');
    expect(receipt.reviewDigest).toBe(preview.reviewDigest);
    expect(receipt.expiresAt).toBe(body.expiresAt);

    const entry = runtime.ledger.read().find((item) => item.event === 'plan.approved');
    expect(entry?.actor).toEqual({ kind: 'human', id: 'tester' });
    expect(entry?.planId).toBe(plan.id);
    expect(entry?.data).toMatchObject({ receiptId: body.receiptId, method: 'local_ui', planDigest: plan.digest });

    const second = await post(handle, 'approve', headers).then((r) => r.status, () => 'closed');
    expect(second).not.toBe(200);
    expect(runtime.store.findReceipts(plan.id)).toHaveLength(1);
  });

  it('ends as approved, with one receipt, when the client disconnects during approval', async () => {
    const { runtime, plan, handle, origin, token } = await setup();
    let entered: () => void = () => undefined;
    let release: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    gate.before = async () => {
      entered();
      await held;
    };

    const req = request(`${handle.url}approve`, { method: 'POST', headers: { origin, 'x-autopilot-token': token } });
    req.on('error', () => undefined);
    const gone = new Promise<void>((resolve) => { req.once('close', () => resolve()); });
    req.end();
    await inside;
    req.destroy();
    await gone;
    await new Promise((resolve) => setTimeout(resolve, 100));
    gate.before = null;
    release();

    const result = await Promise.race([
      handle.done,
      new Promise<string>((resolve) => setTimeout(() => resolve('still listening'), 2000)),
    ]);
    expect(result).toBe('approved');
    expect(runtime.store.findReceipts(plan.id)).toHaveLength(1);
    expect(runtime.ledger.read().filter((item) => item.event === 'plan.approved')).toHaveLength(1);
    const second = await post(handle, 'reject', { origin, 'x-autopilot-token': token }).then((r) => r.status, () => 'closed');
    expect(second).not.toBe(200);
    expect(runtime.store.getPlan(plan.id).status).not.toBe('rejected');
  });

  it('refuses approval when the plan changed after the page was served', async () => {
    const { runtime, plan, handle, origin, token } = await setup();
    runtime.store.savePlan({ ...plan, title: 'Something else' });
    const res = await post(handle, 'approve', { origin, 'x-autopilot-token': token });
    expect(res.status).toBe(409);
    expect(runtime.store.findReceipts(plan.id)).toHaveLength(0);
  });

  it('reject marks the plan rejected and logs it', async () => {
    const { runtime, plan, handle, origin, token } = await setup();
    const res = await post(handle, 'reject', { origin, 'x-autopilot-token': token });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'rejected' });
    expect(await handle.done).toBe('rejected');
    expect(runtime.store.getPlan(plan.id).status).toBe('rejected');
    expect(runtime.ledger.read().some((item) => item.event === 'plan.rejected' && item.planId === plan.id)).toBe(true);
    expect(runtime.store.findReceipts(plan.id)).toHaveLength(0);
  });

  it('expires after the timeout and on close()', async () => {
    const timed = await setup('approve', { timeoutMs: 20 });
    expect(await timed.handle.done).toBe('expired');
    await expect(fetch(timed.handle.url)).rejects.toThrow();

    const closed = await setup();
    closed.handle.close();
    expect(await closed.handle.done).toBe('expired');
  });

  it('serves a denied plan without an Approve button and refuses approve', async () => {
    const { runtime, plan, handle, origin, token } = await setup('propose');
    const html = await (await fetch(handle.url)).text();
    expect(html).not.toContain('id="approve"');
    expect(html).toContain('id="reject"');
    const res = await post(handle, 'approve', { origin, 'x-autopilot-token': token });
    expect(res.status).toBe(403);
    expect(runtime.store.findReceipts(plan.id)).toHaveLength(0);
    expect(runtime.ledger.read().some((item) => item.event === 'plan.approved')).toBe(false);
  });
});
