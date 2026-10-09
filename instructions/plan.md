Plan the remediation for the organization {{org}} from run {{run_id}}.

Failing checks in {{org}}, active repositories only, with the number of repositories failing each:

{{summary}}

Organization security configurations present:

{{configurations}}

The policy's remediation preferences:

{{policy}}

How to propose:

- Call propose_change once per group of repositories that need the same change. Use get_findings only where a decision depends on the details.
- For a core control that most repositories fail (secret scanning, push protection, Dependabot alerts, Dependabot security updates, code scanning default setup, private vulnerability reporting) make one organization level proposal: repos ["*"], action "setting", target "organization security configuration", and say in `after` which control it enables. For the exceptions, or when only a few repositories fail, propose action "setting" per repository.
- For license_file propose action "pr" with target "LICENSE"; for security_md action "pr" with target "SECURITY.md". List every failing repository in one proposal per check.
- For default_branch_protected propose action "issue" with target "branch protection or ruleset" for every failing repository in one proposal.
- For main_branch_protected propose action "setting" with target "main branch protection": require a pull request with at least one approval, no new required CI checks, and administrator bypass for newly protected branches. Existing stronger protection, including admin enforcement and required CI, is preserved.
- Scope: {{scope}}. Only propose changes for the findings in this evaluation. For a single repository, name it explicitly and never use repos ["*"].
- For org_two_factor propose action "manual" with repos ["*"].
- Do not propose anything for checks whose status is unknown or na.

When done, reply with a summary of what you proposed and anything you left out and why.
