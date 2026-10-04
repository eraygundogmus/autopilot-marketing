import { addDays, assertRange, daysInRange } from '../core/dates';
import type { AccountConfig, AttrValue, DatasetName, DateRange, Metrics, Row } from '../core/types';

type Datasets = Partial<Record<DatasetName, Row[]>>;
type Attrs = Record<string, AttrValue>;

/** 30-day figures: impressions, clicks, cost, conversions, conversionValue. */
type Base = readonly [number, number, number, number, number];

const r2 = (n: number): number => Math.round(n * 100) / 100;
const int = (n: number): number => Math.round(n);

function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function toMetrics(b: Base, k: number): Metrics {
  return {
    impressions: int(b[0] * k),
    clicks: int(b[1] * k),
    cost: r2(b[2] * k),
    conversions: int(b[3] * k),
    conversionValue: r2(b[4] * k),
  };
}

const MONEY_KEYS = new Set(['cost', 'conversionValue', 'revenue']);

/** Share of already-scaled metrics; `convShare` applies to conversions and their value. */
function share(m: Metrics, costShare: number, convShare: number = costShare): Metrics {
  const out: Metrics = {};
  for (const [key, value] of Object.entries(m)) {
    if (value === undefined) continue;
    const s = key === 'conversions' || key === 'conversionValue' ? convShare : costShare;
    out[key] = MONEY_KEYS.has(key) ? r2(value * s) : int(value * s);
  }
  return out;
}

function minus(m: Metrics, ...parts: Metrics[]): Metrics {
  const out: Metrics = {};
  for (const [key, value] of Object.entries(m)) {
    if (value === undefined) continue;
    const rest = parts.reduce((left, p) => left - (p[key] ?? 0), value);
    out[key] = Math.max(0, MONEY_KEYS.has(key) ? r2(rest) : int(rest));
  }
  return out;
}

