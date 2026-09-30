-- Org settings. two_factor_requirement_enabled is only returned to org owners.
SELECT org, login, id, plan, two_factor_requirement_enabled, default_repository_permission,
  advanced_security_enabled_for_new_repositories, secret_scanning_enabled_for_new_repositories,
  secret_scanning_push_protection_enabled_for_new_repositories,
  dependabot_alerts_enabled_for_new_repositories, dependabot_security_updates_enabled_for_new_repositories
FROM github.orgs.orgs
WHERE org = {{org}}
