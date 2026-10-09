-- Dependabot automatic security updates, using the dedicated endpoint rather than repo metadata.
SELECT r.org, r.name AS repo, s.enabled, s.paused
FROM github.repos.repos r
INNER JOIN github.repos.security_fixes s
  ON s.owner = r.org AND s.repo = r.name
WHERE r.org = {{org}}
