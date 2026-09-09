# Settings refactor: Task 1 technical checkpoint

## Owner workflow override — September 9, 2026

The owner subsequently instructed the orchestrator to perform the manual validation, continue through all remaining Tasks 3-9, and present the completed work for one final owner review. This explicit instruction supersedes intermediate owner manual-acceptance stops throughout this plan and its linked checkpoint/report, including older per-slice wording retained as history. The orchestrator must still execute and record each slice's exact real-app manual checks before dependent progression. Approved test-first work, focused checks, builds, independent reviews and required regression/E2E checkpoints remain in force. No merge, push or publication is authorized. Preserve the original uncommitted work. Do not request the same per-slice approval again.


Date: 2026-09-09
Branch: `2026-09-08-settings-refactor`
Owning plan: [settings refactor](2026-09-09-settings-refactor.md)

Status: technical decisions and capability mapping approved by the owner's `approve` reply on September 9, 2026, following the explicit approval question for this report. The earlier request authorizes code implementation on `2026-09-08-settings-refactor` using the current stack and preserving uncommitted work. This records technical approval, not live manual acceptance. The baseline below predates runtime implementation. No commit, merge, push or publication is recorded here.

Approval recording: approved actions are recorded in the private `docs/permissions-and-capabilities.md`; the reusable S01-S05 extension is recorded in `docs/ui-component-system.md`. Task 1's technical gate is complete. Its all-surfaces component/case bookkeeping remains open for later slices; each slice must finish its own mapping before dependent implementation.

## Verified intake

- 32/32 approved artifact SHA256 hashes match; no missing or changed approved artifact.
- Production loads `static/app.js` and generated `static/js/runtime-bundle.js` from `templates/index.html`. Build ownership is `scripts/build-runtime-bundle.cjs`.
- Live Settings rendering is `static/js/runtime/utility-renderers-and-actions.js`; events are in `runtime/bootstrap-utility-event-handlers.js`. The plan's `static/js/utilities/shell.js` and tab modules are absent from production bundle/boot references. Implement in the live owners, resolving additional dependencies through callers.
- Canonical loaded Utilities stylesheet is `static/css/runtime/utilities.css`.
- Preserve persistent app-shell/player identity and the September 6 audio/waveform contracts. September 9 approved A/B visuals supersede older fixed/no-glow cosmetics.
- Existing loop order is `app.saved_loops.metadata.source_index`; service reorder silently ignores invalid IDs and appends omissions. The route is in `api_wave_b_asgi_routes.py`. Storage uses the bootstrap account, not the requesting actor; read followed by save has no revision check.
- Current logs are a 250-event server-memory feed plus retained browser IndexedDB history. Migration 0030 deliberately dropped the old operational log table.
- Current listen repository also uses bootstrap-account scope. Meaningful listen means `max(total_listened_seconds, max_contiguous_seconds) > 10`.
- Existing root storage already supports three multi-root categories, duplicate/overlap checks and save-triggered watcher reconciliation. There is no supported native/server folder-picker bridge.
- Account Appearance already supports staged preferences and aggregate revision conflicts. Harbor Mint work exists and will be audited/reused. A/B style is distinct from existing compact-player styling.

## Approved technical decisions

Decision evidence: the owner's September 9, 2026 `approve` reply accepts this report's technical decisions and capability mapping. These are approved implementation contracts; verification and per-slice manual acceptance remain pending.

