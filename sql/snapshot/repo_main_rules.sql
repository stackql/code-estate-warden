-- Active ruleset rules applying to main, including inherited organization rules.
SELECT r.org, r.name AS repo, x.type, x.parameters
FROM github.repos.repos r
INNER JOIN github.repos.rules x
  ON x.owner = r.org AND x.repo = r.name AND x.branch = 'main'
WHERE r.org = {{org}}
