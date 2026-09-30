-- Active rules from rulesets (repo or org level) that apply to the default branch, one row per rule.
SELECT r.org, r.name AS repo, x.type, x.ruleset_id, x.ruleset_source_type, x.ruleset_source, x.parameters
FROM github.repos.repos r
INNER JOIN github.repos.rules x
  ON x.owner = r.org AND x.repo = r.name AND x.branch = r.default_branch
WHERE r.org = {{org}}
