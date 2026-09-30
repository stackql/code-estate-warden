-- Repos with a SECURITY.md at the root. The org .github repo appears here like any other repo.
CREATE MATERIALIZED VIEW repo_security_md AS
SELECT r.org, r.name AS repo, c.path, c.size, c.sha
FROM github.repos.repos r
INNER JOIN github.repos.content_tree c
  ON c.owner = r.org AND c.repo = r.name
WHERE r.org IN ({{orgs}}) AND c.path = 'SECURITY.md'
