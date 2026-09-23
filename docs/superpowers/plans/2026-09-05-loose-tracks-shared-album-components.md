# Loose Tracks Shared Album Components Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render Loose Tracks with the exact shared Album Details header and playback table while giving Problematic Files labels the gallery alert's semantic error styling.

**Architecture:** Keep `AlbumDetailsHeader` and `AlbumTrackTable` as the domain components and add caller configuration for Loose Tracks copy, actions, path cells, and forced group labels. Add an `AlertLabel` renderer beside `SmallAlert`, sharing severity variables while retaining text-pill semantics. Adapt existing data into these components without adding domain behavior to `CompactDataTable`.

**Tech Stack:** Browser JavaScript, Jinja HTML, CSS custom properties, Node test runner, generated runtime bundle, Playwright.

## Global Constraints

- Preserve the current Problematic Files icon and navigation behavior; introduce no new track-table alerts.
- Loose Tracks columns: Play, `#`, Track with artist subtitle, File path, unlabeled problem/action slot, Length.
- Render one Total Length footer after every Loose Tracks group.
- Reuse Album Details hover, selected, playback, motion, reduced-motion, outline, and footer behavior exactly.
- Problematic Files error pills use error-family hover, selected, and focus states, never the global mint outline.
- Web and Tauri are required; Android, TV, and Apple are unsupported.
- Add no permissions, capabilities, persistence, endpoints, dependencies, or deployment changes.
- Preserve unrelated `.superpowers/` content and user-owned changes.

---

### Task 1: Configurable Album Details header

**Files:**
- Modify: `music_app/static/js/runtime/album-details-components.js`
- Modify: `music_app/templates/partials/primary-modals.html`
- Test: `tests/js/runtime/album-details-components.test.js`

**Interfaces:**
- Consumes: `ButtonComponent.renderActionButton(config)`, `escapeHtml(value)`.
- Produces: `buildAlbumDetailsHeaderHtml({ variant, title, subtitle, titleId, subtitleId, actionsHtml, ...albumFields })`; `buildLooseTracksHeaderActionsHtml()`.

- [ ] **Step 1: Write failing tests.** Call `buildAlbumDetailsHeaderHtml({ variant: 'copy', title: 'Loose Tracks', subtitle: 'Non-album tracks found in Folkstone and family artist folders.', titleId: 'non-album-modal-title', subtitleId: 'non-album-modal-subtitle', actionsHtml: buildLooseTracksHeaderActionsHtml() })`. Assert shared header structure, caller copy/IDs, shared Edit tags and Close ActionButtons, Loose Tracks data hooks, no folder action, no raw glyphs, unchanged album defaults, and a template header host.
- [ ] **Step 2: Verify RED.** Run `& 'C:\Program Files\nodejs\node.exe' --test --test-concurrency=1 tests/js/runtime/album-details-components.test.js`. Expect failure because copy mode and Loose Tracks actions do not exist.
- [ ] **Step 3: Implement copy mode.** In `buildAlbumDetailsHeaderHtml`, normalize `titleId`/`subtitleId`; when `variant === 'copy'`, render escaped title/subtitle inside the same `.album-details-header`, identity, primary, secondary, and actions classes. Keep current album rendering as the default path and use configurable IDs there too.
- [ ] **Step 4: Implement actions and shell.** Add `buildLooseTracksHeaderActionsHtml()` with two `ButtonComponent.renderActionButton` calls using the existing edit/close icon classes and stable Loose Tracks IDs/data attributes. Replace the template's raw Loose Tracks buttons/copy with `<div class="non-album-modal-header" id="non-album-modal-header"></div>`.
- [ ] **Step 5: Verify GREEN.** Repeat Step 2; expect all tests to pass.
- [ ] **Step 6: Commit.** Stage the three files and commit `refactor: share album header with loose tracks`.

### Task 2: Loose Tracks AlbumTrackTable variant

**Files:**
- Modify: `music_app/static/js/runtime/album-track-table.js`
- Modify: `music_app/static/js/runtime/modal-and-overlay-helpers.js`
- Modify: `music_app/static/css/runtime/non-album-and-player.css`
- Test: `tests/js/runtime/album-track-table.test.js`
- Test: `tests/js/runtime/modal-and-overlay-helpers.test.js`

