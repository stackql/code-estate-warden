-- license_file: the license field on the repo object. An unrecognised license file (key "other",
-- spdx NOASSERTION) still counts as present.
SELECT org, name AS repo, 'license_file' AS check_id,
  CASE
    WHEN archived THEN 'na'
    WHEN json_extract(license, '$.key') IS NOT NULL THEN 'pass'
    ELSE 'fail'
  END AS status,
  json_object('spdx_id', json_extract(license, '$.spdx_id'), 'private', private) AS evidence,
  'pr' AS remediation
FROM repos
