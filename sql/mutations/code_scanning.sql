UPDATE github.code_scanning.default_setup SET state = 'configured'
WHERE owner = {{org}} AND repo = {{repo}}
