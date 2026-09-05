# Player Centerline Mode Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give waveform and regular expanded-player modes the owner-approved heights, metadata anchors, shared control/timeline centerlines, and revised regular-mode bottom padding.

**Architecture:** `updateWaveformAppearance()` remains the authority for the effective waveform rule, including loop-forced waveform rendering. A small helper publishes that effective mode to the player and document root. CSS uses the published mode to select a 92px waveform layout or 68px regular layout without changing `PlaybackControlCluster`, streaming, queue, seek, or loop ownership.

**Tech Stack:** Current-web JavaScript, CSS, Node test runner, Playwright component tests, Playwright functional E2E after manual acceptance.

## Global Constraints

- Keep the owner-locked AudioWorklet, PCM WebSocket, decoder, seeking, and waveform architecture unchanged.
- Keep waveform mode at 92px with a 56px waveform and a 57px centerline.
- Keep regular mode at 68px with a 39px centerline and 5px below its 48px timeline box.
- Start waveform metadata at the player inner-left edge; keep regular metadata at the seekbar start.
- Use 10px and 11px regular-mode top offsets for metadata and timestamp.
- Keep the timestamp right-aligned in both modes.
- Keep loop editing's existing `loopActive || seekbarMode === 'waveform'` rule.
- Preserve compact docked and floating dimensions and behavior.
- Web desktop is required. Tauri may use the shared web renderer. Narrow web keeps its existing fallback. Android, TV, and Apple remain unsupported for this slice.
- Stop after focused verification and hand the live build to the owner. Add the approved functional E2E only after manual acceptance.
- Preserve unrelated uncommitted work. Stage and commit only each task's named files.

---

### Task 1: Publish the effective expanded-player mode

**Files:**
- Modify: `music_app/static/js/runtime/player-and-waveform.js`
- Modify: `tests/js/runtime/player-and-waveform.test.js`

**Interfaces:**
- Consumes: `isWaveform: boolean` from the existing effective waveform decision.
- Produces: `setPlayerSeekbarPresentation(isWaveform): void`, `.global-player[data-player-seekbar-presentation="waveform|regular"]`, and `html.has-waveform-player`.

- [x] **Step 1: Add a failing mode-publication test**

Add a unit block that supplies a player element, timeline wrapper, canvas, and document root with observable `classList` and attribute doubles. Call `updateWaveformAppearance()` with default seekbar mode and assert:

```js
assert.equal(player.attributes['data-player-seekbar-presentation'], 'regular');
assert.equal(documentRoot.classes.has('has-waveform-player'), false);
assert.equal(wrap.classes.has('is-waveform'), false);
```

Set `state.player.appearance.seekbarMode = 'waveform'`, call the function again, and assert all three waveform markers. Then set the preference to `default`, set `state.player.loopActive = true`, and require waveform markers again.

- [x] **Step 2: Run the Node test and confirm RED**

Run:

```powershell
node --test --test-concurrency=1 tests/js/runtime/player-and-waveform.test.js
```

Expected: FAIL because the player attribute and document-root class do not exist.

- [x] **Step 3: Add the publication helper**

Add this helper beside `updateWaveformAppearance()`:

```js
function setPlayerSeekbarPresentation(isWaveform) {
  const mode = isWaveform ? 'waveform' : 'regular';
  const player = getPlayerElements().player;
  player?.setAttribute('data-player-seekbar-presentation', mode);
  document.documentElement?.classList.toggle('has-waveform-player', isWaveform);
}
```

Call `setPlayerSeekbarPresentation(isWaveform)` immediately after computing `isWaveform` and before toggling the timeline wrapper. Do not create another preference or playback state owner.

- [x] **Step 4: Rerun the Node test and confirm GREEN**

Run the Step 2 command. Expected: all tests pass.

- [x] **Step 5: Commit the mode publication**

```powershell
git add -- music_app/static/js/runtime/player-and-waveform.js tests/js/runtime/player-and-waveform.test.js
git commit -m "feat: publish effective player seekbar mode"
```

---

### Task 2: Implement the approved mode geometry

**Files:**
- Modify: `music_app/static/css/runtime/base-layout.css`
- Modify: `music_app/static/css/runtime/non-album-and-player.css`
- Modify: `tests/js/runtime/player-and-waveform.test.js`

**Interfaces:**
- Consumes: `html.has-waveform-player` and `data-player-seekbar-presentation` from Task 1.
- Produces: exact expanded-player box, text, control, and timeline geometry for both modes.

- [x] **Step 1: Replace the old layout assertions with failing mode-specific contracts**

