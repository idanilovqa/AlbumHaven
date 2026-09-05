# Targeted Library Filesystem Watcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconcile new, changed, moved, and deleted library media through targeted filesystem events while the server runs, then publish Postgres and web updates without an automatic full scan.

**Architecture:** FastAPI lifespan owns a `LibraryWatchService` composed from an event source, debounce coordinator, targeted reconciler, and Postgres repository. The first event source wraps `watchdog`; the other boundaries remain platform-neutral and injectable. Targeted transactions share the inventory advisory lock and mutation revision with manual scans.

**Tech Stack:** Python 3, FastAPI, watchdog, mutagen, psycopg/Postgres, plain JavaScript/CSS, Node test runner, pytest, Playwright after manual acceptance.

## Global Constraints

- Preserve unrelated dirty-tree edits and inspect every overlapping diff before patching.
- Keep Postgres as the sole authority for app-owned inventory.
- Start the watcher with the server and stop it during server shutdown.
- Do not watch or reconcile changes made while the server is stopped.
- Do not invoke a full scan for an ordinary event, queue overflow, missed event, or root disconnect.
- Block stale and delete mutations for an unhealthy root.
- Keep raw paths out of API and UI payloads.
- Use `library.inventory.manage` only for confirmed missing-album removal.
- Web is required. Tauri is product-required and deferred. Android, TV, and Apple are unsupported.
- Run at most one pytest process and one Playwright process at a time.
- Add functional and performance E2E only after owner manual acceptance.

---

### Task 1: Replace the periodic worker with watcher lifecycle and normalized events

**Files:**

- Modify: `requirements.txt`
- Replace: `music_app/services/library_reconciliation.py`
- Modify: `music_app/__init__.py`
- Modify: `tests/py/test_library_reconciliation.py`

**Interfaces:**

- Produces: `LibraryEventKind`, `LibraryEvent`, `LibraryEventSource`, `WatchdogLibraryEventSource`, and `LibraryWatchService.start()/stop()`.
- Consumes: configured library roots and the existing FastAPI lifespan.

- [x] **Step 1: Write failing lifecycle and normalization tests**

  Add tests that inject a fake event source, normalize create/modify/delete/move events against one configured root, reject out-of-root paths, start once, stop once, and leave no live thread. Add a regression assertion that `run_library_reconciliation_loop` and `periodic_reconciliation` no longer exist.

- [x] **Step 2: Run the focused test and confirm RED**

  Run `pytest -q tests/py/test_library_reconciliation.py` and require failures for the missing watcher types rather than import or fixture errors.

- [x] **Step 3: Add watchdog and the event-source boundary**

  Add `watchdog` to `requirements.txt`. Define immutable events with source and destination paths:

  ```python
  class LibraryEventKind(StrEnum):
      CREATED = "created"
      MODIFIED = "modified"
      DELETED = "deleted"
      MOVED = "moved"
      ROOT_UNAVAILABLE = "root_unavailable"
      OVERFLOW = "overflow"

  @dataclass(frozen=True, slots=True)
  class LibraryEvent:
      kind: LibraryEventKind
      root_id: str
      path: Path
      destination: Path | None = None
      destination_root_id: str | None = None
      observed_at: float = 0.0
      is_directory: bool = False
  ```

  Keep watchdog-specific handlers inside `WatchdogLibraryEventSource`; no downstream service imports watchdog classes.

- [x] **Step 4: Wire lifespan ownership**

  Replace `start_library_reconciliation_worker` and `stop_library_reconciliation_worker` imports and calls with one service instance stored on runtime state. Shutdown must stop intake and join owned threads within the existing lifespan cleanup deadline.

- [ ] **Step 5: Run the focused test and commit**

  Run `pytest -q tests/py/test_library_reconciliation.py`, then stage only Task 1 files and commit `feat: add library watcher lifecycle`.

### Task 2: Debounce events and wait for stable media writes

**Files:**

- Create: `music_app/services/library_event_coordinator.py`
- Create: `tests/py/test_library_event_coordinator.py`

**Interfaces:**

- Consumes: `LibraryEvent` values and injected `stat_path`, clock, and queue functions.
- Produces: `TargetedReconciliationRequest(root_id, paths, deleted_paths, moves)` values for the reconciler; each move retains its destination root identity.

- [x] **Step 1: Write failing coordinator tests**

  Cover duplicate modification events, rapid multi-file copies in one album directory, create-then-delete, directory-subtree deletion, source/destination file and directory move pairing, bounded queue overflow, transient sharing violations, file disappearance during sampling, and shutdown.

- [x] **Step 2: Verify RED**

  Run `pytest -q tests/py/test_library_event_coordinator.py`.

- [x] **Step 3: Implement deterministic coalescing**

  Group events by `(root_id, affected_directory)`. Keep move endpoints, directory-subtree semantics, and both root identities in one request. Let a delete dominate earlier create/modify work for the same path. Emit an overflow health event before dropping work from a full queue.

