# autopilot-marketing

autopilot-marketing is an open-source ad operations engine for your own AI agent (Claude Code, Codex, or any MCP client). It gives the agent tools to read ad accounts, find problems with the evidence behind them, prepare typed changes, and apply only what a person approved. State and history stay on your machine. It is not a chatbot and not a hosted service, and there is no account to create with us.

## What it does

- **Evidence-backed audits.** Deterministic checks produce findings, and every finding carries the rows behind it and a data-sufficiency status (`sufficient`, `limited`, `tracking_issue` or `undecidable`).
- **Search-term review.** Search terms are classified with typed judgments from Jev (see [Jev](#jev)), each with a confidence and a band that says whether it can be used or needs review.
- **KPI reports.** Period-over-period numbers with facts that can be recomputed from the stored data.
- **Reviewable change plans.** A plan is a stored list of typed actions with the current state of each target recorded. Creating a plan changes nothing.
- **Guarded execution.** Policy limits, an approval bound to the plan digest, a fresh-state check before each change, an append-only ledger, and compensating reverts.
- **Scheduled checks.** Schedules you write in the config run audits, reports and cycles on this machine, and rules (not a model) decide when a run needs your attention.
- **Your data, your limits.** Per account you decide whether anything goes to Jev and whether an agent may read rows at all. Credentials can live in the operating system's credential store.
- **A local model if you want one.** The same tools work with a model served on this machine, with less authority than your own agent gets.
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

The MCP server exposes 15 tools. Clients add their own prefix to these names.

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
| `jobs_list` | Lists the owner's schedules and the recent scheduled runs, with their results and the reasons a person should look. No tool creates, changes or starts a schedule. |

The command line program `autopilot-marketing` has these commands: `init`, `doctor`, `credentials`, `snapshot`, `audit`, `report`, `plan`, `preview`, `approve`, `review`, `apply`, `revert`, `run`, `schedule`, `jobs`, `reconcile`, `agent`, `ledger`, `kill` and `mcp`. `kill` turns on the kill switch, which refuses every live change, and `mcp` starts the MCP server. Every command takes `--json` for output a script can read.

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

Credentials do not have to sit in a file. `autopilot-marketing credentials set GOOGLE_REFRESH_TOKEN` reads the value from a hidden prompt (or from a pipe) and keeps it in the macOS keychain or, on Linux, in the Secret Service through `secret-tool`. On other systems use the `.env` file. A value in the process environment wins over the credential store, which wins over `.env`. A credential that is registered in the store but cannot be read (a locked keychain, for example) is treated as missing; it is never replaced by a value from `.env` or by another account's credential. The credentials of one account come from one place: an account with an `envPrefix` uses its prefixed variables or the shared ones, never a mix of both.

`autopilot-marketing doctor --connect` tests the connection of every account with real calls and names the fix for what fails: an expired refresh token, a missing scope, an API that is not enabled, a Google Cloud project with Test access only, a customer that is reachable only through a manager account, a Meta token without `ads_read`, an ad account the user cannot reach. It reports what it tested. Read access is tested; write access is not. Google does not expose a project's access level through the API, and Meta's access tier is separate from the permissions of a token: the check prints what Meta reports and does not guess.

If you do not want to connect an API, export CSV files from the platform and pass them to `snapshot_create` in `csvFiles`. A snapshot built from CSV can be audited and reported on without any credentials. Changes still need API access, because the current state of every target is read from the platform before a plan is stored and again before it is applied. Demo accounts simulate changes on this machine; nothing leaves it.

## Scheduling

Schedules are written by you in `config.json`. No tool creates, changes or starts one.

```json
{
  "schedules": [
    { "id": "daily-audit", "accountId": "acme-google", "task": "audit", "every": "1d", "at": "07:30" },
    { "id": "weekly-report", "accountId": "acme-google", "task": "report", "every": "7d" }
  ]
}
```

`task` is `audit` (snapshot and audit), `report` (KPI report against the previous period) or `cycle` (audit, plan, and apply only what the autonomy level, the policy and the Jev gate allow). `every` is `15m` to `30d`. `at` is a time of day in the account's time zone and needs an interval in whole days.

Nothing runs by itself: `autopilot-marketing schedule run` runs what is due and exits, so it fits cron, launchd or a systemd timer, and `schedule run --watch` keeps running in a terminal.

```
*/15 * * * * autopilot-marketing schedule run
```

- A run is stored in the state database and survives a restart. Only the latest slot of a schedule is run; slots missed while the machine was off are not made up.
- Several processes can run at once. A job is claimed by one of them, and a worker that was suspended cannot finish a job that another worker took over.
- A failed audit or report is retried twice when the failure was temporary; a run whose snapshot came back empty counts as failed, not as a clean result. A cycle is never retried: the next slot starts from a fresh snapshot, after settling what an interrupted run left behind (`autopilot-marketing reconcile <accountId>` does the same by hand).
- Rules decide whether a run needs your attention: a new critical or high finding, a score that fell by 10 points, a new tracking problem, a plan waiting for approval, a change that failed or whose outcome is unknown, a run that failed. `autopilot-marketing jobs` and the `jobs_list` tool show the runs and the reasons.
- `schedule run` exits with 3 when a run needs attention, 1 when a run failed, and 0 otherwise.

autopilot-marketing does not start an agent for you. A script of your own can, when the exit code is 3. This starts Claude Code with the tools of this server only, no shell and no file access:

```sh
autopilot-marketing schedule run
if [ $? -eq 3 ]; then
  claude -p --mcp-config mcp.json --strict-mcp-config --tools "" \
    --allowedTools "mcp__autopilot__*" --permission-mode dontAsk --max-turns 8 \
    "Call jobs_list with attentionOnly true and summarise what needs my attention."
fi
```

Here `mcp.json` is `{"mcpServers":{"autopilot":{"command":"npx","args":["-y","github:eraygundogmus/autopilot-marketing","mcp"]}}}`.

When the computer is off or asleep nothing runs, and ads that are live keep running.

## What leaves your machine

The program, its database, the schedules, the reports and the change history stay on your machine, and there is no server of ours. Three things leave it:

- **Calls to the ad platforms**, with your credentials.
- **What your agent reads.** A tool result goes to whatever model your agent uses. Running the server locally does not make a cloud model local.
- **Requests to Jev**, when `TYPESAFE_API_KEY` is set: search terms, ad copy, statements to verify and the actions of a plan, with the business description.

Per account you can narrow this in `config.json`:

```json
{ "id": "acme-google", "platform": "google_ads", "externalId": "123-456-7890",
  "sharing": { "judgments": false, "rows": false } }
```

- `"judgments": false`: nothing stored for this account is sent to Jev. Its audit, the judge tools and the gate use the labelled rule-based fallback, so nothing is applied automatically for it.
- `"rows": false`: `data_query` and `evidence_get` return counts for this account and no rows, and `judge_terms` does not list the search terms of its snapshots. Findings and reports still quote the numbers and names they are about.

Names in findings are not masked. Masking them reliably would need opaque identifiers everywhere and would hide the search terms and ad copy an agent is asked to review, so this version does not promise it.

## Using a local model

`autopilot-marketing agent` runs a task with a model served on this machine through an OpenAI-compatible endpoint, by default Ollama at `http://127.0.0.1:11434/v1`. The model gets the same tools through the same server.

```sh
autopilot-marketing agent "Audit demo-google and list the three most expensive findings." --model qwen3 --account demo-google
```

- The endpoint must be a loopback address written as a number (`127.0.0.1` or `[::1]`), and a model that Ollama serves from the cloud is refused. `--allow-remote` lifts both.
- The model gets less authority than your own agent: it cannot go beyond `propose`, it sees only the accounts named with `--account`, it cannot import files, and judgments use the rule-based fallback instead of Jev. `--allow-apply` gives it the autonomy level of your config, and `--jev` allows Jev.
- With Ollama, set `OLLAMA_NO_CLOUD=1` to turn its cloud features off.

The runner is tested against a model server that follows the documented protocol, not against a real model. How well a small local model uses the tools depends on the model.

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
- **Protected entities.** Entities listed under an account's `protected` (ids, names or name patterns such as `*brand*`) cannot be changed. Names and parent campaigns are taken from the snapshot, never from what the caller supplied, so a plan for an account with protected entities must be created from a snapshot.
- **Account binding.** A snapshot must belong to the same account as the plan, and a Meta entity is checked against the configured ad account before it is read or changed, because one access token often reaches several accounts.
- **Bound approvals.** An approval receipt is bound to the plan digest, the policy digest and the exact review text. It can be used for one execution and it expires.
- **Fresh state.** The target's state is read again before each change, and the change is skipped if it differs from what the plan recorded.
- **No blind retry.** When the outcome of a change cannot be confirmed, it is recorded as `unknown`, and that entity is blocked until a fresh read settles it.
- **Hash-chained ledger.** Each ledger entry contains the hash of the one before it.
- **Kill switch.** While it is on, every live change is refused.
- **One execution per account.** A lock keeps two executions off the same account. It is checked again immediately before every request that changes the platform, after any read the connector makes first, so a process that was suspended past its lock, or a scheduled run that lost its job to another worker, does not write.
- **Human-owned settings.** The autonomy level, the policy, the schedules and the sharing policy live in the config file. No tool changes them.

Known limits:

- An agent that runs as the same operating-system user and has a shell can read the credentials and edit local state. For that reason the terminal and browser approval channels are not proof that a human approved.
- The ledger chain detects accidental damage. It does not stop a determined local attacker.
- Another person can change the account between the last read and the write.
- Local limits are not a billing cap. Set budget caps in the ad platform itself.
- Use credentials with the least privilege that the work needs.
- The data an agent reads through these tools goes to whatever model that agent uses.
- The credential store keeps secrets out of a plain file, out of commits and backups, and away from an agent that can only read files. An agent that may run any shell command as you can ask the operating system for them.
- A schedule runs only while the machine is on, and a local schedule is not a monitor: a run that did not happen raises no alarm.

## Jev

Jev is TypeSafe's System One model. It answers typed questions (yes or no, a choice, a score) instead of free text. autopilot-marketing uses it for four things: classifying search terms, verifying claims against data, screening ad copy, and the gate before an automatic apply.

All requests go to a single endpoint, `POST /v1/systemone`. Each audit, judge tool call and gate check reports the estimated cost of the requests it made itself, and an operation that sent a request writes a `judgment.usage` entry to the ledger. Answers are cached locally, so asking the same question again costs nothing.

Jev is used when `TYPESAFE_API_KEY` is set. Without a key, the same tools return rule-based fallbacks that are labelled as such. Fallback results are signals for review, never decisions, and the `autopilot` level behaves as `approve`.

## Development

```sh
npm ci
npm run check
```

`npm run check` runs the type check, the tests (`npm test`), the build, and `node scripts/verify-dist.mjs`. The built bundle in `dist/` is committed so that `npx` can run the repository directly, and it must match the sources: rebuild with `npm run build` and commit the result with any source change.

## License

Apache-2.0. See [LICENSE](LICENSE).
