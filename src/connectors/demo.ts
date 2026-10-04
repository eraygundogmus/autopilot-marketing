import fs from 'node:fs';
import path from 'node:path';
import { addDays, assertRange, todayIso } from '../core/dates';
import { AutopilotError } from '../core/errors';
import { ensureHome, resolvePaths } from '../core/paths';
import { ACTION_KINDS } from '../core/types';
import type {
  Action,
  ActionDraft,
  ActionKind,
  ActionResult,
  AttrValue,
  Connector,
  ConnectorDeps,
  ConnectorStatus,
  DatasetName,
  DateRange,
  EntityLevel,
  JsonObject,
  Row,
  Snapshot,
  SnapshotRequest,
} from '../core/types';
import { actionSpec } from '../plan/actions';
import { demoDatasets } from './demo-data';
import { buildSnapshot } from './snapshot';

const STATE_FILE = 'demo-state.json';
const ENTITY_FIELDS = ['status', 'dailyBudget', 'bid'] as const;
const BASE_DAYS = 30;

const LEVEL_DATASETS: Partial<Record<EntityLevel, DatasetName>> = {
  campaign: 'campaigns',
  ad_group: 'ad_groups',
  ad: 'ads',
  keyword: 'keywords',
};

type EntityOverlay = Record<string, AttrValue>;

interface AccountOverlay {
  entities: Record<string, EntityOverlay>;
  negatives: Record<string, string[]>;
  members: Record<string, string[]>;
  emails: string[];
}

type DemoState = Record<string, AccountOverlay>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAttrValue(value: unknown): value is AttrValue {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function listMap(value: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!isRecord(value)) return out;
  for (const [key, list] of Object.entries(value)) out[key] = stringList(list);
  return out;
}

function emptyOverlay(): AccountOverlay {
  return { entities: {}, negatives: {}, members: {}, emails: [] };
}

function parseOverlay(value: unknown): AccountOverlay {
  if (!isRecord(value)) return emptyOverlay();
  const entities: Record<string, EntityOverlay> = {};
  const rawEntities = value['entities'];
  if (isRecord(rawEntities)) {
    for (const [key, raw] of Object.entries(rawEntities)) {
      if (!isRecord(raw)) continue;
      const entity: EntityOverlay = {};
      for (const field of ENTITY_FIELDS) {
        const fieldValue = raw[field];
        if (fieldValue !== undefined && isAttrValue(fieldValue)) entity[field] = fieldValue;
      }
      entities[key] = entity;
    }
  }
  return {
    entities,
    negatives: listMap(value['negatives']),
    members: listMap(value['members']),
    emails: stringList(value['emails']),
  };
}

function readStateFile(file: string): DemoState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  const state: DemoState = {};
  if (!isRecord(parsed)) return state;
  for (const [accountId, raw] of Object.entries(parsed)) state[accountId] = parseOverlay(raw);
  return state;
}

function writeStateFile(file: string, state: DemoState): void {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw new AutopilotError('internal', 'could not write the demo state file', { cause: error });
  }
}

function setMembership(map: Record<string, string[]>, key: string, item: string, present: boolean): void {
  const current = (map[key] ?? []).filter((entry) => entry !== item);
  if (present) current.push(item);
  if (current.length === 0) delete map[key];
  else map[key] = current;
}

function stringParam(params: JsonObject, name: string): string {
  const value = params[name];
  if (typeof value !== 'string' || value === '') {
    throw new AutopilotError('invalid_input', `params.${name} must be a non-empty string`);
  }
  return value;
}

function negativeKey(params: JsonObject): string {
  return `${stringParam(params, 'matchType')}:${stringParam(params, 'text')}`;
}

type KindShape = 'negative' | 'segment' | 'email' | 'entity';

function kindShape(kind: ActionKind): KindShape {
  if (kind.includes('.negative_keyword.')) return 'negative';
  if (kind.includes('.segment.')) return 'segment';
  if (kind.endsWith('.email.create_draft')) return 'email';
  return 'entity';
}

