# code-estate-warden

Security posture audit and remediation for every repository across your GitHub organizations. Policy is prose, evidence comes from StackQL, evaluation is SQL, and the reasoning runs on your GitHub Copilot subscription. Nothing is changed until a human asks for an apply.

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

Steps 1, 3 and 4 are deterministic and never involve a model. Steps 2 and 5 are the agent, and it only proposes: every write goes through apply, which confirms each change with a read and records who changed what.

The controls: secret scanning, push protection, Dependabot alerts and security updates, code scanning, private vulnerability reporting, default branch protection, a license, a `SECURITY.md`, the org 2FA requirement, and an org security configuration. A finding is `pass`, `fail`, `na` (archived, or exempt by policy) or `unknown` (the token could not see the setting). `unknown` is never treated as a failure.

Dependabot alerts currently report `unknown` everywhere: the github provider cannot select that state yet ([stackql-provider-github#7](https://github.com/stackql-registry/stackql-provider-github/issues/7)).

## Setup

You need:

- Node 24
- `stackql` on your PATH (`npm run bootstrap` downloads a copy for the command line, but the Copilot CLI starts the StackQL MCP server by name)
- the GitHub CLI, signed in to an account with a Copilot subscription (`gh auth status`)
- the GitHub Copilot CLI for the terminal app, tested on 1.0.86

```
npm install
npm run bootstrap            # finds or downloads stackql, pulls the github provider
cp .env.example .env         # put the read token in CODE_ESTATE_WARDEN_READ_TOKEN
```

Edit `code-estate-warden.toml`: your enterprise slug, the org allowlist, and the model.

### Tokens

Three tokens, one per role, never shared between roles.

| variable | used by | token |
|---|---|---|
| `CODE_ESTATE_WARDEN_READ_TOKEN` | snapshot, StackQL queries | classic, scopes `repo` and `read:org` |
| `CODE_ESTATE_WARDEN_WRITE_TOKEN` | a real apply | classic, scopes `repo` and `write:org` |
| `COPILOT_GITHUB_TOKEN` | the agent | fine-grained, permission "Copilot Requests"; optional when `gh` is signed in |

- Classic tokens, because a fine-grained token only reaches one org.
- The read token owner must be an owner or security manager of each org, or GitHub hides `security_and_analysis` and those checks come back `unknown`.
- The `gh` token works as the read token if that login has both scopes (`gh auth token`). It changes on `gh auth login`, `refresh` and `logout`, so update `.env` after any of those.
- Leave the write token empty until you mean to apply. Without it a real apply refuses, so nothing can be written.
- `GH_TOKEN`, `GITHUB_TOKEN` or `COPILOT_GITHUB_TOKEN` set in your shell override the `gh` login for Copilot. Clear them if you want the signed-in user.

## Use it in the Copilot CLI

Start the CLI in this repository:

```
copilot --experimental --model claude-sonnet-5.5 --no-auto-update
```

- `--experimental` is required: extensions are an experimental feature and the tools do not load without it (`/experimental on` inside a session does the same).
- `--no-auto-update` keeps the CLI on the version you tested.
- Trust the folder when asked, and choose the option that remembers it. The StackQL MCP server only loads in a trusted folder.
- Leave `--agent code-estate-warden` out for now. The agent limits a session to these tools with no shell and no file edits, but it currently hides the StackQL tools.

Check the session before relying on it:

| type | expect |
|---|---|
| `/user` | your `gh` login. If not signed in, `/login`. |
| `/env` | extension `code-estate-warden`, skills `evaluate` and `remediate`, MCP server `stackql` |
| `/mcp` | `stackql` with `--approot .stackql` and `--env.file .env`. Any other path means the folder is not trusted and a user level server of the same name loaded instead. |

The timeline also shows `code-estate-warden: 13 tools, orgs <your orgs>` when the extension has loaded.

Then:

| type | what happens |
|---|---|
| `/evaluate` | Fresh snapshot of every org with StackQL (about two minutes for 250 repos), then the estate as a table: one row per control, one column per org, failing out of assessed. Followed by what stands out and drift since the previous run. |
| `/evaluate latest` | The same from the newest snapshot in `runs/`, in seconds. A run id works too. |
| `/remediate` | Plans the fix for every failing control, shows the change set and what an apply would do, then stops and asks. `/remediate <org>` limits it to one org. |
| `/usage` | What the session has used. |

Anything else is a plain request with the same tools behind it:

```
which repos in stackql-labs have no branch protection?
using stackql, list the owners of the stackql org
apply private vulnerability reporting for stackql/<repo>
```

The first is answered from the findings with no API calls. The second goes through the StackQL MCP server, and the CLI asks you to approve the tool. The third is a real apply: it always asks first, confirms the change with a read and audits it. A shell command that would write to GitHub is refused in any session in this repository, so apply is the only way to change a repo.

### If something goes wrong

| symptom | do this |
|---|---|
| `Tool 'snapshot' does not exist`, or no extension in `/env` | `/extensions manage` shows the status and the log file. Then `/experimental on`, `/clear`, and check `/env` again. |
| Snapshot is slow or errors | `/evaluate latest` shows the same table from the newest snapshot in `runs/`. |
| Many more `unknown` than last time | The read token sees less than it did. Check it against the tokens section above. |
| A StackQL request finds no tools | Check `/mcp`. If the session was started with `--agent`, restart without it. |
| The CLI is unusable | `node src/cli.ts evaluate` prints the same report with no model involved. |

## Use it from the command line

```
node src/cli.ts snapshot     # about two minutes for 250 repos
node src/cli.ts evaluate     # the report, plus what changed since the last run
node src/cli.ts plan         # one Copilot prompt per org with failures, writes the change set
node src/cli.ts apply        # dry run: what --apply would do
```

`node src/cli.ts run` does snapshot, evaluate and plan in one go. Every run leaves its snapshot (a SQLite file), findings and plan in `runs/`, and old runs stay, which is what makes drift possible.

`.github/workflows/audit.yml` runs snapshot and evaluate on a schedule and writes the job summary. It plans only if a `COPILOT_GITHUB_TOKEN` secret is set, and it never applies.

## Applying changes

`apply` without `--apply` is a dry run and needs no write token. With `--apply` it does three kinds of thing:

- Settings on the `apply_checks` allowlist in `code-estate-warden.toml`. Today that is private vulnerability reporting: a StackQL mutation per repo, confirmed by reading the setting back.
- Issues in the affected repos for anything that needs a maintainer, labelled `code-estate-warden`. Running apply again updates the same issue instead of opening another.
- Issues written for the Copilot coding agent when the fix is a file (`LICENSE`, `SECURITY.md`). `--assign-copilot` assigns them.

`--filter <text>` limits apply to changes whose key contains the text, for example one repo. Archived repos, repos outside the org allowlist and anything that would disable a control are refused before any call is made.

## Billing

The agent is billed to the Copilot subscription of the signed-in user, with no model API keys. Snapshot, evaluate and apply never prompt a model. On the command line, planning is one prompt per org with failures and the model comes from `code-estate-warden.toml`. In the Copilot CLI the model is the one you launch with or pick with `/model`, and the tools return counts and summaries instead of whole reports to keep token use low.

## Development

```
npm test          # no network, no premium requests
npm run check     # tsc
```

TypeScript runs straight on Node 24 with no build step. StackQL behaviours the code works around are tracked in [#1](https://github.com/stackql/code-estate-warden/issues/1).
