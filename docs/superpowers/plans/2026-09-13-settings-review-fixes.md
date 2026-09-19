# Settings branch review fixes

**Goal:** Repair the six findings from the local review of `38f740a...0411445`, preserve existing work, and push the branch to full CI with hosted reviews skipped.

**Authorization:** On September 13 the owner requested: "Commit untracked. Fix issues. Push to trigger ci tests with reviews skipped". This authorizes the local fixes, commits, branch push, and a pull request needed to run CI. The earlier no-push instruction is superseded for this batch. Merge and release are outside this request. Existing UI and permission contracts remain unchanged.

**Architecture:** Keep the existing JavaScript handlers, Postgres repositories, scoped listening ledger, and Last.fm receipt guard. Use an additive migration after 0072; never rewrite applied migration bytes. Restore existing behavior at its owning seam.

## Delivery scope

This is one corrective update to the already accumulated branch, following preservation checkpoint `247d63d`. It repairs the reviewed Settings/listening integration rather than adding unrelated features. The branch remains a review candidate; this checkpoint does not claim manual acceptance or authorize release.

| ID | Outcome and acceptance | Files/seams | Compatibility and rollback |
| --- | --- | --- | --- |
| RF1 | Retain measured history when a referenced track is deleted; deletion succeeds and history survives with a null reference | New 0073 migration; measured ledger tests | Retain existing SET NULL foreign keys and data. Roll forward; do not restore a constraint that invalidates retained history. |
| RF2 | Accepted measured listens increment both existing per-track playcount consumers; foreign scope and duplicate receipts do not inflate counts | Measured writer, history lookup, library browse query, migration backfill | Keep legacy families working; preserve stored rows and resolve current track identity. |
| RF3 | Explicit transient Last.fm rejection remains retryable; ambiguous network/delivery outcomes remain protected from duplicate submissions | lastfm_sync_bridge.py; provider receipt tests | Preserve the receipt lock and uncertain-delivery exclusion. |
| RF4 | More than 100 disconnected precedents cannot starve a connected account or its reconnect retry | History pending query and retry worker; account tests | Filter scope and credential eligibility before the limit; do not discard disconnected history. |
| RF5 | Arrow keys on Log History Period never invoke Problems controls | Settings delegated key handler and tests | Guard Problems handling by active tab; preserve normal Period activation. |
| RF6 | Expanding/collapsing a searched loop group preserves the filter | Loop navigation handler and tests | Use the same filtered collection as normal rendering; preserve playback DOM. |

## Execution and gates

- Preservation: 85 files committed in `247d63d` (six existing tracked edits and 79 mockup artifacts). Local restart scratch, brainstorm token/port/PID state, ignored server files, and a private machine-specific Foobar reference remain local and intact.
- Test author writes focused regressions; an independent verifier runs JavaScript and Python sequentially and records expected failures before implementation.
- Backend and frontend implementation follows the confirmed failures. Regenerate the runtime bundle after handler changes.
- Verifier provisions a unique local test database with the existing Windows bootstrap script. No production or shared fixture database mutation. All new database cases must execute rather than skip.
- Run focused tests for all six fixes and related seams, migration checks, bundle consistency, and diff checks. Full-suite execution belongs to CI.
- Independently review the corrective diff and reconcile findings before committing.
- Push the existing branch. Create a draft pull request with `skip_reviews`, verify `skip_tests` is absent, then mark ready so the native full pipeline starts with the waiver present. Do not claim skipped reviews as review coverage.
- Verify the CI run belongs to the pushed head and full test jobs start. Report its URL and observed status; no merge or release.

## Handoffs

- `ci_tests_review`: preservation commit, isolated verification environment, red/green test execution, and later commit/push handoff.
- `frontend_review`: regression test authoring, then independent corrective review.
- `backend_review`: production fixes after red evidence.
- Root: scope, reconciliation, progress, and final report. At most one pytest process; never overlap Python and JavaScript suites.

## Results

Pending implementation and focused verification. No checklist counters in the original feature plan were changed.
