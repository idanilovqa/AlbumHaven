# Saved Loop Player Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Componentize the existing compound Play/loop control without changing its approved appearance, and let Saved Loops use the real combined-audio waveform with exact centerline alignment and semantic delete styling.

**Architecture:** Preserve PlaybackControlCluster's public API and DOM hooks, extract only its internal glyph/pod markup, and reuse the existing waveform-peaks endpoint/cache plus canvas renderer for saved-loop playback. Regular seekbar mode remains a fallback and user-selectable mode.

**Tech Stack:** Browser JavaScript, Canvas 2D, CSS, Node test runner, generated runtime bundle.

## Global Constraints

- Follow the index constraints in `2026-09-06-shared-ui-convergence-index.md`.
- Preserve the 48px play button, its current visual design, and the scissors mini-button relationship.
- Resting pod: oval, behind and bottom-aligned with the play circle; move its left cap under the play circle so the oval start is invisible.
- Scissors stay at one coordinate in resting and expanded states, are dim at rest, and brighten/glow only on direct scissors hover.
- Expanded pod grows right only; close x sits close to scissors, is gray at rest and red on hover, and has no round glow.
- Saved-loop heading contains only the user-assigned loop name. Keep the current timestamp at the top-right of the player row.
- Play glyph center, waveform center, repeat center, and speed center share one horizontal centerline.
- The waveform is a mirrored ribbon derived from real combined stereo PCM peaks; played left side is brighter and unplayed right side dimmer.

### Task 1: Lock PlaybackControlCluster's compound-button contract

**Files:**
- Modify: `music_app/static/js/runtime/playback-control-cluster.js`
- Modify: `music_app/static/css/runtime/non-album-and-player.css`
- Modify: `C:/Repositories/album-haven-internal/docs/ui-component-system.md`
- Modify: `C:/Repositories/album-haven-internal/docs/permissions-and-capabilities.md`
- Modify: `C:/Repositories/album-haven-internal/docs/functional-test-cases/practice-center.md`
- Modify: `C:/Repositories/album-haven-internal/docs/functional-test-cases/bottom-player-and-playback.md`
- Test: `tests/js/runtime/playback-control-cluster.test.js`
- Test: `tests/js/runtime/loop-range-controls.test.js`

**Interfaces:**
- Public `renderPlaybackControlCluster({ variant, ownerId='', loopId='' })` remains unchanged.
- Internal `renderPlaybackGlyph(state)` uses ButtonComponent SVGs.
- Existing data hooks for play, loop-start/scissors, loop-cancel, and loop state remain unchanged.

- [ ] Add failing markup-contract tests for unchanged public hooks/classes, shared SVG Play/Pause glyphs, fixed scissors order, close-x presence only in expanded state, and no wrapper button around the x.
- [ ] Add CSS-contract assertions for 48px play size, pod bottom alignment, covered left cap, fixed scissors coordinate, right-only expansion, dim/bright scissors states, gray/red x states, and no x glow.
- [ ] Run both focused tests; expect the new component assertions to fail while legacy behavior passes.
- [ ] Replace only icon markup with shared SVG output and keep the existing cluster boundary.
- [ ] Adjust pod geometry and direct-child hover selectors to the approved values; do not alter the play-circle design or playback animations.
- [ ] Update the PlaybackControlCluster registry entry, record the unchanged playback/loop capabilities, and extend the owning player/practice functional cases with the approved geometry and proposed focused/post-acceptance E2E coverage.
- [ ] Repeat the focused tests and require zero failures.
- [ ] Commit as `refactor: stabilize compound playback controls`.

### Task 2: Render Saved Loop title and centerline layout

**Files:**
- Modify: `music_app/static/js/runtime/utility-list-builders.js`
- Modify: `music_app/static/css/runtime/non-album-and-player.css`
- Test: `tests/js/runtime/utility-list-builders.test.js`
- Test: `tests/js/runtime/playback-control-cluster.test.js`

