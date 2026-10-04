import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { userInfo } from 'node:os';
import { AutopilotError } from '../core/errors';
import type { PlanPreview, Runtime } from '../core/types';
import { previewPlan } from '../plan/preview';

export interface ReviewHandle {
  /** `http://127.0.0.1:<port>/<token>/`; the token is part of the path. */
  url: string;
  done: Promise<'approved' | 'rejected' | 'expired'>;
  close(): void;
}

type Outcome = 'approved' | 'rejected' | 'expired';

const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_BODY_BYTES = 1024;
const TOKEN_HEX_LENGTH = 32;

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function headerValue(value: string | string[] | undefined): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : value.join(',');
}

function sendText(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(message);
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>, after?: () => void): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body), after);
}

/** Bodies carry nothing; a request that sends more than 1 KB is cut off. */
function discardBody(req: IncomingMessage): void {
  let seen = 0;
  req.on('data', (chunk: Buffer) => {
    seen += chunk.length;
    if (seen > MAX_BODY_BYTES) req.destroy();
  });
  req.on('error', () => undefined);
  req.resume();
}

function renderPage(preview: PlanPreview, token: string, nonce: string): string {
  const allowed = preview.policy.allowed;
  const title = escapeHtml(preview.plan.title);
  const approveButton = allowed ? '<button id="approve" type="button">Approve</button>' : '';
  const note = allowed
    ? 'Approving authorises exactly the changes shown above, once.'
    : 'The policy denies this plan, so it cannot be approved. The denials are listed above.';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review: ${title}</title>
<style>
body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 24px 16px; background: #fff; color: #111; }
main { max-width: 960px; margin: 0 auto; }
h1 { font-size: 22px; margin: 0 0 4px; }
.meta { color: #555; font-size: 13px; word-break: break-all; margin: 0 0 16px; }
pre { font: 13px/1.5 ui-monospace, Menlo, monospace; background: #f5f5f5; border: 1px solid #ddd; border-radius: 6px; padding: 16px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
.actions { display: flex; gap: 12px; margin: 16px 0 8px; }
button { font: inherit; padding: 8px 20px; border-radius: 6px; border: 1px solid #888; background: #fff; color: #111; cursor: pointer; }
button#approve { background: #14532d; border-color: #14532d; color: #fff; }
button:disabled { opacity: 0.5; cursor: default; }
#status { min-height: 24px; font-weight: 600; }
@media (prefers-color-scheme: dark) {
  body { background: #111; color: #eee; }
  .meta { color: #aaa; }
  pre { background: #1c1c1c; border-color: #333; }
  button { background: #1c1c1c; color: #eee; border-color: #666; }
}
</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p class="meta">Plan ${escapeHtml(preview.plan.id)} &middot; account ${escapeHtml(preview.plan.accountId)}</p>
<pre id="review">${escapeHtml(preview.review)}</pre>
<p class="meta">Review digest: <code id="digest">${escapeHtml(preview.reviewDigest)}</code></p>
<p>${note}</p>
<div class="actions">${approveButton}<button id="reject" type="button">Reject</button></div>
<p id="status" role="status"></p>
</main>
<script nonce="${nonce}">
(function () {
  var token = ${JSON.stringify(token)};
  var status = document.getElementById('status');
  var buttons = Array.prototype.slice.call(document.querySelectorAll('button'));
  function decide(action) {
    buttons.forEach(function (button) { button.disabled = true; });
    status.textContent = 'Sending...';
    fetch(action, { method: 'POST', headers: { 'x-autopilot-token': token } })
      .then(function (response) {
        return response.text().then(function (text) {
          var body = {};
          try { body = JSON.parse(text); } catch (error) { body = { message: text }; }
          if (response.ok) {
            status.textContent = body.status === 'approved'
              ? 'Approved. Receipt ' + body.receiptId + ', valid until ' + body.expiresAt + '. You can close this page.'
              : 'Rejected. You can close this page.';
          } else {
            status.textContent = 'Not recorded: ' + (body.message || ('HTTP ' + response.status));
          }
        });
      })
      .catch(function () { status.textContent = 'Not recorded: the review server is no longer running.'; });
  }
  buttons.forEach(function (button) {
    button.addEventListener('click', function () { decide(button.id); });
  });
})();
</script>
</body>
</html>
`;
}

/**
 * Serves one plan's review page on the loopback interface. Approving issues a receipt with
 * method 'local_ui' bound to the plan digest and the review text shown.
 */
export async function startReviewServer(
  planId: string,
  runtime: Runtime,
  options?: { port?: number; timeoutMs?: number; approver?: string },
): Promise<ReviewHandle> {
  const shown = await previewPlan(planId, runtime);
  const token = randomBytes(TOKEN_HEX_LENGTH / 2).toString('hex');
  const approver = options?.approver ?? userInfo().username;
  const actor = { kind: 'human' as const, id: approver };

  let port = 0;
  let outcome: Outcome | null = null;
  // Set as soon as a decision is recorded, before any response is written: a decision is final
  // whatever happens to the socket that carried it.
  let decided: Outcome | null = null;
  // Set while an approve or reject is being processed, so two concurrent requests cannot both decide.
  let deciding = false;
  let timer: NodeJS.Timeout | null = null;
  let resolveDone: (value: Outcome) => void = () => undefined;
  const done = new Promise<Outcome>((resolve) => {
    resolveDone = resolve;
  });

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else sendJson(res, 500, { status: 'error', message: 'The review server failed to process this request.' });
    });
  });

  function finish(result: Outcome): void {
    if (outcome !== null) return;
    outcome = result;
    if (timer !== null) clearTimeout(timer);
    server.close();
    server.closeAllConnections();
    resolveDone(result);
  }

  /**
   * Answers a recorded decision and ends the server once the response is flushed or its
   * connection is gone, whichever comes first. A disconnected client never fires the end callback.
   */
  function settle(res: ServerResponse, body: Record<string, unknown>, result: Outcome): void {
    if (res.destroyed || res.socket === null || res.socket.destroyed) {
      finish(result);
      return;
    }
    res.once('close', () => finish(result));
    sendJson(res, 200, body, () => finish(result));
  }

  async function approve(res: ServerResponse): Promise<void> {
    if (!shown.policy.allowed) {
      sendJson(res, 403, { status: 'denied', message: 'The policy denies this plan; it cannot be approved.' });
      return;
    }
    const current = await previewPlan(planId, runtime);
    if (
      !current.policy.allowed
      || current.plan.digest !== shown.plan.digest
      || current.reviewDigest !== shown.reviewDigest
    ) {
      sendJson(res, 409, {
        status: 'stale',
        message: 'The plan or its review changed since this page was loaded. Restart the review and read it again.',
      });
      return;
    }
    const receipt = runtime.approvals.issue({
      plan: current.plan,
      policyDigest: current.policy.policyDigest,
      reviewDigest: current.reviewDigest,
      method: 'local_ui',
      approver,
      now: runtime.now(),
    });
    runtime.ledger.append({
      event: 'plan.approved',
      actor,
      accountId: current.plan.accountId,
      planId: current.plan.id,
      data: {
        receiptId: receipt.id,
        method: 'local_ui',
        planDigest: current.plan.digest,
        reviewDigest: current.reviewDigest,
        expiresAt: receipt.expiresAt,
      },
    });
    decided = 'approved';
    settle(res, { status: 'approved', receiptId: receipt.id, expiresAt: receipt.expiresAt }, 'approved');
  }

  function reject(res: ServerResponse): void {
    const plan = runtime.store.getPlan(planId);
    runtime.ledger.append({
      event: 'plan.rejected',
      actor,
      accountId: plan.accountId,
      planId: plan.id,
      data: { method: 'local_ui', planDigest: plan.digest, reviewDigest: shown.reviewDigest },
    });
    runtime.store.savePlan({ ...plan, status: 'rejected' });
    decided = 'rejected';
    settle(res, { status: 'rejected' }, 'rejected');
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    discardBody(req);
    if (headerValue(req.headers.host) !== `127.0.0.1:${port}`) {
      sendText(res, 403, 'Forbidden');
      return;
    }
    const rawPath = (req.url ?? '').split('?')[0] ?? '';
    const prefix = rawPath.slice(0, TOKEN_HEX_LENGTH + 2);
    if (!safeEqual(prefix, `/${token}/`)) {
      sendText(res, 404, 'Not found');
      return;
    }
    const rest = rawPath.slice(TOKEN_HEX_LENGTH + 2);

    if (req.method === 'GET' && rest === '') {
      const nonce = randomBytes(16).toString('base64');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy':
          `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'`,
      });
      res.end(renderPage(shown, token, nonce));
      return;
    }

    if (req.method !== 'POST' || (rest !== 'approve' && rest !== 'reject')) {
      sendText(res, 404, 'Not found');
      return;
    }
    if (
      !safeEqual(headerValue(req.headers['x-autopilot-token']), token)
      || headerValue(req.headers.origin) !== `http://127.0.0.1:${port}`
    ) {
      sendText(res, 403, 'Forbidden');
      return;
    }
    if (decided !== null || outcome !== null || deciding) {
      sendJson(res, 409, { status: 'decided', message: 'This review was already decided.' });
      return;
    }
    deciding = true;
    try {
      if (rest === 'approve') await approve(res);
      else reject(res);
    } finally {
      deciding = false;
    }
  }

  await new Promise<void>((resolve, reject_) => {
    server.once('error', (error) => {
      reject_(new AutopilotError('internal', 'The review server could not start on 127.0.0.1.', {
        hint: 'Pick another port, or leave the port out to use a free one.',
        cause: error,
      }));
    });
    server.listen(options?.port ?? 0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  timer = setTimeout(() => finish('expired'), options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  return {
    url: `http://127.0.0.1:${port}/${token}/`,
    done,
    close: () => finish('expired'),
  };
}
