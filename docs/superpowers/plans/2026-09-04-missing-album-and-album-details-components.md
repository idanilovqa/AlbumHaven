# Missing Album And Album Details Components Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task by task.

**Goal:** Deliver the approved missing-album gallery/detail treatment and migrate the complete live Album Details boundary onto reusable current-web components without changing playback behavior.

**Architecture:** Keep watcher and Postgres inventory ownership unchanged. Pure JavaScript renderers own `GalleryCard`, `AlbumArtbox`, `SmallAlert`, `AlbumDetailsHeader`, `OnPageAlert`, and `AlbumTrackTable`; the current Jinja shell supplies stable component hosts. `AlbumTrackTable` composes `CompactDataTable` and preserves every existing playback data hook. Per-account layout and animation choices extend the existing Appearance repository and route. This is an owner-approved bounded current-stack component migration; later React parity maps these boundaries rather than preserving page-local renderers.

**Tech Stack:** FastAPI/ASGI, psycopg/Postgres, Jinja2 shell, plain JavaScript component renderers, CSS custom properties and motion paths, Node test runner, pytest, Playwright after manual acceptance.

## Global Constraints

- Do not change watcher lifecycle, full-scan policy, inventory authority, removal capability, audio source, queue, seek, or player-controller ownership.
- Preserve missing album gallery identity and sort values; missing state changes presentation only.
- Every artbox is square.
- Header actions remain icon-only and exactly `34px × 34px`.
- Use shared Button renderers for alert actions.
- Use `CompactDataTable` at compact density for normal Album Details.
- Keep `Album not found` as gallery and Problematic Files copy.
- Run JavaScript and Python tests serially, with at most one pytest process.
- Add functional E2E only after owner manual acceptance.
- Before code changes, checkpoint or otherwise isolate the existing dirty worktree without discarding unrelated work.

### Task 1: Lock the reusable component contracts with failing tests

**Files:**

- Create: `tests/js/runtime/alert-components.test.js`
- Create: `tests/js/runtime/album-artbox.test.js`
- Create: `tests/js/runtime/gallery-card-component.test.js`
- Create: `tests/js/runtime/album-details-components.test.js`
- Create: `tests/js/runtime/album-track-table.test.js`
- Modify: `tests/js/runtime/virtual-artist-grid.test.js`
- Modify: `tests/js/runtime/track-modal-lightbox-helpers.test.js`

- [x] **Step 1: Add RED tests for alerts and artboxes**

  Assert `error|warning|info`, semantic labels, compact near-circle state,
  hover/focus expansion hooks, square `AlbumArtbox`, crossed-circle missing
  placeholder, bottom-right slot, and reduced-motion hooks.

- [x] **Step 2: Add RED tests for GalleryCard**

  Assert stable `data-gallery-card-key`, unchanged sort-relevant metadata,
  `Album not found`, cached-cover independence, existing open-details hooks,
  rating/track/duration content, and a nested `AlbumArtbox` renderer call.

- [x] **Step 3: Add RED tests for Album Details components**

  Assert three layouts, fat-dot identity separators, first-line action
  alignment for `Stacked Bar`, `34px × 34px` icon actions, full missing alert,
  shared buttons, no artbox `SmallAlert`, and no table host for missing state.

- [x] **Step 4: Add RED tests for AlbumTrackTable**

  Assert compact density, explicit Play/Pause button, current selectors and
  data attributes, disc headings only for multi-disc data, surface-only hover,
  persistent search state, static playing outline, two opposite path spectra,
  reduced-motion fallback, and the separate total-length strip with no left or
  top border.

- [x] **Step 5: Run the RED set**

  Run:

  `node --test --test-concurrency=1 tests/js/runtime/alert-components.test.js tests/js/runtime/album-artbox.test.js tests/js/runtime/gallery-card-component.test.js tests/js/runtime/album-details-components.test.js tests/js/runtime/album-track-table.test.js`

  Expected: failures name missing component functions or contracts, not syntax,
  fixture, or import errors.

### Task 2: Implement shared alerts, AlbumArtbox, and GalleryCard

**Files:**

- Create: `music_app/static/js/runtime/alert-components.js`
- Create: `music_app/static/js/runtime/album-artbox.js`
- Create: `music_app/static/js/runtime/gallery-card-component.js`
- Create: `music_app/static/css/runtime/alert-components.css`
- Create: `music_app/static/css/runtime/album-artbox-and-gallery-card.css`
- Modify: `music_app/static/js/runtime/virtual-artist-grid.js`
- Modify: `music_app/static/css/runtime/non-album-and-player.css`
- Modify: `music_app/templates/index.html`
- Modify: `scripts/build-runtime-bundle.cjs`
- Modify: tests from Task 1

