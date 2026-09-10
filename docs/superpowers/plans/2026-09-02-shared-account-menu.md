# Shared Account Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the approved reusable Settings dropdown and make Account/Admin navigation discoverable and consistent.

**Architecture:** A Jinja partial renders the menu with server-owned permission and CSRF data. A small runtime module manages accessible disclosure-menu behavior, and a dedicated stylesheet provides approved component states. Existing Settings actions route through the menu without changing the Utilities dialog itself.

**Tech Stack:** FastAPI, Jinja2, vanilla JavaScript runtime bundle, CSS, Node test runner, Playwright.

## Global Constraints

- Render Admin Panel only when `accounts.read` is allowed.
- Submit Sign Out through the existing CSRF-protected POST route.
- Keep the existing Settings gear as the only related top-bar control; no standalone Account button.
- Preserve all existing E2E validations while updating the owner-approved Settings action sequence.
- Keep Phase 7 Admin Management in its dedicated suite and runner.

---

### Task 1: Server-owned menu context and shared markup

**Files:**
- Create: `music_app/templates/partials/account-menu.html`
- Modify: `music_app/routes/web_asgi.py`
- Modify: `music_app/templates/index.html`
- Modify: `music_app/templates/partials/primary-modals.html`
- Test: `tests/py/test_web_account_menu.py`
- Update authenticated fixtures: `tests/py/asgi_testing.py`, `tests/py/test_web_bootstrap.py`
- Test: `tests/js/shared-account-menu-contract.test.js`

**Interfaces:**
- Consumes: `allowed_actions_for_request(request, ("accounts.read",))` and the session CSRF cookie.
- Produces: `account_menu_allowed_actions`, `account_menu_csrf_token`, and semantic `[data-account-menu]` markup.

- [x] Write failing route and markup tests for allowed Admin Panel visibility, CSRF logout, the three-action order, and removal of the Utilities Users link.
- [x] Run the focused Python and JavaScript tests and confirm they fail for missing menu context and markup.
- [x] Add the minimal server context, partial, and template integration.
- [x] Run the focused tests and confirm they pass.

### Task 2: Reusable interaction and presentation

**Files:**
- Create: `music_app/static/js/runtime/account-menu.js`
- Create: `music_app/static/css/runtime/account-menu.css`
- Modify: `scripts/build-runtime-bundle.cjs`
- Modify: `music_app/static/js/runtime/bootstrap-init.js`
- Modify: `music_app/templates/index.html`
- Test: `tests/js/runtime/account-menu.test.js`
- Test: `tests/js/shared-account-menu-contract.test.js`

**Interfaces:**
- Consumes: `[data-account-menu-trigger]`, `[data-account-menu]`, `[data-account-menu-settings]`, and disabled menu items.
- Produces: click, outside-click, Escape, focus-return, `aria-expanded`, rounded hover/focus, and disabled-state behavior.

- [x] Write failing runtime and CSS contract tests for menu toggling, keyboard behavior, outside dismissal, rounded states, and disabled activation rejection.
- [x] Run the focused JavaScript tests and confirm the expected failures.
- [x] Implement the focused runtime module and stylesheet, then add the module to the runtime bundle.
- [x] Build the runtime bundle and rerun the focused tests.

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

- [x] Extend the presentation contract with failing assertions for removed sidebar links and row-style Sign Out.
- [x] Run the focused test and confirm the expected failures.
- [x] Apply the minimal template and CSS changes.
- [x] Rerun the focused presentation and responsive tests.

### Task 4: Production-path E2E coverage

**Files:**
- Modify: `tests/e2e/poms/settingsModalAppBar.js`
- Modify: `tests/e2e/actions/settingsModalAppBarActions.js`
- Modify: `tests/e2e/phase7/admin-management/adminManagement.spec.js`
- Modify: `../album-haven-internal/docs/functional-test-cases/users-and-permissions.md`

**Interfaces:**
- Consumes: the shared account menu and the existing Phase 7 isolated Postgres fixture.
- Produces: `FTC-PERMISSIONS-011` owner navigation and `FTC-PERMISSIONS-012` limited-member visibility/logout coverage. `010` already belongs to a post-migration capability case.

- [x] Add the approved functional cases and failing Playwright assertions without weakening existing checks.
- [x] Run the dedicated Phase 7 Admin Management suite and confirm the new flow fails before implementation completion.
- [x] Update the shared Settings POM/action helper to follow gear → Settings and add menu actions.
- [x] Run production-parity validation, focused JavaScript tests, and the unchanged dedicated Phase 7 Admin Management suite.

### Task 5: Review and publish to the open PR

**Files:**
- Modify: `../album-haven-internal/docs/ui-component-system.md`
- Modify: `../album-haven-internal/docs/permissions-and-capabilities.md`

**Interfaces:**
- Consumes: focused test and E2E evidence.
- Produces: registered shared-component and permission-surface records plus an updated open PR.

