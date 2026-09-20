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

### Owner-reported playing-row strobe

The owner requested restoration of travelling perimeter lights instead of the distracting whole-row effect. The existing conic-gradient sweep advanced by angle around a long, shallow rectangle, producing uneven perimeter speed and broad edge illumination. Runtime playback updates retain the same row and animation classes; no animation-reset defect was established. Mask declaration order was considered but is not a proven cause: the existing prefixed XOR already restores exclusion. The later modal-only wash also increased the shared row background from 7% to 16%; that steady wash is distracting but is not itself an animation.

Restore the already approved exact-perimeter contract from the September 4 Album Details component design using a shared, noninteractive SVG decoration in AlbumTrackTable. Two groups of three layered strokes follow the same 1px-inset rounded rectangle, normalized with pathLength 100. Numeric dash offsets differ by 50; both use the existing 3.6-second linear CSS animation and direction. Aligned 12/8/4-unit layers produce elongated graduated spectra without circular heads. No layout measurement, JavaScript animation loop, new table API, or dependency is introduced. The original subtle shared wash and static outline remain. Disabled animation and reduced motion retain their existing behavior; the decoration is aria-hidden and ignores pointer events. The separate Appearance preview is outside this shared-table correction.

Acceptance covers full-row inset/radius geometry, two half-path-separated spectra with synchronized advancing offsets, steady row background/opacity, normal playback/pause, saved animation preference, and reduced motion. Existing FTC-ALBUM-DETAILS-020 replaces obsolete pseudo-element implementation assertions with those rendered path checks, preserving its actions and behavioral checks. Unit coverage checks shared decoration and path animation contracts. CSS is loaded directly by index.html; regenerate only the JavaScript runtime bundle. Rollback is confined to shared table markup, its CSS, and generated bundle. Tests remain unexecuted locally under the owner's CI-only override. Independent static review, complete native CI, and owner visual acceptance remain the gates; static inspection alone does not prove the perceived flashing is resolved.

### Owner-superseded duplicate warning toolbar

The owner subsequently removed the toolbar warning button and its dropdown from the desired flow. This explicitly supersedes the separate-icon behavior in the September 12 gallery-warning plan and the earlier statement above that the icon/panel remain unchanged. Retain one actual floating watcher alert. Only after its current event is acknowledged should the unresolved warning appear on the dedicated Library page; search/selection loading never hosts that notice.

The existing per-account Postgres warning-token acknowledgement becomes the single dismissal authority. Floating Dismiss posts the displayed token; Go to Library awaits the same acknowledgement before navigation. A rejected or failed request leaves the warning available. Same-event requests coalesce; different-event requests serialize and revalidate their captured token before posting, preventing an old write from overwriting a newer acknowledgement. Success cannot hide a newer warning. Tokenless operational updates retain the last authoritative health until /status supplies a token, and explicit healthy status resolves the warning. The old permanent localStorage dismissal flag is ignored; no new persistence or endpoint is introduced.

Remove the duplicate toolbar/popover and duplicate Library host. The remaining Library notice keeps useful recovery instructions and permission-gated Full Rescan, appears only for an acknowledged unresolved warning, and hides immediately outside Library mode. Existing FTC-GALLERY-033 keeps its registered case identity but follows the owner-superseded floating-Dismiss/Library-navigation flow. It covers no toolbar duplicate, no premature Library notice, search loading without an embedded warning, acknowledgement across reload, same-clock and later new warnings, Go to Library acknowledgement, and recovery. Settings I01 keeps its existing Save/read/Dismiss sequence. Unit coverage adds async failure, stale-token, serialization, partial-status, reload, and stable-DOM cases. Rollback is the coherent warning-UI change and generated bundle; the existing acknowledgement schema remains compatible. No local tests/browser execution under the owner's override; complete native CI and manual acceptance remain required.

### Owner review batch: anchored Library menu and plain Sources rows

