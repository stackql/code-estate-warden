-- org_security_configuration: the org has a security configuration of its own or enforces one.
-- Every org carries the unenforced global "GitHub recommended" configuration, which alone is a fail.
SELECT o.org, '*' AS repo, 'org_security_configuration' AS check_id,
  CASE
    WHEN c.own > 0 THEN 'pass'
    WHEN c.own IS NULL THEN 'unknown'
    ELSE 'fail'
  END AS status,
  json_object('configurations', json(c.items)) AS evidence,
  'setting' AS remediation
FROM orgs o
LEFT JOIN (
  SELECT org,
    sum(target_type = 'organization' OR enforcement = 'enforced') AS own,
    json_group_array(json_object('name', name, 'target_type', target_type, 'enforcement', enforcement)) AS items
  FROM org_security_configurations GROUP BY org
) c ON c.org = o.org