- [x] **Step 4: Implement stable-write sampling**

  Require two equal `(size, mtime_ns)` samples before parsing a created or modified media file. Inject the waiter and stat function so tests advance without real sleeps. Convert `FileNotFoundError` to deletion and report exhausted sharing violations as an operational problem.

- [ ] **Step 5: Verify and commit**

  Run `pytest -q tests/py/test_library_event_coordinator.py tests/py/test_library_reconciliation.py`, then commit `feat: coordinate library filesystem events`.

### Task 3: Publish targeted mutations to Postgres

**Files:**

- Create: `music_app/services/targeted_library_reconciliation.py`
- Modify: `music_app/services/scan_cache_persistence.py`
- Modify: `music_app/services/state.py`
- Create: `tests/py/test_targeted_library_reconciliation.py`
- Modify: `tests/py/test_scan_cache_persistence.py`

**Interfaces:**

- Consumes: `TargetedReconciliationRequest` and existing scanner metadata parsing helpers.
- Produces: `TargetedReconciliationResult(revision, affected_album_keys, health)`.
- Repository method: `PostgresScanCacheAdapter.persist_targeted_inventory_mutation(...)`.

- [ ] **Step 1: Add failing pure reconciliation tests**

  Prove that create/modify parses only requested files, delete marks only matching root-owned rows stale, directory deletion marks only root-owned descendants stale, move produces one source/destination mutation, and an unhealthy root rejects destructive work. Assert that the targeted reconciler has no full-scanner dependency.

- [ ] **Step 2: Add failing Postgres persistence tests**

  Use isolated library records to prove atomic upsert, metadata update, one-track stale transition, full-album stale transition, move, idempotent duplicate delivery, revision increment, and rollback. Assert stale marking preserves `metadata #> '{scan_cache,file_entry}'` and only merges stale fields.

- [ ] **Step 3: Verify RED in one pytest process**

  Run `pytest -q tests/py/test_targeted_library_reconciliation.py tests/py/test_scan_cache_persistence.py`.

- [ ] **Step 4: Implement the repository transaction**

  Build mutation rows before opening the transaction. Inside the transaction, take `pg_advisory_xact_lock(hashtext('album-haven:local-inventory-publication'))`, upsert active rows with `ON CONFLICT`, and mark deleted rows stale with nested JSONB merge:

  ```sql
  metadata = jsonb_set(
    coalesce(metadata, '{}'::jsonb),
    '{scan_cache}',
    coalesce(metadata->'scan_cache', '{}'::jsonb)
      || jsonb_build_object('stale', true, 'stale_marked_at', coalesce(...)),
    true
  )
  ```

  Increment `inventory_mutation_revision` in the same transaction and return affected album identities without paths.

- [ ] **Step 5: Invalidate affected projections after commit**

  Reuse the existing cache invalidation seams for browse, relation, Album Details, Problematic Files, and covers. Do not rebuild unrelated roots or run the full scanner.

- [ ] **Step 6: Verify and commit**

  Run the Task 3 pytest command and commit `feat: persist targeted library mutations`.

### Task 4: Add watcher health to status and Problematic Files

**Files:**

- Create: `music_app/services/library_watch_health.py`
- Modify: `music_app/services/view_payloads.py`
- Modify: `music_app/routes/api_read_asgi_routes.py`
- Modify: `music_app/static/js/runtime/utility-list-builders.js`
- Modify: `music_app/static/js/runtime/utility-loaders-and-cover-lookup.js`
- Modify: `music_app/static/js/runtime/core-state-and-helpers.js`
- Modify: `music_app/static/css/runtime/non-album-and-player.css`
- Create: `tests/py/test_library_watch_health.py`
- Modify: `tests/py/test_view_payloads.py`
- Modify: `tests/js/runtime/utility-list-builders.test.js`

**Interfaces:**

- Produces: server-owned watcher health with `state`, opaque `root_key`, `detected_at`, `message`, and allowed manual-scan action.
- Consumes: root-unavailable and overflow events from Task 1.

- [ ] **Step 1: Write failing backend and renderer tests**

  Prove overflow and disconnect create one persistent root problem, block stale decisions, show `Some library changes may have been missed.`, and expose no path. Prove a successful manual full scan clears only the recovered root's problem.

- [ ] **Step 2: Verify RED**

  Run one pytest command for the Python files, then one `node --test --test-concurrency=1` command for the JavaScript file.

- [ ] **Step 3: Implement Postgres-backed health state and payloads**

  Store health in the existing Postgres operational metadata boundary. Project the existing authorized manual full-scan action; a read-only reviewer gets the message without the action.

- [ ] **Step 4: Render existing shared patterns**

  Use the Library Status amber variant and Problematic Files operational row. Reuse shared Button and status tokens; do not add a new panel or dialog.

- [ ] **Step 5: Verify and commit**

  Rerun the focused Python and Node commands and commit `feat: report library watcher health`.

### Task 5: Connect missing-album UI to targeted inventory state

**Files:**

