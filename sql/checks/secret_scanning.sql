-- secret_scanning: security_and_analysis.secret_scanning.status on the repo object. Null means the token is not an admin.
SELECT org, name AS repo, 'secret_scanning' AS check_id,
  CASE
    WHEN archived THEN 'na'
    WHEN json_extract(security_and_analysis, '$.secret_scanning.status') = 'enabled' THEN 'pass'
    WHEN json_extract(security_and_analysis, '$.secret_scanning.status') = 'disabled' THEN 'fail'
    ELSE 'unknown'
  END AS status,
  json_object('status', json_extract(security_and_analysis, '$.secret_scanning.status'), 'archived', archived) AS evidence,
  'setting' AS remediation
FROM repos
