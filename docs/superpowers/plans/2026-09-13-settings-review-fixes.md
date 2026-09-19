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

### Second full-branch pass and CI-only verification override

The owner subsequently instructed: finish actual code changes and review, then push and let CI run the tests; do not continue local test/browser runs. All prior local runners have exited. Subsequent regression tests will be authored but not executed locally; runtime bundle generation and read-only diff review remain implementation work.

The new local review guidance requires at least two complete passes. The second pass covers the full branch from 38f740a4e984a25c0d501a7a2166d6ccdc09dcf3, including the remote repairs and checkpoint e085e0b. It confirmed a Log History date-boundary defect: selecting 2026-09-06 in America/Santiago throws because local midnight is skipped by DST. The direct reproduction preceded the owner's CI-only override.

Corrective acceptance: use the first valid instant of the selected local calendar day, the earliest boundary for repeated midnight, and the next local day as the exclusive end. Preserve the existing query shape, timezone selection, and retained controller state. Add regression cases for skipped/repeated boundaries and a normal-UI browser case in the affected timezone; no new dependency or public API is required. Complete a third full review after the correction, then commit/push to the complete native CI pipeline with skip_reviews. The I01 flow-order decision remains separately pending.

### Third-pass completion and CI handoff

Third full backend/schema, frontend/E2E, and CI/harness reviews are complete against the full branch base plus all corrections. The remaining executable functional-total guard was reconciled to 114; the new H04 case preserves existing ownership and produces 114 functional, 68 component, and 26 performance cases (208 total). No further actionable finding remains in the corrected code. The new DST tests and implementation have not been run locally, per the owner's CI-only instruction.

Push this corrective candidate through the native complete pipeline with skip_reviews and without skip_tests. I01 remains unchanged while its exact warning-dismissal reorder awaits approval; collect the complete CI result, including that known unresolved scenario. Do not start the port-5001 manual-test app until all required CI is green. The old isolated Python database remains idle after automatic approval review rejected teardown; its state and logs were preserved without bypassing the rejection.


### Owner-directed floating notification collision avoidance

The owner superseded the proposed I01 dismissal reorder and subsequent fixed-spacing alternatives: no floating alert may cover an actionable item; calculate its preferred position and shift it when it would cover Save or another active control. The shared notification owner now places watcher warnings, transient toasts, and repair alerts. In-flow OnPageAlert consumers keep their existing layout. Watcher warnings prefer the viewport's bottom-right corner (12px bottom, 16px right); other alerts retain their existing preferred origins.

Placement considers enabled visible native/semantic controls, keyboard-focusable controls and scroll surfaces, and the existing pointer-driven loop-range surface. Hit testing excludes controls occluded by foreground layers. The nearest available rectangle leaves an 8px gap from those controls and other placed notifications. Width is constrained to the visual viewport before geometry is read, including pinch zoom; narrow watcher alerts wrap their existing content and actions without removing them. Viewport, content, resize, scroll, resource-load, font-load, and completed animation/transition events trigger coalesced placement updates without polling. Notification removal disconnects owned listeners and observers when none remain.

If no complete unobstructed rectangle fits, the notification is deferred until a relevant layout change creates space. Transient expiry starts on first display. After that first display, the existing wall-clock expiry remains in force even if a later layout change temporarily defers it; this correction does not introduce a new timer lifecycle. Persistent watcher warnings retain their existing dismissal/recovery lifecycle. No pointer-event pass-through conceals an overlap.

I01 retains Save → read saved settings → Dismiss. Added assertions require the whole warning rectangle to be separate from Save and require both Save and Dismiss to own their real pointer hit targets. Unit coverage addresses preferred placement, multiple obstacles, no-space deferral, foreground hit ownership, loop gesture coverage, visual-viewport host sizing, and observer cleanup. These additions are authored but unexecuted locally under the owner's CI-only instruction. The complete native CI pipeline remains the verification gate.

### Complete CI inventory: run 35460373127

Native run https://github.com/idanilovqa/AlbumHaven/actions/runs/35460373127 at head 4d8beb3feedc08b7e4a540cc502a7bce7f95120e completed with failure. Both JavaScript jobs failed only the explicit playback wave-one expectation missing H04 (portable: 3294 passed, 1 failed, 5 skipped; Windows: 3299 passed, 1 failed). Add H04 without changing shard ownership. Playback/utilities failed H04 because fill targets a readonly date input, and FTC-APPEARANCE-001 because the Neal Morse information heading never appeared after native click. Cloud verification failed consequently. Every other required job passed, including Python (5720 passed, 4 skipped), all performance jobs, the exact concurrent Python harness case, I01 unchanged (30.2 seconds), and L02 (28.3 seconds).

Evidence retained under .tmp/remote-audit: playback job log, debug artifact 10590896589, blob artifact 10590766644. Appearance trace confirms the information overlay stayed empty and hidden after click; no page error or contemporaneous view-data request supports network hydration as its cause. Investigate the local render/gesture boundary before asserting a cause.

The subsequent owner decision requires the shared collision-aware notification placement documented above; the presentation question is resolved. Do not reorder I01. Repair H04 through real date-picker controls. No further local test/browser execution under the CI-only override. Review the coherent repair batch, then run complete native CI with skip_reviews and without skip_tests. Preserve owner AGENTS.md edits outside corrective commits.

