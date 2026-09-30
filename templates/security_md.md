Add a `SECURITY.md` file at the root of the default branch with the content below. Adjust the contact details if the organization has a dedicated security contact.

````markdown
{{security_policy}}
````

## Acceptance criteria

- `SECURITY.md` exists at the root of the default branch of `{{org}}/{{repo}}`.
- It tells reporters how to report a vulnerability privately and what response to expect.
- The `security_md` check passes on the next repo-warden run.
