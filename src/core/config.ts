import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AutopilotError } from './errors';
import { digest } from './ids';
import { ACTION_KINDS, AUTONOMY_LEVELS, JOB_TASKS, PLATFORMS } from './types';
import type {
  LocalAgentConfig,
  ScheduleConfig,
  AccountConfig,
  Autonomy,
  AutopilotConfig,
  Env,
  JudgmentConfig,
  JudgmentMode,
  Paths,
  Policy,
  Thresholds,
} from './types';

export const DEFAULT_POLICY: Policy = {
  maxActionsPerPlan: 25,
  maxBudgetChangePct: 0.2,
  maxAccountBudgetIncreasePct: 0.1,
  maxBidChangePct: 0.25,
  cooldownHours: 24,
  maxSnapshotAgeHours: 24,
  approvalTtlMinutes: 30,
  autoApply: [],
  denyKinds: [],
  killSwitch: false,
};

export const DEFAULT_JUDGMENT: JudgmentConfig = {
  model: 'jev-latest',
  budgetUsd: 0.25,
  actThreshold: 0.8,
  gateThreshold: 0.9,
  usdPerMillionInputTokens: 0.042,
};

export const DEFAULT_THRESHOLDS: Thresholds = {
  wasteCpaMultiple: 2,
  wasteMinCost: 25,
  highCpaMultiple: 1.5,
  lowRoasMultiple: 0.7,
  minConversions: 10,
  minClicks: 200,
  minImpressions: 1000,
  lowSearchCtr: 0.02,
  lowConversionRate: 0.01,
  budgetLostIs: 0.2,
  rankLostIs: 0.3,
  lowQualityScore: 3,
  segmentCpaMultiple: 2,
  segmentMinCostShare: 0.1,
  conversionDropPct: 0.8,
  fatigueFrequency: 3,
  fatigueCtrDropPct: 0.3,
  lowLinkCtr: 0.008,
  landingViewRate: 0.6,
  learningMinEvents: 50,
  trackingGapPct: 0.2,
  highUnsubscribeRate: 0.01,
  highBounceRate: 0.05,
  lowOpenRate: 0.15,
  conversionLagDays: 3,
  strikingDistanceMin: 5,
  strikingDistanceMax: 20,
};

const CONFIG_HINT = 'Fix config.json in the autopilot-marketing home directory (AUTOPILOT_HOME, default ~/.autopilot-marketing).';

const fraction = z.number().gt(0).lte(1);
const nonNegative = z.number().min(0);
const confidence = z.number().min(0.5).max(1);
const text = z.string().min(1);
const actionKinds = z.array(z.enum(ACTION_KINDS));

const policySchema = z.strictObject({
  maxActionsPerPlan: z.number().int().min(1).max(200),
  maxBudgetChangePct: fraction,
  maxAccountBudgetIncreasePct: fraction,
  maxBidChangePct: fraction,
  cooldownHours: nonNegative,
  maxSnapshotAgeHours: nonNegative,
  approvalTtlMinutes: z.number().min(1).max(1440),
  autoApply: actionKinds,
  denyKinds: actionKinds,
  killSwitch: z.boolean(),
});

const judgmentSchema = z.strictObject({
  model: text,
  budgetUsd: nonNegative,
  actThreshold: confidence,
  gateThreshold: confidence,
  usdPerMillionInputTokens: nonNegative,
});

const thresholdsSchema = z.strictObject({
  wasteCpaMultiple: nonNegative,
  wasteMinCost: nonNegative,
  highCpaMultiple: nonNegative,
  lowRoasMultiple: nonNegative,
  minConversions: nonNegative,
  minClicks: nonNegative,
  minImpressions: nonNegative,
  lowSearchCtr: fraction,
  lowConversionRate: fraction,
  budgetLostIs: fraction,
  rankLostIs: fraction,
  lowQualityScore: nonNegative,
  segmentCpaMultiple: nonNegative,
  segmentMinCostShare: nonNegative,
  conversionDropPct: fraction,
  fatigueFrequency: nonNegative,
  fatigueCtrDropPct: fraction,
  lowLinkCtr: fraction,
  landingViewRate: fraction,
  learningMinEvents: nonNegative,
  trackingGapPct: fraction,
  highUnsubscribeRate: fraction,
  highBounceRate: fraction,
  lowOpenRate: fraction,
  conversionLagDays: nonNegative,
  strikingDistanceMin: nonNegative,
  strikingDistanceMax: nonNegative,
});

const accountSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/, 'must match /^[a-z0-9][a-z0-9-]{1,40}$/'),
  platform: z.enum(PLATFORMS),
  externalId: text,
  label: z.string().optional(),
  source: z.enum(['api', 'demo']).optional(),
  loginCustomerId: z.string().optional(),
  currency: z.string().optional(),
  timezone: z.string().optional(),
  envPrefix: z.string().optional(),
  targets: z
    .strictObject({ cpa: z.number().positive().optional(), roas: z.number().positive().optional() })
    .optional(),
  brandTerms: z.array(z.string()).optional(),
  business: z.string().optional(),
  protected: z.array(z.string()).optional(),
  sharing: z.strictObject({ judgments: z.boolean().optional(), rows: z.boolean().optional() }).optional(),
});

const businessSchema = z.strictObject({
  name: text,
  description: text,
  audience: z.string().optional(),
  forbiddenPhrases: z.array(z.string()).optional(),
});

const ENTITY_ID = /^[a-z0-9][a-z0-9-]{1,40}$/;
const EVERY = /^([1-9][0-9]{0,3})([mhd])$/;
const MIN_EVERY_MINUTES = 15;
const MAX_EVERY_MINUTES = 30 * 24 * 60;

function everyMinutes(value: string): number | null {
  const match = EVERY.exec(value);
  if (!match) return null;
  const unit = match[2] === 'm' ? 1 : match[2] === 'h' ? 60 : 24 * 60;
  return Number(match[1]) * unit;
}

const scheduleSchema = z
  .strictObject({
    id: z.string().regex(ENTITY_ID, `must match ${ENTITY_ID}`),
    accountId: z.string().min(1),
    task: z.enum(JOB_TASKS),
    every: z.string().refine((value) => {
      const minutes = everyMinutes(value);
      return minutes !== null && minutes >= MIN_EVERY_MINUTES && minutes <= MAX_EVERY_MINUTES;
    }, "must be a whole number and a unit between '15m' and '30d', for example '6h' or '1d'"),
    at: z
      .string()
      .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, "must be a time of day like '07:30'")
      .optional(),
    days: z.number().int().min(1).max(365).optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine((schedule, ctx) => {
    if (schedule.at !== undefined && !schedule.every.endsWith('d')) {
      ctx.addIssue({ code: 'custom', message: "'at' needs an interval in whole days, for example '1d'", path: ['at'] });
    }
  });

const agentSchema = z.strictObject({
  baseUrl: z.url().optional(),
  model: z.string().min(1).optional(),
  maxSteps: z.number().int().min(1).max(50).optional(),
});

const configSchema = z.strictObject({
  version: z.literal(1),
  autonomy: z.enum(AUTONOMY_LEVELS).optional(),
  business: businessSchema.optional(),
  accounts: z
    .array(accountSchema)
    .optional()
    .superRefine((accounts, ctx) => {
      const seen = new Set<string>();
      (accounts ?? []).forEach((account, index) => {
        if (seen.has(account.id)) {
          ctx.addIssue({ code: 'custom', message: `duplicate account id '${account.id}'`, path: [index, 'id'] });
        }
        seen.add(account.id);
      });
    }),
  policy: policySchema.partial().optional(),
  judgment: judgmentSchema.partial().optional(),
  thresholds: thresholdsSchema.partial().optional(),
  schedules: z.array(scheduleSchema).optional(),
  agent: agentSchema.optional(),
}).superRefine((config, ctx) => {
  const accounts = new Map((config.accounts ?? []).map((account) => [account.id, account.platform]));
  const seen = new Set<string>();
  (config.schedules ?? []).forEach((schedule, index) => {
    if (seen.has(schedule.id)) {
      ctx.addIssue({ code: 'custom', message: `duplicate schedule id '${schedule.id}'`, path: ['schedules', index, 'id'] });
    }
    seen.add(schedule.id);
    const platform = accounts.get(schedule.accountId);
    if (platform === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `unknown account '${schedule.accountId}'`,
        path: ['schedules', index, 'accountId'],
      });
    } else if (schedule.task === 'report' && platform !== 'google_ads' && platform !== 'meta_ads') {
      ctx.addIssue({
        code: 'custom',
        message: `task 'report' needs a google_ads or meta_ads account, '${schedule.accountId}' is ${platform}`,
        path: ['schedules', index, 'task'],
      });
    }
  });
});

/** Drops keys whose value is undefined, so optional properties are absent rather than undefined. */
function compact<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function clonePolicy(policy: Policy): Policy {
  return { ...policy, autoApply: [...policy.autoApply], denyKinds: [...policy.denyKinds] };
}

