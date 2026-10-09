-- main_branch_protected: main requires a pull request and at least one approval.
-- Existing stronger restrictions remain intact. Missing or inaccessible main is unknown.
SELECT r.org, r.name AS repo, 'main_branch_protected' AS check_id,
  CASE
    WHEN r.archived THEN 'na'
    WHEN b.branch IS NULL THEN 'unknown'
    WHEN json_extract(p.required_pull_request_reviews, '$.required_approving_review_count') >= 1
      OR x.approvals >= 1 THEN 'pass'
    WHEN b.protected = 1 AND p.repo IS NULL AND x.approvals IS NULL THEN 'unknown'
    ELSE 'fail'
  END AS status,
  json_object('branch', b.branch, 'protected', b.protected,
    'required_pull_request_reviews', json(p.required_pull_request_reviews),
    'enforce_admins', json(p.enforce_admins), 'ruleset_approvals', x.approvals) AS evidence,
  'setting' AS remediation
FROM repos r
LEFT JOIN repo_main_branch b ON b.org = r.org AND b.repo = r.name
LEFT JOIN repo_main_protection p ON p.org = r.org AND p.repo = r.name
LEFT JOIN (
  SELECT org, repo, max(json_extract(parameters, '$.required_approving_review_count')) AS approvals
  FROM repo_main_rules WHERE type = 'pull_request' GROUP BY org, repo
) x ON x.org = r.org AND x.repo = r.name
