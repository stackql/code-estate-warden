Add a `LICENSE` file at the root of the default branch containing the standard {{license}} license text, with `{{org}}` as the copyright holder and the current year.

## Acceptance criteria

- `LICENSE` exists at the root of the default branch of `{{org}}/{{repo}}` and GitHub detects it as {{license}}.
- No other file is changed.
- The `license_file` check passes on the next code-estate-warden run.
