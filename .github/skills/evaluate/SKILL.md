---
name: evaluate
description: Evaluate the security posture of every repository in every organization in code-estate-warden.toml and show the results as tables. Use when asked to evaluate, audit or report on the GitHub estate.
user-invocable: true
argument-hint: "[latest | run id] - with nothing, a fresh snapshot is taken first"
---

# Evaluate the estate

Arguments: nothing means take a fresh snapshot first. `latest` means the newest snapshot already in runs/. Anything else is a run id.

1. With no argument, call `snapshot` and wait for it. It reads every organization with StackQL and takes about two minutes for 250 repositories. With `latest` or a run id, skip this step.
2. Call `evaluate`, with the run id if one was given.
3. Show the result in this order:
   - One line: the run id, when it was observed, how many repositories in how many organizations.
   - The `inventory` as a table: organization, repositories, archived, private, forks.
   - The `table` exactly as returned. Do not recompute, reorder or round it. Repeat its legend under it.
   - "What stands out": at most five bullets, worst first by severity and by how many repositories fail. Name the control and the count. Say which controls are unknown, and that unknown means the token could not see the setting, not that it fails.
   - Drift: what newly fails and what newly passes since the previous run, or that nothing changed.
4. End with one line: `/remediate` plans the fixes, and nothing is changed until an apply is confirmed.

Call no other tool unless a follow-up question needs one.
