import { createHash, randomBytes } from 'node:crypto';
import { acceptedContent, createRequestStateCodec, inputRequired } from '@modelcontextprotocol/server';
import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { AutopilotError } from '../../core/errors';
import { ACTION_KINDS } from '../../core/types';
import type { Action, ActionDraft, ApplyOutcome, JsonObject, JsonValue, Plan, Runtime } from '../../core/types';
import { proposePlan } from '../../ops/plans';
import type { ProposeInput } from '../../ops/plans';
import { applyPlan, createRevertPlan } from '../../plan/executor';
import { previewPlan } from '../../plan/preview';
import { fail, ok } from '../result';

const MAX_ACTIONS_SHOWN = 50;
const MAX_REVIEW_CHARS = 6000;
const AGENT = { kind: 'agent', id: 'mcp' } as const;

const ENTITY_LEVELS = [
  'account',
  'campaign',
  'ad_group',
  'ad',
  'keyword',
  'search_term',
  'device',
  'placement',
  'conversion_action',
  'segment',
  'email',
] as const;

const targetSchema = z.object({
  level: z.enum(ENTITY_LEVELS).describe('Entity level of the target'),
  id: z.string().min(1).describe('Platform id of the target entity'),
  name: z.string().optional().describe('Display name of the target, for the review text'),
  campaignId: z.string().optional().describe('Parent campaign id, when the target is below a campaign'),
  adGroupId: z.string().optional().describe('Parent ad group id, when the target is below an ad group'),
});

const actionSchema = z.object({
  kind: z.enum(ACTION_KINDS).describe('One of the allowlisted action kinds'),
  target: targetSchema.describe('The entity the action changes'),
  params: z
    .record(z.string(), z.unknown())
    .describe('Parameters of the kind, e.g. { dailyBudget } or { bid } in account currency; {} for pause and enable'),
  rationale: z.string().min(1).describe('Why this change is proposed'),
});

const confirmSchema = z.object({ confirm: z.boolean().describe('Apply these changes to the live account') });

const actionsOutput = z.array(z.looseObject({}));

/** What a confirmation prompt showed. An accepted answer authorises only this plan, at these digests. */
export interface ConfirmState {
  planId: string;
  planDigest: string;
  policyDigest: string;
  /** sha256 of the exact message the person was shown. */
  shownDigest: string;
}

const confirmStateSchema = z.object({
  planId: z.string(),
  planDigest: z.string(),
  policyDigest: z.string(),
  shownDigest: z.string(),
});

// The key lives only in this process: one process serves every round of a confirmation, and a state minted
// by another process is rejected.
const confirmCodec = createRequestStateCodec<ConfirmState>({ key: randomBytes(32), ttlSeconds: 600 });

/** The `ServerOptions.requestState.verify` hook: rejects any request state this process did not sign. */
export function verifyRequestState(state: string, ctx: ServerContext): Promise<ConfirmState> {
  return confirmCodec.verify(state, ctx);
}

/**
 * The signed state of this round, or undefined when there is none or it does not verify. With the server hook
 * wired the accessor returns the decoded payload; without it, the raw wire string, which is verified here.
 */
