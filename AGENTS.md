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
- Run focused tests locally for changed behavior. Use CI for the broader
  JavaScript and Python suites before proposing a release.
- Report security problems through the process in `SECURITY.md`.

## Release test execution

- During release and publish work, limit local execution to focused tests for
  behavior that changed or for specific failures being diagnosed and fixed.
- Push the branch and use CI to run every required complete suite and produce the
  authoritative full-suite failure inventory. Do not run complete release-suite
  inventories locally unless the owner explicitly requests a local full run.
- While the current head remains a merge candidate, let CI finish every required
  suite and collect all genuine failures before making fixes. Apply the
  superseded-run exception below when a validated review finding requires a new
  commit; otherwise stop early only when continuing would be unsafe or impossible.
- Fix the complete CI failure set, verify each fix with its focused local tests,
  then push and rerun all required CI suites. Repeat until CI is fully green.

## Review-first CI execution

- In the authoritative pull-request pipeline, classify review scope first and
  run applicable hosted reviews independently. Start test and E2E jobs only
  after every applicable reviewer succeeds. A failed, cancelled, missing, or
  unexpectedly skipped review holds tests; intentional skips are checked against
  the exact review scope and pull-request context. Collect all applicable review
  results, then the complete test failure inventory after reviews pass.
- If a hosted-review finding is validated against the code and requires another
  commit, preserve the review evidence and cancel that superseded run before
  expensive tests start. Verify its jobs have stopped, fix the finding, run
  focused local checks, and push to a new complete native pull-request pipeline.
  Review failures keep tests blocked while their cause is investigated. The
  replacement head still requires a successful full pipeline; a held or cancelled
  pipeline never records review coverage or authorizes merge or publication.
- Review only functional or E2E-relevant changes. Documentation-only changes
  skip hosted review. On a synchronize event with a valid successfully reviewed
  baseline, fewer than 250 changed functional lines uses incremental review;
  250 or more lines, a binary functional change, an unavailable baseline, or
  `ci:full-review` uses whole-PR review.
- Reproduce and verify failing cases locally, then push directly to the complete review-first CI pipeline. Use focused hosted tests only for unusually difficult failures or CI-specific infrastructure diagnosis; state the reason and return to full CI as soon as the focused failure is fixed. Keep native area tags and focused-selection tooling available. A focused result never authorizes merge or publication.
  If the focused exception is needed, follow the authenticated PR-head promotion procedure in the private E2E investigation workflow. Never use `workflow_dispatch` for hosted reviews or assume a `GITHUB_TOKEN` label write emits a new workflow event.
- Only a successful full pipeline may record review coverage, authorize merge,
  or authorize publication. Focused verification never weakens or replaces an
  existing E2E acceptance contract.

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
