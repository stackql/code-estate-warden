-- Every Actions workflow in every repo, used to spot a CodeQL workflow.
CREATE MATERIALIZED VIEW repo_workflows AS
SELECT r.org, r.name AS repo, w.name, w.path, w.state
FROM github.repos.repos r
INNER JOIN github.actions.workflows w
  ON w.owner = r.org AND w.repo = r.name
WHERE r.org IN ({{orgs}})
