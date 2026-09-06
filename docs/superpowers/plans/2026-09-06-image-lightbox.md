# Image Lightbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make full-size artwork a proper ImageLightbox component whose close and navigation controls use centered shared RoundActionButtons.

**Architecture:** Move lifecycle and keyboard ownership behind one controller while preserving the existing overlay DOM IDs and compatibility functions used by gallery handlers.

**Tech Stack:** Browser JavaScript, Jinja, CSS, Node test runner, Playwright component tests.

## Global Constraints

- Follow the index constraints in `2026-09-06-shared-ui-convergence-index.md`.
- Preserve current image scaling, backdrop, caption, previous/next eligibility, focus restoration, and Escape behavior.
- Keep existing `openImageLightbox` and `closeImageLightbox` callable as compatibility facades.
- Use shared RoundActionButton markup for close, previous, and next; every SVG must be optically centered.

### Task 1: Specify the ImageLightbox controller

**Files:**
- Create: `music_app/static/js/runtime/image-lightbox.js`
- Test: `tests/js/runtime/image-lightbox.test.js`

**Interfaces:**
- `createImageLightboxController({ root, onStep })` returns `{ open({ src, alt, caption, canPrevious, canNext, returnFocus }), close(), step(direction), zoom(delta), resetTransform(), destroy() }`.
- `step(direction)` accepts `-1` or `1` only.
- The controller exposes `loading`, `ready`, and `error` states on the lightbox root and keeps Close available in every state.

- [ ] Write failing tests for open/close state, required source, caption, loading/ready/error transitions, direction validation, previous/next disabled state, zoom bounds, pointer-pan bounds, transform reset between images, Escape, backdrop click, focus trap, focus restoration, and listener cleanup.
- [ ] Run the new test; expect module/API failure.
- [ ] Implement the controller using the existing overlay IDs and native dialog semantics already present in the shell; retain an accessible Close control during loading and image failure.
- [ ] Repeat the focused test and require zero failures.
- [ ] Commit as `refactor: add image lightbox controller`.

### Task 2: Adopt shared round controls and compatibility facades

**Files:**
- Modify: `music_app/templates/partials/overlay-shells.html`
- Modify: `music_app/static/js/runtime/track-modal-lightbox-helpers.js`
- Modify: `music_app/static/js/runtime/modal-and-overlay-helpers.js`
- Modify: `music_app/static/js/runtime/bootstrap-gallery-event-handlers.js`
- Modify: `music_app/static/css/runtime/track-modal-and-lightbox.css`
- Modify: `C:/Repositories/album-haven-internal/docs/ui-component-system.md`
- Modify: `C:/Repositories/album-haven-internal/docs/permissions-and-capabilities.md`
- Modify: `C:/Repositories/album-haven-internal/docs/functional-test-cases/app-shell-and-shared-components.md`
- Test: `tests/js/runtime/track-modal-lightbox-helpers.test.js`
- Test: `tests/js/lightbox-control-stacking.test.js`

- [ ] Add failing assertions that shell controls use the shared round action macro with close/previous/next SVGs, accessible labels, and unchanged IDs/data hooks.
- [ ] Add failing behavior assertions that compatibility functions delegate to one controller and do not register duplicate listeners.
- [ ] Run both focused tests; expect the new component assertions to fail.
- [ ] Replace raw buttons in the overlay shell with shared macro calls and remove page-local glyph markup.
- [ ] Instantiate one controller from the existing bootstrap path; reduce old helpers to compatibility facades and DOM lookup adapters.
- [ ] Retain only lightbox placement/layering CSS locally; inherit button shape, semantic hover, and icon centering from ButtonComponent.
- [ ] Register ImageLightbox and its RoundActionButton slots in the private component registry.
- [ ] Record the unchanged artwork-view capability in the permission registry, and add the approved lightbox behavior and proposed tests to the shared-shell functional cases.
- [ ] Repeat the focused tests and require zero failures.
- [ ] Commit as `refactor: adopt shared image lightbox controls`.

### Task 3: Slice verification and acceptance

- [ ] Run the two focused runtime suites and relevant button component tests together.
- [ ] Run `npm run test:component` after confirming no owned Playwright wave is active.
- [ ] Regenerate the runtime bundle and run `tests/js/runtime/app-loader-bundle.test.js`.
- [ ] Run `git diff --check` and verify the overlay's z-index and stacking contexts did not change except where needed to host shared controls.
- [ ] Give the owner a manual script for mouse/keyboard open, previous/next, disabled ends, Escape, backdrop close, narrow viewport, and focus return.
- [ ] Wait for owner acceptance before altering functional E2E coverage.
