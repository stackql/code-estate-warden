-- code_scanning: default setup configured, or an active CodeQL workflow. Missing setup evidence
-- is unknown, including private repos where permissions or licensing may hide the setting.
SELECT r.org, r.name AS repo, 'code_scanning' AS check_id,
  CASE
    WHEN r.archived THEN 'na'
    WHEN d.state = 'configured' THEN 'pass'
    WHEN w.path IS NOT NULL THEN 'pass'
    WHEN d.state IS NULL THEN 'unknown'
    ELSE 'fail'
  END AS status,
  json_object('default_setup', d.state, 'codeql_workflow', w.path, 'private', r.private) AS evidence,
  'setting' AS remediation
FROM repos r
LEFT JOIN repo_code_scanning_default_setup d ON d.org = r.org AND d.repo = r.name
LEFT JOIN (
  SELECT org, repo, min(path) AS path FROM repo_workflows
  WHERE state = 'active' AND lower(path) LIKE '%codeql%' GROUP BY org, repo
) w ON w.org = r.org AND w.repo = r.name