The owner requested that the Library status right-click menu reuse the regular dropdown and button-anchor presentation, and that Sources contain only labels and switches without inner pills or dividing lines. Reuse the existing gallery anchored surface controller, shared menu action buttons, and trigger-anchor styling. Preserve scan, cover-fetch/cancel, and Library navigation actions, busy-state labels, outside dismissal, and Escape focus return. Keyboard context-menu invocation must reach the same surface. A status-menu close must not close another active surface.

Sources rows override the global checked/hovered dropdown outline and fill only within the Sources menu. Keep the outer anchored panel, existing switch colors and ARIA state, and an accessible focus indicator on the switch track. No persistence, permissions, API, or new component is needed. Acceptance covers shared anchor ownership and lifecycle, existing status actions and labels, plain source rows in checked/hover states, and keyboard focus. Rollback is limited to these menu source/CSS changes and their eventual generated bundle.

The owner explicitly stopped per-fix rebuilds and restarts. Accumulate this manual-review batch locally and perform one final bundle generation, coherent commit/push, and app restart when the owner finishes the batch. The current port-5001 process remains running. New menu regression checks are authored for CI only; no local tests or browser checks. Review the complete batch before the final build and require full native CI with skip_reviews and without skip_tests. No merge or release is authorized.

### Owner review batch: approved alert adoption across active surfaces

The owner requested removal of custom alerts everywhere, including the legacy floating utility-rules error. Use the approved OnPageAlert for visible notification and error messages, SmallAlert for its existing compact affordance, and shared Button actions. This unit includes floating toasts and repair messages, active inline runtime error/warning notices, Appearance alert previews and module failures, and server-rendered authentication, recovery, account, administration, and settings notices. Ordinary empty/loading states and status labels are not alert replacements.

Preserve severity, escaped message text, explicit trusted repair-message HTML, action identifiers, permission boundaries, validation behavior, and no-JavaScript server errors. The approved family has error/warning/info only: legacy success and in-progress repair notifications use info with a neutral Update heading. The toast caller inventory found no HTML payloads; remove the sole redundant scan-error pre-escape so shared escaping occurs once. Floating wrappers retain timing, deduplication, collision-aware placement, dismissal, and Log History targeting, while their custom fills, pill shapes, and action styling are removed. Shared browser/CommonJS exports reuse the same builders, and text-token fallbacks plus hidden-state handling support standalone pages.

Acceptance covers utility-load failures, notification lifecycle/replacement races, warning/error/info appearance, payload escaping, persistent repair actions, Log History navigation, standalone hidden/error/success states, and live Appearance previews without draft changes. Extend existing unit/component/E2E contracts; retain original placement and mutation gates. Rollback is the coherent renderer/template/style adoption and matching generated assets, with no schema, permission, or persistence change. This remains part of the owner's current manual-review batch: no local tests/browser execution, one final bundle build/restart after the batch, and complete native CI before any publication. Static review alone is not runtime or visual acceptance.

### Owner review batch: return from filter dropdown to typing

The owner requested that clicking the search input close its filter dropdown. The outside-click check treated the entire combined search/filter wrapper as part of the dropdown. Narrow that boundary to the actual trigger, menu, and selected-filter chips. Clicking the native input now closes and renders only the filter controls; it does not consume the click, redirect focus, clear the query, or change selected filters. Trigger toggling, menu options, and chip actions retain their existing handling.

Focused unit coverage checks input dismissal, preserved focus and selections, and clicks within each retained boundary. Extend FTC-SETTINGS-S02 with a native filter-open/input-click transition before its original keyboard flow, preserving query, selection, and selected album. Rollback is the one selector change and matching coverage. Keep the ongoing batch's deferred single build/restart, CI-only validation, and no local tests/browser execution; static review does not replace owner acceptance or full CI.

### Owner review batch: embedded search action focus

The owner reported a whole-field glow on pressing embedded search buttons before their dropdown opens. The shared field used focus-within, which includes action-button focus. Restrict that outline to the direct native search input and give keyboard-focused embedded buttons an inset focus ring. Preserve the existing open-dropdown anchor treatment with explicit cascade precedence. No input handlers, native clear behavior, search submission, filtering, or dropdown actions change.

