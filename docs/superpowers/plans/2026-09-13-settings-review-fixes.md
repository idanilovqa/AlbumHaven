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

## September 19 remote-repair audit continuation

The owner requested review of all remote repairs, missing E2E coverage, fixes through a green full pipeline, and a local manual-test server on port 5001. Merge and release remain outside scope. The reviewed remote range is 177fb56..4995f3c; the shared ChatGPT conversation confirms publication but does not establish a green pipeline.

This corrective delivery retains RF1-RF6 and the approved current-stack UI. Prerequisites: complete remote audit and full CI failure inventory. Run 35450899991 at 4995f3c completed with four failures: Python concurrent temporary-directory ownership, saved-loop boundary interception, integration root-save scan completion, and synthetic artist-family unselection stability.

Acceptance cases:
- RF2: deleted measured-track history cannot count toward a replacement identity; legacy aliases still count consistently in both consumers.
- RF4: deleted or renamed pending sources cannot poison valid retries; retained history and provider receipt protection survive, and new client submissions retain source validation.
- RF5: Problems-to-Logs navigation preserves the shared filter icon; Logs directional keys never invoke Problems filtering; Period activation works.
- RF6: expanding and collapsing a searched loop group preserves the filter and playback state.
- CI repairs: reproduce each of the four failed contracts and fix its responsible product or proven harness seam without weakening assertions or limits.

Compatibility and rollback: preserve database history and existing public behavior; no schema rewrite, runtime fixture shortcuts, or new persistence mechanism. Revert corrective code if necessary while retaining existing migration history. Add tests at the existing seams and extend current E2E cases. Separate test-author, implementation, verification, review, and commit/push handoffs. Run one Python test process at a time and no concurrent JavaScript/Python waves. Use focused local checks, then the full native PR pipeline with skip_reviews and without skip_tests. The checkpoint is a committed, pushed, fully green candidate; only then start the normal local app on 5001 for owner testing.

### Audit evidence and focused verification

- Shared conversation read through the rendered page; remote publication claims were checked against Git and the completed native pipeline, not treated as a green result.
- Confirmed additional defects: orphan measured-history key reuse, stale measured-retry source validation, destructive shared filter-button text replacement, redundant watcher-health DOM mutation, and a native loop action helper that never left the expanded control covering the handle.
- Regression-first backend check after existing migration 0073: 3 failed / 1 passed. Corrective focused check: 11 passed. Exact Python harness case passed locally; its complete focused file passed 18 tests. Its assertion now reports ownership evidence without changing the predicate; the CI-only ownership failure remains unproven locally.
- Watcher DOM regression reproduced before the fix. Corrected focused JavaScript checks: 223 passed. Runtime bundle, production parity, syntax, and diff checks passed.
- Real Postgres-backed E2E: FTC-SETTINGS-S02, original saved-loop composite, and FTC-SETTINGS-L02 passed with unchanged limits. Added S02/L02 assertions cover the RF5/RF6 transitions and continuity. Owned app/provider processes, ports, databases, and roles were cleaned up after each completed wave.
- Synthetic NAV026 investigation narrowed the actual mismatch to libraryLoaderMutationCount=3 rather than zero; other card/family fields printed by ObjectContaining were not failed expectations. The watcher helper now avoids same-value writes while retaining warning and recovery transitions. Focused browser verification is pending.
- I01 trace showed scan complete (1090/1090, scan_in_progress=false, relations_in_progress=false). The watcher warning appeared when a watched root became unavailable and intercepted Save; the final cleanup wait masked that click failure. Its existing warning dismissal occurs after Save. Exact reorder approval was requested under the protected E2E-flow rule; I01 remains unchanged pending the owner response.
- Temporary repair workflows have no demonstrated merge-gate bypass. Their token-generated pushes may suppress native pipeline events; this corrective delivery will use a normal authenticated push. Stale diagnostic automation was not removed as unrelated cleanup.

No full local suite, merge, or release was performed. The final native full pipeline and port-5001 manual-test startup remain pending.

### Focused gallery completion

FTC-SEARCH-NAV-026 passed 1/1 in the real browser, including unselection with zero loader mutations and no default-gallery request. The outer performance-target wrapper exited 1 because the exact regression selection excluded the target's metric-producing scenario (reporter-finalization classification: processStatus=0, no target report, metricsComplete=false); this is not recorded as a complete performance-target pass. The original browser regression is proven locally; full target metrics remain for the complete native CI pipeline. Its owned application/provider processes, ports 57564/57566, database, and roles were cleaned up. The final diff reconciliation found no further actionable issue in the corrective code. I01 remains unchanged pending the exact test-order approval.
