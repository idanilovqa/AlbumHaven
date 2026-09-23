# Overlay-Detached Sidebar Player Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detach sidebar-integrated compact-player variants above every active background dimmer while preserving their live controls and restoring their exact sidebar presentation afterward.

**Architecture:** Reuse `body.modal-open` as the single overlay signal. A pure helper decides whether the current effective presentation is sidebar-integrated; the controller mirrors that decision to one class on the existing player node, and CSS applies the approved detached geometry without changing playback ownership or DOM placement.

**Tech Stack:** Plain JavaScript runtime modules, generated runtime bundle, CSS, node:test, Playwright component tests.

## Global Constraints

- Reuse the existing player DOM and playback handlers.
- Do not add modal-specific player hooks or duplicate controls.
- Always-floating, expanded, and normal non-overlay layouts remain unchanged.
- `body.modal-open` is the shared dimming-overlay authority.
- Run focused tests only and one test process at a time.

---

### Task 1: Detachment state contract

**Files:**
- Modify: `tests/js/runtime/compact-player-helpers.test.js`
- Modify: `music_app/static/js/runtime/compact-player-helpers.js`

**Interfaces:**
- Produces: `shouldDetachCompactPlayerForOverlay({ presentation, overlayActive }): boolean`.

- [ ] Add a failing table-driven unit test proving only `docked`, `rail_play`, and `rail_artbox` detach while an overlay is active.
- [ ] Run the exact helper test and confirm the new assertion fails because the helper is absent.
- [ ] Add the minimal pure helper and export it through the existing CommonJS test seam.
- [ ] Rerun the exact helper test and confirm it passes.

### Task 2: Live shared-overlay synchronization

**Files:**
- Modify: `tests/components/sidebarPlayer.spec.js`
- Modify: `music_app/static/js/runtime/compact-player-controller.js`

**Interfaces:**
- Consumes: `shouldDetachCompactPlayerForOverlay` and `body.modal-open`.
- Produces: `.global-player.is-overlay-detached` on the unchanged player node.

- [ ] Add a failing component test that records the player node, toggles `body.modal-open`, and expects the class to appear for each sidebar-integrated presentation and disappear on close.
- [ ] Confirm the component test fails on the missing class.
- [ ] Synchronize the class inside compact-presentation updates and install one body-class `MutationObserver` during compact-player initialization.
- [ ] Confirm the component test passes and the player node identity and active controls are preserved.

### Task 3: Detached visual geometry and interaction

**Files:**
- Modify: `tests/components/sidebarPlayer.spec.js`
- Modify: `music_app/static/css/runtime/non-album-and-player.css`

**Interfaces:**
- Consumes: `.is-overlay-detached` plus the existing `data-compact-presentation` value.
- Produces: rounded stay-docked surface, square play-only surface, and bounded upward artwork reveal.

- [ ] Add failing component geometry assertions for rounded detached docking, modal z-order, clickable play/artwork, approximately square play-only layout, and artwork contained by the expanded light surface.
- [ ] Confirm those assertions fail against current CSS.
- [ ] Add the minimum selectors reusing existing player surface and motion tokens.
- [ ] Rerun the focused component cases and confirm they pass.

### Task 4: Runtime artifact and focused verification

**Files:**
- Regenerate: `music_app/static/js/runtime-bundle.js`

- [ ] Run `node scripts/build-runtime-bundle.cjs`.
- [ ] Run the compact-player helper tests sequentially.
- [ ] Run the sidebar-player component suite sequentially.
- [ ] Run `git diff --check` on the touched files and confirm port 5001 serves the rebuilt artifacts.

