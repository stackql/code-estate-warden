SELECT required_pull_request_reviews, required_status_checks, restrictions, enforce_admins,
  required_linear_history, allow_force_pushes, allow_deletions, block_creations,
  required_conversation_resolution, lock_branch, allow_fork_syncing
FROM github.repos.branch_protection WHERE owner = {{org}} AND repo = {{repo}} AND branch = 'main'