/** Demo accounts for every platform, autonomy `propose`. What a user gets before writing a config. */
export function defaultConfig(): AutopilotConfig {
  const demo = { source: 'demo', externalId: 'demo', currency: 'USD', timezone: 'America/New_York' } as const;
  return {
    version: 1,
    autonomy: 'propose',
    business: {
      name: 'Northwind Outdoor',
      description:
        'Northwind Outdoor sells hiking and camping gear online to weekend hikers in the United States.',
    },
    accounts: [
      {
        id: 'demo-google',
        platform: 'google_ads',
        label: 'Demo Google Ads account',
        ...demo,
        targets: { cpa: 40, roas: 3 },
        brandTerms: ['northwind'],
      },
      {
        id: 'demo-meta',
        platform: 'meta_ads',
        label: 'Demo Meta Ads account',
        ...demo,
        targets: { cpa: 40, roas: 3 },
      },
      { id: 'demo-ga4', platform: 'ga4', label: 'Demo GA4 property', ...demo },
      { id: 'demo-search-console', platform: 'search_console', label: 'Demo Search Console site', ...demo },
      { id: 'demo-mautic', platform: 'mautic', label: 'Demo Mautic instance', ...demo },
    ],
    policy: clonePolicy(DEFAULT_POLICY),
    judgment: { ...DEFAULT_JUDGMENT },
    thresholds: { ...DEFAULT_THRESHOLDS },
  };
}

/** Validates and fills defaults. Throws `config_invalid` naming every problem at once. */
export function parseConfig(raw: unknown): AutopilotConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `${issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)'}: ${issue.message}`,
    );
    throw new AutopilotError('config_invalid', `Invalid config:\n${lines.join('\n')}`, { hint: CONFIG_HINT });
  }
  const data = compact(result.data);
  const config: AutopilotConfig = {
    version: 1,
    autonomy: data.autonomy ?? 'propose',
    accounts: (data.accounts ?? []) as AccountConfig[],
    policy: clonePolicy({ ...DEFAULT_POLICY, ...(data.policy as Partial<Policy> | undefined) }),
    judgment: { ...DEFAULT_JUDGMENT, ...(data.judgment as Partial<JudgmentConfig> | undefined) },
    thresholds: { ...DEFAULT_THRESHOLDS, ...(data.thresholds as Partial<Thresholds> | undefined) },
  };
  if (data.business !== undefined) config.business = data.business as NonNullable<AutopilotConfig['business']>;
  if (data.schedules !== undefined) config.schedules = data.schedules as ScheduleConfig[];
  if (data.agent !== undefined) config.agent = data.agent as LocalAgentConfig;
  return config;
}

/** Reads `paths.config`; a missing file yields `defaultConfig()`. */
export function loadConfig(paths: Paths): AutopilotConfig {
  let content: string;
  try {
    content = fs.readFileSync(paths.config, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultConfig();
    throw new AutopilotError('config_invalid', `Cannot read ${paths.config}`, {
      hint: `Check the permissions of ${paths.config}.`,
      cause: error,
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw new AutopilotError('config_invalid', `${paths.config} is not valid JSON`, {
      hint: `Fix the JSON syntax in ${paths.config}, or delete the file to start from the defaults.`,
      cause: error,
    });
  }
  try {
    return parseConfig(raw);
  } catch (error) {
    if (error instanceof AutopilotError) {
      throw new AutopilotError(error.code, error.message, { hint: `Fix ${paths.config} and run the command again.` });
    }
    throw error;
  }
}

/** Writes the config with mode 0600. Called by the CLI only: no MCP tool may change policy. */
export function saveConfig(config: AutopilotConfig, paths: Paths): void {
  fs.mkdirSync(path.dirname(paths.config), { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.config, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // `mode` only applies when the file is created; an existing file keeps its old bits.
  fs.chmodSync(paths.config, 0o600);
}

/** Throws `not_found` listing the configured account ids. */
export function findAccount(config: AutopilotConfig, accountId: string): AccountConfig {
  const account = config.accounts.find((candidate) => candidate.id === accountId);
  if (account) return account;
  const ids = config.accounts.map((candidate) => candidate.id);
  throw new AutopilotError('not_found', `No account with id '${accountId}'`, {
    hint: ids.length > 0 ? `Configured account ids: ${ids.join(', ')}` : 'No accounts are configured.',
  });
}

export function policyDigest(policy: Policy): string {
  return digest(policy);
}

/** `autopilot` needs Jev: it is lowered to `approve` in fallback mode. Other levels pass through. */
export function effectiveAutonomy(config: AutopilotConfig, mode: JudgmentMode): Autonomy {
  return config.autonomy === 'autopilot' && mode === 'fallback' ? 'approve' : config.autonomy;
}

/** True when `policy.killSwitch` is set, AUTOPILOT_KILL is `1` or `true`, or `paths.killFile` exists. */
export function killSwitchOn(config: AutopilotConfig, paths: Paths, env: Env): boolean {
  if (config.policy.killSwitch) return true;
  if (env.AUTOPILOT_KILL === '1' || env.AUTOPILOT_KILL === 'true') return true;
  return fs.existsSync(paths.killFile);
}
