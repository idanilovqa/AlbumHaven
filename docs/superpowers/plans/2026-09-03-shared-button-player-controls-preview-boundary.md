# Shared Button, Player Controls, and Preview Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Center reusable footer buttons, restore component-owned player chevrons, and confine unsaved Appearance colors to previews.

**Architecture:** A shared Button contract has JavaScript and Jinja renderers over one CSS primitive. Expanded and compact player shells each own their mode action. Appearance sync functions apply draft tokens only to their designated preview nodes.

**Tech Stack:** Current-web JavaScript, Jinja templates, CSS, Node test runner, generated runtime bundle.

## Global Constraints

- Preserve native button semantics, accessible names, disabled state, and keyboard activation.
- Preserve playback, dragging, queue, waveform, loop, and album-detail behavior.
- Do not apply unsaved theme tokens outside designated preview components.
- Migrate only the Appearance footer and player mode controls in this slice.

---

### Task 1: Add the shared Button primitive and migrate EditorFooter

**Files:**
- Create: `music_app/static/js/button-component.js`
- Create: `music_app/static/css/button-component.css`
- Create: `music_app/templates/partials/button.html`
- Modify: `music_app/templates/partials/appearance-bootstrap.html`
- Modify: `music_app/static/js/editor-page.js`
- Create: `tests/js/runtime/button-component.test.js`

**Interfaces:**
- Produces: `ButtonComponent.renderButton(options): string`, Jinja `ui_button(...)`, `.ui-button` variants.

- [ ] Add failing source and renderer tests for escaping, variants, action attributes, and centered layout.
- [ ] Run `node --test --test-concurrency=1 tests/js/runtime/button-component.test.js` and confirm failure.
- [ ] Implement the JavaScript renderer, Jinja macro, shared CSS, asset loading, and EditorFooter migration.
- [ ] Rerun the focused test and confirm it passes.

### Task 2: Restore component-owned player mode controls

**Files:**
- Modify: `music_app/templates/index.html`
- Modify: `music_app/static/js/runtime/compact-player-controller.js`
- Modify: `music_app/static/css/runtime/non-album-and-player.css`
- Modify: `tests/js/runtime/compact-player-helpers.test.js`

**Interfaces:**
- Consumes: Jinja `ui_button` with `data-ui-button-action`.
- Produces: `player-collapse` inside `.player-shell`, `player-expand` inside `.compact-player-shell`.

- [ ] Add failing ownership and placement assertions; remove expectations for `.player-mode-toggle`.
- [ ] Run the compact-player focused test and confirm failure.
- [ ] Move controls into their shells, bind both controller actions, and restore the floating top-left circular placement.
- [ ] Rerun the focused test and confirm it passes.

### Task 3: Confine Appearance draft tokens to previews

**Files:**
- Modify: `music_app/static/js/appearance-backgrounds.js`
- Modify: `tests/js/runtime/appearance-workspace.test.js`

**Interfaces:**
- Consumes: `applyDraftEditorTheme(draft, previewHost)`.
- Produces: exactly three preview-scoped draft-token calls and no editor/footer draft-token calls.

- [ ] Add a failing contract test for the three preview hosts and stable footer/editor chrome.
- [ ] Run the Appearance workspace test and confirm failure.
- [ ] Move draft-token application to `.background-preview`, `.player-live-preview`, and `.selection-hover-preview`; move draft accent variables to the Selection preview.
- [ ] Rerun the focused test and confirm it passes.

### Task 4: Registry, bundle, and aggregate verification

**Files:**
- Modify: `C:/Repositories/album-haven-internal/docs/ui-component-system.md`
- Create: `C:/Repositories/album-haven-internal/docs/design-mockups/components/shared-button/v001/component-record.md`
- Regenerate: `music_app/static/js/runtime-bundle.js`

**Interfaces:**
- Produces: registered current-web Button extension and browser bundle parity.

- [ ] Record the approved component, variants, consumers, accessibility, client support, and verification contract.
- [ ] Run `npm run build:runtime`.
- [ ] Run the Button, compact-player, bundle, Appearance, palette, selection, and navigation JavaScript tests in one serial Node process.
- [ ] Run `git diff --check` for all changed files.
