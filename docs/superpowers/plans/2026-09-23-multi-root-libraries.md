# Multi-root libraries implementation plan

> **For agentic workers:** Use executing-plans task-by-task with separate test, implementation, verification and review handoffs.

**Goal:** Deliver an initial testable multi-root library with approved source indicators and precise duplicate album reporting.

**Architecture:** Extend existing root, scanner, gallery, Appearance and Postgres owners. Preserve the PCM player and source-specific playback. No new moves, persistence fallback, or UI framework.

**Tech stack:** FastAPI, PostgreSQL, existing plain JavaScript shared components and CSS.

## Global constraints and checkpoint

- Approved design: `docs/superpowers/specs/2026-09-23-multi-root-libraries-design.md`; v003 layout plus final owner icon references, redrawn as theme-aware SVG.
- Defaults: card colors off, source hover outlines off, source icons on. At least one enabled; server and UI enforce the invariant.
- Existing Main roots and move policies remain unchanged. No machine paths in committed defaults.
- One test command at a time; Python and JavaScript must not overlap. Focused local verification only.
- Initial implementation still requires owner manual acceptance. E2E, full CI and release remain gated; the owner separately authorized real-root configuration and a full scan before acceptance. Do not publish inherited branch changes implicitly.
- Delivery outcome: source-aware browse/play and duplicates, corresponding to partial AH-W02-001/002/003. AH-W02-004 dedicated review and AH-W02-005 moves remain open.
- Prerequisites: existing categorized root persistence, media containment, PCM playback, shared GalleryCard and aggregate Appearance profiles.
- Compatibility: additive account preferences with legacy defaults; no media moves/deletes, no change to root IDs or media references. Revert rendering independently without losing inventory.

## 1. Duplicate identity and source-safe playback

**Owners:** `music_app/services/library.py`, `music_app/services/library_browse_postgres.py`, `music_app/routes/api_problematic_albums.py`; tests `tests/py/test_multi_root_duplicates.py`.

- [x] Separate test author adds cases through real Track/Album objects and existing construction seams: same artist/title/valid year qualifies despite track-count, duration and edition differences; unknown/conflicting identity, different year/artist, same container and multidisc do not.
- [x] Run `python -m pytest tests/py/test_multi_root_duplicates.py -q`; retain missing-behavior failures before implementation.
- [x] Implement one shared normalized identity rule at the existing domain boundary, reused in the Postgres problem projection. Keep version records and each source's queue separate; all affected versions expose the group.
- [x] Run the new tests and focused existing duplicate/problem cases; reconcile only contracts explicitly changed by the approved rule.

## 2. Appearance persistence and approved gallery indicators

**Owners:** `music_app/services/appearance_preferences_postgres.py`, `music_app/static/js/utilities/appearance-tab.js`, `music_app/static/js/appearance-backgrounds.js`, shared gallery/artbox runtime and CSS; additive migration only if existing profile ownership requires it.

- [x] Separate test author traces aggregate/profile defaults and authors strict boolean, all-disabled rejection, legacy compatibility and profile-isolation cases in `tests/py/test_library_source_appearance.py`.
- [x] Run the focused file and retain RED evidence.
- [x] Add three account-owned independent settings through existing staged Save/Cancel and revision/profile semantics. Preserve old payloads with valid defaults; direct invalid API writes fail.
- [x] Add focused JavaScript behavior tests before implementation: neutral/main+hoard+arrivals segments, icon-only hover expansion, duplicate warning independent of icon preference, no nested interactive controls.
- [x] Extend shared cards/artboxes with subtle amber/teal treatment, theme-neutral Main segments, accessible individual hover/focus actions and owner-referenced SVG icons. Include provenance/problem state in virtualized render invalidation.
- [x] Run focused JS and Python checks sequentially. Existing missing inventory warning remains distinct from duplicate files.

## 3. Root, scan, cover and media readiness

**Owners:** existing `library_roots.py`, `scoped_library_roots.py`, `library_settings.py`, `library_indexing.py`, `cover_workflow.py`, `scan_state.py`, and media routes.

- [x] Inspect existing contracts and run focused category enumeration, second-root media containment, cover-target and offline-root tests.
- [ ] If a gap fails an approved case, add a regression test before the minimal responsible-layer fix. No speculative replacement of working root/scan infrastructure.
- [x] Launch the isolated build with the existing private-node configuration for owner manual acceptance; do not commit credentials.

## 4. Verification, documentation and manual handoff

- [x] Separate verification handoff runs relevant focused checks, reports exact counts and prerequisites.
- [x] Complete two full relevant-diff local review passes; repair all confirmed issues. A substantive second-pass issue requires another full pass.
- [x] Reconcile owning companion plan, UI registry and functional cases without overwriting concurrent private documentation changes. Check only proven milestones; leave release/manual/E2E/move items open.
- [x] Provide the owner a runnable initial build and exact manual script: configure sources, test all three Appearance toggles and last-enabled constraint, hover/focus icons, inspect duplicates and play one selected copy.
- [x] Configure the four owner-requested roots, apply and verify required migrations, and preserve the existing Main root and move policy.
- [x] Run the full scan and verify published track-file inventory in Main, Hoard, and New Arrivals. The one-shot runner exited during post-scan cover planning because it omitted the app's logging initialization; the scan inventory itself was published.
- [ ] Finish the missing-cover pass and report downloads, no-match/provider failures, unavailable roots, and remaining errors.
- [ ] After owner manual acceptance, proceed to approved E2E and release gates separately.

