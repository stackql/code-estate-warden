Protect the default branch of `{{org}}/{{repo}}` with branch protection or a ruleset. At minimum require a pull request before merging and block force pushes and deletions. The maintainers choose the exact rules.

## Acceptance criteria

- The default branch has an active branch protection rule or an active ruleset that targets it.
- The `default_branch_protected` check passes on the next repo-warden run.
