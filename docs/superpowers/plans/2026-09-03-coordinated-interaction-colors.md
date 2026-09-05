# Coordinated Interaction Colors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace repeated interaction swatches with seven coordinated role-specific families and apply Item states to shared actionable controls.

**Architecture:** Keep the closed Postgres payload and six existing interaction keys. Add one browser-owned `interactionColorFamilies` catalog, derive each row's swatches from its role, and map the stored button keys to Item labels and semantic CSS behavior. Existing NavigationTree and Player token boundaries remain isolated.

**Tech Stack:** Browser JavaScript, CSS custom properties, Node test runner.

## Global Constraints

- Keep existing persistence keys and API shape; no migration or backend change.
- Show Navigation hover, Navigation selected, Item hover background, Item hover border, Item pressed, and Keyboard focus.
- Keep seven aligned Blue, Steel, Green, Olive, Plum, Clay, and Neutral families with the exact approved colors.
- Item states cover buttons, checkboxes, radio buttons, and opted-in custom action controls.
- Disabled controls do not receive pointer states.
- NavigationTree and Player controls retain their dedicated color tokens.
- `Use theme default` clears one override.
- Web desktop and narrow web are required; Tauri is optional; Android, TV, and Apple are unsupported.

---

### Task 1: Freeze the coordinated family catalog and editor labels

**Files:**
- Modify: `tests/js/runtime/appearance-workspace.test.js`
- Modify: `music_app/static/js/appearance-backgrounds.js`

**Interfaces:**
- Produces: `interactionColorFamilies: Array<{id:string,label:string,colors:Record<string,string>}>`
- Preserves: `interaction_overrides` keys `item_hover`, `item_selected`, `button_hover_background`, `button_hover_border`, `button_pressed`, `focus`.

- [x] Add a failing test that asserts all seven exact family records, the six revised labels, role-specific swatches, and `Use theme default`.
- [x] Run `node --test --test-concurrency=1 tests/js/runtime/appearance-workspace.test.js` and confirm the catalog/label assertions fail.
- [x] Implement and export `interactionColorFamilies`; render each interaction row from its role-specific colors.
- [x] Rerun the focused test and confirm it passes.

### Task 2: Apply Item states to actionable controls without crossing token boundaries

**Files:**
- Modify: `tests/js/runtime/appearance-workspace.test.js`
- Modify: `music_app/static/css/appearance-backgrounds.css`

**Interfaces:**
- Consumes: existing CSS variables `--appearance-button-hover-background`, `--appearance-button-hover-border`, `--appearance-button-pressed`, and `--appearance-focus`.
- Produces: shared pointer/focus rules for application buttons, `.button`, native checkbox/radio controls, and `[data-actionable]`/non-navigation `[role='button']` controls.

- [x] Add a failing CSS-contract test for Item hover background/border, pressed, checkbox/radio `accent-color`, focus, disabled exclusion, and Player/Navigation exclusions.
- [x] Run the focused test and confirm the missing actionable selectors fail.
- [x] Add scoped selectors using semantic item variables while preserving NavigationTree hover/selected rules and Player-specific rules.
- [x] Rerun the focused test and confirm it passes.

### Task 3: Verify the aggregate Appearance workflow

**Files:**
- Modify: `docs/superpowers/plans/2026-09-03-coordinated-interaction-colors.md`

**Interfaces:**
- Consumes: the coordinated catalog and CSS action contract from Tasks 1 and 2.
- Produces: verified current-stack Appearance behavior ready for owner manual acceptance.

- [x] Run `node --test --test-concurrency=1 tests/js/runtime/appearance-workspace.test.js tests/js/runtime/appearance-waveform-recents.test.js tests/js/runtime/appearance-palettes.test.js tests/js/runtime/selection-accent.test.js tests/js/runtime/navigation-tree.test.js`.
- [x] Run `git diff --check`.
- [x] Confirm the exact family order, labels, and storage keys match the approved design.
