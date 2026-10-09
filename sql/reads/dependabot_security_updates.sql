SELECT enabled, paused FROM github.repos.security_fixes WHERE owner = {{org}} AND repo = {{repo}}
