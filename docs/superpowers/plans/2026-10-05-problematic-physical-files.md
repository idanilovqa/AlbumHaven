# Physical File Problem Categories Implementation Plan

## Approved normalized-folder index follow-up (current; supersedes older no-schema gate)

Implementation evidence: after freeze release, C-collation attempt07 produced the expected targeted-detail regression (**1 failed**, 1.52s) while global candidate detection found both records. The normalized equality/index replacement then passed attempt08 (**3 passed**, 6.44s): all four targeted modes used the expression index and materialized exactly two context rows with 3,001 unrelated files. Exact attempt07/08 cleanup returned zero databases, roles and connections; owned launchers exited. Attempt09 proved a wrong same-name prebuilt index was silently accepted (**1 failed**, 1.20s); migration validation now checks canonical definition and valid/ready/live flags before ledger insertion. Attempt09 cleanup likewise returned zero resources. Online application remains a separate gated action, not performed.

Final attempt10: **4 SQL tests passed**, 4.95s, exit 0, including fresh migration, valid existing-index replay, wrong existing-index rejection, C-collation regression and bounded four-mode EXPLAIN. Cleanup independently verified databases 0, roles 0, connections 0; launcher 15556 absent. Focused physical/Problematic Files Python contracts: **152 passed, 233 deselected**, 2.06s. Concurrent build under live workload and explicit invalid-index interrupted-build recovery have not been executed; these remain online rollout verification gates, not claimed outcomes. Independent review and owner acceptance remain open.

Nearest-file unit run produced **384 passed, 1 failed**. Review traced `test_postgres_root_sidebar_reads_one_repeatable_read_snapshot_and_rolls_it_back` to an overbroad SQL classifier: `files.scan_file_album` also matches the new physical seed query. The seven-query invariant still passes. The classifier now matches `files.scan_file_album as album`; all existing count/snapshot/rollback assertions remain unchanged. Verification is pending the test lane.

The owner approved the index-related options. Selected solution: one additive normalized-folder index, without the slower root-wide fallback. Approval does not permit table/catalog/media rewrites. The metadata browser wave ended and source freeze was released. The test lane is currently held by another worker; no tests run until handoff. No live DDL is authorized by this plan checkpoint.

Independent review found that unconditional slash conversion after `local_path_key` conflates POSIX literal backslashes with directory separators. Attempt11 proved RED: one literal-backslash regression failed, one case-distinct control passed (1.79s). Query and index now convert separators only for Windows paths. Attempt12: six SQL contracts passed in 6.15s, including POSIX negatives, Windows C-collation and bounded indexed lookup. Exact teardown audit: zero databases, roles and connections; launcher 41208 and descendants absent. Sidebar classifier and nearby physical/browse unit contracts: 385 passed, zero failures (JUnit 7.040s).

Concurrent-recovery test creation was rejected by automatic safety review before writing or launching because its environment-selected database was not sufficiently proven disposable for concurrent DROP/CREATE INDEX. No workaround was used. Existing harness/resolver checks enforce generated fixture names and loopback; explicit exact suffix/database/role proof is required before retry. Concurrent/interrupted-build verification remains a narrow live-rollout gate; no live DDL occurred.

Attempt `physical_20261005_06` unexpectedly passed the Windows-case regression: **1 passed, 2 deselected**, 1.89s, exit 0. The local template uses `English_United States.1251` collation, not bytewise C ordering. This is not a demonstrated local casing failure. Exact cleanup: databases 0, roles 0, connections 0; launcher 35100 and owned processes absent. Test lane released. An explicitly C-collated disposable regression must establish the portability boundary before query replacement.

Minimal proposed index expression (design only, not executed):

```sql
CREATE INDEX CONCURRENTLY local_track_files_active_physical_parent_idx
ON library.local_track_files (
  library_root_id,
  (regexp_replace(case when library.local_path_style(private_path) = 'windows'
    then replace(library.local_path_key(private_path), chr(92), '/')
    else library.local_path_key(private_path) end, '/[^/]*$', ''))
)
WHERE scan_cache_stale IS FALSE;
```

Reuse the existing immutable `library.local_path_key` and the identical immediate-parent expression in seeds, indexed sibling lookup and grouping. It normalizes Windows paths while preserving POSIX case. Remove raw folder-prefix generation and its slash/backslash union. Match root ID and normalized parent directly; retain nonstale, track-library and active-root checks. Preserve distinct persisted album identities, off-page companions, disc-directory boundaries and global inventory semantics. No helper function, stored column or INCLUDE columns without evidence of need.

