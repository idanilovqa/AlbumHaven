# Light-theme Artist Family Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give selected Artist Family cards a solid play-green fill with contrast-safe content in light themes while preserving the existing border-only dark-theme treatment.

**Architecture:** Keep Artist Family structure and behavior unchanged. Extend the existing appearance-mode CSS ownership in `appearance-backgrounds.css` with one light-only selected-card rule and a nested count-badge rule using the existing `--appearance-play` / `--appearance-play-ink` contrast pair; rendered component coverage protects theme and interaction states.

**Tech Stack:** CSS custom properties, Playwright component tests, Node.js CSS contract tests.

## Global Constraints

- Apply the solid fill only to `.artist-family-panel__artist.is-active` under `data-appearance-mode='light'`.
- Use `--appearance-play` and `--appearance-play-ink`; add no hard-coded theme color and no new appearance preference.
- Preserve card dimensions, artwork, text placement, count placement, marker, hover, focus, pressed state, selection behavior, dark themes, related chips, navigation-tree selection, Gallery cards, and persistence.

---

### Task 1: Light-theme selected-card surface

**Files:**
- Modify: `tests/components/appearanceWorkspace.spec.js:143-163`
- Modify: `music_app/static/css/appearance-backgrounds.css:275-302`
- Modify: `tests/js/runtime/appearance-backgrounds.test.js:411-430`

**Interfaces:**
- Consumes: `data-appearance-mode`, `.artist-family-panel__artist.is-active`, `.artist-family-panel__name`, `.artist-family-panel__count`, `--appearance-play`, and `--appearance-play-ink`.
- Produces: a light-mode-only solid selected surface whose hover and focus states retain the play fill; no JavaScript interface changes.

- [ ] **Step 1: Write the failing rendered style contract**

Replace the existing single Artist Family surface test with explicit light and dark cases. The light case must render selected and unselected cards with name and count elements, set distinct card/play/play-ink tokens, and assert:

```js
await expect(unselected).toHaveCSS('background-color', 'rgb(17, 17, 17)');
await expect(selected).toHaveCSS('background-color', 'rgb(75, 193, 115)');
await expect(selected).toHaveCSS('color', 'rgb(8, 56, 32)');
await expect(selectedCount).toHaveCSS('background-color', 'rgb(8, 56, 32)');
await expect(selectedCount).toHaveCSS('color', 'rgb(75, 193, 115)');
```

After `selected.hover()` and `selected.focus()`, assert the selected background remains `rgb(75, 193, 115)`. The dark case must assert the selected card retains the card background and play-green border.

- [ ] **Step 2: Run the light rendered case and verify RED**

Run:

```powershell
npx playwright test tests/components/appearanceWorkspace.spec.js --config=playwright.component.config.js --grep "Artist Family" --reporter=line
```

Expected: the new light selected-background assertion fails because the current rule resolves to `--appearance-card`.

- [ ] **Step 3: Add the minimum light-mode CSS override**

Add after the existing Artist Family active/hover rules:

```css
:root[data-appearance-mode='light'] .artist-family-panel__artist.is-active,
:root[data-appearance-mode='light'] .artist-family-panel__artist.is-active:is(:hover, :focus-visible) {
  background: var(--appearance-play, #4bc173);
  color: var(--appearance-play-ink, #10201a);
}
:root[data-appearance-mode='light']
  .artist-family-panel__artist.is-active
  .artist-family-panel__count {
  background: var(--appearance-play-ink, #10201a);
  color: var(--appearance-play, #4bc173);
}
```

Do not alter the generic palette or dark-theme active rules.

- [ ] **Step 4: Update the static ownership contract**

Keep the existing assertions that the generic active state uses the card background and play border. Add mappings that require the light active rule to use `background: var(--appearance-play)`, `color: var(--appearance-play-ink)`, and the nested count rule to use the inverse play/play-ink pair.

- [ ] **Step 5: Run focused verification**

Run sequentially:

```powershell
npx playwright test tests/components/appearanceWorkspace.spec.js --config=playwright.component.config.js --grep "Artist Family" --reporter=line
node --test --test-concurrency=1 tests/js/runtime/appearance-backgrounds.test.js
git diff --check -- music_app/static/css/appearance-backgrounds.css tests/components/appearanceWorkspace.spec.js tests/js/runtime/appearance-backgrounds.test.js
```

Expected: all selected tests pass and `git diff --check` exits `0`.

- [ ] **Step 6: Verify the live stylesheet**

Fetch `http://localhost:5001/static/css/appearance-backgrounds.css` with a cache-busting query and compare it ordinally with the local file after normalizing an optional UTF-8 BOM. Expected: HTTP `200` and exact equality.
