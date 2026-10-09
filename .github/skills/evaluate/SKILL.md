---
name: evaluate
description: Evaluate security posture for a GitHub repository, organization or all organizations in code-estate-warden.toml. Use when asked to test, evaluate, audit or report on core five controls and SECURITY.md or the full estate.
user-invocable: true
argument-hint: "[org | org/repo | GitHub URL] [core] [latest | run id]"
---

# Evaluate the estate

Arguments: nothing means take a fresh snapshot first. `latest` means the newest snapshot already in runs/. A run id selects that snapshot. An organization, org/repo or https://github.com/org/repo narrows the scope. `core` selects the core five plus SECURITY.md.

1. Unless `latest` or a run id was supplied, call `snapshot` with `org` or `repo` when supplied, and `core: true` for the core preset. Wait for it. Do not inventory unrelated organizations for a targeted request.
2. Call `evaluate` with the same scope and the new run id (or the requested run id). If a repository is absent from an old snapshot, take a new scoped snapshot instead.
3. Show the result in this order:
   - One line: the run id, when it was observed, how many repositories in how many organizations.
   - The `inventory` as a table: organization, repositories, archived, private, forks.
   - The `table` exactly as returned. Do not recompute, reorder or round it. Repeat its legend under it.
   - "What stands out": at most five bullets, worst first by severity and by how many repositories fail. Name the control and the count. Say which controls are unknown, and that unknown means the token could not see the setting, not that it fails.
   - Drift: what newly fails and what newly passes since the previous run, or that nothing changed.
4. End with one line: `/remediate` plans the fixes, and nothing is changed until an apply is confirmed.

Call no other tool unless a follow-up question needs one.
