# Expanded Player Layout and Playback Control Cluster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace separate player transport and loop-control markup with one reusable `PlaybackControlCluster` family and tighten the expanded player to the owner-approved alignment and spacing.

**Architecture:** A Jinja macro renders expanded and compact instances; a runtime JavaScript renderer creates saved-loop instances. Both renderers emit the same component root, variant marker, action hooks, native buttons, and loop-action ownership structure. Existing playback and loop controllers retain behavior authority and bind through component-owned query hooks. CSS keeps one root as the positioning context for each variant and gives the expanded metadata/waveform composition measurable alignment variables.

**Tech Stack:** Jinja, current-web JavaScript, CSS Grid, Node test runner, generated runtime bundle.

## Global Constraints

- Preserve the owner-locked AudioWorklet, PCM WebSocket, decoder, seeking, and waveform architecture.
- Keep Previous and Next visible only in compact mode.
- Keep the waveform 56px high.
- Align the expanded waveform and Play/Pause centers within 1px.
- Keep 4–6px between metadata and the waveform, about 6px below the lowest child, and 6–8px above the metadata text.
- Start from 108px player height and remove only unused top space after the alignment rules pass.
- Preserve native button semantics, accessible names, disabled behavior, keyboard activation, focus treatment, playback, queue, seek, loop, artwork, compact-mode, and saved-loop behavior.
- Web desktop is required. Tauri uses the web implementation. Native Android, TV, and Apple renderers remain outside this slice.
- Preserve all unrelated uncommitted work. Do not stage or commit overlapping implementation files as part of this run.

---

### Task 1: Record the approved component artifact

**Files:**
- Create: `C:/Repositories/album-haven-internal/docs/design-mockups/components/playback-control-cluster/v001/prompt.md`
- Create: `C:/Repositories/album-haven-internal/docs/design-mockups/components/playback-control-cluster/v001/notes.md`
- Create: `C:/Repositories/album-haven-internal/docs/design-mockups/components/playback-control-cluster/v001/review.json`
- Create: `C:/Repositories/album-haven-internal/docs/design-mockups/components/playback-control-cluster/v001/component-record.md`
- Copy: owner screenshot to `C:/Repositories/album-haven-internal/docs/design-mockups/components/playback-control-cluster/v001/references/current-app-desktop.png`
- Modify: `C:/Repositories/album-haven-internal/docs/ui-component-system.md`

**Interfaces:**
- Consumes: approved spec `docs/superpowers/specs/2026-09-03-expanded-player-layout-and-playback-control-cluster-design.md` and owner screenshot `codex-clipboard-d5427b35-6f27-4c18-8f3d-8431415199f9.png`.
- Produces: approved `current-web-playback-control-cluster-v001` registry record and stored visual reference.

- [ ] **Step 1: Store the screenshot and approval record**

Record `status: approved`, the owner’s spacing and ownership requests, the three variants, client matrix, and the approved spec path. Store the screenshot as the current-app reference.

- [ ] **Step 2: Add the component registry entry**

Append an `Approved current-web PlaybackControlCluster v001 extension` section that names the renderer and macro owners, consumers, variants, accessibility contract, visual reference, client matrix, and adoption state `implementing`.

- [ ] **Step 3: Verify the artifact**

Run:

```powershell
Get-Content -Raw C:\Repositories\album-haven-internal\docs\design-mockups\components\playback-control-cluster\v001\review.json | ConvertFrom-Json | Out-Null
Test-Path C:\Repositories\album-haven-internal\docs\design-mockups\components\playback-control-cluster\v001\references\current-app-desktop.png
```

Expected: JSON parsing succeeds and `Test-Path` returns `True`.

### Task 2: Add the reusable render contract

**Files:**
- Create: `music_app/templates/partials/playback-control-cluster.html`
- Create: `music_app/static/js/runtime/playback-control-cluster.js`
- Create: `tests/js/runtime/playback-control-cluster.test.js`
- Modify: `scripts/build-runtime-bundle.cjs`

**Interfaces:**
- Consumes: `buildLoopEditActionControl(options)` from `loop-range-controls.js` for JavaScript-rendered saved-loop actions.
- Produces: Jinja `playback_control_cluster(variant, owner_id, play_id='', loop_mount=false)`; JavaScript `renderPlaybackControlCluster(options): string`; JavaScript `getPlaybackControlClusterElements(root): object`.