async function confirmedState(ctx: ServerContext): Promise<ConfirmState | undefined> {
  const raw = ctx.mcpReq.requestState<unknown>();
  if (raw === undefined) return undefined;
  try {
    return confirmStateSchema.parse(typeof raw === 'string' ? await confirmCodec.verify(raw, ctx) : raw);
  } catch {
    return undefined;
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** A confirmation prompt is sent only when it can carry the whole review: acceptance authorises the whole plan. */
export function reviewFitsElicitation(review: string): boolean {
  return review.length <= MAX_REVIEW_CHARS;
}

export function reviewTooLongError(planId: string): AutopilotError {
  return new AutopilotError('approval_required', `Plan ${planId} has no approval.`, {
    hint: `This plan is too long for an in-client confirmation. A person must review it in full in a terminal: autopilot-marketing review ${planId} or autopilot-marketing approve ${planId}`,
  });
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

function compact(value: unknown): string {
  return value === null || value === undefined ? 'unknown' : JSON.stringify(value);
}

function targetLabel(action: Action): string {
  const { level, id, name } = action.target;
  return name === undefined ? `${level} ${id}` : `${level} ${id} (${name})`;
}

function actionRows(plan: Plan): JsonValue[] {
  return plan.actions.slice(0, MAX_ACTIONS_SHOWN).map((action) =>
    json({
      id: action.id,
      kind: action.kind,
      target: action.target,
      before: action.before,
      after: action.after,
      spendEffect: action.spendEffect,
      spendDeltaPerDay: action.spendDeltaPerDay,
      reversible: action.reversible,
    }),
  );
}

function actionLines(plan: Plan): string[] {
  const lines = plan.actions
    .slice(0, MAX_ACTIONS_SHOWN)
    .map((action) => `- ${action.kind} ${targetLabel(action)}: ${compact(action.before)} -> ${compact(action.after)}`);
  const hidden = plan.actions.length - MAX_ACTIONS_SHOWN;
  if (hidden > 0) lines.push(`- and ${hidden} more`);
  return lines;
}

function applyResult(planId: string, outcome: ApplyOutcome): { structured: JsonObject; text: string } {
  const results = outcome.results.slice(0, MAX_ACTIONS_SHOWN).map((entry) => ({
    actionId: entry.actionId,
    status: entry.status,
    note: entry.note ?? null,
    error: entry.result?.error ?? null,
  }));
  const lines = [
    `Plan ${planId}${outcome.dryRun ? ' (dry run)' : ''}: ${outcome.applied} applied, ${outcome.failed} failed, ${outcome.skipped} skipped, ${outcome.unknown} unknown.`,
    ...results.map((entry) => {
      const detail = entry.error?.message ?? entry.note;
      return `- ${entry.actionId}: ${entry.status}${detail ? ` (${detail})` : ''}`;
    }),
  ];
  if (outcome.dryRun) lines.push('Nothing was changed.');
  if (outcome.unknown > 0) {
    lines.push('An outcome is unknown: do not retry; a person must check the entity in the ad platform.');
  }
  return {
    structured: {
      planId,
      dryRun: outcome.dryRun,
      executionId: outcome.executionId,
      status: outcome.plan.status,
      applied: outcome.applied,
      failed: outcome.failed,
      skipped: outcome.skipped,
      unknown: outcome.unknown,
      results: json(results),
    },
    text: lines.join('\n'),
  };
}

export function register(server: McpServer, runtime: Runtime): void {
  server.registerTool(
    'plan_create',
    {
      title: 'Create a change plan',
      description:
        'Turns audit findings (auditId plus findingIds) or explicit typed actions into a stored plan, recording the current state of every target. Only allowlisted action kinds exist: there is no delete and no raw API call. Creating a plan changes nothing in the ad account; it returns the plan id, digest and each action with its before and after values.',
      inputSchema: z.object({
        accountId: z.string().describe('Id of the configured account the plan is for'),
        title: z.string().min(1).describe('Short title of the plan'),
        rationale: z.string().min(1).describe('Why these changes are proposed'),
        snapshotId: z.string().optional().describe('Snapshot the plan is built on'),
        auditId: z.string().optional().describe('Audit whose findings suggest the actions'),
        findingIds: z
          .array(z.string())
          .optional()
          .describe('Finding ids from that audit to take actions from; all findings when omitted'),
        actions: z.array(actionSchema).optional().describe('Explicit actions, instead of audit findings'),
      }),
      outputSchema: z.looseObject({
        planId: z.string(),
        digest: z.string(),
        status: z.string(),
        accountId: z.string(),
        actions: actionsOutput,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const input: ProposeInput = {
          accountId: args.accountId,
          title: args.title,
          rationale: args.rationale,
          createdBy: 'agent',
          ...(args.snapshotId === undefined ? {} : { snapshotId: args.snapshotId }),
          ...(args.auditId === undefined ? {} : { auditId: args.auditId }),
          ...(args.findingIds === undefined ? {} : { findingIds: args.findingIds }),
          ...(args.actions === undefined ? {} : { actions: json(args.actions) as unknown as ActionDraft[] }),
        };
        const plan = await proposePlan(runtime, input);
        return ok(
          {
            planId: plan.id,
            digest: plan.digest,
            status: plan.status,
            accountId: plan.accountId,
            actions: actionRows(plan),
          },
          [`Plan ${plan.id} (${plan.status}), ${plan.actions.length} action(s):`, ...actionLines(plan), 'Next: plan_preview'].join(
            '\n',
          ),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'plan_preview',
    {
      title: 'Preview a plan',
      description:
        'Evaluates a stored plan against the owner policy and the safety gate and returns the exact review text a person approves, with totals and what approval is still needed. Use it after plan_create and before plan_apply. It changes nothing in the ad account.',
      inputSchema: z.object({ planId: z.string().describe('Id of the stored plan') }),
      outputSchema: z.looseObject({
        planId: z.string(),
        digest: z.string(),
        policy: z.looseObject({ allowed: z.boolean(), autoApplicable: z.boolean(), denials: z.array(z.looseObject({})) }),
        gate: z.unknown(),
        approval: z.looseObject({}),
        totals: z.looseObject({}),
        reviewDigest: z.string(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ planId }) => {
      try {
        const preview = await previewPlan(planId, runtime);
        return ok(
          {
            planId: preview.plan.id,
            digest: preview.plan.digest,
            policy: {
              allowed: preview.policy.allowed,
              autoApplicable: preview.policy.autoApplicable,
              denials: json(preview.policy.results.filter((result) => result.outcome === 'deny')),
            },
            gate: json(preview.gate),
            approval: json(preview.approval),
            totals: json(preview.totals),
            reviewDigest: preview.reviewDigest,
          },
          preview.review,
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'plan_apply',
    {
      title: 'Apply a plan',
      description:
        'Defaults to a dry run that validates the plan with the platform and changes nothing. A live run (dryRun false) executes only a stored plan that passes the policy and has an approval given by a person outside this conversation, or that falls within the owner\'s auto-apply policy. The agent cannot approve a plan; returns per-action results and counts.',
      inputSchema: z.object({
        planId: z.string().describe('Id of the stored plan'),
        dryRun: z.boolean().default(true).describe('True (default) validates only; false changes the live account'),
        receiptId: z.string().optional().describe('Approval receipt id a person obtained in a terminal'),
      }),
      outputSchema: z.looseObject({
        planId: z.string(),
        dryRun: z.boolean(),
        executionId: z.string().nullable(),
        status: z.string(),
        applied: z.number(),
        failed: z.number(),
        skipped: z.number(),
        unknown: z.number(),
        results: z.array(z.looseObject({})),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ planId, dryRun, receiptId }, ctx) => {
      try {
        if (dryRun) {
          const shaped = applyResult(planId, await applyPlan(planId, runtime, { dryRun: true, actor: AGENT }));
          return ok(shaped.structured, shaped.text);
        }
        let outcome: ApplyOutcome;
        try {
          outcome = await applyPlan(planId, runtime, {
            dryRun: false,
            actor: AGENT,
            ...(receiptId === undefined ? {} : { receiptId }),
          });
        } catch (error) {
          const needsApproval = error instanceof AutopilotError && error.code === 'approval_required';
          if (!needsApproval || !server.server.getClientCapabilities()?.elicitation) return fail(error);

          const preview = await previewPlan(planId, runtime);
          if (!reviewFitsElicitation(preview.review)) return fail(reviewTooLongError(planId));
          const responses = ctx.mcpReq.inputResponses;
          const answer = acceptedContent(responses, 'confirm', confirmSchema);
          if (answer === undefined) {
            // An answer that is present but not an accepted form is a refusal, not a reason to ask again.
            if (responses !== undefined && 'confirm' in responses) {
              return fail(new AutopilotError('approval_required', 'The person declined.'));
            }
            const message = `${preview.review}\n\nApply exactly these changes?`;
            return inputRequired({
              inputRequests: {
                confirm: inputRequired.elicit({ message, requestedSchema: confirmSchema }),
              },
              requestState: await confirmCodec.mint({
                planId,
                planDigest: preview.plan.digest,
                policyDigest: preview.policy.policyDigest,
                shownDigest: sha256(message),
              }),
            });
          }
          if (answer.confirm !== true) {
            return fail(new AutopilotError('approval_required', 'The person declined.'));
          }
          // An accepted answer counts only with the signed record of what was shown, for this plan as it is now.
          const state = await confirmedState(ctx);
          if (state === undefined) {
            return fail(
              new AutopilotError('approval_required', `Plan ${planId} has no approval.`, {
                hint: 'The confirmation is not bound to a prompt this server showed. Call plan_apply again to be asked.',
              }),
            );
          }
          if (
            state.planId !== planId ||
            state.planDigest !== preview.plan.digest ||
            state.policyDigest !== preview.policy.policyDigest
          ) {
            return fail(
              new AutopilotError('stale_state', 'The confirmation was given for a different plan, plan content or policy.', {
                hint: 'Call plan_apply again so the person is shown the current review.',
              }),
            );
          }
          outcome = await applyPlan(planId, runtime, {
            dryRun: false,
            actor: AGENT,
            elicitedBy: server.server.getClientVersion()?.name ?? 'mcp-client',
            reviewDigest: state.shownDigest,
          });
        }
        const shaped = applyResult(planId, outcome);
        return ok(shaped.structured, shaped.text);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'plan_revert',
    {
      title: 'Create a revert plan',
      description:
        'Creates a new plan that restores the values an applied plan changed. It changes nothing by itself: the new plan must be previewed, approved and applied like any other. Returns the new plan id and its actions.',
      inputSchema: z.object({ planId: z.string().describe('Id of the applied plan to revert') }),
      outputSchema: z.looseObject({
        planId: z.string(),
        revertsPlanId: z.string(),
        digest: z.string(),
        actions: actionsOutput,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ planId }) => {
      try {
        const plan = await createRevertPlan(planId, runtime);
        return ok(
          {
            planId: plan.id,
            revertsPlanId: plan.revertsPlanId ?? planId,
            digest: plan.digest,
            actions: actionRows(plan),
          },
          [
            `Plan ${plan.id} reverts ${plan.revertsPlanId ?? planId}, ${plan.actions.length} action(s):`,
            ...actionLines(plan),
            'This is a new plan: preview it and have it approved like any other. Money already spent is not recovered.',
          ].join('\n'),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );
}
