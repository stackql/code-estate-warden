SELECT name, protected FROM github.repos.branch WHERE owner = {{org}} AND repo = {{repo}} AND branch = 'main'
