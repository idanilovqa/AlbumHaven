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

## Post-Migration Wave 2+ feature workflow

Every Wave 2 or later product feature must move through this sequence:

1. Read the roadmap item, its complete companion plan, the current implementation,
   and any technical documents triggered by the feature.
2. Ask the owner to approve the permission and capability model, deployment modes,
   and client-support matrix before treating those choices as settled.
3. Produce a technical design. For visible UI work, capture the current UI and
   prepare mockups.
4. Obtain owner approval for the technical design and each exact visual artifact.
5. Record functional cases and the automated-test proposal, then add failing unit
   or integration tests for the approved behavior.
6. Implement one complete vertical slice in React. If the slice first touches a
   legacy UI ownership boundary, migrate that whole boundary and remove its
   superseded live implementation.
7. Run focused verification and give the owner an exact manual test script or
   build.
8. Wait for the owner's manual acceptance.
9. Add the approved functional E2E coverage. Add performance E2E coverage only
   when the feature's required performance assessment identifies measurable risk,
   then run the required regression, review, and publish flow.

Each feature plan must classify web, Tauri, Android, TV, and Apple support as
`required`, `optional`, or `unsupported`. Leave feature-specific permission and
capability choices open until stage 2. Each planned or implemented action must
be added to the private owner registry at `docs/permissions-and-capabilities.md`
when that repository is available; ask the owner to approve its capabilities,
scope, reusable role-preset membership, deployment modes, and client constraints
before technical design approval. Never infer access from an existing screen or
tier name. All new post-migration UI uses React. When the private owner
repository is available, every visible post-migration surface must also map to
`docs/ui-component-system.md`. Reuse approved components and tokens. If the
catalog is insufficient, obtain owner approval for a reusable extension before
implementation instead of hardcoding a page-local button, menu, select, table,
bar, navigation element, panel, dialog, notification pattern, or visual token.
An independently complete slice may merge and publish before its feature family is
finished, but broken flows and partially exposed user journeys must not merge.

The private repository is not accepting external pull requests at this time.
See `CONTRIBUTING.md` for the current contribution policy.
