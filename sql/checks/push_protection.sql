-- push_protection: security_and_analysis.secret_scanning_push_protection.status on the repo object. Null means the token is not an admin.
SELECT org, name AS repo, 'push_protection' AS check_id,
  CASE
    WHEN archived THEN 'na'
    WHEN json_extract(security_and_analysis, '$.secret_scanning_push_protection.status') = 'enabled' THEN 'pass'
    WHEN json_extract(security_and_analysis, '$.secret_scanning_push_protection.status') = 'disabled' THEN 'fail'
    ELSE 'unknown'
  END AS status,
  json_object('status', json_extract(security_and_analysis, '$.secret_scanning_push_protection.status'), 'archived', archived) AS evidence,
  'setting' AS remediation
FROM repos
