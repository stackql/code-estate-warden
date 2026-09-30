-- default_branch_protected: classic branch protection on the default branch, or any active rule
-- from a ruleset (repo or org level) that targets it. Either satisfies. No default branch is na.
SELECT r.org, r.name AS repo, 'default_branch_protected' AS check_id,
  CASE
    WHEN r.archived THEN 'na'
    WHEN b.branch IS NULL THEN 'na'
    WHEN b.protected = 1 OR x.rules IS NOT NULL THEN 'pass'
    ELSE 'fail'
  END AS status,
  json_object('branch', b.branch, 'protected', b.protected, 'rules', json(x.rules)) AS evidence,
  'setting' AS remediation
FROM repos r
LEFT JOIN repo_default_branch b ON b.org = r.org AND b.repo = r.name
LEFT JOIN (
  SELECT org, repo, json_group_array(type) AS rules FROM repo_branch_rules GROUP BY org, repo
) x ON x.org = r.org AND x.repo = r.name
