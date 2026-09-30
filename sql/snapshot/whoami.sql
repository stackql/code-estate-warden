-- Identity of the read token, recorded with the run.
CREATE MATERIALIZED VIEW whoami AS
SELECT login, id, type
FROM github.users.users
