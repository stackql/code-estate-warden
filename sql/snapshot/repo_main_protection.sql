-- Classic main protection details. An unprotected branch returns 404 and has no row.
SELECT r.org, r.name AS repo, p.required_pull_request_reviews, p.enforce_admins
FROM github.repos.repos r
INNER JOIN github.repos.branch_protection p
  ON p.owner = r.org AND p.repo = r.name AND p.branch = 'main'
WHERE r.org = {{org}}