- [x] Record the component, action visibility, clients, approved artifact, and verification evidence in the private registries.
- [x] Run focused verification and `git diff --check`.
- [x] Review the scoped diff, commit public and private repository changes separately, and push the existing PR branch.
- [ ] Monitor PR checks and review output without merging.

Public implementation commit `c104670b15654f79bbbfe7fdb84930eb298f8cbb` is on [PR #1](https://github.com/idanilovqa/AlbumHaven/pull/1). Private artifact and test-case commit `42f5908873402c1972e7acb1118c4bae5a996d58` remains local. The `album-haven-pr-1-checks` thread heartbeat checks hosted E2E and review results every ten minutes and pauses after terminal results. The PR remains unmerged for owner testing; monitoring stays open until those results arrive.

## E2E-discovered policy regression

The new limited-member journey initially reached 403 because the existing Listener browse capability did not satisfy shell/bootstrap/status read actions. The correction lives in `music_app/services/policy_evaluator.py` and `music_app/services/policy_asgi.py`; `tests/py/test_policy_evaluator.py` and `tests/py/test_policy_asgi.py` prove same-library scope and continued administrative denial. Logout is active-session self-service while its existing route retains CSRF and origin checks. All 118 focused policy/auth/boundary checks passed after the correction.

The newly authored post-logout assertion was reconciled with the established `/account` 401 contract. No existing E2E assertion, timeout, retry, or flow was weakened. The owner-approved Settings path change is centralized in the existing Settings helper.

## Owner correction: remove the extra Account button

The owner identified the remaining `#account-button` link in a screenshot and explicitly requested its removal. This corrects the approved single-dropdown navigation design; it does not change the dropdown, account routes, or permissions. The exact removal is approved, so no new visual design is needed.

- [x] Remove the standalone Account link from the shared shell template.
- [x] Add a regression assertion and verify it fails before removal and passes afterward.
- [x] Run the focused shared-menu and Account/Admin presentation tests.

Verification: the new assertion failed on the extra link before removal; all 11 focused tests passed afterward. This local correction changes the shell template, shared-menu contract test, and this plan only. It has not been committed or pushed; the previous full-suite results above do not cover this follow-up.

Manual check: refresh the library page after restarting the app if templates are cached. The smiley Account icon must be absent; the Settings gear must still open Settings, Admin Panel, and Sign Out for an authorized owner.

## Owner correction: restore My account navigation

The owner reported that Users was the only working sidebar destination and that their own password/device controls were no longer discoverable. The existing `/account` page still implements those controls; removing the standalone Account icon had left no visible path from Admin. This correction restores navigation using the existing approved sidebar rows, without adding an app-bar button, changing the three-item dropdown, or introducing new permissions.

- [x] Replace the disabled Email delivery, Security, and Audit log placeholders with a working My account link to `/account`.
- [x] Keep My account active on the account page, preserve its password form and Active sessions list, and show a return Users link only when the server allows `accounts.read`.
- [x] Add failing presentation and route tests, then verify the correction with owner and non-admin actors.
- [x] Extend FTC-PERMISSIONS-011 additively to cover Admin → My account → Users, current-user identity, password fields, and connected-device information; preserve existing suite expectations and local SMTP isolation.
- [x] Run focused tests, production-parity validation, and the dedicated Admin Management E2E suite; record results before handoff.

No new device-management operation is introduced: the existing current-user password form and device/session information remain unchanged. This plan has no aggregate checkbox counter.

Focused evidence: the new navigation assertions failed before implementation (two JavaScript and two Python failures). After implementation, all 13 focused JavaScript and five account-route Python tests passed sequentially; production-parity validation passed. Independent local review found no actionable issue. Full repository regression and publishing are not claimed for this local correction.

The first dedicated Admin Management run retained two failures and three passes. Both failures were in the newly authored password-label lookup; the captured screenshot and accessibility snapshot showed the correct account page, password inputs, and active-device information. Investigation identified an anchored regular expression matching raw multiline label text. The correction is confined to the new POM lookup; assertions, product behavior, timeouts, and established scenarios remain unchanged. Initial failure artifacts are retained under `test-results/my-account-nav-admin-initial-failure-20260902`.

Final verification: all five dedicated Admin Management E2E cases passed in 33.4 seconds (exit 0) after the three new password-label expressions were corrected to tolerate leading whitespace. Production parity passed again, and the independent follow-up review found no issue. Evidence: `test-results/my-account-nav-admin-rerun-20260902.stdout.log`. The recorded runner and descendants exited and ports 6190–6192 were clear afterward. The owner's port-5000 server and real SMTP configuration were untouched. This correction remains local and uncommitted for owner testing; no push or merge was performed.

This correction changes ten files, excluding the preceding standalone-icon removal and unrelated owner work:

- Application: `music_app/routes/account_asgi.py`, `music_app/templates/account.html`, `music_app/templates/partials/admin-settings-nav.html`.
- Tests: `tests/py/test_account_asgi.py`, `tests/js/phase7-account-admin-presentation.test.js`, `tests/e2e/phase7/admin-management/adminManagement.spec.js`, `tests/e2e/phase7/poms/authPages.js`.
- Documentation: this plan and private `docs/functional-test-cases/users-and-permissions.md` plus `docs/functional-test-cases.md`.

Exact total elapsed time and the direct-work/process-overhead split were not recorded. The private functional-case statuses and counters remain unchanged at Automated 9/12 for Users And Permissions.

## Manual acceptance script

1. Restart the local app on this branch and sign in as the owner.
2. Click the Settings gear. Confirm Settings, Admin Panel, and Sign Out appear in that order.
3. Hover each row and use Arrow Down/Arrow Up. Highlights have rounded corners; Escape closes the menu and returns focus to the gear. Clicking outside also closes it.
4. Choose Settings. The existing Utilities dialog opens. Close it, reopen the gear, and choose Admin Panel. Users is the active tab.
5. Click My account in the Admin sidebar. Your signed-in username, password form, and Active sessions/device list appear; My account is active. Click Users to return to user management. Email delivery, Security, and Audit log placeholders are absent. Sessions and Back to library are absent from the sidebar; Sign Out looks like a navigation row.
6. Invite a Listener without administrative capabilities and accept the copied link in a separate browser profile. After login, Settings and Sign Out appear, but Admin Panel does not.
7. Choose Sign Out. Login appears and the previous session cannot access Account. No real SMTP is needed for these copied-link checks.

## Verification evidence (September 2, 2026)

- Focused JavaScript: 143 passed, including presentation and responsive contracts.
- Full JavaScript foundation gate: 2,042 passed, zero failures. The initial ten failures were stale bundle-order/source-loading harness expectations; both harnesses now load the new module.
- Full Python: 4,136 passed, 44 skipped, one existing Pillow deprecation warning.
- E2E production parity: zero violations.
- Dedicated Admin Management E2E: five passed, including both new menu cases and existing copied-invitation, local-SMTP, and permission-enforcement cases.
- Dedicated Auth Lifecycle E2E: six passed, including anonymous-root login redirect, password reset, session expiry, CSRF, and logout revocation.
- Local scoped review: no actionable defects. Disabled activation and outside-focus dismissal have runtime tests, not browser E2E coverage.
- `git diff --check`: passed. User-owned `AGENTS.md` and attachment changes are excluded from the implementation commit.
- The isolated E2E fixture logged an unavailable empty media root during shell scan startup; auth/menu assertions passed. No production-library or real SMTP configuration was changed.

## Changed-file inventory

The implementation touches 31 public files and seven private planning/artifact files. Two private registry references remain within the owner's pre-existing untracked registry documents; those documents must not be staged wholesale with this feature. Exact direct-work, process-overhead, and total elapsed times were not recorded.

Public application files:

- `docs/superpowers/plans/2026-09-02-shared-account-menu.md`
- `docs/superpowers/specs/2026-09-02-shared-account-menu-design.md`
- `music_app/routes/web_asgi.py`
- `music_app/services/policy_asgi.py`
- `music_app/services/policy_evaluator.py`
- `music_app/static/css/account.css`
- `music_app/static/css/admin-members.css`
- `music_app/static/css/runtime/account-menu.css`
- `music_app/static/js/runtime-bundle.js`
- `music_app/static/js/runtime/account-menu.js`
- `music_app/static/js/runtime/bootstrap-init.js`
- `music_app/templates/account.html`
- `music_app/templates/index.html`
- `music_app/templates/partials/account-menu.html`
- `music_app/templates/partials/admin-settings-nav.html`
- `music_app/templates/partials/primary-modals.html`
- `scripts/build-runtime-bundle.cjs`
- `tests/e2e/actions/settingsModalAppBarActions.js`
- `tests/e2e/phase7/admin-management/adminManagement.spec.js`
- `tests/e2e/poms/settingsModalAppBar.js`
- `tests/js/phase7-account-admin-presentation.test.js`
- `tests/js/runtime/account-menu.test.js`
- `tests/js/runtime/app-loader-bundle.test.js`
- `tests/js/runtime/bootstrap-init-playback-ownership.test.js`
- `tests/js/shared-account-menu-contract.test.js`
- `tests/py/asgi_testing.py`
- `tests/py/test_account_asgi.py`
- `tests/py/test_policy_asgi.py`
- `tests/py/test_policy_evaluator.py`
- `tests/py/test_web_account_menu.py`
- `tests/py/test_web_bootstrap.py`

Private owner files:

- `docs/design-mockups/components/shared-account-menu/v001/component-record.md`
- `docs/design-mockups/components/shared-account-menu/v001/design-brief.md`
- `docs/design-mockups/components/shared-account-menu/v001/mock.png`
- `docs/design-mockups/components/shared-account-menu/v001/review.json`
- `docs/functional-test-cases/users-and-permissions.md`
- `docs/permissions-and-capabilities.md` (reference only, preserve owner's untracked document)
- `docs/ui-component-system.md` (reference only, preserve owner's untracked document)
