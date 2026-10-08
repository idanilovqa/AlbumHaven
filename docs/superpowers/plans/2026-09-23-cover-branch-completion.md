# Cover branch completion

## Current release authority and repair checkpoint — 2026-10-07

The owner's later instruction to finish and release this branch authorizes the
0.9.49 merge and stable publication after the required gates pass. It supersedes
earlier instructions in this plan and its predecessor to leave PR21 unmerged,
pause after a checkpoint, or treat application publication as unauthorized.
Those dated checkpoints remain historical evidence, not current restrictions.
Keep the owner-authorized `skip_reviews` waiver; never add `skip_tests`.

Current published application head is
`6b7baffdeee4dcb1ba07baffe2a141f12317e7bc`; PR21 remains open. Version remains
`0.9.49`, and active test-data consumers retain immutable `fixtures-v1.0.25`.
The complete native PR pipeline
[37711113585](https://github.com/idanilovqa/AlbumHaven/actions/runs/37711113585)
finished with failures on that exact head. All four performance profiles,
production parity, Auth Lifecycle and Admin Management passed. Eight test jobs
failed; Cloud Verification Gate failed downstream. This is not green CI or
publication evidence.

The complete failure inventory is retained in
`.tmp/ci-37711113585/FAILURES-COMPLETE.md`, with final job JSON, exact logs and all
57 retained artifacts. Failures cover component discovery/ownership counts,
the startup-hydration rejection fixture, two Python source inventories, and a
shared functional-fixture credential-row restoration failure. Retained logs
also expose a background gallery-summary startup `Event` call error despite
passing performance jobs. The functional shards stopped after their first
passing case when restoration failed; their remaining cases are not passes.

Locally verified inventory/fixture repairs are uncommitted at this checkpoint:
the two approved startup-progress widths now have ownership rows, component
discovery remains strict at 193 cases and total ownership at 420; the browser VM
models startup-failure feedback and asserts one failure notification versus
zero on cancellation; migration and runtime-script inventories explicitly
include 0086 and `startup-progress.js`. Exact failures were reproduced before
repair. Related JavaScript verification passed 209 tests; the two exact Python
cases passed after failing locally. Evidence and reviewed source hashes are in
`.tmp/ci-37711113585/REPAIR-SCOPE-VERIFICATION.md` and
`repair-scope-reviewed-sha256.json`. These focused results do not close the
remaining repair batch or replace complete CI.

Delivery checkpoint: finish every validated repair and its focused verification,
reassess the resulting diff, commit the entire local batch, then push once to a
new complete native PR pipeline. Collect every required job result before the
next repair batch. Preserve existing startup/gallery/search cases `005S`, `005T`
and `005U`, their completeness assertions and timing budgets. Only a successful full
pipeline permits merge, stable publication and main synchronization. Production
promotion additionally requires the owner's requested legacy schema/permission
repair, final release-pinned migration inventory through 0086, and verified
deployment under the production runbook; none is established here.

Sandbox4 usability evidence is separate from release acceptance. After the
guarded launcher restart (PID 34780), authenticated Neal Morse Cover Lookup
returned 200, and three local cover cards visibly rendered without browser errors
at the port 5004 HTTPS URL. Evidence:
`.tmp/lookup5004-live-1791423906239/evidence.json` and `cover-lookup.png`.
The probe's seven image elements can include auxiliary images; the screenshot
verifies three local cover cards while the remote placeholder remains loading.
This does not prove migration 0086 is installed on the shared database, a ready
summary's real-data startup improvement, or production readiness.

### ROOT01–ROOT05 durable gallery summary delivery (0.9.49)

Owner approved including accurate Postgres-owned counts, ordered membership and revision invalidation in 0.9.49. Outcome: ready root requests read the complete lightweight sidebar/totals and an indexed bounded occurrence page without re-evaluating every file or hashing every occurrence. Store exact canonical ordering and the existing content hash; retain eight initial album occurrences, fifty ordinary continuation occurrences (1–100), complete sidebar, category/featured/missing/loose-track semantics and current cursor `[1, revision, offset]`. Reuse the current SQL and Python selector as the semantic oracle, existing bounded album hydration, and account-private rating overlays. No new search behavior or timing budget.

Prerequisites: cover-only/rating/presentation writes must not invalidate membership; every membership/order mutation must invalidate within its database transaction, including full/targeted scans, stale files, structural and ordering tag edits, exception saves/deletes/intent recovery, artist/featured/alias changes, missing removal and consumed category provenance. Current relation fingerprint and inventory revision are not complete gallery authorities. Use a dedicated per-library source generation and statement-level dependency invalidation compatible with older supported writers; avoid one generation update per file. Scope summary by resolved library and normalized root filters, never cursor-supplied access. Publish generation, exact sidebar/totals/hash and occurrence rows atomically after locked source-generation recheck; stale-to-stale mutations supersede builders.

Lifecycle: proactively prepare supported root scopes through the existing startup projection-readiness lifecycle. Browsing reads a ready same-snapshot summary or falls back to the current accurate computed path; it never serves stale counts or launches repeated expensive request-time rebuilds. Shared read-only port 5004 does not apply migrations or build shared derived data implicitly; maintenance remains separately coordinated. Transient scan pages retain their existing scan-generation namespace. Failed/cancelled publication leaves accurate fallback available. Cover/ratings continue live hydration and do not change cursor content revisions.

Acceptance and delivery checkpoint: add failing focused guards and oracle-equivalence cases first; use uniquely owned isolated Postgres for transaction rollback, every mutation dependency, neutral cover writes, superseded publication, account/library/category scope and cursor compatibility across computed/ready paths. Preserve exact full sidebar and hydration bounds. Complete focused tests, two independent full-diff reviews, then unchanged native ROOT006/startup/search verification and the complete existing CI repair flow. Root owns test-lane scheduling, live deployment and final release gates; no migration or data write against shared/production during implementation. Reversible expansion: new derived objects retain source data; old readers ignore them, and rollback restores computed reads before removing derived objects. The prepared source design is `.tmp/gallery-summary-design.md`; this entry owns approved scope and acceptance.

#### Implemented summary contract and focused evidence — 2026-10-07

Migration `0086` adds derived per-library generations, scope headers, and ordered
occurrences. Scope identity preserves category order. Readiness requires matching
source generation and builder version; old schemas and stale summaries use the
unchanged computed selector. Database statement triggers cover older writers and
coalesce invalidation within a transaction. Publication rejects source-writing
transactions and superseded generations. No source records are replaced.

Startup prepares the default and new-arrivals scopes. Successful full-scan and
queued-update publication schedules refresh through the existing cache executor.
Concurrent refresh requests retain one trailing refresh; captured summaries retain
only the latest pending generation per library/scope. Other category orders publish
their accurate computed snapshot after browse. Shared read-only configuration never
builds or publishes a summary. Ready pages hydrate at most the requested occurrence
count, with one bounded query for distinct missing-album keys.

Final focused evidence: 66 gallery, pagination, and cache lifecycle checks passed
in 2.39 seconds. Five isolated PostgreSQL browse checks passed in 56.36 seconds
with no skips, including default/new-arrivals scope, all 15 ordered category
combinations, 8/50 page parity, interoperable cursors, cover neutrality, bounded
missing-album hydration, and the exact migration 0082 missing-removal case.
The earlier category-permutation run used an ignored parameter and is not
category coverage; the final run supplies `category` and asserts normalized
scope identity. Fourteen isolated mutation checks passed in 89.21 seconds,
covering eight source-update boundaries, exception/file deletion, stale-to-stale
invalidation, rollback/savepoints, superseded publication, snapshot isolation,
and read-only grants/runtime behavior. Invalidation uses epoch-safe `xid8` to
coalesce once per source-writing transaction; publication from that same writer
is rejected. Two final full resulting-diff review passes found no validated
remaining issue. Disposable databases, roles, and owned test processes were
removed. These are focused proofs, not complete CI or a real-data ready-path timing.
Fresh native synthetic verification passed all four cases: 005S root-gallery
visible readiness at 2792 ms; 005T app-open readiness at 1963 ms and sidebar
hydration at 25 ms; 005U Devin at 456.4 ms (grace-used) and Neal Morse at
375.9 ms (target-met). Search retains its 400 ms target and 500 ms hard ceiling.
The shared fixture was loaded once; the disposable database, three roles, and
owned application/browser/test trees exited after the sequential run. Evidence:
`.tmp/gallery-summary-native-performance.log` and retained metrics group
`paired-search-calibration-1791421048207`. Complete native CI remains mandatory.
The shared 5004 database still lacks migration `0086`; its computed fallback remains
accurate. Native acceptance remains the existing 005S root browse, 005T app-open,
005U paired complete-search, and functional root pagination cases; budgets are
unchanged. Migration `0085` and `0086` supplement the earlier historical 0081–0084
migration inventory below. Final release and authorized writable readiness setup
must precede real-data summary timing.

### ROOT01 existing exception-index candidate — 2026-10-07

Outcome: avoid reading every active file's metadata during root membership eligibility by reusing the existing active-file covering index and scanned-exception partial index. Materialize the exact stored-exception candidate file identities and values; retain the existing override CASE and join candidates by both track ID and unique file path. This changes only root membership's stored-metadata lookup, without DDL, cache, API, forced planner settings, or threshold changes. Preserve MATERIALIZED shared eligibility, lowest-ID track override, explicit NULL clearing, path override without an exception key suppressing track fallback, stale-file handling, featured occurrences, category filters, missing albums, complete sidebar/totals, ordering and revision hashing.

Acceptance: first prove the indexed-candidate guard fails; use isolated existing fixtures for exact old/new rows and independent expected memberships including all override precedence and duplicate-file cases; compare real-data digests for every category in one read-only snapshot, ABBA timings and unchanged EXPLAIN settings. Keep only a consistent measured improvement. Reuse root paging/eligibility coverage and retain unchanged native startup/ROOT006 acceptance. Rollback removes this root-only candidate and its focused tests together. Commit/push remains within the complete repair batch after review and verification; no restart or publication in this experiment.

Candidate rejected after measurement: two focused guards failed before implementation, then 24 related checks passed. Real-data exact membership digests matched for all/main/hoard/new-arrivals in one read-only snapshot. The plan used the existing exception index for three rows and active covering index for 159545 rows, reducing file-read blocks from 49870 to 7049 (4960 visibility heap fetches). Despite that intended mechanism and faster EXPLAIN (1046 to 830 ms), normal ABBA wall times did not improve consistently: all baseline 2276/1162 versus candidate 2817/1358 ms; new-arrivals 1208/1401 versus 1652/1466 ms; main and hoard varied or improved. Therefore source and candidate-only tests were removed. Prepared isolated override/duplicate-file cases were retained privately but not executed because rejection removed the need to create a database. Evidence: `.tmp/root-indexed-exceptions-{red,focused,measure}.log`, `.tmp/root-indexed-exceptions-measure.json`, and `.tmp/root-indexed-exceptions-candidate.patch`. No DDL, shared-data write, planner override, budget change, or deployment occurred. This records an unsuccessful optimization attempt, not a startup fix.

### ROOT01 album-grain membership candidate — 2026-10-07

Outcome: reduce the materialized eligibility intermediate in bounded root startup while preserving exact full membership, sidebar, totals, ordering, and cursor revision. Current normal-server evidence attributes 1.19–1.26 seconds to root membership SQL. Reuse the existing eligibility SQL builder with an explicit album-only projection, following the album-grain form already used by the older startup query; retain MATERIALIZED, active-file and override predicates, featured-artist ownership, category filters, missing albums, loose tracks, and page-bounded hydration. No cache, schema, endpoint, permission, or acceptance-budget change.

Prerequisites and acceptance: prove the album-grain guard fails first; compare exact old/new membership rows in isolated semantic cases and a single read-only real-data snapshot; retain all root-pagination cases and unchanged ROOT006/startup contracts. Measure old/new query plans and reject the candidate if it does not improve the measured path. No product implementation before red proof. This is a candidate, not a performance success claim. Rollback restores the root eligibility projection and its focused guard together. Commit/push remains part of the current complete CI-repair batch after focused verification and review; no separate release or deployment is authorized by this entry.

Candidate rejected: the guard first failed against track-grain materialization; the candidate passed 24 focused checks. Read-only repeatable-read comparison preserved exact row digests for all 17003 memberships and each category. ABBA measurements did not establish a consistent improvement: all-category baseline 850/1682 ms versus candidate 1138/1342 ms; main-library 1209/863 versus 1219/1089 ms; new-arrivals 539/839 versus 958/952 ms; hoard 655/652 versus 566/549 ms. A faster candidate EXPLAIN (627 versus 809 ms) does not override those mixed normal executions. Source and candidate-only tests were removed; the prepared isolated test was not run because rejection made further fixture setup unnecessary. Private evidence: `.tmp/root-album-grain-measure.json`, `.tmp/root-album-grain-measure.log`, `.tmp/root-album-grain-focused.log`. No database writes, deployment, or budget change occurred. Existing membership SQL remains authoritative; this investigation does not close startup latency or the intermittent search spike.

## October 5 continuation evidence

Cover display previews now use shared album-adjacent storage at
`<album-directory>/.album-haven/cover_variants/...`; the app data directory and
browser storage are not used for these files. A single throttled
`CoverPreviewBackfill` worker enumerates distinct Postgres album cover paths,
continues across rescans, pauses after foreground request activity, and stops
cooperatively during ASGI shutdown. Existing foreground and interactive cover
requests retain their priority lanes. Focused preview, route, queue, lifecycle,
and shutdown tests pass.

The startup preview balancing query now counts distinct `(library_id, album_id)`
pairs when several selected artists share an album, preserving the eight unique
album limit. Database identity status keeps the successful opaque identity for
60 seconds and refreshes the catalog count after expiry; transient failures are
still retried on the next request. The paired production/synthetic calibration
run `paired-search-20261005-143219-9c009206` remains the authoritative search
evidence: Devin 1059.2 ms production / 322.3 ms synthetic, Neal Morse 768.5 ms
production / 194.2 ms synthetic.

## Current integration checkpoint вЂ” October 4, 2026

Current `origin/main` (`eef9d13f`, release 0.9.48) is merged at `2e016251`.
That merge includes the separately completed mobile-layout and Admin/capability
branches. Conflict reconciliation intentionally favors their mobile and
capability behavior while retaining this branch's approved desktop/web visual
work. Commit `6b285822` restores the merged mobile/shared styles and reapplies
only the three required desktop rules. No Admin or capability behavior is
overridden by the remaining branch diff.

Post-merge repairs are committed separately: `de537f8a` resumes suspended cover
loads after cached Scan Page replacements render and removes duplicate tests;
`8bb3f5c1` accepts the documented dedicated `album_haven_scan_e2e` database only
with its exact expected role. The last pushed head remains `91b334fc`;
artist-search, migration, startup, and pass-3 review repairs after that head
remain local working-tree changes. Against `origin/main`, the settled candidate
has 74 tracked files with 6,438 additions and 654 deletions, plus five intended
untracked source files totaling 479 added lines. The exact delivery manifest is
therefore 79 files, 6,917 additions, and 654 deletions. Local
`.codex-restart/**` diagnostics and the mock-preview PID are excluded from those
totals and from the delivery manifest.

The test-data checkout's two local 706-fixture commits are already represented
in released source `b24265f`; that released source differs only by eight stricter
fixture assertions. The stale local fixture branch therefore has no unpublished
fixture content to promote for this release. The private owner checkout contains
broad unrelated interleaved edits; no whole file is owned by this branch, so it
remains untouched.

Focused integration evidence is green: CSS contracts 111/111; Scan Page runtime
147/147; duplicate-test selections exit 0; E2E production parity passes; and
the database-identity selection passes 74 Python tests, including wrong-role
rejection. FTC-OPS-017 then passed unchanged on its single diagnostic rerun:
cached browse 531 ms, stable 544 ms, and search 446.4 ms, each below the original
1000/1000/1200 ms hard ceilings. The reporter finalized, metrics and functional
checks completed, and the policy result is `passed`; the earlier
`reporter-finalization` record contained no measurements and was a transient
pre-measurement harness failure.

Post-integration review found and repaired three Important issues: the desktop
Gallery toolbar surface is now scoped above 900 px so merged mobile styling wins;
the shared AlbumCard locator now forwards `{ visible: true }` and cannot settle
cover readiness on a hidden stale card; and the established visible Artist Family
Combine-row hover assertion is restored. The two new RED contracts failed for
the intended missing behavior, then passed together at 75/75 after the fixes.

Release metadata is now prepared for 0.9.49 because 0.9.48 is already on
`origin/main`. Remaining work: final post-integration review and focused checks,
commit and push the application branch, open a new application PR with
`skip_reviews` and without `skip_tests`, collect and fix the complete native CI
failure inventory, merge only after the full pipeline is green, publish 0.9.49,
then synchronize and deploy the verified release under the deployment runbook.

### Artist-search performance delivery

Outcome: show the first expected album for `Devin` and `Neal Morse` within an
800 ms target, 400 ms grace band, and 1200 ms hard ceiling on the real production
dataset. The measured interval starts immediately before explicit submission by
Enter or the search button; it does not include a measured type-ahead debounce.
Typing remains explicit-submit only. The clear X changes only the input until an
empty query is submitted. Clicking a recent-search suggestion submits it
immediately. The interval ends after the exact search response has a later
request generation, its album is visible in a later render generation, and the
current query is exact.

Included acceptance work: preserve complete multi-alias artist previews, raw
metadata and path-derived non-album matches, all-stale missing-album detection,
active-album suppression, category filtering, and the existing single
repeatable-read snapshot. Synthetic performance remains a fast regression gate.
Immediately after satisfactory real-data Devin and Neal Morse behavior, run the
equivalent synthetic benchmark and calibrate its documented expectations against
that paired journey. Synthetic timings are correlated evidence, not a claim that
synthetic absolute latency equals production data. They do not replace paired
real-data evidence.

Prerequisite `0067_add_scanned_exception_candidate_index.sql` was absent from
the production migration ledger even though release 0.9.48 contains the file.
The production runbook skips automatic historical migration replay because the
ledger contains renumbered and incomplete history. The owner authorized an
online application on October 3. The exact migration checksum now matches the
ledger, the partial index is valid and ready, and no app restart occurred.

Implementation boundary: consolidate missing-album text matching into the
existing broad search SQL and return active-preview and all-stale partitions
from the same snapshot. Keep the standalone missing-album loader for root browse,
details, Problematic Files, and rollback. Do not add a cross-request process
cache in this delivery; its invalidation contract would require a separate
database-owned projection revision and technical design.

Acceptance cases: focused RED/GREEN contracts must cover album, artist,
featured/raw credit, alias, track-title, filename/stem, wildcard and backslash
matching; mixed active/stale exclusion; category filtering after complete-row
hydration; selected-artist reuse without a second missing query; no private-path
payload leak; and one-snapshot consistency. Final evidence requires paired
real-data server profiles and the unchanged visible-result performance E2E.

Compatibility and rollback: this delivery now includes four unreleased upgrade
migrations. Apply them before deploying the matching application code. `0081`
restores the narrow runtime `DELETE` grant used by root-setting replacement;
revoke it only after rolling back that writer. `0082` replaces the missing-album
removal function while preserving relation readiness; rolling it back means
reapplying the `0063` function and accepting a relation rebuild, and it cannot
restore inventory rows already removed by a confirmed operation. `0083` adds an
online concurrent trigram index and therefore runs outside a transaction; its
rollback is `DROP INDEX CONCURRENTLY`, after which the same search remains
correct but may be slower. `0084` transactionally adds the artist-search
projection table, canonical-scope B-tree, replacement function, and grants. Roll
back application code
before dropping those objects so a current relation-ready marker cannot direct
the old process to a missing projection table. The existing live-SQL path
remains the runtime fallback when projection readiness is absent, stale, or
incompatible. None of `0081`вЂ“`0084` is committed or released from this branch
yet. Retained artifacts do not prove the production migration-ledger state for
any of the four, so release rollout must verify each filename and checksum
rather than infer application from a working sandbox.

The owner explicitly approved applying production migration `0084`, including
the projection table and the bounded `SECURITY DEFINER` replacement function
grant executable by `album_haven_app`. That approval does not waive the
deployment runbook or exact filename/checksum validation.

October 4 continuation checkpoint: production-backed sandbox1 now uses
nonblocking Postgres startup, a narrow healthy projection probe, pooled login
and pre-auth connections, first-keystroke cover-load suspension, request-local
lazy alias normalization, and a narrowed relation-alias snapshot read. A
nonlocking session-read experiment was discarded after it produced no measured
browser gain and weakened strict revocation ordering; all authenticated requests
retain the existing exclusive account/session locks. Focused evidence is green:
95/95 gallery-handler JavaScript tests and 15/15 adjacent search
snapshot/category tests. Direct Devin preview profiling fell
from 194ms and about54k calls to 133ms and about15.7k calls before the narrowed
alias JSON read; a later local authenticated HTTP sample was154ms total with a
141ms route.

Retained October browser evidence does not yet measure the new first-visible
contract. The two retained October 3 probes waited for the applied query to be
idle and therefore measured full settlement: `measure-real-search-current`
recorded Devin at 1814.6ms and Neal Morse at 2479.6ms; its network-instrumented
companion recorded 1608.5ms and 2506.6ms. They used the production-backed
sandbox path. Their stdout SHA-256 values are respectively
`8715e5b487baf07f538c22670d576a0e0b5cea2887b210fc2066ca8db7b3782b`
and `a42a6f12f9537bbbdd90a286c42377e1c9e82dde136df591c96c3021ccef66ea`.
They are useful diagnostics, but are not samples for the new
submit-through-first-visible-album metric. The previously noted 1051.6ms and
935.9ms pair has no retained artifact and is removed from the evidence record.
The first-visible baseline, range, and sample count remain unknown until the
paired Devin and Neal Morse acceptance test produces retained metrics. Server
logs separately show preview-route variability; those route durations are not
browser measurements and are not substituted for the missing sample. Do not
retry for a passing sample. The current owner-approved 800 ms target, 400 ms
grace, and 1200 ms hard ceiling supersede the earlier 1000 ms ceiling; the
historical executed values above remain history. The remaining responsible design is a database-owned normalized
artist alias/search projection, published atomically with relation readiness and
joined from the same repeatable-read snapshot. The owner approved that
schema/projection change on October 4, 2026; stale or absent readiness must fall
back to live SQL. A process-local cache remains
out of scope because another production-backed process can invalidate the shared
projection without notifying this app instance.

October 4 pass-3 release checkpoint: the candidate is still unreleased. The
changelog now says `Unreleased`; no staging, commit, push, PR, hosted CI, merge,
tag, publication, or deployment is claimed. The Render demo migration runner
now validates nontransactional `0083` before ledgering it and, after a failed
concurrent build, drops only the named invalid index concurrently before
rethrowing so the next startup can retry. Its focused RED failed because no
cleanup occurred; GREEN passed, and the focused Render test file passed 32/32.
The existing live `0082` success test already checks the blocked unhealthy-root
path, album/track/file deletion, one revision increment, byte-for-byte retention
of the relation views/projection/build metadata, and retained `ready` status, so
no duplicate test was added. A local attempt skipped because dedicated isolated
Postgres URLs are not configured; that skip is not recorded as passing live
evidence. The first-visible benchmark formatter now reports null and blank
baseline/range values as unavailable rather than `0 ms`; its RED reproduced the
false zero and the focused benchmark file passed 14/14 after the fix.

The later staging manifest is all tracked candidate changes plus only these five
currently untracked source files:
`migrations/postgres/0081_grant_move_policy_settings_delete.sql`,
`migrations/postgres/0082_preserve_relations_for_missing_album_removal.sql`,
`migrations/postgres/0083_add_album_raw_artist_search_index.sql`,
`migrations/postgres/0084_create_local_artist_search_projection.sql`, and
`tests/py/test_nontransactional_postgres_migrations.py`. Exclude every
`.codex-restart/**` diagnostic and
`docs/design-mockups/screens/remaining-ui/v001/preview.pid`; do not add ignore
rules for either class. Before any future commit, verify the cached diff contains
none of those excluded paths.

October 4 cold-search continuation: the first production-backed `Devin`
preview still spent `56,500.41 ms` in the server. An instrumented real-data
profile located `98,600 ms` under `_load_live_relation_alias_maps`, including
rebuilding relation views from all `407,331` source rows. The ready `0084`
projection had no exact `Devin` key, and the preview path treated that valid
partial miss as proof that it must rebuild the live alias graph. The repaired
path checks the database projection's current readiness metadata in the same
repeatable-read snapshot and lets the bounded broad search handle partial
queries. It retains the live rebuild only when the projection is absent,
stale, or incompatible. Focused RED reproduced the 407k-row fallback; focused
GREEN passed 5/5 current, stale, and exact-projection cases.

After a clean sandbox1 restart against the production database, the cold
`Devin` preview route completed in `209.87 ms` and full hydration in
`341.09 ms`. Direct real-data previews completed in `425.77 ms` for `Devin`
and `349.96 ms` for `Neal Morse`. A normal Enter-submission browser diagnostic
measured first visible results at `1,093.5 ms` for `Devin` (`grace-used`) and
`767.5 ms` for `Neal Morse` (`target-met`). The authoritative paired run has
not passed yet. Cloudflare injected one Insights script request and three RUM
posts, which the benchmark's forbidden-request assertion recorded, and the
fresh second browser waited 120 seconds for initial gallery-cover readiness
before submitting `Neal Morse`. Synthetic calibration therefore has not run.

## Current verification checkpoint вЂ” September 23, 2026

All introduced acceptance scenarios are now green, including real full-app FTC-OPS-003G failure/recovery and the released-706 Problematic Files case under its approved temporary performance ceilings. Three complete local review passes are finished; no completion push, PR or hosted CI run has started.

Retained verification logs are under `C:\Users\Rendref\AppData\Local\Temp\codex-tag-tree-28d8f76df7f84fb88323eddfe80d3969`. Canonical case identities remain unchanged; the explicitly approved temporary cold-request budget is recorded below.

| Acceptance | Latest passing evidence |
| --- | --- |
| Artist Tree | `treeFixed`: 14.8s, wrapper 24.9s; 1400px column gain, 1060px three-column no-gain, original visible anchor/trigger within one pixel, query/selection, persistent player, repeated folding/reduced motion. Processes, ports 22035/22037, database and roles clear. |
| Edit Tags025 | `tags3`: 48.4s; native selection/modifiers, grip-only first/middle/last/append and keyboard reorder, selected identities, non-grip/outside no-op, Escape, Cancel, persisted Apply. |
| Album Details019/022 | `playbackbatch2`: desktop/layout/width/narrow flow passed, approximately 1.2m including restoration. `touch`: 46.2s; full artwork and Cover Lookup opened by touch without hover. Touch processes, ports 40226/40228 and database/roles cleared. |
| Cover composer024 | `coverbatch5`: 37.6s; native picker/drop/image clipboard, failing extraction retention, extensionless image/hash, narrow layout, exclusive selection and staged removal. |
| Notifications007 | Dedicated toast entrance geometry/layering/Delete: `coverbatch4`, case 37.3s/wrapper 47.2s. Actual bulk flow: `bulk007fixed`, 1.6m/wrapper 1.8m; native selection/copy, Enter/Space exact album, save/frozen elapsed, no-result/failure, clear-finished preserving active jobs, reload/cancel/final deletion. Cancellation took 7.535s; owned cleanup audited empty. |
| Library Status Page | `scanPagePair`: canonical C+E target 2/2, 36.7s/5.8s, total 45.1s; finalStatus=passed/processStatus=0. Real nonempty phases/completion, one request per regular/full cancellation, Browse/Back, GalleryBar lifetime/player retention. Processes/port38898/database/roles clear. Natural health003F: `scanhealth5`, 9.0s/wrapper11.4s, dismissal and persistent warning/return; port53362 and owned state clear. |
| Settings/Appearance | S06: 20.2s invocation, Rules/Integrations/Appearance matching/no-match/clear, independent queries and unsaved editor retention. A01: approximately1.2m, Save/Cancel/reload, disabled Mobile/TV and safe restoration. Broader private A01 matrix remains planned. |
| Combined player019вЂ“022 | `combinedPlayer4`: 57.9s/wrapper1.1m; startup/audio, regular/waveform, Loop editing/cancel, accepted docked/rail/floating, artwork activation/drag, reload/narrow and second-tab disabled-Play ownership. Expanded skip nodes absent; compact skip controls hidden. Processes/ports31090/31092/database/three roles clear;1497fixture files unchanged. |
| Visual/component coverage | `visualverify`:49 cases passed with pinned Chrome151 and no snapshot updates after inspection of ten player/anchor images. `anchorResync`: native nested scroll/resize/edge/close/reopen passed1.3s (2.9s invocation), cleanup clear. Two real Library Status error/cancellation component cases passed2/2 in4.2s; these are not full-app terminal-error E2E. |
| Backend seams | `backend2`:15 passed/115 deselected,4.21s; `backendcovers`:88 passed/66 deselected,9.97s. Overlapping selections cover extraction, authorization/stale task/album identity and snapshot/save conflicts; not103unique tests or a full Python suite. Sole pytest processes exited. |
| Problematic Files | Fresh canonical released-706 run `2026-09-23T22-31-29-334Z`: 1/1 passed in 23.2s on its sole attempt. Cold API1883.96ms used the approved grace and remained below2000ms; readiness672ms remained below1400ms; cached enter/exit/reenter141/160/141ms, search126ms, longest filter383ms, payload2,040,096bytes,706items/23mounted. PID/tree, ports51086/51088, database and three roles clear. |

### Performance acceptance and diagnostic evidence

Latest canonical result: **cold API1883.96ms<2000ms and readiness672ms<1400ms**, so FTC-UTIL-PROBLEMS-009 passed under the owner-approved temporary ceilings. The released-706 case ran once under `local`, without retry/recovery: case23.2s, one passing test and zero errors. Payload2,040,096bytes passes2MiB; all functional and non-timing checks completed with706items/23mounted rows. Cached enter/exit/reenter141/160/141ms, search126ms and longest filter383ms also passed. Metrics: `test-results/playwright-performance-targets/utility-problematic-files/history/utilityProblematicFilesLocal/runs/2026-09-23T22-31-29-334Z/metrics.json`; logs: `%TEMP%\album-haven-canonical706-cold2000-warm1400.stdout.log` and `.stderr.log`.

Historical repairs2 result: **1453.852ms cold API > 1200ms hard ceiling**, the sole failure in FTC-UTIL-PROBLEMS-009 (22.211s, local contract, one attempt, no recovery). That run used 1000ms target plus 200ms grace and remains recorded as failed. Payload 2,040,096 bytes passes the 2,097,152-byte guard; all 706-item functional checks pass, with 23 mounted rows. Other measurements met their targets: readiness 678ms, cached enter/exit/reenter 145/166/166ms, search 113ms, slowest filter 309ms. This is not proof of a reliable performance improvement.

The owner explicitly approved temporary contracts: **cold1000ms target +1000ms grace =2000ms hard ceiling** and **initial readiness1000ms target +400ms grace =1400ms hard ceiling**. Cached enter/exit/reentry remain unchanged at1000ms target +200ms grace =1200ms hard ceilings; functional and payload assertions remain unchanged. Phase 9 follow-up `P9-PERF-001` must restore the original1200ms cold ceiling or obtain explicit owner disposition before closure. Contract synchronization passed80/80 focused checks, and fresh canonical verification passed as recorded above. Preserve all earlier runs as historical evidence; this temporary acceptance does not establish a reliable product performance improvement.

Historical native2 evidence: The native first-Settings-fetch boundary and approved 2MiB guard are exercised. The final native2 case completed in27.2s: authentication, cold rebuilt response,706summary/detail, payload and functional checks passed; cold latency1882.737ms still exceeds1200ms. Focused53+145 checks/parity passed. Earlier native1846.22ms is retained as historical same-boundary evidence, not a demonstrated improvement.

Problematic Files706 now passes the approved temporary acceptance contract on the single canonical run above. Historical canonical native2 cold GET remains **1882.737ms>1200ms**, case27.2s. Payload1,787,328bytes passed2MiB; ready630ms, cached120/138/154ms, search125ms and filter434ms met their budgets. Logs `utility706native2.stdout.log`/`.stderr.log` are retained in the common evidence directory. PID49532/tree exited, ports36612/36614 clear, isolated database/roles0 for suffixc184871ff2eb. Historical repairs2 and cold1800 failures remain valid under their executed contracts. The new passing result reflects the explicitly widened temporary ceilings; it does not prove a performance improvement or authorize an architecture change.

Earlier instrumentation measured server1376ms/browser1929ms and1,787,328bytes. The owner approved the **2MiB (2,097,152-byte)** test/report guard, now passing canonically; it is not a runtime cap or API change. Historical2559ms/2942ms used the old JSON-document measurement and are not directly comparable to native1846.22ms. Preserve their failure artifacts and executed1200ms contract as history. The temporary cold-only exception above supersedes that ceiling for new verification; functional assertions remain unchanged.

Earlier isolated cProfile measured one cold repository build at1960.7ms: connection66.6ms, candidate query218.9ms plus59.7ms fetching7200rows, missing-album query23.4ms, aliases1.2ms, serialization19.4ms,706summary assembly913.6ms (surviving reasons764.1ms/full row construction654.5ms), grouping/file projection494.7ms and cache copy101ms. Candidate EXPLAIN was151.1ms without disk reads. Processes30264/41420/40368 and the isolated database/three roles were cleaned. The implemented summary-only omission of unused repair metadata preserves full detail semantics;93browse and11missing-album checks passed, but the real browser result still failed. No index, SQL, API-shape, fixture-count or budget change is justified merely by this diagnostic.

### Documentation and discovery status

The original September10 plan is reconciled at **31/54** checked steps for Tasks2вЂ“10 (23open), **36/59** overall including Task1. Compound unchecked steps distinguish broad matrices/consumer audits from the focused passing cases above; they are not a claim of23newly missing browser scenarios. Historical v001 hashes remain mismatched and waived by explicit current-implementation acceptance, not rewritten.

Canonical discovery is 120 functional + 175 component + 28 performance = **323**, with 21 performance-runner targets. New independent `scan-error` is coverage-only with cached generated-isolated setup. Focused registration/helper checks passed 189/189 and production parity passed; discovery is not browser execution. Private catalog counts are 142 automated + 127 ready = **269**, including automated FTC-OPS-003G; broader planned player/Appearance matrices remain unpromoted. No final local review has occurred.

## Scope and owner decisions

The verified active goal supersedes the earlier no-publication scope: "get the branch locally reviewed in 3 thorough passes as a senior lead developer, bump the verison and get all the docs updates for release, get CI run with reviews skipped and fix all the failures found in CI run. When CI is green, publish."

The same goal directs: "Update all the historical docs that are done completely for the tasks worked in this worktree and move them under history docs subfolder". Current scope is three complete sequential local review passes over the relevant branch diff, fixing and verifying validated findings between passes; version and release-document updates; reconciliation and archival of fully completed historical task documents; full native pull-request CI with `skip_reviews` and all tests enabled (`skip_tests` absent); repair and rerun of CI failures; then publication after CI is green and the applicable release gates are satisfied. Hosted reviews are waived for this run without recording hosted review coverage. Publication is authorized by this active goal; historical pause and no-publication instructions below are not current restrictions.

Historical pause instruction, fulfilled before resumption: finish targeted checks/evidence, publish and adopt immutable fixtures-v1.0.25 for all active release consumers, then make the local application commit and handoff and pause without application reviews, push, PR or CI. The earlier request for hosted review-first CI is superseded by the current explicit hosted-review waiver. Fixture publication and adoption are complete; generated-isolated scans remain generated-isolated. Fixture publication does not authorize application publication.

The owner accepts the current implementation, including departures from initial mockups. Historical v001 hash mismatches are not a completion gate; do not alter historical manifests to claim verification. Mobile and TV remain disabled in the UI, with their existing Follow/Customize implementation, API, database columns, and saved values retained.

## Baseline and dependencies

- Both prerequisite tasks completed on 2026-09-23: loop-player work and Problematic Files virtualization.
- Checkpoint `0900c81ac8d3799dbba350113fc433a84d03d774` preserves their implementation and the previously accumulated branch work. It is not a verification or review approval.
- Local completion checkpoint `0c25878f63ab9988ea6fbef82e0c58d4cc745155` (`test(ui): cover approved interaction flows`) contains exactly98 owned paths:82 tracked plus16 new. All `.codex-restart/**` and the mock preview PID remain excluded. Index and tracked worktree were clean after the commit; no test, push or review was performed by that checkpoint.
- Final local handoff commit `9f770e967fcc6fc734b2064e1fccddce6eb4223c` (`test(e2e): adopt v1.0.25 and record final evidence`) is complete: nine owned files include the verified fixture pins, backend correction/tests and evidence documentation. The tracked worktree was clean at resumption; restart/preview artifacts remain excluded. This commit establishes neither performance acceptance nor review/CI approval.
- Historical browser verification used the downloaded immutable `fixtures-v1.0.24` distribution. Active release consumers now pin verified `fixtures-v1.0.25`; the four nonutility profile objects are identical to released v1.0.24.
- The approved706 fixture is now published as `fixtures-v1.0.25`, source/tag `b24265ffa15241f156d0197e7167e929dd9c1f4b`, after fixture PR24 and successful main-release run35883029715. Manifest SHA-256: `e56a515ff4073fa1c0e7e2b9a91a5217259344415c71de0b068af3615eb09e60`. All six release assets were digest-verified; utility archive `90375c0620ef340217b0cf385dcc037b93efacee44bd6f5afe00da38f808262b` matches the canonical local706 stage. Historical v1.0.24 had18 problematic rows and cannot satisfy strict706 by pin alone.
- Historical clean fixture release base was62f9d778d28aa7c47bcad93b3a3f51d88febbae4. The unpublished build used working-checkout base cbd93ef913d2f38ceea42d178103a0747b3b483e plus dirty generator corrections; that SHA does not contain all corrected706bytes. The released source is b24265ffa15241f156d0197e7167e929dd9c1f4b; do not relabel local-stage provenance.
- Temporary `.codex-restart` files and preview PID files are not deliverables and remain untracked.

## Acceptance and evidence checklist

- [x] Wait for both prerequisite tasks and inspect their completion state.
- [x] Preserve shared work in a checkpoint without pushing or rewriting history.
- [x] Cover Lookup: real composer staging/removal, extraction failure retention, direct image extraction, selection exclusivity, narrow layout, and current notification identities/statuses.
- [x] Edit Tags: execute selection/reorder/Cancel/Apply coverage; assert grip-only reorder and selection preservation without weakening existing checks.
- [x] Artist Tree: prove fixture ownership and execute gain/no-gain gallery reflow, search/selection/scroll/player preservation, repeated folding, and reduced motion.
- [x] Album Details: retain hover/focus/released-width checks and add missing touch interaction coverage.
- [x] Library Status Page: nonempty scan/header restoration and natural health warning pass; genuine failed publication and native recovery now pass through FTC-OPS-003G. Component evidence remains separately recorded.
- [x] Verify FTC-OPS-003G through complete real full-app failure/recovery and cleanup: canonical scan-error passed 1/1 in 2.4m, authoritative-pass exit0; native recovery took 73.6s. The strict isolated helper revokes only INSERT on library.local_track_files and restores privileges in finally. Durable error, retained gallery/header/player and native recovery passed; no mocked app route or runtime state injection.
- [x] Player and shared anchors: representative visual comparisons and motion geometry checks pass with inspected baselines; the additional native-scroll/resize anchor scenario and combined full-app player verification also pass.
- [x] Problematic Files: immutable fixture release reconciled and706-row production-path checks passed once under the approved cold1000ms target/1000ms grace/2000ms ceiling and readiness1000ms target/400ms grace/1400ms ceiling; cached timings retain their1200ms ceilings. Preserve Phase9 `P9-PERF-001`, which must restore the original1200ms cold ceiling or obtain explicit owner disposition before closure.
- [x] Complete private-registry/consumer and historical migration-evidence status reconciliation. Original Tasks2вЂ“10 remain31/54 checked with owning focused case evidence updated; required schema is verified, missing historical ledger entries are not manufactured, and broader matrices remain explicitly unfinished rather than being promoted from source-string tests.
- [x] Run focused verification for every changed seam and audit owned test-process cleanup. Only one pytest process ran at a time; heavyweight browser verification was coordinated serially, and all owned benchmark processes, ports, database and roles were cleared.
- [x] Checkpoint the owned completion changes through the local commit handoff: `0c25878f63ab9988ea6fbef82e0c58d4cc745155` and final handoff `9f770e967fcc6fc734b2064e1fccddce6eb4223c`; unrelated restart/preview artifacts are excluded. The committed changes are part of the authoritative `origin/main...HEAD` review scope without publication. This closes the checkpoint operation only; combined acceptance and evidence items above remain open.

### Resumed application workflow вЂ” three local passes, release preparation, full CI and publication

The owner has authorized the following continuation. No final local review has completed at resumption (0/3); each pass covers the entire resulting relevant diff and includes validation, fixes and focused verification before the next pass.

- [x] Full local review pass 1: entire relevant branch diff, including tests, shared ownership boundaries, security, accessibility, and unnecessary code; eight validated product findings fixed and focused-verified.
- [x] Full local review pass 2: entire resulting relevant diff reassessed; 13 EOF-whitespace findings fixed and branch-wide `git diff --check` made clean.
- [x] Full local review pass 3: entire resulting relevant diff reassessed across security, trust boundaries, migration compatibility, accessibility/state ownership, bundle parity and CI evidence integrity; two stale 19-target test labels corrected, with no remaining validated finding.
- [x] Bump the original completion candidate to 0.9.46; after integrating released 0.9.48, prepare the final candidate as 0.9.49 and update release documentation.
- [x] Reconcile historical documents for tasks worked in this worktree; move the two fully completed documents under `docs/history/` and repair their references while leaving unfinished plans active.
- [ ] Commit verified fixes and push the existing PR21 branch. Preserve `skip_reviews` and the absence of `skip_tests`; do not create a replacement draft PR.
- [ ] Run the complete native PR pipeline with `skip_reviews` and without `skip_tests`; collect the complete genuine test failure inventory for the current candidate head. Preserve the explicit owner waiver without recording hosted review coverage.
- [ ] Fix failures with focused local reproduction, then rerun the complete native PR pipeline until all required jobs pass.
- [ ] After full CI is green, leave PR21 unmerged for owner manual acceptance. Merge, release publication, production deployment, and main synchronization are not authorized by this checkpoint.

### Pass-1 findings and regression evidence

The first complete-diff inspection and focused repair verification identified eight validated product defects: scan-error materializer/sample coverage incorrectly reused FTC-OPS-003C/E instead of FTC-OPS-003G; invalid device profiles returned 503 instead of 400; editor synchronization enabled unavailable Mobile/TV native buttons; gallery resize/search handlers selected the Library Status bar; capture-phase Escape bypassed the nested Settings filter; virtual-list repainting destroyed focused rows and interrupted keyboard traversal; Appearance cleanup retained the inline floating-edge token; and generic pressed-state specificity overrode accepted action colors. Repairs for these eight defects have focused GREEN evidence below. The later passing canonical performance run closed pass1.

Original-head focused regression evidence: report JavaScript **2 failed**; appearance route **3 failed, 1 passed**; browser components **9 failed**. The separate summary/detail compatibility baseline passed **6/6**, covering reason order, tied/duplicate filenames, scoped exclusions, incomplete track order and missing albums with independent inputs. These are focused regression outcomes, not full-suite results. The materializer regression now obtains each target's metadata from the production inventory builder while retaining the exact C/E, F and G expectations and existing rejection assertions; that fixture correction is included in the focused GREEN runtime run below.

The first broader focused wave retained 327 passing and 11 failing JavaScript checks plus 49 passing and five failing component cases. Investigation separated the two additional product defects above from harness drift: four gallery mocks lacked the production gallery-instance selector, the modal harness omitted the production utility state, and the virtual-list DOM stub lacked reconciliation support. The materializer fixture now uses real inventory metadata without relaxing exact coverage IDs. Accepted visual reconciliation updates only the quiet Cancel transparent background (with ink/token checks retained), regular dock border alpha 0.24, and the owner-accepted light Artist Family 20% fill/count tokens. Quiet Cancel is grounded in the September 5 paired-player/Cancel plan; dock alpha is specified in the September 22 docked-player plan; the current-visual supersession above authorizes the family appearance without rewriting its historical solid-fill plan. The four cleanup regressions and three pressed-color regressions were retained unchanged and resolved through product fixes.

Focused GREEN, independently executed by the verification worker and confirmed from retained log tails: Appearance API 54 passed in 6.63s (`%TEMP%\album-haven-green-appearance-repairs.log`); browse compatibility 118 passed, 205 deselected in 1.61s (`%TEMP%\album-haven-green-browse-repairs.log`); runtime/report JavaScript 338 passed, zero failures in 1353.1917ms (`%TEMP%\album-haven-green-runtime-repairs2.log`); browser components 54 passed in 1.1m (`%TEMP%\album-haven-green-components-repairs2.log`). These are focused selections, not complete-suite or production E2E approval; no combined unique-test total is claimed.

The canonical repairs2 benchmark completed with the sole cold-API hard failure above. Logs are `%TEMP%\album-haven-canonical706-repairs2.stdout.log` and `%TEMP%\album-haven-canonical706-repairs2.stderr.log`; the original metrics path was `test-results/playwright-performance-targets/utility-problematic-files/history/utilityProblematicFilesLocal/runs/2026-09-23T20-07-19-676Z/metrics.json`, but that file is now absent. The retained original stdout remains the evidence source; the historical metrics path is not a currently available artifact. The final policy selected `local`, `attemptCount=1`, `finalStatus=failed`, `recoveryUsed=false`. The verification worker audited zero owned processes, no listeners on ports36544/36546, and no isolated `health_8877243d0fac` database or its three roles. Preserve prior1882.737ms as historical failure evidence; the later passing2000/1400 canonical run is the current result.

Historical diagnostic evidence is retained in `measure-released706.stdout.log` under the common evidence directory: total profiled build 4585.9ms, summary construction 2020.9ms, surviving-reason evaluation 1496.1ms and per-track row construction 1159.9ms. This profile predates the summary-iterator change, as shown by its 707 `_problematic_track_problem_rows` calls; it cannot attribute the fresh cold1800 failure to the current implementation. It is neither browser timing nor a passing replacement for canonical acceptance. The orchestrator's retained cleanup summary reports the owned processes/listeners, isolated database and three roles removed, with ports39612/39614 clear.

The temporary cold-only contract and focused JavaScript verification are complete:212passed/0failed in2747.1625ms, log `%TEMP%\album-haven-cold1800-green2.log`. Fresh canonical cold1800 verification failed with the cold/readiness results above. Logs: `%TEMP%\album-haven-canonical706-cold1800.stdout.log` and `.stderr.log`; metrics: `test-results/playwright-performance-targets/utility-problematic-files/history/utilityProblematicFilesLocal/runs/2026-09-23T20-39-52-205Z/metrics.json`. Final policy: `local`, `attemptCount=1`, `finalStatus=failed`, `recoveryUsed=false`. The verifier confirmed zero owned processes, no listeners on40465/40467, and zero isolated databases/roles for `health_bd41bd208d0d`.

Bounded diagnostic checkpoint: the verified `music_app` diff between `ef31c0b` and `b2f097e` is empty. Both browser runs returned 2,040,096 bytes and 706 rows. From repairs2 to cold1800, cold request time rose from 1453.852ms to 4837.715ms and the warm request from 414.5ms to 808.3ms, while parsing changed from 50.2ms to 52.8ms and rendering from 35.6ms to 39.8ms. Wider resource contention remains an unproven hypothesis.

The owner approved one correlated instrumented diagnostic. Its first launch returned HTTP422 because the observer's endpoint wrapper broke request binding; no valid cold measurement resulted. The harness fault was preserved separately and fully cleaned before removing that wrapper. The replacement returned HTTP200, rebuilt all706 rows and retained the2,040,096-byte payload with23 observer hooks. Diagnostic cold time was2330.412ms>1800ms; readiness714ms, cached242/179/180ms, search113ms and filter449ms. ASGI duration was2320.559ms; browser wait2320.089ms and transfer9.816ms. Repository work took1892.161ms wall/1343.75ms CPU: disjoint projection499.317ms and summary695.865ms, rows492.401ms, connection98.735ms and missing rows42.619ms. Reason evaluation482ms is nested inside summary and must not be added again. Observer overhead is uncalibrated; this is diagnostic evidence, not acceptance or a measured optimization benefit. The host resource sample occurred after the cold request and cannot establish its cause.

Diagnostic evidence is under `%TEMP%\album-haven-cold-request-diagnostic`: `request-dea6c877fbe54428aa0ecd35773f5bea.46008.json`, `request-dea6c877fbe54428aa0ecd35773f5bea.browser.25568.json` and `run2.*` logs. The prior cold1800 failure was preserved in19 files under `pre-instrumentation-cold1800-evidence`; the initial harness fault is preserved separately. Cleanup verified zero owned processes, no listeners on50671/50673, and zero isolated databases/roles for `health_7bf7500599b2`; the parent environment was unchanged. The next candidate is sharing the existing text-classification cache within one projection call, with no architecture, query, fixture or API changes. Its benefit is unmeasured, owner approval is pending, and no fix has been implemented. Preserve all contracts and failed acceptance evidence; do not retry for a pass.

The approved request-local cache trial was test-first. The exact RED Node case failed with four classification calls instead of two. The production patch is two lines that share the existing `(label, value, detect_encoding)` cache within one projection call; the exact GREEN rerun passed1/1 and the nearby focused selection passed54/54. One fresh uninstrumented canonical attempt then retained all functional outcomes but failed its executed contract: cold API1859.425ms>1800ms, readiness1135ms within the then-current1200ms grace, payload2,040,096bytes with706items/23mounted, cached204/187/162ms, search134ms and slowest filter567ms. The case took28.6s with one failed test, zero errors and no retry. Metrics: `test-results/playwright-performance-targets/utility-problematic-files/history/utilityProblematicFilesLocal/runs/2026-09-23T21-57-48-851Z/`; logs: `%TEMP%\album-haven-canonical706-cachetrial1.stdout.log` and `%TEMP%\album-haven-canonical706-cachetrial1.stderr.log`. The optimization deterministically removes duplicate classification but establishes no causal end-to-end gain. The later owner-approved2000/1400 contracts and their passing canonical evidence are recorded above.

All three local review passes and their validated fixes are complete. Pass2 removed13 trailing blank-line findings; pass3 corrected two stale performance-target labels. Fresh focused verification after pass3: JavaScript120/120, exact label contracts17/17, Python510/510, syntax parsing189 JavaScript/26 Python/17 JSON files, and branch-wide `git diff --check` clean. The checklist is18/22. No reliable browser performance improvement, complete CI result, merge, or release is claimed; the active publish goal now proceeds to the native PR pipeline with `skip_reviews` and without `skip_tests`.

## Compatibility, rollback, and delivery

This completion work adds evidence around already accepted behavior. It must not remove dormant Mobile/TV compatibility, replace Postgres authority, weaken test contracts, or introduce test-only production paths. Any product fixes belong at their existing responsible boundary and require focused regression coverage. Revert cohesive new commits to roll back this completion work; do not reset or discard shared work.

The existing branch is already accumulated. Do not rewrite its history or automatically publish it as a release. Before PR creation, record the final dependency/split assessment: independently separable fixture delivery belongs in its fixture repository, while coupled application controls, runtime, tests, and acceptance evidence must remain coherent. The owner requested a new application PR; merge and publication remain separate checkpoints.

September 23 delivery assessment: the prior owner-requested single application PR groups the original seven units (shared controls, Artist Tree, Album Details/Cover Lookup/notifications, Edit Tags, Library Status Page, Appearance/player persistence, and consumer adoption). Their shared runtime, templates, CSS, migrations, and generated bundle contain overlapping changes; whole-file splitting or history rewriting would not preserve working slices. The separately approved Problematic Files virtualizer remains a distinct review unit within this accumulated PR, with its own runtime, navigation, fixture, and performance acceptance contract. Its sanitized fixture distribution was published separately in the fixture repository. Reassess and record the safe application split/dependency decision against the final reviewed diff before PR creation; this historical grouping does not authorize automatic publication or history rewriting.

Fixture publication and all-active-consumer v1.0.25 adoption are complete. Both workflow fetches, local functional runner and their contract expectations use the released manifest hash above. The real released manifest passes the strict production loader for functional-core, synthetic-large-library and utility-problematic-files; utility counts are40artists/706albums/7200tracks/7200files/627covers. Focused pin suites passed45/45. Generated-isolated scans remain separate. A v1.0.24 rollback must pair consumer contract and pin; pin-only rollback cannot satisfy strict706. No application push/PR/CI or release was performed.

## Historical handoff snapshot

The following subsection preserves the pre-review transfer state and its then-current failures. It is superseded by the current release checkpoint below and must not be used as the active status.

The local handoff and requested pause completed at `9f770e967fcc6fc734b2064e1fccddce6eb4223c`. The verified active goal authorizes three complete sequential local review/fix/verification passes, version and release-document updates, archival of fully completed historical task documents, full native PR CI with hosted reviews skipped, CI-failure repair, and publication once CI is green and applicable release gates pass. Latest cold1800 verification failed: cold4837.715ms>1800ms and readiness1233ms>unchanged1200ms. The approved cold-only exception is implemented; `P9-PERF-001` restores1200ms in Phase9. Focused212JavaScript checks passed, but pass1 remains open; passes2/3 and CI have not started, and final reviews remain0/3. Version0.9.46/release-document preparation and two history moves are saved pending review. No completion push or PR has started.

The approved instrumented diagnostic is now complete and recorded above; it does not replace the failed uninstrumented acceptance result. The pending decision concerns the proposed projection-local cache optimization; the previously requested diagnostic has already been approved and executed. No review pass or CI gate was completed by the diagnostic.

### Historical transferable local handoff checkpoint вЂ” superseded October 3

Final local handoff commit `9f770e967fcc6fc734b2064e1fccddce6eb4223c` includes verified v1.0.25 pins and two backend files (`library_browse_postgres.py` and its tests). Backend focused evidence:21 failing regressions became21 passing; the related112 checks passed, including an independent native `Path.name` oracle. This does not establish an end-to-end latency improvement. Pin contracts passed45/45 and the released manifest passed strict loader validation for all three active profiles. The historical instruction to stop after this commit was fulfilled; current continuation is recorded above.

- Application worktree: `C:\Users\Rendref\.codex\worktrees\bf02\album-haven-app`; branch `2026-09-09-cover-look-up-refactor`; local checkpoint `0c25878f63ab9988ea6fbef82e0c58d4cc745155`, subject `test(ui): cover approved interaction flows`. Exactly98 owned files were committed. This is a checkpoint, not final review or full-suite approval.
- Targeted acceptance is listed in the current evidence table: Artist Tree001, Tags025, Album019/022, Covers024 and both007 flows, SettingsS06, narrow AppearanceA01, combined Player019вЂ“022, scan C+E/F/G,49 visual/component cases and the additional native anchor scenario. All these nonperformance scenarios pass; terminal-error003G is full-app evidence distinct from the component tests. Backend15/88 selections overlap and must not be summed as unique coverage. No complete local release suite was run or claimed.
- Latest canonical706 result: cold1800 cold GET4837.715ms>1800ms and readiness1233ms>unchanged1200ms,42.620s case; payload2,040,096bytes<2MiB and all19functional steps pass with706items/23mounted. Cached206/217/195ms, search126ms and filter992ms met their targets. One local attempt failed with no recovery; exact logs, metrics and verified cleanup are recorded above. Prior repairs2 cold1453.852ms and native2 cold1882.737ms remain historical failures under their executed1200ms contracts.
- Fixture delivery: [fixtures-v1.0.25](https://github.com/idanilovqa/album-haven-test-data/releases/tag/fixtures-v1.0.25) is published and verified, with source/manifest provenance above. App adoption covers both workflow fetches, local runner, two pin contract suites and `docs/local-functional-e2e.md`. Strict real-manifest validation and45/45 focused checks pass. Preserve fixture-neutral fake-unit releases, immutable history and generated-isolated scan setup.
- Private evidence lives in `C:\Repositories\album-haven-internal`: catalog142automated+127ready=269, operational10/24 with003G automated. Broader Appearance/player matrices remain planned. Original application plan is31/54 checked across Tasks2вЂ“10; remaining compound audit/matrix steps are not automatically missing introduced scenarios. Existing schema is verified without replaying absent historical ledger entries or exposing saved values.
- Excluded artifacts: every `.codex-restart/**` file/directory and `docs/design-mockups/screens/remaining-ui/v001/preview.pid`. Keep them untracked and outside final commits. Never stage another worker's active backend edits before its explicit verification handoff; stage exact task-owned paths.
- Historical finish line, superseded by the final PR21-unmerged checkpoint below: three complete sequential senior local review passes and verified fixes; review saved version0.9.46/release-document preparation and two historical document moves; push/new PR and full native CI using `skip_reviews` with all tests enabled; fix CI failures and publish after green CI and applicable release gates. Reviews remain0/3; fresh706verification failed, so pass1 and compound acceptance items remain open, with passes2/3 and CI not started.

## Current release checkpoint

The original local review is complete 3/3 and the checklist is 18/22. Current
`origin/main` 0.9.48 is integrated, post-merge repairs and duplicate-test cleanup
are committed, FTC-OPS-017 passes its unchanged contract, and 0.9.49 release
metadata is prepared. `P9-PERF-001` remains open to restore the original 1200 ms
Problematic Files cold ceiling or obtain explicit owner disposition. Next:
complete post-integration review and focused verification, commit and push, open
and attach a new PR, apply `skip_reviews`, verify `skip_tests` is absent, run the
complete native CI, fix its full failure inventory, rerun until green, then
publish through the applicable release gates.

### Normal-database evidence

Read-only inspection on 2026-09-23 found one Appearance preference row. The normal database already has the columns, types, non-null/default settings, device-profile shape constraint, and expanded dock-behavior constraint introduced by 0075, 0076, 0078, and 0079. The migration ledger contains 0077 and 0078 with the previously recorded checksums, but no entries for 0075, 0076, or 0079. Do not replay the non-idempotent 0079 or downgrade the 0078 behavior constraint by rerunning 0076. This pass changed neither the schema nor stored preferences. Historical ledger reconciliation remains distinct from checking that the required schema is present.

Migration evidence follow-up: read-only probes with `default_transaction_read_only=on` confirmed every required 0075вЂ“0078 schema element, including validated palette, device-profile, motion, floating-edge, and expanded dock-behavior constraints. Ledger 0077/0078 SHA-256 values exactly match the checked-in files. One existing Appearance row would violate 0076's superseded two-value constraint, so replay is unsafe; 0078/0079 also contain non-idempotent column additions. The unchanged full-row MD5 fingerprint was `7e7d45ca76035c4bd6f1c1c778125005`, with one row and one distinct revision across both probes. No saved values or credentials were exposed. The normal runbook records a ledger entry only after successful migration execution; the automated runner is restricted to isolated databases and offers no adoption/supersession operation. Keep absent 0075/0076/0079 ledger entries as historical evidence gaps, separate from the verified required schema; do not manufacture execution history or modify normal-database preferences. No migrations were applied during this audit.

### Remaining coverage versus historical backlog

- **Introduced scan-error gap closed:** canonical FTC-OPS-003G passed 1/1 in 2.4m, authoritative-pass exit0, with native recovery in 73.6s after genuine INSERT denial. Durable error, retained gallery/GalleryBar/player and privilege restoration passed. Retained log: `scanError2.stdout.log` in the directory above. Owned processes were zero, ports40118/40120 clear, database/three roles dropped. First failure `scanError-first-failure/trace.zip` reached the real failed state but spec77 received undefined: statusSample/statusPayloadFromSample omitted scan_outcome. A real-sample regression failed before the two-line projection repair and passed afterward. This full-app proof is distinct from the component proof.
- **Introduced measurable failure:** Problematic Files706 has exercised native filtering, search clearing, exact706-row virtualization and cached tabs, but cold API/payload performance remains unresolved. This is failing coverage, not missing functional authoring.
- **No other concrete missing branch-introduced browser scenario was identified by the bounded coverage intake.** Native anchor scroll/resize/edge/cleanup was its actionable gap and now passes. This intake is not one of the three full reviews and cannot replace their complete-diff assessment.
- **Broader or pre-existing matrices:** Cover023 native OS refocus remains ready/helper-only and unchanged by this branch; no OS-focus harness is claimed. Wide private Appearance/account/conflict/palette and player idle/boundary/reduced-motion matrices remain planned where the passing narrow cases do not cover the entire contract. The original plan still leaves explicit focus-transfer, all-keyboard/all-zoom/forced-color/theme matrices and general consumer-adoption checks open; these require evidence reconciliation or final review, not automatic classification as newly introduced regressions.
- Fixture release/pin, provider licensing and historical migration-ledger gaps are delivery/evidence decisions, not missing browser scenarios. Editable Mobile/TV removal and historical mock-byte recovery are explicitly outside the required completion work.

### Historical failures and repairs вЂ” superseded unless listed as active above

These grouped records retain distinct failure outcomes and provenance. Their latest passing results are in the current checkpoint; no pending language below schedules a redundant rerun.

| Area | Retained diagnostic and repair history |
| --- | --- |
| Artist Tree settlement | Search returned60albums while canonicalApplied=false/revision0. GalleryBar owns the artist label when repeated headings are suppressed; allowing only artist context still failed (`album-haven-functional-local-7da574cbfe8e-playback_utilities`, ports52228/52230 cleaned). Both artist and single-artist contexts now pass while generic/family contexts stay excluded. Related focused regressions passed42 and51 checks; observational query reads never became readiness authority. |
| Artist Tree geometry | Initial default-folded setup made requesting fold a no-op; native expansion now establishes the baseline. 1280px genuinely gained a column, so it could not establish no-gain. Captured title/artwork trigger mismatch was repaired at the shared anchor boundary (48unit cases), but1340px still drifted430.96875px. Diagnostic trace772505c3c85e showed settled5columns reverting to4 during ordinary height reconciliation. Height-only recalculation now preserves column geometry (49unit cases); the action waits for the existing transition class to clear.1060px is the actual three-column no-gain setup. No identity or one-pixel tolerance was weakened. |
| Tags025 | Last-to-first native dragging failed because scrolling preceded drag start. The helper now begins native movement before scrolling and observes dragged/insertion cues; original orders remain, with additive identity/non-grip/outside checks. No tag runtime mutation was required. |
| Album Details | Old pointer-hover assertions expected a keyboard-only outline; actual semantic hover retains border/background and geometry. The table-width observer used the outer padded box rather than the grid content box. Both test observations were aligned without changing accepted layout. |
| Composer | Desktop overlay actions were clicked before actual artwork hover; shared lookup/fast-fetch helpers now reveal the overlay, while touch stays native tap. Clipboard source404 came from an older manifest descriptor, fixed by exact released asset ID/SHA. Full7500px JPEG-to-PNG clipboard content correctly exceeded10MB; the external fixture now copies a512px preview while direct-image hash checks retain full bytes. Alert heading/message selectors and current saved-remote versus local-replacement Save expectations were corrected. A genuine full-render selection bug marked saved remote and pasted art together; the existing incremental pending-pasted guard was applied to full rendering after RED. |
| Notifications | Dedicated toast originally measured before accepted running-progress content appeared:10.75px height/5.375px vertical change. A read-only entrance observer now requires an unsettled toast and running-layout baseline, exact zero movement through remaining entrance, fixed layering/non-obstruction and cleanup (141contracts). Delete's old label was corrected. Native text drag incorrectly began in the thumbnail; endpoints now use visible text characters (142contracts/parity). Flex-parent blockification and translated/faded drawer closure replaced stale display assumptions, not behavior assertions. |
| Notification runtime | Explicit Delete returned200 but hover/focus preservation kept the row; explicit delete/rollback now bypasses polling preservation, with single/bulk failure rollback coverage. Canceled tasks fell through to Searching; then a focused/hovered obsolete Cancel action held stale markup despite canceled polls. Terminal mapping and state-specific action retention were repaired with RED/GREEN renderer cases, preserving independent live text selection and mixed-card Retry/Delete interaction. Actual bulk007 subsequently passed all stages. |
| Library Status | Scoped artist heading observation, ten old Go to Scan Page labels, transient relation screenshot timing, old idle title and burgundy/left cancellation geometry conflicted with the accepted current page. Controls now use Go to Library Status Page and current idle copy/layout without dropping phase or cancellation checks. Health notifications intentionally defer on dense gallery and persistent guidance follows dismissal; native page-open/dismiss ordering was repaired. C-only passed38.2s/wrapper40.5s, Back103ms/stable534ms, port51662 clean, but was correctly rejected as an incomplete C+E target. The canonical pair later passed. |
| Library Status terminal error | Initial component fixture sliced an empty template; after correction the real renderer exposed the intended missing-alert RED, while cancellation passed. The existing safe-text OnPageAlert now reports terminal failure without denying a previously usable catalog or falsely completing phases, clears on running/success, and preserves GalleryBar restoration. Two component cases passed; no forced production API/state seam was added. |
| Player/Appearance | A01 restoration initially submitted read-only player_recent_sets; removing that field preserved nullable palette defaults and revision/session/overlap guards (seven isolation regressions). Combined player initially captured Appearance before authenticated navigation. Later failures were obsolete76px compact/chevron/skip-control assumptions: tree-wide240x72, rail64x100 and floating96px are now checked through actual controls; expanded cluster renders no Previous/Next and accepted compact variants hide them. Second-tab ownership is the disabled Play affordance, not a nonexistent Locked label. Full player4 passed and cleanup is recorded above. |
| Backend authorization | First focused wave had10passes/5setup failures because the test opaque session token was noncanonical base64url. Correcting only the token to the production-compatible fixture value allowed the same denial/no-leak/stale/snapshot assertions to pass. Shared-library capability semantics, not invented per-user task ownership, remain authoritative. |
| Visual fixtures and discovery | Initial pinned-Chrome run had42passes plus seven missing-baseline failures generating ten images; this was not acceptance. Clipped labels/contrast/empty art traced to synthetic markup/colors. Production tokens/markup and deterministic artwork repaired the fixtures; all ten images were inspected, then49cases passed without updates. Inventory counts progressed82в†’172в†’174в†’175components as cases were discovered/authored. Health routing first had177passes/9failures, then198/1, finally199/199; environment isolation passed2parameterized cases. Final discovery is322cases, not a full-suite pass. |
|706observer| The all-row DOM equality check contradicted approved virtualization. The shared observer now requires native query/count/range plus exact ordered mounted identities, rejecting stale query, wrong order/range and incomplete windows (157focused checks/parity). Browser functional flow subsequently passed, including clear in115ms, but cold performance failed2559ms then2942ms. |

### Fixture provenance and local-only706 evidence

Release-backed functional tests use downloaded immutable `fixtures-v1.0.24`. The separately downloaded scan-library profile had manifest SHA-256 `1b68ff21620663c500a3869c74f01565ecbcd38f906a5c7eb690ac75581db8f6`, but was **unused**: the established scan runner requires generated-isolated media and uniquely owned Postgres, rejecting inherited release roots. Do not describe scan/health runs as exercising v1.0.24 bytes.

The authorized unpublished706 generation used working-checkout base `cbd93ef913d2f38ceea42d178103a0747b3b483e` with uncommitted generator corrections, not a commit containing the complete corrected706contract. Initial local label `fixtures-v1.0.24-local-706-cbd93ef` produced manifest SHA-256 `e7282e21fef51201ae32d21a3c2db5d07598f1f7925f1dfae1dbdf1f91b9efec`; strict prestart validation rejected its contradictory expected identities/counts before application startup. Actual media/catalog rows were already correct, but expected18identities and legacy distribution metadata were not.

Generator regression first failed `7200 !=125`, then passed one case in246.108s; five loader contradictions became25passing checks. Corrected local label `fixtures-v1.0.24-local-706-cbd93ef-dirty-96c6d94b252d` uses generator SHA-256 `96c6d94b252dda48c3ed6bc594d86518cf924ea3f87b380e6f9c618e98b4a971` and manifest SHA-256 `6a8ec7fde6556fbb07fc2230e17dc5bfb7d97ed54e6a08645ec72a161e9cac59`. Utility ZIP SHA-256 remains `90375c0620ef340217b0cf385dcc037b93efacee44bd6f5afe00da38f808262b`. Strict parser accepts706identities,7200candidate files and79uncovered albums. Owned generation processes exited; restored-database browser functional proof subsequently passed, but performance did not.

Neither historical local stage is a released immutable fixture. Preserve the rejected stage as failure evidence, never relabel it as v1.0.24 acceptance. The subsequent verified v1.0.25 release is recorded separately above.

### Provider asset provenance

The shipped `music_app/static/images/google.ico` and `yandex.ico` match the locally retained source downloads recorded in remaining-UI notes as `https://google.com/favicon.ico` and `https://yandex.com/favicon.ico`. SHA-256 values are respectively `6da5620880159634213e197fafca1dde0272153be3e4590818533fab8d040770` and `9a8c4ab2a3a2451c6f1b31af29eeeced47745013711f641eafa80828a2b251de`. This checks source provenance, not historical mock approval or trademark permission.

Runtime provider badges are inline SVG primitives in `cover-lookup-modal-and-drawer.js`; CAA is text. Do not describe them as the Simple Icons downloads used in the earlier mock. Provider-asset licensing review remains open; current visual acceptance does not itself establish redistribution rights.

Official guidance inspected on 2026-09-23: [Google brand products and services](https://about.google/brand-resource-center/products-and-services/) and [Yandex logo usage rules](https://yandex.com/company/general_info/logotype_rules). These are conditional brand-use rules, not a blanket open-source asset license. Preserve that distinction rather than inventing a permissive license for downloaded favicons.

The owner asked whether using these icons requires license rights; the owner did not approve their removal. No infringement or blanket requirement to buy a license has been established. Yandex expressly permits qualifying non-commercial websites and mobile applications subject to its conditions, including language-specific link destinations; the app currently links to `yandex.com/images/search`. Google's guidance distinguishes its company G from product icons, so product-icon permission requirements must not automatically be applied to the G. These observations narrow the assessment but do not establish legal clearance for this application's exact use. Keep the icons unchanged while documenting the applicable conditions.

Exact-use assessment: both favicons appear only beside named external image-search links in the manual composer, with an external-navigation marker and empty decorative image alternatives. The renderer does not claim a partnership. CSS preserves proportions with `object-fit: contain` at 22 pixels; no image recoloring is applied. These facts establish the implementation's referential use, not legal clearance. Google's current [visual-brand guidance](https://partnermarketinghub.withgoogle.com/brands/google/branding-guidelines/how-to-show-googles-brand/) distinguishes the Google G from product icons, requires accurate attribution and clear space, and places conditions on commercial uses and product-icon permission. Yandex's linked rules cover non-commercial use, restrict destinations, prohibit distortion and misleading affiliation, and require written permission for uses outside those rules. The downloaded favicon hashes alone do not establish that all those conditions, or redistribution rights for this exact application, are met. Retain this specific unresolved assessment for release review; do not replace accepted icons, infer blanket permission, or contact either provider without owner direction.

### Remaining consumer inventory (initial, not acceptance)

| Surface | Existing shared adoption | Remaining classification work |
| --- | --- | --- |
| Main modals and notifications | Shared action-button macro, `ui-button` variants, OnPageAlert and production notification renderer | Classified: primary/confirm templates already reuse quiet Cancel and shared header actions. Raw Auto-number is a pressed-state control with its own compact geometry; destructive confirmations use the existing shared `.confirm-modal-danger` owner, not individual page copies. Notification Retry already has shared `ui-button` classes; Cancel/Delete use `ButtonComponent.renderActionButton`. Composer/image-overlay actions have specialized compact hit targets. Replacing them with 34px ActionButtons would change accepted geometry. Remaining adoption/interaction verification is open, not a blanket raw-button defect. |
| Account | Shared AppBar, alerts, input-action wrapper, button macro import | Classified: Show/Hide already composes `.ui-input-action` and native password fields with autocomplete/validation; retain focus return and `aria-pressed`. The only raw general submit is Change password. Adding `ui-button` would exclude current 42px/10px-radius `.button:not(.ui-button)` styling and change the screen. A bounded candidate is deleting unused account-scoped `.button.is-ghost`/`.button.is-small` rules after final consumer confirmation; no conversion or new wrapper is justified solely by markup. |
| Admin members/account detail | Shared AppBar, alerts, scrollbar, account/settings navigation | Classified: `.admin-button` duplicates basic inline-flex/button styling, but currently serves both anchors and submits with 40px geometry, green/danger variants and auth-specific hooks. The Jinja `ui_button` does not express anchor semantics or arbitrary attributes. Do not replace links with buttons or add wrapper APIs merely for adoption. Native capability selects/switches and reauthentication inputs are intentional. Any consolidation must preserve current dimensions, permission branches and hook identities and still needs focused rendered verification. |
| Login | Shared OnPageAlert and scrollbar | Classified: `.login-submit` owns a 60px full-width gradient submit; the password toggle is a 44px minimum embedded native action. The standard shared Button medium minimum is 32px and uses account theme tokens; unauthenticated login has a separate fixed palette and native autocomplete/required fields. No safe blind class replacement. Keep login semantics and current layout; existing login UI/runtime/auth E2E seams must verify any future scoped change. |
| Recovery/reset/invitation | Shared OnPageAlert and recovery stylesheet | Classified: recovery/reset already share `.recovery-submit` and `.recovery-form` with 44px controls and native form submission. Invitation uses the same page stylesheet but omits those classes, leaving native fields/submit. Applying them would visibly restyle the accepted screen, not remove duplicate code; record this as a distinct presentation decision rather than silently converting it. No new shared wrapper proposed. |
| Settings | Shared Settings shell/navigation and existing search/action components | Classified: Problems/Rules/Loops/Appearance/Integrations adapters update the same search element and use NavigationTree ownership; per-tab placeholders/filter state are domain inputs, not duplicate SearchInput implementations. S01вЂ“S05/A01/L02 cover several real flows. S06 now supplies passing Rules/Integrations/Appearance matching/no-match/clear and draft-retention evidence. Wide Problems/Loops and broad consumer-adoption verification remain separate; this row does not claim all six areas verified. |

The presence of a native `button`, `input`, or `select` is not itself a duplicate-component defect. Keep specialized menu, playback, image-lightbox, form-submit, and password-toggle semantics. Task 10 remains open until responsibility and focused visual/behavior checks resolve the candidates above.

Read-only classification evidence: `partials/primary-modals.html`, `partials/confirm-modals.html`, `runtime/cover-lookup-modal-and-drawer.js`, `runtime/cover-lookup-modal.css`, `runtime/utilities.css`, `account.html`/`account.css`, `admin-members.html`, `admin-account-detail.html`/`admin-members.css`, `login.html`/`login.css`, and the three recovery/invitation templates plus `password-recovery.css`. The private component catalog explicitly permits ordinary semantic HTML and unique composition. Shared password-toggle behavior is textually duplicated in `account.js` and `admin-members.js`, but `settings-navigation.js` mounts exactly the appropriate page controller; this is not evidence of double activation or a reason to introduce a shallow helper without a wider ownership benefit.

Existing verification seams (located, not executed by this classification): `tests/js/phase7-account-admin-presentation.test.js`; runtime `account.test.js`, `admin-members.test.js`, `login.test.js`, `password-recovery.test.js`, `remaining-ui-interactions.test.js`, `remaining-ui-dialogs.test.js`; `tests/py/test_auth_login_ui.py`; phase7 `adminManagement.spec.js` and `persistentSettings.spec.js`; existing cover/Settings/Appearance functional cases. No runtime changes or tests were made during classification. No safe mandatory duplicate conversion was established; the small unused account-style candidate and outstanding rendered checks remain separate follow-ups, not completed adoption.
## Phase 9 mobile interaction coverage follow-up

The branch has responsive Chromium coverage and focused runtime tests, but real mobile behavior remains a separate completion item. Add a dedicated mobile-device project using Playwright device profiles (iPhone/Android), `hasTouch`, and real touch input. Cover these cases through the normal application path:

- taps on album rows, track rows, nested actions, player controls, Gallery Bar actions, and settings drawer entries;
- horizontal album/artwork swipes, vertical scrolling, pinch/zoom cancellation, and gesture interruption;
- mobile Back and browser history across Gallery, album details, full artwork, settings, and nested utility pages;
- narrow phone versus wide-tablet layout selection, 1/2/3-column gallery geometry, safe-area/footer placement, keyboard-visible layout, and orientation changes;
- touch target size, focus transfer, dismissal ownership, and prevention of background actions while a mobile surface is open.

Keep the existing unit and isolated-browser contracts. Add the device project and its functional cases before Phase 9 is declared complete; physical-device acceptance for browser-specific back gestures, safe areas, and virtual keyboards remains a manual gate.


### October 5 local mobile follow-up

Outcome: reuse Home InPageTabs for album editions on desktop and mobile; show known editions during detail hydration; keep mobile seek feedback continuous and discard an outgoing track drag on cancellation or track change. This continues the owner-approved cover branch and does not change playback architecture, schemas, credentials, or media. Rollback is the source commit and rebuilt runtime bundle. Checkpoint: local commit and authenticated port-5004 build only; do not push or merge PR #21.

Acceptance cases: first-open edition tabs, edition selection and keyboard navigation, mobile spacing, fractional drag feedback without repeated decoder seeks, cancelled touch without seeking, and track promotion without stale progress. Atomic search retains the mounted gallery until full results arrive; clear-search and superseded-response guards remain enforced.

Read-only source diagnosis: both compared albums are 44.1-kHz stereo 320-kbit MP3. Question Mark tracks 1/2 expose FFmpeg Skip Samples metadata (1105 samples); Joseph Part Two tracks 15/16 do not. Decoded Everlasting tail and Dawning head contain approximately 18.77 ms and 8.56 ms below -60 dB respectively; the compared Question Mark boundary contains none. This demonstrates source padding but does not prove the entire audible mobile pause is source-only. No media trimming or decoder-contract changes were made.

Focused verification: 315 runtime cases passed; the playing-row accent component case passed in Chrome. Physical Android touch/gapless acceptance and the prior complete CI failure batch remain pending.

### October 6 bounded root-library loading design and implementation

Owner outcome: login must reveal a bounded usable gallery immediately, with exact overall album/artist totals and complete artist names/counts in the sidebar. Additional gallery cards load near the end without clearing existing cards, changing their order or moving the viewport. Existing endpoint names and atomic complete search results remain unchanged. This is one cohesive maintenance delivery, identified as ROOT01вЂ“ROOT05 below; the original design checkpoint claimed no implementation or passing verification. Later sections record the implementation and final native acceptance.

Evidence and prerequisite: root SSR recorded 3732.26 ms, including 3286.27 ms building its payload. Login authentication itself has not been attributed that duration. Startup currently embeds the complete sidebar and at most eight albums from six canonical artists; background hydration still downloads the complete gallery after five seconds. Virtualization limits DOM nodes, not network data. Interrupted ordering evidence compared only the initial six groups; hydrated gallery had 6087 groups versus 6045 sidebar entries. Resolve the membership discrepancy before treating sort alignment as complete. Both surfaces must derive membership, canonical identity and ordering from the same eligible album-to-artist relation, including missing albums, featured artists and aliases.

ROOT01: retain SSR and optimize its measured blocking stage. The sidebar needs album existence, not track durations or every track row. Compare the current materialized eligible-track aggregate with an album-correlated EXISTS using the same active-file and exception predicates; stop at the first eligible file. Preserve path override precedence, the lowest-id track override fallback, scan-cache stale exclusion, category visibility, distinct album IDs and canonical alias deduplication. Missing-album projection rows must join the same membership calculation once, with existing active-album suppression. Do not simply omit missing rows or substitute raw database counts. Reuse existing predicates rather than maintaining divergent definitions. Use query plans and focused semantic cases before selecting the faster equivalent form; no new cache or migration is assumed.

ROOT02: extend existing /view-data with optional root-only `gallery_page_size` and `gallery_cursor` parameters. Absence retains the current full response for compatibility. Only an empty-query, unselected-artist albums root accepts paging; selected-artist, family and search responses keep existing complete behavior. Default requested page size is 50 album occurrences, validated from 1 through 100. Apply the limit before album-detail hydration, including when a single artist owns thousands of albums. Fetch one extra identity solely to determine continuation. One album appearing under two artists is two distinct gallery occurrences; hydration can deduplicate the underlying album internally.

Return an additive `gallery_page` object containing `next_cursor`, `has_more`, `revision` and `page_size`. Keep top-level artist_count/album_count authoritative for the entire filtered library, never the loaded subset. The first page/SSR carries the full lightweight sidebar; continuation omits it and leaves existing sidebar/totals intact. A cursor contains the versioned last artist sort key, canonical artist identity, existing album sort tuple and stable album identity, plus normalized filter fingerprint and catalog/relation revision. Validate and bound its fields; parameterize SQL and derive library/access scope from the authenticated request, never the cursor. Use one repeatable-read snapshot per response. Reuse existing database revision evidence; do not invent a wall-clock revision or cross-request transaction. A revision/filter mismatch returns an explicit restart-required conflict, never silently appends a different snapshot. Before implementing, verify that the revision covers all membership/order mutations, including missing-album changes; include their existing revision if needed.

The cursor sort tuple must reproduce the existing canonical sidebar ordering and existing album order exactly, with identity tie-breakers. Establish the first SSR slice as the contiguous prefix of that order, rather than balancing later artists ahead of unreturned albums from an earlier artist. Reuse the same bounded page repository path for SSR and continuation so the SSR cursor cannot skip cards. Gallery occurrence identity is canonical artist identity plus stable album identity; album identity alone would incorrectly remove featured-artist occurrences.

ROOT03: root bootstrap uses its embedded first page and continuation metadata instead of scheduling an unconditional full-library follow-up. Reuse the existing scroll owner to request the next page when less than two viewport heights remain, including a short initial page. Allow one in-flight continuation for the current view revision. Append by occurrence identity, merge split artist groups without duplicate headings, and retain existing card nodes/cover state and scroll anchor. Prefetch sequentially only while the viewport remains near the loaded end; do not drain the library while idle at its beginning. Existing search submission, artist selection, category changes and leaving the surface invalidate/abort the page owner. Late responses cannot append, alter totals or clear a newer request. Failed continuation keeps rendered cards and permits a bounded subsequent user-driven retry through existing error treatment; no automatic retry loop. Revision conflict restarts from the first page while retaining the current visible gallery until the replacement is ready, then uses existing anchor preservation when its identity survives.

ROOT04: focused acceptance coverage belongs at existing seams: tests/py/test_library_browse_postgres.py for eligibility equivalence, missing/active suppression, canonical/featured membership, exact totals, large single-artist page bounds, equal sort keys, complete traversal without omissions/duplicates and revision changes; tests/py/test_api_read_asgi_routes.py for parameter bounds, invalid cursors, scoped access and unchanged default/search responses; tests/py/test_web_asgi_routes.py for bounded SSR with complete sidebar/totals and no full-root hydration. Runtime tests for bootstrap-init, gallery-refresh-and-status and virtual-artist-grid must cover one-flight near-end fetch, split-group merge, stale response cancellation, unchanged header totals, retained nodes/scroll anchors, failure/retry and filter reset. Add native login-to-gallery and scroll-through-page-boundary cases using isolated Postgres fixtures; preserve existing search, ordering and startup performance assertions. No real-library benchmark is scheduled by this design. Performance diagnosis uses the existing worker-owned slot and existing budgets, without weakening contracts.

ROOT05: review the complete vertical slice twice, run focused checks sequentially, rebuild and deploy the actual checkout to port 5004, and provide the owner a login/All artists/scroll/search manual itinerary. Commit only this cohesive source/tests/documentation unit with the remaining branch work accounted for. Preserve the owner instruction to fix the complete CI failure batch before the next push/full native pipeline; leave PR #21 unmerged. Rollback reverts the optional page contract plus frontend use together; default full /view-data remains compatible. No schema/data rollback, endpoint rename, credential change or production media mutation is planned.

Design grounding: inspected current route, repository, bootstrap and virtual-grid flow; consulted writing-plans and the Postgres pagination guidance. The installed grill-with-docs skill is marked disable-model-invocation and requests an interview; this continuation records the owner's already explicit behavior without inventing an additional approval requirement. Checklist status elsewhere remains unchanged.
ROOT02 implementation refinement: use a transient lightweight occurrence index for common sidebar totals, ordering and page selection. It contains only artist identity/display/sort plus album identity/title/year, and existing missing-album projection data. It never hydrates the complete album/track catalog. Hash the exact normalized ordered membership and filters for continuation validation; this catches aliases and missing membership without assuming the inventory mutation counter covers every writer. The bounded cursor stores version, fingerprint and index position; this is slicing the already-required lightweight membership, not SQL OFFSET over hydrated rows. Each page repeats lightweight membership work (O(membership)); no process cache is introduced. Measure that cost before acceptance. The first page and continuation hydrate only selected album IDs. This supersedes the keyset tuple proposal above while preserving its stability, filter scope and stale-snapshot rejection requirements.
ROOT01/ROOT02 implementation evidence (October 6; native browser evidence below): focused paging/API/root/missing-album selection passed 94 cases; one existing isolated-live-database case remained skipped because its setup was unavailable, and is not passing database evidence. The duplicate-alias row-order regression first failed, then passed after resolving canonical display authority before occurrence deduplication. Presentation-only mode/scale changes no longer invalidate membership fingerprints. First pages always provide complete navigation even if the caller requests omit_sidebar; only a cursor continuation may omit repeated sidebar data.

Bounded read-only real-data diagnostics identified the missing-album all-catalog rollup as a 2680 ms first-page stage. Restricting its candidates to albums with a stale file, while retaining the original all-files-stale aggregate and exception/category handling, reduced the final sample to 322 ms with the same five source rows and one missing album. The final first-eight stage sample totaled 1788.67 ms: aliases 130.56, support 7.33, membership 944.12, missing SQL 322.17, missing conversion 0.05, page selection 347.86 and bounded hydration 36.63. The next-fifty sample totaled 2041.03 ms. Both returned authoritative totals of 6045 artists and 14674 distinct albums, with eight/fifty page occurrences respectively. These are diagnostic server-stage sums, not login-to-paint timings or a performance-suite pass. Forced scalar correlation and a separate lightweight materialization alternative were slower and were discarded; no index/schema/cache change was retained. Real-data artist-search benchmarks were not rerun. Native browser acceptance is recorded below; complete CI and owner manual acceptance remain pending.
### Startup persistence recovery and journal ownership - 2026-10-06

- Restored tag-edit journal recovery and legacy album-exclusion migration in the Postgres startup worker without restoring whole-library hydration. Existing legacy hydration ordering remains covered.
- Changed exclusion migration to the existing atomic targeted upsert/removal operation. A concurrent unrelated exclusion must survive; the regression failed before the fix and passes afterward.
- Active Edit Tags requests now acquire a dedicated Postgres session advisory lease before committing their journal entry. Existing request reservation ownership transfers that lease to either save finalizer. Preparation failure, request handoff failure, submit failure, finalization, and queued-future cancellation release the lease/session.
- Startup recovery attempts one nonblocking intent lease at a time, rereads unfinished status and root identity after claiming, and skips busy or already-terminal intents before inventory/media access. One inventory snapshot is loaded lazily and reused. No schema, persisted cache, endpoint, or global lease registry was added.
- Local evidence: seven initial lease regressions RED then GREEN; two additional queued-cancellation regressions RED then GREEN; related journal/recovery/Edit Tags/reservation selection **73 passed**. Real migrated isolated Postgres, using separate runtime-role connections: **2 passed in 21.00 seconds**, covering active-edit exclusion, release/disconnect recovery, competing recovery exclusion, and terminal reread. The uniquely owned test database and three roles were removed; exact runner/pytest process audit found no survivors. Retained local evidence: `.tmp/intent-lease-live-run.log`.
- Compatibility and deployment restriction: **every writer process sharing the database must use the lease-aware build before startup recovery is enabled against that database**. Older writers do not acquire the advisory lease, so a mixed-version deployment is not proven safe. Per-intent recovery coordination does not introduce general cross-process serialization of independent edits to the same media file. Port 5004 remains the earlier build; this recovery change has not been deployed against the shared real database.
- Full native E2E/CI verification and manual acceptance remain required; focused checks do not authorize merge or publication.

### ROOT03вЂ“ROOT05 native continuation acceptance вЂ” 2026-10-06

- Added mandatory `FTC-GALLERY-STARTUP-006` to the gallery-search-visual shard and fixture matrix. An isolated production PostgreSQL app, released fixture v1.0.25 and native browser login/wheel input prove eight initial occurrences, all 39 sidebar artists and accurate 400-album totals, followed by one cursor request appending 50 occurrences. The test compares the resulting first 58 occurrences and full metadata with the unchanged unpaged API as an independent oracle.
- The visible card captured before the continuation merge remains the same mounted node; scroll-compensated anchor drift is at most two pixels. Native return to the top restores the exact global summary. While scrolled, the existing sticky bar intentionally describes the visible artist rather than the global library. No application-state injection, API mocking, or test-only product switch was introduced.
- Native acceptance **1 passed in 6.7 seconds**, no skipped cases or JavaScript errors. Evidence: `.tmp/root-pagination-e2e5.out.log`, `.tmp/root-pagination-e2e5.err.log`, `.tmp/root-pagination-e2e5.identity.json`, and `.tmp/root-pagination-e2e5.tree.json`. Final semantic Problematic Files reader and shard-registry checks: **46 passed**, `.tmp/paging-harness-final-green.log`.
- Earlier failed native traces were retained: run 3 captured a pre-scroll buffer card that correctly virtualized out after a 2273-pixel wheel; run 4 retained the visible card successfully but incorrectly expected the global summary in the intentional sticky artist context. The final oracle captures a visible card at the continuation request boundary, asserts exactly eight loaded occurrences at capture, and checks global summary after native return to the top. Neither correction weakens visible-card continuity or authoritative totals.
- Teardown verified zero surviving exact owned runner/app/browser identities, no listeners on ports 25264/25266, and deletion of the uniquely owned database and three roles. Port 5004 was not redeployed. Full CI and owner manual acceptance remain required; no merge or publication is authorized by this focused result.

### Remaining playback inventory and targeted repairs вЂ” 2026-10-06

- Replayed all six remaining native playback cases against isolated fixture v1.0.25: **2 passed, 4 failed**. PROBLEMS011 and TAGS024 now pass, including real app restart recovery. Remaining failures are PROBLEMS001 and NONALBUM011, NONALBUM014, and the compound NONALBUM010/009/008/007/006/TAGS007/005 case. Evidence: `.tmp/playback-six-final-results.json` and `.tmp/playback-six-final.out.log`; retained run directory `album-haven-functional-local-669c90c013dd-playback_utilities`. Exact owned runner/browser/app audit found no survivors; ports 44677/44679 cleared and the database plus three roles were removed.
- PROBLEMS001 is a readiness race in the native action helper: the detail API contained the expected Missing cover art row, while reopening the tab started a summary refresh that could clear the prior cached selection after the helper accepted its old DOM. In retained wave 01-02, the summary request began at trace time 26062; screenshot `.tmp/problems001-failure.jpg` at 26294 showed Loading selected album; the exact assertion at 26335 received an empty array. Two new readiness regressions failed before the helper guards; the final focused selection passed **13 tests, zero skips**. Both `waitForReady` and `waitForSelectedDetailSelection` now reject a pending summary refresh. The unchanged native case still requires replay.
- The compound rarity case exposed an independent bounded-root regression: paged root responses permanently returned an empty loose-track list. The first page now reuses the existing bounded non-album candidate loader and configured-root snapshot in the same read transaction, without full album hydration. Continuations omit that list and the existing merge preserves it. The exact backend test failed with an empty list before the fix; focused paging tests passed **17**, and root visibility/pagination runtime tests passed **36**, with no skips. Evidence: `.tmp/root-loose-tracks-red.log`, `.tmp/root-loose-tracks-green.log`, `.tmp/root-loose-tracks-runtime-green.log`. Existing root visibility already includes loose tracks outside the loaded artist window, so no runtime behavior change was required. Native replay and startup performance assessment remain pending; no timing budget changed.

- NONALBUM014 notification diagnosis: the saved notice was already visibly delivered in Settings at trace time 46826 (`.tmp/nonalbum014-46900.jpg`). The test spent another 2.7 seconds reopening the sibling editor and navigating before asserting visibility, exceeding the unchanged two-second notification lifetime. The native case now acknowledges the exact saved notice immediately in the current Settings view, then performs the same one-sibling editor assertions and closes Settings. Native replay remains pending; no notification behavior or timeout changed.

- Follow-up four-case native playback replay: **2 passed, 2 failed**. NONALBUM014 passed (1.2 minutes); the compound rarity case passed (44.7 seconds), proving the bounded root loose-track fix through native reload. Remaining failures: PROBLEMS001 expected three rows but received one; NONALBUM011 timed out at the saved-notification/library-restoration step after the rename. Parent and startup workers own those investigations. Evidence: .tmp/playback-four-final-results.json, .tmp/playback-four-final.out.log, retained album-haven-functional-local-eaa45e0bad82-playback_utilities. Final exact PID/creation audit found zero survivors; ports29300/29302 clear; owned database and three roles dropped. Test slot released for PR22; metadata and performance runs remain pending.
- Paged startup benchmark helper review: two new regressions failed before correction; **17 focused tests passed, zero skips** afterward. Initial authority collection ignores cursor continuations; runtime accumulated-page validation permits appended rows but requires the cursor end position to equal the loaded occurrence count. Both root startup performance specs validate this authority instead of requiring the obsolete full-payload tier. All timing budgets remain unchanged. Evidence: .tmp/paged-startup-helper-review-red.log and .tmp/paged-startup-helper-review-green.log.

### ROOT01вЂ“ROOT05 canonical root display completion вЂ” 2026-10-06

Outcome: the applied All artists gallery and sidebar retain the same canonical artist membership and order during first paint and every page continuation. The owner's original ordering screenshot has All artists (6045) selected; the visible Neal Morse text is an unsubmitted draft. Historical full-gallery evidence still had 6087 display groups versus 6045 sidebar entries, including 31 repeated display names and 14 gallery names absent from the sidebar. Server membership totals alone did not close this discrepancy.

Responsible boundary: `splitArtistGroupForDisplay` expands canonical root groups into raw album-artist buckets after database paging. Root-only display must retain the existing canonical group and every album occurrence. Preserve raw album/track credits, featured occurrences, the selected/search Combine similar artists preference, and Home behavior. Resolve scope from the applied view, never the draft search input. No schema, media, endpoint or credential change.

Acceptance: a continuation that adds a differently credited album must not split or reorder the canonical artist; numeric, punctuation and non-Latin artist boundaries retain sidebar order; the same album under distinct canonical featured artists remains present; typed-but-unsubmitted search remains root; selected/search/Home split and combine controls retain behavior. Add RED-first regression at the existing display helper plus real continuation merge. Extend native ROOT006 to compare the rendered display model and headings, traverse the complete isolated fixture across artist boundaries, and compare every occurrence with the unchanged full-root API oracle. Preserve existing mounted-node/scroll and authoritative-total checks. No real-data benchmark.

Delivery checkpoint: finish focused RED/GREEN, complete relevant review, and native verification within the existing serialized test slot before local build. Preserve complete CI failure batching and manual PR21 acceptance; no merge or release. Rollback reverts only this root display guard and associated coverage together; persistence and canonical server inventory remain unchanged.

### ROOT03 bounded same-scope refresh coverage вЂ” 2026-10-06

Outcome: a root refresh in the same data scope preserves previously loaded bounded coverage and scroll through tag saves, background refreshes and modal refreshes, including gallery display/scale changes. Evidence: TAGS010/011/013/022 in `.tmp/metadata-paging-failure-diagnosis.md`; TAGS022 reopens the existing page rather than starting a fresh browser. Prerequisite: complete metadata10 inventory retained (five passed, five failed), failing focused regression before product changes, and the root agent's sole-test-slot grant.

Acceptance: actual `fetchAndRender` tests reconstruct 108 occurrences through fresh pages of 50, applying atomically; cover terminal shrink, refreshed totals/deletions, same-scope display/scale changes, changed categories/scope and unchanged normal/search/selected/startup single-page behavior. Cover navigation/mutation/guard cancellation, HTTP503, nonadvancing/repeated cursors and HTTP409/revision mismatch with only one bounded restart. Existing native two-pixel scroll and persisted-topology contracts remain in TAGS010/011/013/022. Diagnose TAGS012 separately without changing its five-second contract.

Compatibility and rollback: no API or schema change. Preserve request ownership and the old mounted view until atomic success. Rollback the runtime/test pair together. Checkpoint: focused RED/GREEN and complete relevant local review, then repair the whole CI failure inventory before commit/push and complete native PR CI. PR21 remains unmerged. Synchronize product owners before rebuilding the runtime bundle.

Root display verification: the new canonical page-boundary regression failed twice before the guard, inserting a duplicate Alice heading for both an empty draft and an unsubmitted Neal Morse draft. The root-only guard passed all five focused cases, including selected/search/Home compatibility. Directly related display, paging, virtual-grid and gallery-main checks passed **145 tests, zero failures/skips**. Evidence: `.tmp/root-ordering-display-red.log`, `.tmp/root-ordering-display-green.log`, `.tmp/root-ordering-related-green.log`. ROOT006 now reads actual display groups and mounted headings, traverses the complete isolated fixture with a fixture-derived finite page bound and existing bounded waits, and requires crossing an artist boundary. Its extended native replay and synchronized runtime bundle rebuild remain pending.


### October 6 final local reconciliation checkpoint (supersedes pending native replays above)

The seven-case native replay completed with **five passed and two failed**. Extended ROOT006 passed, including full fixture traversal across canonical artist boundaries, exact gallery/sidebar identities and occurrences, and the existing retained-node/two-pixel anchor contract. TAGS010, TAGS011, TAGS012 and TAGS013 passed with their existing persistence, topology and scroll expectations. Earlier failed runs remain historical evidence; this checkpoint does not erase them.

TAGS022 still failed in its fresh browser after the original-page reopen passed: a native wheel reached the previous loaded boundary while a continuation increased the scroll extent without moving the retained anchor. Its unchanged 5000 ms settlement predicate then waited for movement at what had become an interior position. This is separate from the cursorless refresh repaired by bounded coverage. Evidence: `.tmp/tags022-fresh-scroll-evidence.md`. The native traversal repair and exact replay remain pending; no timeout or product scroll contract is relaxed.

PROBLEMS001 still failed at `waitForReady` after rule reversion and before the suggested-edit Apply assertions, using the unchanged 60000 ms contract. Thus neither the prior atomic row reader nor the current explicit-selection assertions close this remaining failure. Evidence for all seven cases: `.tmp/reconciliation-seven-current.out.log` and `.tmp/reconciliation-seven-current.err.log`. The parent audited cleanup before releasing the shared execution slot; the separately owned PR22 work holds that slot at this checkpoint.

The shared runtime bundle was rebuilt before this native replay. Independent read-only composition verification found all 77 bundled modules equal to current source. The first final complete local review covered 103 tracked changed files plus eight intended untracked source/test files, excluding private output. It found stale JavaScript inventory totals after adding ROOT006: the matrix and functional shard both own 123 functional cases, and the matrix has 418 total entries. The count assertions and descriptive title are now corrected; exact verification and the second complete review remain pending. The earlier malformed BEL character in the historical artifact directory name is repaired. No merge, push, release, deployment, or performance-budget change is established by this checkpoint.

### PROBLEMS001 invalidated summary-load liveness repair вЂ” 2026-10-06

Outcome: after an acknowledged rule revert invalidates an in-flight Problematic Files summary, discard its stale response, release only its own promise/loading state, and let waiting callers obtain one fresh current summary without another user action. The native seven-case inventory above is the prerequisite. Source diagnosis found the stale response returns null while its finalizer leaves `loading` and `loadPromise` set; reopening the tab then joins the already-settled stale promise. Existing regression coverage checked only `loaded === false` and did not prove retry liveness.

Acceptance: first add a failing focused regression for an invalidated in-flight summary with two waiting callers. Require no stale commit, exactly one new current request, current-result delivery, and protection of a newer promise owner. Preserve the existing genuine rule-revert integration, then rerun exact native PROBLEMS001 under its unchanged 60000 ms contract. Test execution remains serialized through the parent's shared slot.

Compatibility and rollback: no API, schema, timeout or acceptance change. Reuse the existing loader ownership boundary; rollback the loader/test repair together. Complete the full CI failure batch before the next push and complete native PR pipeline; PR21 remains unmerged pending owner acceptance.


### Owner queued-request gate before CI вЂ” 2026-10-06

The complete local audit is retained in `.tmp/queued-issue-audit-2026-10-06.md`; private media/data evidence remains outside tracked documentation. Do not start another CI run until the queued issues are attended to. Historical requests already implemented must not be reopened without new failing evidence.

- [x] Reconcile mobile accents, edition tabs, thin seek, full-art swipe/Back/buttons/focus, Rules actions, Problematic table/truncation/year/selection/drag/Apply/Create Exception, search behavior, counts/sidebar/order/paging and Phase9 mobile coverage against current code and retained tests.
- [x] Preserve owner acceptance of search speed/no black flash; no further real-data performance benchmarks. Retained native family correctness includes the specifically reported missing Neal Morse bands.
- [x] Record automated gapless source-boundary/output proof separately from unrecorded owner listening acceptance; do not claim every physical mobile behavior verified by controlled browser fixtures.
- [x] TAGS022 and PROBLEMS001 exact native cases passed under unchanged contracts; PROBLEMS001 also verifies loader recovery, explicit Apply selection, and mobile Rules placement. Retained evidence is summarized below.
- [x] Establish the exact Cyrillic artist/album membership and track-credit provenance; analogous passing credit tests alone do not answer the owner's specific screenshot. Authenticated exact-credit evidence is recorded below.
- [ ] LAN omission is explained by the existing loopback-only folder capability. Localhost affordance remains unverified under preserved trusted-origin configuration; do not broaden that boundary.
- [x] Earlier shared-writer deployment blocker resolved at the authenticated PID24092 checkpoint. Later repairs require a new final-source port5004 deployment; the new browse/scrobble-only conversion has focused guard/launcher verification but is not yet deployment proof.
- [x] Registry counts and second complete local review reconciled at their recorded checkpoint; later focused independent reviews are separate. Commit/push and complete current-head CI remain pending; keep `skip_reviews`, never add `skip_tests`, and leave PR21 unmerged.

### Exact featured-credit follow-up вЂ” 2026-10-06

Read-only diagnosis confirmed that В«РћС‚РїРµС‚С‹Рµ РњРѕС€РµРЅРЅРЅРёРєРёВ» is a featured performer on Р›РµРѕРЅРёРґ РђРіСѓС‚РёРЅвЂ™s В«Р“СЂР°РЅРёС†Р°В» from В«Р”РµР¶Р° Р’СЋВ» (2003). The retained artist credit contains `feat` without a period and guillemets; the spelling is preserved exactly rather than rewriting source tags. Album membership is therefore grounded in a real track credit.

Current album-detail hydration preserves the raw track artist and canonical album artist, and the shared row formatter already accepts this syntax. Added the exact Cyrillic case to `test_build_track_rows_omits_album_artist_from_featured_track_artist_credit`; both parameter cases passed (2 passed). No product change was required for this regression. Fresh deployed authenticated UI verification remains pending; the historical screenshot is not evidence that the current build still omits the credit.

### PROBLEMS001 mobile action placement reconciliation вЂ” 2026-10-06

The final two-case native replay passed TAGS022, including its fresh-browser selection path. PROBLEMS001 passed the formerly blocked summary readiness step and reached its mobile Rules geometry assertion. Retained trace evidence attributes that failure to the October 5 page-local CSS override moving Revert to grid row 3, conflicting with CompactDataTable's existing top-right action contract. The override also retained the shared fixed action width; its apparent full-width intent was not an implemented compatibility contract. Its commit message requested action exposure, but recorded owner requirements do not authorize replacing the existing mobile placement acceptance.

Removed only that conflicting override, retaining the shared component placement and existing 10px mobile inset. Added a focused regression preventing page-local row-placement overrides. Exact mobile exclusion tests reproduced RED (new assertion failed) and passed GREEN (2 passed). Existing native geometry, timing and action expectations remain unchanged. Native PROBLEMS001 must still prove visible and usable Revert actions; focused source assertions alone do not establish that result.

Compatibility and rollback: no runtime JavaScript, schema, API or permission changes. Revert the CSS deletion and regression together if needed. Prepared `.tmp/run-problems001-mobile.ps1` and its monitored launcher for exactly one native playback-utilities case using the existing isolated fixture runner. Launch remains serialized through the shared test slot; no CI or publication is authorized by this checkpoint.

### Current local build verification вЂ” 2026-10-06

Rebuilt the runtime bundle from all 77 modules and replaced only the verified prior local application process. The current branch is running on the owner-requested local port. Existing configuration and account credentials were preserved; no password/auth-record changes, production promotion, media scan, or benchmark was performed.

Authenticated browser verification showed the gallery header with 6045 artists and 14674 albums, with All artists showing 6045 in the sidebar. The exact В«Р”РµР¶Р° Р’СЋВ» album renders В«Р“СЂР°РЅРёС†Р°В» with `feat. В«РћС‚РїРµС‚С‹Рµ РњРѕС€РµРЅРЅРЅРёРєРёВ»`; other retained featured credits also display. The verified LAN flow recorded no page or console errors. Screenshots and sanitized evidence are retained privately with the queued-request audit.

The server-local folder action is intentionally omitted over LAN. A separate localhost login probe returned400 under the preserved trusted-origin configuration; localhost UI visibility was not verified and trusted origins were not broadened. Browser verification processes were closed and audited; the requested application remains running.

### Synthetic observation-contract reconciliation вЂ” 2026-10-06

After the full synthetic/scan inventory completed, corrected two validated harness expectations without changing product behavior or timing budgets. The retained root-browse trace contained eight preview albums with empty track arrays and no hydrated tracks. Raw bootstrap/API summaries must still omit the tracks field entirely; compact runtime summaries may omit it or retain only an empty array. Two new boundary tests first failed, then all 19 directly related benchmark-helper tests passed with no skips.

FTC-SEARCH-NAV-026 now expects the complete initial РђСЂРёСЏ family defined independently by the synthetic fixture's ariaFamily contract, rather than only the primary artist. Exact Р’РёС‚Р°Р»РёР№ Р”СѓР±РёРЅРёРЅ filtering, search-clear continuity, exclusions, and subsequent empty-selection assertions remain unchanged. The retained failure trace showed the correct applied query and a settled complete family, not a stale response. Native replays of both affected scenarios remain required.

### Cold-scan bounded partial browsing repair вЂ” 2026-10-06

FTC-OPS-014 retained trace proves Browse Library waited 49.641 seconds for the first card and another 1.451 seconds for covers. Browse appeared after 32.436 seconds, but partial-gallery readiness took 51.918 seconds, finishing after the scan. Root requests now include gallery_page_size; that bypassed the existing published transient cold-scan snapshot and waited for committed PostgreSQL publication.

Reuse the existing root page selector for the transient payload after the same root/filter validation. Preserve bounded occurrence pages, full snapshot totals/sidebar, rating overlays, preview-only albums, and continuation revision/restart behavior. Namespace transient revisions by scan generation so growth, new scans, and transition to committed data invalidate old cursors. Existing scan completion refresh replaces the snapshot with committed authority. No persistence, schema, permission, timing-budget, or native acceptance change. Exact route regression reproduced the bypass before implementation. Roll back route/helper/regression together; complete focused verification and unchanged native active-scan browsing proof before publication.

### SSR preview boundary correction вЂ” 2026-10-06

The subsequent isolated startup diagnostic exposed an overgeneralization in the preceding harness repair: embedded SSR previews were treated as direct API summaries. Existing `startup_bootstrap` deliberately emits empty track arrays, and `test_build_initial_view_preview_preserves_compact_album_track_count` already asserts that contract. No product defect was established by that failure.

Corrected the harness to distinguish embedded previews explicitly: API summaries still omit tracks; embedded SSR and compact runtime accept only absent or empty arrays, rejecting populated or invalid values. The embedded flag does not relax page bounds. The new SSR acceptance case failed before correction; all 20 related helper tests then passed. The original diagnostic evidence remains retained; this correction does not turn that failed run into a performance pass. Native replay remains pending.

### Measured root startup request repair вЂ” 2026-10-06

Outcome: remove unnecessary full-library track aggregation and first-request template compilation from bounded All artists startup, preserving full authoritative sidebar/counts, page membership, eligibility, ordering, and existing performance ceilings. This completes the existing ROOT01вЂ“ROOT05 startup/paging acceptance work; it introduces no new delivery or publication boundary.

An isolated timing-only diagnostic measured 927ms root payload construction, including 531ms membership SQL and 93ms page selection. Template response took 382ms, including 287ms across 15 Jinja compilation calls and 51ms asset hashing. The diagnostic failed the separately recorded SSR observation assertion before completing performance acceptance; these measurements are diagnostic evidence, not a passing native run. No further real-data benchmark was performed.

Compared unchanged membership SQL, unaggregated EXISTS eligibility, and album-grain eligibility on one uniquely owned synthetic fixture in a repeatable-read, read-only transaction. Both passes returned exactly the same 5330 sorted rows and digest. Counterbalanced baseline/raw/album/album/raw/baseline client timings were 1039.646/269.469/422.263/617.236/195.739/501.235ms; corresponding baseline EXPLAIN execution was 498.319/450.125ms versus raw EXISTS 133.962/136.790ms. The raw plan avoided the baseline disk reads. Retained private evidence: `.tmp/perf_62efdd9bf545/startup-membership-query-plans.json`.

The shared eligibility CTE retains aggregation by default. Only root membership disables duration aggregation and per-track GROUP BY, allowing EXISTS to use eligible rows directly; path override precedence, track defaults, stale-file exclusion, category filtering, and final distinct artist/album membership remain unchanged. Existing bounded album hydration still performs its required rollups. At application lifespan entry, compile existing templates into the existing Jinja environment cache without rendering; no request/account context, additional cache, persistence, configuration, or asset-hash cache is introduced. Jinja auto-reload remains enabled.

The new membership and first-request compilation regressions both failed before implementation; the reload compatibility case already passed. Focused verification then passed 26 cases covering those regressions, root pagination, shared eligibility, bounded preview rollups, and startup/shutdown lifecycle. Evidence: `.tmp/startup-repair-red.log` and `.tmp/startup-repair-green.log`. Independent incremental review found no validated issue. Native startup/browse/cold-scan acceptance remains pending; budgets were not changed. Rollback reverts the membership opt-out, compile-only warmup, and their regression coverage together without schema or data migration. Preserve the existing full-CI, owner manual acceptance, and unmerged PR21 checkpoint.

### NAV026 drawer handoff continuity repair - 2026-10-06

Outcome: preserve the retained Artist Family panel during search-clear continuity. The native FTC-SEARCH-NAV-026 replay passed the corrected complete-family expectation, then failed with familyMutationCount 2 and familyScrollChanged true (expected 0 and false). Search focus replaced the family drawer with recent-search suggestions, but the outgoing drawer's delayed close still changed its hidden state after continuity observation began. Its transition and timeout callbacks could both complete.

Surface replacement now finishes the departing drawer synchronously before activating the next surface. Ordinary dismissal retains its animation; completion cancels the alternate callback and is idempotent, and reopening cancels the previous pending close. Search-clear behavior, family assertions, timing budgets, and native waits remain unchanged. This reuses the existing shared surface lifecycle; rollback reverts this lifecycle change and its four regression cases together, without data or schema changes.

Four targeted regressions failed before the fix. Exact verification now passes 4/4 with zero skips; the related gallery runtime contract file passes 70/70 with zero skips. Retained logs: `.tmp/nav026-close-focused-green.log` and `.tmp/nav026-runtime-green.log`. Test-process audit found no remaining owned Node test process. `rtk npm run build:runtime` completed and rebuilt the runtime bundle from 77 modules.

The original native continuity failure remains open pending the exact FTC-SEARCH-NAV-026 replay. These unit results do not replace native acceptance. No native run, deployment restart, commit, push, merge, or publication was performed for this checkpoint; PR21 remains unmerged.

### Stale-file startup index repair вЂ” planned 2026-10-06

The enhanced actual-request diagnostic attributes 1704ms to missing-album discovery: PostgreSQL scans all 57,980 track-file rows (14,444 heap blocks, approximately 113MiB) to find zero stale files. A later warm SQL-only check is faster but still reads thousands of blocks. Membership uses the intended unaggregated EXISTS SQL and category_count=0; no database-role or filter mismatch was found. This is a measured access-path defect rather than evidence for increasing the app-open ceiling.

Extend the existing ROOT01вЂ“ROOT05 startup delivery with migration 0085: an idempotent partial index on local_track_files(track_id) where scan_cache_stale is true. Leave the query, generated staleness column, active/missing transitions, exception precedence, result ordering, permissions and payload contracts unchanged. Existing code remains compatible before and after the index; PostgreSQL maintains membership transactionally as metadata changes. No data rewrite or new persistence authority. Rollback drops only this index using a subsequent authorized migration; old readers/writers remain valid throughout.

Acceptance: RED migration contract, focused GREEN registry/index contracts, unchanged missing-album row results, the retained synthetic plan using the narrow stale candidate index instead of the full-file scan, and transactional active/stale/returning-file lifecycle preservation. Apply through the normal isolated migration ledger to the retained fixture only, then independent review and ordinary native app-open verification with unchanged budgets. Diagnostic profiling is not authoritative timing evidence. Production changes, merge and publication remain outside this checkpoint.

Verification update: the migration contract failed because 0085 was absent, then four focused migration registry/index and existing missing-query scope cases passed. The migration was applied twice through `isolatedPostgres.apply_migrations` on the retained synthetic database; its ledger checksum matches the source and the second application is idempotent. The unchanged missing query returns identical rows and now uses `local_track_files_stale_track_id_idx`: 0.658ms execution, four shared hits, zero reads, versus the earlier 14,444-block full-file scan. Six transactional cases cover active, stale, mixed active/stale copies, all copies stale, returning active copy, and stale-copy deletion; uniquely owned proof rows were rolled back and absence verified. Evidence: `.tmp/stale-index-red.log`, `.tmp/stale-index-green.log`, and retained fixture `stale-index-proof.log` / `stale-index-after-plan.json`. Ordinary native acceptance remains pending; this SQL proof does not replace it.

### Measured idle playback preparation вЂ” 2026-10-06

The paired private browser/server startup capture identified synchronous AudioContext creation on initial rendering (169ms sampled CPU), before any play action. Defer only this existing warmup to browser idle work (bounded 1000ms timeout, timer fallback); existing first-play and resume paths still await shared engine preparation. The existing unload cleanup cancels pending warmup logically, preventing a queued callback from reopening audio or its socket after pagehide/beforeunload. No sidebar, paging, permission, gapless algorithm, asset freshness, or performance-budget contract changes.

The new initial-render regression failed before implementation. Focused bootstrap and streaming tests passed 138 cases, including unload before idle, rejected preparation, first-play preparation, and existing streaming lifecycle contracts. Private evidence: `.tmp/startup-idle-audio-red.log` and `.tmp/startup-idle-audio-green-v2.log`. Rollback restores only synchronous warmup and its related tests. This repair is not a native startup acceptance result; the unchanged 2500ms ceiling remains outstanding.

The same instrumented request spent 1614ms in membership SQL. Read-only EXPLAIN using the retained synthetic app role and identical all-category parameters returned the same 5330 rows: first execution 504.904ms (planning 93.61ms), second 79.977ms (planning 4.986ms). Both had no shared reads, JIT, parallel workers, or temporary writes. This variability remains unattributed; no SQL or acceptance change is justified by it. Private plans: `.tmp/perf_68a5c63f9173/membership-current-plans.json`. No real-data benchmark was run.

### Owner-authorized shared browse-only port5004 conversion - 2026-10-07

Outcome: run the current cover branch against its existing shared data on port5004 while sandbox3 owns library mutation. Preserve existing credentials, authenticated browsing/search, playback, account preferences and account-only scrobble state/retries. No production/sandbox3 process, schema, media or password changes. This is an owner-authorized temporary deployment capability, not production promotion.

Reuse the existing shared-browse guard model at hydration, relation repair and scan entry points; do not start ordinary startup recovery, watchers, reconciliation, scan, cover backfill or mail workers. The private launcher uses the current checkout configuration and TLS rather than copying production settings. Explicitly permit only authentication, account preferences and playback/scrobble mutations; fail closed for library/media mutations, including library-owned ratings. Existing cover variants may be served, but GET cover misses must return source art without generating media-adjacent previews. Preserve original authentication/capability/CSRF routing.

Acceptance: focused denied-writer and allowed-read/playback/account route cases; no background library writers; strict existing projection hydration without repair; cover miss causes no generation; scrobble retry lifecycle is started/stopped through its existing service. Review before replacing only the exact owned5004 process, then authenticated UI proof. Shared test execution remains serialized. Rollback restores the prior private launcher after the exclusive-writer window ends; no schema/data rollback is needed. Deployment remains pending tests/review; PR21 remains unmerged.

### Root continuation geometry after layout вЂ” 2026-10-07

Outcome: preserve bounded root paging while removing a forced layout from the initial sidebar/gallery write frame (existing ROOT01вЂ“ROOT05). The private trace's automatic pagination callback took 136.386ms, containing 54.847ms style recalculation and 80.933ms layout. It reads viewport geometry after the full sidebar has just been inserted. Schedule only the two automatic render/bootstrap continuation checks in the next animation frame after those writes; keep scroll-triggered checks immediate, all sidebar rows/counts, initial cards, cursor ownership, and startup readiness marks unchanged. No endpoint, timing budget, or acceptance change. Add callback-order regressions and retain paging coverage. Rollback restores single-frame scheduling at these two sites. Native startup acceptance remains required before completion/publication.

Verification: callback-order regressions failed in both automatic paths against their original single-frame scheduling (2 failures, 1 unrelated nonpaged pass). With second-frame scheduling, all 214 related bootstrap, gallery refresh, and root pagination tests passed. Evidence: `.tmp/startup-pagination-layout-red.log` and `.tmp/startup-pagination-layout-green.log`. Source review confirmed immediate scroll and continuation-drain paths remain unchanged; native replay remains pending.

### Final local failure reconciliation вЂ” 2026-10-07

This checkpoint supersedes earlier pending-result statements without erasing their failed-run evidence. All 44 original functional failures now have cumulative exact local pass evidence. TAGS022 passed in `functional-final-two-20261006-225805.out.log`; PROBLEMS001 passed in `problems001-mobile-20261006-232646.out.log` (58.7s, zero skipped/errors). The 44 JavaScript failures, 56-case Python identity shard, and 15 migration-ledger cases have focused pass evidence in the cumulative inventory. Hosted cover-provider evidence uploads succeeded in the retained hosted log; this does not establish a full current-head CI pass.

Paired-search calibration and artist-family targets passed in `.tmp/synthetic-five-inventory-20261007.json`. Root-album-browse passed after the embedded SSR boundary correction, recorded in `.tmp/four-repair-native-replay-20261007.json` (run `2026-10-07T01-04-04-663Z`). Scan OPS015/OPS017 passed in `.tmp/scan-performance-20261007-000315.out.log`; OPS014 passed in `.tmp/scan-cold-replay-20261007-010710.out.log`. Cold partial browse improved from the historical 51918ms to 4002ms under the unchanged contract. Search-all-artists passed all three cases, including FTC-SEARCH-NAV-026, in `.tmp/retained-probe-native-results-20261007.json`; that fixture's owned processes, ports, database, and roles were confirmed absent.

The final ordinary FTC-GALLERY-STARTUP-005T app-open run passed **1794ms against the unchanged 2500ms ceiling**, run `2026-10-07T02-55-07-040Z`, with evidence under `.tmp/perf_68a5c63f9173/ordinary-app-open-second-raf/native-artifacts`. No private profiler, retry, or budget change was used. Historical 3056/3151ms failures, the 4580ms replay during nearby severe host pressure, and the controlled 2507ms replay remain retained. The owner authorized termination of the specifically identified runaway user Chrome renderer; after that host remedy, the measured automatic-pagination forced-layout repair supplied the final source change. Host samples were not captured throughout the original failure, so nearby resource pressure is not represented as complete causal proof. Final cleanup confirmed original/replay process trees and SQL sessions absent, scoped ports 5980вЂ“6020 clear, fixture database and all three roles absent, and prepared-profile removed. `.tmp/performance-final-inventory-20261007.json` retains this evidence. Aborting the original paused runner only for cleanup does not invalidate the separate completed ordinary pass.

The earlier second complete review covered 105 tracked files plus eight intended untracked files. Preserve its exact evidence: the combined invocation was 222 passes and two loader-fixture failures, followed by corrected loader 40/40; it was not a single 224-case green run. Subsequent startup, migration, NAV026, idle playback, pagination scheduling, and shared-browse guard reviews were narrow independent reviews. Current intended scope at reconciliation is 114 tracked changed files plus ten intended untracked source/test/migration files (124 total), excluding private `output/` artifacts.

Shared browse/scrobble conversion verification comprises nine product-guard cases and 30 private launcher cases. Existing account credentials, authentication/CSRF checks, shared data, and production boundaries are preserved. The later authenticated deployment checkpoint below supplies final-source port5004 proof. Earlier authenticated LAN proof showed 6045 artists, 14674 albums, the exact Cyrillic featured credit, and no page/console errors; later startup/NAV026 changes postdate that checkpoint.

Remaining gates: final diff/evidence review and commit; push to existing PR21 and complete native CI, collecting all failures before another repair batch. Preserve `skip_reviews`, never add `skip_tests`, and leave PR21 unmerged. No replacement draft PR, merge, release publication, production promotion, or main synchronization. Owner accepted real-data search speed/no black flash; no further real-data benchmark was run or required. Gapless automated boundary/output proof is separate from unrecorded owner listening acceptance of Everlasting в†’ Dawning. Physical-phone seeking, swipe/Back and visual acceptance remain unrecorded; Phase9 mobile follow-up documentation is complete. Localhost folder affordance and exact latest first-open edition/mobile-search native journeys retain their documented evidence limits.

### Final-source port5004 verification вЂ” 2026-10-07

The browse/scrobble-only build is verified on PID37736, created `2026-10-07T03:04:13.2261240Z`. Existing owner credentials were used unchanged; no password or account record was replaced. Authenticated UI showed 6045 artists and 14674 albums, with zero page/console errors and zero 5xx responses. Account preferences GET returned200. Library-writing refresh routes, cover lookup, and loop mutation probes returned409. Playback/scrobble routes remain available; no external scrobble was sent as a test. Ordinary startup recovery, watchers, reconciliation, scans, cover backfill and mail workers are omitted from this temporary shared deployment.

The full review's P1 shared cover-queue finding was fixed at the enqueue boundary; 17 focused cases passed and independent re-review was clear. Preserve the earlier nine product-guard and 30 private launcher passes as separate evidence. The stopped initial replacement is not the verified process. Browser verification processes were audited absent; the requested server remains running (owned session80870). Private proof: `.tmp/browse5004-ui-1791342365525/evidence.json` and `gallery.png`. Exact Cyrillic provenance was verified at the earlier recorded album-credit checkpoint; this gallery verification does not claim a new album-credit observation.

Final-source deployment is complete. Full-branch second review remains in progress, followed by commit/push and complete native CI. PR21 remains unmerged; no release, production promotion, or main synchronization is claimed.

### 2026-10-07 mounted family ownership repair
- Outcome: selecting a family member includes its authoritative shared albums after artist search. Scope: FTC-ALBUM-DETAILS-021 / FTC-ARTIST-FAMILY-019 / FTC-NON-ALBUM-015; no acceptance-budget change.
- Evidence: native trace shows Partner's mounted group lacks shared release while Lead/composite groups contain it; optimistic family reuse suppresses the authoritative request.
- Approach: reuse existing sidebar-count completeness check at mounted-family selection boundary; retain complete-family reuse. Compatibility: incomplete projections fetch existing endpoint; rollback is isolated guard removal. Acceptance: focused regression plus unchanged native compound case. Checkpoint: local review, parent commit/push; PR21 remains unmerged.
- Follow-up native trace: initial count-only guard was insufficient. At the actual failure, retained query stays `Control Signal Lead`; Partner group and sidebar both report 11, but shared release remains only in Lead/composite groups. The earlier empty-query snapshot belonged to cleanup, not the failing selection. Artist metadata on an album outside the selected group now conservatively requires the existing authoritative fetch; no client ownership synthesis. Equal-count retained-query regression reproduced before repair.

### Completed CI repair batch вЂ” 2026-10-07

The complete hosted inventory for run `37565714514`, head `f1243c167b2010f971dc2eb517ad07e706398f95`, was collected before repairs: 23 jobs finished, nine primary failures and one downstream gate failure. Primary failures were production parity, cover providers, Python, playback utilities, Windows JavaScript contracts, pinned-Chrome components, portable JavaScript, metadata mutations, and gallery/search/visual. Performance jobs passed. Exact original cases and raw logs remain in `.tmp/ci-37565714514-failure-inventory.json`, with separate Python18 and portable-JavaScript11 inventories. This checkpoint does not claim a new complete hosted pipeline pass.

The JavaScript11 failures were reproduced and passed with corrected year/subtitle fake-DOM contracts; related verification passed355cases separately. Component ownership now counts191 approved components. Production parity keeps browser selectors and read-only observations in their owning POMs. Gallery selection tests use the shared tab component's `aria-selected` contract. FTC-GALLERY-033 now records the owner-approved pending-search behavior: retain the current gallery, show no blocking library loader or embedded warning, and preserve the original floating-warning appearance and dismissal assertions. This supersedes historical spinner wording for that case.

Original native failures have exact cumulative local passes, across separate runs: COVERS019, PROBLEMS001, GALLERY030/032 and NAV002/003/026 in `.tmp/ci-native-repair.out.log`; NAV022, FAMILY015, FAMILY014 and GALLERY033 in `.tmp/ci-native-final6.out.log`; NAV020 in `.tmp/ci-native-final2.out.log`. TAGS015 passed its unchanged exact local replay; no fabricated product fix is attributed to it. The final ALBUM-DETAILS021/FAMILY019/NON-ALBUM015 compound passed unchanged in `.tmp/ci-native-interview-owner.out.log` (one case, zero skipped/errors,3.1minutes). Its retained-query family step passed17.69seconds and all18 Interview tracks remained available in Loose Tracks before restoration. Earlier failing traces remain retained.

The traversal repair uses native wheel input to reach the loaded boundary, then requires actual accumulated product inventory before absence can pass. Raw final-page responses alone never prove completeness. Applied gallery evidence remains read-only, distinguishes positive presence from ready accepted-scope presence, rejects unobserved replacement queries, and preserves every original absolute deadline. The final product repair conservatively fetches authoritative selected-artist data when another mounted group contains potentially relevant album membership absent from the selected group. Complete preview-card reuse remains supported; no ownership is synthesized from broad artist-credit metadata.

Final focused verification:341 JavaScript cases passed in `.tmp/ci-family-membership-query-green.log`; production parity passed; the77-module runtime bundle rebuilt successfully. These are separate from earlier243-case boundary and related355-case runs. Independent local review completed at least four full passes and the final resulting33-file batch reassessment found no validated findings. No budget, acceptance assertion, or required case was weakened or skipped.

The final native wrapper exited0. Exact recorded PID/creation identities were absent; ports49785/49787 were clear; the isolated database and all three roles were dropped; owned track credits and Interview exceptions were restored. No further test wave is running from this repair task. Port5004 was not restarted or changed by this batch. Physical-phone and owner listening acceptance remain unrecorded.

Latest owner direction: finish this local batch, commit/push, then audit all queued user issues; do not resume CI failure debugging after that push. Keep PR21 unmerged and preserve `skip_reviews`; never add `skip_tests`. This direction supersedes earlier next-step CI-loop wording for the immediate handoff.

### Owner override: visible search progress (2026-10-07)

The owner now requires an immediate centered `Searching` spinner on explicit submission. This supersedes the prior no-loader search assertion. The existing loader uses a transparent, nonblocking overlay while retaining gallery nodes; request ownership spans preview and full hydration, and clears progress on success, failure, or supersession. No minimum display delay is added. Focused runtime verification: 342 passed, zero failures/skips (`.tmp/searching-overlay-focused.log`); runtime bundle rebuilt from 77 modules. GALLERY033 now asserts the search indicator while retaining its no-blackout and warning-lifecycle checks; the native scenario has not been rerun. Rollback is the search-only request option, overlay renderer/CSS, and matching tests together. No commit, push, CI run, or deployment performed for this change.

### Seek preparation latency investigation вЂ” 2026-10-07

Owner reported that the playhead moves immediately but audible playback remains at the old position for 1вЂ“2 seconds, and selected Everlasting as the reproduction track. The shared client seek path prepares 12,000 target frames (250 ms at 48 kHz) before an AudioWorklet render-boundary cutover; investigation found no fixed 1вЂ“2 second delay in that path. Existing audio remains active during preparation.

A concrete backend cost was reproduced: unchanged mixed-case LAME MP3s launched a compatibility FFmpeg probe for every seek. Before repair, Everlasting decoder startup through all 12,000 prepared frames measured 1238.56/366.87/470.88 ms at positions 35/170/347 seconds; compatibility probes consumed 1045.50/140.75/144.00 ms. Filesystem warmth varies, so these are stage observations rather than a controlled performance acceptance result.

The repair retains up to 128 successful compatibility results in process memory, keyed by media and decoder path/stat identity. Failed or cancelled probes are retried; changed identities invalidate reuse; native Skip Samples results are cached too. No persistent cache, media mutation, buffering-budget change, architecture change, live restart or CI/push is part of this repair.

Six cache regressions failed before implementation. Final focused verification passed 51 cases across test_mp3_gapless.py and test_playback_pcm.py, including real FFmpeg sample-boundary comparisons, intentional silence, cancellation cleanup, identity invalidation, eviction and cancellation on cache hits. After initial play populated the cache, Everlasting preparation measured 146.04/141.45/156.71 ms at the same seek positions; metadata readiness was 51.95/43.77/34.94 ms. Initial playback preparation measured 643.57 ms. All four measured decoder processes exited after scoped cancellation.

These measurements cover backend decoder preparation only. Browser request scheduling, WebSocket delivery, AudioWorklet cutover and physical-device audible output remain separate verification gates. This evidence does not establish that every format or the owner's full audible delay is resolved.

Review follow-up: cancellation is checked unconditionally after the post-probe identity read, including changed or unavailable identities. An exact regression covers cancellation during that read. Final focused verification after this repair: 52 passed in 7.59 seconds; pytest exited successfully.

### Sidebar order after retained-artist search clear вЂ” 2026-10-07

Outcome: preserve authoritative supplied artist order in root, selected-artist, search, and cleared-search sidebars without losing the selection. Exact punctuation/Cyrillic regression reproduces the current change from server ordering to client natural collation. Reuse the server's existing canonical order and deliberate search priority; remove the alternate client sort and obsolete structural-order discriminator. Preserve selected/primary family roles and album sorting. Acceptance: root/selected/search/clear regression, related sidebar/view-state tests, bundle build and independent review. Rollback is isolated source/test change; no schema/data change. Checkpoint: authorized local commit/build only unless the owner directs otherwise.
- Verification: exact punctuation/Cyrillic regression reproduced the browser resort; 129 related sidebar/view/search cases passed in `.tmp/sidebar-order-related-green.log`, no skips. Runtime bundle rebuilt from 77 modules; diff check clean. Independent source review found no issue. No database, API, deployment, or native-suite run was needed for this rendering-only repair.

### Root document startup eligibility repair (2026-10-07)

Outcome: remove repeated album eligibility work from authenticated root SSR while preserving authoritative global totals, the complete sidebar, and bounded first-gallery hydration. Scope: existing ROOT startup/paging contracts; no endpoint, schema, permission, or budget changes. One read-only cold/warm browser diagnostic found document TTFB 10948/13030ms, with cards visible about400ms after the document. Server stage logs attributed10479/12880ms to bootstrap payload generation. Root membership EXPLAIN showed the nonmaterialized eligibility subtree repeating32903times. Materializing that unchanged CTE once reduced EXPLAIN8607ms to675ms; same-snapshot row comparison preserved all17003rows with identical digest (3262ms versus815ms). Page hydration SQL is unchanged. The regression failed before the repair;15focused rootstartup/paging/membership cases passed. Migration0085's stale index was absent in this database but was not applied or changed. Rollback reverts the single root-query materialization choice and its regression. Full CI and deployment remain separate checkpoints.

Final source read-only bootstrap profile:10098ms before versus5088ms after, same6045artists/14674albums; SQL waits8618ms versus3694ms. This does not establish subsecond startup or a fresh5004 browser acceptance. Independent narrow review found no validated issue; all probe PIDs exited. Private evidence: `.tmp/root-document-profile.pstats`, `.tmp/root-document-fixed-profile.pstats`, `.tmp/root-membership-explain.json`, `.tmp/root-membership-materialized-explain.json`, `.tmp/root-membership-equivalence.out.log`, `.tmp/root-membership-green.log`, and `.tmp/navigation-waterfall-1791361256414/evidence.json`.

A final fixed-source probe without cProfile completed the full root payload in1806.88ms, retaining6045artists/14674albums. Summed SQL execute time was1123.31ms: rootmembership759.76ms, missing/stale albums195.35ms, every other statement at most68.25ms. Thus the absent0085index is a separate optimization/deployment concern, not the cause of the observed10вЂ“13second startup. The5.1second instrumented observation remains retained; cache state and profiler overhead make it unsuitable as the final unprofiled latency claim. Evidence: `.tmp/root-document-fixed-stages.out.log`; diagnostic PID44916 exited. No index or migration was applied, and served5004 browser acceptance still requires an authorized current-source restart.
### Deployed queued-fix verification вЂ” 2026-10-07

Final focused repair verification: all original gallery failures have exact local passing evidence, including complete-family reuse, incomplete-family authoritative fetching, virtualized gallery/sidebar order, original-art preload/fallback ordering, Problematic Files stability, and edition controls. GALLERY033 passed the newly approved black pending-search display while preserving warning lifecycle assertions. The corrected Last.fm invalidation source passed 45 focused tests and its full native case. An earlier report of that unit result was invalid because the source edit had not applied; `.tmp/lastfm-verification-correction.json` preserves the correction, and only the subsequent explicit exit-zero runs count.

A delayed Problematic Files response was replacing the active Loops panel and stopping playback. The regression failed before a dynamic active-tab render guard; all 67 related tests then passed. The final LOOP028 native replay passed with the original geometry assertions restored. Its helper now uses native locator hover rather than a stale manual bounding-box click path. All owned native process trees, ports, databases, and roles were cleaned up. Evidence: `.tmp/deployment-recovery-final-evidence.json`, `.tmp/gallery-compound-green.*`, `.tmp/gallery033-final.*`, and `.tmp/loop028-cross-tab-final.log`. A single unchanged watcher diagnostic and final parity checks precede the next complete hosted pipeline; no release success is claimed yet.

Release repair checkpoint: full run `37600768210` on `24f1a64` finished with seven primary failed jobs and one downstream gate. Inventory is retained at `.tmp/ci-37600768210/FAILURES.md` and `inventory.json`; all four performance jobs passed. Four Python fixture cases and three distinct JavaScript harness cases were reproduced before repair; focused verification passed eight Python variants without skips and 42 related JavaScript cases. Fixture provenance now uses the runtime-owned credit source, preserving the application's protection of externally owned credits. No timing budgets changed.

The final thin-player gesture repair passed 63 focused tests and native touch verification: one seek, no Play activation during the drag, and a subsequent normal tap activates Play. Two independent review passes and runtime bundle parity passed. Search presentation verification passed 224 related cases and production parity. These local results are not full-CI or release acceptance. Native browser failure repairs remain in progress; no release or production promotion has occurred.

Final release intake update: the owner now authorizes completing the final fixes, synchronizing applicable app/internal/test-data documentation, bumping the version, committing/pushing, repairing the complete CI failure set, and merging/publishing the branch after required gates. This supersedes the earlier unmerged/no-further-CI direction. Preserve `skip_reviews`; never add `skip_tests` or weaken performance acceptance.

Search presentation override: while a submitted search is pending, hide the previously displayed album gallery and show a black content area with a smaller spinner and `Searching` text. This explicitly supersedes the transparent retained-gallery search overlay contract below. Reuse existing request-owned search state; retain underlying nodes if useful, but do not display old results. Restore the proper gallery on success, error, or supersession without stale results flashing between preview and hydration. Acceptance includes immediate pending state, smaller indicator, correct new results, and recovery/cancellation behavior. Keep ordinary scanning and root pagination loader behavior unchanged. Update the matching GALLERY033 assertion to this owner-approved contract; do not loosen its unrelated warnings or timing assertions.

Owner acceptance update: Everlasting to Dawning has no audible gap on the current build; seeking is acceptable for now; mobile dragging is smooth once engaged. Those observations close the previously pending owner listening and drag-smoothness checks. A separate remaining defect is difficult gesture acquisition near the thin player's right-side Play control.

Follow-up delivery: prioritize deliberate horizontal dragging near the mobile thin playhead over adjacent Play/control or empty-space hits, while preserving ordinary Play taps, keyboard activation, vertical gestures, pointer cancellation, and one seek commit on release. Trace the existing player gesture owner and reuse it rather than introducing a second seek implementation. Acceptance: reproduce right-edge acquisition failure, focused regression covering drag versus tap and cancellation, related player tests, independent review, then current-source port 5004 verification. No audio decoder, timing budget, endpoint, permission, schema, or media changes. Rollback removes only this gesture arbitration change and its tests. Commit/push checkpoint follows verified repair; PR21 remains unmerged.

Live edition acceptance gap closed on the owner's reported Ayreon album, `Into The Electric Castle`: both desktop and mobile first opening displayed shared tabs `Original - 1998` and `20th Anniversary Edition Remix - 2018` before details finished loading. Actual release grouping established the candidate; duplicate titles were not treated as edition evidence. No page errors; all owned probe/browser processes exited. Evidence: `.tmp/actual-editions-1791364811732/evidence.json`, `desktop.png`, `mobile.png`. This supersedes earlier pending live-edition statements below. Device-level listening/touch acceptance remains distinct.

Mobile indicator repair completed: the focused regression failed against the obsolete control target, then both related suites passed (119 tests) with the current opener and clear-on-open coverage. Runtime bundle rebuilt; independent review found no issue. Guarded redeployment replaced PID 35040 with PID 388 (CIM creation `2026-10-07T09:12:00.7223200Z`). Authenticated mobile proof retained 6045 artists/14674 albums, confirmed computed `mobile-artists-search-pulse` animation on the visible Library button while the drawer stayed closed, and confirmed opening cleared the marker/description and displayed exactly the filtered 13-entry Devin sidebar. Zero page errors or HTTP 5xx; owned verification browsers exited. Evidence: `.tmp/mobile-glow-proof-1791364558718`; server logs: `.tmp/browse5004-20261007-031158-914`. No new timing benchmark, playback, schema/data change, commit, push or CI run.

Follow-up browser verification passed Flower Kings to Angra with repeated Enter, and mobile search kept the tree closed while its opened contents matched all 19 applied-search entries. It exposed a results-indicator ownership defect: the legacy artist-mode button receives the pulse state, while the current `mobile-library-button` does not. Repair acceptance is a pulse on the actual closed drawer opener after search, cleared when opened, with unchanged filtering and no automatic drawer opening. Reuse existing indicator styling and drawer ownership; rollback the control-state repair and its regression together. Live first-open edition acceptance remains unproven: duplicate album titles examined were shared memberships, not confirmed linked editions. The retained GALLERY032 test uses explicitly linked editions and is separate evidence.

The reviewed working tree after `fda9f5f` is deployed on the guarded port 5004 reader (PID 35040). This supersedes earlier statements that the latest queued fixes await deployment. Credentials are unchanged; authentication succeeds. No migration, shared-library mutation, sandbox3 restart, commit, or push accompanied this deployment.

Authenticated navigation measured 3076 ms document TTFB and 3472 ms to visible gallery; reload measured 2448 ms and 2841 ms respectively. Earlier measurements were 12225 ms post-login document TTFB and 7419 ms on reload. These observations establish improvement, not an instantaneous-load guarantee. Functional smoke retained global totals of 6045 artists and 14674 albums, Devin's 7 artists/36 albums, and Neal Morse's 18 artists/84 albums. Searching feedback appeared without hiding the mounted gallery; no browser page errors were recorded. No new real-data search performance benchmark was run.

The clear-search check compared the complete sidebar sequence, not the selected gallery groups: all 6045 entries retained exactly the original order, the query was empty, and Neal Morse remained selected as permitted by the owner. Evidence: `.tmp/deployed5004-verification-1791363184965/evidence.json` and `.tmp/sidebar-clear-verification-1791363313486/evidence.json`. Owned verification browsers and obsolete server processes exited; the requested replacement server remains running. First-open edition tabs, the exact Flower Kings-to-Angra journey, and mobile search-tree behavior remain separate targeted verification items. Physical-device feel and audible playback acceptance remain unrecorded.

### CI 37656037334 repair checkpoint вЂ” 2026-10-07

The complete run on `81d8d7a` finished before this repair batch. Its six distinct failing cases were the JavaScript native-hover contract (reported by both JavaScript jobs), playback lifespan shutdown, Devin and Neal Morse paired calibration (FTC-GALLERY-STARTUP-005U), FTC-COVERS-014, and FTC-UTIL-LOOPS-028. Exact cases, failures, and job evidence remain in `.tmp/ci-37656037334/FAILURES.md` and `inventory.json`. No performance ceiling, grace allowance, retry policy, or required test was changed.

The playback fixture's fake database URL escaped into unrelated connection prewarming and cover-preview discovery. Its real backfill worker then raced the unchanged 30-second shutdown join. The fixture now isolates those two database operations while retaining the actual worker lifecycle, socket-close code, decoder cleanup, and assertions. The unchanged exact local replay passed in 33.77 seconds; this was not a local reproduction of the CI failure. The repaired exact case passed in 3.78 seconds; the related playback, backfill, and lifespan selection passed 94 cases in 15.75 seconds. Evidence: `.tmp/shutdown-exact-isolated-green.log` and `.tmp/shutdown-related-isolated-green.log`.

LOOP028's retained trace recorded 398 notification interceptions of its waveform target. Notification placement now protects hit-tested waveform controls even when their visual surface is transparent; the native scenario retains its geometry and interaction assertions without dismissing the notice as a workaround. The focused regressions first produced two failures and two passes, then 215 related JavaScript cases passed. Exact native LOOP028 passed with zero skips and exit zero. Evidence: `.tmp/ci37656-notification-red.log`, `.tmp/ci37656-hover-notification-green.log`, `.tmp/ci37656-loop028-trace-cause.json`, and `.tmp/ci37656-loop028-green.log`.

Paired-search observation alignment with the owner's black pending-search presentation and the cover-latency failure remain under verification. These completed local repairs do not establish a complete green batch or hosted pipeline. Finish their verification, review the resulting whole batch, then commit/push and require a new complete native pipeline with `skip_reviews` retained and `skip_tests` absent. Release and production promotion remain gated on that result and the applicable owner acceptance.

### Owner-approved removal of the search preview request вЂ” 2026-10-07

The owner explicitly directed: "remove the preview completely". This supersedes the two-request search flow: each explicit search must issue one complete search request, then display its complete gallery and artist family atomically. Preserve immediate `Searching` feedback, the approved pending display, cancellation and supersession ownership, error recovery, and complete counts/results. Bounded initial root-gallery loading and its complete sidebar/totals are separate behavior and remain required.

The live failure is established, not inferred from the black pending screen. On the unchanged port-5004 process, Devin's complete response finished in 343.79 ms, but the parallel six-album preview took 54,241.23 ms. The client awaited both before applying the complete response. A second bounded browser reproduction received the complete 13-artist/37-album response while `busy`, pending-search, and pending-transition remained true for 30 seconds, with `Searching` visible and zero visible gallery cards. Read-only inspection found the relation projection stale with the generic scan_inventory_changed reason; the exact invalidating writer remains unproven: its current and built source fingerprints differed, although builder versions matched. The preview entered a live relation fallback that rebuilt the whole-library relation source; the captured active query was `load_relation_source_rows_sql`, not a database lock wait. Evidence: `.tmp/live5004-recovery-browser-1791400227894/evidence.json`, its `timeout.png`, `.tmp/live5004-preview-active-query.json`, and the scoped server log. This diagnosis does not establish that all host-load or startup delays share that cause.

Acceptance retains the existing end-to-end performance ceilings: 500 ms for synthetic data and 1200 ms for real data, with the existing target/grace policy unchanged. Measure explicit submission through complete usable results, not merely the API response or a first partial album. Required regression cases must exercise one complete request, complete artist-family results, no dependency on a preview response, stale projection fallback, superseded submissions, failure recovery, and the existing login/root continuation contracts. No required case may be skipped or budget weakened to accept this change.

Compatibility and rollback: keep the existing complete search endpoint and response authority; remove the redundant preview request and its request-coupled orchestration rather than introducing another endpoint or persisted cache. Roll back the cohesive source/test change together if needed. Implementation, focused verification, review, rebuilt runtime, exact guarded 5004 restart, and fresh login/Devin/Neal Morse browser proof are pending at this checkpoint. Neither a deployed fix nor full-CI acceptance is claimed. Complete the full existing CI repair batch before the next push and complete native pipeline; preserve `skip_reviews` and the absence of `skip_tests`.

### Search-preview removal and shared loading indicator verification

Preview removal is implemented, focused-tested, bundled, and deployed on guarded port 5004. The first authenticated browser journey measured 3.66 seconds from login to initial gallery and Devin complete-result paint at 614 ms, with exactly one search request (421 ms server time). Global totals and the complete sidebar remained authoritative while the initial gallery stayed bounded. These observations do not establish a pass for all search or startup cases.

Neal Morse still reached a stale full-request fallback: a profiled request took 75.5 seconds, including 74.3 seconds rebuilding live relation aliases. The existing shared projection remains stale; publication-path repairs and a separately reviewed maintenance proposal are under review. No shared projection refresh has been executed. The owner clarified that login, initial gallery, and search should be verified together after fixes; no new combined regression case is requested or retained. Existing automated contracts remain required.

The owner also requested one spinner component across loading screens. The existing loader markup is reused with one authoritative 28px/3px CSS definition; duplicate base, search, and scan sizing rules were removed. Labels, accessibility, and reduced-motion behavior remain intact. All 36 focused loader checks passed and two review passes found no issue. This CSS change has not received fresh rendered browser verification.

Final publication review caught and repaired a scan-generation race in the cached stale-projection repair. Both cache-fresh repair paths now use the existing expected generation and stop when superseded. Verification passed 70 scan/hydration cases plus two publication-owner concurrency cases. Removing unused preview-only matching/scope helpers and their private SQL generators retained the full-search authority contract; 139 focused unit cases and four isolated database authority cases passed. Two complete post-fix Python review passes and two complete frontend passes found no remaining validated blockers. The existing runtime bundle matches its source.

The owner explicitly approved a one-time derived-data rebuild. Authenticated sandbox3 status was idle before maintenance. This authorizes that bounded existing-service operation only; the guarded 5004 process remains browse-only. Completion and post-refresh browser timings remain to be recorded.

Approved maintenance completed successfully: 407331 source rows, 63089 ms, normal transactional projection publication, combined relation/search readiness verified. Private before/after backups were retained; the maintenance process exited without errors. No rescan, schema, media, or credential change occurred. Sandbox3 was not restarted.

The normal guarded 5004 launcher now serves the current source. Authenticated verification at .tmp/live5004-verified-1791406377964/evidence.json passed with no page errors: login to first card 3491 ms; Devin complete results 748 ms; Neal Morse complete results 702 ms. Each search issued exactly one full request and hid old cards while pending. Global counts and sidebar were 6045 artists and 14674 albums, with eight initial album occurrences. Computed loader styling was 28px by 28px with a 3px border. Search observations satisfy the existing real-data ceiling; login timing is descriptive, not a claim of a separate startup-budget pass. Native synthetic timing and complete CI remain release gates.

The first final-source native 005U replay completed with Devin 660.8 ms (hard fail) and Neal Morse 451.3 ms (grace-used pass), against the unchanged 500 ms synthetic ceiling. Complete result inventory and black pending feedback passed. Devin measured 61.3 ms submission-to-request, 495.3 ms HTTP (462.62 ms server), 93.8 ms response-to-DOM, and 10.4 ms DOM-to-paint. Projection readiness was current before both requests. This failure remains open; no retry or budget change was made. The runner and browser processes exited, ports 5860–5866 were clear, and the isolated database and three roles were verified removed. Production parity passed, and performance discovery validated four profile runners, 22 targets, and 30 cases. Do not treat this checkpoint as commit/push or release acceptance.

Final uninstrumented native verification on checkpoint 58a75b1 passed both unchanged 005U cases: Devin 366.3 ms and Neal Morse 356.4 ms, each meeting the 400 ms target and 500 ms hard ceiling. Earlier local timing failures remain recorded; no SQL optimization or relaxed acceptance was introduced to hide them. A bounded diagnostic found SQL latency dominated actual native requests and varied between runs. Its temporary timing hooks were removed, and source bytes matched the checkpoint before final verification. The fresh native app/browser used the existing prepared-fixture path without search warmup or skipped cases. Evidence: .tmp/native005u-final.log. All owned processes exited, ports 5860–5866 were clear, and the retained isolated database and three roles were removed and verified absent.

The owner authorized stopping sandbox3 to relieve memory pressure; its exact process exited and port 5003 was cleared. Guarded port 5004 remained running from the current source. This temporary shutdown is separate from production promotion. Complete hosted CI is the remaining app release gate; local passing evidence is not a release claim. Production also retains a separately documented historical schema/permission compatibility gate, with no production changes performed.


### Owner-requested startup loading feedback (2026-10-07)

CI repair batch: native run `37692189104` completed with seven failing cases across Python, components, gallery, and playback/settings jobs. The two obsolete preview fixtures now exercise complete search while retaining canonical/alias completeness and category-selection assertions. Generated `.album-haven/cover_variants` watcher events are excluded before bounded reconciliation admission; source media, source covers, boundary-crossing moves, and native path case semantics remain supported. Focused verification passed: nine search tests, 100 watcher/reconciliation/coordinator/shutdown tests, and the five exact component/gallery/appearance/settings cases. The component browser closure did not reproduce locally and has no claimed product fix. Two complete independent reviews of the repair/loading diff found no validated findings. These local results do not replace the next complete native CI pipeline.

Outcome: retain native sign-in and show a startup-only full-screen progress bar while the authenticated library initializes. Owner chose completed-stage percentages and normal visible text exactly "Just a sec"; the bar and glow use existing player palette tokens. Milestones are valid form submission (25), authenticated document received (50), gallery/navigation runtime initialized (75), and usable initial view including an authoritative empty library (100). No timer-derived percentages, credentials storage, extra browse requests, or search-budget changes. Existing search and selection spinners remain unchanged.

The implementation reuses progress-bar/fill geometry and player tokens, restores native login controls on history return, exposes reload after startup failure, and permanently closes progress before subsequent searches. Acceptance covers invalid/valid native form submission, accessible monotonic progress, one-shot completion, error/reset cleanup, mobile/desktop player colors and visible text. Focused verification: 57 JavaScript tests, 10 login/authentication tests, and two pinned-Chrome component cases passed. Component screenshots are local evidence under test-results/playwright-artifacts/components/pid-21396; no new combined 005V journey was added. Compatibility: POST/CSRF/redirect behavior and accurate startup totals/sidebar remain unchanged; rollback removes only startup presentation/hooks. Parent review, normal 5004 visual verification and complete CI remain required before publication.
