import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { envFor, loadEnv, missingEnv } from '../../src/core/env';
import { attrNumber, attrString, groupBy, kpis, metric, monthly, ratio, sumMetrics } from '../../src/core/metrics';
import { ensureHome, resolvePaths } from '../../src/core/paths';
import { redact } from '../../src/core/redact';
import type { AccountConfig, Row } from '../../src/core/types';

function row(id: string, metrics: Row['metrics'], attrs: Row['attrs'] = {}): Row {
  return { id, metrics, attrs };
}

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apm-'));
}

const account: AccountConfig = { id: 'acme-google', platform: 'google_ads', externalId: '123' };

describe('metrics', () => {
  it('ratio handles missing and zero operands', () => {
    expect(ratio(1, 0)).toBeNull();
    expect(ratio(1, undefined)).toBeNull();
    expect(ratio(undefined, 4)).toBe(0);
    expect(ratio(3, 4)).toBe(0.75);
  });

  it('reads metrics and attrs', () => {
    const r = row('a', { clicks: 3 }, { bid: '1.5', qualityScore: 7, status: 'ENABLED', primary: true, empty: '', bad: 'x1' });
    expect(metric(r, 'clicks')).toBe(3);
    expect(metric(r, 'cost')).toBe(0);
    expect(attrNumber(r, 'bid')).toBe(1.5);
    expect(attrNumber(r, 'qualityScore')).toBe(7);
    expect(attrNumber(r, 'status')).toBeNull();
    expect(attrNumber(r, 'primary')).toBeNull();
    expect(attrNumber(r, 'empty')).toBeNull();
    expect(attrNumber(r, 'bad')).toBeNull();
    expect(attrNumber(r, 'absent')).toBeNull();
    expect(attrNumber(row('b', {}, { n: Number.POSITIVE_INFINITY }), 'n')).toBeNull();
    expect(attrString(r, 'status')).toBe('ENABLED');
    expect(attrString(r, 'qualityScore')).toBeNull();
    expect(attrString(r, 'absent')).toBeNull();
  });

  it('sumMetrics sums sparse keys and skips undefined', () => {
    const total = sumMetrics([
      row('a', { clicks: 2, cost: 1.5 }),
      row('b', { clicks: 3, sessions: 10, revenue: undefined }),
      row('c', { linkClicks: 4 }),
    ]);
    expect(total).toEqual({ clicks: 5, cost: 1.5, sessions: 10, linkClicks: 4 });
    expect(sumMetrics([])).toEqual({});
  });

  it('kpis fills zeros and returns null on zero denominators', () => {
    expect(kpis({})).toEqual({
      impressions: 0,
      clicks: 0,
      cost: 0,
      conversions: 0,
      conversionValue: 0,
      ctr: null,
      cpc: null,
      cpa: null,
      roas: null,
      conversionRate: null,
    });
    const k = kpis({ impressions: 1000, clicks: 50, cost: 100, conversions: 5, conversionValue: 400 });
    expect(k.ctr).toBe(0.05);
    expect(k.cpc).toBe(2);
    expect(k.cpa).toBe(20);
    expect(k.roas).toBe(4);
    expect(k.conversionRate).toBe(0.1);
    const partial = kpis({ impressions: 100, cost: 10 });
    expect(partial.ctr).toBe(0);
    expect(partial.cpc).toBeNull();
    expect(partial.cpa).toBeNull();
    expect(partial.roas).toBe(0);
  });

  it('monthly scales by the inclusive day count', () => {
    expect(monthly(70, { start: '2026-03-01', end: '2026-03-07' })).toBe(300);
    expect(monthly(5, { start: '2026-03-01', end: '2026-03-01' })).toBe(150);
    expect(monthly(60, { start: '2026-02-15', end: '2026-03-16' })).toBe(60);
    expect(() => monthly(1, { start: '2026-03-02', end: '2026-03-01' })).toThrow(/ends before/);
    expect(() => monthly(1, { start: 'nope', end: '2026-03-01' })).toThrow(/Invalid date/);
  });

  it('groupBy preserves first-seen key order', () => {
    const groups = groupBy(['b1', 'a1', 'b2', 'c1', 'a2'], (s) => s.charAt(0));
    expect([...groups.keys()]).toEqual(['b', 'a', 'c']);
    expect(groups.get('b')).toEqual(['b1', 'b2']);
    expect(groups.get('a')).toEqual(['a1', 'a2']);
  });
});

describe('paths', () => {
  it('defaults to ~/.autopilot-marketing', () => {
    const expected = path.join(os.homedir(), '.autopilot-marketing');
    expect(resolvePaths({}).home).toBe(expected);
    expect(resolvePaths({ AUTOPILOT_HOME: '' }).home).toBe(expected);
  });

  it('honours AUTOPILOT_HOME and expands a leading ~', () => {
    const paths = resolvePaths({ AUTOPILOT_HOME: '/data/apm' });
    expect(paths).toEqual({
      home: '/data/apm',
      config: path.join('/data/apm', 'config.json'),
      envFile: path.join('/data/apm', '.env'),
      db: path.join('/data/apm', 'state.db'),
      brief: path.join('/data/apm', 'brief.md'),
      approvalKey: path.join('/data/apm', 'approval.key'),
      killFile: path.join('/data/apm', 'KILL'),
      credentials: path.join('/data/apm', 'credentials.json'),
    });
    expect(resolvePaths({ AUTOPILOT_HOME: '~/apm-state' }).home).toBe(path.join(os.homedir(), 'apm-state'));
    expect(resolvePaths({ AUTOPILOT_HOME: '~' }).home).toBe(os.homedir());
  });

  it('ensureHome creates the directory recursively with mode 0700', () => {
    const paths = resolvePaths({ AUTOPILOT_HOME: path.join(tempHome(), 'nested', 'home') });
    ensureHome(paths);
    ensureHome(paths);
    const stat = fs.statSync(paths.home);
    expect(stat.isDirectory()).toBe(true);
    if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o700);
  });
});

