# Sandbox3 manual-test handoff

## Problematic separate-release detail identity repair

- Outcome: resolve the exact summary identity when a separate release's canonical
  artist differs from its persisted album credit; repair FTC-UTIL-PROBLEMS-013/007
  without changing their acceptance contracts.
- Scope: CI functional/detail checklist; detail-only candidate resolution and
  focused summary-to-loader regression. Preserve the shared duplicate resolver.
- Prerequisites: retained HTTP 200 summary / HTTP 404 detail evidence, completed
  isolated-run cleanup, and exclusive focused pytest lane.
- Acceptance: composite persisted credit resolves canonical summary key; exact
  projected year remains authoritative; wrong year/title and other owner/library
  candidates cannot leak. Load compact scoped album identity fields before full
  file metadata, retaining existing physical-container duplicate validation.
- Compatibility/rollback: no schema, persisted-data, public payload, UI, timeout,
  or test-flow change. Revert the detail resolver and its regression together.
- Checkpoint: focused RED/GREEN, two complete independent reviews, then unchanged
  focused browser cases; full hosted CI and existing release gates remain open.
- Verification: the new real-loader regression failed for both existing years
  with `detail is None` before repair. After repair, 135 focused problematic-file
  and duplicate-identity tests passed (220 unrelated cases deselected), including
  absent year/title and foreign-library negatives. Scope is guarded at the SQL
  connection boundary; no live database isolation test was run in this slice.
- Query cost: separate-release detail adds one compact album-identity read (key,
  title, canonical artist, edition), with no track/file join or metadata payload.
  Existing duplicate inventory/cache and final exact projected-key filtering are
  unchanged. Browser verification and two independent reviews remain pending.

## Focused functional runner PowerShell selection

- Outcome: let the supported isolated functional runner provision and tear down
  using installed PowerShell 7, with Windows PowerShell retained as fallback.
- Scope: local runner executable choice, focused regression and local-run guide;
  existing four-case hydration/warning/detail verification remains unchanged.
- Evidence: Windows PowerShell cannot resolve `Get-FileHash` on this host;
  PowerShell 7 provides it and completed the checksum-pinned v1.0.25 download.
  The runner hardcodes Windows PowerShell for its bootstrap child even when
  launched from PowerShell 7. No app, service or database was started.
- Acceptance: prefer available `pwsh.exe`; retain the existing absolute Windows
  PowerShell fallback; fail before provisioning if neither exists; preserve all
  bootstrap arguments, secret filtering and teardown through the same selected
  executable. Reuse the runner's existing executable resolver.
- Compatibility/rollback: no schema or acceptance-contract changes; reverting
  executable selection restores previous behavior. Existing services are not
  restarted. No test timeout, retry or expectation changes are allowed.
- Checkpoint: focused RED/GREEN and two independent review passes before the
  original four functional cases run; hosted CI still gates publication.
- Verification: new resolver regression failed before the repair; all eight
  focused runner tests passed afterward. Two independent reviews completed
  before browser execution. The repair was committed as `2fcc7909`.
- Fixture provenance: authenticated repository acquisition verified release
  `fixtures-v1.0.25`, manifest SHA256
  `e56a515ff4073fa1c0e7e2b9a91a5217259344415c71de0b068af3615eb09e60`
  and its archive checksum. Existing v1.0.22 files were not replaced. A new
  task-owned distribution envelope supplied the supported local runner.
- Unchanged four-case result: FTC-UTIL-PROBLEMS-013 and -007 failed their
  60-second selected-detail waits. The -013 trace shows list HTTP 200 followed
  by selected album detail HTTP 404 (`Problematic album not found.`), with
  the UI displaying `Album details unavailable`. FTC-GALLERY-031 passed its
  original startup hydration/totals contract and subsequent search/hover cases,
  then failed at line 108 waiting for `[data-artist-info-trigger]` until the
  unchanged 180-second test timeout. FTC-GALLERY-033 passed in 38.6 seconds.
- Evidence: private `tmp/ci22-functional-1791165159050/functional.log`; retained
  output and blob artifacts beneath
  `tmp/ci22-functional-1791165159050/runner-temp/album-haven-functional-local-fed481ec6185-gallery_search_visual/`.
  Failure output waves `wave-01-01-playwright-config-js`,
  `wave-01-02-playwright-config-js` and `wave-01-03-playwright-config-js` retain
  page snapshots and full traces containing 319, 326 and 192 screenshot
  resources respectively. No waits, expectations or E2E scenarios were edited.