| Area | Approved decision |
| --- | --- |
| Suggestions | Stable opaque proposal IDs derived from target, field, original/corrected values and source revision; retain evidence server-side. Revalidate actor, target, original tags and revision under the existing tag-edit reservation before writes. Use the confirmed tag-edit intent/recovery workflow; return target-level outcomes and preserve failed/stale selections. No implicit exceptions. |
| Evidence | Encoding must round-trip unambiguously without unrelated title-casing. Year/number proposals require authoritative metadata or verified track identity/order, never filename sorting or guessed album year. Existing canonical alias and disc-marker corrections require their own evidence. Missing text, mismatches, corrupt/undecoded text and duplicate-file problems get no proposal absent reliable evidence. Cover problems remain album-level and use existing cover actions. Inventory every catalog reason during Task 3 before implementation. |
| Selection | Independent stable-ID problem/proposal sets; drag locks to the originating type. Apply All uses only eligible visible proposals; explicit Apply uses selected visible proposals. Hidden selections cannot cause silent writes. |
| Loop ownership/order | Scope reads/mutations to the server-derived actor, library and stable song identity. Existing bootstrap-owned loops remain with that owner. Reject duplicate, foreign, missing or incomplete song membership. Compare a song revision atomically and update only order metadata; use a per-song revision row for safe empty-list/create/reorder concurrency. Historical loops without track IDs need a verified source-track mapping, never filename-only grouping. Migration/backfill preserves existing IDs and audio. |
| Roots | Absolute media-host paths. Reject duplicates and parent/child overlaps across all categories. Validate new/changed roots; preserve unchanged offline NAS roots with an unavailable state. Removing a root never deletes media. Provide a bounded server-directory picker within administrator-configured browse bases on private nodes; reject traversal and symlink escapes. No hosted-cloud server browsing. |
| Statistics | Own-account, current-library aggregates. Local playcount counts unique measured local sessions satisfying the existing greater-than-10-second rule. Total time sums actual measured listened seconds for those sessions, excluding seek distance, pause time and nominal duration. Preserve current repeat/loop session segmentation. Key writes by account/library/device/session so retries deduplicate; separate devices remain separate sessions. Imported playcounts contribute neither local-session count nor measured time; preserve them separately. Audit the live elapsed-time accumulator first. |
| Logs | Add a forward Postgres migration for authorized library-scoped operational events. Browser state becomes navigation/query state, not durable authority. Keep old browser records available for explicit legacy export; do not silently attribute/import them. Use browser-local IANA timezone with visible label, inclusive displayed end date converted to next local midnight, UTC half-open intervals and stable timestamp/event-ID ordering. Today/7/30 mean local calendar dates including today. Console/export share one authorized snapshot query and bounded keyset pagination. Approved defaults: 90-day new-event retention, 500-row pages, 100,000-event export maximum with explicit refusal above the limit, never silent truncation. |
| Preference and touch | `loopControlStyle: capsule | companion`, default capsule, existing staged own-account Appearance revision contract. Gate selector and actions by effective `library.loops.create`. Keyboard focus exposes usable actions. On touch, expose scissors/save/cancel controls directly to authorized users rather than depending on hover; this interaction needs touch review before support is claimed. |
| Clients/deployments | Desktop web required; narrow web shared shell required; touch player required only after interaction review. Tauri optional if a real bridge exists; Android, TV and Apple native unsupported for this slice. macOS browser is desktop web. Existing supported self-hosted/hosted account functions retain scope; media-host filesystem administration stays private-node-only. |

## Approved action registry rows

Existing capability keys come from `music_app/services/private_route_boundary.py`; authorization behavior comes from `policy_evaluator.py`. Preserve existing explicit grants and bootstrap-owner inheritance. No musician/listener role-name inference.

| Action | Capability | Scope and approved preset membership |
| --- | --- | --- |
| Proposal application | `library.files.edit_tags` | Current library/exact targets; existing grants unchanged |
| Create/revert exceptions | `library.rules.manage` | Current library/exact targets; existing grants unchanged |
| Read/create/delete/reorder loops | Existing `library.loops.read/create/delete/reorder` keys | Owning actor/library/song; existing grants unchanged |
| A/B preference | `account.self.appearance.read/write` plus effective `library.loops.create` | Own account; existing Appearance self-service and creation grants |
| Read/save roots | `library.settings.read/manage` | Current media-host library; existing grants unchanged |
| Browse host folders | New `library.filesystem.browse` AND `library.paths.read` | Administrator explicit grants only, bounded browse bases, private-node web |
| Read measured statistics | Runtime action `account.self.listens.read` | Own account/current library self-service; no other-user access |
| Read/export operational logs | `library.logs.read`; new `library.logs.export` for export | Current library; export granted explicitly to library administrators, not automatically to readers |
| Paths in log export | No include-paths option in this slice | Redacted export; folder-picker path grants do not silently enable log disclosure |
| Existing Explorer/cover/Last.FM actions | `library.files.open_location`, `library.covers.fetch`, `integration.lastfm.manage` and existing lookup/media keys | Existing target, host and client constraints unchanged |