describe('env', () => {
  it('returns a copy of base when there is no .env file', () => {
    const paths = resolvePaths({ AUTOPILOT_HOME: tempHome() });
    const base = { A: '1' };
    const env = loadEnv(paths, base);
    expect(env).toEqual({ A: '1' });
    expect(env).not.toBe(base);
  });

  it('parses the .env file and lets base win', () => {
    const paths = resolvePaths({ AUTOPILOT_HOME: tempHome() });
    fs.writeFileSync(
      paths.envFile,
      [
        '# comment',
        '',
        'PLAIN=value',
        'export EXPORTED=exported value',
        'DOUBLE="double quoted"',
        "SINGLE='single quoted'",
        '  SPACED = padded  ',
        'NO_INTERP=$PLAIN/${PLAIN}',
        'EMPTY=',
        'WITH_EQ=a=b',
        'not a valid line',
        '1BAD=x',
        '=novalue',
        'OVERRIDDEN=file',
        'UNSET_IN_BASE=file',
      ].join('\n'),
    );
    const env = loadEnv(paths, { OVERRIDDEN: 'process', ONLY_BASE: 'b', UNSET_IN_BASE: undefined });
    expect(env).toEqual({
      PLAIN: 'value',
      EXPORTED: 'exported value',
      DOUBLE: 'double quoted',
      SINGLE: 'single quoted',
      SPACED: 'padded',
      NO_INTERP: '$PLAIN/${PLAIN}',
      EMPTY: '',
      WITH_EQ: 'a=b',
      OVERRIDDEN: 'process',
      UNSET_IN_BASE: 'file',
      ONLY_BASE: 'b',
    });
  });

  it('envFor prefers the prefixed name and falls back', () => {
    const prefixed: AccountConfig = { ...account, envPrefix: 'ACME_' };
    const env = { ACME_TOKEN: 'acme', TOKEN: 'shared', ACME_EMPTY: '', EMPTY: 'fallback', BLANK: '' };
    expect(envFor(env, prefixed, 'TOKEN')).toBe('acme');
    expect(envFor(env, account, 'TOKEN')).toBe('shared');
    expect(envFor(env, prefixed, 'EMPTY')).toBe('fallback');
    expect(envFor(env, prefixed, 'BLANK')).toBeUndefined();
    expect(envFor(env, prefixed, 'ABSENT')).toBeUndefined();
    expect(missingEnv(env, prefixed, ['ABSENT', 'TOKEN', 'BLANK', 'EMPTY'])).toEqual(['ABSENT', 'BLANK']);
  });
});

describe('redact', () => {
  it('replaces values of secret-named variables', () => {
    const env = {
      GOOGLE_ADS_DEVELOPER_TOKEN: 'dev-token-123',
      meta_app_secret: 'shhhhhh',
      DB_PASSWORD: 'hunter22',
      API_KEY: 'abc',
      HOME: '/home/someone',
      UNSET_TOKEN: undefined,
    };
    const out = redact('t=dev-token-123 s=shhhhhh p=hunter22 again dev-token-123 k=abc h=/home/someone', env);
    expect(out).toBe(
      't=[redacted:GOOGLE_ADS_DEVELOPER_TOKEN] s=[redacted:meta_app_secret] p=[redacted:DB_PASSWORD] again [redacted:GOOGLE_ADS_DEVELOPER_TOKEN] k=abc h=/home/someone',
    );
  });

  it('redacts the longer secret when one contains another', () => {
    const out = redact('v=abcdef-long', { A_KEY: 'abcdef', B_KEY: 'abcdef-long' });
    expect(out).toBe('v=[redacted:B_KEY]');
  });

  it('treats regex metacharacters in values literally', () => {
    expect(redact('x a.b+c(d)$ y', { X_TOKEN: 'a.b+c(d)$' })).toBe('x [redacted:X_TOKEN] y');
  });

  it('redacts bearer tokens', () => {
    expect(redact('Authorization: Bearer ya29.a0Af_x-Y/z= next', {})).toBe('Authorization: Bearer [redacted] next');
  });

  it('redacts query string parameters', () => {
    const out = redact(
      'GET https://x.test/a?access_token=AAA&fields=id&client_secret=BBB&refresh_token=CCC&api_key=DDD&password=EEE done',
      {},
    );
    expect(out).toBe(
      'GET https://x.test/a?access_token=[redacted]&fields=id&client_secret=[redacted]&refresh_token=[redacted]&api_key=[redacted]&password=[redacted] done',
    );
  });

  it('redacts JSON parameters', () => {
    const out = redact('{"access_token":"A\\"A","expires_in":3600, "refresh_token" : "BBB","client_secret":"C","name":"ok"}', {});
    expect(out).toBe(
      '{"access_token":"[redacted]","expires_in":3600, "refresh_token" : "[redacted]","client_secret":"[redacted]","name":"ok"}',
    );
  });

  it('never throws', () => {
    expect(redact('', {})).toBe('');
    expect(redact('plain text', {})).toBe('plain text');
    expect(() => redact(undefined as unknown as string, {})).not.toThrow();
    expect(() => redact('x', null as unknown as Record<string, string>)).not.toThrow();
  });
});
