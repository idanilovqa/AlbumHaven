# Shared Actions and Track Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reusable round action-button and icon primitives, then center the AlbumTrackTable Play/Pause SVG without changing its button, row, or animation behavior.

**Architecture:** Extend the existing ButtonComponent rather than adding page-local controls. Keep AlbumTrackTable's public API and CSS state classes stable; only its glyph markup changes.

**Tech Stack:** Browser JavaScript, Jinja macros, CSS, Node test runner.

## Global Constraints

- Follow the index constraints in `2026-09-06-shared-ui-convergence-index.md`.
- Preserve all existing ActionButton variants and data/ARIA attributes.
- A round action button is a shape option of the shared action component, not a separate style system.
- Do not alter AlbumTrackTable dimensions, transitions, selectors, current-row glow, or click/keyboard behavior.

### Task 1: Add shared SVG icon markup

**Files:**
- Modify: `music_app/static/js/button-component.js`
- Test: `tests/js/runtime/button-component.test.js`

**Interfaces:**
- Produces `renderIconSvg(name, options = {})`, supporting `play`, `pause`, `edit`, `close`, `more`, `delete`, `previous`, and `next`.
- SVG output uses `aria-hidden="true"`, `focusable="false"`, `viewBox="0 0 24 24"`, and `.ui-icon`.

- [ ] Write failing tests for every supported icon, escaped class names, unknown-icon rejection, and non-focusable decorative markup.
- [ ] Run `& 'C:\Program Files\nodejs\node.exe' --test --test-concurrency=1 tests/js/runtime/button-component.test.js`; expect failures because `renderIconSvg` is absent.
- [ ] Implement a fixed icon-path registry and `renderIconSvg`; do not accept caller-supplied raw SVG.
- [ ] Export `renderIconSvg` without changing `renderButton` or `renderActionButton` signatures.
- [ ] Repeat the focused test and require zero failures.
- [ ] Commit the source and test as `refactor: add shared action icons`.

### Task 2: Extend ActionButton with a round shape

**Files:**
- Modify: `music_app/static/js/button-component.js`
- Modify: `music_app/static/css/button-component.css`
- Modify: `music_app/templates/partials/button.html`
- Modify: `C:/Repositories/album-haven-internal/docs/ui-component-system.md`
- Modify: `C:/Repositories/album-haven-internal/docs/permissions-and-capabilities.md`
- Modify: `C:/Repositories/album-haven-internal/docs/functional-test-cases/app-shell-and-shared-components.md`
- Modify: `C:/Repositories/album-haven-internal/docs/functional-test-cases/track-preferences-and-album-details-table.md`
- Test: `tests/js/runtime/button-component.test.js`
- Test: `tests/components/buttonInteractionOutline.spec.js`

**Interfaces:**
- `renderActionButton({ shape: 'default' | 'round', icon, label, ...existingOptions })`.
- `action_button(..., shape='default')` Jinja macro.
- `.action-button--round` uses equal inline/block size and a centered `.ui-icon`.

- [ ] Add failing runtime assertions for `shape: 'round'`, accessible labels, centered icon wrapper, destructive semantics, and unchanged default markup.
- [ ] Add a component assertion that round icons share an exact center point and that destructive hover/focus uses the destructive color family rather than the mint interaction outline.
- [ ] Run the two focused suites; expect the new assertions to fail.
- [ ] Implement the shape option in JavaScript and Jinja and center its SVG with grid placement; preserve focus visibility.
- [ ] Record RoundActionButton as an ActionButton shape in the private component registry, including permitted semantic variants.
- [ ] Record that these controls expose no new action or capability in the private permission registry, and record the approved Button/AlbumTrackTable functional cases plus the proposed focused and post-acceptance E2E coverage in their owning files.
- [ ] Repeat the focused suites and require zero failures.
- [ ] Commit as `refactor: add round action button shape`.

### Task 3: Replace only the AlbumTrackTable glyph

**Files:**
- Modify: `music_app/static/js/runtime/album-track-table.js`
- Test: `tests/js/runtime/album-track-table.test.js`

**Interfaces:**
- `buildAlbumTrackPlayButtonHtml(track = {})` retains its current button classes, label, attributes, and state contract.
- The button child changes from text entities to `ButtonComponent.renderIconSvg(isPlaying ? 'pause' : 'play')`.

- [ ] Add failing assertions that Play and Pause use the shared SVG, contain no text glyph entity, and retain byte-equivalent outer button attributes/classes for idle, current, and playing rows.
- [ ] Assert the existing row animation/current-row/Total Length markup is unchanged.
- [ ] Run `& 'C:\Program Files\nodejs\node.exe' --test --test-concurrency=1 tests/js/runtime/album-track-table.test.js`; expect only the SVG assertions to fail.
- [ ] Replace the glyph expression inside `buildAlbumTrackPlayButtonHtml`; make no CSS changes to AlbumTrackTable.
- [ ] Repeat the focused test and require zero failures.
- [ ] Commit as `fix: center album track playback glyphs`.

### Task 4: Slice verification and manual acceptance

- [ ] Run `git diff --check` and inspect the diff for forbidden AlbumTrackTable CSS/state changes.
- [ ] Run the ButtonComponent and AlbumTrackTable runtime tests together with `--test-concurrency=1`.
- [ ] Run `npm run test:component` after confirming no other owned Playwright wave is active.
- [ ] Regenerate `music_app/static/js/runtime-bundle.js` with `npm run build:runtime` and rerun `tests/js/runtime/app-loader-bundle.test.js`.
- [ ] Give the owner a manual script covering play, pause, keyboard activation, row animation, reduced motion, and destructive round-button focus.
- [ ] Wait for owner acceptance before adding or changing functional E2E coverage.