- [x] **Step 1: Implement pure alert renderers**

  Expose validated severity, title/body/icon/action slots, and compact versus
  page presentation. Escape text and require callers to supply only existing
  shared-Button markup for actions.

- [x] **Step 2: Implement AlbumArtbox**

  Preserve current cover loading/error hooks. Render square geometry for all
  states, crossed-circle missing art, and an overridable bottom-right action
  slot. Inventory status overrides cached cover display only for the missing
  visual state; it does not mutate cover persistence.

- [x] **Step 3: Implement GalleryCard and delegate the live renderer**

  Move the whole card markup boundary out of `virtual-artist-grid.js` while
  retaining `albumCardHtml(...)` as a compatibility delegate during bundle
  migration. Do not change virtual-grid node keys, render keys, card click
  selectors, or cover-loading priorities.

- [x] **Step 4: Add approved SmallAlert styles**

  Use semantic Appearance variables for tinted fill, outline, icon, and text.
  Anchor at artbox bottom-right. Only the compact alert itself activates pointer
  expansion; artbox hover does not. Give the expanded label explicit trailing
  padding and stable space, and expand without changing card dimensions. Under
  reduced motion, remove interpolation while retaining focus-visible text.

- [x] **Step 5: Verify gallery components**

  Rerun Task 1 gallery tests plus:

  `node --test --test-concurrency=1 tests/js/runtime/virtual-artist-grid.test.js tests/js/runtime/gallery-cover-readiness.test.js`

  Expected: all pass; missing and normal cards keep stable identities.

### Task 3: Migrate Album Details shell, header, artbox, and page alert

**Files:**

- Create: `music_app/static/js/runtime/album-details-components.js`
- Create: `music_app/static/css/runtime/album-details-components.css`
- Modify: `music_app/templates/partials/primary-modals.html`
- Modify: `music_app/static/js/runtime/modal-and-overlay-helpers.js`
- Modify: `music_app/static/js/runtime/tag-editor-and-optimistic-updates.js`
- Modify: `music_app/static/css/runtime/track-modal-and-lightbox.css`
- Modify: `music_app/templates/index.html`
- Modify: `scripts/build-runtime-bundle.cjs`
- Modify: `tests/js/runtime/track-modal-lightbox-helpers.test.js`
- Modify: `tests/js/runtime/tag-editor-and-optimistic-updates.test.js`

- [x] **Step 1: Give Jinja one stable Album Details host**

  Preserve dialog IDs, accessible labelling, focus trap, close behavior, and
  existing event-delegation roots. Replace page-local header/body assumptions
  with component-owned slots; do not add a second modal.

- [x] **Step 2: Implement AlbumDetailsHeader**

  Render `classic_bar`, `stacked_bar`, and `editorial_canvas` from one identity
  model. Keep Edit tags, Open folder, and Close selectors and accessible names.
  Hide unsafe missing-album actions through server-owned allowed state.

- [x] **Step 3: Reuse AlbumArtbox and OnPageAlert**

  Render square normal/missing cover states. For missing state render
  `Album details unavailable`, missing copy, `Remove from library` when
  authorized, and `Keep as missing`. Reuse the existing confirmation route and
  immediate optimistic cleanup. Render no track list or footer.

- [x] **Step 4: Preserve modal lifecycle and detail hydration**

  Keep loading shell, preview hydration, release tabs, duplicate-source state,
  cover tools for present albums, tag edit, folder open, lightbox, and close
  interruption behavior unchanged.

- [x] **Step 5: Verify the migrated shell**

  Run the Task 1 Album Details test plus:

  `node --test --test-concurrency=1 tests/js/runtime/track-modal-lightbox-helpers.test.js tests/js/runtime/tag-editor-and-optimistic-updates.test.js tests/js/runtime/modal-stacking-contract.test.js`

  Expected: all pass, including existing loading/hydration and close contracts.

### Task 4: Implement AlbumTrackTable on CompactDataTable

**Files:**

- Create: `music_app/static/js/runtime/album-track-table.js`
- Create: `music_app/static/css/runtime/album-track-table.css`
- Modify: `music_app/static/js/runtime/compact-data-table.js`
- Modify: `music_app/static/css/runtime/compact-data-table.css`
- Modify: `music_app/static/js/runtime/tag-editor-and-optimistic-updates.js`
- Modify: `music_app/static/js/runtime/player-and-waveform.js`
- Modify: `music_app/static/css/runtime/track-modal-and-lightbox.css`
- Modify: `music_app/templates/index.html`
- Modify: `scripts/build-runtime-bundle.cjs`
- Modify: `tests/js/runtime/album-track-table.test.js`
- Modify: `tests/js/runtime/player-and-waveform.test.js`
- Modify: `tests/js/runtime/track-modal-lightbox-helpers.test.js`