- [ ] **Step 1: Write failing renderer and ownership tests**

Test all three variants. Require one root with `data-playback-control-cluster` and `data-playback-control-variant`. Require expanded children to contain Play/Pause plus one loop-action mount, compact children to contain Previous/Play/Next, and saved-loop children to contain Play/Pause plus rendered loop actions. Reject unknown variants. Prove the macro and JavaScript renderer share class, variant, action, accessible-name, and disabled hooks.

- [ ] **Step 2: Run the new test and confirm RED**

Run:

```powershell
node --test --test-concurrency=1 tests/js/runtime/playback-control-cluster.test.js
```

Expected: FAIL because both component files are absent.

- [ ] **Step 3: Implement the minimal renderers**

The Jinja macro emits expanded and compact markup from structured parameters. The JavaScript renderer validates `expanded-player`, `compact-player`, and `saved-loop`, escapes attributes, and calls `buildLoopEditActionControl` for saved-loop actions. `getPlaybackControlClusterElements` queries Previous, Play/Pause, Next, and loop-action mount from a supplied component root.

- [ ] **Step 4: Add the runtime module before consumers**

Insert `js/runtime/playback-control-cluster.js` after `js/runtime/loop-range-controls.js` and before `js/runtime/utility-list-builders.js` in `RUNTIME_SCRIPT_PATHS`.

- [ ] **Step 5: Rerun the test and confirm GREEN**

Run the same Node command. Expected: all component renderer tests pass.

### Task 3: Migrate expanded, compact, and saved-loop consumers

**Files:**
- Modify: `music_app/templates/index.html`
- Modify: `music_app/static/js/runtime/utility-list-builders.js`
- Modify: `music_app/static/js/runtime/compact-player-controller.js`
- Modify: `tests/js/runtime/playback-control-cluster.test.js`
- Modify: `tests/js/runtime/compact-player-helpers.test.js`
- Modify: `tests/js/runtime/utility-list-builders.test.js`
- Modify: `tests/js/runtime/loop-range-controls.test.js`

**Interfaces:**
- Consumes: Jinja `playback_control_cluster`; JavaScript `renderPlaybackControlCluster`; JavaScript `getPlaybackControlClusterElements`.
- Produces: three live component instances with existing IDs/data hooks preserved for current controllers.

- [ ] **Step 1: Add failing integration assertions**

Require `index.html` to call the macro for `expanded-player` and `compact-player`, with no transport or loop-action children outside those roots. Require saved-loop markup to call `renderPlaybackControlCluster({ variant: 'saved-loop', ... })` instead of interpolating the cluster markup. Require the compact controller to resolve transport elements through `getPlaybackControlClusterElements`.

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

```powershell
node --test --test-concurrency=1 tests/js/runtime/playback-control-cluster.test.js tests/js/runtime/compact-player-helpers.test.js tests/js/runtime/utility-list-builders.test.js tests/js/runtime/loop-range-controls.test.js
```

Expected: component-consumption assertions fail against the separate markup.

- [ ] **Step 3: Replace consumer markup**

Import the Jinja macro in `index.html`. Render expanded and compact variants inside their existing shells. Replace saved-loop cluster interpolation with the JavaScript renderer. Preserve `#player-play`, compact transport data attributes, `data-loop-play`, `data-loop-action-mount`, and `data-loop-action-owner`.

- [ ] **Step 4: Bind compact controls through the component root**

Have `compactPlayerElements()` find the compact component root and call `getPlaybackControlClusterElements`. Keep queue offset, playback toggle, disabled state, cover, mode transition, and drag behavior unchanged.

- [ ] **Step 5: Rerun focused tests and confirm GREEN**

Run the same four-file Node command. Expected: all tests pass.

### Task 4: Tighten and align the expanded player

**Files:**
- Modify: `music_app/static/css/runtime/non-album-and-player.css`
- Modify: `tests/js/runtime/player-and-waveform.test.js`
- Modify: `tests/js/runtime/playback-control-cluster.test.js`