Require the stylesheet to encode these values:

```js
assert.equal(basePlayerHeight, 68);
assert.match(css, /:root\.has-waveform-player\s*\{[^}]*--player-height:\s*92px/s);
assert.match(css, /--player-waveform-centerline:\s*57px/);
assert.match(css, /--player-regular-centerline:\s*39px/);
assert.match(css, /data-player-seekbar-presentation="regular"[^}]*\.player-meta[^}]*top:\s*10px/s);
assert.match(css, /data-player-seekbar-presentation="regular"[^}]*\.player-time[^}]*top:\s*11px/s);
```

Keep assertions for the 56px canvas/range surface, compact dimensions, and component-owned controls.

- [x] **Step 2: Run the source contract and confirm RED**

Run:

```powershell
node --test --test-concurrency=1 tests/js/runtime/player-and-waveform.test.js tests/js/runtime/playback-control-cluster.test.js tests/js/runtime/compact-player-helpers.test.js
```

Expected: FAIL on the old 92px base height and missing mode selectors.

- [x] **Step 3: Set mode height variables**

Change the base root variable to `--player-height: 68px`. Add the waveform override before the existing compact override:

```css
:root.has-waveform-player { --player-height: 92px; }
:root.has-compact-player { --player-height: 0px; }
```

The later compact rule must continue to win while either compact mode is active.

- [x] **Step 4: Replace the expanded vertical grid with measured positioning**

Keep the existing two columns and component ownership. Introduce these layout variables on `.global-player`:

```css
--player-waveform-centerline: 57px;
--player-regular-centerline: 39px;
--player-controls-size: 48px;
--player-leading-width: 114px;
```

Remove vertical padding from expanded mode while retaining `28px` left and `16px` right padding. Give `.player-shell` and `.player-main` `height: 100%`, make `.player-main` positioned, and place metadata, time, and timeline with mode-scoped absolute offsets.

Waveform selectors must use:

```css
.global-player[data-player-seekbar-presentation="waveform"] .player-controls {
  margin-top: calc(var(--player-waveform-centerline) - (var(--player-controls-size) / 2));
}
.global-player[data-player-seekbar-presentation="waveform"] .player-meta { top: 7px; left: calc(-1 * var(--player-leading-width)); }
.global-player[data-player-seekbar-presentation="waveform"] .player-time { top: 8px; }
.global-player[data-player-seekbar-presentation="waveform"] .player-timeline-wrap { top: 29px; height: 56px; }
```

Regular selectors must use:

```css
.global-player[data-player-seekbar-presentation="regular"] .player-controls {
  margin-top: calc(var(--player-regular-centerline) - (var(--player-controls-size) / 2));
}
.global-player[data-player-seekbar-presentation="regular"] .player-meta { top: 10px; left: 0; }
.global-player[data-player-seekbar-presentation="regular"] .player-time { top: 11px; }
.global-player[data-player-seekbar-presentation="regular"] .player-timeline-wrap { top: 15px; height: 48px; }
```

Set the expanded collapse button to a 48px alignment box with `line-height: 1`; keep its glyph and hit target inside `.player-controls`. The artwork and Play/Pause sizes remain 50px and 48px. Center tests use each rendered box center, so compensate for the artwork's 50px size through its top position rather than shrinking it.

- [x] **Step 5: Rerun the source contract and confirm GREEN**

Run the Step 2 command. Expected: all tests pass.

- [x] **Step 6: Commit the CSS geometry**

```powershell
git add -- music_app/static/css/runtime/base-layout.css music_app/static/css/runtime/non-album-and-player.css tests/js/runtime/player-and-waveform.test.js
git commit -m "feat: align expanded player by seekbar mode"
```

---

### Task 3: Prove both layouts in the component browser

**Files:**
- Modify: `tests/components/playerViews.spec.js`
- Regenerate: `tests/components/playerViews.spec.js-snapshots/expanded-waveform-player-win32.png`
- Create: `tests/components/playerViews.spec.js-snapshots/expanded-regular-player-win32.png`
- Remove: `tests/components/playerViews.spec.js-snapshots/expanded-player-win32.png`

**Interfaces:**
- Consumes: Task 1 mode markers and Task 2 CSS geometry.
- Produces: rendered geometry assertions and stable owner-approved visual baselines.

- [x] **Step 1: Split the old expanded fixture into waveform and regular states**

Make `mountPlayer(page, mode)` emit `data-player-seekbar-presentation="waveform"` plus `html.has-waveform-player` for waveform mode and `data-player-seekbar-presentation="regular"` for regular mode. Remove the fixture's stale `--player-height: 108px` override. Keep animations disabled and real CSS loaded through `page.addStyleTag()`.

