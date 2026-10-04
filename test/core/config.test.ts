import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  DEFAULT_THRESHOLDS,
  defaultConfig,
  effectiveAutonomy,
  findAccount,
  killSwitchOn,
  loadConfig,
  parseConfig,
  policyDigest,
  saveConfig,
} from '../../src/core/config';
import { AutopilotError } from '../../src/core/errors';
import type { Paths } from '../../src/core/types';

function tempPaths(): Paths {
  const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apm-')), 'home');
  return {
    home,
    config: path.join(home, 'config.json'),
    envFile: path.join(home, '.env'),
    db: path.join(home, 'autopilot.db'),
    brief: path.join(home, 'brief.md'),
    approvalKey: path.join(home, 'approval.key'),
    killFile: path.join(home, 'KILL'),
    credentials: path.join(home, 'credentials.json'),
  };
}

function failure(run: () => unknown): AutopilotError {
  try {
    run();
  } catch (error) {
    if (error instanceof AutopilotError) return error;
    throw error;
  }
  throw new Error('expected an AutopilotError');
}

describe('defaultConfig and parseConfig', () => {
  it('round-trips the defaults', () => {
    const config = defaultConfig();
    expect(parseConfig(JSON.parse(JSON.stringify(config)))).toEqual(config);
    expect(config.accounts.map((account) => account.id)).toEqual([
      'demo-google',
      'demo-meta',
      'demo-ga4',
      'demo-search-console',
      'demo-mautic',
    ]);
    expect(config.autonomy).toBe('propose');
  });

  it('returns copies, not the shared defaults', () => {
    const config = defaultConfig();
    config.policy.autoApply.push('google_ads.campaign.pause');
    config.thresholds.minClicks = 1;
    expect(DEFAULT_POLICY.autoApply).toEqual([]);
    expect(DEFAULT_THRESHOLDS.minClicks).toBe(200);
  });

  it('fills defaults for a minimal config', () => {
    const config = parseConfig({ version: 1 });
    expect(config.autonomy).toBe('propose');
    expect(config.accounts).toEqual([]);
    expect(config.policy).toEqual(DEFAULT_POLICY);
    expect(config.thresholds).toEqual(DEFAULT_THRESHOLDS);
    expect('business' in config).toBe(false);
  });

  it('merges a partial policy, judgment and thresholds over the defaults', () => {
    const config = parseConfig({
      version: 1,
      policy: { maxActionsPerPlan: 5, denyKinds: ['meta_ads.ad.enable'] },
      judgment: { budgetUsd: 0 },
      thresholds: { lowSearchCtr: 0.05 },
    });
    expect(config.policy).toEqual({ ...DEFAULT_POLICY, maxActionsPerPlan: 5, denyKinds: ['meta_ads.ad.enable'] });
    expect(config.judgment.budgetUsd).toBe(0);
    expect(config.judgment.actThreshold).toBe(0.8);
    expect(config.thresholds).toEqual({ ...DEFAULT_THRESHOLDS, lowSearchCtr: 0.05 });
  });

  it('rejects unknown keys at every level', () => {
    expect(failure(() => parseConfig({ version: 1, extra: true })).code).toBe('config_invalid');
    expect(failure(() => parseConfig({ version: 1, policy: { maxBudget: 1 } })).message).toContain('policy');
    const account = { id: 'acme', platform: 'ga4', externalId: '1', token: 'x' };
    expect(failure(() => parseConfig({ version: 1, accounts: [account] })).message).toContain('accounts.0');
  });

  it('rejects duplicate account ids', () => {
    const account = { id: 'acme-google', platform: 'google_ads', externalId: '123' };
    const error = failure(() => parseConfig({ version: 1, accounts: [account, { ...account }] }));
    expect(error.code).toBe('config_invalid');
    expect(error.message).toContain("accounts.1.id: duplicate account id 'acme-google'");
  });

  it('reports several problems together as path: message lines, with a hint', () => {
    const error = failure(() =>
      parseConfig({
        version: 2,
        autonomy: 'yolo',
        accounts: [{ id: 'Bad Id', platform: 'tiktok', externalId: '1', source: 'csv' }],
        policy: { maxBudgetChangePct: 20, maxActionsPerPlan: 0, approvalTtlMinutes: 2000, autoApply: ['x.delete'] },
        judgment: { actThreshold: 0.4, budgetUsd: -1 },
        thresholds: { lowOpenRate: 0, budgetLostIs: 1.5 },
      }),
    );
    expect(error.code).toBe('config_invalid');
    expect(error.hint).toContain('config');
    const paths = error.message
      .split('\n')
      .slice(1)
      .map((line) => line.split(': ')[0]);
    for (const expected of [
      'version',
      'autonomy',
      'accounts.0.id',
      'accounts.0.platform',
      'accounts.0.source',
      'policy.maxBudgetChangePct',
      'policy.maxActionsPerPlan',
      'policy.approvalTtlMinutes',
      'policy.autoApply.0',
      'judgment.actThreshold',
      'judgment.budgetUsd',
      'thresholds.lowOpenRate',
      'thresholds.budgetLostIs',
    ]) {
      expect(paths).toContain(expected);
    }
  });

  it('rejects a non-object', () => {
    expect(failure(() => parseConfig(null)).code).toBe('config_invalid');
    expect(failure(() => parseConfig({ version: 1, policy: { maxActionsPerPlan: 1.5 } })).code).toBe('config_invalid');
  });
});

