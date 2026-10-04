import type { ActionDraft, ActionKind, CheckContext, DatasetName, EntityLevel, EntityRef, EvidenceRef, Row, Snapshot } from '../core/types';

/** Rows of a dataset, or an empty array. */
export function rows(snapshot: Snapshot, dataset: DatasetName): Row[] {
  return snapshot.datasets[dataset] ?? [];
}

/** Rows whose `attrs.status` is 'ENABLED' or absent. */
export function activeRows(snapshot: Snapshot, dataset: DatasetName): Row[] {
  return rows(snapshot, dataset).filter((row) => {
    const status = row.attrs['status'];
    return status === undefined || status === null || status === 'ENABLED';
  });
}

/** Evidence for one row, carrying the named metric and numeric attr values. */
export function evidence(snapshot: Snapshot, dataset: DatasetName, row: Row, keys: string[]): EvidenceRef {
  const metrics: Record<string, number> = {};
  for (const key of keys) {
    const metric = Object.hasOwn(row.metrics, key) ? row.metrics[key] : undefined;
    if (typeof metric === 'number') {
      metrics[key] = metric;
      continue;
    }
    const attr = Object.hasOwn(row.attrs, key) ? row.attrs[key] : undefined;
    if (typeof attr === 'number' && Number.isFinite(attr)) metrics[key] = attr;
  }
  const ref: EvidenceRef = { snapshotId: snapshot.id, dataset, rowId: row.id, metrics };
  if (row.name !== undefined) ref.label = row.name;
  return ref;
}

export function entity(level: EntityLevel, row: Row): EntityRef {
  const ref: EntityRef = { level, id: row.id };
  if (row.name !== undefined) ref.name = row.name;
  if (row.campaignId !== undefined) ref.campaignId = row.campaignId;
  if (row.adGroupId !== undefined) ref.adGroupId = row.adGroupId;
  return ref;
}

export function draft(kind: ActionKind, target: EntityRef, params: ActionDraft['params'], rationale: string): ActionDraft {
  return { kind, target, params, rationale };
}

/** The account's target CPA, else the account-wide CPA from `campaigns`, else null. */
export function referenceCpa(ctx: CheckContext): number | null {
  const target = ctx.account.targets?.cpa;
  if (target !== undefined) return target;
  let cost = 0;
  let conversions = 0;
  for (const row of rows(ctx.snapshot, 'campaigns')) {
    cost += row.metrics.cost ?? 0;
    conversions += row.metrics.conversions ?? 0;
  }
  return conversions > 0 ? cost / conversions : null;
}