**Interfaces:**
- Consumes: `.playback-control-cluster--expanded`, `.player-meta`, `.player-time`, and `.player-timeline-wrap`.
- Produces: component-owned positioning plus measurable expanded-player spacing variables.

- [ ] **Step 1: Add failing layout contracts**

Require the expanded player to define explicit layout variables for waveform height `56px`, bottom clearance near `6px`, metadata gap from `4px` through `6px`, and top clearance from `6px` through `8px`. Require artwork, expanded component root, and waveform row to share one centerline without separate positive margins. Require compact and saved-loop variants to keep their current dimensions.

- [ ] **Step 2: Run layout tests and confirm RED**

Run:

```powershell
node --test --test-concurrency=1 tests/js/runtime/player-and-waveform.test.js tests/js/runtime/playback-control-cluster.test.js
```

Expected: FAIL against the current translated grid rows.

- [ ] **Step 3: Implement the aligned grid**

Use player-level custom properties for the approved clearances and waveform height. Replace independent negative Y transforms with a two-row metadata/waveform layout. Place artwork and `.playback-control-cluster--expanded` on the waveform row centerline. Keep the time in the metadata row. Keep the waveform, range input, loop surface, and idle backdrop at `56px`.

- [ ] **Step 4: Reduce unused height only when the grid leaves excess top space**

Calculate the fixed player height from top padding, metadata line, metadata gap, waveform height, and bottom padding. Keep `108px` if those values consume the height; otherwise reduce `--player-height` by the unused top excess while retaining the approved ranges.

- [ ] **Step 5: Rerun layout tests and confirm GREEN**

Run the same two-file Node command. Expected: all tests pass.

### Task 5: Build and focused regression verification

**Files:**
- Regenerate: `music_app/static/js/runtime-bundle.js`
- Modify: `C:/Repositories/album-haven-internal/docs/design-mockups/components/playback-control-cluster/v001/component-record.md`
- Modify: `C:/Repositories/album-haven-internal/docs/design-mockups/components/playback-control-cluster/v001/review.json`

**Interfaces:**
- Consumes: all completed component and layout changes.
- Produces: generated bundle parity, focused verification evidence, and manual-test handoff.

- [ ] **Step 1: Regenerate the runtime bundle**

Run:

```powershell
npm run build:runtime
```

Expected: the command writes the bundle and reports the updated module count.

- [ ] **Step 2: Run the focused JavaScript regression set in one serial process**

Run:

```powershell
node --test --test-concurrency=1 tests/js/runtime/playback-control-cluster.test.js tests/js/runtime/compact-player-helpers.test.js tests/js/runtime/utility-list-builders.test.js tests/js/runtime/loop-range-controls.test.js tests/js/runtime/player-and-waveform.test.js tests/js/runtime/player-loop-playback.test.js tests/js/runtime/app-loader-bundle.test.js tests/js/e2e-action-production-paths.test.js
```

Expected: all tests pass.

- [ ] **Step 3: Check formatting and generated parity**

Run:

```powershell
git diff --check -- music_app/templates/index.html music_app/templates/partials/playback-control-cluster.html music_app/static/js/runtime/playback-control-cluster.js music_app/static/js/runtime/utility-list-builders.js music_app/static/js/runtime/compact-player-controller.js music_app/static/css/runtime/non-album-and-player.css scripts/build-runtime-bundle.cjs tests/js/runtime/playback-control-cluster.test.js tests/js/runtime/compact-player-helpers.test.js tests/js/runtime/utility-list-builders.test.js tests/js/runtime/loop-range-controls.test.js tests/js/runtime/player-and-waveform.test.js music_app/static/js/runtime-bundle.js
```

Expected: no whitespace errors.

- [ ] **Step 4: Record evidence and manual checks**

Record the test command and result in the component record. Set implementation status to `implemented_for_manual_review`. Manual checks: expanded Play/Pause and waveform centers, metadata gap, top and bottom clearance, paused/playing state, loop enter/save/cancel, compact Previous/Next, saved-loop Play/Pause and loop actions, and expanded/compact transitions.

Do not run full JavaScript, Python, functional E2E, or performance suites in this focused implementation pass. The branch remains in its larger manual-acceptance workflow.
