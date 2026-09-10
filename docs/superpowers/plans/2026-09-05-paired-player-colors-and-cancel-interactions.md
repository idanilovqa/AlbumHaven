# Paired Player Colors and Cancel Interactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep play/control and waveform colors in coordinated pairs and make the shared Cancel Button expose complete interaction feedback.

**Architecture:** Add a pure color-pair helper beside the Appearance controller and invoke it only for direct field edits. Extend the shared Button CSS and renderer with a reusable quiet modifier, then verify the component independently from page-wide Appearance rules.

**Tech Stack:** Browser JavaScript, CSS custom properties, Node test runner, Playwright component tests.

## Global Constraints

- Preserve the edited `#RRGGBB` value exactly and return uppercase derived colors.
- Do not rewrite complete permanent themes or restored recent sets.
- Keep custom interaction outlines fixed; player-linked outlines follow the effective control border.
- Hosted and self-hosted desktop and narrow web are required; Tauri is optional; Android, TV, and Apple are unsupported.
- Do not change persistence, permissions, capabilities, or playback authority.

---

### Task 1: Pair direct player and waveform color edits

**Files:**
- Modify: `music_app/static/js/appearance-backgrounds.js`
- Test: `tests/js/runtime/appearance-waveform-recents.test.js`
- Test: `tests/js/runtime/appearance-palettes.test.js`

**Interfaces:**
- Produces: `derivePairedPlayerColor(sourceRole, color) -> { role, color }`.
- Consumes: `normalizeColor`, `setPlayerStylePath`, and `controller.setWaveformColor`.

- [x] **Step 1: Add failing tests**

Assert that each Classic green reference color maps to its paired reference,
that all four edit directions retain the selected field exactly, that waveform
edge edits also update an untouched matching handle, and that a separately
edited handle stays independent. Assert theme and recent-set restoration remain
atomic.

- [x] **Step 2: Run the focused tests and verify RED**

```powershell
& 'C:\Program Files\nodejs\node.exe' --test --test-concurrency=1 tests/js/runtime/appearance-waveform-recents.test.js tests/js/runtime/appearance-palettes.test.js
```

Expected: the new pairing assertions fail because direct edits update one field.

- [x] **Step 3: Implement the pure pair conversion and direct-edit wiring**

Add these reference pairs:

```javascript
const playerColorPairs = Object.freeze({
  'controls.fill': Object.freeze({ role: 'waveform.fill', source: '#24B86B', target: '#387F68' }),
  'waveform.fill': Object.freeze({ role: 'controls.fill', source: '#387F68', target: '#24B86B' }),
  'controls.border': Object.freeze({ role: 'waveform.edge', source: '#86EFAC', target: '#AFD8C2' }),
  'waveform.edge': Object.freeze({ role: 'controls.border', source: '#AFD8C2', target: '#86EFAC' }),
});
```

Implement `hexToHsl`, `hslToHex`, and `derivePairedPlayerColor`. Calculate the
target hue by adding the reference hue difference, multiply saturation by the
reference saturation ratio, and add the reference lightness difference. Wrap
hue to `0..360`; clamp saturation and lightness to `0..1`. A zero-saturation
input stays achromatic. Normalize the result to uppercase hex.

Change `setPlayerStylePath` so direct edits to a paired path also write the
derived path before calling `controller.setPlayerStyle(style)`. Change
`setWaveformColor` to pair `waveform.fill` and `waveform.edge`; when edge changes,
set `handles.color` to the new edge only if it equaled the previous edge. Do not
call the helper from `setPlayerStyle` or `restorePlayerSet`.

- [x] **Step 4: Run the focused tests and verify GREEN**

Run the Step 2 command. Expected: all selected tests pass.

---

### Task 2: Give Button and quiet Cancel self-contained interactions

**Files:**
- Modify: `music_app/static/js/button-component.js`
- Modify: `music_app/static/js/editor-page.js`
- Modify: `music_app/static/css/button-component.css`
- Test: `tests/js/runtime/button-component.test.js`
- Test: `tests/components/buttonInteractionOutline.spec.js`

**Interfaces:**
- `renderButton({ quiet?: boolean })` adds `ui-button--quiet`.
- `.ui-button` consumes `--appearance-interaction-outline`, hover-background,
  pressed-background, and existing surface tokens.

- [x] **Step 1: Add failing unit and component assertions**

Require the generic Button CSS to own hover border/outline, active feedback,
keyboard-focus outline, and disabled exclusions. Load only base and Button CSS
in the component fixture. Assert Cancel renders `ui-button--quiet`, retains its
base background on hover/active apart from a faint translucent tint, and uses
the semantic outline color.

- [x] **Step 2: Run unit tests and verify RED**

```powershell
& 'C:\Program Files\nodejs\node.exe' --test --test-concurrency=1 tests/js/runtime/button-component.test.js
```

Expected: assertions fail because `.ui-button` owns layout only and the renderer
does not expose the quiet modifier.

- [x] **Step 3: Implement shared interactions**

In `renderButtonMarkup`, append `ui-button--quiet` when `options.quiet === true`.
Render the EditorFooter secondary Cancel action with `quiet: true`.

Add these component-owned states, retaining the existing ActionButton rules:

```css
.ui-button {
  outline: 2px solid transparent;
  outline-offset: 2px;
  transition: background 150ms ease, border-color 150ms ease,
    color 150ms ease, outline-color 150ms ease;
}
.ui-button:hover:not(:disabled):not([aria-disabled='true']) {
  border-color: var(--appearance-interaction-outline, var(--appearance-accent, #72baff));
  outline-color: var(--appearance-interaction-outline, var(--appearance-accent, #72baff));
  background: var(--appearance-item-action-hover-background, var(--appearance-hover, #293a50));
}
.ui-button:active:not(:disabled):not([aria-disabled='true']) {
  background: var(--appearance-item-action-pressed,
    var(--appearance-item-action-hover-background, var(--appearance-hover, #293a50)));
}
.ui-button:focus-visible {
  outline-color: var(--appearance-interaction-outline, var(--appearance-accent, #72baff));
}
.ui-button--quiet:hover:not(:disabled):not([aria-disabled='true']) {
  background: color-mix(in srgb, currentColor 6%, transparent);
}
.ui-button--quiet:active:not(:disabled):not([aria-disabled='true']) {
  background: color-mix(in srgb, currentColor 10%, transparent);
}
```

- [x] **Step 4: Run unit tests and verify GREEN**

Run the Step 2 command. Expected: all Button unit tests pass.

- [x] **Step 5: Run the focused component test**

```powershell
& 'C:\Program Files\nodejs\node.exe' scripts/run-playwright-component.cjs test tests/components/buttonInteractionOutline.spec.js --workers=1
```

Expected: Cancel and enabled shared Buttons show the configured outline; disabled
and player-excluded controls remain inert.

---

### Task 3: Focused verification

**Files:**
- Verify only; no planned source edits.

**Interfaces:**
- Consumes both completed slices.
- Produces fresh focused test evidence and a manual test script.

- [x] **Step 1: Run focused JavaScript verification**

```powershell
& 'C:\Program Files\nodejs\node.exe' --test --test-concurrency=1 tests/js/runtime/appearance-waveform-recents.test.js tests/js/runtime/appearance-palettes.test.js tests/js/runtime/appearance-workspace.test.js tests/js/runtime/button-component.test.js
```

- [x] **Step 2: Run `git diff --check` on the changed files**

- [x] **Step 3: Report the exact manual checks**

Edit both sides of each player pair, select **Use player colors**, verify Cancel
hover/press/focus treatment, choose a custom outline, and confirm later player
changes do not replace the custom outline.
