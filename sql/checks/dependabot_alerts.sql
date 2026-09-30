-- dependabot_alerts: the github provider has no SELECT for this state yet, only an EXEC that hides
-- the 204 or 404 answer (stackql-registry/stackql-provider-github#7). Unknown until it does.
SELECT org, name AS repo, 'dependabot_alerts' AS check_id,
  CASE WHEN archived THEN 'na' ELSE 'unknown' END AS status,
  json_object('reason', 'not collectable: check_vulnerability_alerts is EXEC only in the github provider') AS evidence,
  'setting' AS remediation
FROM repos
