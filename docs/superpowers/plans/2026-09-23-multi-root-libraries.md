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
A separate missing-cover pass is
running; its final results, functional E2E, large-library query performance,
and full CI remain open.

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

The current one-worker cover pass must not be restarted merely to raise
concurrency. `run_cover_jobs` writes individual cover files during the pass, but
publishes the updated scan cache and saves the cover lookup cache after the job
loop. Interrupting it now could discard in-memory metadata for completed jobs
and require rework; let the existing pass finish unless the owner approves an
explicit recovery plan.
