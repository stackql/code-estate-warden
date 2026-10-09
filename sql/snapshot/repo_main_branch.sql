-- The main branch only, independent of the repository's default branch.
SELECT r.org, r.name AS repo, b.name AS branch, b.protected
FROM github.repos.repos r
INNER JOIN github.repos.branch b
  ON b.owner = r.org AND b.repo = r.name AND b.branch = 'main'
WHERE r.org = {{org}}