Forward application: first inspect migration-runner transaction semantics and select the next available migration identity. Fresh isolated databases can build the index through the normal transactional migration path. Existing live databases need a reviewed autocommit `CREATE INDEX CONCURRENTLY` path outside transaction blocks, bounded lock acquisition, exact relation/definition checks and recorded completion. Name-only `IF NOT EXISTS` is insufficient: verify `pg_index.indisvalid`, readiness and exact index definition. Failed concurrent builds can leave invalid indexes; preserve evidence and remove only the exact confirmed invalid index before controlled retry. Never stamp or rewrite migration history merely because a name exists. Test fresh/online ledger parity before any live application.

Compatibility/rollback: the additive nonunique index leaves old readers/writers unchanged; no catalog rows, constraints, permissions, configuration or media are rewritten. Build and verify before deploying the targeted query on a large catalog. Application rollback may leave the index safely installed. Optional later index removal uses only the exact `DROP INDEX CONCURRENTLY` outside a transaction after dependency/rollout checks. Categories and exclusion identities retain their existing rollback contract.

- [x] After freeze/lane release, run unchanged SQL against a C-collated disposable fixture and retain genuine RED evidence; do not relabel the locale-sensitive passing run.
- [ ] Add index definition/partial-predicate and four-mode contracts: Windows case/slash variants, POSIX case distinction, root/library/stale/inactive/off-page controls.
- [x] After RED, implement the migration and normalized-parent equality lookup; verify fresh install and valid/wrong existing-index replay. Online interrupted-build recovery remains open.
- [x] Verify dense EXPLAIN uses the normalized-parent index and materializes only affected folder context in all targeted modes; retain inventory parity. Rerun after the pending POSIX correction.
- [ ] Complete focused tests, two full relevant-diff reviews and exact disposable cleanup before proposing a live DDL checkpoint.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose known empty audio files and cross-record album conflicts within one physical folder through the existing Problematic Files surface.

**Architecture:** Extend the existing Postgres browse projection and reason generation. Compute mixed-folder context across active records before album selection or pagination; carry a boolean into each selected file row. Preserve known file size in compact projections. Use existing generic reason rendering and exclusion identities, with no new repair action.

**Tech Stack:** Python, Postgres, pytest; existing generic Problematic Files interface and client filter helpers.

## Global Constraints

- Owner approved `Empty audio file` and `Mixed album metadata in one folder` categories using the existing generic UI.
- No tag edits, file deletion, catalog merge, production writes, scan, media copy, deployment, or schema migration in this unit.
- Only canonical `local_track_files.file_size_bytes` exactly zero qualifies; unknown, absent, invalid, or positive sizes do not. Cached scan-entry size never overrides it: the existing fallback can synthesize cached zero from unknown canonical size.
- Folder identity is library ID, library-root ID, and normalized immediate physical parent. Do not collapse disc directories or compare only basenames.
- Different track artists within one compilation album do not create a mixed-folder warning.
- Mixed means multiple persisted album identities share one immediate folder; it does not claim duplicate audio or prescribe a catalog merge.
- Preserve existing permission/capability checks and client support of the generic Problematic Files surface. Web required; no new native-client surface or capability is introduced.
- All tests wait for the orchestrator's sole test lane; no parallel pytest/JavaScript/E2E execution.

## Delivery Boundary

Outcome and checklist IDs: PF-PHYSICAL-01 empty-file visibility; PF-PHYSICAL-02 cross-record folder visibility; PF-PHYSICAL-03 summary/detail/count/filter/exclusion parity.

Prerequisite evidence: private nine-folder audit distinguishes metadata splits, two empty files, and genuinely different tags. The separate subtitle/edition correction does not rewrite persisted catalog identities. The nine folders must not be described as duplicates.

Compatibility/rollback: additive reasons and projection fields only; no persistent schema or media changes. Revert this unit to remove the categories. Exclusion keys remain stable under the existing generic key format. No automatic repair controls for either reason.

Merge/publish checkpoint: independently reviewable unit on the existing accumulated branch; no automatic publication or history rewriting. Require focused RED/GREEN, isolated Postgres SQL proof, two complete local review passes, complete CI and owner manual acceptance before release.

## Task 1: Regression Contracts

Files: `tests/py/test_problematic_physical_file_categories.py`.