## Progress

### October 6 arrivals workflow and manual-move decisions

The owner wants no dedicated New Arrivals page for now. Browse through the
existing gallery: `Sources` -> `New Arrivals` only -> `All Artists`. The dedicated
page, automatic moves and bulk moves remain deferred.

The confirmed manual-move dialog direction is a compact album-art row, an arrow,
and the destination Main Library or Hoard exact path, with manual confirmation
before changes. Preserve path-read permissions and server-computed destination
validation. Prefer an existing artist folder; suggest a new artist destination
under an existing broad genre/family folder within the approved layout rules.

The owner requested configurable hierarchical versus flat layout. Applying it
only to future moves, without automatic reorganization of existing files, remains
a proposal awaiting approval. The owner confirmed sibling artist folders within
the shared family folder, never nesting inside a related band's own album folder.
The album right-click menu must include `Move`, opening the same destination
picker and confirmation flow. Move is owner-only in both frontend and server
authorization, superseding the October 4 allowance for explicit non-owner grants.
Require server-verified library ownership alongside existing move/view checks;
non-owner administrator presets or explicit grants cannot bypass that restriction.
The private `library-roots-and-arrivals-plan.md` owns these decisions and the
existing move/layout safety rules. Deployment and client limits remain unchanged;
the owner-only restriction narrows Move authority. Technical design, exact mockup, automated-test proposal and owner
manual acceptance gates remain open. No implementation, file move, checklist
completion or release follows from this documentation update.

### October 6 missing source-indicator repair intake

The owner reported missing Hoard and New Arrivals icons/colors after the sandbox
handoff. The compact root-album builder omits stored `root_provenance`; ordinary
nonduplicate cards therefore lose the source summary consumed by the existing
indicators. Repair scope: preserve the stored public provenance/category summary
at that payload boundary, retaining mixed-source and year-specific semantics.
No query, cache, performance architecture or visual-design change belongs here.
Rollback is the source-only payload change; existing permissions and path privacy
remain unchanged. This supports FTC-LIBROOTS-003/003C without completing their E2E gates.

Focused Hoard, New Arrivals and mixed-source regressions reproduced five assertion
failures with one passing year-provenance control (353 deselected, 8.17s); the
numeric pytest exit was unavailable. The two-field payload repair then passed all
six selected cases (353 deselected, 1.53s, exit 0), and related checks passed 18
cases (341 deselected, 1.35s, exit 0). The verifier confirmed no owned or global
test process remained. Two independent narrow review passes found no remaining
finding; the test author's additional review does not count as independent test
review. No SQL, cache or performance change belongs to this repair.

A read-only shared-database aggregate found stored primary categories for 9,188
Hoard, 143 New Arrivals and 5,206 Main albums, with 172 absent primaries. These are
stored metadata counts, not active-display counts. Live owner manual acceptance,
full CI and release gates remain open. Existing checklists are unchanged; this
checkpoint does not claim a successful deployment.

Startup follow-up: `build_initial_view_preview` also omitted the source summary
while slimming albums. Six regressions failed at missing provenance (exit 1;
private evidence `source-indicators-startup-red-v1.log`). The startup serializer
now copies a dictionary provenance summary and preserves the category, including
the public-safe preference-stripping path. Tracks and duplicate-source details
remain slimmed; no paths or queries were added. Exact focused GREEN passed all
six cases in 6.98s, exit 0; evidence:
`C:/temp/pr22-local-1855858/source-indicators-startup-green-v1-exact.log`.
Two narrow review passes found no substantive findings, including privacy and
compatibility checks. Related startup checks subsequently passed 10 cases in
5.10s, exit 0; evidence:
`C:/temp/pr22-local-1855858/source-indicators-startup-green-v1-related.log`.
These results do not establish
a completed deployment: the new sandbox server is still hydrating at this
checkpoint. Owner manual acceptance, full CI and release gates remain open;
no checklist or delivery checkpoint closes from this focused evidence.

### October 6 current checkpoint

The running-pass and review-server notes below are historical. The latest cover
retry stopped with a worker error; its audit verified current outcomes for 235
recorded terminal jobs and decoded all 61 downloaded images. That audit does not
prove completion of the remaining queue. Normal authenticated sandbox3 browsing
now uses the owner-approved shared data without a library copy; no new cover pass
is running at this checkpoint. Operational identities and handoff evidence remain
in the private deployment record.

