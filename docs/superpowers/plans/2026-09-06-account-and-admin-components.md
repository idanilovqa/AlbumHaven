# Account and Admin Components Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make My Account, Edit User, and the Admin roster use the same inputs, selects, checkboxes, buttons, action menu, and frame-free table while using the approved two-column desktop layout.

**Architecture:** Introduce Jinja form-control macros and a reusable disclosure action menu, formalize CompactDataTable's frame-free variant, then migrate both account pages and the roster without changing authorization or form submission behavior.

**Tech Stack:** Jinja, browser JavaScript, CSS, Node test runner, Python ASGI tests.

## Global Constraints

- Follow the index constraints in `2026-09-06-shared-ui-convergence-index.md`.
- My Account and Edit User must share the same page skeleton and visual rules.
- Change Password remains directly on the page with no visible outer panel.
- Active Sessions and Account Settings occupy the right desktop column; narrow layouts stack them.
- Edit User Account Settings and Active Sessions use the same frame-free table treatment.
- The capability-role select is wider than its inline information alert; neither spans the full page.
- Admin rows render no action for zero actions, the direct icon action for one action, and an ellipsis disclosure menu for two or more actions.

### Task 1: Shared form controls

**Files:**
- Create: `music_app/templates/partials/form-controls.html`
- Create: `music_app/static/css/form-control-components.css`
- Modify: `music_app/templates/account.html`
- Modify: `music_app/templates/admin-account-detail.html`
- Modify: `C:/Repositories/album-haven-internal/docs/ui-component-system.md`
- Modify: `C:/Repositories/album-haven-internal/docs/permissions-and-capabilities.md`
- Modify: `C:/Repositories/album-haven-internal/docs/functional-test-cases/users-and-permissions.md`
- Test: `tests/py/test_account_asgi.py`
- Test: `tests/py/test_admin_members_asgi.py`

**Interfaces:**
- Jinja macros: `ui_input(name, label, type='text', value='', autocomplete='', help_text='', errors=[])`, `ui_select(name, label, options, selected='', help_text='')`, and `ui_checkbox(name, label, checked=false, disabled=false, help_text='')`.
- All macros preserve caller form names, IDs, values, autocomplete, disabled state, and submitted semantics.

- [ ] Add failing ASGI/template assertions that both pages use the shared macros/classes for every input, select, and checkbox and retain current field names and CSRF/form boundaries.
- [ ] Run `python -m pytest -q tests/py/test_account_asgi.py tests/py/test_admin_members_asgi.py`; expect shared-control assertions to fail.
- [ ] Implement the macros with associated labels, descriptions/errors via `aria-describedby`, and invalid state via `aria-invalid`.
- [ ] Add the shared stylesheet to the base asset path used by both pages and migrate raw controls without changing handlers.
- [ ] Add Input, Select, and Checkbox records to the private component registry.
- [ ] Record the unchanged account/admin capabilities and deployment/client matrix in the permission registry, and add the approved rendering/action cases plus proposed tests to `users-and-permissions.md`.
- [ ] Repeat the focused pytest invocation and require zero failures.
- [ ] Commit as `refactor: share account form controls`.

### Task 2: Frame-free CompactDataTable and two-column account shell

**Files:**
- Modify: `music_app/static/js/runtime/compact-data-table.js`
- Modify: `music_app/static/css/runtime/compact-data-table.css`
- Modify: `music_app/templates/account.html`
- Modify: `music_app/templates/admin-account-detail.html`
- Modify: `music_app/static/css/account.css`
- Test: `tests/js/runtime/compact-data-table.test.js`
- Test: `tests/js/phase7-account-admin-presentation.test.js`

**Interfaces:**
- `buildCompactDataTable({ frame: 'outline' | 'none', ...existingOptions })`; default remains `outline`.
- Shared account layout classes: `.account-page-grid`, `.account-page-grid__primary`, `.account-page-grid__secondary`, `.account-section`.

- [ ] Add failing table tests for `frame: 'none'`, default compatibility, accessible headers, row actions, and empty state.
- [ ] Add failing presentation assertions for identical My Account/Edit User shell classes, desktop two-column placement, narrow stacking, unboxed Change Password, and matching frame-free Active Sessions/Account Settings tables.
- [ ] Run the two Node test files with `--test-concurrency=1`; expect failures for the new contract.
- [ ] Implement `frame: 'none'` as a modifier that removes only the exterior boundary, retaining row separators, hover, selection, and accessibility.
- [ ] Restructure both templates into the common grid. Keep password fields in a semantic section without card/panel decoration.
- [ ] Give the role row a bounded grid such as `minmax(18rem, 32rem) minmax(14rem, 24rem)` and stack it at narrow width.
- [ ] Repeat the focused Node tests and require zero failures.
- [ ] Commit as `refactor: align account page layouts`.

### Task 3: Shared roster action menu and centered Add User button

**Files:**
- Create: `music_app/templates/partials/action-menu.html`
- Create: `music_app/static/js/action-menu.js`
- Create: `music_app/static/css/action-menu.css`
- Modify: `music_app/templates/admin-members.html`
- Modify: `music_app/static/js/admin-members.js`
- Modify: `music_app/static/css/account.css`
- Modify: `C:/Repositories/album-haven-internal/docs/ui-component-system.md`
- Test: `tests/js/runtime/admin-members.test.js`
- Test: `tests/js/phase7-account-admin-presentation.test.js`

**Interfaces:**
- Jinja macro `action_menu(id, label, actions)` owns the ellipsis trigger and menu markup.
- `createActionMenuController(root)` owns open/close, outside-click, Escape, ArrowUp/ArrowDown, Home/End, and focus return.
- Server-side action list remains `{ id, label, href?, method?, icon? }[]`.

- [ ] Add failing tests for 0/1/2+ action rendering, edit pencil SVG, preserved pending-user invite copy/send actions, menu keyboard behavior, outside click, and focus return.
- [ ] Assert Add User uses the shared ButtonComponent and that icon plus label are centered on the button centerline.
- [ ] Run the two focused Node tests; expect failures because the roster always renders its legacy menu.
- [ ] Add the Jinja macro, then extract the disclosure controller from `admin-members.js` into `action-menu.js`, keeping existing server operations and confirmation behavior.
- [ ] In the template, compute available actions: render nothing for zero, a direct RoundActionButton for one, and ActionMenu for two or more.
- [ ] Render Edit with the shared pencil SVG; retain Copy invite link and Send invitation email for pending users.
- [ ] Migrate Add User to the shared primary button and center its content using the shared button layout.
- [ ] Register ActionMenu in the private component registry.
- [ ] Repeat the focused tests and require zero failures.
- [ ] Commit as `refactor: share admin roster actions`.

### Task 4: Slice verification and acceptance

- [ ] Run the affected Node tests together, then the two focused pytest files; never overlap pytest with another pytest process.
- [ ] Run `git diff --check` and verify no permission predicates, endpoints, form names, or account mutations changed.
- [ ] Regenerate the runtime bundle if a bundled module changed and run `tests/js/runtime/app-loader-bundle.test.js`.
- [ ] Give the owner a desktop/narrow manual script covering My Account, Edit User, role select/info sizing, sessions/settings placement, Add User alignment, one-action pencil, and multi-action pending-user menu.
- [ ] Wait for owner acceptance before updating phase-7 functional E2E assertions.