Acceptance covers both current macro instances: the app-bar submit action and Settings filter. Extend the existing component tests to check pointer-down before click from idle and typing, keyboard transfer between input and action, and native clearing with retained input focus. The shared stylesheet applies the behavior to every caller of the component. Static CSS contracts retain the child reset and verify separate field/button focus ownership. Rollback is confined to the shared stylesheet and matching tests. Preserve the ongoing batch's deferred single build/restart; no local tests or browser execution. Two static review passes and the full native CI pipeline remain required before any publication.

### Owner review batch: player artwork above Settings

The owner requested that player artwork open Album Details while Settings is open. Both player layouts already resolve the playing album correctly; the Album Details overlay was behind Settings (108 versus 112). Player artwork now explicitly requests a transient foreground class at 113. Settings and its drafts remain mounted underneath. Closing Album Details removes that class and reveals Settings; reopening Settings removes the class as well. Escape closes foreground Album Details before Settings while retaining higher-dialog precedence. Detail hydration preserves the current order and cannot promote itself again after Settings reopens. Ordinary gallery actions and the player single-cover lightbox contract remain unchanged.

Acceptance covers expanded and compact artwork, the playing album after unrelated gallery navigation, uninterrupted playback, retained Settings drafts, foreground pointer actionability, Escape, normal hydration and the Settings-reopen race. Existing unit fixtures and player E2E cases are extended without adding a new scenario or mutation contract. Rollback is limited to the explicit opening option, transient layer/lifecycle handling, matching tests, and eventual generated bundle. Two static reviews and CI-only verification remain required; no local tests or browser execution. Include this correction in the owner's current batch, with one bundle build and restart only after the owner finishes the batch. No merge or publication is authorized.

### Owner review batch: drag to deselect problem labels

The owner requested deselection by dragging across selected problem labels. The existing gesture records the initial selected state only for deferred click behavior, while range extension always selects. Capture a fixed select/deselect intent when the gesture begins and apply that intent idempotently to matching file-problem labels across the range. Starting on an unselected label selects; starting on a selected label deselects. Preserve deferred single-click behavior, same-reason boundaries, unrelated selections, and independent suggested-edit state.

Acceptance covers forward and reverse selection/deselection, repeated or backtracked movement, mixed selection states, and unrelated problem reasons. Extend the existing native E2E range-selection scenario with deselection and reselection before its original exclusion action; do not change exclusion persistence or confirmation behavior. No API, persistence, permission, or visual component change is needed. Rollback is limited to gesture intent and range application. Include this correction in the ongoing batch with one final bundle build and restart after the owner finishes sending fixes; no local tests or browser checks.

### Owner review batch: saved-loop insertion cues

The owner reported missing insertion feedback while dragging saved loops. Bind the existing same-song reorder handler to detail lists as well as tree lists, resolve gaps against visible rows, clear stale cues on invalid or empty targets, and provide detail-list edge padding for the existing marker. Preserve row-hover feedback, permissions, revision validation, persistence, playback, and editor continuity.

Acceptance covers before-first, between-row, and after-last cues, hidden rows, invalid song membership, marker cleanup, and unchanged reorder behavior. Unit coverage exercises tree and detail containers; the existing native E2E reorder scenario observes marker paint and clipping during cancelled drags before its original persistence and playback assertions. Rollback is limited to container targeting, edge padding, and matching coverage. Source-only correction in the current owner batch: two static reviews, CI-only execution, and one deferred bundle build/restart after the owner finishes the batch. No local tests, browser checks, merge, or publication.


### Owner review batch: calendar input clipping

The owner reported the left date input being clipped in the Log History export form. The shared form body scrolls vertically and consequently clips horizontal overflow; its controls previously sat directly against that clipping edge. Add a four-pixel content inset to preserve the existing focus outline on both date fields and other shared form controls, retaining vertical scrolling and the stationary footer. Acceptance covers focused From and To date inputs inside the scroll viewport without horizontal overflow, plus the existing export flow. No date parsing, calendar behavior, API, or persistence changes. Rollback is the shared body inset and matching coverage. Keep this source correction in the current batch, with CI-only verification and one final bundle/restart after owner completion.