- [x] Author tests for exact-zero, absent/unknown/positive size, compact/detail parity, single-album projection retaining externally computed folder context, compilation artist variation, stable exclusion IDs and projection presence.
- [x] Add invalid-size cases and exclusion round-trip cases using the generic reason key helpers.
- [x] After test-lane handoff, run `python -m pytest tests/py/test_problematic_physical_file_categories.py -q`; retain expected missing-category failures before implementation.

## Task 2: Minimal Projection and Reasons

Files: `music_app/services/library_browse_postgres.py`.

Interfaces: compact and detail `file_size` carry canonical `file_size_bytes` without defaulting missing values to zero. `file_mixed_album_folder` carries a SQL boolean. `_problematic_file_entry_from_row` propagates these into file entries. `_problematic_album_reasons`, `_problematic_album_scope_reasons`, and `_iter_problematic_track_reasons` retain the same generic exclusion behavior as existing reasons.

- [x] Preserve canonical file size in both SQL projections and file-entry conversion without a new persistence source or cached-size fallback.
- [x] Add batched immediate-folder context over active source rows, scoped to bootstrap library and root. Global grouping is limited to inventory queries. Targeted reads seed selected immediate folders and load off-page companions through existing indexed private-path ranges before grouping. Group by library/root/normalized immediate parent; use `count(distinct album_id) > 1`. Do not reuse `_physical_album_container_sql`, which intentionally collapses disc folders for a different feature.
- [x] Include mixed-only and empty-only albums in candidate IDs before pagination. Join the same folder context into compact and detail file rows, including selected-ID and targeted-owner paths.
- [x] Add exact labels and identity codes `empty-audio-file` and `mixed-album-folder`; honor album/file exclusions and avoid adding a tag-repair field or destructive action.
- [x] Rerun Task 1 focused tests and the nearest existing Problematic Files contracts after obtaining the test lane.

## Task 3: SQL Boundary Proof and Handoff

- [x] Extend the existing isolated Postgres browse fixture with two otherwise healthy persisted albums sharing one immediate folder; assert both candidate IDs, filtered summaries/count and single-album detail contain the mixed reason.
- [x] Add isolated controls: different library/root with identical path text, separate `CD1`/`CD2` parents, stale sibling row, one compilation album with different track artists, zero-only file and unknown-size file. Assert only active same-scope immediate-folder conflicts and known zero files are selected.
- [ ] Use the unchanged real query path, not a mocked candidate result. Preserve the existing Problematic Files performance acceptance contract; inspect the bounded query plan if grouping changes threaten it.
- [ ] Perform two full relevant-diff review passes; fix validated findings and rerun focused checks.
- [ ] Hand owner a manual script: open Problematic Files, filter each exact category, inspect affected paths and album records, verify no automatic file/tag repair is offered, exclude one warning and confirm list/count/detail agree.
- [ ] Separately authorize and execute any deployment or real catalog refresh needed to expose current nine-folder facts. Until then report implementation/test status, not that those nine are already flagged in the live app.

## Evidence History

Initial RED executed after explicit lane handoff: Python unit author file **14 failed, 17 passed** in 1.78s, exit 1. Missing behavior includes canonical-zero warnings, mixed-folder flags/reasons, stable reason codes and repository count. Positive warning/exclusion cases currently receive no problematic payload because the categories do not exist. One invocation warning reports unknown `cache_dir` because pytest's cache provider was disabled. Repeated short RED invocations were needed to recover proxy-compressed output; they did not change source or expectations. Generic client filter tests **5 passed** in 205ms, exit 0. Scoped elevated process audit found no matching remaining Python/Node test processes; lane returned to the orchestrator.

At the initial RED checkpoint, SQL was not executed because isolated URL variables were absent. This historical limitation was resolved by the verified disposable SQL follow-up below. No live records or media changed.

Implementation now authored in `library_browse_postgres.py`. Focused unit/nearest seam run: **148 passed, 233 deselected**, 5.88s. Initial nearest-seam failure detected a third source-table scan; implementation now shares the existing `active_problem_rows` CTE and preserves the two-scan assertion. One structural query assertion changed from two permissive singleton-library predicates to one plus explicit bootstrap-library/active-root ownership checks; this reflects the approved strict scope, not a changed user acceptance condition. Review must inspect that change explicitly.

Disposable SQL verification attempted through the existing Windows bootstrap helper. Runner exited before state/environment artifacts or SQL tests; failure cause not yet recovered because the host proxy replaced stderr with an unavailable compression marker. Scoped process audit found no surviving owned test processes. No SQL success claimed; the runner now retains failure evidence before a later authorized retry. No production/shared-sandbox data was used.