- [x] **Step 1: Add non-breaking CompactDataTable row extensions**

  Accept validated row class/state and accessible description hooks needed by
  hover, search, and playing states. Preserve every existing consumer and
  default output.

- [x] **Step 2: Render track groups through AlbumTrackTable**

  Use `density: compact`, stable Play/Pause markup, track number, title/credit,
  and duration. Preserve `data-track-row-path`, `data-src`, playback payload,
  double-click handling, problem links, and current/total time updates.

- [x] **Step 3: Render disc labels and footer**

  Suppress a generic Tracks label. Render disc headings only when the album has
  multiple discs. Render every disc as a separate `CompactDataTable`, keep each
  disc label outside its table border, and render the column headers only for
  the first table. Suppress `CD 1` when the other groups are bonus discs, but
  keep numbered labels when at least two main-disc groups are present. Put
  total length outside the tables in a separate gradient strip; ensure no
  left/top outline can be produced by the table frame.

- [x] **Step 4: Implement state precedence and exact motion path**

  Use one rounded-border geometry for static outline and both animated spectra.
  Drive both spectra from the same keyframes and duration with a 50% path-offset
  difference. Do not approximate with independent top/bottom gradients. Hover
  must not erase search or playing state. Resolve colors from theme/player
  variables and provide reduced-motion/static fallback.

- [x] **Step 4a: Match the approved table ink and duration treatment**

  Resolve data text through the palette's primary ink and headings/secondary
  credits through muted ink. Keep album duration values free of a leading dot
  during initial render and playback refresh. Slightly soften spectrum opacity
  without changing its path, timing, direction, or half-perimeter offset.

- [x] **Step 5: Preserve playback behavior**

  Trigger only a transient CSS class on a successful Play click. Do not replace
  event handlers, `Audio`/AudioWorklet ownership, queue state, current time,
  seek, next-track behavior, or cross-surface playback controls.

- [x] **Step 6: Verify table and playback**

  Run:

  `node --test --test-concurrency=1 tests/js/runtime/album-track-table.test.js tests/js/runtime/compact-data-table.test.js tests/js/runtime/player-and-waveform.test.js tests/js/runtime/track-modal-lightbox-helpers.test.js`

  Expected: all pass; existing audio and progress assertions remain unchanged.

### Task 5: Persist Album Details Appearance choices

**Files:**

- Create: `migrations/postgres/0058_album_details_appearance.sql`
- Modify: `migrations/postgres/README.md`
- Modify: `music_app/services/appearance_preferences_postgres.py`
- Modify: `music_app/routes/appearance_asgi.py`
- Modify: `music_app/templates/partials/appearance-bootstrap.html`
- Modify: `music_app/static/js/runtime/appearance-backgrounds-bridge.js`
- Modify: `music_app/static/js/runtime/utility-renderers-and-actions.js`
- Modify: `music_app/static/js/runtime/utility-list-builders.js`
- Modify: `music_app/static/css/appearance-backgrounds.css`
- Modify: `tests/py/test_appearance_preferences_postgres.py`
- Modify: `tests/py/test_account_appearance_asgi.py`
- Modify: `tests/js/runtime/appearance-waveform-recents.test.js`
- Modify: `tests/js/runtime/utility-list-builders.test.js`

- [x] **Step 1: Add RED validation and persistence tests**

  Cover defaults, all allowed values, unknown-value rejection, sibling-field
  preservation, per-account isolation, unauthorized denial, and no-store reads.

- [x] **Step 2: Extend the existing Appearance record atomically**

  Add `album_details_layout` and `album_playing_row_animation` without creating
  a second preference store. Preserve existing palette, selection, waveform,
  compact-player, and recent-color fields.

- [x] **Step 3: Add the Album page Appearance group**

  Reuse current segmented-choice and save/cancel patterns. Apply saved layout
  and motion state to open and future Album Details instances only after a
  successful write; failed writes must not become durable browser success.

- [x] **Step 4: Verify Python, then JavaScript**

  Run one pytest process:

  `pytest -q tests/py/test_appearance_preferences_postgres.py tests/py/test_account_appearance_asgi.py tests/py/test_postgres_migrations.py`

  After it exits, run:

  `node --test --test-concurrency=1 tests/js/runtime/appearance-waveform-recents.test.js tests/js/runtime/utility-list-builders.test.js tests/js/runtime/album-details-components.test.js`

  Expected: all pass serially.

### Task 6: Complete focused integration verification and manual handoff

**Files:**