### Owner review batch: compact date-range dropdown

Remove the unused vertical space reported below the date-range timezone. The shared form error paragraph has default paragraph margins even when empty because it is a flex child. Collapse only the empty error node; populated validation messages retain their normal layout and alert semantics. Scope the timezone margin to ten pixels above and zero below, and the action-row top margin to twelve pixels, for forms containing the shared date-range picker. Preserve controls, calendar anchoring, scrolling, footer accessibility, and real error visibility. No fixed height or calendar behavior change. This low-impact CSS correction remains in the pending manual-review batch; no local tests, browser checks, bundle, or restart. Rollback is these three CSS rules.

### Owner review batch: reuse the shared calendar for log export

The owner requested the filter's shared calendar wherever dates are selected, specifically Export all logs. Replace its two native date inputs with the existing date-range builder and controller. Preserve presets and Custom values; mount only while Custom is visible, disable hidden date controls, and dispose calendar listeners/popups on preset changes and dialog close. Scope export-only input styling away from shared calendar fields and remove the obsolete date grid. The earlier form-content focus inset remains useful for shared controls.

Acceptance covers shared calendar selection for both endpoints, unclipped field focus, retained Custom dates across preset switches, hidden-control focus exclusion, listener cleanup, and unchanged export query/download behavior. Extend the existing runtime and H03 E2E cases. No new component, permission, persistence, or API is introduced. Rollback is limited to export calendar composition, scoped styles, and matching tests. Source-only owner batch: two static reviews and CI-only execution; defer the single bundle build and restart until the owner finishes the batch. No local tests, browser execution, merge, or publication.

### Owner review batch: simple library path rows

Remove Folder layout from Library settings while retaining recognized layout_mode values in existing settings and save payloads. Every root group retains one editable blank draft row when empty; Add path appends a row, including a second row from an empty group. Removing the final row restores a blank input, and Browse fills that existing draft row. Saved settings remain unchanged until Save; serialization omits blank paths and clears only policy references to blank rows in the policy's own category. Blank rows are excluded from policy menus. Unknown policy IDs remain available for server validation.

Acceptance covers empty Hoard/New Arrivals/Main groups, append/remove/browse, unchanged normalized empty settings, blank-free POST bodies, retained layout metadata, and same-ID policy isolation between categories. Unit cases and the existing I01 E2E flow cover the changed behavior. Rollback is limited to path-row presentation, draft serialization, and matching tests. Source-only current batch: two static reviews, no local tests/browser/build/restart; final bundle and restart remain deferred until the owner finishes the batch. No merge or publication.

### Owner review batch: shared Move policy dropdowns

Replace the Library writes and Move to Hoard native selects with approved ButtonComponent triggers and the existing shared anchored choice dropdown. Choices carry distinct root IDs and displayed path labels, include the empty default choice, and omit blank draft paths. Preserve persisted move-policy fields and server validation. Disabled controls and guarded selection enforce the existing manage capability. Extend the shared helper to accept value/label choices while preserving Foobar string choices; same-trigger activation toggles closed and a different trigger opens its menu immediately.

Acceptance covers both dropdowns, selected state, duplicate labels with distinct IDs, empty reset, permission changes, focus return, toggle/switch behavior, and Foobar compatibility. Extend runtime unit cases and the existing I01 E2E flow, preserving its original save validation. No new component, API, permission, or persistence model. Rollback is limited to shared choice compatibility, policy controls, and matching tests. Source-only batch: static reviews and CI-only verification, no local tests/browser/build/restart; defer the final bundle and restart until the owner finishes the batch. No merge or publication.

### Owner review batch: compact Artist Family panel

