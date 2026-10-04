import { describe, expect, it } from 'vitest';

import { demoDatasets } from '../../src/connectors/demo-data';
import type { AccountConfig, DatasetName, DateRange, Platform, Row } from '../../src/core/types';
import { PLATFORMS } from '../../src/core/types';

const D30: DateRange = { start: '2026-01-01', end: '2026-01-30' };
const D60: DateRange = { start: '2026-01-01', end: '2026-03-01' };
const D7: DateRange = { start: '2026-01-01', end: '2026-01-07' };

function account(platform: Platform): AccountConfig {
  return { id: `demo-${platform}`, platform, externalId: 'demo', source: 'demo' };
}

function load(platform: Platform, range: DateRange = D30): Record<string, Row[]> {
  return demoDatasets(account(platform), range) as Record<string, Row[]>;
}

function rows(data: Record<string, Row[]>, name: DatasetName): Row[] {
  const found = data[name];
  if (!found) throw new Error(`missing dataset ${name}`);
  return found;
}

function byId(list: Row[], id: string): Row {
  const row = list.find((r) => r.id === id);
  if (!row) throw new Error(`missing row ${id}`);
  return row;
}

const n = (row: Row, key: string): number => row.metrics[key] ?? 0;
const sum = (list: Row[], key: string): number => list.reduce((total, r) => total + n(r, key), 0);

