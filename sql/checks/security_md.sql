-- security_md: SECURITY.md at the repo root, else the org .github repo's SECURITY.md is inherited.
SELECT r.org, r.name AS repo, 'security_md' AS check_id,
  CASE
    WHEN r.archived THEN 'na'
    WHEN s.path IS NOT NULL OR o.path IS NOT NULL THEN 'pass'
    ELSE 'fail'
  END AS status,
  json_object(
    'path', s.path,
    'inherited_from', CASE WHEN s.path IS NULL AND o.path IS NOT NULL THEN r.org || '/.github' END,
    'private', r.private
  ) AS evidence,
  'pr' AS remediation
FROM repos r
LEFT JOIN repo_security_md s ON s.org = r.org AND s.repo = r.name
LEFT JOIN repo_security_md o ON o.org = r.org AND o.repo = '.github' AND r.name <> '.github'
