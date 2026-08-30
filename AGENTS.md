# Contributor guidance

## Private owner context

Owner workflows live in a separate private repository. If
`ALBUM_HAVEN_INTERNAL_REPO` names a readable checkout, read its `AGENTS.md`.
Otherwise, check `../album-haven-internal/AGENTS.md`. External contributors do
not need the private repository to build or use Album Haven.

## Application repository rules

- Keep runtime persistence Postgres-backed. Do not add file or JSON persistence
  fallbacks for app-owned data.
- Do not expose local music paths, raw media, database credentials, tokens, or
  private fixture assets.
- Use environment variables for machine-specific paths and credentials.
- Keep tests independent and give state-mutating tests uniquely owned data.
- Run focused tests for changed behavior. Run the broader JavaScript and Python
  suites before proposing a release.
- Report security problems through the process in `SECURITY.md`.

The private repository is not accepting external pull requests at this time.
See `CONTRIBUTING.md` for the current contribution policy.