describe('demoDatasets', () => {
  it('is deterministic', () => {
    for (const platform of PLATFORMS) {
      expect(demoDatasets(account(platform), D30)).toEqual(demoDatasets(account(platform), D30));
    }
  });

  it('exposes the documented datasets per platform', () => {
    expect(Object.keys(load('google_ads')).sort()).toEqual(
      ['ad_groups', 'ads', 'campaigns', 'conversion_actions', 'daily', 'devices', 'keywords', 'search_terms'].sort(),
    );
    expect(Object.keys(load('meta_ads')).sort()).toEqual(['ad_groups', 'ads', 'campaigns', 'daily', 'placements']);
    expect(Object.keys(load('ga4')).sort()).toEqual(['channels', 'daily', 'landing_pages']);
    expect(Object.keys(load('search_console')).sort()).toEqual(['pages', 'queries']);
    expect(Object.keys(load('mautic')).sort()).toEqual(['emails', 'lifecycle_campaigns', 'segments']);
  });

  it('returns nothing for an unknown platform', () => {
    const other = { ...account('ga4'), platform: 'tiktok_ads' as unknown as Platform };
    expect(demoDatasets(other, D30)).toEqual({});
  });

  it('scales additive metrics with the range', () => {
    for (const platform of ['google_ads', 'meta_ads'] as const) {
      const cost30 = sum(rows(load(platform, D30), 'campaigns'), 'cost');
      const cost60 = sum(rows(load(platform, D60), 'campaigns'), 'cost');
      expect(cost60 / cost30).toBeCloseTo(2, 2);
    }
    expect(rows(load('google_ads', D60), 'daily')).toHaveLength(60);
  });

  it('has non-negative metrics and unique ids for every range', () => {
    for (const range of [D7, D30, D60]) {
      for (const platform of PLATFORMS) {
        for (const [name, list] of Object.entries(load(platform, range))) {
          expect(new Set(list.map((r) => r.id)).size, `${platform}.${name} ids`).toBe(list.length);
          for (const row of list) {
            for (const value of Object.values(row.metrics)) {
              expect(value).toBeGreaterThanOrEqual(0);
            }
          }
        }
      }
    }
  });

  it('google_ads: campaigns carry the planted figures', () => {
    const campaigns = rows(load('google_ads'), 'campaigns');
    expect(campaigns.map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
    const c2 = byId(campaigns, 'c2');
    expect(c2.name).toBe('Search - Hiking Boots');
    expect(c2.metrics).toMatchObject({ cost: 3600, conversions: 110, conversionValue: 13200 });
    expect(c2.attrs).toMatchObject({ status: 'ENABLED', channelType: 'SEARCH', dailyBudget: 120, lostIsBudget: 0.35, lostIsRank: 0.1 });
    const c3 = byId(campaigns, 'c3');
    expect(n(c3, 'cost') / n(c3, 'conversions')).toBe(100);
    expect(c3.attrs.lostIsRank).toBe(0.4);
    const c4 = byId(campaigns, 'c4');
    expect(c4.metrics).toMatchObject({ cost: 2400, conversions: 0, conversionValue: 0 });
    expect(n(c4, 'clicks') / n(c4, 'impressions')).toBeCloseTo(0.012, 4);
    expect(byId(campaigns, 'c1').metrics).toMatchObject({ cost: 1500, conversions: 120, conversionValue: 9600 });
    expect(byId(campaigns, 'c5').attrs.channelType).toBe('SHOPPING');
    const c6 = byId(campaigns, 'c6');
    expect(c6.attrs).toMatchObject({ status: 'PAUSED', channelType: 'DISPLAY', dailyBudget: 30 });
    expect(sum([c6], 'cost') + sum([c6], 'impressions')).toBe(0);
  });

  it('google_ads: ad groups, ads and devices sum to their campaign', () => {
    for (const range of [D7, D30]) {
      const data = load('google_ads', range);
      for (const campaign of rows(data, 'campaigns').filter((c) => c.attrs.status === 'ENABLED')) {
        const groups = rows(data, 'ad_groups').filter((g) => g.campaignId === campaign.id);
        expect(groups.map((g) => g.id)).toEqual([`${campaign.id}-ag1`, `${campaign.id}-ag2`]);
        const devices = rows(data, 'devices').filter((d) => d.campaignId === campaign.id);
        expect(devices.map((d) => d.attrs.device).sort()).toEqual(['DESKTOP', 'MOBILE', 'TABLET']);
        for (const key of ['impressions', 'clicks', 'cost', 'conversions']) {
          expect(sum(groups, key)).toBeCloseTo(n(campaign, key), 2);
          expect(sum(devices, key)).toBeCloseTo(n(campaign, key), 2);
        }
      }
      const weak = rows(data, 'ad_groups').filter(
        (g) => g.campaignId === 'c4' && n(g, 'impressions') >= 1000 && n(g, 'clicks') / n(g, 'impressions') < 0.02,
      );
      expect(weak.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('google_ads: one disapproved enabled ad in c3', () => {
    const ads = rows(load('google_ads'), 'ads');
    const bad = ads.filter((a) => a.attrs.approvalStatus === 'DISAPPROVED');
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ campaignId: 'c3', attrs: { status: 'ENABLED' } });
    expect(ads.every((a) => a.id.startsWith(`${a.adGroupId}~`))).toBe(true);
    expect(ads.filter((a) => a !== bad[0]).every((a) => a.attrs.approvalStatus === 'APPROVED')).toBe(true);
  });

  it('google_ads: wasteful and low-quality keywords hold from 7 days up', () => {
    for (const range of [D7, D30]) {
      const keywords = rows(load('google_ads', range), 'keywords');
      expect(keywords.length).toBeGreaterThanOrEqual(18);
      expect(keywords.every((kw) => kw.id.startsWith(`${kw.adGroupId}~`))).toBe(true);
      const waste = keywords.filter(
        (kw) => kw.campaignId === 'c4' && kw.attrs.status === 'ENABLED' && n(kw, 'cost') >= 80 && n(kw, 'conversions') === 0 && n(kw, 'clicks') >= 30,
      );
      expect(waste.length).toBeGreaterThanOrEqual(3);
      const lowQs = keywords.filter((kw) => Number(kw.attrs.qualityScore) <= 3 && n(kw, 'cost') >= 40);
      expect(lowQs.length).toBeGreaterThanOrEqual(2);
      expect(keywords.some((kw) => Number(kw.attrs.qualityScore) >= 6 && Number(kw.attrs.qualityScore) <= 9)).toBe(true);
      expect(keywords.every((kw) => typeof kw.attrs.matchType === 'string' && typeof kw.attrs.bid === 'number')).toBe(true);
    }
  });

  it('google_ads: planted search terms hold from 7 days up', () => {
    const wasted = [
      'free hiking boots giveaway',
      'hiking boots repair jobs',
      'how to make a tent diy',
      'rei camping tents',
      'patagonia jackets sale',
      'tent rental near me',
    ];
    for (const range of [D7, D30]) {
      const terms = rows(load('google_ads', range), 'search_terms');
      expect(terms.length).toBeGreaterThanOrEqual(28);
      for (const term of wasted) {
        const row = terms.find((t) => t.name === term);
        expect(row, term).toBeDefined();
        expect(row?.metrics.cost).toBeGreaterThanOrEqual(80);
        expect(row?.metrics.conversions).toBe(0);
      }
      for (const row of terms) {
        expect(row.id).toBe(`${row.campaignId}:${row.adGroupId}:${row.name}`);
        expect(row.attrs.searchTermStatus).toBe('NONE');
        expect(typeof row.attrs.campaignName).toBe('string');
      }
      const brandLeak = terms.filter((t) => t.name?.includes('northwind') && t.campaignId !== 'c1');
      expect(brandLeak.map((t) => t.campaignId).sort()).toEqual(['c2', 'c3']);
    }
    const terms = rows(load('google_ads'), 'search_terms');
    expect(byId(terms, 'c2:c2-ag1:waterproof hiking boots').metrics.conversions).toBeGreaterThan(0);
    expect(byId(terms, 'c3:c3-ag1:4 person camping tent').metrics.conversions).toBeGreaterThan(0);
    expect(byId(terms, 'c3:c3-ag1:rei camping tents').attrs.campaignName).toBe('Search - Camping Tents');
  });

  it('google_ads: c2 tablet is expensive', () => {
    const data = load('google_ads');
    const tablet = byId(rows(data, 'devices'), 'c2:TABLET');
    expect(tablet.metrics.cost).toBe(540);
    expect(tablet.metrics.conversions).toBe(3);
    for (const range of [D7, D60]) {
      const scaled = load('google_ads', range);
      const c2 = byId(rows(scaled, 'campaigns'), 'c2');
      const t = byId(rows(scaled, 'devices'), 'c2:TABLET');
      expect(n(t, 'cost') / n(c2, 'cost')).toBeCloseTo(0.15, 3);
      expect(n(t, 'cost') / n(t, 'conversions')).toBeGreaterThan(2 * (n(c2, 'cost') / n(c2, 'conversions')));
    }
  });

  it('google_ads: daily is steady and conversion actions are planted', () => {
    const data = load('google_ads');
    const daily = rows(data, 'daily');
    expect(daily).toHaveLength(30);
    expect(daily[0]?.date).toBe('2026-01-01');
    expect(daily[29]?.date).toBe('2026-01-30');
    const campaigns = rows(data, 'campaigns');
    expect(Math.abs(sum(daily, 'cost') / sum(campaigns, 'cost') - 1)).toBeLessThan(0.05);
    expect(Math.abs(sum(daily, 'conversions') / sum(campaigns, 'conversions') - 1)).toBeLessThan(0.08);
    const conversions = daily.map((d) => n(d, 'conversions'));
    expect(Math.min(...conversions)).toBeGreaterThanOrEqual(0.8 * Math.max(...conversions));

    const actions = rows(data, 'conversion_actions');
    const purchase = actions.find((a) => a.name === 'Purchase');
    const pageView = actions.find((a) => a.name === 'Page view');
    const signup = actions.find((a) => a.name === 'Newsletter signup');
    expect(purchase?.attrs).toMatchObject({ status: 'ENABLED', category: 'PURCHASE', primary: true, countingType: 'MANY_PER_CLICK' });
    expect(pageView?.attrs).toMatchObject({ status: 'ENABLED', category: 'PAGE_VIEW', primary: true, countingType: 'MANY_PER_CLICK' });
    expect(signup?.attrs.primary).toBe(false);
  });

  it('meta_ads: campaigns and ad sets carry the planted figures', () => {
    const data = load('meta_ads');
    const campaigns = rows(data, 'campaigns');
    expect(byId(campaigns, 'm1')).toMatchObject({ name: 'Prospecting - Broad', metrics: { cost: 4000, conversions: 60, conversionValue: 7200 } });
    expect(byId(campaigns, 'm2')).toMatchObject({ name: 'Retargeting - Site Visitors', metrics: { cost: 1500, conversions: 75, conversionValue: 9000 } });
    expect(byId(campaigns, 'm3')).toMatchObject({ name: 'Lookalike - Purchasers', metrics: { cost: 1800, conversions: 12, conversionValue: 1300 } });
    for (const campaign of campaigns) {
      expect(campaign.attrs.status).toBe('ENABLED');
      expect(typeof campaign.attrs.dailyBudget).toBe('number');
      expect(typeof campaign.attrs.objective).toBe('string');
    }

    const sets = rows(data, 'ad_groups');
    expect(byId(sets, 'm3-as1').attrs.learningStatus).toBe('FAIL');
    expect(byId(sets, 'm1-as1').metrics).toMatchObject({ linkClicks: 1000, landingPageViews: 450 });
    for (const set of sets) {
      expect(typeof set.campaignId).toBe('string');
      expect(typeof set.attrs.dailyBudget).toBe('number');
      expect(typeof set.attrs.optimizationGoal).toBe('string');
      expect(n(set, 'linkClicks')).toBeGreaterThan(0);
      if (set.id !== 'm1-as1') expect(n(set, 'landingPageViews') / n(set, 'linkClicks')).toBeCloseTo(0.85, 2);
    }
    for (const range of [D7, D30]) {
      const dead = byId(rows(load('meta_ads', range), 'ad_groups'), 'm1-as2');
      expect(dead.metrics.cost).toBeGreaterThanOrEqual(600);
      expect(dead.metrics.conversions).toBe(0);
    }
  });

  it('meta_ads: fatigue, weak creative and the audience network placement', () => {
    for (const range of [D7, D30]) {
      const data = load('meta_ads', range);
      const ads = rows(data, 'ads');
      const linkCtr = (row: Row): number => n(row, 'linkClicks') / n(row, 'impressions');
      const pair = ads.filter((a) => a.adGroupId === 'm1-as1');
      expect(pair).toHaveLength(2);
      const tired = pair.find((a) => a.attrs.frequency === 4.2);
      const fresh = pair.find((a) => a.attrs.frequency !== 4.2);
      if (!tired || !fresh) throw new Error('missing fatigue pair');
      expect(linkCtr(tired) / linkCtr(fresh)).toBeCloseTo(0.5, 1);
      expect(Number(fresh.attrs.frequency)).toBeLessThan(3);
      const weak = ads.filter((a) => a.adGroupId !== 'm1-as1' && n(a, 'impressions') >= 3000 && linkCtr(a) < 0.008);
      expect(weak.length).toBeGreaterThanOrEqual(1);
      for (const ad of ads) {
        expect(typeof ad.attrs.headline).toBe('string');
        expect(typeof ad.attrs.description).toBe('string');
        expect(ad.attrs.status).toBe('ENABLED');
        expect(typeof ad.campaignId).toBe('string');
      }

      const placements = rows(data, 'placements');
      const set = byId(rows(data, 'ad_groups'), 'm2-as1');
      const network = byId(placements, 'm2-as1:audience_network:classic');
      expect(network.attrs.placement).toBe('audience_network:classic');
      expect(n(network, 'cost') / n(set, 'cost')).toBeCloseTo(0.15, 3);
      expect(n(network, 'conversions')).toBeGreaterThan(0);
      expect(n(network, 'cost') / n(network, 'conversions')).toBeGreaterThan(2 * (n(set, 'cost') / n(set, 'conversions')));
      expect(new Set(placements.map((p) => p.attrs.placement))).toEqual(
        new Set(['facebook:feed', 'instagram:feed', 'instagram:stories', 'audience_network:classic']),
      );
      expect(placements.every((p) => p.id === `${p.adGroupId}:${p.attrs.placement}`)).toBe(true);
    }
    const daily = rows(load('meta_ads'), 'daily');
    expect(daily).toHaveLength(30);
    const conversions = daily.map((d) => n(d, 'conversions'));
    expect(Math.min(...conversions)).toBeGreaterThanOrEqual(0.8 * Math.max(...conversions));
  });

  it('ga4: unassigned share and weak landing pages', () => {
    for (const range of [D7, D30]) {
      const data = load('ga4', range);
      const channels = rows(data, 'channels');
      expect(channels.map((c) => c.name)).toEqual(['Paid Search', 'Paid Social', 'Organic Search', 'Direct', 'Email', 'Referral', 'Unassigned']);
      expect(n(byId(channels, 'Unassigned'), 'sessions') / sum(channels, 'sessions')).toBeCloseTo(0.14, 2);
      const pages = rows(data, 'landing_pages');
      expect(pages).toHaveLength(8);
      const weak = pages.filter((p) => n(p, 'sessions') >= 200 && n(p, 'engagedSessions') / n(p, 'sessions') < 0.3);
      expect(weak).toHaveLength(2);
      for (const row of [...channels, ...pages]) {
        expect(Object.keys(row.metrics).sort()).toEqual(['engagedSessions', 'keyEvents', 'revenue', 'sessions']);
      }
    }
    const daily = rows(load('ga4'), 'daily');
    expect(daily).toHaveLength(30);
    expect(daily.every((d) => typeof d.date === 'string' && n(d, 'sessions') > 0)).toBe(true);
  });

  it('search_console: striking-distance and low-ctr queries', () => {
    for (const range of [D7, D30]) {
      const data = load('search_console', range);
      const queries = rows(data, 'queries');
      expect(queries).toHaveLength(25);
      const position = (r: Row): number => Number(r.attrs.position);
      const striking = queries.filter((q) => position(q) >= 5 && position(q) <= 20 && n(q, 'impressions') >= 1000);
      expect(striking.length).toBeGreaterThanOrEqual(5);
      const lowCtr = queries.filter((q) => position(q) <= 3 && n(q, 'impressions') >= 1000 && Number(q.attrs.ctr) < 0.1);
      expect(lowCtr.length).toBeGreaterThanOrEqual(2);
      expect(rows(data, 'pages')).toHaveLength(10);
      for (const q of queries) {
        expect(n(q, 'clicks')).toBeLessThanOrEqual(n(q, 'impressions'));
      }
    }
  });

  it('mautic: segments, emails and lifecycle campaigns', () => {
    for (const range of [D7, D30]) {
      const data = load('mautic', range);
      const segments = rows(data, 'segments');
      expect(segments).toHaveLength(6);
      expect(segments.filter((s) => s.attrs.published === true && n(s, 'contacts') === 0)).toHaveLength(1);
      expect(segments.every((s) => typeof s.attrs.alias === 'string')).toBe(true);

      const emails = rows(data, 'emails');
      expect(emails).toHaveLength(6);
      const rate = (row: Row, key: string): number => n(row, key) / n(row, 'sent');
      expect(emails.every((e) => n(e, 'sent') >= 200)).toBe(true);
      expect(emails.filter((e) => Math.abs(rate(e, 'unsubscribed') - 0.02) < 0.002)).toHaveLength(1);
      expect(emails.filter((e) => Math.abs(rate(e, 'bounced') - 0.08) < 0.002)).toHaveLength(1);
      expect(emails.filter((e) => Math.abs(rate(e, 'read') - 0.09) < 0.002)).toHaveLength(1);
      for (const email of emails) {
        expect(typeof email.attrs.subject).toBe('string');
        expect(typeof email.attrs.emailType).toBe('string');
        expect(typeof email.attrs.published).toBe('boolean');
      }

      const lifecycle = rows(data, 'lifecycle_campaigns');
      expect(lifecycle).toHaveLength(4);
      const off = lifecycle.filter((c) => c.attrs.published === false);
      expect(off).toHaveLength(1);
      expect(off[0]?.metrics.contacts).toBe(340);
    }
    const emails = rows(load('mautic'), 'emails');
    expect(byId(emails, '3').metrics).toMatchObject({ sent: 5000, unsubscribed: 100 });
    expect(byId(emails, '4').metrics).toMatchObject({ sent: 2500, bounced: 200 });
    expect(byId(emails, '5').metrics).toMatchObject({ sent: 4000, read: 360 });
  });
});