Approved rows, action projections, denial cases and decision evidence are recorded in the private permissions registry under Settings refactor technical approval. New route bindings and enforcement evidence must be completed in the owning later slice before exposure; this approval does not claim those APIs exist. New APIs must be included in server policy and its projection; hiding controls alone is insufficient.

## Component and functional-case mapping

Use the private UI registry's existing families, with these reusable extensions documented before dependent changes:

| Cases | Existing family and extension |
| --- | --- |
| S01–S05 | Header/TabBar joined contour; SearchInput anchored filter; wide NavigationTree metadata; AlbumArtbox activation and missing state |
| P01–P10, R01–R02 | CompactDataTable; typed error/positive labels with independent selection; Button/ActionButton; confirmation Modal |
| L01–L06, B01–B08 | NavigationTree expansion/reorder; Loop and PlaybackControlCluster A/B/timers/accessibility; red delete Button and Modal |
| H01–H03 | ConsoleLog with temporary query entry, shared scrolling and export Modal |
| I01–I08 | Input with in-shell icon actions; anchored dropdown; status labels; wide single-scroll guide Modal; disabled Button |
| A01–A03 | Existing Appearance editor/preview/footer and Harbor Mint central palette; gated staged A/B field |

Proposed automation remains the owning plan's per-slice unit/integration cases followed by real-app functional cases after manual acceptance. Add cases for every new authority denial, cross-account access, stale revision, migration preservation and export bound. Do not weaken current E2E/audio contracts for changed visual expectations without exact owner approval where required.

## Fresh focused baseline

No fixes made. JavaScript and Python ran sequentially, with one pytest process.