Independent read-only PostgreSQL catalog audit returned zero databases and roles matching this runner's `physical_` generated-name prefix, proving no disposable resources remained. The runner now retains its exact suffix before provisioning for subsequent identity audits.

### Verified isolated SQL follow-up

On October 5, attempt `physical_20261005_04` provisioned a uniquely owned disposable database through `scripts/ci/bootstrap-windows-postgres.ps1`, applied current migrations and seeded only the standard bootstrap owner/library before the transaction-owned test data. **Real SQL contract: 1 passed in 1.70s.** Evidence is retained privately under `tmp/physical-category-sql-20261005/stdout-04.log` and `teardown.log`.

Earlier setup failures were harness prerequisites: Windows PowerShell lacked `Get-FileHash`; using installed PowerShell 7 resolved that. The helper's default admin password did not match local configuration; reusing the existing local E2E pgpass extraction contract resolved that. No test expectations were changed for these failures.

Teardown dropped the exact disposable database and three generated roles. Independent catalog verification returned database count 0, role count 0 and active-connection count 0; state artifact removed. Exact launcher PID 35048 and owned descendants were absent. Detached launcher OS exit status was not retained; pytest success and completed teardown are the retained evidence. No performance claim is made from this functional run.

Current verification: Python focused **148 passed**, real SQL **1 passed**, generic JS **5 passed**. Independent full-diff reviews, relevant performance assessment, owner manual acceptance and CI/release gates remain open. No production data or music files were changed.

Additional authored SQL test: `tests/py/test_problematic_physical_files_postgres.py`. It reuses `isolatedPostgres.resolve_isolated_database_urls`, requires an already provisioned isolated database, inserts uniquely named rows inside a rolled-back transaction, and never provisions, resets, or starts a database. It exercises actual candidate-ID, selected-ID page, and detail SQL for mixed and zero-only records, with library/root/stale/inactive/disc-directory/compilation/unknown-size controls. Canonical/cached size disagreements are explicit. Foreign and inactive scopes each contain genuinely conflicting pairs and empty files. Compilation has two distinct track artists. Overlapping root controls use physically valid shared containment.

The backend returns a full cached list and count; category filtering belongs to the client, not a separate HTTP filter endpoint. The Python author file now covers actual repository list/count/cache invalidation after the final file warning is excluded. `tests/js/runtime/utility-problematic-tab.test.js` exercises the existing generic category filter for both new reasons, all affected album records, combined filters and post-exclusion counts. Healthy unit controls accept the existing `None` payload contract.

After lane handoff, run `python -m pytest tests/py/test_problematic_physical_file_categories.py tests/py/test_problematic_physical_files_postgres.py -q` with the existing isolated setup/runtime URL variables and `PGPASSFILE` configured. A skipped SQL test is not SQL proof.

Then, sequentially after pytest exits, run `node --test tests/js/runtime/utility-problematic-tab.test.js`. The initial unit RED, generic JS and functional SQL results are recorded above.

### Targeted-query review correction

Independent full-diff review found that global materialized grouping on detail/selected-ID/targeted-owner/duplicate reads would defeat their bounded lookup behavior. New scoped-query contracts failed **4/4** before correction. The fix seeds selected physical folders, uses existing indexed prefix ranges for off-page same-library/root siblings and limits global grouping to inventory queries. Focused unit/nearest seams now **152 passed, 233 deselected**, 2.98s.

The dense isolated EXPLAIN contract checks every targeted mode with 3,001 unrelated files: selected physical context must contain exactly the two affected records and the plan must include private-path range index conditions. Attempt `physical_20261005_05` passed both functional SQL and EXPLAIN tests: **2 passed**, 5.72s, launcher exit **0** retained. All four targeted modes materialized exactly **2 context rows**, with **1 or 2 private-path range index nodes**. Exact disposable database/roles/connections and owned process tree were absent after teardown. This is bounded-query proof, not an elapsed-time UI performance claim.

Subsequent root review identified a remaining Windows-case boundary: normalized grouping case-folds Windows paths, but raw indexed prefix bounds can omit a same-root sibling stored with different casing. A real SQL regression now compares global candidate detection with all four targeted modes for both records. No schema or fallback workaround is authorized yet. Owner choice is pending between a normalized-folder index and a slower root-scoped fallback. Preserve the successful raw-case EXPLAIN evidence without treating it as proof for arbitrary Windows casing. Owner manual acceptance, post-fix review and CI/release gates remain open.
