import { AutopilotError } from '../core/errors';
import { canonicalJson, shortId } from '../core/ids';
import { ACTION_KINDS } from '../core/types';
import type {
  AccountConfig, Action, ActionDraft, ActionKind, Connector, DatasetName, EntityLevel, EntityRef,
  Finding, Plan, Snapshot,
} from '../core/types';
import { actionSpec, buildAction, planDigest, validateDraft } from './actions';

const DEFAULT_MAX_ACTIONS = 25;
const MAX_DRAFTS_PER_PLAN = 200;
const TARGET_DATASETS: Partial<Record<EntityLevel, DatasetName>> = {
  campaign: 'campaigns',
  ad_group: 'ad_groups',
  ad: 'ads',
  keyword: 'keywords',
  segment: 'segments',
};

/**
 * Fields that describe a child of the target named by the params (a negative keyword of a campaign,
 * a contact of a segment, a new email of an account), not the target itself. Two drafts on one
 * target collide on such a field only when they name the same child.
 */
const CHILD_FIELDS = ['exists', 'member'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isActionKind(kind: unknown): kind is ActionKind {
  return typeof kind === 'string' && (ACTION_KINDS as readonly string[]).includes(kind);
}

function monthlyImpact(finding: Finding): number {
  const monthly = finding.impact?.monthly;
  return typeof monthly === 'number' && Number.isFinite(monthly) ? monthly : Number.NEGATIVE_INFINITY;
}

function draftKey(draft: ActionDraft): string {
  return canonicalJson([draft.kind, draft.target.level, draft.target.id, draft.params]);
}

/**
 * Target names and ancestry come from the referenced snapshot row and from nowhere else: the
 * draft's own metadata is supplied by the caller and is never used.
 */
function snapshotTarget(target: EntityRef, snapshot: Snapshot | null): EntityRef {
  const dataset = TARGET_DATASETS[target.level];
  const source = dataset === undefined ? undefined : snapshot?.datasets?.[dataset]?.find((item) => item.id === target.id);
  return {
    level: target.level,
    id: target.id,
    ...(typeof source?.name !== 'string' ? {} : { name: source.name }),
    ...(typeof source?.campaignId !== 'string' ? {} : { campaignId: source.campaignId }),
    ...(typeof source?.adGroupId !== 'string' ? {} : { adGroupId: source.adGroupId }),
  };
}

/** Suggested actions of the findings, de-duplicated by kind and target, largest impact first. */
export function draftsFromFindings(findings: Finding[], maxActions: number = DEFAULT_MAX_ACTIONS): ActionDraft[] {
  const limit = Number.isFinite(maxActions) ? Math.max(0, Math.floor(maxActions)) : DEFAULT_MAX_ACTIONS;
  const ordered = findings
    .filter((finding) => finding.dataStatus === 'sufficient')
    .map((finding, index) => ({ finding, index, monthly: monthlyImpact(finding) }))
    .sort((a, b) => (a.monthly === b.monthly ? a.index - b.index : a.monthly > b.monthly ? -1 : 1));

  const byKey = new Map<string, { draft: ActionDraft; findingIds: string[] }>();
  for (const { finding } of ordered) {
    for (const draft of finding.suggestedActions ?? []) {
      const ids = [...(draft.findingIds ?? []), finding.id];
      const key = draftKey(draft);
      const kept = byKey.get(key);
      if (kept === undefined) {
        byKey.set(key, { draft, findingIds: [...new Set(ids)] });
      } else {
        for (const id of ids) if (!kept.findingIds.includes(id)) kept.findingIds.push(id);
      }
    }
  }
  return [...byKey.values()].slice(0, limit).map(({ draft, findingIds }) => ({ ...draft, findingIds }));
}

/** Problems of one draft; a malformed draft is reported instead of thrown on. */
function draftProblems(draft: unknown): string[] {
  if (!isRecord(draft)) return ['must be an object with kind, target, params and rationale'];
  const shape: string[] = [];
  if (!isRecord(draft['target'])) shape.push('target must be an object with level and id');
  if (!isRecord(draft['params'])) shape.push('params must be an object');
  if (shape.length > 0) return shape;
  return validateDraft(draft as unknown as ActionDraft);
}

/** `level:id:field` keys the draft writes; empty when its kind or shape is not usable. */
function writeKeys(draft: ActionDraft): string[] {
  if (!isRecord(draft) || !isRecord(draft.target) || !isRecord(draft.params) || !isActionKind(draft.kind)) return [];
  const spec = actionSpec(draft.kind);
  let fields: string[];
  try {
    fields = Object.keys(spec.after(null, draft.params));
  } catch {
    return [];
  }
  const entity = canonicalJson([draft.target.level, draft.target.id]);
  return fields.map((field) =>
    CHILD_FIELDS.includes(field) ? `${entity}:${field}:${canonicalJson(draft.params)}` : `${entity}:${field}`,
  );
}

function collectProblems(input: {
  account: AccountConfig;
  snapshot: Snapshot | null;
  drafts: ActionDraft[];
  title: string;
  rationale: string;
}): string[] {
  const problems: string[] = [];
  const drafts: ActionDraft[] = Array.isArray(input.drafts) ? input.drafts : [];
  if (typeof input.title !== 'string' || input.title.trim() === '') problems.push('title must not be empty');
  if (typeof input.rationale !== 'string' || input.rationale.trim() === '') problems.push('rationale must not be empty');
  if (drafts.length === 0) problems.push('a plan needs at least one draft');
  if (drafts.length > MAX_DRAFTS_PER_PLAN) {
    problems.push(`a plan holds at most ${MAX_DRAFTS_PER_PLAN} drafts, got ${drafts.length}`);
  }
  if (input.snapshot !== null && input.snapshot.accountId !== input.account.id) {
    problems.push(`snapshot ${input.snapshot.id} belongs to another account, not '${input.account.id}'`);
  }

  const writers = new Map<string, number>();
  drafts.forEach((draft, index) => {
    const at = `drafts[${index}]: `;
    for (const problem of draftProblems(draft)) problems.push(at + problem);
    if (isRecord(draft) && isActionKind(draft.kind)) {
      const platform = actionSpec(draft.kind).platform;
      if (platform !== input.account.platform) {
        problems.push(
          `${at}${draft.kind} is a ${platform} action, but account '${input.account.id}' is ${input.account.platform}`,
        );
      }
    }
    const clashes = new Set<number>();
    for (const key of writeKeys(draft)) {
      const earlier = writers.get(key);
      if (earlier === undefined) writers.set(key, index);
      else clashes.add(earlier);
    }
    for (const earlier of clashes) {
      problems.push(`${at}conflicts with drafts[${earlier}]: both change the same field of the same entity`);
    }
  });
  return problems;
}

/**
 * Validates the drafts (throws `invalid_input` listing every problem), reads each action's `before`
 * state through the connector, and returns a `proposed` plan with its digest.
 */
export async function createPlan(input: {
  account: AccountConfig;
  snapshot: Snapshot | null;
  drafts: ActionDraft[];
  title: string;
  rationale: string;
  createdBy: Plan['createdBy'];
  connector: Connector;
  now: Date;
  revertsPlanId?: string;
}): Promise<Plan> {
  const problems = collectProblems(input);
  if (problems.length > 0) {
    throw new AutopilotError('invalid_input', `The plan cannot be created:\n${problems.join('\n')}`, {
      hint: 'Fix every listed problem and create the plan again.',
    });
  }

  const actions: Action[] = [];
  for (const draft of input.drafts) {
    const normalized = { ...draft, target: snapshotTarget(draft.target, input.snapshot) };
    const before = await input.connector.readState(normalized);
    actions.push(buildAction(normalized, before));
  }

  const accountId = input.account.id;
  const platform = input.account.platform;
  const createdAt = input.now.toISOString();
  const snapshotId = input.snapshot?.id ?? null;
  const digest = planDigest({
    accountId,
    platform,
    actions,
    snapshotId,
    ...(input.revertsPlanId === undefined ? {} : { revertsPlanId: input.revertsPlanId }),
  });
  return {
    id: shortId('plan', { digest, createdAt }),
    schemaVersion: 1,
    createdAt,
    createdBy: input.createdBy,
    accountId,
    platform,
    snapshotId,
    title: input.title.trim(),
    rationale: input.rationale.trim(),
    actions,
    digest,
    status: 'proposed',
    ...(input.revertsPlanId === undefined ? {} : { revertsPlanId: input.revertsPlanId }),
  };
}
