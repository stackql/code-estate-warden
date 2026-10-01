---
name: remediate
description: Plan the remediation for every failing control across the organizations in code-estate-warden.toml, show the change set and what an apply would do. Changes nothing until the person confirms an apply.
user-invocable: true
argument-hint: "[org] - with nothing, every organization"
---

# Remediate the estate

Arguments: nothing means every organization in the allowlist. An organization name limits the plan to it.

1. If nothing has been evaluated in this session, call `evaluate` for the latest snapshot.
2. For each organization in scope that has failures, call `plan_brief` and follow it: `propose_change` once per group of repositories that need the same change, `get_findings` only where a decision depends on the details, then `finish_plan` for that organization.
3. Call `apply` with apply false. That is a dry run.
4. Show the result in this order:
   - The plan as a table: action, organization, control, change, repositories affected.
   - What the dry run would do: how many settings, issues and issues for the Copilot coding agent, and what is skipped and why.
   - What was left out of the plan and why.
5. Stop and ask what to apply. Suggest a narrow first step: one repository and one control.

A real apply happens only when the person asks for it in so many words and names what to apply. Pass that as the filter and never widen it. The apply asks for confirmation again, confirms each change by reading it back, and writes an audit row. Never apply the whole plan unasked.