Show the selected primary artist followed by Family, with the album total immediately beside it after a decorative fat dot. Size the panel intrinsically from its longest artist pill, count, and padding, capped at the existing 390px/92vw limit, with a viewport-bounded 240px floor to keep short-family controls usable. Header/help and Combine content do not contribute to intrinsic width. Keep long pill names ellipsized with full text in the DOM and a title tooltip; retain fixed counts, existing anchoring, viewport/player bounds, and selection identity.

Acceptance covers the primary title, adjacent total, compact known-family width, maximum viewport width, long-name truncation/accessibility, and unchanged selection/drag behavior. Update both shared panel markup and the server template, existing runtime unit coverage, and the family responsiveness E2E flow. No data, permission, or persistence change. Rollback is limited to panel presentation and matching coverage. Source-only owner batch: static reviews and CI-only verification; no local browser/tests/build/restart, with final bundle/restart deferred until the owner finishes the batch. No merge or publication.


### Owner review follow-up: Gallery Bar left alignment

The owner requested alignment of Gallery Bar text with gallery headings and album cards. Both surfaces share the main content inset, but the bar added ten pixels of left padding. Remove that redundant left padding while preserving the right action inset and vertical spacing. This applies at desktop and mobile breakpoints without changing gallery layout or scrolling. Static review confirms no overriding bar padding rules. This is a source-only follow-up after the last manual build; retain CI-only testing and defer another build/restart until requested.


### Owner review follow-up: restore historical playing-row animation

The owner rejected the current animation and requested the playing-row animation from approximately September 14. Commit d0fe14e on September 19 replaced the existing conic-gradient perimeter pseudo-elements with SVG dashed paths. Restore the pre-d0fe14e animation CSS, row renderer, and corresponding component/unit/E2E assertions; all six files were unchanged since that commit before this restoration. Preserve the existing playback controls, animation preference, reduced-motion behavior, and timing. Do not revert the generated runtime bundle or unrelated pending changes. Rebuild once with the next requested batch; no local tests or browser checks. Static review only, CI verification pending.


### Owner review follow-up: artist information text links

Use a pointer cursor and underline for enabled artist-information text actions and links. Suppress the global rectangular button hover/focus treatment within the existing shared link row; keyboard focus receives a thicker underline instead of losing its visible indication. Preserve disabled Full page behavior and existing link destinations/read-more handling. The same row styles apply to live rendering and the component builder. Source-only CSS correction, statically reviewed; no local tests/browser checks or restart.

### Owner review batch: shared compound input focus

The owner requested mm/dd/yyyy placeholders in blank shared calendar fields and no field-ring flash when an embedded action is pressed. Introduce an explicit ui-input-action focus contract in the already shared button-component stylesheet, loaded by the application and standalone appearance bootstrap. Search, date range, library paths, and account/admin password wrappers opt in; per-variant tokens preserve their existing focus colors and geometry. Only direct input focus paints the field, with suppression during embedded-button active states and joined dropdown ownership. Embedded actions retain an inset keyboard focus ring; inner inputs do not duplicate it. Existing password toggle focus-return behavior and ordinary login inputs remain unchanged.

Acceptance covers input focus, pointer-down before/after input focus, independent button keyboard focus, open trigger anchors/search suggestions, all compound variants, and both calendar placeholders. Extend existing component/static/runtime coverage and H03 export E2E. No new dependency, permission, persistence, or UI framework. Rollback is limited to the shared focus contract, wrapper markers/tokens, placeholders, and matching coverage. Source-only current batch: static review and CI-only verification; no local tests/browser/build/restart, with one final bundle/restart deferred until the owner finishes the batch. No merge or publication.


### Manual review: muted input focus
- Owner requested calendar-style grey/themed focus for every input and search field.
- Shared input-action defaults now use a 1px inset muted edge without a glow. Removed search, password and path blue focus overrides; ordinary text-entry inputs, textareas and selects receive the same shared rule.
- Native toggles, sliders, color pickers and action buttons retain their own interaction styling. Compound buttons retain independent focus ownership.
- Component coverage checks muted colors, thin inset geometry, no shadow, page-style precedence and theme changes. Existing search and compound-field coverage updated.
- CI-only verification remains in effect. No local tests, browser checks, build or restart for this change. Delivery remains part of the pending owner manual-review batch; rollback is the scoped CSS/test diff.