- [ ] Add failing tests that a Saved Loop heading contains only its escaped user name, while current/duration timestamps remain in the existing player row location.
- [ ] Add layout-contract assertions that play glyph, seek surface, repeat, and speed each use the same `--saved-loop-control-centerline` and no transform applies a second vertical offset.
- [ ] Run both focused tests; expect failures for current heading metadata and inconsistent alignment rules.
- [ ] Remove track title/timestamp metadata from the loop heading and keep timestamp rendering in its current control-row owner.
- [ ] Establish one CSS grid row and one centerline variable; align the four control centers without changing the approved horizontal order.
- [ ] Repeat the focused tests and require zero failures.
- [ ] Commit as `fix: align saved loop player controls`.

### Task 3: Reuse real waveform peaks for Saved Loop playback

**Files:**
- Modify: `music_app/static/js/runtime/utility-loop-playback.js`
- Modify: `music_app/static/js/runtime/player-waveform-peaks.js`
- Modify: `music_app/static/css/runtime/non-album-and-player.css`
- Test: `tests/js/runtime/utility-loop-playback.test.js`
- Test: `tests/js/runtime/player-waveform-peaks.test.js`
- Test: `tests/js/runtime/appearance-waveform-integration.test.js`

**Interfaces:**
- `resolveSavedLoopSeekbarMode(root=document.documentElement)` returns `'default'` or `'waveform'` from the existing player seekbar preference.
- `ensureSavedLoopWaveform(loopId, audio)` returns cached validated combined peaks or `null`.
- `drawCombinedLoopWaveform(canvas, peaks, progress)` draws symmetric positive/negative amplitude around the centerline and clips the played/unplayed palettes at progress.

- [ ] Add failing tests for mode selection, endpoint/cache reuse, stereo combination, symmetric amplitude, progress clipping, resize redraw, seek mapping, load failure, and regular-range fallback.
- [ ] Assert the waveform data follows actual peak values and is not a decorative/generated pattern.
- [ ] Run the three focused tests; expect failure because the canvas currently belongs only to active loop editing.
- [ ] Generalize the existing peak loader/cache for non-editing saved-loop playback; do not duplicate fetches or introduce a new endpoint.
- [ ] Keep the waveform canvas visible in waveform mode, update it on timeupdate/seek/resize, and keep loop-selection overlays conditional on edit mode.
- [ ] Draw a mirrored ribbon around zero with brighter played tokens to the left of the handle and dimmer unplayed tokens to the right.
- [ ] On unavailable/invalid peaks, show the regular range input and issue one warning ToastAlert per failed load.
- [ ] Repeat the focused tests and require zero failures.
- [ ] Commit as `feat: add real waveform to saved loops`.

### Task 4: Make Saved Loop delete a semantic round action

**Files:**
- Modify: `music_app/static/js/runtime/utility-list-builders.js`
- Modify: `music_app/static/css/runtime/non-album-and-player.css`
- Modify: `music_app/static/css/appearance-backgrounds.css`
- Test: `tests/js/runtime/utility-list-builders.test.js`
- Test: `tests/components/buttonInteractionOutline.spec.js`

- [ ] Add failing assertions that delete uses a shared destructive RoundActionButton with a centered delete SVG and retains its current delete data hook and accessible label.
- [ ] Add visual-style assertions that its top focus/hover edge is fully visible and same-family red styling overrides the global green/mint interaction outline.
- [ ] Run the focused runtime and component tests; expect the delete component/style assertions to fail.
- [ ] Render delete through ButtonComponent and reserve enough top inset/overflow space for its border and focus ring.
- [ ] Replace selector-specific green overrides with the shared destructive semantic tokens.
- [ ] Repeat the focused tests and require zero failures.
- [ ] Commit as `fix: use semantic saved loop delete action`.

### Task 5: Slice verification and acceptance

- [ ] Run all five affected Node runtime tests together with `--test-concurrency=1`.
- [ ] Run `npm run test:component` after confirming no owned Playwright wave is active.
- [ ] Regenerate the runtime bundle and run `tests/js/runtime/app-loader-bundle.test.js`.
- [ ] Run `git diff --check` and verify the Play/loop DOM hooks and interaction state machine remain compatible.
- [ ] Give the owner a manual script covering resting/hover/expanded/cancel loop pod, Play/Pause, waveform seek/progress/resize, regular seekbar selection, failed-waveform fallback, repeat, speed, timestamp placement, and delete hover/focus clipping.
- [ ] Wait for owner acceptance before changing `tests/e2e/specs/loops.functional.spec.js`; after acceptance, add exact functional cases and run one owned E2E wave.
