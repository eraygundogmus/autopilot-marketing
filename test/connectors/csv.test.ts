import { describe, expect, it } from 'vitest';
import { importCsv, parseCsv } from '../../src/connectors/csv';
import { AutopilotError } from '../../src/core/errors';
import type { AccountConfig, DatasetName } from '../../src/core/types';

const account: AccountConfig = { id: 'acme-google', platform: 'google_ads', externalId: '123-456-7890' };
const dateRange = { start: '2026-09-01', end: '2026-09-30' };
const now = new Date('2026-10-01T00:00:00Z');

function run(files: Array<{ dataset: DatasetName; text: string }>, extra: { currency?: string; account?: AccountConfig } = {}) {
  return importCsv({
    account: extra.account ?? account,
    dateRange,
    files,
    now,
    ...(extra.currency === undefined ? {} : { currency: extra.currency }),
  });
}

describe('parseCsv', () => {
  it('handles quoted fields, doubled quotes and embedded delimiters', () => {
    const parsed = parseCsv('Campaign,Clicks,Note\n"Shoes, EU",5,"say ""hi"""\r\nPlain,7,\n');
    expect(parsed.headers).toEqual(['Campaign', 'Clicks', 'Note']);
    expect(parsed.rows).toEqual([
      ['Shoes, EU', '5', 'say "hi"'],
      ['Plain', '7', ''],
    ]);
  });

  it('keeps a newline inside a quoted field', () => {
    const parsed = parseCsv('Campaign,Clicks\n"Line one\nLine two",3\n');
    expect(parsed.rows).toEqual([['Line one\nLine two', '3']]);
  });

  it('strips a BOM', () => {
    const parsed = parseCsv('﻿Campaign,Clicks\nA,1');
    expect(parsed.headers).toEqual(['Campaign', 'Clicks']);
    expect(parsed.rows).toEqual([['A', '1']]);
  });

  it('detects semicolon and tab delimiters', () => {
    expect(parseCsv('Campaign;Clicks;Cost\nA;1;2,50\n').rows).toEqual([['A', '1', '2,50']]);
    expect(parseCsv('Campaign\tClicks\nA, B\t1\n').rows).toEqual([['A, B', '1']]);
  });

  it('skips title lines, drops Total and empty rows, and pads or cuts rows', () => {
    const text = [
      'Campaign report',
      '"September 1, 2026 - September 30, 2026"',
      'Campaign,Clicks,Cost',
      'A,1',
      '',
      'B,2,3,extra',
      'Total Care,4,5',
      'Total: Campaigns,3,3',
      'Total: Account,3,3',
    ].join('\n');
    const parsed = parseCsv(text);
    expect(parsed.headers).toEqual(['Campaign', 'Clicks', 'Cost']);
    expect(parsed.rows).toEqual([
      ['A', '1', ''],
      ['B', '2', '3'],
      ['Total Care', '4', '5'],
    ]);
  });

  it('falls back to the first non-empty row when no header is recognised', () => {
    const parsed = parseCsv('\nfoo,bar\n1,2\n');
    expect(parsed.headers).toEqual(['foo', 'bar']);
    expect(parsed.rows).toEqual([['1', '2']]);
  });
});