### Manual review: remove export Source filter
- Owner requested removing unclear Sources unless important. This is an optional event-origin filter, not a library-path control. Removed its dropdown and menu lifecycle; export drafts explicitly include all sources.
- Keep event-origin metadata and backend query support for diagnostics and compatibility. Date, event-type and text filters remain available.
- Updated regression coverage for absent Source controls and unrestricted-source export drafts. Static review only; CI-only verification and deferred rebuild remain in effect.

### Manual review: main-library destination
- Rename Library writes to Library destination and simplify explanatory text. A sole nonblank main path is shown without a selector; the planner already defaults to it. Multiple main paths use only actual path choices, showing the effective first-root fallback when no preference is saved.
- Shared choice menus reuse gallery anchored-menu rows and trigger-anchor animation/interaction styles. Hoard keeps its explicit destination requirement, as its planner blocks without a saved choice.
- Updated unit and native E2E coverage. No local execution or rebuild; this remains in the pending reviewed batch.

### Manual review: destination captions must not activate dropdowns
- Replaced the two move-policy wrapping labels with layout divs. Native label activation was forwarding caption clicks to the contained buttons. Buttons retain explicit accessible names and keyboard behavior.
- Updated static coverage and the native destination-selection flow to click each caption first and assert that its menu stays closed, then open via the actual trigger. No local tests, browser checks or restart.

### Manual review: move automation proposal and destination width
- Owner requested narrower destination triggers with full-trigger-width menus. Both policy triggers now cap at 320px; their shared menu matches measured trigger width and stays within viewport bounds.
- Proposed replacement controls: Auto Move rated albums to Main library; Move New Arrivals to Hoard. Each has an enable switch and a destination selector only for multiple roots. Future manual album-context moves remain excluded.
- Investigation found destination planning but no existing automatic rated-album mover. Automatic execution awaits clarification of the New Arrivals trigger; no new move behavior or persisted switch has been introduced yet. No local test execution or rebuild.

#### Owner scope clarification: UI only
- Owner explicitly deferred automatic-move backend, watcher changes and scheduling. Implemented only the two shared switch rows. State is held in the current settings UI, not saved as automation configuration and not sent to the backend. Existing destination preference persistence remains unchanged.
- Switches start off; off hides destination controls. Enabled rows show a plain path for a single destination, or path-only anchored dropdowns for multiple destinations. Missing destinations or absent manage permission disable the switch.
- Updated regression fixtures, switch-state coverage and native dropdown width assertions. No local tests/build/restart. Prior caption-only assertions are superseded by the owner-requested interactive switches; switch activation must still never open a destination menu.

### Manual review: Sources hover
- Added a subtle theme-neutral hover fill to enabled Sources rows, preserving plain text/switches, no row outlines or pills, and the existing keyboard focus cue. Static-only review; no rebuild or restart.

### Manual review: shared neutral dropdown hover
- Moved dropdown-row interaction styling into the shared trigger/popup stylesheet. Hover uses a neutral theme-derived fill, customizable through --dropdown-item-hover-background; row outlines and shadows are suppressed. Keyboard focus remains visible through fill and underline.
- Removed competing dropdown outline rules from Appearance and the Sources-only hover override. File-list selection styling remains separate. Updated existing component coverage for account links/buttons and theme-token changes. No local execution or rebuild.

### Manual review: full family heading
- Panel content sizing now includes the full family heading plus album count, while explanatory text does not force extra width. Preserve 240px minimum and 390px/viewport maximum.
- Remove heading ellipsis; long family names wrap within the cap. Header cannot shrink vertically, keeping the full title visible above the artist list. Artist-pill truncation remains unchanged. Static regression coverage added; no local execution or rebuild.

