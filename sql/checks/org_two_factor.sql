-- org_two_factor: the org requires two factor authentication. Only visible to org owners.
SELECT org, '*' AS repo, 'org_two_factor' AS check_id,
  CASE
    WHEN two_factor_requirement_enabled = 1 THEN 'pass'
    WHEN two_factor_requirement_enabled = 0 THEN 'fail'
    ELSE 'unknown'
  END AS status,
  json_object('two_factor_requirement_enabled', two_factor_requirement_enabled) AS evidence,
  'manual' AS remediation
FROM orgs
