/**
 * Shared contract for every module. Change it only together with its users.
 *
 * Conventions
 * - Money is a decimal number in the account currency's major units (12.34 = twelve dollars
 *   thirty-four). Connectors convert platform units (Google micros, Meta minor units) at the
 *   boundary and nowhere else. Limits are compared in integer micros, and rounding never loosens
 *   a limit.
 * - Dates are ISO `YYYY-MM-DD`, ranges are inclusive, timestamps are ISO 8601 UTC.
 * - Ratios (CTR, conversion rate, lost impression share) are fractions in 0..1, never percents.
 * - Numbers shown to a human or an agent are computed by code from snapshot rows. A model never
 *   supplies a metric.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

// ---------------------------------------------------------------------------------------------
// Sources and data
// ---------------------------------------------------------------------------------------------

export const PLATFORMS = ['google_ads', 'meta_ads', 'ga4', 'search_console', 'mautic'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Where a snapshot's rows came from. Only `api` snapshots can back a live mutation. */
export type SourceKind = 'api' | 'csv' | 'demo';

export const DATASETS = [
  // google_ads + meta_ads (Meta ad sets are normalised to `ad_groups`)
  'campaigns',
  'ad_groups',
  'ads',
  'daily',
  // google_ads
  'keywords',
  'search_terms',
  'devices',
  'conversion_actions',
  // meta_ads
  'placements',
  // ga4
  'channels',
  'landing_pages',
  // search_console
  'queries',
  'pages',
  // mautic
  'segments',
  'emails',
  'lifecycle_campaigns',
] as const;
export type DatasetName = (typeof DATASETS)[number];

export interface DateRange {
  start: string;
  end: string;
}

/**
 * Additive metrics. Shared keys: impressions, clicks, cost, conversions, conversionValue.
 * Platform keys: linkClicks, landingPageViews (meta_ads); sessions, engagedSessions, keyEvents,
 * revenue (ga4); sent, read, clicked, unsubscribed, bounced (mautic emails); contacts (mautic).
 */
export interface Metrics {
  impressions?: number;
  clicks?: number;
  cost?: number;
  conversions?: number;
  conversionValue?: number;
  [extra: string]: number | undefined;
}

export type AttrValue = string | number | boolean | null;

/**
 * One row of a dataset. `attrs` holds non-additive facts. Keys used by checks and actions:
 * status ('ENABLED' | 'PAUSED' | 'REMOVED'), dailyBudget, biddingStrategy, channelType,
 * lostIsBudget, lostIsRank, matchType, qualityScore, bid, device, placement, frequency, reach,
 * learningStatus, approvalStatus, headline, description, finalUrl, searchTermStatus,
 * campaignName (search_terms), sharedBudget, budgetId (campaigns: budgets shared by several
 * campaigns carry the same budgetId), budgetType ('daily' | 'lifetime', meta_ads), ctr, position
 * (search_console), category, countingType, primary (conversion_actions), published (mautic),
 * scope ('lifetime' on Mautic emails, whose counters are not limited to the date range).
 * A search term's text is the row's `name`.
 */
export interface Row {
  /** Unique within its dataset: an entity id, or a composite such as `${campaignId}:${device}`. */
  id: string;
  name?: string;
  campaignId?: string;
  adGroupId?: string;
  /** Set on daily datasets. */
  date?: string;
  metrics: Metrics;
  attrs: Record<string, AttrValue>;
}

export type CoverageStatus = 'complete' | 'partial' | 'missing';

export interface DatasetCoverage {
  status: CoverageStatus;
  rows: number;
  note?: string;
}

/** An immutable, normalised copy of one account's data for one date range. */
export interface Snapshot {
  /** `snap_` + 16 hex chars derived from `contentHash`, platform, account and range. */
  id: string;
  schemaVersion: 1;
  platform: Platform;
  /** `AccountConfig.id`. */
  accountId: string;
  /** The platform's own account identifier. */
  externalAccountId: string;
  source: SourceKind;
  /** ISO 4217, or 'XXX' when unknown. */
  currency: string;
  /** IANA zone the platform reports in. */
  timezone: string;
  dateRange: DateRange;
  createdAt: string;
  datasets: Partial<Record<DatasetName, Row[]>>;
  coverage: Partial<Record<DatasetName, DatasetCoverage>>;
  warnings: string[];
  /**
   * What `conversions` counts, when the platform leaves a choice (the Meta action type, for example
   * 'purchase' or 'lead'). Two snapshots are comparable on conversions only when this is equal.
   */
  conversionDefinition?: string;
  /** sha256 of the canonical JSON of `datasets`. */
  contentHash: string;
}

