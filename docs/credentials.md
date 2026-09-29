# Credentials

repo-warden uses three tokens, one per role. A token is never used for more than one role, so a leaked read token cannot change anything and the write token is only present when `apply --apply` runs.

| variable | used by | can write |
|---|---|---|
| `REPO_WARDEN_READ_TOKEN` | `snapshot` | no |
| `REPO_WARDEN_WRITE_TOKEN` | `apply --apply` | yes |
| `COPILOT_GITHUB_TOKEN` | `compile-policy`, `plan` | no repo access at all |

Set them in the environment or in a `.env` file in the directory you run repo-warden from. See `.env.example`.

## Read token

Fine-grained personal access token, minimum permissions:

| scope | permission | access | needed for |
|---|---|---|---|
| repository | Metadata | read | repo object, license, rulesets, private vulnerability reporting status |
| repository | Administration | read | `security_and_analysis`, branch protection, code scanning default setup, vulnerability alerts |
| repository | Contents | read | SECURITY.md and CodeQL workflow presence |
| organization | Administration | read | org security configurations, org rulesets |

Repository access: all repositories.

The token owner also matters. GitHub only returns `security_and_analysis` to repo admins, org owners and security managers, and only returns the org 2FA requirement to org owners. When the token cannot see a setting, the snapshot stores null and the check reports `unknown`, not `fail`.

## Write token

Fine-grained personal access token, minimum permissions:

| scope | permission | access | needed for |
|---|---|---|---|
| repository | Metadata | read | required by GitHub for every token |
| repository | Administration | write | enabling private vulnerability reporting and other repo security settings |
| repository | Issues | write | creating and updating issues, creating the `repo-warden` label |
| organization | Administration | write | attaching an org security configuration (omit if you only use per-repo settings) |

## Copilot token

Fine-grained personal access token owned by a user with a Copilot subscription, with one account permission: Copilot Requests. Classic tokens are not accepted by the Copilot CLI.

The Copilot CLI reads `COPILOT_GITHUB_TOKEN`, then `GH_TOKEN`, then `GITHUB_TOKEN`. If none are set it uses the signed-in `gh` user.

## One token, many orgs

A fine-grained token can only access resources owned by a single user or organization. An audit that spans several orgs therefore needs one of:

- a fine-grained token per org, running repo-warden once per org
- a classic token with the `repo` and `read:org` scopes, which spans every org the owner belongs to

A classic token with `repo` is write capable, so using one as the read token gives up the read and write separation described above.
