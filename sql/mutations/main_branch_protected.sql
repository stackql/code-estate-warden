REPLACE INTO github.repos.branch_protection
(owner, repo, branch, enforce_admins, required_pull_request_reviews, required_status_checks, restrictions{{extra_columns}})
SELECT {{org}}, {{repo}}, 'main', {{enforce_admins}}, {{reviews}}, {{checks}}, {{restrictions}}{{extra_values}}
