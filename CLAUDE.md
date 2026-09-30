# repo-warden

Agentic security posture audit and remediation for every repository across every organization in a GitHub Enterprise account. Policy is expressed as a prompt, evidence is gathered with StackQL, evaluation is deterministic SQL, reasoning and remediation planning run on the GitHub Copilot SDK (billed to the Copilot subscription, no model API keys), and remediation happens through StackQL mutations, issues raised in the affected repos, and the Copilot coding agent for changes that need a PR.

Origin: built during the GitHub Secure Open Source Fund (Session 5) to scale the program's core controls across the whole StackQL org.

## Architecture

Five layers, in order. Keep them separate. The agent only touches layers 2 and 5.

1. Inventory (deterministic) - StackQL queries in `sql/snapshot/*.sql` enumerate orgs -> repos -> settings with the in memory backend; the rows are written with `node:sqlite` into a point-in-time snapshot, one table per source, in a fresh `runs/<run_id>.db`. Nothing else talks to the GitHub API for reads.
2. Policy (agentic) - the Copilot SDK agent reads the policy prompt (`policy/core-controls.md`) and compiles it into `policy/manifest.json`: which checks are in scope, their scope (all or public repos), fork and named exemptions. Humans can hand-write the manifest and skip the agent. The manifest is checked in and only recompiled on request (`plan --compile-policy`), one prompt.
3. Evaluate (deterministic) - each check in the manifest is a SQL query in `sql/checks/<check_id>.sql` run against the snapshot. A finding the manifest exempts becomes `na` with `evidence.exempt` giving the reason. Output is a findings table with a stable schema. No LLM involvement.
4. Report (deterministic) - findings rendered as terminal table, markdown, and a GitHub Actions job summary. Findings are kept per run in `runs/<run_id>.json` so runs can be diffed (drift).
5. Remediate (agentic, gated) - the agent turns findings into a change set: repo setting mutations (StackQL), issues in affected repos, or issues assigned to the Copilot coding agent for file changes (LICENSE, SECURITY.md). Nothing is applied without `--apply`. Default is plan only.

The two agentic layers use the same Copilot SDK session factory in `src/agent.ts`. Everything the agent needs is exposed as SDK tools wrapping the deterministic layers, plus the StackQL MCP server for ad hoc queries.

## Findings schema

Every check emits rows with exactly these columns. Do not add per-check columns; put extras in `evidence` as JSON.

| column | type | notes |
|---|---|---|
| run_id | text | ULID per run |
| org | text | |
| repo | text | |
| check_id | text | matches `sql/checks/<check_id>.sql` |
| status | text | `pass`, `fail`, `na`, `unknown` |
| severity | text | `high`, `medium`, `low` |
| evidence | json | raw values the decision was made on |
| remediation | text | `setting`, `issue`, `pr`, `manual`, `none` |
| observed_at | text | ISO 8601 |

`unknown` is for when the token lacked permission to see the setting (e.g. `security_and_analysis` returns null without admin). Never coerce unknown to fail.

## Checks (v1)

| check_id | source of truth | remediation |
|---|---|---|
| secret_scanning | `security_and_analysis.secret_scanning` on repo | setting (org security configuration preferred) |
| push_protection | `security_and_analysis.secret_scanning_push_protection` | setting |
| dependabot_alerts | `vulnerability-alerts` endpoint (204/404) | setting |
| dependabot_security_updates | `security_and_analysis.dependabot_security_updates` | setting |
| code_scanning | `code-scanning/default-setup` state, or presence of a CodeQL workflow | setting |
| private_vuln_reporting | `private-vulnerability-reporting` endpoint | setting |
| default_branch_protected | `branches/{default}/protection` OR an active ruleset targeting the default branch. Either satisfies. | setting |
| license_file | `license` field on repo object | pr |
| security_md | `contents/SECURITY.md` in repo, else `SECURITY.md` in the org `.github` repo. Inherited counts as pass with evidence noting inheritance. | pr |
| org_two_factor | `two_factor_requirement_enabled` on the org (owners only) | manual |
| org_security_configuration | an org-owned or enforced security configuration; the unenforced global "GitHub recommended" alone is a fail | setting |

