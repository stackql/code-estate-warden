-- dependabot_security_updates: dedicated automated-security-fixes endpoint. Older snapshots
-- may contain the former security_and_analysis field, used only when endpoint evidence is absent.
SELECT r.org, r.name AS repo, 'dependabot_security_updates' AS check_id,
  CASE
    WHEN r.archived THEN 'na'
    WHEN s.enabled = 1 AND s.paused = 0 THEN 'pass'
    WHEN s.enabled = 0 OR s.paused = 1 THEN 'fail'
    WHEN s.repo IS NULL AND json_extract(security_and_analysis, '$.dependabot_security_updates.status') = 'enabled' THEN 'pass'
    WHEN s.repo IS NULL AND json_extract(security_and_analysis, '$.dependabot_security_updates.status') = 'disabled' THEN 'fail'
    ELSE 'unknown'
  END AS status,
  json_object('enabled', s.enabled, 'paused', s.paused,
    'status', json_extract(security_and_analysis, '$.dependabot_security_updates.status'), 'archived', archived) AS evidence,
  'setting' AS remediation
FROM repos r
LEFT JOIN repo_security_fixes s ON s.org = r.org AND s.repo = r.name