function dailyRows(range: DateRange, days: number, rng: () => number, per30: Record<string, number>): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < days; i += 1) {
    const date = addDays(range.start, i);
    const jitter = 1 + (rng() - 0.5) * 0.1;
    const metrics: Metrics = {};
    for (const [key, total] of Object.entries(per30)) {
      const value = (total / 30) * jitter;
      metrics[key] = MONEY_KEYS.has(key) ? r2(value) : int(value);
    }
    rows.push({ id: date, date, metrics, attrs: {} });
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// google_ads
// ---------------------------------------------------------------------------------------------

/** id, name, status, channelType, dailyBudget, lostIsBudget, lostIsRank, base, ad group names. */
const G_CAMPAIGNS: ReadonlyArray<
  readonly [string, string, string, string, number, number, number, Base, readonly [string, string]]
> = [
  ['c1', 'Brand - Northwind', 'ENABLED', 'SEARCH', 60, 0.02, 0.05, [30000, 2100, 1500, 120, 9600], ['Brand Core', 'Brand Products']],
  ['c2', 'Search - Hiking Boots', 'ENABLED', 'SEARCH', 120, 0.35, 0.1, [60000, 3000, 3600, 110, 13200], ['Waterproof Boots', 'Mens and Womens Boots']],
  ['c3', 'Search - Camping Tents', 'ENABLED', 'SEARCH', 100, 0.05, 0.4, [50000, 2000, 3000, 30, 4500], ['Family Tents', 'Backpacking Tents']],
  ['c4', 'Search - Generic Outdoor', 'ENABLED', 'SEARCH', 80, 0.1, 0.2, [100000, 1200, 2400, 0, 0], ['Outdoor Gear', 'Outdoor Store']],
  ['c5', 'Shopping - All Products', 'ENABLED', 'SHOPPING', 90, 0.1, 0.15, [200000, 2500, 2500, 70, 9100], ['Footwear', 'Camp Equipment']],
  ['c6', 'Display - Remarketing', 'PAUSED', 'DISPLAY', 30, 0, 0, [0, 0, 0, 0, 0], ['', '']],
];

/** adGroupId, n, text, matchType, qualityScore, bid, impressions, clicks, cost, conversions. */
const G_KEYWORDS: ReadonlyArray<
  readonly [string, number, string, string, number, number, number, number, number, number]
> = [
  ['c1-ag1', 1, 'northwind outdoor', 'EXACT', 9, 0.8, 12000, 900, 620, 55],
  ['c1-ag1', 2, 'northwind', 'PHRASE', 9, 0.7, 6000, 380, 280, 20],
  ['c1-ag2', 1, 'northwind hiking boots', 'EXACT', 8, 0.9, 7000, 500, 360, 28],
  ['c1-ag2', 2, 'northwind tents', 'EXACT', 8, 0.9, 5000, 320, 240, 17],
  ['c2-ag1', 1, 'waterproof hiking boots', 'EXACT', 8, 1.3, 16000, 850, 1000, 34],
  ['c2-ag1', 2, 'gore tex hiking boots', 'PHRASE', 7, 1.4, 10000, 480, 600, 18],
  ['c2-ag1', 3, 'best hiking boots', 'PHRASE', 6, 1.5, 9000, 420, 560, 14],
  ['c2-ag2', 1, 'mens hiking boots', 'EXACT', 7, 1.2, 13000, 650, 760, 24],
  ['c2-ag2', 2, 'womens hiking boots', 'EXACT', 8, 1.2, 12000, 600, 680, 20],
  ['c3-ag1', 1, '4 person camping tent', 'EXACT', 6, 1.6, 12000, 520, 760, 12],
  ['c3-ag1', 2, 'family camping tent', 'PHRASE', 6, 1.6, 9000, 380, 560, 7],
  ['c3-ag1', 3, 'camping tents', 'BROAD', 3, 1.9, 9000, 300, 480, 2],
  ['c3-ag2', 1, 'backpacking tent', 'EXACT', 7, 1.5, 9000, 380, 520, 6],
  ['c3-ag2', 2, '2 person tent', 'PHRASE', 6, 1.5, 6000, 250, 360, 3],
  ['c3-ag2', 3, 'cheap tents', 'BROAD', 2, 2.0, 5000, 170, 320, 0],
  ['c4-ag1', 1, 'outdoor gear', 'BROAD', 4, 2.0, 30000, 350, 700, 0],
  ['c4-ag1', 2, 'camping stuff', 'BROAD', 3, 2.0, 27000, 300, 600, 0],
  ['c4-ag2', 1, 'outdoor store', 'PHRASE', 5, 2.0, 24000, 300, 600, 0],
  ['c4-ag2', 2, 'hiking things', 'BROAD', 2, 2.0, 19000, 250, 500, 0],
  ['c1-ag1', 3, 'northwind outdoor store', 'EXACT', 9, 0.7, 2000, 140, 100, 8],
];

/** campaignId, ad group (1 | 2), term, clicks, cost, conversions. */
const G_TERMS: ReadonlyArray<readonly [string, 1 | 2, string, number, number, number]> = [
  ['c1', 1, 'northwind outdoor', 850, 600, 50],
  ['c1', 1, 'northwind store', 420, 300, 24],
  ['c1', 2, 'northwind boots', 350, 250, 20],
  ['c1', 1, 'northwind coupon', 210, 150, 12],
  ['c1', 2, 'northwind tents review', 140, 100, 6],
  ['c2', 1, 'waterproof hiking boots', 600, 700, 30],
  ['c2', 2, 'mens hiking boots', 420, 500, 20],
  ['c2', 2, 'womens hiking boots', 330, 400, 16],
  ['c2', 1, 'leather hiking boots', 210, 250, 9],
  ['c2', 1, 'lightweight hiking boots', 170, 200, 8],
  ['c2', 1, 'northwind hiking boots', 170, 200, 14],
  ['c2', 1, 'free hiking boots giveaway', 300, 360, 0],
  ['c2', 2, 'hiking boots repair jobs', 290, 350, 0],
  ['c3', 1, '4 person camping tent', 330, 500, 10],
  ['c3', 2, 'backpacking tent', 200, 300, 6],
  ['c3', 2, '2 person tent', 170, 250, 4],
  ['c3', 1, 'family tent', 130, 200, 3],
  ['c3', 1, 'northwind tents', 100, 150, 5],
  ['c3', 1, 'how to make a tent diy', 270, 400, 0],
  ['c3', 1, 'rei camping tents', 300, 450, 0],
  ['c3', 2, 'tent rental near me', 250, 380, 0],
  ['c4', 1, 'patagonia jackets sale', 250, 500, 0],
  ['c4', 1, 'outdoor gear', 200, 400, 0],
  ['c4', 1, 'camping stuff', 175, 350, 0],
  ['c4', 2, 'outdoor store near me', 150, 300, 0],
  ['c4', 2, 'hiking equipment', 125, 250, 0],
  ['c4', 2, 'camping gear list', 100, 200, 0],
  ['c5', 1, 'trekking poles', 250, 250, 7],
  ['c5', 2, 'camping stove', 300, 300, 9],
  ['c5', 2, 'sleeping bag', 350, 350, 10],
];

/** device, cost share, conversion share; DESKTOP takes the remainder. */
const G_DEVICES: ReadonlyArray<readonly [string, number, number]> = [
  ['MOBILE', 0.55, 0.52],
  ['TABLET', 0.08, 0.07],
];
const G_DEVICES_C2: ReadonlyArray<readonly [string, number, number]> = [
  ['MOBILE', 0.5, 0.52],
  ['TABLET', 0.15, 3 / 110],
];

function googleAds(range: DateRange, days: number, k: number, rng: () => number): Datasets {
  const campaigns: Row[] = [];
  const adGroups: Row[] = [];
  const ads: Row[] = [];
  const devices: Row[] = [];
  const names = new Map<string, string>();

  for (const [id, name, status, channelType, dailyBudget, lostIsBudget, lostIsRank, base, agNames] of G_CAMPAIGNS) {
    const metrics = toMetrics(base, k);
    names.set(id, name);
    campaigns.push({
      id,
      name,
      metrics,
      attrs: { status, channelType, dailyBudget, biddingStrategy: 'MAXIMIZE_CONVERSIONS', lostIsBudget, lostIsRank },
    });
    if (status !== 'ENABLED') continue;

    const first = share(metrics, 0.6);
    const groups: Metrics[] = [first, minus(metrics, first)];
    groups.forEach((groupMetrics, index) => {
      const adGroupId = `${id}-ag${index + 1}`;
      adGroups.push({
        id: adGroupId,
        name: agNames[index] ?? adGroupId,
        campaignId: id,
        metrics: groupMetrics,
        attrs: { status: 'ENABLED' },
      });
      const firstAd = share(groupMetrics, 0.55);
      [firstAd, minus(groupMetrics, firstAd)].forEach((adMetrics, adIndex) => {
        const adId = `${adGroupId}~${adIndex + 1}`;
        ads.push({
          id: adId,
          name: `${agNames[index] ?? adGroupId} RSA ${adIndex + 1}`,
          campaignId: id,
          adGroupId,
          metrics: adMetrics,
          attrs: {
            status: 'ENABLED',
            approvalStatus: adId === 'c3-ag1~2' ? 'DISAPPROVED' : 'APPROVED',
            headline: `${agNames[index] ?? name} | Northwind Outdoor`,
            description: 'Hiking and camping gear. Free shipping over $50.',
            finalUrl: `https://northwind-outdoor.example/${id}/${index + 1}`,
          },
        });
      });
    });

    const parts = (id === 'c2' ? G_DEVICES_C2 : G_DEVICES).map(
      ([device, costShare, convShare]) => [device, share(metrics, costShare, convShare)] as const,
    );
    const all = [...parts, ['DESKTOP', minus(metrics, ...parts.map(([, m]) => m))] as const];
    for (const [device, deviceMetrics] of all) {
      devices.push({ id: `${id}:${device}`, name: `${name} / ${device}`, campaignId: id, metrics: deviceMetrics, attrs: { device } });
    }
  }

  const keywords: Row[] = G_KEYWORDS.map(([adGroupId, n, text, matchType, qualityScore, bid, impressions, clicks, cost, conversions]) => ({
    id: `${adGroupId}~${n}`,
    name: text,
    campaignId: adGroupId.slice(0, 2),
    adGroupId,
    metrics: toMetrics([impressions, clicks, cost, conversions, conversions * 110], k),
    attrs: { status: 'ENABLED', matchType, qualityScore, bid },
  }));

  const searchTerms: Row[] = G_TERMS.map(([campaignId, group, term, clicks, cost, conversions]) => {
    const adGroupId = `${campaignId}-ag${group}`;
    return {
      id: `${campaignId}:${adGroupId}:${term}`,
      name: term,
      campaignId,
      adGroupId,
      metrics: toMetrics([clicks * 18, clicks, cost, conversions, conversions * 110], k),
      attrs: { searchTermStatus: 'NONE', campaignName: names.get(campaignId) ?? campaignId },
    };
  });

  const totals = G_CAMPAIGNS.reduce<number[]>((sum, row) => row[7].map((v, i) => v + (sum[i] ?? 0)), []);
  const daily = dailyRows(range, days, rng, {
    impressions: totals[0] ?? 0,
    clicks: totals[1] ?? 0,
    cost: totals[2] ?? 0,
    conversions: totals[3] ?? 0,
    conversionValue: totals[4] ?? 0,
  });

  const action = (id: string, name: string, category: string, primary: boolean, conversions: number, value: number): Row => ({
    id,
    name,
    metrics: { conversions: int(conversions * k), conversionValue: r2(value * k) },
    attrs: { status: 'ENABLED', category, primary, countingType: 'MANY_PER_CLICK' },
  });
  const conversionActions = [
    action('ca1', 'Purchase', 'PURCHASE', true, 330, 36400),
    action('ca2', 'Page view', 'PAGE_VIEW', true, 9800, 0),
    action('ca3', 'Newsletter signup', 'SIGNUP', false, 410, 0),
  ];

  return {
    campaigns,
    ad_groups: adGroups,
    ads,
    keywords,
    search_terms: searchTerms,
    devices,
    daily,
    conversion_actions: conversionActions,
  };
}

// ---------------------------------------------------------------------------------------------
// meta_ads
// ---------------------------------------------------------------------------------------------

const M_CAMPAIGNS: ReadonlyArray<readonly [string, string, number]> = [
  ['m1', 'Prospecting - Broad', 135],
  ['m2', 'Retargeting - Site Visitors', 50],
  ['m3', 'Lookalike - Purchasers', 60],
];

/** id, name, dailyBudget, learningStatus, impressions, linkClicks, landingPageViews, cost, conversions, value. */
const M_ADSETS: ReadonlyArray<
  readonly [string, string, number, string, number, number, number, number, number, number]
> = [
  ['m1-as1', 'Broad - US 25-54', 50, 'SUCCESS', 70000, 1000, 450, 1400, 60, 7200],
  ['m1-as2', 'Broad - Outdoor Interests', 85, 'SUCCESS', 130000, 2000, 1700, 2600, 0, 0],
  ['m2-as1', 'Visitors 30d', 36, 'SUCCESS', 50000, 1300, 1105, 1100, 60, 7200],
  ['m2-as2', 'Cart Abandoners 14d', 14, 'SUCCESS', 20000, 500, 425, 400, 15, 1800],
  ['m3-as1', 'Lookalike 1% Purchasers', 60, 'FAIL', 100000, 1200, 1020, 1800, 12, 1300],
];

/** adGroupId, n, headline, impressions, linkClicks, share of the ad set's cost and conversions, frequency. */
const M_ADS: ReadonlyArray<readonly [string, number, string, number, number, number, number]> = [
  ['m1-as1', 1, 'Trail-ready boots', 50000, 556, 0.7, 4.2],
  ['m1-as1', 2, 'Built for the long way', 20000, 444, 0.3, 1.6],
  ['m1-as2', 1, 'Gear up for the weekend', 70000, 1200, 0.55, 1.8],
  ['m1-as2', 2, 'Camp anywhere', 60000, 800, 0.45, 1.7],
  ['m2-as1', 1, 'Still thinking it over?', 30000, 800, 0.6, 2.4],
  ['m2-as1', 2, 'Your boots are waiting', 20000, 500, 0.4, 2.2],
  ['m2-as2', 1, 'Finish your order', 20000, 500, 1, 2.6],
  ['m3-as1', 1, 'Loved by hikers', 40000, 900, 0.45, 1.5],
  ['m3-as1', 2, 'Shop outdoor gear', 60000, 300, 0.55, 1.9],
];

/** placement, cost share, conversion share. */
const M_PLACEMENTS: ReadonlyArray<readonly [string, number, number]> = [
  ['facebook:feed', 0.45, 0.47],
  ['instagram:feed', 0.3, 0.3],
  ['instagram:stories', 0.17, 0.17],
  ['audience_network:classic', 0.08, 0.06],
];
const M_PLACEMENTS_M2: ReadonlyArray<readonly [string, number, number]> = [
  ['facebook:feed', 0.45, 0.5],
  ['instagram:feed', 0.25, 0.3],
  ['instagram:stories', 0.15, 0.16],
  ['audience_network:classic', 0.15, 0.04],
];

/** All clicks on a Meta ad, relative to its link clicks. */
const CLICKS_PER_LINK_CLICK = 1.2;

function metaMetrics(
  k: number,
  impressions: number,
  linkClicks: number,
  landingPageViews: number,
  cost: number,
  conversions: number,
  value: number,
): Metrics {
  return {
    ...toMetrics([impressions, linkClicks * CLICKS_PER_LINK_CLICK, cost, conversions, value], k),
    linkClicks: int(linkClicks * k),
    landingPageViews: int(landingPageViews * k),
  };
}

function metaAds(range: DateRange, days: number, k: number, rng: () => number): Datasets {
  const adGroups: Row[] = M_ADSETS.map(
    ([id, name, dailyBudget, learningStatus, impressions, linkClicks, landingPageViews, cost, conversions, value]) => ({
      id,
      name,
      campaignId: id.slice(0, 2),
      metrics: metaMetrics(k, impressions, linkClicks, landingPageViews, cost, conversions, value),
      attrs: { status: 'ENABLED', dailyBudget, learningStatus, optimizationGoal: 'OFFSITE_CONVERSIONS' },
    }),
  );

  const campaigns: Row[] = M_CAMPAIGNS.map(([id, name, dailyBudget]) => {
    const metrics: Metrics = {};
    for (const row of adGroups) {
      if (row.campaignId !== id) continue;
      for (const [key, value] of Object.entries(row.metrics)) {
        const sum = (metrics[key] ?? 0) + (value ?? 0);
        metrics[key] = MONEY_KEYS.has(key) ? r2(sum) : sum;
      }
    }
    return { id, name, metrics, attrs: { status: 'ENABLED', dailyBudget, objective: 'OUTCOME_SALES' } };
  });

  const ads: Row[] = M_ADS.map(([adGroupId, n, headline, impressions, linkClicks, part, frequency]) => {
    const set = M_ADSETS.find((row) => row[0] === adGroupId);
    const lpvRate = set ? set[6] / set[5] : 0.85;
    const metrics = metaMetrics(
      k,
      impressions,
      linkClicks,
      linkClicks * lpvRate,
      (set?.[7] ?? 0) * part,
      (set?.[8] ?? 0) * part,
      (set?.[9] ?? 0) * part,
    );
    return {
      id: `${adGroupId}-ad${n}`,
      name: headline,
      campaignId: adGroupId.slice(0, 2),
      adGroupId,
      metrics,
      attrs: {
        status: 'ENABLED',
        frequency,
        reach: int((metrics.impressions ?? 0) / frequency),
        headline,
        description: 'Hiking and camping gear from Northwind Outdoor.',
      },
    };
  });

  const placements: Row[] = adGroups.flatMap((set) =>
    (set.id === 'm2-as1' ? M_PLACEMENTS_M2 : M_PLACEMENTS).map(([placement, costShare, convShare]) => ({
      id: `${set.id}:${placement}`,
      name: `${set.name ?? set.id} / ${placement}`,
      campaignId: set.id.slice(0, 2),
      adGroupId: set.id,
      metrics: share(set.metrics, costShare, convShare),
      attrs: { placement },
    })),
  );

  const per30: Record<string, number> = {
    impressions: 0,
    clicks: 0,
    cost: 0,
    conversions: 0,
    conversionValue: 0,
    linkClicks: 0,
    landingPageViews: 0,
  };
  for (const [, , , , impressions, linkClicks, landingPageViews, cost, conversions, value] of M_ADSETS) {
    per30.impressions = (per30.impressions ?? 0) + impressions;
    per30.clicks = (per30.clicks ?? 0) + linkClicks * CLICKS_PER_LINK_CLICK;
    per30.cost = (per30.cost ?? 0) + cost;
    per30.conversions = (per30.conversions ?? 0) + conversions;
    per30.conversionValue = (per30.conversionValue ?? 0) + value;
    per30.linkClicks = (per30.linkClicks ?? 0) + linkClicks;
    per30.landingPageViews = (per30.landingPageViews ?? 0) + landingPageViews;
  }

  return { campaigns, ad_groups: adGroups, ads, placements, daily: dailyRows(range, days, rng, per30) };
}

// ---------------------------------------------------------------------------------------------
// ga4
// ---------------------------------------------------------------------------------------------

/** name or path, sessions, engaged share, keyEvents, revenue. */
type Ga4Row = readonly [string, number, number, number, number];

const GA_CHANNELS: ReadonlyArray<Ga4Row> = [
  ['Paid Search', 12000, 0.62, 330, 36400],
  ['Paid Social', 8000, 0.48, 140, 16500],
  ['Organic Search', 13000, 0.66, 260, 28600],
  ['Direct', 6000, 0.6, 150, 17200],
  ['Email', 2500, 0.7, 90, 9900],
  ['Referral', 1500, 0.58, 25, 2700],
  ['Unassigned', 7000, 0.35, 20, 2100],
];

const GA_PAGES: ReadonlyArray<Ga4Row> = [
  ['/', 11000, 0.64, 180, 20500],
  ['/hiking-boots', 9000, 0.68, 290, 33800],
  ['/camping-tents', 7000, 0.22, 35, 5200],
  ['/outdoor-gear', 6000, 0.25, 10, 1100],
  ['/sale', 5000, 0.6, 210, 21400],
  ['/backpacks', 4500, 0.63, 120, 12600],
  ['/blog/how-to-choose-hiking-boots', 4000, 0.71, 60, 6900],
  ['/sleeping-bags', 3500, 0.59, 110, 12000],
];

function ga4Rows(table: ReadonlyArray<Ga4Row>, k: number, attr: string): Row[] {
  return table.map(([name, sessions, engaged, keyEvents, revenue]) => {
    const scaled = int(sessions * k);
    return {
      id: name,
      name,
      metrics: { sessions: scaled, engagedSessions: int(scaled * engaged), keyEvents: int(keyEvents * k), revenue: r2(revenue * k) },
      attrs: { [attr]: name },
    };
  });
}

function ga4(range: DateRange, days: number, k: number, rng: () => number): Datasets {
  const per30 = { sessions: 0, engagedSessions: 0, keyEvents: 0, revenue: 0 };
  for (const [, sessions, engaged, keyEvents, revenue] of GA_CHANNELS) {
    per30.sessions += sessions;
    per30.engagedSessions += sessions * engaged;
    per30.keyEvents += keyEvents;
    per30.revenue += revenue;
  }
  return {
    channels: ga4Rows(GA_CHANNELS, k, 'channel'),
    landing_pages: ga4Rows(GA_PAGES, k, 'landingPage'),
    daily: dailyRows(range, days, rng, per30),
  };
}

// ---------------------------------------------------------------------------------------------
// search_console
// ---------------------------------------------------------------------------------------------

/** query or page, 30-day impressions, ctr (fraction), average position. */
type GscRow = readonly [string, number, number, number];

const GSC_QUERIES: ReadonlyArray<GscRow> = [
  ['northwind outdoor', 9000, 0.42, 1.1],
  ['northwind hiking boots', 6000, 0.38, 1.3],
  ['best waterproof hiking boots', 22000, 0.04, 2.4],
  ['4 person camping tent', 15000, 0.06, 2.9],
  ['hiking boots', 60000, 0.012, 8.6],
  ['camping tents', 48000, 0.009, 11.2],
  ['waterproof hiking boots', 26000, 0.021, 6.4],
  ['backpacking tent', 18000, 0.015, 9.8],
  ['how to break in hiking boots', 12000, 0.018, 7.3],
  ['trekking poles', 14000, 0.008, 14.5],
  ['sleeping bag temperature ratings', 9000, 0.011, 12.1],
  ['mens hiking boots', 16000, 0.006, 18.4],
  ['camping stove', 11000, 0.004, 24.0],
  ['hiking backpack', 13000, 0.003, 31.5],
  ['how to choose hiking boots', 7000, 0.19, 2.2],
  ['family camping checklist', 5000, 0.16, 3.4],
  ['northwind tents', 2400, 0.4, 1.2],
  ['leather hiking boots care', 3200, 0.12, 4.1],
  ['ultralight tent', 4000, 0.007, 22.3],
  ['camping gear sale', 3600, 0.02, 9.1],
  ['winter hiking boots', 3000, 0.017, 10.4],
  ['tent footprint', 2600, 0.03, 6.8],
  ['hiking socks', 3400, 0.005, 27.9],
  ['northwind outdoor reviews', 1500, 0.31, 1.6],
  ['camp chairs', 2800, 0.004, 35.2],
];

const GSC_PAGES: ReadonlyArray<GscRow> = [
  ['https://northwind-outdoor.example/', 40000, 0.11, 3.2],
  ['https://northwind-outdoor.example/hiking-boots', 95000, 0.02, 7.9],
  ['https://northwind-outdoor.example/camping-tents', 80000, 0.012, 10.6],
  ['https://northwind-outdoor.example/backpacks', 22000, 0.006, 26.0],
  ['https://northwind-outdoor.example/sleeping-bags', 18000, 0.01, 13.4],
  ['https://northwind-outdoor.example/sale', 9000, 0.03, 8.8],
  ['https://northwind-outdoor.example/blog/how-to-choose-hiking-boots', 21000, 0.09, 3.9],
  ['https://northwind-outdoor.example/blog/family-camping-checklist', 12000, 0.08, 4.6],
  ['https://northwind-outdoor.example/trekking-poles', 15000, 0.008, 14.2],
  ['https://northwind-outdoor.example/camp-kitchen', 13000, 0.004, 23.7],
];

function gscRows(table: ReadonlyArray<GscRow>, k: number): Row[] {
  return table.map(([name, impressions, ctr, position]) => {
    const scaled = int(impressions * k);
    return { id: name, name, metrics: { clicks: int(scaled * ctr), impressions: scaled }, attrs: { ctr, position } };
  });
}

// ---------------------------------------------------------------------------------------------
// mautic
// ---------------------------------------------------------------------------------------------

const MAUTIC_SEGMENTS: ReadonlyArray<readonly [string, string, string, boolean, number]> = [
  ['1', 'Newsletter subscribers', 'newsletter-subscribers', true, 8400],
  ['2', 'Customers', 'customers', true, 3100],
  ['3', 'Cart abandoners', 'cart-abandoners', true, 620],
  ['4', 'VIP repeat buyers', 'vip-repeat-buyers', true, 0],
  ['5', 'Inactive 90 days', 'inactive-90-days', true, 1900],
  ['6', 'Trade show leads 2023', 'trade-show-leads-2023', false, 240],
];

/** id, name, subject, emailType, published, 30-day sent, read rate, click rate, unsubscribe rate, bounce rate. */
const MAUTIC_EMAILS: ReadonlyArray<
  readonly [string, string, string, string, boolean, number, number, number, number, number]
> = [
  ['1', 'Weekly newsletter', 'New arrivals for the trail', 'list', true, 8000, 0.28, 0.04, 0.003, 0.01],
  ['2', 'Welcome', 'Welcome to Northwind Outdoor', 'template', true, 1200, 0.52, 0.12, 0.004, 0.012],
  ['3', 'Spring sale blast', 'Spring sale: 30% off tents', 'list', true, 5000, 0.22, 0.03, 0.02, 0.015],
  ['4', 'Trade show follow-up', 'Good to meet you', 'list', true, 2500, 0.18, 0.02, 0.005, 0.08],
  ['5', 'Win-back', 'We miss you on the trail', 'list', true, 4000, 0.09, 0.008, 0.006, 0.02],
  ['6', 'Cart reminder', 'Your cart is waiting', 'template', true, 1000, 0.41, 0.15, 0.002, 0.008],
];

const MAUTIC_CAMPAIGNS: ReadonlyArray<readonly [string, string, boolean, number]> = [
  ['1', 'Welcome series', true, 1200],
  ['2', 'Cart recovery', true, 620],
  ['3', 'Post-purchase review request', false, 340],
  ['4', 'Win-back 90 days', true, 1900],
];

function mautic(k: number): Datasets {
  return {
    // Contact counts are a stock, not a flow: they do not scale with the date range.
    segments: MAUTIC_SEGMENTS.map(([id, name, alias, published, contacts]) => ({
      id,
      name,
      metrics: { contacts },
      attrs: { alias, published },
    })),
    emails: MAUTIC_EMAILS.map(([id, name, subject, emailType, published, sent30, read, clicked, unsubscribed, bounced]) => {
      const sent = int(sent30 * k);
      return {
        id,
        name,
        metrics: {
          sent,
          read: int(sent * read),
          clicked: int(sent * clicked),
          unsubscribed: int(sent * unsubscribed),
          bounced: int(sent * bounced),
        },
        attrs: { subject, published, emailType },
      };
    }),
    lifecycle_campaigns: MAUTIC_CAMPAIGNS.map(([id, name, published, contacts]) => ({
      id,
      name,
      metrics: { contacts },
      attrs: { published },
    })),
  };
}

/**
 * A deterministic synthetic account for `account.platform`, seeded by the account id and scaled to
 * the date range. It carries the problems the checks look for, so a demo audit has findings.
 */
export function demoDatasets(account: AccountConfig, dateRange: DateRange): Partial<Record<DatasetName, Row[]>> {
  assertRange(dateRange);
  const days = daysInRange(dateRange);
  const k = days / 30;
  const rng = mulberry32(hash32(account.id));
  switch (account.platform) {
    case 'google_ads':
      return googleAds(dateRange, days, k, rng);
    case 'meta_ads':
      return metaAds(dateRange, days, k, rng);
    case 'ga4':
      return ga4(dateRange, days, k, rng);
    case 'search_console':
      return { queries: gscRows(GSC_QUERIES, k), pages: gscRows(GSC_PAGES, k) };
    case 'mautic':
      return mautic(k);
    default:
      return {};
  }
}
