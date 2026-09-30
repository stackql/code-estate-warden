-- Code scanning default setup state per repo: configured or not-configured.
CREATE MATERIALIZED VIEW repo_code_scanning_default_setup AS
SELECT r.org, r.name AS repo, d.state, d.languages, d.query_suite, d.updated_at
FROM github.repos.repos r
INNER JOIN github.code_scanning.default_setup d
  ON d.owner = r.org AND d.repo = r.name
WHERE r.org IN ({{orgs}})
