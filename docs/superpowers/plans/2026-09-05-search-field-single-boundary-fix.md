# Search Field Single-Boundary Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure the shared search input and search action always render as one component with one external focus ring and no internal outline, border, or shadow.

**Architecture:** Keep the existing semantic structure because the action already lives inside `.search-field-control`. Make the shared component stylesheet authoritative over the later global appearance focus rule, and cover both focusable children with browser-computed component tests.

**Tech Stack:** Jinja HTML macro, CSS, Playwright component tests, Node.js test runner.

## Global Constraints

- Keep the browser-native search clear control.
- Keep the search button inside the shared search component and preserve its accessible name, submit behavior, and pointer target.
- Render exactly one external focus indicator from `.search-field-control:focus-within`.
- Render no internal outline, border, or shadow on either the input or search button.
- Preserve visible keyboard focus on the button through its background and foreground color state.

---

### Task 1: Lock the Single-Boundary Focus Contract

**Files:**
- Modify: `tests/components/searchInput.spec.js`
- Modify: `music_app/static/css/search-input.css`

**Interfaces:**
- Consumes: `.search-field-control:focus-within`, `.search-field-button`, and the global appearance `:focus-visible` rule loaded after the component stylesheet.
- Produces: a shared CSS contract in which either focused child activates only the outer control ring.

- [x] **Step 1: Write the failing component test**

Extend the existing test to tab from the input to the search button and assert the real computed styles after `appearance-backgrounds.css` loads:

```js
<html style="--appearance-interaction-outline: rgb(75, 193, 115); --appearance-accent: rgb(75, 193, 115);">

await page.keyboard.press('Tab');
await expect(searchButton).toBeFocused();
await expect(searchButton).toHaveCSS('outline-style', 'none');
await expect(searchButton).toHaveCSS('border-style', 'none');
await expect(searchButton).toHaveCSS('box-shadow', 'none');
await expect(control).toHaveCSS('outline-style', 'solid');
await expect(control).toHaveCSS('outline-width', '2px');
```

- [x] **Step 2: Run the focused test to verify the regression**

Run:

```powershell
npx playwright test --config=playwright.component.config.js tests/components/searchInput.spec.js
```

Expected: the search-button focus assertions fail because the component rule and the later global rule currently draw an internal outline.

- [x] **Step 3: Make the component authoritative**

Replace the child focus rules in `search-input.css` with selectors that outrank the late global appearance rule while retaining the existing button focus fill:

```css
:root .search-field .search-field-control > input[type='search']:focus-visible,
:root .search-field .search-field-action > .search-field-button:focus-visible {
  border: 0;
  outline: none;
  box-shadow: none;
}
```

Keep `.search-field-control:focus-within` unchanged and keep the existing `:hover, :focus-visible` background/foreground rule for `.search-field-button`.

- [x] **Step 4: Run focused component and structural tests**

Run:

```powershell
npx playwright test --config=playwright.component.config.js tests/components/searchInput.spec.js
node --test tests/js/app-chrome-search-layout.test.js
```

Expected: all search component and app-chrome search layout tests pass.

- [x] **Step 5: Verify the browser states**

Open the rendered app and check the default, input-focused, populated/native-clear, and keyboard-focused-button states. Expected: one outer ring only; no seam between the native clear control and search action; the button focus fill remains visible.

- [x] **Step 6: Commit the repair with its design and plan**

```powershell
git add docs/superpowers/specs/2026-09-03-search-bar-alignment-design.md docs/superpowers/plans/2026-09-05-search-field-single-boundary-fix.md tests/components/searchInput.spec.js music_app/static/css/search-input.css
git commit -m "fix: keep search focus on shared boundary"
```

## Self-Review

- Spec coverage: the plan covers input focus, native-clear adjacency, button keyboard focus, the single outer ring, shared ownership, accessibility, and mobile preservation.
- Placeholder scan: no deferred or unspecified implementation steps remain.
- Type consistency: the selectors and class names match the shared Jinja macro and current component test fixture.