export interface SnapshotRequest {
  account: AccountConfig;
  dateRange: DateRange;
  /** Defaults to every dataset the connector supports. */
  datasets?: DatasetName[];
}

export type EntityLevel =
  | 'account'
  | 'campaign'
  | 'ad_group'
  | 'ad'
  | 'keyword'
  | 'search_term'
  | 'device'
  | 'placement'
  | 'conversion_action'
  /** A Mautic contact segment. */
  | 'segment'
  | 'email'
  | 'contact'
  | 'page'
  | 'query';

export interface EntityRef {
  level: EntityLevel;
  id: string;
  name?: string;
  campaignId?: string;
  adGroupId?: string;
}

// ---------------------------------------------------------------------------------------------
// Configuration and policy (human-owned; no MCP tool can write it)
// ---------------------------------------------------------------------------------------------

/**
 * observe   — read and audit only; plans cannot be created.
 * propose   — plans can be created and previewed, never applied live.
 * approve   — a plan is applied live only with a human approval bound to its digest.
 * autopilot — as `approve`, plus action kinds listed in `policy.autoApply` are applied without a
 *             human when every gate passes. Requires Jev; falls back to `approve` without it.
 */
export const AUTONOMY_LEVELS = ['observe', 'propose', 'approve', 'autopilot'] as const;
export type Autonomy = (typeof AUTONOMY_LEVELS)[number];

export interface AccountTargets {
  /** Target cost per conversion, account currency. */
  cpa?: number;
  /** Target return on ad spend, e.g. 3 means 3:1. */
  roas?: number;
}

export interface AccountConfig {
  /** Local handle used in every tool call, e.g. 'acme-google'. */
  id: string;
  platform: Platform;
  /** Google customer id, Meta `act_…` id, GA4 property id, Search Console site URL, Mautic base URL. */
  externalId: string;
  label?: string;
  /** 'demo' reads the built-in dataset; 'api' needs credentials. Default 'api'. */
  source?: Exclude<SourceKind, 'csv'>;
  /** Google Ads manager account id, when access goes through one. */
  loginCustomerId?: string;
  currency?: string;
  timezone?: string;
  /** Prefix for this account's credential variables, e.g. 'ACME_' → ACME_GOOGLE_ADS_REFRESH_TOKEN. */
  envPrefix?: string;
  targets?: AccountTargets;
  /** Brand names; used to separate brand from non-brand search terms. */
  brandTerms?: string[];
  /** What the business sells, in a sentence. Context for term and copy judgments. */
  business?: string;
  /** Entity ids or name globs (`*brand*`) that no plan may touch. */
  protected?: string[];
}

export interface Policy {
  /** Largest number of actions in one plan. */
  maxActionsPerPlan: number;
  /** Largest relative change to one budget within `cooldownHours`, as a fraction (0.2 = 20%). */
  maxBudgetChangePct: number;
  /** Largest sum of daily budget increases across an account within 24h, as a fraction of its total daily budget. */
  maxAccountBudgetIncreasePct: number;
  /** Largest relative change to one bid within `cooldownHours`, as a fraction. */
  maxBidChangePct: number;
  /** An entity changed by an applied plan cannot be changed again for this many hours. */
  cooldownHours: number;
  /** A plan built on an older snapshot is refused. */
  maxSnapshotAgeHours: number;
  /** Minutes an approval receipt stays valid. */
  approvalTtlMinutes: number;
  /** Action kinds `autopilot` may apply without a human. Empty by default. */
  autoApply: ActionKind[];
  /** Kinds that are refused outright. */
  denyKinds: ActionKind[];
  /** Refuse every live mutation while true. Also set by env AUTOPILOT_KILL=1 (or `true`) or a KILL file in the home dir. */
  killSwitch: boolean;
}

export interface JudgmentConfig {
  /** TypeSafe model name. Pin a versioned id once thresholds are tuned. */
  model: string;
  /** Hard cap on Jev spend per process run, USD. */
  budgetUsd: number;
  /** Confidence at or above which a classification stands without review. */
  actThreshold: number;
  /** Confidence the gate needs before `autopilot` applies an action. */
  gateThreshold: number;
  /** Price used to estimate cost from `usage.input_tokens`. */
  usdPerMillionInputTokens: number;
}