Appearance follow-up: source review confirms the pointer-gesture render guard covered album cards but omitted the actual family-header artist-information button. Extend only its existing selector to that control. Add an unexecuted unit regression for forced render during pointerdown, retention through pointerup/click, and deferred render release. Preserve the appearance E2E sequence and assertions. This repairs a confirmed static guard gap; the exact scheduled callback in the CI trace remains unproven. Two corrective-diff reviews completed; no local tests executed.


### CI lifecycle evidence: run 35465988104

Full native run 35465988104 at a1c7e463b9f9e6d617fc940bc7a0ed5747ce4a83 passed every test assertion, including H04, appearance, and I01. Playback emitted 34 tests-complete signals but only 33 run-final signals. The final I01 test passed in 40.7 seconds; its wrapper then failed finalization-timeout with wrapper-child-lifecycle-mismatch. All other suites passed. Scoped logs, artifact manifest, blob artifact, and inventory are retained under .tmp/remote-audit/run-35465988104*. The exact blocking lifecycle operation remains unknown.

Add evidence collection at the existing finalization deadline before terminating the owned child: a process-tree snapshot bounded to five seconds and the existing 256-process maximum; PID, parent PID, allowlisted executable/role, identity-aware liveness, completion phase and elapsed time. Emit structured stderr and preserve it in combinedOutput even without a Playwright output directory. Never emit command lines, environment values, private paths, raw unknown executable names, or process creation identities. Preserve finalization deadlines, cleanup, and failure semantics. This is instrumentation, not a claimed lifecycle fix. Extend the existing deadline regression for diagnostic-before-kill ordering, PID replacement, safe redaction, and snapshot failure that still kills/fails. Two static corrective reviews completed; no local tests executed under the CI-only override.


### Terminal CI inventory and playback timing: run 35469862760

Full native run 35469862760 at 7b8c273fbb9b911e43404f18f8e9029d07fce72a completed with only two genuine failing JavaScript cases on each platform: the parameterized finalization regression with snapshotFailure false and true. Its shared test wrapper supplied a processObject without pid, so diagnostic parentPid was omitted despite the expected process.pid. Supply an explicit realistic processObject only in these variants; preserve the parent-PID assertion and production code. Windows: 3305 passed, 2 failed. Portable: 3300 passed, 2 failed, 5 skipped. Cloud Gate failure is consequential. Every other suite passed, including playback job 105968783481. The earlier finalization failure did not recur; this does not prove its unknown cause fixed.

The requested playback timing audit found a 55m43s functional step, approximately 16m39s of test execution, 34 wrapper invocations, and 32m09s of inter-test gaps. These measurements overlap and must not be added as independent costs. Read-only cases are already batched; retain mutation isolation rather than combining conflicting tests. No broader timing instrumentation or execution changes are included in this correction. Two static reviews completed; no local tests or browser runs under the CI-only override.

### Owner-reported Gallery totals changing during hydration

The owner observed Gallery changing from 1985 artists / 5327 albums to 2000 artists / 5327 albums after scrolling, while All artists remained 1985. The Gallery summary switched from authoritative API counts during partial startup to rendered group counts after full hydration. Backend review confirmed that the API and sidebar count normalized distinct album-owning artist identities; display groups are not an interchangeable authority.

This corrective unit retains authoritative artist and album totals for the unchanged root scope before and after hydration. Query results, selected-artist families, and narrowed client source/release-type/family filters retain their existing computed totals. No API, persistence, permissions, or visual component changes are required; rollback is the single summary-selection guard and matching generated bundle. Prerequisites are the confirmed count contract and existing Gallery startup scenario. Acceptance: header and sidebar agree on the authoritative root artist total, scrolling/hydration cannot change that total, and client-filtered/selected results remain scoped correctly. Unit regressions and FTC-GALLERY-031 cover these boundaries without changing its existing action order. Tests are authored but not executed locally under the owner's CI-only override. Independent static review, complete native CI, and owner manual acceptance remain required before any merge/publication checkpoint.

### Owner-reported Library warning leaking into selection loading

The owner showed Neal Morse search/selection displaying the Library watcher notice and Full Rescan beneath Loading selection. The shared loader owns both selection and dedicated Library modes; the separate library-warning renderer exposed its scan-page notice whenever health was warning, regardless of mode. The existing watcher-health notice already respected the mode and is not the source of this leak.

This corrective unit gates the scan-page warning on dedicated Library mode during both mode switches and later status renders. Selection keeps its spinner/loading text. Actual Library/Scan warning visibility, permission-gated Full Rescan, persistent warning icon/panel, dismissal, and recovery remain unchanged. No persistence/API/permission or component redesign is required. Rollback is limited to the two visibility seams and generated bundle. Acceptance covers active-warning search, return from Library into selection, repeated status updates, reopening Library, and healthy-state recovery. Unit cases cover immediate mode changes and status rendering; existing FTC-GALLERY-033 observes the real seeded-warning search transition with a read-only DOM observer and retains its Library, dismissal, and recovery checks. No intercepted requests, forced interaction, or test-only runtime state are introduced. No local tests/browser runs under the owner's override; independent static review and complete native CI remain required, with no merge/publication authorized by this change alone.
