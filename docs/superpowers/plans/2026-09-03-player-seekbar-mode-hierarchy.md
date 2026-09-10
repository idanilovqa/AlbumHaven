# Player & Seekbar Mode Hierarchy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep player-wide appearance controls available in both seekbar modes while removing unavailable waveform controls from the Default seekbar editor.

**Architecture:** The Utilities detail becomes a host for the shared Appearance editor. `seekbarMarkup(seekbarMode)` owns the logical page hierarchy and conditionally emits waveform-only navigation, fields, recovery, and preview markup. The existing browser preference handler remains the authority for immediate Default/Waveform mode changes and remounts the editor with the current mode.

**Tech Stack:** Current-web JavaScript, Jinja-rendered application shell, CSS, generated runtime bundle, Node test runner.

## Global Constraints

- Preserve the real player's existing `loopActive || seekbarMode === 'waveform'` rendering rule.
- Preserve saved and draft waveform, edge, and handle values while their controls are unavailable.
- Keep Player themes, Recent sets, Surface, Controls, and Compact player available in both modes.
- Use actual omitted/hidden DOM state so unavailable waveform controls cannot receive focus or dispatch edits.
- Keep the shared Appearance draft and footer behavior unchanged.

---

### Task 1: Encode the mode-specific editor contract

**Files:**
- Modify: `tests/js/runtime/appearance-v009-player-isolation.test.js`
- Modify: `tests/js/runtime/appearance-waveform-recents.test.js`

**Interfaces:**
- Consumes: `AlbumHavenAppearance.seekbarMarkup(seekbarMode)`.
- Produces: regression coverage for Default and Waveform editor markup and loop rendering isolation.

- [x] Add a test that calls `seekbarMarkup('default')` and asserts Player themes, Recent sets, Surface, Controls, Seekbar style, and Compact player remain, while waveform tabs, fields, recovery, handles, and stereo preview are absent and a plain seekbar is present.
- [x] Add a test that calls `seekbarMarkup('waveform')` and asserts Waveform and Edges & handles navigation, waveform fields, recovery, and stereo preview are present.
- [x] Extend the mount test so `mountSeekbar` consumes `getSeekbarMode()` and remounts Default and Waveform markup without changing the aggregate Appearance draft.
- [x] Preserve the assertion that `player-and-waveform.js` uses `state.player.loopActive || state.player.appearance.seekbarMode === 'waveform'`.
- [x] Run `node --test --test-concurrency=1 tests/js/runtime/appearance-v009-player-isolation.test.js tests/js/runtime/appearance-waveform-recents.test.js` and confirm the new tests fail before implementation.

### Task 2: Rebuild the Player & Seekbar hierarchy

**Files:**
- Modify: `music_app/static/js/appearance-backgrounds.js`
- Modify: `music_app/static/js/runtime/utility-list-builders.js`
- Modify: `music_app/static/js/runtime/appearance-backgrounds-bridge.js`
- Modify: `music_app/static/css/appearance-backgrounds.css`

**Interfaces:**
- Produces: `seekbarMarkup(seekbarMode = 'default'): string`.
- Consumes: `mountSeekbar(host, { getLegacyColors, getSeekbarMode })`.

- [x] Change `buildUtilityAppearanceDetail()` to render only the Appearance editor host; remove its separate Seekbar heading, radio group, and explanatory copy.
- [x] Pass `getSeekbarMode: () => state.player.appearance?.seekbarMode || 'default'` from `mountSeekbarAppearanceEditor`.
- [x] Change `mountSeekbar` to render `seekbarMarkup(options.getSeekbarMode?.() || 'default')`.
- [x] Move the native Default seekbar/Waveform seekbar radio group into `seekbarMarkup` after the always-available Surface and Controls area.
- [x] Emit a plain seekbar preview in Default mode and the existing stereo waveform preview in Waveform mode.
- [x] Emit Waveform, Edges & handles, recent colors, recovery, and handle fields only in Waveform mode.
- [x] Keep complete Player themes and Recent sets unchanged so their hidden waveform values remain in the aggregate draft.
- [x] Add layout styles for the Seekbar style and conditional waveform sections without changing saved-theme/footer boundaries.
- [x] Rerun the two focused tests and confirm they pass.

### Task 3: Bundle and focused regression verification

**Files:**
- Regenerate: `music_app/static/js/runtime-bundle.js`
- Update: `docs/superpowers/plans/2026-09-03-player-seekbar-mode-hierarchy.md`

**Interfaces:**
- Produces: browser bundle parity with the source modules.

- [x] Run `npm run build:runtime`.
- [x] Run one serial Node command covering Appearance workspace, waveform recents, player isolation, waveform integration, utility navigation, player rendering, and bundle loading.
- [x] Run the focused Jinja/template test to ensure the application shell still renders.
- [x] Run `git diff --check` on this slice's files.
- [x] Mark every plan checkbox complete and report the exact manual test path.