describe('importCsv', () => {
  it('imports a Google Ads style export', () => {
    const text = [
      'Campaign report',
      '"September 1, 2026 - September 30, 2026"',
      'Campaign,Campaign ID,Campaign status,Budget,Impr.,Clicks,Cost,Conversions,Conv. value,Search lost IS (budget),Search lost IS (rank),Currency code',
      'Brand,111,Enabled,50.00,"12,345",678,"1,234.56",12.5,"2,000.00",12.5%,< 10%,EUR',
      'Generic,222,Paused,20.00,0,0,0.00,0,0, --,> 90%,EUR',
      'Total: Campaigns,,,,"12,345",678,"1,234.56",12.5,"2,000.00",,,',
    ].join('\r\n');
    const snapshot = run([{ dataset: 'campaigns', text }]);
    expect(snapshot.source).toBe('csv');
    expect(snapshot.currency).toBe('EUR');
    expect(snapshot.timezone).toBe('UTC');
    expect(snapshot.createdAt).toBe('2026-10-01T00:00:00.000Z');
    expect(snapshot.coverage.campaigns).toEqual({ status: 'complete', rows: 2 });
    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.datasets.campaigns).toEqual([
      {
        id: '111',
        name: 'Brand',
        metrics: { impressions: 12345, clicks: 678, cost: 1234.56, conversions: 12.5, conversionValue: 2000 },
        attrs: { status: 'ENABLED', dailyBudget: 50, lostIsBudget: 0.125, lostIsRank: 0.1 },
      },
      {
        id: '222',
        name: 'Generic',
        metrics: { impressions: 0, clicks: 0, cost: 0, conversions: 0, conversionValue: 0 },
        attrs: { status: 'PAUSED', dailyBudget: 20, lostIsRank: 0.9 },
      },
    ]);
  });

  it('imports a Meta style export', () => {
    const text = [
      'Campaign name,Ad set name,Ad set delivery,Ad set budget,Reach,Frequency,Impressions,Link clicks,Amount spent (USD),Results,Purchases conversion value,Landing page views',
      'Prospecting,Lookalike 1%,active,$25.00,900,1.5,1350,40,$123.40,3,450.5,31',
      'Prospecting,Retargeting,inactive,10,--,,0,,0,,,',
    ].join('\n');
    const snapshot = run([{ dataset: 'ad_groups', text }], {
      account: { id: 'acme-meta', platform: 'meta_ads', externalId: 'act_1', timezone: 'Europe/Istanbul' },
      currency: 'TRY',
    });
    expect(snapshot.currency).toBe('USD');
    expect(snapshot.timezone).toBe('Europe/Istanbul');
    expect(snapshot.datasets.ad_groups).toEqual([
      {
        id: 'lookalike-1',
        name: 'Lookalike 1%',
        campaignId: 'prospecting',
        metrics: {
          impressions: 1350,
          clicks: 40,
          linkClicks: 40,
          cost: 123.4,
          conversions: 3,
          conversionValue: 450.5,
          landingPageViews: 31,
        },
        attrs: { status: 'ENABLED', dailyBudget: 25, frequency: 1.5, reach: 900 },
      },
      {
        id: 'retargeting',
        name: 'Retargeting',
        campaignId: 'prospecting',
        metrics: { impressions: 0, cost: 0 },
        attrs: { status: 'PAUSED', dailyBudget: 10 },
      },
    ]);
  });

  it('normalises keywords: match type, status, quality score and slug ids', () => {
    const text = [
      'Campaign,Ad group,Keyword,Match type,Status,Quality Score,Impr.,Clicks,Cost',
      'Brand,Core,running shoes,Exact match,Eligible,7,100,10,5.5',
      'Brand,Core,running shoes,Phrase match,Removed, --,50,1,0.5',
      'Brand,Core,shoes,Broad match,Archived,--,5,0,0',
    ].join('\n');
    const rows = run([{ dataset: 'keywords', text }]).datasets.keywords ?? [];
    expect(rows.map((row) => row.id)).toEqual([
      'brand-core-running-shoes-exact-match',
      'brand-core-running-shoes-phrase-match',
      'brand-core-shoes-broad-match',
    ]);
    expect(rows[0]).toMatchObject({ name: 'running shoes', campaignId: 'brand', adGroupId: 'core' });
    expect(rows.map((row) => row.attrs)).toEqual([
      { status: 'ENABLED', matchType: 'EXACT', qualityScore: 7 },
      { status: 'REMOVED', matchType: 'PHRASE' },
      { status: 'REMOVED', matchType: 'BROAD' },
    ]);
  });

  it('prefers id columns over slugs', () => {
    const text = 'Campaign ID,Ad group ID,Keyword ID,Keyword,Impr.\n1,2,3,shoes,9\n';
    expect(run([{ dataset: 'keywords', text }]).datasets.keywords).toEqual([
      { id: '3', name: 'shoes', campaignId: '1', adGroupId: '2', metrics: { impressions: 9 }, attrs: {} },
    ]);
  });

  it('shapes search terms, devices, placements and daily rows', () => {
    const snapshot = run([
      {
        dataset: 'search_terms',
        text: 'Search term,Campaign,Ad group,Added/Excluded,Impr.,Cost\nfree shoes,Brand,Core,Excluded,10,TRY 1.20\n',
      },
      { dataset: 'devices', text: 'Campaign,Device,Impr.\nBrand,Mobile phones,10\n' },
      { dataset: 'placements', text: 'Ad set name,Placement,Impressions\nRetargeting,Feed,10\n' },
      { dataset: 'daily', text: 'Day,Impr.,Cost\n"Sep 5, 2026",10,1\n2026-09-06,20,2\nnot a date,1,1\n' },
    ]);
    expect(snapshot.datasets.search_terms).toEqual([
      {
        id: 'brand-core-free-shoes',
        name: 'free shoes',
        campaignId: 'brand',
        adGroupId: 'core',
        metrics: { impressions: 10, cost: 1.2 },
        attrs: { searchTermStatus: 'EXCLUDED' },
      },
    ]);
    expect(snapshot.datasets.devices).toEqual([
      {
        id: 'brand:Mobile phones',
        name: 'Mobile phones',
        campaignId: 'brand',
        metrics: { impressions: 10 },
        attrs: { device: 'Mobile phones' },
      },
    ]);
    expect(snapshot.datasets.placements).toEqual([
      {
        id: 'retargeting:Feed',
        name: 'Feed',
        adGroupId: 'retargeting',
        metrics: { impressions: 10 },
        attrs: { placement: 'Feed' },
      },
    ]);
    expect(snapshot.datasets.daily).toEqual([
      { id: '2026-09-05', date: '2026-09-05', metrics: { impressions: 10, cost: 1 }, attrs: {} },
      { id: '2026-09-06', date: '2026-09-06', metrics: { impressions: 20, cost: 2 }, attrs: {} },
    ]);
    expect(snapshot.coverage.daily).toEqual({ status: 'complete', rows: 2 });
    expect(snapshot.warnings).toEqual(['daily: skipped 1 row(s) without a readable date']);
  });

  it('marks a dataset without cost and impressions as partial', () => {
    const snapshot = run([{ dataset: 'campaigns', text: 'Campaign,Clicks\nA,1\n' }]);
    const note = 'campaigns: missing columns cost, impressions';
    expect(snapshot.coverage.campaigns).toEqual({ status: 'partial', rows: 1, note });
    expect(snapshot.warnings).toEqual([note]);
  });

  it('resolves currency from input, then account, then XXX', () => {
    const files = [{ dataset: 'campaigns' as const, text: 'Campaign,Cost\nA,1\n' }];
    expect(run(files, { currency: 'GBP', account: { ...account, currency: 'TRY' } }).currency).toBe('GBP');
    expect(run(files, { account: { ...account, currency: 'TRY' } }).currency).toBe('TRY');
    expect(run(files).currency).toBe('XXX');
  });

  it('warns about duplicate ids', () => {
    const snapshot = run([{ dataset: 'campaigns', text: 'Campaign,Cost\nA,1\nA,2\n' }]);
    expect(snapshot.warnings).toHaveLength(1);
    expect(snapshot.warnings[0]).toContain('share an id');
  });

  it('rejects an unsupported dataset', () => {
    const attempt = () => run([{ dataset: 'conversion_actions', text: 'a,b\n1,2\n' }]);
    expect(attempt).toThrow(AutopilotError);
    try {
      attempt();
    } catch (error) {
      expect(error).toMatchObject({ code: 'unsupported' });
    }
  });

  it('puts two files into one deterministic snapshot', () => {
    const files = [
      { dataset: 'campaigns' as const, text: 'Campaign,Impr.,Cost\nBrand,10,1\n' },
      { dataset: 'ad_groups' as const, text: 'Campaign,Ad group,Ad group status,Impr.,Cost\nBrand,Core,Enabled,10,1\n' },
    ];
    const snapshot = run(files);
    expect(Object.keys(snapshot.datasets).sort()).toEqual(['ad_groups', 'campaigns']);
    expect(snapshot.coverage).toEqual({
      campaigns: { status: 'complete', rows: 1 },
      ad_groups: { status: 'complete', rows: 1 },
    });
    expect(snapshot.datasets.ad_groups?.[0]).toEqual({
      id: 'core',
      name: 'Core',
      campaignId: 'brand',
      metrics: { impressions: 10, cost: 1 },
      attrs: { status: 'ENABLED' },
    });
    expect(snapshot.id).toMatch(/^snap_[0-9a-f]{16}$/);
    expect(run(files).id).toBe(snapshot.id);
    expect(snapshot.accountId).toBe('acme-google');
  });
});