- [x] **Step 2: Add failing rendered geometry assertions**

For waveform mode, assert 92px height and compare center Y values for collapse, cover, Play/Pause, waveform, and player-relative `57px`. Assert the metadata left edge matches the player inner-left edge within 1px.

For regular mode, assert 68px height and compare collapse, cover, Play/Pause, timeline, and player-relative `39px`. Assert metadata left equals timeline left within 1px, metadata top equals player top plus 10px, timestamp top equals player top plus 11px, and the timeline bottom leaves 5px inside the player.

Use `getByRole()` for buttons, stable component locators for layout containers, `boundingBox()` for geometry, and `toHaveScreenshot({ animations: 'disabled' })` for each expanded mode.

- [x] **Step 3: Run the component tests and confirm RED**

Run:

```powershell
npx playwright test --config=playwright.component.config.js tests/components/playerViews.spec.js --workers=1
```

Expected: geometry and snapshot assertions fail before the final fixture and CSS adjustments.

- [x] **Step 4: Make the smallest fixture or CSS corrections**

Correct only mismatches against the approved measurements. Do not add screenshot thresholds, masks, waits, retries, or alternate expectations. Keep docked and floating assertions unchanged.

- [x] **Step 5: Generate and verify the two approved expanded snapshots**

Run:

```powershell
npx playwright test --config=playwright.component.config.js tests/components/playerViews.spec.js --workers=1 --update-snapshots
npx playwright test --config=playwright.component.config.js tests/components/playerViews.spec.js --workers=1
```

Expected: waveform, regular, docked, and floating component cases pass with animations disabled.

- [x] **Step 6: Commit the rendered contract**

```powershell
git add -- tests/components/playerViews.spec.js tests/components/playerViews.spec.js-snapshots
git commit -m "test: cover player centerlines by seekbar mode"
```

---

### Task 4: Build, verify, and hand off for manual acceptance

**Files:**
- Regenerate: `music_app/static/js/runtime-bundle.js`
- Modify: `docs/superpowers/plans/2026-09-05-player-centerline-mode-layout.md`
- Modify: `C:/Repositories/album-haven-internal/docs/design-mockups/components/playback-control-cluster/v002/review.json`

**Interfaces:**
- Consumes: completed source and component changes.
- Produces: bundle parity, focused verification evidence, and the manual-test checkpoint.

- [x] **Step 1: Regenerate the runtime bundle**

Run `npm run build:runtime`. Expected: the bundle contains the updated player runtime.

- [x] **Step 2: Run focused JavaScript tests in one serial process**

```powershell
node --test --test-concurrency=1 tests/js/runtime/player-and-waveform.test.js tests/js/runtime/playback-control-cluster.test.js tests/js/runtime/compact-player-helpers.test.js tests/js/runtime/player-loop-playback.test.js tests/js/runtime/app-loader-bundle.test.js
```

Expected: all tests pass.

- [x] **Step 3: Run the component player suite**

```powershell
npx playwright test --config=playwright.component.config.js tests/components/playerViews.spec.js --workers=1
```

Expected: all four player-view component cases pass.

- [x] **Step 4: Check generated parity and whitespace**

Run `git diff --check` on the task files and confirm `tests/js/runtime/app-loader-bundle.test.js` passed in Step 2.

- [ ] **Step 5: Record focused evidence and commit**

Focused evidence is recorded. The generated bundle is current and passes parity, but its index entry already contains unrelated owner-staged generated changes. Keep this step open until those changes can be committed with their owning source work; committing the bundle here would absorb unrelated work into this slice.

Mark Tasks 1 through 4 complete in this plan. Update the private v002 review history with exact commands and counts. Commit only the bundle and plan in the app repository:

```powershell
git add -- music_app/static/js/runtime-bundle.js docs/superpowers/plans/2026-09-05-player-centerline-mode-layout.md
git commit -m "build: verify player centerline layouts"
```

- [x] **Step 6: Stop for owner manual acceptance**

Give the owner this script:

1. Start a track with Default seekbar selected. Confirm the expanded player is 68px high.
2. Confirm chevron, artwork, Play/Pause, seekbar, and thumb share one horizontal centerline.
3. Confirm metadata begins at the seekbar start and both text blocks sit close above it.
4. Select Waveform seekbar. Confirm the player grows to 92px, metadata begins at the player edge, and controls align with the waveform centerline.
5. Return to Default, enter loop editing, and confirm waveform geometry appears without pausing or changing the track.
6. Cancel loop editing, seek, collapse, and expand. Confirm regular geometry returns and playback continues.

