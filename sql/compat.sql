-- Old snapshots and fixtures lack these sources. Empty temp tables expose missing evidence
-- as unknown. Never shadow a collected source in main.
CREATE TEMP TABLE IF NOT EXISTS repo_dependabot_alerts (org, repo, enabled, http_status, reason);
CREATE TEMP TABLE IF NOT EXISTS repo_security_fixes (org, repo, enabled, paused);
CREATE TEMP TABLE IF NOT EXISTS repo_main_branch (org, repo, branch, protected);
CREATE TEMP TABLE IF NOT EXISTS repo_main_protection (org, repo, required_pull_request_reviews, enforce_admins);
CREATE TEMP TABLE IF NOT EXISTS repo_main_rules (org, repo, type, parameters);
