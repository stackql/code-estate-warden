-- dependabot_security_updates: security_and_analysis.dependabot_security_updates.status on the repo object. Null means the token is not an admin.
SELECT org, name AS repo, 'dependabot_security_updates' AS check_id,
  CASE
    WHEN archived THEN 'na'
    WHEN json_extract(security_and_analysis, '$.dependabot_security_updates.status') = 'enabled' THEN 'pass'
    WHEN json_extract(security_and_analysis, '$.dependabot_security_updates.status') = 'disabled' THEN 'fail'
    ELSE 'unknown'
  END AS status,
  json_object('status', json_extract(security_and_analysis, '$.dependabot_security_updates.status'), 'archived', archived) AS evidence,
  'setting' AS remediation
FROM repos