export function createDemoConnector(deps: ConnectorDeps): Connector {
  const { account } = deps;
  const platform = account.platform;

  const stateFile = (): string => path.join(resolvePaths(deps.env).home, STATE_FILE);
  const loadOverlay = (): AccountOverlay => readStateFile(stateFile())[account.id] ?? emptyOverlay();

  const baseRange = (): DateRange => {
    const end = addDays(todayIso(deps.now()), -1);
    return { start: addDays(end, 1 - BASE_DAYS), end };
  };

  const overlayRows = (level: EntityLevel, rows: Row[], overlay: AccountOverlay): Row[] =>
    rows.map((row) => {
      const changes = overlay.entities[`${level}:${row.id}`];
      return changes === undefined ? row : { ...row, attrs: { ...row.attrs, ...changes } };
    });

  const status = (): ConnectorStatus => {
    const end = todayIso(deps.now());
    return {
      platform,
      accountId: account.id,
      source: 'demo',
      ready: true,
      missingEnv: [],
      datasets: Object.keys(demoDatasets(account, { start: end, end })) as DatasetName[],
      actions: ACTION_KINDS.filter((kind) => kind.startsWith(`${platform}.`)),
      note: 'Synthetic data. Changes are simulated and never leave this machine.',
    };
  };

  const fetchSnapshot = async (request: SnapshotRequest): Promise<Snapshot> => {
    assertRange(request.dateRange);
    const all = demoDatasets(account, request.dateRange);
    const overlay = loadOverlay();
    const datasets: Partial<Record<DatasetName, Row[]>> = {};
    for (const [name, rows] of Object.entries(all) as Array<[DatasetName, Row[]]>) {
      if (request.datasets !== undefined && !request.datasets.includes(name)) continue;
      const level = (Object.entries(LEVEL_DATASETS) as Array<[EntityLevel, DatasetName]>).find(
        ([, dataset]) => dataset === name,
      )?.[0];
      datasets[name] = level === undefined ? rows : overlayRows(level, rows, overlay);
    }
    return buildSnapshot({
      account,
      source: 'demo',
      dateRange: request.dateRange,
      currency: account.currency ?? 'USD',
      timezone: account.timezone ?? 'UTC',
      datasets,
      now: deps.now(),
    });
  };

  const readState = async (draft: ActionDraft): Promise<JsonObject> => {
    const overlay = loadOverlay();
    const shape = kindShape(draft.kind);
    if (shape === 'negative') {
      return { exists: (overlay.negatives[draft.target.id] ?? []).includes(negativeKey(draft.params)) };
    }
    if (shape === 'segment') {
      return { member: (overlay.members[draft.target.id] ?? []).includes(stringParam(draft.params, 'contactId')) };
    }
    if (shape === 'email') {
      return { exists: overlay.emails.includes(stringParam(draft.params, 'name')) };
    }
    const dataset = LEVEL_DATASETS[draft.target.level];
    const rows = dataset === undefined ? undefined : demoDatasets(account, baseRange())[dataset];
    const row = rows?.find((candidate) => candidate.id === draft.target.id);
    if (row === undefined) {
      throw new AutopilotError('not_found', `no ${draft.target.level} with id ${draft.target.id} in the demo account`, {
        hint: 'Take entity ids from a fresh snapshot of this account.',
      });
    }
    const attrs = { ...row.attrs, ...overlay.entities[`${draft.target.level}:${row.id}`] };
    const state: JsonObject = {};
    for (const field of actionSpec(draft.kind).fields) state[field] = attrs[field] ?? null;
    return state;
  };

  const apply = async (action: Action, options: { validateOnly: boolean }): Promise<ActionResult> => {
    if (options.validateOnly) return { ok: true, dryRun: true, after: null };
    const paths = resolvePaths(deps.env);
    ensureHome(paths);
    const file = path.join(paths.home, STATE_FILE);
    const state = readStateFile(file);
    const overlay = state[account.id] ?? emptyOverlay();
    const shape = kindShape(action.kind);
    if (shape === 'negative') {
      setMembership(overlay.negatives, action.target.id, negativeKey(action.params), action.after['exists'] === true);
    } else if (shape === 'segment') {
      setMembership(
        overlay.members,
        action.target.id,
        stringParam(action.params, 'contactId'),
        action.after['member'] === true,
      );
    } else if (shape === 'email') {
      const name = stringParam(action.params, 'name');
      overlay.emails = overlay.emails.filter((entry) => entry !== name);
      if (action.after['exists'] === true) overlay.emails.push(name);
    } else {
      const key = `${action.target.level}:${action.target.id}`;
      const entity: EntityOverlay = { ...overlay.entities[key] };
      for (const field of ENTITY_FIELDS) {
        const value = action.after[field];
        if (value !== undefined && isAttrValue(value)) entity[field] = value;
      }
      overlay.entities[key] = entity;
    }
    state[account.id] = overlay;
    writeStateFile(file, state);
    return { ok: true, dryRun: false, simulated: true, after: null, resource: action.target.id };
  };

  return { platform, source: 'demo', status, fetchSnapshot, readState, apply };
}
