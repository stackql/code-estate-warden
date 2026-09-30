-- Every repo in every org in scope. security_and_analysis is null when the token is not an admin.
SELECT org, name, full_name, archived, disabled, fork, private, visibility, default_branch,
  license, security_and_analysis, permissions, pushed_at, updated_at
FROM github.repos.repos
WHERE org = {{org}}