### Manual review: laptop gallery horizontal overflow
- The responsive card tracks already distribute the available scroll width. The absolute 300px focus glow can extend beyond the final card and create scrollable horizontal overflow. Clip only horizontal decorative overflow at the viewport boundary; preserve vertical scrolling, card sizing and the glow inside the gallery.
- Allow long artist headings to wrap within flexible grid tracks. Existing 1440px/1024px responsive E2E now hovers the rightmost first-row card before measuring card fit and document/gallery horizontal overflow. CI-only verification; no local browser/test execution or rebuild.

### Approved mockup: compact artist-family selection rows
- Implement the owner-provided dark 60px rows, reserved 5x28 selection bar, existing 48px album-art component, one-line artist name and fixed 44x32 neutral count badge. Both selected and unselected states keep identical geometry and full-color artwork.
- Selection uses only a crisp 1px green border and marker. Remove the primary-artist divider/glow/fill distinction while retaining its semantic identity for selection logic. No artist-image fetching or database changes.
- Preserve independent multi-selection, existing artwork fallback, full family heading, and responsive panel bounds. Update test selectors and visual contracts. CI-only verification; no rebuild/restart.

### Investigation: saved-loop Play immediately stops
- Owner reports immediate stop/reset. Exact loop, entry point and browser are pending. Local app log contains a PCM WebSocket disconnect, but no causal link to the loop click is established.
- Confirmed silent rejection handling in toggleUtilityLoopPlayback: both native play failure and global-player handoff failure were swallowed. Added shared-toast reporting with error name only and bounded media error code in console; no media paths or raw error messages. Playback ownership/architecture remains unchanged.
- Existing playLoopByName verifies native playback plus >=0.2s progress; this alone does not prove all browser/media/handoff combinations. Added rejection-reporting regressions for direct and handoff starts. CI-only testing; no local execution, rebuild or restart. Root cause remains unconfirmed.


### Manual loop playback investigation: stale media references

- Observed real owner-app GET /loops/media failures returning 404. Two failing records pointed outside the configured loops directory; matching in-root files existed and SHA-256 matched. The resolver correctly rejects outside-root media. Do not relax this security boundary.
- Repaired twelve confirmed stale loop_private_path values for account 1/library 1 across two serializable transactions. Each update required one matching in-root file, equal SHA-256, unchanged row identity, and no other database owner of the old/new artifact path. Audio files were unchanged.
- Final read-only inventory: 21 records; zero outside-root references; twelve present files and nine missing files. No matching artifacts for those nine were found under the configured loops directory. Their records were preserved; do not claim all loops are repaired.
- Existing E2E playback helper checks media readiness, playback and time advancement; valid fixtures do not certify integrity of pre-existing owner media references. Rejection UI coverage was added for direct playback and main-player handoff. Errors now use the shared toast rather than being silently swallowed. This source change is pending the final batch build and CI.
- Static corrective-diff review and git diff --check completed. No local tests, browser checks, rebuild, restart, merge or release. Actual owner playback remains unverified.


### Loop waveform setting and scissors follow-up

- Confirmed current source and bundle already wire the player seekbar setting to saved-loop canvases, including when no main track is selected. Existing drawCombinedLoopWaveform renders one centered combined L/R magnitude band, consistent with the approved utilities-refactor v002 waveform. No speculative renderer or playback architecture change.
- The scissors entry flow waits for the same /playback/waveform loop-ID endpoint; recorded 404 responses for repaired loop IDs explain refusal to enter the editor. That route uses the same protected media resolver as playback. Failed peak loads are evicted so retry can recover after the data repair. Exact owner loop/error timing was requested to distinguish any failure persisting after repair.
- Added unit regressions for no-main-track waveform/default propagation, saved-loop 404 recovery without stale cache poisoning, and scissors reopening after peaks become available without saving prematurely. Existing FTC-UTIL-LOOPS-028 already exercises five paused waveforms after cold reload; existing scissors E2E contracts remain intact.
- Two static passes plus independent review completed; no retained findings. Tests remain unexecuted under CI-only authorization. No build/restart. Missing audio for nine remaining records is unresolved and prevents waveform/editor use for those records.
