-- dependabot_alerts: 204 means enabled. A 404 means disabled only with confirmed repo admin
-- permission; otherwise it is unknown. The HTTP read is a narrow provider limitation exception.
SELECT r.org, r.name AS repo, 'dependabot_alerts' AS check_id,
  CASE WHEN r.archived THEN 'na' WHEN a.enabled = 1 THEN 'pass'
    WHEN a.enabled = 0 THEN 'fail' ELSE 'unknown' END AS status,
  json_object('enabled', a.enabled, 'http_status', a.http_status,
    'reason', coalesce(a.reason, CASE WHEN a.repo IS NULL THEN 'not collected in this snapshot' END)) AS evidence,
  'setting' AS remediation
FROM repos r
LEFT JOIN repo_dependabot_alerts a ON a.org = r.org AND a.repo = r.name
