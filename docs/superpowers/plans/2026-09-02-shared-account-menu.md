# Shared Account Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the approved reusable Settings dropdown and make Account/Admin navigation discoverable and consistent.

**Architecture:** A Jinja partial renders the menu with server-owned permission and CSRF data. A small runtime module manages accessible disclosure-menu behavior, and a dedicated stylesheet provides approved component states. Existing Settings actions route through the menu without changing the Utilities dialog itself.

**Tech Stack:** FastAPI, Jinja2, vanilla JavaScript runtime bundle, CSS, Node test runner, Playwright.

## Global Constraints

- Render Admin Panel only when `accounts.read` is allowed.
- Submit Sign Out through the existing CSRF-protected POST route.
- Keep the existing Settings gear as the only related top-bar control.
- Preserve all existing E2E validations while updating the owner-approved Settings action sequence.
- Keep Phase 7 Admin Management in its dedicated suite and runner.

---

### Task 1: Server-owned menu context and shared markup

**Files:**
- Create: `music_app/templates/partials/account-menu.html`
- Modify: `music_app/routes/web_asgi.py`
- Modify: `music_app/templates/index.html`
- Modify: `music_app/templates/partials/primary-modals.html`
- Test: `tests/py/test_web_asgi.py`
- Test: `tests/js/shared-account-menu-contract.test.js`

**Interfaces:**
- Consumes: `allowed_actions_for_request(request, ("accounts.read",))` and the session CSRF cookie.
- Produces: `account_menu_allowed_actions`, `account_menu_csrf_token`, and semantic `[data-account-menu]` markup.

- [ ] Write failing route and markup tests for allowed Admin Panel visibility, CSRF logout, the three-action order, and removal of the Utilities Users link.
- [ ] Run the focused Python and JavaScript tests and confirm they fail for missing menu context and markup.
- [ ] Add the minimal server context, partial, and template integration.
- [ ] Run the focused tests and confirm they pass.

### Task 2: Reusable interaction and presentation

**Files:**
- Create: `music_app/static/js/runtime/account-menu.js`
- Create: `music_app/static/css/runtime/account-menu.css`
- Modify: `scripts/build-runtime-bundle.cjs`
- Modify: `music_app/templates/index.html`
- Test: `tests/js/runtime/account-menu.test.js`
- Test: `tests/js/shared-account-menu-contract.test.js`

**Interfaces:**
- Consumes: `[data-account-menu-trigger]`, `[data-account-menu]`, `[data-account-menu-settings]`, and disabled menu items.
- Produces: click, outside-click, Escape, focus-return, `aria-expanded`, rounded hover/focus, and disabled-state behavior.

- [ ] Write failing runtime and CSS contract tests for menu toggling, keyboard behavior, outside dismissal, rounded states, and disabled activation rejection.
- [ ] Run the focused JavaScript tests and confirm the expected failures.
- [ ] Implement the focused runtime module and stylesheet, then add the module to the runtime bundle.
- [ ] Build the runtime bundle and rerun the focused tests.

### Task 3: Account and Admin sidebar cleanup

**Files:**
- Modify: `music_app/templates/account.html`
- Modify: `music_app/templates/partials/admin-settings-nav.html`
- Modify: `music_app/static/css/account.css`
- Modify: `music_app/static/css/admin-members.css`
- Test: `tests/js/phase7-account-admin-presentation.test.js`

**Interfaces:**
- Consumes: existing Account and Admin navigation row styles.
- Produces: Account Password & security plus row-style Sign Out; Admin Users without Back to library.

- [ ] Extend the presentation contract with failing assertions for removed sidebar links and row-style Sign Out.
- [ ] Run the focused test and confirm the expected failures.
- [ ] Apply the minimal template and CSS changes.
- [ ] Rerun the focused presentation and responsive tests.

### Task 4: Production-path E2E coverage

**Files:**
- Modify: `tests/e2e/poms/settingsModalAppBar.js`
- Modify: `tests/e2e/actions/settingsModalAppBarActions.js`
- Modify: `tests/e2e/phase7/admin-management/adminManagement.spec.js`
- Modify: `C:/Repositories/album-haven-internal/docs/functional-test-cases/users-and-permissions.md`

**Interfaces:**
- Consumes: the shared account menu and the existing Phase 7 isolated Postgres fixture.
- Produces: `FTC-PERMISSIONS-010` owner navigation and `FTC-PERMISSIONS-011` limited-member visibility/logout coverage.

- [ ] Add the approved functional cases and failing Playwright assertions without weakening existing checks.
- [ ] Run the dedicated Phase 7 Admin Management suite and confirm the new flow fails before implementation completion.
- [ ] Update the shared Settings POM/action helper to follow gear → Settings and add menu actions.
- [ ] Run production-parity validation, focused JavaScript tests, and the unchanged dedicated Phase 7 Admin Management suite.

### Task 5: Review and publish to the open PR

**Files:**
- Modify: `C:/Repositories/album-haven-internal/docs/ui-component-system.md`
- Modify: `C:/Repositories/album-haven-internal/docs/permissions-and-capabilities.md`

**Interfaces:**
- Consumes: focused test and E2E evidence.
- Produces: registered shared-component and permission-surface records plus an updated open PR.

- [ ] Record the component, action visibility, clients, approved artifact, and verification evidence in the private registries.
- [ ] Run focused verification and `git diff --check`.
- [ ] Review the scoped diff, commit public and private repository changes separately, and push the existing PR branch.
- [ ] Monitor PR checks and review output without merging.

