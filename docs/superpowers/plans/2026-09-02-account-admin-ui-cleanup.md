# Account and Admin UI Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the unused Account `Profile` placeholder and unwanted session divider, and prevent blinking carets on non-editable Account/Admin text.

**Architecture:** Keep the change within the existing standalone Account/Admin template and stylesheets. Add one Node source-contract test that verifies the approved markup and CSS behavior without runtime JavaScript or backend changes.

**Tech Stack:** Jinja HTML templates, CSS, Node.js built-in test runner.

## Global Constraints

- Do not make `Profile` clickable or add a replacement placeholder.
- Do not use `user-select: none`.
- Do not change form behavior, focus styling, navigation destinations, session data, permissions, or backend behavior.
- Editable controls retain `caret-color: auto`.
- Preserve the section divider above `Active sessions`; remove only the `.sessions` top border.

---

### Task 1: Account and Admin presentation cleanup

**Files:**
- Create: `tests/js/phase7-account-admin-presentation.test.js`
- Modify: `music_app/templates/account.html`
- Modify: `music_app/static/css/account.css`
- Modify: `music_app/static/css/admin-members.css`

**Interfaces:**
- Consumes: Existing `.account-nav-item`, `.sessions`, and standalone-page `body` presentation contracts.
- Produces: Clean Account navigation and session presentation, plus static-text caret suppression on Account/Admin pages.

- [x] **Step 1: Write the failing presentation-contract tests**

Create a Node test that reads the three production files and asserts:

```javascript
assert.doesNotMatch(accountTemplate, />Profile<\/span>/);
assert.doesNotMatch(sessionsRule, /border-top\s*:/);
assert.match(css, /body\s*\{[^}]*caret-color:\s*transparent/s);
assert.match(css, /input,\s*textarea,\s*select,\s*\[contenteditable="true"\]\s*\{[^}]*caret-color:\s*auto/s);
```

Run:

```powershell
node --test --test-concurrency=1 tests/js/phase7-account-admin-presentation.test.js
```

Expected: four failures for the four absent presentation contracts.

- [x] **Step 2: Make the minimal production changes**

Delete the disabled `Profile` span from `account.html`. Remove `border-top` from `.sessions`. Add `caret-color: transparent` to each standalone `body` rule and add this rule to both stylesheets:

```css
input,
textarea,
select,
[contenteditable="true"] {
  caret-color: auto;
}
```

- [x] **Step 3: Run focused verification**

```powershell
node --test --test-concurrency=1 tests/js/phase7-account-admin-presentation.test.js tests/js/phase7-responsive-layout.test.js
```

Expected: five tests pass with zero failures.

- [x] **Step 4: Review and commit only scoped files**

```powershell
git diff --check -- music_app/templates/account.html music_app/static/css/account.css music_app/static/css/admin-members.css tests/js/phase7-account-admin-presentation.test.js
git add -- music_app/templates/account.html music_app/static/css/account.css music_app/static/css/admin-members.css tests/js/phase7-account-admin-presentation.test.js docs/superpowers/plans/2026-09-02-account-admin-ui-cleanup.md
git commit -m "fix(auth): clean up account admin presentation"
```