**Interfaces:**
- Consumes: Task 1 header functions; `buildCompactDataTable(config)`; duration formatters.
- Produces: `buildAlbumTrackTableHtml({ groups, totalLength, showPath, forceGroupLabels, ariaLabel, playingAnimation })`; row `displayPath`; one shared table from `buildNonAlbumTrackSectionsMarkup(items)`.

- [ ] **Step 1: Write failing component tests.** Render `buildAlbumTrackTableHtml` with `showPath: true`, `forceGroupLabels: true`, a track containing `secondaryArtist` and `displayPath`, and `totalLength`. Assert exact order `play, number, title, path, problem, duration`, hidden Play/problem headers, visible `#`/Track/File path/Length headers, artist subtitle, empty problem cell, heading, and shared footer. Assert the default five-column Album Details output is unchanged.
- [ ] **Step 2: Write failing adapter tests.** Update the modal-helper VM to load `album-track-table.js`. Assert Loose Tracks returns one `.album-track-table`, ordered visible group headings, shared play controls and row classes, artist/path/duration cells, preserved problem icon, and one summed Total Length.
- [ ] **Step 3: Verify RED.** Run `& 'C:\Program Files\nodejs\node.exe' --test --test-concurrency=1 tests/js/runtime/album-track-table.test.js tests/js/runtime/modal-and-overlay-helpers.test.js`. Expect failures because path/forced-label configuration is absent and Loose Tracks builds separate CompactDataTables.
- [ ] **Step 4: Extend the shared table.** Add `path` to row cells. When `showPath` is true, use columns `34px 36px minmax(180px, 1fr) minmax(220px, .9fr) 20px minmax(54px, auto)` and configuration `play`, `number`, `title`, `path`, `problem`, `duration`; otherwise preserve the current grid/configuration byte-for-byte. Show headings when the existing rule passes or `forceGroupLabels` is true. Prefix table ARIA labels from `ariaLabel`.
- [ ] **Step 5: Adapt Loose Tracks data.** Convert `buildNonAlbumTrackRowsMarkup` to AlbumTrackTable track inputs, preserving title/filename fallback, artist, safe display path, sequential numbering, duration, playback state, and `isProblematic`. Collect populated groups in rarity/interview/other order and call `buildAlbumTrackTableHtml` once with `showPath`, `forceGroupLabels`, shared animation preference, and total seconds formatted once.
- [ ] **Step 6: Render the header on open.** Return `header` from `getNonAlbumModalElements`. In `openNonAlbumModal`, compute the existing contextual subtitle and render Task 1's copy header with title `Loose Tracks` and shared actions before rendering the table.
- [ ] **Step 7: Remove obsolete CSS.** Delete independent Loose Tracks row hover/current/play styling; retain modal shell, scrolling, sizing, and path typography needed around the shared components.
- [ ] **Step 8: Verify GREEN.** Repeat Step 3; expect all tests to pass.
- [ ] **Step 9: Commit.** Stage the five files and commit `refactor: render loose tracks with album table`.

### Task 3: Shared playback state

**Files:**
- Modify: `music_app/static/js/runtime/tag-editor-and-optimistic-updates.js`
- Test: `tests/js/runtime/tag-editor-and-optimistic-updates.test.js`

**Interfaces:**
- Consumes: shared row classes and `data-track-playing` from Task 2.
- Produces: `refreshNonAlbumModalPlaybackState()` matching `refreshTrackModalPlaybackState()`.

- [ ] **Step 1: Write a failing executable playback test.** Build a visible Loose Tracks modal row and active playback snapshot. Assert current/playing/animated classes, `data-track-playing="true"`, pause glyph/label, `current / duration` text, and animation suppression when the document preference is disabled.
- [ ] **Step 2: Verify RED.** Run `& 'C:\Program Files\nodejs\node.exe' --test --test-concurrency=1 tests/js/runtime/tag-editor-and-optimistic-updates.test.js`. Expect failure because Loose Tracks only toggles legacy classes.
- [ ] **Step 3: Implement the shared contract.** Mirror Album Details toggles for `.album-track-table__row--current`, `--playing`, `--animated`, and `row.dataset.trackPlaying`; make the duration text identical to Album Details without the legacy bullet prefix.
- [ ] **Step 4: Verify GREEN.** Repeat Step 2; expect all tests to pass.
- [ ] **Step 5: Commit.** Stage both files and commit `fix: share loose track playback states`.

