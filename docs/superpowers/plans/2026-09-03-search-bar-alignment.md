# Search Bar Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the desktop library search field with the main panel's outer edge and tighten the clear-to-search icon spacing without overlap.

**Architecture:** Keep the change CSS-only and scoped to the library app bar. Protect the layout contract with a focused Node test that reads the stylesheet and checks the exact desktop alignment and spacing declarations.

**Tech Stack:** CSS, Node.js built-in test runner

## Global Constraints

- Do not change search behavior, markup, keyboard handling, the native clear control, accessible names, or trailing app-bar controls.
- Do not change the existing responsive overrides at 900 pixels or 720 pixels.
- Keep the icon-spacing override scoped to the app bar so other shared search fields retain their current layout.

---

### Task 1: Library App-Bar Search Layout

**Files:**
- Create: `tests/js/app-chrome-search-layout.test.js`
- Modify: `music_app/static/css/app-chrome.css:58-62`
- Modify: `music_app/static/css/app-chrome.css:85-94`

**Interfaces:**
- Consumes: `.app-bar .toolbar-left`, `.app-bar .search-field`, and the shared `.search-field-control` grid.
- Produces: a zero desktop left inset for the library toolbar and an app-bar-only zero right inset between the native clear control's input cell and the search action cell.

- [ ] **Step 1: Write the failing stylesheet contract test**

```js
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const appChromeCss = fs.readFileSync(
  path.join(__dirname, '..', '..', 'music_app', 'static', 'css', 'app-chrome.css'),
  'utf8',
);

test('desktop library search aligns to the main panel outer edge', () => {
  assert.match(
    appChromeCss,
    /\.app-bar \.toolbar-left\s*\{[^}]*padding-left:\s*0;/,
  );
});

test('app-bar search keeps the native clear control close to the search action', () => {
  assert.match(
    appChromeCss,
    /\.app-bar \.search-field \.search-field-control\s*>\s*input\[type='search'\]\s*\{[^}]*padding-right:\s*0;/,
  );
});
```

- [ ] **Step 2: Run the test and verify that both assertions fail**

Run: `node --test tests/js/app-chrome-search-layout.test.js`

Expected: two failed tests because the toolbar still has `padding-left: 24px` and no app-bar-scoped `padding-right: 0` rule exists.

- [ ] **Step 3: Implement the minimal CSS change**

Change the existing desktop toolbar rule and add the app-bar-scoped input override:

```css
.app-bar .toolbar-left { margin: 0; padding-left: 0; }

.app-bar .search-field .search-field-control > input[type='search'] {
  padding-right: 0;
}
```

Keep the existing `@media (max-width: 900px)` and `@media (max-width: 720px)` declarations unchanged. The input and search action remain separate grid cells, so their controls cannot overlap.

- [ ] **Step 4: Run focused verification**

Run: `node --test tests/js/app-chrome-search-layout.test.js tests/js/shared-account-menu-contract.test.js`

Expected: all tests pass with no warnings or errors.

- [ ] **Step 5: Inspect the final diff**

Run: `git diff --check -- music_app/static/css/app-chrome.css tests/js/app-chrome-search-layout.test.js`

Expected: no output.

- [ ] **Step 6: Commit the implementation**

```bash
git add music_app/static/css/app-chrome.css tests/js/app-chrome-search-layout.test.js
git commit -m "fix: align library search bar"
```
