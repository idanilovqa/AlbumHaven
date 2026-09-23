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
- Initial implementation ends at owner manual acceptance. E2E, full CI, release and real-source scan remain gated; do not publish inherited branch changes implicitly.
- Delivery outcome: source-aware browse/play and duplicates, corresponding to partial AH-W02-001/002/003. AH-W02-004 dedicated review and AH-W02-005 moves remain open.
- Prerequisites: existing categorized root persistence, media containment, PCM playback, shared GalleryCard and aggregate Appearance profiles.
- Compatibility: additive account preferences with legacy defaults; no media moves/deletes, no change to root IDs or media references. Revert rendering independently without losing inventory.

## 1. Duplicate identity and source-safe playback

**Owners:** `music_app/services/library.py`, `music_app/services/library_browse_postgres.py`, `music_app/routes/api_problematic_albums.py`; tests `tests/py/test_multi_root_duplicates.py`.

- [ ] Separate test author adds cases through real Track/Album objects and existing construction seams: same artist/title/valid year qualifies despite track-count, duration and edition differences; unknown/conflicting identity, different year/artist, same container and multidisc do not.
- [ ] Run `python -m pytest tests/py/test_multi_root_duplicates.py -q`; retain missing-behavior failures before implementation.
- [ ] Implement one shared normalized identity rule at the existing domain boundary, reused in the Postgres problem projection. Keep version records and each source's queue separate; all affected versions expose the group.
- [ ] Run the new tests and focused existing duplicate/problem cases; reconcile only contracts explicitly changed by the approved rule.

## 2. Appearance persistence and approved gallery indicators

**Owners:** `music_app/services/appearance_preferences_postgres.py`, `music_app/static/js/utilities/appearance-tab.js`, `music_app/static/js/appearance-backgrounds.js`, shared gallery/artbox runtime and CSS; additive migration only if existing profile ownership requires it.

- [ ] Separate test author traces aggregate/profile defaults and authors strict boolean, all-disabled rejection, legacy compatibility and profile-isolation cases in `tests/py/test_library_source_appearance.py`.
- [ ] Run the focused file and retain RED evidence.
- [ ] Add three account-owned independent settings through existing staged Save/Cancel and revision/profile semantics. Preserve old payloads with valid defaults; direct invalid API writes fail.
- [ ] Add focused JavaScript behavior tests before implementation: neutral/main+hoard+arrivals segments, icon-only hover expansion, duplicate warning independent of icon preference, no nested interactive controls.
- [ ] Extend shared cards/artboxes with subtle amber/teal treatment, theme-neutral Main segments, accessible individual hover/focus actions and owner-referenced SVG icons. Include provenance/problem state in virtualized render invalidation.
- [ ] Run focused JS and Python checks sequentially. Existing missing inventory warning remains distinct from duplicate files.

## 3. Root, scan, cover and media readiness

**Owners:** existing `library_roots.py`, `scoped_library_roots.py`, `library_settings.py`, `library_indexing.py`, `cover_workflow.py`, `scan_state.py`, and media routes.

- [ ] Inspect existing contracts and run focused category enumeration, second-root media containment, cover-target and offline-root tests.
- [ ] If a gap fails an approved case, add a regression test before the minimal responsible-layer fix. No speculative replacement of working root/scan infrastructure.
- [ ] Establish runnable local build prerequisites without changing production roots or initiating a scan before acceptance.

## 4. Verification, documentation and manual handoff

- [ ] Separate verification handoff runs relevant focused checks, reports exact counts and prerequisites.
- [ ] Complete two full relevant-diff local review passes; repair all confirmed issues. A substantive second-pass issue requires another full pass.
- [ ] Reconcile owning companion plan, UI registry and functional cases without overwriting concurrent private documentation changes. Check only proven milestones; leave release/manual/E2E/move items open.
- [ ] Provide the owner a runnable initial build and exact manual script: configure sources, test all three Appearance toggles and last-enabled constraint, hover/focus icons, inspect duplicates and play one selected copy.
- [ ] After owner acceptance, configure authorized real roots, run full scan/missing-cover pass, report unavailable roots and provider failures; proceed to approved E2E/release gates separately.

## Progress

Design approval recorded; test-author handoffs started. No product implementation or real-source scan verified yet.
