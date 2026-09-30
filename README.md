# repo-warden

Security posture audit and remediation for every repository across your GitHub organizations. Policy is prose, evidence comes from StackQL, evaluation is SQL, and the reasoning runs on your GitHub Copilot subscription. Nothing is changed without a human saying `--apply`.

Built during the GitHub Secure Open Source Fund to scale its core controls across the whole StackQL org.

## How it works

```
policy/core-controls.md                    what good looks like, in prose
        |
        v
1. snapshot   StackQL reads orgs, repos and settings   ->  runs/<run_id>.db
2. policy     the agent compiles the prose             ->  policy/manifest.json
3. evaluate   one SQL check per control                ->  runs/<run_id>.json
4. report     terminal, markdown, job summary, drift against the previous run
5. plan       the agent groups failures into changes   ->  runs/<run_id>.plan.json
   apply      settings, issues, issues for the coding agent, each audited
```

Layers 1, 3 and 4 are deterministic and never involve a model. Layers 2 and 5 are the agent, and it only ever proposes: every write goes through `apply --apply`, which confirms each change with a read and records who changed what.

## Quickstart

You need Node 24, a GitHub classic token with `repo` and `read:org` (see credentials below), and a Copilot subscription on the account you are signed in to with `gh`.

```
npm install
npm run bootstrap            # finds or downloads stackql, pulls the github provider
cp .env.example .env         # put the read token in REPO_WARDEN_READ_TOKEN
```

Edit `repo-warden.toml`: your enterprise slug, the org allowlist, and the model.

```
node src/cli.ts snapshot     # about two minutes for 250 repos
node src/cli.ts evaluate     # the report, plus what changed since the last run
node src/cli.ts plan         # one Copilot prompt per org, writes the change set
node src/cli.ts apply        # dry run: what --apply would do
```

`node src/cli.ts run` does snapshot, evaluate and plan in one go; `npm run demo` is the same with the total time at the end.

Every run leaves three files in `runs/`: the snapshot (a SQLite file you can open with any client), the findings, and the plan. Old runs stay, which is what makes drift possible.

## What gets checked

Secret scanning, push protection, Dependabot alerts and security updates, code scanning, private vulnerability reporting, default branch protection, a license, a `SECURITY.md`, the org 2FA requirement, and whether the org has a security configuration of its own. Each check is one SQL file under `sql/checks/` and reads only the snapshot. A finding is `pass`, `fail`, `na` (archived, or exempt by policy) or `unknown` (the token could not see the setting). `unknown` is never treated as a failure.

Dependabot alerts currently report `unknown` everywhere: the github provider cannot select that state yet ([stackql-provider-github#7](https://github.com/stackql-registry/stackql-provider-github/issues/7)).

## Applying changes

`apply` without `--apply` is a dry run and needs no write token. With `--apply` it needs `REPO_WARDEN_WRITE_TOKEN` and does three kinds of thing:

- Settings on the `apply_checks` allowlist in `repo-warden.toml`. Today that is private vulnerability reporting: a StackQL mutation per repo, confirmed by reading the setting back.
- Issues in the affected repos for anything that needs a maintainer, labelled `repo-warden`. Running apply again updates the same issue instead of opening another.
- Issues written for the Copilot coding agent when the fix is a file (`LICENSE`, `SECURITY.md`): the body carries the file content and the acceptance criteria. `--assign-copilot` assigns them.

`--filter <text>` limits apply to changes whose key contains the text, for example one repo. Archived repos, repos outside the org allowlist and anything that would disable a control are refused before any call is made.

## Billing

The agent runs on the GitHub Copilot SDK, so it is billed to the Copilot subscription of the signed-in user (or the owner of `COPILOT_GITHUB_TOKEN`). There are no model API keys. Each prompt counts as one premium request against that subscription's allowance, so the tool is built to prompt rarely: one prompt to compile the policy (only on `plan --compile-policy`), and one prompt per org that has failures when planning. Snapshot, evaluate and apply never prompt. The model is a config value; `plan` lists the available models with their multipliers if the configured one does not exist, without spending a request.

## Credentials

Three tokens, one per role, never shared between roles.

| variable | used by | token |
|---|---|---|
| `REPO_WARDEN_READ_TOKEN` | `snapshot` | classic, scopes `repo` and `read:org` |
| `REPO_WARDEN_WRITE_TOKEN` | `apply --apply` | classic, scopes `repo` and `write:org` |
| `COPILOT_GITHUB_TOKEN` | `plan` | fine-grained, permission "Copilot Requests"; optional when `gh` is signed in |

Classic tokens because a fine-grained token only reaches one org. The token owner must be an owner or security manager of each org, or GitHub hides `security_and_analysis` and those checks come back `unknown`.

## In GitHub Actions

`.github/workflows/audit.yml` runs snapshot and evaluate on a schedule and writes the job summary. It plans only if a `COPILOT_GITHUB_TOKEN` secret is set, and it never applies. The runs are uploaded as an artifact.

## Development

```
npm test          # 48 tests, no network, no premium requests
npm run check     # tsc
```

TypeScript runs straight on Node 24 with no build step. Checks are tested against small JSON fixtures in `test/fixtures/`, the agent against a fake runtime, and apply against a fake stackql. StackQL behaviours the code works around are tracked in [#1](https://github.com/stackql/repo-warden/issues/1).
