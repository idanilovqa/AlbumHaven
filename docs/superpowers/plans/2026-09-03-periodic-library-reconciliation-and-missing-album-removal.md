# Periodic Library Reconciliation and Missing Album Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task.

**Goal:** Detect albums whose files disappeared from an available library root, keep them visible as actionable tombstones, and let an authorized owner or administrator remove them from Album Haven immediately.

**Architecture:** The ASGI lifespan owns a stoppable periodic reconciliation worker that reuses the existing single-flight scanner. Scan publication marks only files under successfully observed roots stale. Postgres read projections derive a missing-album tombstone when every known file for an album is stale. A capability-protected removal service rechecks the tombstone in a short transaction, deletes app-owned album inventory, advances the library revision, and invalidates affected projections. Existing gallery and utility renderers consume the new payload fields.

**Tech Stack:** Python 3, FastAPI, psycopg/Postgres, server-rendered HTML, plain JavaScript, CSS, Node test runner, pytest.

## Global Constraints

- Preserve unrelated dirty-tree edits. Inspect each target diff before patching and never restore or replace user-owned work.
- Keep app-owned persistence Postgres-only and never expose local paths.
- Use `library.inventory.manage` for removal. `library.problems.read` may reveal the warning but never authorize mutation.
- Web is required for this slice. Tauri parity remains required by the product design but deferred because no desktop repository exists. Android, TV, and Apple are unsupported.
- A missing or disconnected root must not mark its inventory stale. Only a successful observation of an available root can produce tombstones for that root.
- Run at most one pytest process at a time. Run focused tests now; full regression and E2E wait for owner manual acceptance.
- Keep the removal transaction short, use parameterized SQL, preserve listening history through existing `ON DELETE SET NULL` relationships, and invalidate caches after commit.

## Task 1: Lock down periodic reconciliation and root-health behavior

**Files:**

- Create: `tests/py/test_library_reconciliation.py`
- Modify: `tests/py/test_state.py`
- Modify: `tests/py/test_scan_cache_persistence.py`
- Create: `music_app/services/library_reconciliation.py`
- Modify: `music_app/services/state.py`
- Modify: `music_app/services/scan_cache_persistence.py`
- Modify: `music_app/__init__.py`

1. Add failing tests proving the periodic worker requests a normal background refresh after the configured cache-age interval, skips while a scan is active, and stops cleanly with the application lifespan.
2. Add a failing scan test with two configured roots: one available and one unavailable. Assert that publication marks missing files stale only beneath the available root and preserves the unavailable root's active rows.
3. Add a failing persistence test proving the first `stale_marked_at` timestamp survives later reconciliations and an active upsert clears both stale fields.
4. Run `pytest -q tests/py/test_library_reconciliation.py tests/py/test_state.py tests/py/test_scan_cache_persistence.py` and confirm the new assertions fail for the intended missing behavior.
5. Implement a stoppable monitor with injected wait/start functions for deterministic tests. Start and stop it in `create_asgi_app()` lifespan beside the Last.fm worker.
6. Carry successfully observed root identities through scan publication and scope `_mark_stale_track_files_sql()` to those roots. If no roots are available, fail without stale publication.
7. Make stale marking idempotent so repeat scans do not reset `stale_marked_at`.
8. Rerun the focused pytest command and require green.

## Task 2: Derive missing-album read projections

**Files:**

- Modify: `tests/py/test_library_browse_postgres.py`
- Modify: `tests/py/test_view_payloads.py`
- Modify: `music_app/services/library_browse_postgres.py`
- Modify: `music_app/services/view_payloads.py`

1. Add failing projection tests for an album whose every known file is stale. Assert gallery and album-details payloads retain it with `inventory_status: "missing"`, `missing_since`, zero playable tracks, no file actions, and removal authorization derived from allowed actions.
2. Add a mixed-state test proving an album with any active file remains normal.
3. Add Problematic Files tests proving the same tombstone appears once with reason `Album not found`, cannot be excluded, and contains no raw path.
4. Run `pytest -q tests/py/test_library_browse_postgres.py tests/py/test_view_payloads.py` and confirm RED.
5. Extend the Postgres browse SQL with a narrowly scoped missing-album projection sourced from stale inventory. Merge it with active browse results without duplicating albums.
6. Extend gallery, detail, and Problematic Files payload shaping with the approved public fields and permission decision.
7. Rerun the focused pytest command and require green.

## Task 3: Add the protected confirm-removal action

**Files:**

- Create: `music_app/services/missing_album_removal_postgres.py`
- Modify: `music_app/routes/api_wave_a_asgi_routes.py`
- Modify: `music_app/routes/api_read_asgi_routes.py`
- Modify: `music_app/services/private_route_boundary.py`
- Modify: `music_app/routes/admin_asgi.py`
- Create: `tests/py/test_missing_album_removal_postgres.py`
- Create: `tests/py/test_missing_album_projection.py`

