# Album Track Play Hover Outline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give only the Album Details per-track Play controls a theme-aware hover outline matching the main player Play color.

**Architecture:** Keep the behavior entirely in `AlbumTrackTable` CSS. Define one component-local hover-color variable from the active player Play token, then apply it through a disabled-safe hover selector; do not change markup, JavaScript, playback state, or shared button styles.

**Tech Stack:** CSS custom properties, Node.js built-in test runner, JavaScript source-contract tests.

## Global Constraints

- Scope the change to `.album-track-table__play` controls.
- Use `--appearance-play` first, with player-accent and AlbumTrackTable accent fallbacks.
- Render a `2px` circular outline outside the existing border without layout movement.
- Do not show the hover outline on disabled controls.
- Preserve existing focus, playing-row, activation-animation, accessible-name, and playback behavior.

---

### Task 1: Add The Scoped Player-Colored Hover Outline

**Files:**
- Modify: `tests/js/runtime/album-track-table.test.js`
- Modify: `music_app/static/css/runtime/album-track-table.css`

**Interfaces:**
- Consumes: Appearance CSS custom properties `--appearance-play`, `--appearance-player-accent`, and the existing `--album-track-accent`.
- Produces: Component-local `--album-track-play-hover` and the `.album-track-table__play:hover:not(:disabled)` visual state.

- [ ] **Step 1: Write the failing CSS contract test**

Append this focused test to `tests/js/runtime/album-track-table.test.js`:

```js
test('per-track Play hover uses the main player Play color without affecting disabled controls', () => {
  const css = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'css', 'runtime', 'album-track-table.css'),
    'utf8',
  );

  assert.match(
    css,
    /--album-track-play-hover:\s*var\(--appearance-play,\s*var\(--appearance-player-accent,\s*var\(--album-track-accent\)\)\)/,
  );
  assert.match(
    css,
    /\.album-track-table__play:hover:not\(:disabled\)\s*\{[^}]*outline:\s*2px solid var\(--album-track-play-hover\)[^}]*outline-offset:\s*2px/s,
  );
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
& 'C:\Program Files\nodejs\node.exe' --test --test-concurrency=1 tests/js/runtime/album-track-table.test.js
```

Expected: FAIL only in `per-track Play hover uses the main player Play color without affecting disabled controls` because `--album-track-play-hover` and the scoped hover rule are absent.

- [ ] **Step 3: Add the minimal component-scoped CSS**

Add the local variable to `.album-track-table`:

```css
--album-track-play-hover: var(--appearance-play, var(--appearance-player-accent, var(--album-track-accent)));
```

Add immediately after the base `.album-track-table__play` rule:

```css
.album-track-table__play:hover:not(:disabled) {
  border-color: var(--album-track-play-hover);
  outline: 2px solid var(--album-track-play-hover);
  outline-offset: 2px;
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
& 'C:\Program Files\nodejs\node.exe' --test --test-concurrency=1 tests/js/runtime/album-track-table.test.js
```

Expected: all AlbumTrackTable tests pass with zero failures.

- [ ] **Step 5: Inspect the exact changed hunks without claiming ownership of surrounding work**

Run:

```powershell
git diff --check -- tests/js/runtime/album-track-table.test.js music_app/static/css/runtime/album-track-table.css
git diff -- tests/js/runtime/album-track-table.test.js music_app/static/css/runtime/album-track-table.css
```

Expected: the focused test, local color variable, and scoped hover rule are present.
Both target files already contain uncommitted Album Details work, so do not
stage or commit either full file as part of this correction; preserve ownership
of the surrounding work for the active feature batch.