- Cleanup: ordinary failure exit 1, not cleanup-failure exit 2. Exact disposable
  database `album_haven_ci_local_fed481ec6185` and all three suffixed roles have
  independent zero-count verification. Ports 54196/54198 have no listeners;
  original owned app/browser/runner processes exited. The numeric runner PID
  was later reused by the audit's own `rtk.exe`, distinguished by executable
  and creation time. Runtime fixture copies, state and password files were
  removed; failure evidence and downloaded source fixtures remain. Existing
  PostgreSQL 18 stayed running; production and sandbox services were untouched.

## Isolated CI duplicate and live-fixture repair

- Outcome: preserve same-track physical-file duplicate reasons alongside multi-root duplicate sources; execute the eight existing source-appearance and multi-root live contracts in CI.
- Scope: CI Python checklist item; shared problematic projection, focused parity/isolation regression, existing CI persistent database wiring and narrowly validated live-fixture ownership.
- Prerequisites: migration identity repair and exclusive pytest lane. No production or sandbox database is permitted.
- Acceptance: unchanged live duplicate assertion; summary/detail parity; unrelated albums remain unflagged; eight live instances execute without skips; unowned database names are rejected before connecting.
- Compatibility/rollback: additive duplicate classification and reuse of CI-owned provisioning; revert these changes without modifying persisted application data or test expectations.
- Checkpoint: focused RED/GREEN and two complete reviews before root integration; complete hosted CI remains required before merge/publication. No local full suite or deployment belongs to this repair.
- Verification: same-track and separated-year regressions each failed before their corrections; CI ownership configuration failed for the intended persistent lane before repair. Final focused verification passed 35 tests. The unchanged live duplicate contract passed 1/1 and all eight formerly skipped live instances passed 8/8, with zero skips/failures/errors (private evidence: `tmp/ci22-inventory/live-duplicate.xml` and `live-eight.xml`).
- Isolation: localhost PostgreSQL 18 disposable databases `album_haven_ci_py_ci22dup_20261004_2320` and `album_haven_ci_py_contract_20261004_2320` used existing bootstrap provisioning and exact state-bound teardown. Final audit found zero matching databases, six matching roles removed, zero matching connections, no owned process, and no remaining state/password files. Production and sandbox3 were not used.
- Review: two complete relevant-diff passes; the first tightened negative coverage for missing track keys and explicit album count, the second found no remaining validated issue. Persistent fixtures retain UUID-owned row cleanup, role checks, loopback/same-database validation and ownership locks; CI exports only its already provisioned persistent contract database. Hosted CI and independent integration review remain pending.

## Current repair evidence

- Appearance and component-inventory focused verification: 100/100 Node tests passed; complete CI and independent review remain pending.
- Startup investigation reproduced a full followup request being rewritten to sidebar-only data. The correction must preserve ordinary root pagination and the existing full-startup acceptance contract; no performance threshold changes are authorized.
- Python investigation identified repeated exception resolution when duplicate projection rebuilds file entries already normalized by the problematic-files projection. Reuse belongs at the shared projection seam, preserving output and one resolution per row. Rollback is removal of that reuse, not altered assertions. Focused verification remains pending.
- Fresh service inspection still finds the original maintenance server on port 5003 and production on port 5000. Normal sandbox deployment is blocked on the owner's data-mode choice; no service or production database change has been made.
- Startup focused verification reached 161/161 after an additional regression exposed automatic page loading cancelling the queued full startup fetch. Keep pagination suspended until startup hydration completes. Browser and hosted verification remain pending.
- All six unchanged exception-resolution-once tests now pass with shared projection reuse. The last exact by-track-path payload check passed after explicitly accounting for its existing internal persisted-album identity. Migration collision, live Postgres cases, provisioning skips, and complete CI remain unresolved.
- Library State initial focused verification reached 41 Node and 36 Python passes. Independent review subsequently requested preparation-mode and terminal-counter rendering repairs; those require fresh checks before this unit can be marked complete.
- Python consolidated verification passed 417 tests in 16.61 seconds (exit 0): both complete focused browse/palette modules and the two repaired isolated fixture-generation cases. Evidence: private `tmp/ci22-inventory/python-consolidated.xml`. This does not include the migration collision, live database assertion, or provisioning skips. Independent two-pass review of the four-file repair found no validated issue.
- Appearance/inventory is committed as `d62a95165138eb6aaa7d198f68e213d8636b696f`; seven files only, index clear, no push or deployment. Exact implementation versus process elapsed time was not recorded.
- Python repair is committed as `dd871bbb39874324524d11394a0723f19052e5ab` (four implementation/test files plus this handoff plan). No push or database operation occurred.
- Migration investigation: both `0080_library_source_indicators.sql` and `0080_user_client_layout_preferences.sql` exist, followed by `0081_grant_move_policy_settings_delete.sql`. A byte-preserving source-indicator rename to 0082 alone is unsafe: the sandbox deployment controller rejects applied filenames missing from source before executing SQL. Proposed compatibility is an exact checksum-bound old/new alias accepted in both directions, preserving ledger history and avoiding replay. The owner has been asked to approve this deployment-tool change separately from the sandbox data-mode choice. No migration file, controller, or ledger has been changed.
- Owner approved the checksum-bound compatibility fix and selected an isolated production-data copy provided it retains the multi-root inventory. Preserve all root/catalog/cover records. A database snapshot does not itself copy media; media/cover mapping must be verified before manual-test handoff, without turning sandbox writes into production-media writes.
- Final combined frontend verification: 202/202 passed (zero failures/skips), covering startup hydration and Library State together. Library State backend: 41/41 after exception-outcome repairs. Fourth complete Library State review found no remaining validated finding. Browser verification and full CI remain open.

