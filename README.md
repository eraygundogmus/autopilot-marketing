# autopilot-marketing

autopilot-marketing is an open-source ad operations engine for your own AI agent (Claude Code, Codex, or any MCP client). It gives the agent tools to read ad accounts, find problems with the evidence behind them, prepare typed changes, and apply only what a person approved. State and history stay on your machine. It is not a chatbot and not a hosted service, and there is no account to create with us.

## What it does

- **Evidence-backed audits.** Deterministic checks produce findings, and every finding carries the rows behind it and a data-sufficiency status (`sufficient`, `limited`, `tracking_issue` or `undecidable`).
- **Search-term review.** Search terms are classified with typed judgments from Jev (see [Jev](#jev)), each with a confidence and a band that says whether it can be used or needs review.
- **KPI reports.** Period-over-period numbers with facts that can be recomputed from the stored data.
- **Reviewable change plans.** A plan is a stored list of typed actions with the current state of each target recorded. Creating a plan changes nothing.
- **Guarded execution.** Policy limits, an approval bound to the plan digest, a fresh-state check before each change, an append-only ledger, and compensating reverts.
- **A keyless demo and CSV import.** Demo accounts work without credentials, and CSV exports can be imported instead of calling an API.

## Try it in two minutes

No credentials are needed. The only requirement is Node.js 22.13 or newer.

```sh
npx -y github:eraygundogmus/autopilot-marketing init
npx -y github:eraygundogmus/autopilot-marketing doctor
npx -y github:eraygundogmus/autopilot-marketing audit demo-google
```

`init` creates the local configuration, `doctor` reports what is ready, and `audit demo-google` runs an audit on the built-in demo Google Ads account. The other demo accounts are `demo-meta`, `demo-ga4`, `demo-search-console` and `demo-mautic`.

Then connect an agent. In Claude Code, install the plugin:

```
/plugin marketplace add eraygundogmus/autopilot-marketing
/plugin install autopilot-marketing@autopilot-marketing
```

Or register the MCP server, which is called `autopilot`, with any client:

```sh
claude mcp add --transport stdio autopilot -- npx -y github:eraygundogmus/autopilot-marketing mcp
codex mcp add autopilot -- npx -y github:eraygundogmus/autopilot-marketing mcp
```

An example prompt:

> Audit demo-google for the last 30 days. Show me the three findings with the largest monthly impact and the rows behind each one, then prepare a plan for the ones whose data status is sufficient and show me the preview. Do not apply anything.

## How a change happens

1. **Snapshot.** The account's data is copied into an immutable, normalised snapshot.
2. **Audit.** Deterministic checks run on the snapshot and produce findings with evidence.
3. **Plan.** The agent, or a check's suggested actions, become a stored plan of typed actions. The current state of every target is recorded.
4. **Policy.** The plan is checked against the owner's limits. A denied plan cannot be applied, approved or not.
5. **Jev gate.** After the policy passes, Jev judges whether each action is justified by its evidence.
6. **Approval by a person.** The person reads the exact review text and approves it outside the conversation.
7. **Fresh-state check.** Before each change, the target is read again. If it differs from what the plan recorded, that action is not applied.
8. **Apply.** The action is sent to the platform.
9. **Read back.** The new state is read from the platform.
10. **Ledger.** Every step is written to an append-only log.

How far this pipeline may go is set by the autonomy level. The owner sets it in the config file; no tool lets an agent change it.

| Level | What is allowed |
| --- | --- |
| `observe` | Read and audit only. Plans cannot be created. |
| `propose` (default) | Plans can be created, previewed and dry-run, never applied live. |
| `approve` | A plan is applied live only with a person's approval bound to its digest. |
| `autopilot` | As `approve`, plus action kinds the owner listed in `policy.autoApply` are applied automatically when the policy and the Jev gate both pass. It requires Jev and falls back to `approve` without it. |

Approval is given by the person with `autopilot-marketing approve <planId>` or `autopilot-marketing review <planId>` in their own terminal, or through the MCP client's own confirmation prompt.

## Tools

The MCP server exposes 14 tools. Clients add their own prefix to these names.

| Tool | What it does |
| --- | --- |
| `sources_list` | Lists configured accounts, their readiness, the autonomy level, the judgment mode, policy limits and the owner's business brief. Call it first. |
| `snapshot_create` | Stores an immutable, normalised copy of one account's data and returns its `snapshotId`, coverage per dataset and totals. Accepts CSV files instead of calling an API. |
| `data_query` | Filters, sorts and pages rows of one dataset in a snapshot. Ratios (`ctr`, `cpc`, `cpa`, `roas`, `conversionRate`) are computed by the tool. |
| `audit_run` | Runs the deterministic checks and returns a score from 0 to 100 with its coverage, and findings with observation, recommendation, evidence, monthly impact, data status and suggested actions. |
| `evidence_get` | Returns the rows behind one finding. |
| `report_build` | Builds period-over-period KPIs with quotable facts, for `google_ads` and `meta_ads` accounts. |
| `judge_terms` | Classifies search terms as `relevant`, `irrelevant`, `competitor`, `brand` or `unclear`, and drafts negative keywords for confidently irrelevant or competitor terms. |
| `judge_copy` | Rates ad copy variants for policy risk, clarity and match with the landing text, with flags. |
| `judge_claims` | Marks each statement as `verified`, `contradicted` or `unsupported` against the data. |
| `plan_create` | Stores a plan of typed actions with each target's current state. Changes nothing. |
| `plan_preview` | Returns the exact review text: before and after per action, spend effect, policy result, Jev gate result and what approval is needed. |
| `plan_apply` | A dry run by default. A live run executes only a stored, policy-passing plan with an approval given by a person outside the conversation, or inside the owner's auto-apply policy. |
| `plan_revert` | Creates a new compensating plan for an applied plan. It needs its own preview and approval. |
| `ledger_list` | Reads the append-only change log and reports its integrity. |

The command line program `autopilot-marketing` has these commands: `init`, `doctor`, `snapshot`, `audit`, `report`, `plan`, `preview`, `approve`, `review`, `apply`, `revert`, `run`, `ledger`, `kill` and `mcp`. `kill` turns on the kill switch, which refuses every live change, and `mcp` starts the MCP server.

## Connecting real accounts

Configuration lives in `~/.autopilot-marketing/`. Set the `AUTOPILOT_HOME` environment variable to use another directory.

- `config.json` holds accounts, the autonomy level and policy limits.
- `.env` holds credentials.
- `brief.md` holds free-form notes about the business, written by you and read by every agent as data.

A minimal `config.json` with one Google Ads account:

```json
{
  "version": 1,
  "autonomy": "propose",
  "accounts": [
    {
      "id": "acme-google",
      "platform": "google_ads",
      "externalId": "123-456-7890",
      "targets": { "cpa": 40 },
      "brandTerms": ["acme"]
    }
  ]
}
```

`id` is the local handle used in every tool call. `externalId` is the platform's own identifier: the Google customer id, the Meta `act_` id, the GA4 property id, the Search Console site URL, or the Mautic base URL. `targets.cpa` is the target cost per conversion in the account currency, and `targets.roas` is the target return on ad spend. `brandTerms` separate brand from non-brand search terms.

Credentials are read from these variables:

| Platform | Variables |
| --- | --- |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REFRESH_TOKEN`, or `GOOGLE_APPLICATION_CREDENTIALS`. The Google Ads API version defaults to v25 and can be set with `GOOGLE_ADS_API_VERSION`. |
| Meta | `META_ACCESS_TOKEN`. The Graph API version defaults to v26.0 and can be set with `META_GRAPH_API_VERSION`. `META_CONVERSION_ACTION` selects the conversion action. |
| Mautic | `MAUTIC_CLIENT_ID` and `MAUTIC_CLIENT_SECRET`, or `MAUTIC_USERNAME` and `MAUTIC_PASSWORD`. The instance URL is the account's `externalId`. |
| Jev | `TYPESAFE_API_KEY`. Optional. |

Google retired developer tokens on 2026-09-09. Access to the Google Ads API now follows the Google Cloud project that owns the OAuth credentials.

If you do not want to connect an API, export CSV files from the platform and pass them to `snapshot_create` in `csvFiles`. A snapshot built from CSV can be audited and reported on without any credentials. Changes still need API access, because the current state of every target is read from the platform before a plan is stored and again before it is applied. Demo accounts simulate changes on this machine; nothing leaves it.

## Support matrix

| Platform | Data that can be read | Changes that can be made |
| --- | --- | --- |
| `google_ads` | campaigns, ad groups, ads, daily, keywords, search terms, devices, conversion actions | `google_ads.campaign.pause`, `.enable`, `.set_daily_budget`; `google_ads.ad_group.pause`, `.enable`; `google_ads.ad.pause`, `.enable`; `google_ads.keyword.pause`, `.enable`, `.set_bid`; `google_ads.negative_keyword.add`, `.remove` |
| `meta_ads` | campaigns, ad sets, ads, daily, placements | `meta_ads.campaign.pause`, `.enable`, `.set_daily_budget`; `meta_ads.adset.pause`, `.enable`, `.set_daily_budget`; `meta_ads.ad.pause`, `.enable` |
| `ga4` | channels, landing pages | None. Read only. |
| `search_console` | queries, pages | None. Read only. |
| `mautic` | segments, emails, lifecycle campaigns | `mautic.segment.add_contact`, `.remove_contact`; `mautic.email.create_draft` |

This is the complete list of action kinds. The following are not supported: deleting anything, sending email, shared budgets and lifetime budgets, Performance Max asset edits, creative upload, and raw API calls.

## Safety model

What the server enforces:

- **Allowlisted typed actions.** Only the action kinds in the table above exist.
- **Policy limits.** Budget and bid changes, plan size, cooldown and snapshot age are checked against the owner's limits. Money is compared in integer micros (millionths of a currency unit), and rounding never loosens a limit.
- **Bound approvals.** An approval receipt is bound to the plan digest, the policy digest and the exact review text. It can be used for one execution and it expires.
- **Fresh state.** The target's state is read again before each change, and the change is skipped if it differs from what the plan recorded.
- **No blind retry.** When the outcome of a change cannot be confirmed, it is recorded as `unknown`, and that entity is blocked until a fresh read settles it.
- **Hash-chained ledger.** Each ledger entry contains the hash of the one before it.
- **Kill switch.** While it is on, every live change is refused.

Known limits:

- An agent that runs as the same operating-system user and has a shell can read the credentials and edit local state. For that reason the terminal and browser approval channels are not proof that a human approved.
- The ledger chain detects accidental damage. It does not stop a determined local attacker.
- Another person can change the account between the last read and the write.
- Local limits are not a billing cap. Set budget caps in the ad platform itself.
- Use credentials with the least privilege that the work needs.
- The data an agent reads through these tools goes to whatever model that agent uses.

## Jev

Jev is TypeSafe's System One model. It answers typed questions (yes or no, a choice, a score) instead of free text. autopilot-marketing uses it for four things: classifying search terms, verifying claims against data, screening ad copy, and the gate before an automatic apply.

All requests go to a single endpoint, `POST /v1/systemone`. The estimated cost of the requests is reported with the results and recorded in the ledger.

Jev is used when `TYPESAFE_API_KEY` is set. Without a key, the same tools return rule-based fallbacks that are labelled as such. Fallback results are signals for review, never decisions, and the `autopilot` level behaves as `approve`.

## Development

```sh
npm ci
npm run check
```

`npm run check` runs the type check, the tests (`npm test`), the build, and `node scripts/verify-dist.mjs`. The built bundle in `dist/` is committed so that `npx` can run the repository directly, and it must match the sources: rebuild with `npm run build` and commit the result with any source change.

## License

Apache-2.0. See [LICENSE](LICENSE).