1. Add failing service tests for successful removal, a reappeared active file returning a domain conflict, unknown album handling, correct library scoping, and rollback on failure.
2. Add failing route tests for owner/admin success, read-only denial, malformed keys, and `409` when the album reappears.
3. Add capability-catalog tests proving `library.inventory.manage` is selectable for administrators and not included in listener defaults.
4. Run `pytest -q tests/py/test_missing_album_removal_postgres.py tests/py/test_policy_asgi.py tests/py/test_missing_album_asgi.py` and confirm RED.
5. Implement a repository method that locks the target album and its file inventory, verifies no active row exists, deletes stale file inventory and now-unreferenced local tracks, then deletes the album in one transaction. Let existing foreign keys detach retained listening history.
6. Add `POST /api/library/albums/{album_key}/confirm-removal`, protect it with `library.inventory.manage`, translate the reappeared case to `409`, and return the new library revision plus removed key.
7. Invalidate browse, relation, Problematic Files, utility-rule, and album-detail projections only after commit.
8. Rerun the focused pytest command and require green.

## Task 4: Render and remove missing albums in the gallery

**Files:**

- Modify: `music_app/static/js/runtime/virtual-artist-grid.js`
- Modify: `music_app/static/css/runtime/non-album-and-player.css`
- Modify: `music_app/static/js/runtime/tag-editor-and-optimistic-updates.js`
- Modify: `music_app/static/js/runtime/bootstrap-gallery-event-handlers.js`
- Modify: `music_app/static/js/runtime/modal-and-overlay-helpers.js`
- Modify: `music_app/templates/partials/primary-modals.html`
- Modify: `tests/js/runtime/virtual-artist-grid.test.js`
- Modify: `tests/js/runtime/tag-editor-and-optimistic-updates.test.js`
- Modify: `tests/js/runtime/bootstrap-gallery-event-handlers.test.js`
- Modify: `tests/js/runtime/modal-stacking-contract.test.js`

1. Add failing Node tests for the bottom-right `!` badge, hover/focus expansion label `Album not found`, missing-album detail warning, authorized/read-only action copy, confirmation copy, optimistic removal, empty-artist cleanup, and `409` recovery.
2. Run the focused Node test files with `node --test --test-concurrency=1` and confirm RED.
3. Render a semantic warning badge inside the cover button and include missing state in the card render key. Use existing appearance tokens plus the established destructive color; add a reduced-motion rule.
4. Render the approved warning first in Album Details. Hide playback, folder, tag, and cover actions for tombstones. Show `Remove from Album Haven` only when allowed, otherwise show `Ask an owner or administrator to remove it.`
5. Add the approved confirmation dialog and mutation handler. On success close both dialogs, remove the card, recalculate counts, remove an empty artist section, and refresh Problematic Files. On `409`, retain/refresh the card and announce that the album was found again.
6. Rerun the focused Node command and require green.

## Task 5: Add the Problematic Files action

**Files:**

- Modify: `music_app/static/js/runtime/utility-list-builders.js`
- Modify: `music_app/static/js/runtime/bootstrap-utility-event-handlers.js`
- Modify: `music_app/static/js/runtime/utility-loaders-and-cover-lookup.js`
- Modify: `tests/js/runtime/utility-list-builders.test.js`
- Modify: `tests/js/runtime/bootstrap-utility-event-handlers.test.js`

1. Add failing tests that render `Album not found` as an album-level, non-excludable reason and expose the same authorized removal flow without any path-based action.
2. Run `node --test --test-concurrency=1 tests/js/runtime/utility-list-builders.test.js tests/js/runtime/bootstrap-utility-event-handlers.test.js` and confirm RED.
3. Reuse the gallery confirmation/mutation function from the Problematic Files detail action. Refresh the summary and clear its selection immediately after success; preserve it on `409`.
4. Rerun the focused Node command and require green.

## Task 6: Rebuild assets and perform focused verification

**Files:**

- Modify generated output: `music_app/static/js/runtime-bundle.js`

1. Run `npm run build:runtime` and inspect the generated diff for only expected source composition changes.
2. Run the complete focused Python set from Tasks 1–3 in one pytest process.
3. Run the complete focused Node set from Tasks 4–5 with concurrency one.
4. Run the repository's static or import checks that cover changed routes and runtime sources.
5. Inspect `git diff --check`, the changed-file list, and every overlapping dirty-file diff to distinguish this feature from pre-existing work.

## Task 7: Manual acceptance handoff

1. Provide a build/run command and exact manual script: start with a present album, delete or move its directory, wait through one reconciliation interval, verify the gallery badge, details warning, and Problematic Files entry, then remove it as owner/admin and confirm immediate gallery/count cleanup.
2. Include safety checks: disconnect an entire configured root and verify its albums are not tombstoned; restore a missing album before confirmation and verify `409`/found-again recovery; sign in without `library.inventory.manage` and verify read-only copy.
3. Report focused test evidence, direct task time, workflow overhead, total elapsed time, and the exact feature-owned changed files.
4. Stop and wait for owner manual acceptance. Do not add functional E2E coverage or run the full release regression before acceptance.

## Task 8: Post-acceptance E2E and release verification

**Files:**

- Create or modify the approved functional E2E spec and fixture matrix only after owner acceptance.

1. Add one isolated, state-mutating E2E case covering deletion detection, all three UI surfaces, authorized confirmation, and immediate removal.
2. Add a second root-health safety case only if it can own both filesystem roots without affecting shared fixtures.
3. Update `tests/ci/functional-shards.json` and `tests/ci/test-data-matrix.json` with owner-approved cases.
4. Run the required focused E2E, then all required JavaScript and Python regression suites serially from a clean committed state.
5. Run review, address findings, and follow the repository publish flow.