Preparation reuse and completed-job progress accounting have focused verification.
The earlier unrun-counter checkpoint is historical: implementation and focused
RED/GREEN verification are complete. The counter measures accepted terminal
search results, not durable persistence. Gallery-performance work has transferred
to another chat and is outside this chat's scope; its acceptance gate remains open.
Remaining work includes the complete CI failure batch and the retry with visible
progress. The owner approved cross-instance single-writer coordination using the
shared production database/media with production browsing online. Concrete safe
ownership and recovery design remain pending; composition is unimplemented and
prospective safety tests are unrun. Retry verification gates remain open.
Follow `../../plans/2026-10-04-cover-timeout-retry-investigation.md` for the cover
repair checkpoint. Manual acceptance, full green CI and release remain open.

Initial implementation is in this worktree. Red-first duplicate regressions covered
unknown and conflicting metadata, cross-edition and separated-year copies,
source-specific queues, and real PostgreSQL candidate/Problematic Files reads.
The final focused command on September 23 passed `78` Python tests across the
new duplicate and Appearance files (including isolated PostgreSQL cases).
The two source-specific Node test files exited successfully, and the rendered
gallery component file passed `4 / 4` cases in dark and light themes. The
runtime bundle was regenerated. Four full local diff-review passes repaired
all validated findings; pass four found none. The component screenshots were
visually inspected. Exact elapsed slice times were not recorded.

This is not owner acceptance or release evidence. The owner has not manually
accepted the build. The four requested roots are configured, migrations 0079,
0080 and 0081 match the live ledger, and a full scan published 159,545 file
entries across Main, Hoard and New Arrivals. A read-only live query confirmed
57,975 current Main files, 100,070 Hoard files across three roots, and 1,500
New Arrivals files; five additional Main rows are marked scan-cache-stale.
The app's read-only Problematic Files projection found 254 duplicate-marked
album records; all 254 appear in its summary and carry the `Duplicate files`
reason. A separate missing-cover pass is running; its final results,
functional E2E, large-library query performance, and full CI remain open.

The isolated runtime bundle built from 74 modules. A review server launched
against the existing private-node configuration, completed startup with 159,545
files and 14,673 albums hydrated, and served `/status` with HTTP 200. Its working
set then rose past 2.4 GB while free physical memory fell below 1 GB. Only that
new server (PID 20024) was stopped out of caution; the cover worker (PID 44676)
continued. The earlier listener check silently suppressed an access-denied error
and was not evidence of failed startup. Live owner review remains open; verify
the server with a direct HTTP request and monitor memory on the next launch.

The subsequent isolated review launch uses the app's built-in local HTTPS mode
at `https://127.0.0.1:5001/login`, with the loopback URL and no trusted proxy
for this process only. Startup again hydrated 159,545 files and 14,673 albums;
an unverified-certificate HTTPS request returned the login page with HTTP 200.
The review server was left running for owner manual acceptance. This does not
prove the owner accepted the feature or that the missing-cover pass finished.

The owner subsequently approved stopping the slow cover worker and replacing
its automatic search. That worker exited at 265 processed jobs / 156 downloads;
written covers must be preserved. The approved recovery and bounded automatic
resolver are tracked in
`2026-09-24-fast-automatic-cover-search.md` and its companion design. The worker
must not resume until focused verification and recovery complete. Do not repeat
the full music scan merely to restart covers.

The owner also approved gallery/search performance corrections and Main-only
folder-derived Artist Family evidence. Follow
`2026-09-24-gallery-performance-and-family-corrections.md` for progressive
loading, source-filtered totals, hidden artist information during search, and
source-style search regressions. These corrections do not mark manual
acceptance, E2E, full CI, or publication complete.

### October 4 CI contract reconciliation

PR22 run `37218749498` at `f4cc9bc1` reported the same 15 JavaScript
failures on portable and Windows runners. Twelve canonical Appearance object
assertions omitted the approved `library_source_indicators` defaults
(`card_colors=false`, `hover_outline_colors=false`, `icons=true`). The two
test-owned defaults now include that additive field without removing any
existing save, cancel, session, compatibility, or recent-color assertion.

The remaining three JavaScript failures and the component prerequisite failure
shared stale discovery accounting. The four existing `librarySourceCard.spec.js`
cases implement the approved design's individual hover/focus labels, independent
duplicate warning, and neutral Main segment in dark/light mixed-source frames.
They are now registered explicitly in the test-data matrix; exact component
and complete inventory counts advance from 189/412 to 193/416. No component
assertion, fixture isolation contract, or execution gate was weakened.

Focused verification passed 100/100 tests, zero failures/skips, in 46.218 seconds:
`node --test --test-concurrency=1 tests/js/runtime/appearance-palettes.test.js tests/js/runtime/appearance-waveform-recents.test.js tests/js/ci-fixture-data-contracts.test.js tests/js/validate-foundation-gates.test.js`.
The initial sandbox run passed 96/100; four discovery checks could not open
Playwright's transform-cache files (`EPERM`). Repeating the same focused scope
with cache access passed, including exact discovery and ownership checks.
Component execution and the full hosted pipeline remain required; the earlier
failed manifest upload was downstream of inventory validation.
