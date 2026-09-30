-- The default branch of each repo with its classic branch protection. Absent for empty repos.
CREATE MATERIALIZED VIEW repo_default_branch AS
SELECT r.org, r.name AS repo, b.name AS branch, b.protected, b.protection
FROM github.repos.repos r
INNER JOIN github.repos.branch b
  ON b.owner = r.org AND b.repo = r.name AND b.branch = r.default_branch
WHERE r.org IN ({{orgs}})
