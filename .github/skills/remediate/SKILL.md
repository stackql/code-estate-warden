---
name: remediate
description: Plan fixes for a GitHub repository, organization or all configured organizations, including core five controls and SECURITY.md. Use when asked to remediate or fix control gaps. Changes nothing until the person confirms an apply.
user-invocable: true
argument-hint: "[org | org/repo | GitHub URL] [core]"
---

# Remediate the estate

Arguments: nothing means every organization in the allowlist. An organization name, org/repo or GitHub URL narrows the plan. `core` selects the core five plus SECURITY.md.

1. Call `evaluate` with the requested `org` or `repo` and `core: true` for the core preset, even if there was an earlier broader evaluation. If no usable snapshot exists, call `snapshot` with the same scope first.
2. For each organization in scope that has failures, call `plan_brief` and follow it: `propose_change` once per group of repositories that need the same change, `get_findings` only where a decision depends on the details, then `finish_plan` for that organization.
3. Call `apply` with apply false. That is a dry run.
4. Show the result in this order:
   - The plan as a table: action, organization, control, change, repositories affected.
   - What the dry run would do: how many settings, issues and issues for the Copilot coding agent, and what is skipped and why.
   - What was left out of the plan and why.
5. Stop and ask what to apply. Suggest a narrow first step: one repository and one control.

A real apply happens only when the person asks for it in so many words and names what to apply. Pass that as the filter and never widen it. The apply asks for confirmation again, confirms each change by reading it back, and writes an audit row. Never apply the whole plan unasked.

For a repository or organization request, also pass the exact `repo` or `org` to apply, not just a substring filter. Never propose organization-wide changes for a repository-scoped evaluation. SECURITY.md is an issue with file content and acceptance criteria; assign it to the coding agent only when asked.
