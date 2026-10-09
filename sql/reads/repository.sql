SELECT full_name, archived, permissions, security_and_analysis
FROM github.repos.details WHERE owner = {{org}} AND repo = {{repo}}
