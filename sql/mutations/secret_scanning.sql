UPDATE github.repos.repos
SET security_and_analysis = '{"secret_scanning":{"status":"enabled"}}'
WHERE owner = {{org}} AND repo = {{repo}}
