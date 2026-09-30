-- private_vuln_reporting: GitHub only answers for public, non archived repos (422 otherwise),
-- so an absent row on a private repo is na and on a public repo is unknown.
SELECT r.org, r.name AS repo, 'private_vuln_reporting' AS check_id,
  CASE
    WHEN r.archived THEN 'na'
    WHEN p.enabled = 1 THEN 'pass'
    WHEN p.enabled = 0 THEN 'fail'
    WHEN r.private THEN 'na'
    ELSE 'unknown'
  END AS status,
  json_object('enabled', p.enabled, 'private', r.private) AS evidence,
  'setting' AS remediation
FROM repos r
LEFT JOIN repo_private_vulnerability_reporting p ON p.org = r.org AND p.repo = r.name
