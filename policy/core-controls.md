# Core controls

The baseline policy for every organization in scope. It follows the GitHub Secure Open Source Fund core controls and adds a license and a security policy file for every open source repository.

## Checks in scope

Repository level, every active repository:

- secret_scanning
- push_protection
- dependabot_alerts
- dependabot_security_updates
- code_scanning
- private_vuln_reporting
- default_branch_protected
- main_branch_protected
- security_md

Repository level, public repositories only:

- license_file

Organization level:

- org_two_factor
- org_security_configuration

## Exemptions

- Archived repositories are out of scope for every check.
- Private and internal repositories are exempt from license_file.
- Forks are exempt from license_file. The upstream owns that file.
- Repositories listed under exclude_repos in code-estate-warden.toml are exempt from every check.

## Remediation preferences

- When most active repositories in an organization fail the same core control (secret scanning, push protection, Dependabot alerts, Dependabot security updates, code scanning default setup, private vulnerability reporting), prefer one change to an organization security configuration that enables the control and applies it to the affected repositories. Per repository settings are the fallback for the exceptions.
- A missing LICENSE or SECURITY.md is fixed with a pull request. Raise an issue in the repository that the Copilot coding agent can take: state the file, the content to add, and the acceptance criteria.
- Default branch protection is proposed as an issue for the maintainers. The choice of rules is theirs.
- The core five preset uses main_branch_protected instead: only main, pull requests with at least one approval, administrator bypass for new protection, no new required CI checks. Preserve all existing stronger restrictions rather than weakening them. Repositories without an accessible main are unknown and are not changed automatically.
- The core five are secret scanning, code scanning, main protection, private vulnerability reporting, and Dependabot (both alerts and automatic security-update PRs). Include SECURITY.md for every active repository. Scheduled dependency-version updates are not part of this preset.
- Requiring two factor authentication is a manual change for organization owners.
- Never disable a control. Never touch an archived repository. Never touch a repository outside the organization allowlist.