Owner requested normal sandbox3 browsing, visible Library State progress, all
approved fixes, continued CI repairs, and reconciliation of outstanding requests.
This checklist coordinates existing owning plans; it does not approve new UI,
permissions, database changes, merge, or publication.

## Delivery units and gates

- [ ] Library State: preserve the approved four-card UI; show completed albums,
  downloaded covers, meaningful percentage, preparation-inclusive elapsed time,
  ETA or unknown, and unavailable/stale state. Center the block when sole content.
  Owner: existing September 21 Library State spec and remaining-UI plan.
  Compatibility: existing UI and status API; additive telemetry only. Verify
  focused tests and rendered behavior before the manual-test deployment.
- [ ] CI appearance/inventory: align test fixtures and registration with the
  approved source indicators; preserve all discovered cases and thresholds.
- [ ] CI Python: reproduce and repair the complete reported failure inventory;
  distinguish fixture drift from actual browse/identity/schema regressions.
- [ ] CI functional/performance: resolve gallery hydration/navigation failures
  without weakening existing full-view or responsiveness acceptance contracts.
- [ ] Deploy: use the deployment runbook and this feature worktree only. Confirm
  the owner's database choice before replacing maintenance with normal sandbox3;
  preserve current production service and database unless separately authorized.
  Verify local/public login, private bootstrap denial, owner browsing, covers,
  artist/search actions, settings loading, and Library State.
- [ ] Cover recovery/retry: retain the timeout investigation plan's unresolved
  read-only-file permission, mixed-album scope, durable-outcome audit, and exclusive
  writer gates. Never label errors as no candidates or silently restart a pass.
- [ ] Manual move: initial permission/client/deployment scope is approved; exact
  technical design, mockup, and functional cases still require their explicit
  approval before exposing the new action.
- [ ] Family grouping: preserve the diagnosed distinction between folder-derived
  family ancestry and external artist relations; proposed grouping changes must
  specify the desired contract before implementation.
- [ ] Remaining multi-root/preparation checks: reconcile their existing owning
  plans and provide a precise manual script; do not infer completion from commits.

## Verification and release boundary

Run one test command at a time for this coordinated batch, including one pytest
process globally. Complete two severe relevant-diff reviews per repaired unit.
After focused verification, commit coherent units and push the complete native
PR22 pipeline with the existing owner-authorized `skip_reviews` waiver; never
add `skip_tests`. Full CI must finish before collecting the next failure batch.
Manual acceptance, unresolved designs, full CI, and release gates stay open.
An accumulated branch needs a safe delivery split before publication.

## Current operational evidence

The original cover executor has a terminal completed record; its server remains
on 5003. Production is currently running on 5000, while the ordinary sandbox3 task
is disabled. This differs from the original maintenance handover. Deployment must
not restore obsolete task state or start concurrent cover writers.

The normal deployment controller provisions isolated sandbox data. The owner
selected a multi-root-preserving production copy. Physical
preflight found approximately 1.91 TB of indexed media versus 1.61 TB free on C:;
the complete copy cannot fit in the current slot. K: has about 4.41 TB free but
requires an explicitly approved storage-boundary extension. A follow-up choice
is pending between catalog plus copied covers (no playback/moves/scanning of
uncopied audio), complete media on suitable storage, or exclusive production
database/media use with production stopped. No import or service switch occurred.