/** Tunable numbers behind the deterministic checks. Fractions are 0..1; money is account currency. */
export interface Thresholds {
  /** Cost with zero conversions counts as waste at this multiple of the target CPA. */
  wasteCpaMultiple: number;
  /** Waste floor used when the account has no target CPA. */
  wasteMinCost: number;
  /** CPA above this multiple of target is flagged. */
  highCpaMultiple: number;
  /** ROAS below this multiple of target is flagged. */
  lowRoasMultiple: number;
  /** Conversions needed before a CPA or ROAS comparison is trusted. */
  minConversions: number;
  /** Clicks needed before a conversion-rate comparison is trusted. */
  minClicks: number;
  /** Impressions needed before a CTR comparison is trusted. */
  minImpressions: number;
  lowSearchCtr: number;
  lowConversionRate: number;
  /** Search impression share lost to budget above this is flagged on efficient campaigns. */
  budgetLostIs: number;
  rankLostIs: number;
  lowQualityScore: number;
  /** A device or placement whose CPA exceeds its parent's by this multiple is flagged. */
  segmentCpaMultiple: number;
  /** Share of parent cost a device or placement needs before it is compared. */
  segmentMinCostShare: number;
  /** Week-over-week conversion fall that signals broken tracking while clicks hold. */
  conversionDropPct: number;
  fatigueFrequency: number;
  fatigueCtrDropPct: number;
  lowLinkCtr: number;
  /** Landing page views per link click below this is flagged. */
  landingViewRate: number;
  learningMinEvents: number;
  /** Platform-reported conversions may exceed GA4 key events by this fraction before tracking is flagged. */
  trackingGapPct: number;
  /** Email checks. */
  highUnsubscribeRate: number;
  highBounceRate: number;
  lowOpenRate: number;
  /** Most recent days left out of conversion-based comparisons, because conversions arrive late. */
  conversionLagDays: number;
  /** Search Console: average position range treated as striking distance. */
  strikingDistanceMin: number;
  strikingDistanceMax: number;
}

/** What the business is, kept outside any chat so every agent reads the same thing. */
export interface BusinessProfile {
  name: string;
  /** What is sold and to whom, in a few sentences. */
  description: string;
  audience?: string;
  /** Words and claims that must never appear in copy. */
  forbiddenPhrases?: string[];
}

export interface AutopilotConfig {
  version: 1;
  autonomy: Autonomy;
  business?: BusinessProfile;
  accounts: AccountConfig[];
  policy: Policy;
  judgment: JudgmentConfig;
  thresholds: Thresholds;
}

// ---------------------------------------------------------------------------------------------
// Typed judgments (Jev / TypeSafe System One)
// ---------------------------------------------------------------------------------------------

/** `jev` = answered by the TypeSafe API. `fallback` = deterministic rules, never shown as model confidence. */
export type JudgmentMode = 'jev' | 'fallback';

/** `act` = decisive enough to use. `review` = a signal for a human or a stronger model. */
export type Band = 'act' | 'review';