describe('schedules and sharing in the config', () => {
  const base = () => ({ version: 1, accounts: defaultConfig().accounts });
  const problems = (raw: unknown): string => {
    try {
      parseConfig(raw);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return '';
  };

  it('accepts schedules, a sharing policy and local runner defaults', () => {
    const config = parseConfig({
      ...base(),
      accounts: defaultConfig().accounts.map((account) =>
        account.id === 'demo-google' ? { ...account, sharing: { judgments: false, rows: false } } : account,
      ),
      schedules: [
        { id: 'daily-google', accountId: 'demo-google', task: 'audit', every: '1d', at: '07:30' },
        { id: 'meta-report', accountId: 'demo-meta', task: 'report', every: '7d', days: 14, enabled: false },
        { id: 'cycle', accountId: 'demo-google', task: 'cycle', every: '6h' },
      ],
      agent: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3', maxSteps: 8 },
    });
    expect(config.schedules).toHaveLength(3);
    expect(config.accounts.find((account) => account.id === 'demo-google')?.sharing).toEqual({ judgments: false, rows: false });
    expect(config.agent?.model).toBe('qwen3');
  });

  it('leaves the optional keys out when the file has none', () => {
    const config = parseConfig(base());
    expect('schedules' in config).toBe(false);
    expect('agent' in config).toBe(false);
  });

  it('rejects a schedule for an unknown account, a report on a platform without one, and a duplicate id', () => {
    const text = problems({
      ...base(),
      schedules: [
        { id: 'a-one', accountId: 'nobody', task: 'audit', every: '1d' },
        { id: 'b-two', accountId: 'demo-ga4', task: 'report', every: '1d' },
        { id: 'b-two', accountId: 'demo-google', task: 'audit', every: '1d' },
      ],
    });
    expect(text).toContain("schedules.0.accountId: unknown account 'nobody'");
    expect(text).toContain("schedules.1.task: task 'report' needs a google_ads or meta_ads account");
    expect(text).toContain("schedules.2.id: duplicate schedule id 'b-two'");
  });

  it('rejects intervals outside 15 minutes to 30 days and a time of day on a sub-day interval', () => {
    const schedule = (every: string, at?: string) => ({
      ...base(),
      schedules: [{ id: 'a-one', accountId: 'demo-google', task: 'audit', every, ...(at === undefined ? {} : { at }) }],
    });
    for (const every of ['5m', '31d', '1w', 'daily', '0h', '1.5h']) expect(problems(schedule(every))).toContain('schedules.0.every');
    for (const every of ['15m', '6h', '30d']) expect(problems(schedule(every))).toBe('');
    expect(problems(schedule('6h', '07:00'))).toContain("schedules.0.at: 'at' needs an interval in whole days");
    expect(problems(schedule('1d', '7:00'))).toContain('schedules.0.at');
    expect(problems(schedule('1d', '24:00'))).toContain('schedules.0.at');
  });

  it('has no key by which a config could start a program', () => {
    expect(problems({ ...base(), onAttention: { command: ['sh', '-c', 'true'] } })).toContain('onAttention');
  });
});

describe('loadConfig and saveConfig', () => {
  it('returns the defaults when the file is missing', () => {
    expect(loadConfig(tempPaths())).toEqual(defaultConfig());
  });

  it('saves with private modes and loads the same config back', () => {
    const paths = tempPaths();
    const config = { ...defaultConfig(), autonomy: 'approve' as const };
    saveConfig(config, paths);
    expect(fs.statSync(paths.config).mode & 0o777).toBe(0o600);
    expect(fs.statSync(paths.home).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(paths.config, 'utf8')).toContain('\n  "autonomy": "approve"');
    expect(loadConfig(paths)).toEqual(config);
  });

  it('throws config_invalid for unparseable JSON and for an invalid file', () => {
    const paths = tempPaths();
    fs.mkdirSync(paths.home, { recursive: true });
    fs.writeFileSync(paths.config, '{ not json');
    const broken = failure(() => loadConfig(paths));
    expect(broken.code).toBe('config_invalid');
    expect(broken.hint).toContain(paths.config);
    fs.writeFileSync(paths.config, JSON.stringify({ version: 3 }));
    const invalid = failure(() => loadConfig(paths));
    expect(invalid.code).toBe('config_invalid');
    expect(invalid.hint).toContain(paths.config);
  });
});

describe('findAccount', () => {
  it('finds an account and lists the ids when it is unknown', () => {
    const config = defaultConfig();
    expect(findAccount(config, 'demo-meta').platform).toBe('meta_ads');
    const error = failure(() => findAccount(config, 'nope'));
    expect(error.code).toBe('not_found');
    expect(error.hint).toContain('demo-google');
    expect(error.hint).toContain('demo-mautic');
  });
});

describe('policyDigest', () => {
  it('is stable across key order and changes with the policy', () => {
    const reversed = Object.fromEntries(Object.entries(DEFAULT_POLICY).reverse()) as typeof DEFAULT_POLICY;
    expect(policyDigest(reversed)).toBe(policyDigest(DEFAULT_POLICY));
    expect(policyDigest({ ...DEFAULT_POLICY, killSwitch: true })).not.toBe(policyDigest(DEFAULT_POLICY));
    expect(policyDigest(DEFAULT_POLICY)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('effectiveAutonomy', () => {
  it('lowers autopilot to approve in fallback mode only', () => {
    const autopilot = { ...defaultConfig(), autonomy: 'autopilot' as const };
    expect(effectiveAutonomy(autopilot, 'fallback')).toBe('approve');
    expect(effectiveAutonomy(autopilot, 'jev')).toBe('autopilot');
    expect(effectiveAutonomy(defaultConfig(), 'fallback')).toBe('propose');
    expect(effectiveAutonomy({ ...defaultConfig(), autonomy: 'observe' }, 'fallback')).toBe('observe');
  });
});

describe('killSwitchOn', () => {
  it('is off by default', () => {
    expect(killSwitchOn(defaultConfig(), tempPaths(), {})).toBe(false);
    expect(killSwitchOn(defaultConfig(), tempPaths(), { AUTOPILOT_KILL: '0' })).toBe(false);
  });

  it('turns on through the policy', () => {
    const config = defaultConfig();
    config.policy.killSwitch = true;
    expect(killSwitchOn(config, tempPaths(), {})).toBe(true);
  });

  it('turns on through the environment', () => {
    expect(killSwitchOn(defaultConfig(), tempPaths(), { AUTOPILOT_KILL: '1' })).toBe(true);
    expect(killSwitchOn(defaultConfig(), tempPaths(), { AUTOPILOT_KILL: 'true' })).toBe(true);
  });

  it('turns on through the kill file', () => {
    const paths = tempPaths();
    fs.mkdirSync(paths.home, { recursive: true });
    fs.writeFileSync(paths.killFile, '');
    expect(killSwitchOn(defaultConfig(), paths, {})).toBe(true);
  });
});