Archived repos are `na` for every check; that rule lives in each check's SQL, not in a check of its own. Org-level checks are named `sql/checks/org_*.sql` and emit rows with `repo = '*'`. Every check has a fixture in `test/fixtures/<check_id>.json` and the test suite refuses a check without one.

## StackQL

- Provider: `github`. Pull with `REGISTRY PULL github` on first run.
- Use StackQL two ways: the `stackql` binary (spawned from `src/stackql.ts`) directly for the inventory snapshot, and the StackQL MCP server exposed to the Copilot agent for ad hoc reasoning queries. Do not let the agent build the snapshot.
- Prefer org security configurations (GitHub's security configurations API) over per-repo PATCHes when remediating the core controls. Per-repo mutations are the fallback for exceptions.
- Collection and persistence are separate. Each `sql/snapshot/*.sql` is a plain `SELECT` run by stackql with its in memory backend (`--output json`, every value a string); `src/snapshot.ts` coerces `true`/`false`/`null` and inserts the rows into `runs/<run_id>.db`. A query with an `{{org}}` placeholder runs once per org, at most six stackql processes at a time (GitHub's secondary rate limit is about 900 calls a minute). Do not go back to materialized views or a file backend: `PURGE` empties or drops views, a failed `REFRESH` leaves a view empty, two processes on one file race on provider discovery, and stackql does not evaluate expressions over views (stackql/stackql#798 to #801).
- Pagination and rate limits: snapshot once per run, evaluate offline. Respect `X-RateLimit-Remaining`; back off rather than fail the run.
- Every StackQL mutation used for remediation must have a matching read that confirms the new state. Apply = mutate, re-read, record.

## Copilot SDK

- Node package `@github/copilot-sdk` (1.0.15 verified; the runtime is bundled per platform, no separate CLI install). Auth via `COPILOT_GITHUB_TOKEN`, else the signed-in `gh` user (`useLoggedInUser` defaults to true). Each prompt counts against the subscription's premium request allowance, so batch work into as few prompts as possible: one prompt to compile policy, one prompt per remediation plan, not one per repo.
- Verified API: `new CopilotClient({ gitHubToken })`, `client.listModels()` (ids with `billing.multiplier`, not a premium request), `client.createSession({ model, systemMessage: { mode: "append", content }, tools, mcpServers, onPermissionRequest, streaming: false })`, `defineTool(name, { description, parameters: zodSchema, handler })`, `session.sendAndWait({ prompt }, zodSchema, timeoutMs)` for a structured reply. `CopilotRuntime.ask` refuses an unknown model id before spending a request.
- MCP servers are a session option, not a config file: `mcpServers: { stackql: { type: "stdio", command, args } }`. The StackQL server is `stackql mcp --approot .stackql --auth <read token json> --mcp.server.type=stdio`, declared by `stackql.mcpServer()`.
- Permission handler (`agent.ts`): approve `custom-tool` (our tools) and read only `mcp` calls, reject everything else including `shell` and `write`. Never use `approveAll` outside tests. `propose_change` is the only tool with a side effect and it only appends to the change set.
- Every agentic step is `runtime.ask({ prompt, tools, schema })` on the `AgentRuntime` interface. Tests use `test/fake.ts`, which runs scripted tool calls and returns a canned reply, so the suite never spends a request.
- Prompts are prose files in `instructions/` with `{{placeholders}}`, loaded by `instruction(name, vars)`.
- Pin the model in config, default to the cheapest model that handles tool use reliably. Model choice is a config value, not a code change.
- The agent layer must be swappable. Keep the provider behind the `AgentRuntime` interface in `src/agent.ts` so a Claude Code headless runtime can be added later without touching other layers.
- Not yet exercised live (no Copilot allowance on the build day): session creation, the MCP server hand-off and structured replies. First live run: `repo-warden plan` on a fresh snapshot, watching for model id, MCP startup and tool call permission events.

## Remediation rules

- `plan` is the default verb. `apply` requires `--apply` and a write-capable token in `REPO_WARDEN_WRITE_TOKEN`. Reads use `REPO_WARDEN_READ_TOKEN`. Never use one token for both.
- Idempotent: before raising an issue, search the repo for an open issue with label `repo-warden` and the same `check_id` in the title. Update it rather than duplicate. Same for branches and PRs (`repo-warden/<check_id>`).
- Issues raised in affected repos include: the finding, the evidence, the exact change proposed, and a link back to the run report. For `pr` remediations, the issue is written so it can be assigned to the Copilot coding agent as is (clear acceptance criteria, the file content to add). Assignment to Copilot is a separate `--assign-copilot` flag.
- Never mutate a repo outside the orgs listed in config. Never touch archived repos. Never disable a control.
- Every apply writes an audit row (`who`, `what`, `before`, `after`, `run_id`).

## Stack and conventions

- TypeScript on Node 24, run directly by Node (type stripping, erasable syntax only). No build step, no transpiler, no bundler. `npm` for dependencies and scripts.
- `commander` for CLI, `zod` for models and validation, `smol-toml` for config, `node:test` for tests. Prefer the Node standard library over a dependency. `tsc` clean (`npm run check`).
- Prose lives in `.md` files and queries live in `.sql` files. TypeScript modules load them. Do not inline prompts, templates, policy text or SQL in code.
- CLI: `repo-warden snapshot | evaluate | plan | apply | run`. `repo-warden run` chains snapshot -> evaluate -> plan. `bootstrap` checks the stackql binary and pulls the provider. `evaluate` runs the checks, writes `runs/<run_id>.json`, prints the report (terminal, or markdown with `--markdown`), appends the GitHub Actions job summary when `GITHUB_STEP_SUMMARY` is set, and shows drift against the previous run. There are no separate report or history verbs.
- Config in `repo-warden.toml`: enterprise slug, org allowlist, repo exclusions, model, severity mapping, issue label.
- Tests: unit tests for every check SQL against small JSON row sets in `test/fixtures/`; no live API calls in tests. Agent layer tested with a fake runtime.
- GitHub Actions: `.github/workflows/audit.yml` runs `repo-warden run` on a schedule and posts the job summary; never runs `apply` unattended.
- Commit style: conventional commits. Small PRs. No generated code without a test.
- Writing style in docs and issue templates: matter of fact, no hyperbole, no em dashes (use `-`), no unicode arrows (use `->`).

## Repo layout

```
src/
  cli.ts            commander: snapshot | evaluate | plan | apply | run
  config.ts         zod schema + loader for repo-warden.toml
  stackql.ts        spawn stackql, run .sql files, return rows
  snapshot.ts       runs sql/snapshot/*.sql per org, rows -> runs/<run_id>.db
  evaluate.ts       runs sql/checks/*.sql -> findings[]
  report.ts         table to terminal, markdown, job summary
  agent.ts          Copilot SDK session, tools, permission handler
  remediate.ts      change set, plan (agent), apply (gated), issues
  types.ts          Finding, ChangeItem, Manifest
sql/
  snapshot/         one .sql per inventory source
  checks/           one .sql per check, findings schema out
instructions/       system_prompt.md
policy/             policy prompts (core-controls.md is the SOSF baseline)
templates/          issue.md, SECURITY.md
test/
  fixtures/         small JSON row sets per check
  *.test.ts
runs/               gitignored: <run_id>.json findings per run
```

## Out of scope for v1

GitLab or other forges, GHAS alert triage, secret rotation, dependency upgrades, anything that modifies code other than adding LICENSE or SECURITY.md via the coding agent.