- Modify: `tests/py/test_missing_album_projection.py`
- Modify: `tests/py/test_targeted_library_reconciliation.py`
- Modify: `tests/js/runtime/gallery-refresh-and-status.test.js`
- Modify: `tests/js/runtime/bootstrap-gallery-event-handlers.test.js`
- Create: `docs/handoffs/2026-09-04-missing-album-album-details-manual-test.md`

- [x] **Step 1: Add projection/order regression tests**

  Prove missing projection retains stored album identity, year, rating, and
  ordering data while forcing missing inventory presentation. Prove refresh
  reconciles the existing card in place rather than appending it.

- [x] **Step 2: Build the runtime and run focused JavaScript tests**

  Run `npm run build:runtime`, then one Node invocation containing every changed
  runtime test. Expected: bundle parity and all focused tests pass.

- [x] **Step 3: Run focused Python integration tests**

  Run one pytest process containing appearance, watcher, targeted reconciliation,
  missing projection, and removal tests. Expected: all pass; no real database is
  used by state-mutating cases.

- [ ] **Step 4: Inspect the production UI at desktop and narrow widths**

  Use the normal FastAPI app with isolated Postgres and generated media. Verify
  square art, alert expansion/focus, all layouts, missing state, table density,
  disc headings, footer fade, state precedence, reduced motion, and exact 34px
  actions. Capture browser console and accessibility evidence.

- [ ] **Step 5: Exercise real playback through the migrated table**

  Start, pause, seek, resume, change track, close/reopen Album Details, and use
  the bottom player. Confirm one audible source, unchanged queue/progress, and
  no duplicate handlers or console errors.

- [ ] **Step 6: Measure without changing thresholds**

  Record watcher event-to-commit/event-to-visible latency and compare existing
  gallery/Album Details/idle-memory guards. Do not convert observations into a
  new threshold without owner approval.

- [x] **Step 7: Hand off for owner manual acceptance**

  Provide the exact build, data setup, steps, observed test counts, changed-file
  list, and known provisional Play-button chase note. Stop before E2E.

### Task 7: Add the approved E2E coverage after manual acceptance

**Files:**

- Create: `tests/e2e/specs/libraryFilesystemWatcher.functional.spec.js`
- Create: `tests/e2e/specs/albumDetailsComponents.functional.spec.js`
- Modify: `tests/e2e/poms/albumCard.js`
- Modify: `tests/e2e/poms/trackModal.js`
- Create: `tests/e2e/poms/components/smallAlert.js`
- Create: `tests/e2e/poms/components/albumTrackTable.js`
- Modify: `tests/e2e/support/isolatedLibraryApp.py`
- Modify: `tests/ci/functional-shards.json`
- Modify: `tests/ci/test-data-matrix.json`
- Modify: `C:/Repositories/album-haven-internal/docs/functional-test-cases/library-roots-new-arrivals-and-file-moves.md`
- Modify: `C:/Repositories/album-haven-internal/docs/functional-test-cases/album-details-versions-and-tracklists.md`

- [ ] **Step 1: Update the owner-approved cases exactly**

  Change `FTC-LIBROOTS-017` copy to `Album not found` and add the approved
  position/artbox/alert/no-table assertions. Add `FTC-ALBUM-DETAILS-019` and
  `FTC-ALBUM-DETAILS-020` exactly as approved in the design.

- [ ] **Step 2: Keep E2E on production paths**

  Generate media and isolated Postgres state before app start. Mutate the
  watched filesystem directly. Use visible settings and controls. Add no magic
  routes, DOM state injection, app-owned API mocks, fixed sleeps, or direct
  playback shortcuts.

- [ ] **Step 3: Run production-parity validation**

  Run `npm run check:e2e-production-parity`. Expected: pass.

- [ ] **Step 4: Run focused functional E2E and audit cleanup**

  Run only the two new specs through the local functional runner. Verify the
  exact owned FastAPI, watcher, browser, Node, and Python process tree exits and
  scoped ports are clear before another heavyweight run.

- [ ] **Step 5: Update matrices and evidence**

  Record exact test counts and results. Do not weaken existing expectations,
  timeouts, retries, performance thresholds, or playback assertions.

## Plan Self-Review

- The plan preserves the watcher and removal design instead of coupling UI to
  filesystem events.
- The full touched album-card and Album Details markup boundaries move behind
  reusable renderers; no page-local alert or table substitute is introduced.
- Existing audio ownership and selectors are retained and verified explicitly.
- Missing state, normal state, all three layouts, search, hover, playback,
  reduced motion, permissions, narrow layout, and cleanup have named coverage.
- Performance work measures risk without silently creating or widening a
  threshold.
- E2E remains after manual acceptance and requires the owner's exact three-case
  approval before implementation starts.