export interface NoulQuestion {
  type: 'noul';
  instructions: JsonValue;
  criteria?: { true?: JsonValue; false?: JsonValue };
}
export interface ChoiceQuestion {
  type: 'choice';
  instructions: JsonValue;
  /** Option id → description (null when the id says enough). At most 255 options. */
  criteria: Record<string, JsonValue>;
}
export interface ScoreQuestion {
  type: 'score';
  instructions: JsonValue;
  /** Ordered level descriptions, lowest first; 2 to 10 levels. */
  criteria: JsonValue[];
}
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: 'noul';
  /** Probability of yes, 0..1. */
  noul: number;
}
export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
export interface ScoreAnswer {
  type: 'score';
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JudgmentUsage {
  mode: JudgmentMode;
  /** Versioned model id reported by the API; null in fallback mode. */
  model: string | null;
  requests: number;
  failed: number;
  /** Requests skipped because the budget would have been exceeded. */
  skipped: number;
  inputTokens: number;
  outputTokens: number;
  /** Estimated from input tokens and the configured price. */
  costUsd: number;
}

export type TermLabel = 'relevant' | 'irrelevant' | 'competitor' | 'brand' | 'unclear';

export interface TermJudgment {
  term: string;
  label: TermLabel;
  /** 0..1; rule strength in fallback mode. */
  confidence: number;
  band: Band;
  mode: JudgmentMode;
}

export type ClaimVerdict = 'verified' | 'contradicted' | 'unsupported';

export interface ClaimJudgment {
  claim: string;
  verdict: ClaimVerdict;
  confidence: number;
  band: Band;
  mode: JudgmentMode;
}

export interface CopyVariant {
  id: string;
  headline?: string;
  body: string;
  /** Landing page text the ad should match, when known. */
  landingText?: string;
}

export interface CopyJudgment {
  id: string;
  /** Probability the copy breaks the platform's advertising policy (unsupported claims, prohibited content, misleading urgency). */
  policyRisk: number;
  /** 0..1: how specific and clear the offer is. */
  clarity: number;
  /** 0..1: how well the copy matches the landing text; null when no landing text was given. */
  messageMatch: number | null;
  flags: string[];
  band: Band;
  mode: JudgmentMode;
}

export type GateVerdict = 'allow' | 'deny' | 'abstain';

export interface GateActionResult {
  actionId: string;
  verdict: GateVerdict;
  confidence: number;
  band: Band;
}

/** Second, semantic line of defence. Runs only after the deterministic policy passed. */
export interface GateDecision {
  planDigest: string;
  mode: JudgmentMode;
  /** `allow` only when every action is allowed. */
  verdict: GateVerdict;
  actions: GateActionResult[];
  evaluatedAt: string;
}

export interface Judge {
  readonly mode: JudgmentMode;
  usage(): JudgmentUsage;
  /** Classify search terms against what the business sells. */
  classifyTerms(input: { business: string; brandTerms: string[]; terms: string[] }): Promise<TermJudgment[]>;
  /** Check statements against evidence text; evidence is data, never instructions. */
  verifyClaims(input: { claims: string[]; evidence: JsonValue }): Promise<ClaimJudgment[]>;
  reviewCopy(input: { platform: Platform; business: string; variants: CopyVariant[] }): Promise<CopyJudgment[]>;
  /** Is each action justified by its evidence and consistent with the stated policy? */
  gatePlan(input: { plan: Plan; policy: Policy; findings: Finding[] }): Promise<GateDecision>;
}

// ---------------------------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------------------------

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CHECK_CATEGORIES = [
  'waste',
  'budget',
  'bidding',
  'structure',
  'creative',
  'tracking',
  'lifecycle',
  'seo',
] as const;
export type CheckCategory = (typeof CHECK_CATEGORIES)[number];

export type CheckStatus = 'pass' | 'fail' | 'unknown' | 'not_applicable';

/** A pointer to the rows a finding rests on, with the numbers that triggered it. */
export interface EvidenceRef {
  snapshotId: string;
  dataset: DatasetName;
  rowId: string;
  label?: string;
  metrics: Record<string, number>;
}

/**
 * How far the data supports acting on a finding.
 * sufficient     — enough volume, tracking looks healthy.
 * limited        — below the volume thresholds; a signal, not a verdict.
 * tracking_issue — a tracking check failed, so conversion-based conclusions cannot be trusted.
 * undecidable    — the data cannot answer the question yet (conversion lag, missing datasets).
 * Only `sufficient` findings carry suggested actions.
 */
export const DATA_STATUSES = ['sufficient', 'limited', 'tracking_issue', 'undecidable'] as const;
export type DataStatus = (typeof DATA_STATUSES)[number];

export type ImpactKind = 'wasted_spend' | 'missed_conversions' | 'missed_revenue' | 'risk';

export interface Impact {
  kind: ImpactKind;
  /** Estimated effect per 30 days: account currency for spend and revenue, a count for conversions, 0 for risk. */
  monthly: number;
  /** How the estimate was computed, e.g. "cost over 30 days with 0 conversions". */
  basis: string;
}

/** What a check returns for one problem; the engine adds identity and account fields. */
export interface FindingDraft {
  entity?: EntityRef;
  /** Overrides the check's default severity. */
  severity?: Severity;
  title: string;
  /** The numbers, in a sentence. */
  observation: string;
  recommendation: string;
  evidence: EvidenceRef[];
  impact?: Impact;
  suggestedActions?: ActionDraft[];
  /** True when a judgment landed in the review band or coverage was partial. */
  needsReview?: boolean;
  /** Default 'sufficient'. */
  dataStatus?: DataStatus;
}

export interface Finding extends FindingDraft {
  /** `fnd_` + 16 hex chars from checkId, snapshotId and entity. */
  id: string;
  checkId: string;
  category: CheckCategory;
  severity: Severity;
  platform: Platform;
  accountId: string;
  snapshotId: string;
  suggestedActions: ActionDraft[];
  needsReview: boolean;
  dataStatus: DataStatus;
}

export interface CheckOutcome {
  status: CheckStatus;
  /** Why the check is unknown or not applicable. */
  reason?: string;
  findings: FindingDraft[];
}

export interface CheckContext {
  snapshot: Snapshot;
  account: AccountConfig;
  thresholds: Thresholds;
  /** Null when the caller disabled judgments. */
  judge: Judge | null;
}

export type CheckNeed = 'target_cpa' | 'target_roas' | 'brand_terms' | 'judgment';

export interface CheckDefinition {
  /** `<platform prefix>.<category>.<name>`, e.g. `gads.waste.search_terms`. */
  id: string;
  platform: Platform;
  category: CheckCategory;
  severity: Severity;
  title: string;
  /** Datasets that must be present for the check to be evaluable. */
  requires: DatasetName[];
  needs?: CheckNeed[];
  /** True when the conclusion rests on conversion counts; such findings are demoted while tracking looks broken. */
  usesConversions?: boolean;
  run(ctx: CheckContext): CheckOutcome | Promise<CheckOutcome>;
}

export interface CheckResult {
  checkId: string;
  category: CheckCategory;
  severity: Severity;
  title: string;
  status: CheckStatus;
  reason?: string;
  findingIds: string[];
}

export type ScoreStatus = 'complete' | 'provisional' | 'insufficient_evidence';

export interface AuditScore {
  /** 0..100; null when evidence is insufficient. */
  value: number | null;
  grade: 'A' | 'B' | 'C' | 'D' | 'F' | null;
  /** Share of weighted checks that could be evaluated, 0..1. */
  coverage: number;
  status: ScoreStatus;
  byCategory: Partial<Record<CheckCategory, { value: number | null; evaluated: number; total: number }>>;
}

export interface AuditReport {
  /** `aud_` + 16 hex chars. */
  id: string;
  accountId: string;
  platform: Platform;
  snapshotId: string;
  dateRange: DateRange;
  currency: string;
  createdAt: string;
  score: AuditScore;
  checks: CheckResult[];
  /** Failing findings, largest monthly impact first. */
  findings: Finding[];
  /**
   * `wastedSpendMonthly` is a floor: per campaign only the check with the largest waste counts,
   * because keywords, search terms and devices are different cuts of the same spend.
   */
  totals: { wastedSpendMonthly: number; findings: number; needsReview: number };
  judgment: JudgmentUsage;
}

// ---------------------------------------------------------------------------------------------
// Plans, policy, approval, execution
// ---------------------------------------------------------------------------------------------

/** The complete allowlist. There is no delete, no send and no raw passthrough. */
export const ACTION_KINDS = [
  'google_ads.campaign.pause',
  'google_ads.campaign.enable',
  'google_ads.campaign.set_daily_budget',
  'google_ads.ad_group.pause',
  'google_ads.ad_group.enable',
  'google_ads.ad.pause',
  'google_ads.ad.enable',
  'google_ads.keyword.pause',
  'google_ads.keyword.enable',
  'google_ads.keyword.set_bid',
  'google_ads.negative_keyword.add',
  'google_ads.negative_keyword.remove',
  'meta_ads.campaign.pause',
  'meta_ads.campaign.enable',
  'meta_ads.campaign.set_daily_budget',
  'meta_ads.adset.pause',
  'meta_ads.adset.enable',
  'meta_ads.adset.set_daily_budget',
  'meta_ads.ad.pause',
  'meta_ads.ad.enable',
  'mautic.segment.add_contact',
  'mautic.segment.remove_contact',
  'mautic.email.create_draft',
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export type SpendEffect = 'none' | 'decrease' | 'increase' | 'unknown';

/** exact = restoring `before` undoes it; compensating = a different call undoes it; none = cannot be undone. */
export type Reversibility = 'exact' | 'compensating' | 'none';

/**
 * What an agent or a check proposes. `params` per kind:
 * - *.set_daily_budget   { dailyBudget: number }            (account currency, major units)
 * - keyword.set_bid      { bid: number }
 * - negative_keyword.add / .remove { text: string, matchType: 'EXACT' | 'PHRASE' | 'BROAD' }  (target = campaign)
 * - segment.*_contact    { contactId: string }              (target = segment)
 * - email.create_draft   { name: string, subject: string, html: string }  (target = account)
 * - pause / enable       {}
 */
export interface ActionDraft {
  kind: ActionKind;
  target: EntityRef;
  params: JsonObject;
  rationale: string;
  findingIds?: string[];
}

export interface ActionResult {
  ok: boolean;
  dryRun: boolean;
  /** True when the demo connector applied the action to its in-memory dataset; nothing left the machine. */
  simulated?: boolean;
  /** State read back after a live apply; null on dry run or failure. */
  after: JsonObject | null;
  /** Platform resource name or id created or changed. */
  resource?: string;
  platformRequestId?: string;
  error?: { code: string; message: string; retryable: boolean };
}

/** `unknown` = an intent was recorded but the outcome could not be confirmed; it must be reconciled before the entity is touched again. */
export type ActionStatus = 'pending' | 'applied' | 'failed' | 'skipped' | 'unknown' | 'reverted';

export interface Action extends ActionDraft {
  /** `act_` + 16 hex chars from kind, target and params. */
  id: string;
  platform: Platform;
  /** Current values of the fields this action changes; null when they could not be read. */
  before: JsonObject | null;
  /** Intended values of those fields. */
  after: JsonObject;
  /** sha256 of canonical `before`; live apply aborts the action when a fresh read differs. */
  preconditionHash: string | null;
  spendEffect: SpendEffect;
  /**
   * Change to the daily spend ceiling (the budgets), account currency; null when unknown. 0 for a
   * change that moves spend inside an unchanged budget: a bid, a keyword, an ad, a negative keyword.
   * `spendEffect` still says which way actual spend is expected to move.
   */
  spendDeltaPerDay: number | null;
  reversible: Reversibility;
  status: ActionStatus;
  result?: ActionResult;
}

export type PlanStatus =
  | 'proposed'
  | 'approved'
  | 'applying'
  | 'applied'
  | 'partial'
  | 'failed'
  | 'rejected'
  | 'reverted';

export interface Plan {
  /** `plan_` + 16 hex chars. A handle, not a capability: every call re-checks policy and approval. */
  id: string;
  schemaVersion: 1;
  createdAt: string;
  createdBy: 'agent' | 'cli' | 'autopilot';
  accountId: string;
  platform: Platform;
  /** Snapshot the plan was built on; null for hand-written plans. */
  snapshotId: string | null;
  /** Audit whose findings the actions cite, when there is one. */
  auditId?: string;
  title: string;
  rationale: string;
  actions: Action[];
  /** sha256 over account, platform and each action's kind, target, params, before and after. Approval binds to it. */
  digest: string;
  status: PlanStatus;
  /** Set on a compensating plan. */
  revertsPlanId?: string;
}

export type PolicyOutcome = 'pass' | 'deny';

export interface PolicyRuleResult {
  /** e.g. 'kill_switch', 'autonomy', 'kind_denied', 'protected_entity', 'max_actions', 'budget_change', 'account_budget_increase', 'bid_change', 'cooldown', 'snapshot_age', 'source_not_live', 'missing_before'. */
  ruleId: string;
  outcome: PolicyOutcome;
  message: string;
  actionId?: string;
  observed?: JsonValue;
  limit?: JsonValue;
}

export interface PolicyDecision {
  planDigest: string;
  /** sha256 of the canonical policy that was applied. */
  policyDigest: string;
  evaluatedAt: string;
  /** False when any rule denies. A denied plan cannot be applied, approved or not. */
  allowed: boolean;
  /** True when every action kind is in `policy.autoApply`, none increases spend and autonomy is `autopilot`. */
  autoApplicable: boolean;
  results: PolicyRuleResult[];
}

/** tty = `approve` in a terminal; local_ui = the local review page; elicitation = the MCP client's prompt; policy = auto-apply. */
export type ApprovalMethod = 'tty' | 'local_ui' | 'elicitation' | 'policy';

export interface ApprovalReceipt {
  /** `apr_` + 16 hex chars. */
  id: string;
  planId: string;
  planDigest: string;
  policyDigest: string;
  method: ApprovalMethod;
  /** sha256 of the exact review text the approver was shown (`PlanPreview.review`). */
  reviewDigest: string;
  /**
   * The channel, which is not proof of a human: OS user name for `tty` and `local_ui`, client
   * name for `elicitation`, 'policy' for auto-apply (delegated authority under the policy).
   */
  approver: string;
  createdAt: string;
  expiresAt: string;
  /** HMAC-SHA256 over the other fields with the key in the home dir. Detects accidental edits only. */
  signature: string;
}

export const LEDGER_EVENTS = [
  'snapshot.created',
  'audit.run',
  'plan.created',
  'plan.previewed',
  'plan.approved',
  'plan.rejected',
  /** A receipt was claimed for one live execution. Written before any platform call. */
  'execution.claimed',
  /** Written durably before the platform call it describes. */
  'action.intent',
  'action.applied',
  'action.failed',
  'action.skipped',
  /** The call was sent but its outcome is not known (timeout, crash). */
  'action.unknown',
  /** A fresh read settled an `action.unknown` or an intent without a result. */
  'action.reconciled',
  'execution.closed',
  'judgment.usage',
] as const;
export type LedgerEvent = (typeof LEDGER_EVENTS)[number];

export interface LedgerEntry {
  seq: number;
  ts: string;
  /** Hash of the previous entry; 64 zeros for the first. */
  prevHash: string;
  /** sha256 over canonical JSON of this entry without `hash`. */
  hash: string;
  event: LedgerEvent;
  actor: { kind: 'human' | 'agent' | 'system'; id: string };
  accountId?: string;
  planId?: string;
  /** `exec_` + 16 hex chars; one per live `applyPlan` call. Dry runs have none. */
  executionId?: string;
  actionId?: string;
  idempotencyKey?: string;
  data?: JsonObject;
}

export interface PlanPreview {
  plan: Plan;
  policy: PolicyDecision;
  /** Null when the policy denied the plan (the gate is not asked) or judgments were disabled. */
  gate: GateDecision | null;
  /** What the human must do next, if anything. */
  approval: { required: boolean; satisfiedBy: ApprovalMethod | null; hint: string };
  totals: { actions: number; spendDeltaPerDay: number; increases: number; irreversible: number };
  /** The exact text a human approves: account, currency, every before and after value, totals, gates. */
  review: string;
  /** sha256 of `review`; an approval receipt binds to it. */
  reviewDigest: string;
}

export interface ApplyOutcome {
  plan: Plan;
  dryRun: boolean;
  /** Null on a dry run. */
  executionId: string | null;
  applied: number;
  failed: number;
  skipped: number;
  /** Actions whose outcome could not be confirmed. */
  unknown: number;
  results: Array<{ actionId: string; status: ActionStatus; result: ActionResult | null; note?: string }>;
  ledgerSeqs: number[];
}

// ---------------------------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------------------------

export interface ConnectorStatus {
  platform: Platform;
  accountId: string;
  source: SourceKind;
  /** True when every credential needed for reads is present. */
  ready: boolean;
  /** Names (never values) of missing environment variables. */
  missingEnv: string[];
  datasets: DatasetName[];
  /** Action kinds this connector can apply live. */
  actions: ActionKind[];
  note?: string;
}

export interface Connector {
  readonly platform: Platform;
  readonly source: SourceKind;
  status(): ConnectorStatus;
  fetchSnapshot(request: SnapshotRequest): Promise<Snapshot>;
  /** Current values of exactly the fields `draft` would change, in the same shape as `Action.before`. */
  readState(draft: ActionDraft): Promise<JsonObject>;
  /** Performs one action. `validateOnly` asks the platform to validate without changing anything, where it can. */
  apply(action: Action, options: { validateOnly: boolean; idempotencyKey: string }): Promise<ActionResult>;
}

// ---------------------------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------------------------

export interface KpiSet {
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
  conversionValue: number;
  /** Derived; null when the denominator is zero. */
  ctr: number | null;
  cpc: number | null;
  cpa: number | null;
  roas: number | null;
  conversionRate: number | null;
}

export interface KpiDelta {
  metric: keyof KpiSet;
  current: number | null;
  previous: number | null;
  /** Relative change as a fraction; null when it cannot be computed. */
  change: number | null;
}

export interface KpiReport {
  accountId: string;
  platform: Platform;
  currency: string;
  current: { snapshotId: string; dateRange: DateRange; kpis: KpiSet };
  previous: { snapshotId: string; dateRange: DateRange; kpis: KpiSet } | null;
  deltas: KpiDelta[];
  /** Largest movers by cost among campaigns. */
  topCampaigns: Array<{ id: string; name: string; kpis: KpiSet; previous: KpiSet | null }>;
  /** Plain statements a writer may use; each one is recomputable from the snapshots. */
  facts: string[];
}

// ---------------------------------------------------------------------------------------------
// Services (implemented under src/core, src/connectors, src/judgment and src/plan)
// ---------------------------------------------------------------------------------------------

/** Process environment overlaid on the home dir's `.env`. Values are secrets: never log them. */
export type Env = Record<string, string | undefined>;

export interface Paths {
  /** AUTOPILOT_HOME, default `~/.autopilot-marketing`. */
  home: string;
  config: string;
  envFile: string;
  /** SQLite database holding snapshots, audits, plans, receipts, the ledger and locks. */
  db: string;
  /** Free-form notes about the business (`brief.md`), written by the human, read by every agent as data. */
  brief: string;
  /** HMAC key for approval receipts, mode 0600. */
  approvalKey: string;
  /** Its existence turns the kill switch on. */
  killFile: string;
}

export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON body. */
  json?: JsonValue;
  /** `application/x-www-form-urlencoded` body. */
  form?: Record<string, string>;
  timeoutMs?: number;
  /** Retry on 429, 5xx and network errors. Default: true for GET, false otherwise. */
  retry?: boolean;
}

export interface HttpResponse<T = JsonValue> {
  status: number;
  headers: Record<string, string>;
  body: T;
}

/** Throws `AutopilotError` (`rate_limited` or `platform_error`, secrets redacted) on a non-2xx response. */
export interface HttpClient {
  request<T = JsonValue>(request: HttpRequest): Promise<HttpResponse<T>>;
}

export interface ConnectorDeps {
  account: AccountConfig;
  env: Env;
  http: HttpClient;
  now: () => Date;
}

export interface SnapshotSummary {
  id: string;
  accountId: string;
  platform: Platform;
  source: SourceKind;
  dateRange: DateRange;
  createdAt: string;
}

export interface Store {
  saveSnapshot(snapshot: Snapshot): void;
  /** Throws `not_found`. */
  getSnapshot(id: string): Snapshot;
  listSnapshots(filter?: { accountId?: string }): SnapshotSummary[];
  saveAudit(report: AuditReport): void;
  getAudit(id: string): AuditReport;
  savePlan(plan: Plan): void;
  getPlan(id: string): Plan;
  listPlans(filter?: { accountId?: string; status?: PlanStatus }): Plan[];
  saveReceipt(receipt: ApprovalReceipt): void;
  findReceipts(planId: string): ApprovalReceipt[];
  /** Atomic. True when this call claimed the receipt; false when it was claimed before. */
  claimReceipt(receiptId: string, executionId: string, at: string): boolean;
  /** The execution that claimed a receipt, or null while it is unclaimed. */
  receiptClaim(receiptId: string): { executionId: string; at: string } | null;
  /**
   * One live execution per account at a time, across processes. True when the lock was taken
   * (or an expired one replaced); false while another execution holds it.
   */
  acquireLock(accountId: string, executionId: string, now: Date, ttlSeconds: number): boolean;
  releaseLock(accountId: string, executionId: string): void;
}

export type LedgerInput = Omit<LedgerEntry, 'seq' | 'ts' | 'prevHash' | 'hash'> & { ts?: string };

export interface LedgerFilter {
  accountId?: string;
  planId?: string;
  events?: LedgerEvent[];
  /** ISO timestamp, inclusive. */
  since?: string;
  /** Newest entries first when set. */
  limit?: number;
}

export interface Ledger {
  append(entry: LedgerInput): LedgerEntry;
  read(filter?: LedgerFilter): LedgerEntry[];
  /** Recomputes the hash chain. `brokenAt` is the seq of the first bad entry. */
  verify(): { ok: boolean; entries: number; brokenAt: number | null };
}

export interface ApprovalService {
  issue(input: {
    plan: Plan;
    policyDigest: string;
    reviewDigest: string;
    method: ApprovalMethod;
    approver: string;
    now: Date;
  }): ApprovalReceipt;
  /**
   * Returns a valid, unclaimed, unexpired receipt for this exact plan digest and policy digest.
   * Throws `approval_required` when there is none, `approval_invalid` when one exists but fails a check.
   */
  verify(input: { plan: Plan; policyDigest: string; receiptId?: string; now: Date }): ApprovalReceipt;
  /**
   * Atomically claims the receipt for one execution (one conditional UPDATE in the state database).
   * Throws `approval_invalid` when it was claimed before: a receipt authorises one execution, not
   * one action.
   */
  claim(receipt: ApprovalReceipt, executionId: string, now: Date): void;
}

export interface TypeSafeClient {
  /** False when no API key is configured. */
  readonly available: boolean;
  /** One request to `POST /v1/systemone`. Never throws: null on any failure, counted in `usage().failed`. */
  ask(state: JsonValue, questions: Record<string, Question>): Promise<Record<string, Answer> | null>;
  usage(): JudgmentUsage;
}

/** Everything a tool or command needs, built once per process. */
export interface Runtime {
  config: AutopilotConfig;
  env: Env;
  paths: Paths;
  store: Store;
  ledger: Ledger;
  approvals: ApprovalService;
  judge: Judge;
  /** `config.autonomy`, lowered to `approve` when Jev is unavailable. */
  autonomy: Autonomy;
  now: () => Date;
  /** Throws `not_found` listing the configured ids. */
  account(accountId: string): AccountConfig;
  connector(account: AccountConfig): Connector;
  killSwitch(): boolean;
}
