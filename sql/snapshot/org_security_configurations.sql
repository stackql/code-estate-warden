-- Org security configurations (GitHub recommended plus custom), one row per configuration.
CREATE MATERIALIZED VIEW org_security_configurations AS
SELECT org, id, name, target_type, enforcement, secret_scanning, secret_scanning_push_protection,
  dependabot_alerts, dependabot_security_updates, code_scanning_default_setup, private_vulnerability_reporting
FROM github.code_security.code_security_configurations
WHERE org IN ({{orgs}})