- Modify: `music_app/services/library_browse_postgres.py`
- Modify: `music_app/services/view_payloads.py`
- Modify: `music_app/static/js/runtime/virtual-artist-grid.js`
- Modify: `music_app/static/js/runtime/tag-editor-and-optimistic-updates.js`
- Modify: `music_app/static/css/runtime/non-album-and-player.css`
- Modify: `tests/py/test_library_browse_postgres.py`
- Modify: `tests/py/test_missing_album_projection.py`
- Modify: `tests/js/runtime/virtual-artist-grid.test.js`
- Modify: `tests/js/runtime/tag-editor-and-optimistic-updates.test.js`

**Interfaces:**

- Consumes: stale file rows and `inventory_mutation_revision` from Task 3.
- Produces: `inventory_status = "missing"`, `missing_since`, and the existing removal action projection.

- [ ] **Step 1: Add regressions for cached-cover tombstones and exact copy**

  Prove all-stale albums remain in browse with stored metadata, cached covers do not suppress the badge, its bottom-right hover/focus label is `Album deleted`, and Album Details uses the approved warning. Preserve the Problematic Files reason `Album not found`.

- [ ] **Step 2: Verify RED**

  Run the focused Python files in one process and focused Node files with concurrency one.

- [ ] **Step 3: Fix projection and renderer seams**

  Derive inventory status from file rows rather than cover lookup. Keep the badge inside the cover boundary and in the card render key. Retain reduced-motion behavior and all removal authorization rules.

- [ ] **Step 4: Rebuild and verify**

  Run `npm run build:runtime`, rerun focused tests, inspect generated output, and commit `fix: show watched missing albums in gallery`.

### Task 6: Focused integration verification and manual acceptance build

**Files:**

- Modify only feature-owned tests or code needed to correct focused failures.

**Interfaces:**

- Consumes all earlier tasks.
- Produces a server build and manual script for owner acceptance.

- [ ] **Step 1: Run the complete focused Python set once**

  Run one pytest process containing watcher lifecycle, coordinator, targeted persistence, browse projection, health, and missing-album removal tests. Record the test count and failures.

- [ ] **Step 2: Run the complete focused Node set once**

  Run one concurrency-one Node process containing gallery, details, removal, Problematic Files, and status tests.

- [ ] **Step 3: Run static checks**

  Run `git diff --check`, dependency/import validation, and the runtime-bundle guard. Inspect every overlapping dirty file before attributing it to this feature.

- [ ] **Step 4: Exercise a temporary root through the running server**

  Start the normal FastAPI application with an isolated Postgres library and temporary media root. Copy, edit, move, and delete generated media. Verify each inventory revision and UI change without a manual scan. Stop the server and verify its watcher threads and owned child processes exit.

- [ ] **Step 5: Hand off manual acceptance**

  Give the owner the nine-step script from the design, focused test evidence, changed files, and observed event-to-commit/event-to-visible samples. Wait for owner acceptance before Task 7.

### Task 7: Add approved functional and measurement E2E after manual acceptance

**Files:**

- Create: `tests/e2e/specs/libraryFilesystemWatcher.functional.spec.js`
- Create: `tests/e2e/actions/libraryFilesystemWatcherActions.js`
- Create: `tests/e2e/poms/libraryWatchStatus.js`
- Modify: `tests/e2e/support/isolatedLibraryApp.py`
- Modify: `tests/e2e/poms/galleryPage.js`
- Modify: `tests/e2e/actions/utilityProblematicFilesActions.js`
- Modify: `tests/ci/functional-shards.json`
- Modify: `tests/ci/test-data-matrix.json`

**Interfaces:**

- Consumes the production server, watcher, Postgres repository, API revision, and UI from Tasks 1–6.
- Produces coverage for FTC-LIBROOTS-016 through FTC-LIBROOTS-019 and measurement records without a timing threshold.

- [ ] **Step 1: Extend the isolated fixture**

  Give each test a generated watched root and unique Postgres library. Expose filesystem actions through support code, not test-only app routes. Ensure teardown stops the server, watcher, browser, and owned processes.

- [ ] **Step 2: Add thin Playwright scenarios**

  Keep the spec declarative and call action/POM methods for copy, tag edit, track deletion, album deletion, move, overflow injection at the event-source boundary, warning inspection, and authorized removal.

- [ ] **Step 3: Wait on state, not time**

  Use `expect.poll()` for the production inventory revision and web-first assertions for visible state. Do not use `waitForTimeout()` or fixed sleeps.

- [ ] **Step 4: Record latency samples**

  Record event received, stable-ready, Postgres commit, API revision, and visible UI timestamps as non-blocking measurements. Do not add target, grace, or ceiling values before owner approval.

- [ ] **Step 5: Run focused E2E and update matrices**

  Run the functional watcher group alone, verify cleanup, update the shard and test-data matrices, and commit `test: cover library filesystem watcher flow`.

- [ ] **Step 6: Calibrate the performance contract**

  Present representative distributions to the owner. Add a central performance target, grace band, and hard ceiling only after approval, then run the required serial regression, review, and publish flow.
