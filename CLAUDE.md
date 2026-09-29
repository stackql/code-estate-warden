# repo-warden

Agentic security posture audit and remediation for every repository across every organization in a GitHub Enterprise account. Policy is expressed as a prompt, evidence is gathered with StackQL, evaluation is deterministic SQL, reasoning and remediation planning run on the GitHub Copilot SDK (billed to the Copilot subscription, no model API keys), and remediation happens through StackQL mutations, issues raised in the affected repos, and the Copilot coding agent for changes that need a PR.

Origin: built during the GitHub Secure Open Source Fund (Session 5) to scale the program's core controls across the whole StackQL org.

## Architecture

Five layers, in order. Keep them separate. The agent only touches layers 2 and 5.

1. Inventory (deterministic) - StackQL queries enumerate enterprise -> orgs -> repos -> settings and write a point-in-time snapshot to SQLite. Nothing else talks to the GitHub API for reads.
2. Policy (agentic) - the Copilot SDK agent reads the policy prompt (`policy/*.md`) and produces a policy manifest (`checks.yaml`): which checks are in scope, thresholds, exemptions. Humans can also hand-write the manifest and skip the agent.
3. Evaluate (deterministic) - each check is a SQL query in `checks/<check_id>.sql` run against the snapshot. Output is a findings table with a stable schema. No LLM involvement.
4. Report (deterministic) - findings rendered as terminal table, markdown, JSON, and a GitHub Actions job summary. History is kept so runs can be diffed (drift).
5. Remediate (agentic, gated) - the agent turns findings into a change set: repo setting mutations (StackQL), issues in affected repos, or issues assigned to the Copilot coding agent for file changes (LICENSE, SECURITY.md). Nothing is applied without `--apply`. Default is plan only.

The two agentic layers use the same Copilot SDK session factory in `repo_warden/agent.py`. Everything the agent needs is exposed as SDK tools wrapping the deterministic layers, plus the StackQL MCP server for ad hoc queries.

## Findings schema

Every check emits rows with exactly these columns. Do not add per-check columns; put extras in `evidence` as JSON.

| column | type | notes |
|---|---|---|
| run_id | text | ULID per run |
| org | text | |
| repo | text | |
| check_id | text | matches `checks/<check_id>.sql` |
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
| archived_excluded | archived repos are `na` for every other check | none |

Org-level checks (2FA required, org security configurations present) live in `checks/org/` and emit rows with `repo = '*'`.

## StackQL

- Provider: `github`. Pull with `REGISTRY PULL github` on first run.
- Use StackQL two ways: the `stackql` binary (or `pystackql`) directly for the inventory snapshot, and the StackQL MCP server exposed to the Copilot agent for ad hoc reasoning queries. Do not let the agent build the snapshot.
- Prefer org security configurations (GitHub's security configurations API) over per-repo PATCHes when remediating the core controls. Per-repo mutations are the fallback for exceptions.
- Pagination and rate limits: snapshot once per run, evaluate offline. Respect `X-RateLimit-Remaining`; back off rather than fail the run.
- Every StackQL mutation used for remediation must have a matching read that confirms the new state. Apply = mutate, re-read, record.

## Copilot SDK

- Python package `github-copilot-sdk`, import `copilot`. The CLI is bundled with the Python package. Auth via `COPILOT_GITHUB_TOKEN` (or the signed-in `gh` user). Each prompt counts against the subscription's premium request allowance, so batch work into as few prompts as possible: one prompt to compile policy, one prompt per remediation plan, not one per repo.
- Session creation: `CopilotClient()` -> `client.create_session(model=..., tools=[...], system_message={...}, on_permission_request=...)`. Tools are defined with `@define_tool` and pydantic params.
- Verify against the installed SDK version how MCP servers are declared (session option vs the Copilot CLI `mcp-config.json`). Use whichever the installed version supports and document it in `docs/mcp.md`. Do not guess.
- Permission handler: approve read tools automatically, reject shell, and route any write tool through the plan/apply gate. Never use `approve_all` outside tests.
- Pin the model in config, default to the cheapest model that handles tool use reliably. Model choice is a config value, not a code change.
- The agent layer must be swappable. Keep the provider behind `AgentRuntime` protocol in `repo_warden/agent.py` so a Claude Code headless runtime can be added later without touching other layers.

## Remediation rules

- `plan` is the default verb. `apply` requires `--apply` and a write-capable token in `REPO_WARDEN_WRITE_TOKEN`. Reads use `REPO_WARDEN_READ_TOKEN`. Never use one token for both.
- Idempotent: before raising an issue, search the repo for an open issue with label `repo-warden` and the same `check_id` in the title. Update it rather than duplicate. Same for branches and PRs (`repo-warden/<check_id>`).
- Issues raised in affected repos include: the finding, the evidence, the exact change proposed, and a link back to the run report. For `pr` remediations, the issue is written so it can be assigned to the Copilot coding agent as is (clear acceptance criteria, the file content to add). Assignment to Copilot is a separate `--assign-copilot` flag.
- Never mutate a repo outside the orgs listed in config. Never touch archived repos. Never disable a control.
- Every apply writes an audit row (`who`, `what`, `before`, `after`, `run_id`).

## Stack and conventions

- Python 3.12, `uv` for env and lockfile, `typer` for CLI, `rich` for terminal output, `pydantic` for models, SQLite via stdlib, `ruff` and `pyright` clean.
- CLI: `repo-warden snapshot | compile-policy | evaluate | report | plan | apply | history`. `repo-warden run` chains snapshot -> evaluate -> report -> plan.
- Config in `repo-warden.toml`: enterprise slug, org allowlist, repo exclusions, model, severity mapping, issue label.
- Tests: unit tests for every check SQL against fixture snapshots in `tests/fixtures/*.db`; no live API calls in tests. Agent layer tested with a fake runtime.
- GitHub Actions: `.github/workflows/audit.yml` runs `repo-warden run` on a schedule and posts the job summary; never runs `apply` unattended.
- Commit style: conventional commits. Small PRs. No generated code without a test.
- Writing style in docs and issue templates: matter of fact, no hyperbole, no em dashes (use `-`), no unicode arrows (use `->`).

## Repo layout

```
repo_warden/
  cli.py            typer entrypoint
  config.py
  inventory.py      StackQL snapshot -> SQLite
  policy.py         prompt -> checks.yaml (agentic) and manifest loader
  evaluate.py       runs checks/*.sql -> findings
  report.py
  remediate.py      change set model, plan, apply, audit
  agent.py          AgentRuntime protocol, Copilot SDK implementation, tools
  github_writes.py  StackQL mutations, issue and PR helpers
checks/             one .sql per check, org/ subfolder for org-level
policy/             policy prompts (core-controls.md is the SOSF baseline)
templates/          issue bodies, PR bodies, SECURITY.md, LICENSE options
docs/
tests/
```

## Out of scope for v1

GitLab or other forges, GHAS alert triage, secret rotation, dependency upgrades, anything that modifies code other than adding LICENSE or SECURITY.md via the coding agent.