Do not start Task 5 until the owner reports a manual pass.

---

### Task 4A: Raise the regular-player group after live review

**Files:**
- Modify: `music_app/static/css/runtime/non-album-and-player.css`
- Modify: `tests/js/runtime/player-and-waveform.test.js`
- Modify: `tests/components/playerViews.spec.js`
- Regenerate: `tests/components/playerViews.spec.js-snapshots/expanded-regular-player-win32.png`

**Interfaces:**
- Consumes: the existing regular-mode presentation marker and 68px player box.
- Produces: a 39px regular centerline, 10px metadata top, 11px timestamp top, 15px timeline top, and 5px bottom padding.

- [ ] **Step 1: Change the source and rendered contracts to the revised measurements**

Update the regular-mode assertions to require `39px`, `10px`, `11px`, `15px`, and a 5px player-bottom gap. Leave all waveform assertions unchanged.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run the source test and one-worker component suite. Expected: regular-mode measurements fail against the former `43px`, `14px`, `15px`, and `19px` values; waveform, docked, and floating cases remain unchanged.

- [ ] **Step 3: Apply the single 4px regular-mode offset**

Change only the regular centerline and its three absolute top offsets:

```css
--player-regular-centerline: 39px;
.global-player[data-player-seekbar-presentation="regular"] .player-meta { top: 10px; left: 0; }
.global-player[data-player-seekbar-presentation="regular"] .player-time { top: 11px; }
.global-player[data-player-seekbar-presentation="regular"] .player-timeline-wrap { top: 15px; height: 48px; }
```

- [ ] **Step 4: Verify GREEN and regenerate only the regular expanded snapshot**

Run the focused source tests, update the regular snapshot, then rerun the full four-case component file without thresholds or masks. Expected: every geometry assertion and snapshot passes.

- [ ] **Step 5: Commit the accepted correction**

Stage only the four Task 4A paths and commit with `fix: add regular player bottom padding`.

---

### Task 5: Add the owner-approved functional E2E after manual acceptance

**Files:**
- Modify: `tests/e2e/poms/globalPlayer.js`
- Modify: `tests/e2e/actions/globalPlayerActions.js`
- Modify: `tests/e2e/specs/playerViewModes.spec.js`
- Modify: `tests/ci/test-data-matrix.json`
- Modify: `C:/Repositories/album-haven-internal/docs/functional-test-cases/bottom-player-and-playback.md`

**Interfaces:**
- Produces: `GlobalPlayer.readExpandedGeometryCheckpoint(): object` and `GlobalPlayerActions.expectExpandedGeometry(mode): object`.
- Consumes: existing visible Appearance actions, existing loop-editor actions, and the `FTC-PLAYER-019 / 020 / 021 / 022` isolated scenario.

- [ ] **Step 1: Add geometry ownership to the POM and action layer**

`readExpandedGeometryCheckpoint()` reads bounding boxes for the player, collapse button, artwork, Play/Pause, metadata, timestamp, timeline, and waveform canvas. `expectExpandedGeometry(mode)` asserts the approved height, relative centerline, and metadata anchor for `regular` or `waveform` and returns the checkpoint. Keep selectors in `GlobalPlayer` and user-visible operations in `GlobalPlayerActions`.

- [ ] **Step 2: Extend the existing player-view scenario**

Before the compact-player steps, use the visible Settings Appearance flow to select Default, close Settings, verify regular geometry and playback identity, select Waveform, verify waveform geometry, return to Default, open loop editing, verify loop-forced waveform geometry, cancel, and verify regular geometry returns. Keep the established compact, drag, persistence, and narrow-web steps unchanged.

- [ ] **Step 3: Update the approved functional contract**

Add `expanded-seekbar-mode-geometry` and `loop-forced-waveform-geometry` to the existing test-data matrix row. Add the approved geometry flow and expectations to FTC-PLAYER-019 without removing or weakening its existing compact-player expectations.

- [ ] **Step 4: Run the focused functional E2E**

Use the repository's managed functional runner for `tests/e2e/specs/playerViewModes.spec.js`, one worker, with the production FastAPI/ASGI application and isolated Postgres profile. Expected: the unchanged playback-continuity assertions and new geometry assertions pass.

- [ ] **Step 5: Run focused source and component regression**

Rerun the Task 4 Node and component commands sequentially. Expected: all tests pass.

- [ ] **Step 6: Commit the accepted functional contract**

Stage only the Task 5 files and commit with `test: cover expanded player mode geometry`.