### Task 4: Semantic AlertLabel

**Files:**
- Modify: `music_app/static/js/runtime/alert-components.js`
- Modify: `music_app/static/js/runtime/utility-list-builders.js`
- Modify: `music_app/static/css/runtime/alert-components.css`
- Modify: `music_app/static/css/utilities.css`
- Test: `tests/js/runtime/alert-components.test.js`
- Test: `tests/js/runtime/utility-list-builders.test.js`

**Interfaces:**
- Consumes: `normalizeAlertSeverity`, `escapeHtml`, existing Problematic Files data/state.
- Produces: `buildAlertLabelHtml({ severity, message, className, attributes, interactive, pressed, disabled })`.

- [ ] **Step 1: Write failing component tests.** Assert static error labels render `<span class="alert-label alert-label--error">`; interactive labels render `<button type="button">`, preserve escaped data attributes, `aria-pressed`, classes, and disabled state. Assert CSS shares `--alert-edge`, `--alert-tint`, `--alert-ink`, red-family border/background/glow, and same-family hover/focus/selected outline without `--appearance-interaction-outline`.
- [ ] **Step 2: Verify RED.** Run `& 'C:\Program Files\nodejs\node.exe' --test --test-concurrency=1 tests/js/runtime/alert-components.test.js`. Expect failure because AlertLabel does not exist.
- [ ] **Step 3: Implement AlertLabel.** Add a safe data/ARIA attribute serializer and the renderer. Include `.alert-label` in shared severity-variable selectors. Style its pill and interactive states with `--alert-edge` mixes; explicitly override the global interaction border/outline where necessary.
- [ ] **Step 4: Write failing integration tests.** Assert missing-album, album-level, and track-level reasons use `.alert-label--error`; selection hooks, disabled state, and `aria-pressed` remain intact; detected-problem output no longer hand-builds visual problem chips.
- [ ] **Step 5: Verify RED.** Run `& 'C:\Program Files\nodejs\node.exe' --test --test-concurrency=1 tests/js/runtime/utility-list-builders.test.js`. Expect failure because Problematic Files still builds utility chips.
- [ ] **Step 6: Integrate the component.** Render detected-problem static and interactive reasons through `buildAlertLabelHtml`, passing exact existing data attributes and state. Remove duplicated visual declarations from the utility chip while retaining unrelated consumers. Do not change `.track-problem-link` markup.
- [ ] **Step 7: Verify GREEN.** Run both tests from Steps 2 and 5 together; expect all tests to pass.
- [ ] **Step 8: Commit.** Stage the six files and commit `refactor: share semantic problem labels`.

### Task 5: Bundle and end-to-end verification

**Files:**
- Regenerate: `music_app/static/js/runtime-bundle.js`
- Modify: `tests/e2e/specs/nonAlbumRarity.spec.js`

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: deployable bundle and verified behavior.

- [ ] **Step 1: Update FTC-NON-ALBUM-012.** Assert `.album-details-header`, exactly Edit/Close actions, no folder action, one `.album-track-table`, approved six-column order, visible group labels, and one Total Length footer while retaining its existing open/close and track assertions.
- [ ] **Step 2: Regenerate.** Run `npm run build:runtime`; expect the bundle-written message and exit 0.
- [ ] **Step 3: Run focused tests.** Run the seven affected runtime test files plus `app-loader-bundle.test.js` with `node --test --test-concurrency=1`; expect zero failures.
- [ ] **Step 4: Run broad JS tests.** Run `npm run test:js`; expect zero failures.
- [ ] **Step 5: Run focused E2E.** Run the repository local functional harness targeting `nonAlbumRarity.spec.js` and `FTC-NON-ALBUM-012`, with one owned browser/server wave; expect pass and verify its owned process tree exits.
- [ ] **Step 6: Manual browser QA.** Compare Album Details and Loose Tracks at desktop/narrow widths; exercise play transitions, group totals, Edit tags, Close, reduced motion, and Problematic Files mouse/keyboard states; require a clean console.
- [ ] **Step 7: Review scope.** Run `git diff --check`, `git status --short`, and targeted diffs. Require only planned files plus preserved unrelated `.superpowers/`, matching generated bundle, and unchanged `.track-problem-link` behavior.
- [ ] **Step 8: Commit.** Stage bundle/E2E changes and commit `test: verify shared loose tracks components`.