- JavaScript: 271 tests, 265 passed, 6 failed.
  - `appearance-palettes.test.js:272`: actual #9ABBDC, expected #8BAED1.
  - `appearance-palettes.test.js:307`: actual #24B86B, expected #86EFAC.
  - `loop-range-controls.test.js:627`: empty hover background, expected linear-gradient(135deg, #0fa66f, #1f995c).
  - `loop-range-controls.test.js:1204,1231`: generic CSS selector exclusion assertions fail.
  - `shell-persistent-player-layout.test.js:90`: trigger-anchor.css is last, expected shell-persistent-player.css.
- Python: 195 tests, 190 passed, 5 failed.
  - `test_appearance_palettes.py:72,82,114,129,151`: actual preference dictionaries additionally include album_details_layout=classic_bar, album_playing_row_animation=enabled, alert_family=ember.
- These are pre-implementation baseline failures, not yet proven unrelated or approved expectation changes.
- `git diff --check` passes, with a pre-existing line-ending warning.
- Read-only Git-process audit required owner-inspection escalation and then succeeded: zero selected candidates, zero processes stopped.

## Resume checkpoint

Technical approval is recorded and Task 2 live-source ownership is corrected in the owning plan. The owner-reported Problems selection jump is fixed: mounted rows, focus, scroll and unchanged images survive selection/detail hydration; labels/counts update and repeated cached selection avoids detail churn. Final independent verification passed 263/263 focused JS tests, including 39 Settings cases and three added lightbox cases, with runtime build/parity, syntax/diff and original-file preservation checks passing. Fresh browser verification retained exact deep-list and neighboring-row geometry after uncached and repeated cached clicks. The [Task 2 acceptance report](2026-09-09-settings-refactor-task2-acceptance.md) preserves the defect, test and numeric browser evidence. Ready for renewed owner manual acceptance; stop at that checkpoint before commit/E2E progression. Preserve initial uncommitted work. No merge or publication is authorized.

Later-slice implementation prerequisites remain: inventory every suggestion reason and evidence seam (Task 3); verify historical song identity and revision migration (Task 5); bind new log routes/projections and validate bounds (Task 6); audit measured elapsed time, picker containment and actual Foobar parser support (Task 7); and review touch player interaction before claiming support (Task 4). These checks implement approved contracts and do not reopen settled approval.

### Task 2 test-authoring handoff and performance assessment

The approved unit/integration, manual-acceptance, then functional-E2E sequence initially added 21 focused Node tests in `tests/js/runtime/settings-refactor-shell.test.js`. The test-author handoff witnessed 15 initial RED assertions with no harness errors; the additional arrow-navigation and hidden-count tests also failed for missing behavior. This is test-first evidence, not a passing-verification claim. The resize revision passed 249/249 focused JS tests, including 29 Settings cases. The final run after both P2 fixes passed 255/255 focused JS tests, including 31 Settings cases and three added lightbox cases, as recorded in the acceptance report. The later selection correction passed 263/263 focused tests, including 39 Settings cases; seven additional expected behavior failures were witnessed before implementation while one genuine collection-refresh case already passed. The earlier baseline remains separate.

Coverage includes six-tab activation; ArrowLeft/ArrowRight wrapping, Home/End and unhandled/modified-key preservation; Filters ArrowDown and Escape/focus restoration; shared anchor cleanup and label; both header Artboxes in ready/missing states; both tree types with artwork, real or absent year, hidden count; shared NavigationTree escaping/link semantics; and redundant-heading removal.

| Functional case | Owning plan requirements | Proposed real-app flow and checks |
| --- | --- | --- |
| `FTC-SETTINGS-S01` | S01-S02 | Open six tabs by pointer/keyboard, exercise wrap/Home/End, preserve unsupported keys; inspect selected joined header geometry and upper-right Close without hit interception. |
| `FTC-SETTINGS-S02` | S03 | Search and filter together, clear each, open Filters by keyboard, escape to its anchor; verify shared anchored placement and retained valid selection. |
| `FTC-SETTINGS-S03` | S04 | Inspect Problems and Loops tree rows with ready/missing art and known/unknown year; show real title/artist metadata and hidden count without invented values. |
| `FTC-SETTINGS-S04` | S05 | Open available art from Problems and Loops headers, close with restored focus; missing art has crossed-disc state and no enlargement; opening art preserves selected context. |
| `FTC-SETTINGS-S05` | S02-S05 | Resize desktop/narrow shell, revisit tabs and close/reopen; verify contour/filter alignment, neutral artwork focus, usable input editing and selection/copy without blinking carets. |

Private owner: `docs/functional-test-cases/app-shell-and-shared-components.md`, indexed from `docs/functional-test-cases.md`. The five planned functional scenarios use the configured real-app functional suite and `tests/e2e/phase7/poms/settingsShell.js`, with isolated normal Postgres product data seeded before startup and generated ready/missing-art records. Each scenario owns any changed data. Existing authorization and media routes remain active; app-owned responses are not mocked. Functional E2E authoring waits for live owner acceptance. The next manual handoff must give exact steps for these five scenarios; approved mockups and Node assertions do not count as live acceptance.

Performance assessment: the shell measures only six tab bounds and updates their selected contour. Observe resize-driven measurement and disposal of ResizeObserver/anchor listeners when the owning shell lifecycle ends; do not leave idle polling or accumulating listeners. Tree rendering retains existing list scale and queries, with no new full-table query. New tree artwork requires native lazy loading and async decoding to avoid eager requests for all offscreen rows; focused tests verify this bounded image-loading correction, with live checks passed and owner manual acceptance retained. Preserve current gallery and Utilities responsiveness/memory contracts and budgets. Focused resize/lifecycle checks plus manual desktop/narrow inspection cover this shell-only change; no new performance E2E is required for Task 2 alone. A measured regression reopens diagnosis under the existing budgets. Later suggestion tables, loop reordering and log queries retain their own required assessments.

## Reproduction and cleanup evidence

JavaScript command:

```powershell
node --test --test-concurrency=1 tests/js/runtime/shell-navigation-drawer.test.js tests/js/runtime/shell-persistent-player-layout.test.js tests/js/runtime/utility-list-builders.test.js tests/js/runtime/utility-list-builders-foobar.test.js tests/js/runtime/utility-list-builders-local-playlist-import.test.js tests/js/runtime/utility-problematic-tab.test.js tests/js/runtime/utility-problematic-review-contracts.test.js tests/js/runtime/utility-problematic-load-diagnostics.test.js tests/js/runtime/utility-problematic-focused-track-render.test.js tests/js/runtime/problematic-album-helpers.test.js tests/js/runtime/playback-control-cluster.test.js tests/js/runtime/loop-range-controls.test.js tests/js/runtime/browser-log-history-store.test.js tests/js/runtime/library-settings.test.js tests/js/runtime/appearance-palettes.test.js tests/js/runtime/appearance-backgrounds.test.js
```

Python command:

```powershell
$env:PYTHONDONTWRITEBYTECODE = '1'
& ./scripts/test.ps1 -PytestArgs @('tests/py/test_appearance_palettes.py','tests/py/test_appearance_preferences_postgres.py','tests/py/test_account_appearance_asgi.py','tests/py/test_api_loop_helpers.py','-q','-p','no:cacheprovider')
```

The verification agent confirmed no remaining pytest or node --test processes. Test temporary writes required scoped escalation. One cache_dir configuration warning resulted from disabling pytest's cache provider. No unresolved baseline setup prerequisite remains.

## Task 3 intake and implementation handoff

Intake only; no runtime implementation or tests were run for this handoff. The `grill-with-docs` skill and its grilling/domain-modeling dependencies were read. Environment facts below answer the technical questions without reopening the already approved Suggestions, Evidence and Selection decisions. The final-only owner review instruction above overrides intermediate acceptance prompts.

### Live ownership and definitions

A problem is a detected condition on an album or track; a proposal is one evidence-backed correction with an opaque stable ID and exact target/field/current/corrected values. A problem exclusion suppresses a detected condition through the Rules workflow; it is never a side effect of applying a proposal. A confirmed tag edit is successful only after the authoritative persistence finalizer completes, not after optimistic display or physical file I/O alone. These are the existing approved concepts, not new permission choices.

`api_problematic_albums.py` builds summary/detail payloads using `services/problematic_albums.py` and `repair_previews.py`. `api_rules_helpers.py` owns generic text/year diagnostics. `metadata.py`/`utils.py` own physical tag reading and candidate encoding helpers. Live UI owners are runtime `utility-list-builders.js` (detail/rules/filter construction, selection helpers), `bootstrap-utility-event-handlers.js` (pointer/keyboard/confirm actions), `utility-renderers-and-actions.js` (mounted shell), `utility-loaders-and-cover-lookup.js` (detail loading), `problematic-album-helpers.js` and `problem-exclusion-mutations.js`. Keep Task 2's mounted-tree selection behavior. The `utilities/*-tab.js` files are stale and must not become a second implementation.

### Complete actual reason/evidence inventory

| Emitted condition | Current source and reliable proposal rule |
| --- | --- |
| Missing artist, missing album, missing track title, missing track artist, missing album artist | `text_problem_reason` formats its input label; album summaries use Artist/Album and track rows use Album/Track title/Track artist/conditional Album artist. Missing text has no intrinsic correction; no proposal without independently authoritative target metadata. Do not substitute filename/stem or neighboring-track majority. |
| Undecoded characters | Explicit `??`, standalone `?`, or replacement-marker patterns. Lost characters are not reversible evidence; no proposal unless a separate authoritative value exists. |
| Encoding problem | Existing mojibake detection and candidate enumeration in `utils.py`. Deduplicate plausible candidates, require exact reversible byte round-trip and exactly one distinct supported correction. Ambiguity yields no label. Do not use the first/best heuristic candidate as proof. Preserve original casing; `metadata.build_text_repairs_for_entry` currently calls title-casing and is not directly safe for approved proposals. |
| Artist name casing differs from canonical; Artist name variant differs from canonical | Explicit server relation `alias_to_canonical` mapping, excluding collaboration names in both source and destination. Use the exact mapped canonical value and retain that mapping as evidence; a generic casing rule is not evidence. |
| Disc marker in album name | Existing regex/cleaner recognizes CD/disc/disk with positive numeric marker and builds album plus disc-number updates. Require a single unambiguous marker and no conflicting known disc number; otherwise no proposal. Remove only that marker and separators, preserve unrelated casing. Treat the coupled album/disc update as one proposal, not a display string written into the album field. Existing helper title-cases and may overwrite a conflicting disc number, so wrap/replace that proposal computation rather than copying it blindly. |
| Missing year; Invalid year | `year_problem_reason` reports absent, unparsable or nonpositive values. A verified date/metadata value tied to the same track/release can justify a year. Album aggregate year, current date, filename or neighboring majority cannot. Current entry schema has `release_date`; validate its provenance/consistency and preserve full date semantics when writing the year field. No matching trustworthy value means no proposal. |
| Missing track number; Invalid track number | Absent, unparsable or nonpositive number. Require authoritative number or verified recording/release position for that exact track (including disc identity). File iteration, filename sorting, displayed row index and inferred contiguous gaps are insufficient. Current `read_metadata_for_file` has no verified external release-order map; ordinary missing-number entries therefore have no proposal until a real evidence adapter supplies one. Test supplied verified evidence and evidence-absent outcomes separately. |
| Album name mismatch; Album artist mismatch | Distinct nonempty case-folded track values; shared-artist compilations exempt the artist mismatch. Detection identifies disagreement, not the correct side; no proposal from the mismatch alone. A separately approved canonical/encoding correction can still target its own field. |
| Year mismatch; Inconsistent year; per-track `Year mismatch: <value or Missing>` | Summary and per-track labels differ; normalize them to one selection/filter reason type while preserving actual per-track text. Conflicting values do not determine a correct year; no proposal without independent authoritative evidence. |
| Missing cover art; Poor art quality | Album-only reasons; quality threshold is minimum edge 1200 in `problematic_albums.py`. Keep existing authorized cover actions. No tag proposal and no per-track cover problem row. |
| Duplicate files | Album duplicate-source detection; not proof of which source to remove or how to rewrite tags. No proposal; preserve applicable existing workflows. |
| Library watcher overflow/root unavailable | Separate operational rows from `library_watch_health.py`, with opaque root key and path-free message. Not a tag problem/proposal; preserve existing allowed actions and refresh ownership. |

Ignored undecoded/year rows and persisted problem exclusions remain honored. Reasons are not inferred from mock labels. Existing `repair_preview_rows` include old heuristic encoding, aliases and compound disc rows, so the new service must compute validated proposals independently rather than relabeling every legacy preview as safe.

### Authorized mutation seam and resolved semantics

Use `/utilities/edit-tags`, bound to `library.files.edit_tags` in `private_route_boundary.py`; do not call `/utilities/repair-album`, whose capability is `library.files.repair` and whose legacy selection combines repairs/ignores. Proposal reads preserve `library.problems.read`; any new apply/read route must receive explicit policy binding and the existing client projection before exposure. Derive actor/library and target membership from server context; client paths/album objects are not authority. Rules creation/revert remains `library.rules.manage` on the existing problem-ignore/version-exception routes.

`api_wave_a_asgi_routes.utilities_edit_tags` requires `confirmed` and nonempty updates, acquires structural resource reservation, and dispatches `edit_workflows.handle_edit_tags_request`. The reservation covers the handler and transfers to the save finalizer when a save task exists. The workflow reads current cache entries, validates structural destination conflicts, commits a Postgres intent before I/O, verifies every requested field through the existing worker, queues authoritative persistence and returns task/changed/committed data. `_authoritative_edit_tags_response` permits success only for completed persistence and otherwise returns a visible 500 failure. The selected Postgres response intentionally omits rebuilt album payloads and requests refresh; the client must refresh exact affected targets without pretending an omitted payload proves all problems disappeared.

Current stale-data gap: ordinary edit-tags compares desired values with current cache values but has no proposal ID/original-value/source-revision contract. Add an optional proposal-validation hook/branch under the acquired reservation, before intent preparation or file writes. It must recompute server evidence/identity, compare current physical tags and source revision with the proposal, and reject stale/unknown/foreign targets. Use actual metadata version inputs (`mtime`, `size`, relevant raw tags and evidence identity); current payloads do not expose a universal tag revision. Do not fabricate a database revision column or trust a client-provided corrected value. Deterministic opaque IDs include target, fields, original/corrected values and this source revision; paths/evidence remain server-side and public projection follows existing path grants. Where generation relies on cached tags, apply must reread/revalidate under the reservation. An external writer is outside the in-process lock, so preserve the existing verified write/readback/recovery checks.

Partial semantics are batch-compensating today: `_run_edit_jobs` waits for all started workers, records mismatched/missing/unexpected fields, then reverses every reported successful field if any job fails; it returns no successful changes for that batch. Do not report those compensated proposals as applied. Preserve one coupled field update per proposal; target-level result mapping must distinguish committed, stale/rejected, failed/rolled-back and recovery-pending. Eligibility/stale failures can be returned per target before writes; any shared submitted write batch retains its existing compensation boundary. If the adapter deliberately splits independent targets into separate edit transactions, record outcomes per transaction and never claim an atomic multi-target operation. Persisted intent states and startup recovery distinguish fully requested, fully old, mixed and externally divergent files; compensation/readback failure stays unresolved. UI retains failed/stale selections and unrelated issues, and successful proposals disappear only after authoritative target refresh.

### Concrete test-author handoff

Before dependent code, add failing unit/integration cases for: unique reversible encoding versus multiple candidates/lossy text/casing preservation; explicit canonical mapping and collaboration exclusion; single disc marker with consistent number versus multiple/conflicting markers; verified year/number evidence versus absent/ambiguous evidence; every inventory row's no-proposal result; opaque stable IDs changing with source revision; generation never calling a writer; same-type problem/proposal drag with independent sets; header selection scoped to matching problems; union filters with empty=all; visible-only Apply All/Apply; coupled proposal writes; exact current-to-corrected labels and always-present Suggested edits column; album-only cover problems; no implicit exception writes; capability denial and foreign target; stale rejection before intent/I/O; partial worker failure/compensation and unresolved retention; authoritative finalizer failure; successful refresh preserving unrelated problems and Task 2 tree continuity. Existing tag-edit/intent/recovery tests remain the transaction contract; do not replace them with mocks that bypass reservation or durable finalization.

Resolved implementation facts versus remaining work: catalog and mutation semantics are now inventoried. There is no verified external release-order provider in the current metadata entry; absent evidence must produce no proposal, while the computation interface can accept only validated server evidence. Proposal generation, source-revision validation, public projection/route binding, target outcome mapping, private component/functional-case adoption records and the above RED cases are still implementation prerequisites. They are authorized work, not new owner approval gates. The existing approved technical choices remain unchanged.

Task 2 manual completion: the orchestrator completed the five live flows on the final runtime under the owner override (six-tab keyboard/pointer behavior; search/filter results and Escape focus; actual missing artwork/year; 390px Appearance geometry; three close/reopen cycles). Prior same-runtime lightbox/copy/tree-stability evidence remains valid. Exact evidence is in the Task 2 report. Task 3 test-first work may proceed; final owner review remains due.

Task 3 private adoption/case prerequisite is recorded: ui-component-system.md P01-P10/R01-R02 adoption v001 and functional-test-cases/settings-problems-and-suggestions.md (FTC-SETTINGS-P01/P02/P03/R01/R02). Cases remain planned, counters unchanged; existing tag-edit/recovery cases remain authoritative.
