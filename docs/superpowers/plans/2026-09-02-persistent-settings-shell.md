# Persistent Settings Shell Implementation Plan

> **For agentic workers:** Use the repository's subagent handoffs for implementation, test authoring, verification, review, and commit. Preserve the current branch. Do not push or merge this manual-testing batch.

**Goal:** Keep the Settings sidebar and ongoing music playback mounted while the user moves between Users, My account, and account editors.

**Architecture:** Keep the current Jinja/JavaScript stack. A shared Settings shell owns a fixed sidebar and a replaceable content outlet. A scoped navigation controller fetches existing protected HTML routes, mounts their content controllers, and coordinates browser history without unloading the library document or player.

**Tech Stack:** FastAPI, Jinja, browser JavaScript, CSS, Node tests, pytest, Playwright with isolated Postgres and generated audio.

## Approved scope and visual reference

The owner approved this design in chat with “it does match” on 2026-09-02:

- Use the supplied second screenshot's Settings sidebar appearance.
- Keep Users, My account, Sign Out in that order. Keep logo, heading, icons, spacing, and width stable. Sign Out uses an ordinary navigation row.
- Change only the active highlight and right-hand content. Keep the actual sidebar element mounted.
- Keep the current bottom player visible and ongoing playback uninterrupted after entering from the library.
- Support browser Back/Forward without unloading either component.
- Keep Users permission-controlled across both screens. Do not add placeholders or app-bar buttons.

The approved visual reference is stored in the private repository at `docs/design-mockups/components/persistent-settings/v001/approved-settings-sidebar.png`; its source is the owner-supplied `codex-clipboard-a5625d47-ca71-4a1e-8b46-23cdba4de7c1.png`. The first supplied screenshot records the inconsistent Account sidebar being removed.

This corrects the Phase 7 current-stack UI. It does not start the later React migration or redesign the player. Existing web support remains required; Tauri uses the shared web implementation. Native Android, TV, and Apple renderers remain outside this DOM-component scope.

## Global constraints

- Preserve the existing AudioWorklet, WebSocket, decoder ownership, queue, loop, volume, and unload behavior. Real logout still unloads and stops playback.
- Keep existing server policy, CSRF validation, and no-store responses. Never call the library index handler through an account-only permission boundary.
- Cold direct Settings URLs keep their authorized server-rendered entry path. They have no live library player to preserve. Internal Settings navigation is smooth there too; entering the library can then load its authorized document.
- Fetch and parse only allowlisted same-origin Settings routes. Never evaluate scripts from fetched HTML or replace the document body.
- Preserve existing E2E scenarios and validation strength. The unified navigation accessible name and fixed item presentation change only as approved above.
- Run one test process at a time; JavaScript, Python, and browser waves run sequentially. Leave the owner's port 5000 server and real database untouched.

## File ownership

- `music_app/templates/partials/admin-settings-nav.html`: the shared fixed sidebar.
- `music_app/templates/index.html`, `account.html`, `admin-members.html`, `admin-account-detail.html`: persistent host and replaceable content boundaries.
- `music_app/static/js/settings-navigation.js`: route allowlist, HTML extraction, history, loading/error handling, and content-controller lifecycle.
- `music_app/static/js/account.js`, `admin-members.js`: root-scoped initialization and mutation navigation.
- The shared navigation controller coordinates library enter/return and history without editing the player/runtime bootstrap.
- Account/admin stylesheets and shared Settings stylesheet as needed: scoped tokens and stable layout above the player.
- Focused JS/Python tests, Phase 7 Admin POM/spec/fixture: regression coverage.

## Task 1: Protect navigation and component ownership

- [x] Add failing unit/integration tests before production edits. Assert the shared nav order and permission visibility, allowlisted same-origin navigation, retained sidebar identity, stale-response rejection, failed-load retention, and history arbitration.
- [x] Run the new focused tests and record the expected failures.
- [x] Implement one reusable sidebar and Settings host. In the library, retain `#app-shell` and its player sibling; hide/show the library instead of rebuilding it.
- [x] Implement content navigation with an explicit route allowlist:

```js
const isSettingsPath = (path) => path === '/account'
  || path === '/admin/members'
  || /^\/admin\/accounts\/(?:new|[0-9]+)$/.test(path);
```

- [x] Validate each response's origin, path, HTML content boundary, and status before swapping. Abort superseded requests, retain the old content on failure, and show an accessible error. Let logout leave the document.
- [x] Scope CSS and controller listeners to their content root. Mount once per new outlet and release old document listeners. Keep password fields out of cached history snapshots.

## Task 2: Complete mutation and history paths

- [x] Route admin create/save/revoke completion and Cancel through the Settings controller rather than `location.assign`.
- [x] Submit own-account password and dismissal forms through their existing POST routes, keeping browser validation and CSRF fields. Render server errors and follow successful account redirects inside the outlet.
- [x] Update URL/title/active state after successful content transitions. Ensure the gallery popstate handler does not consume Settings routes.
- [x] Restore the existing library document and its prior view on return. Verify ordinary modified-link clicks and direct URLs still work.

## Task 3: Verify and hand off

- [x] Add Phase 7 Admin E2E cases for stable sidebar node/geometry, Users/account/editor navigation, Back/Forward, and real playback progress through Settings with the same stream. Use generated media seeded before production ASGI starts and the existing isolated Postgres fixture. Keep SMTP local.
- [x] Run focused JavaScript and Python checks sequentially, production-parity validation, then the complete dedicated Admin suite. Exercise relevant existing auth cases if password submission changes.
- [x] Review the diff for policy leaks, CSS collisions, listener leaks, request races, and playback lifecycle changes; fix and reverify findings.
- [x] Update the private functional cases and index with the observed evidence. Reconcile this checklist before commit.
- [x] Prepare the owner's manual checks and current results below for handoff. Do not merge; no full-release claim follows this focused batch.

## Manual acceptance

Restart the local server and hard-refresh the browser once to load the changed templates and scripts. Do not refresh during the continuity checks below.

1. Start a track from the library and note its position.
2. Open Settings gear → Admin Panel. Confirm the same track keeps advancing and the player stays visible.
3. Move Users → My account → Users; open an editor and Cancel. Confirm Users, My account, and Sign Out keep the same order, icons, and position; the actual sidebar stays fixed and the music does not restart. My account must still show password controls and active sessions.
4. Use Back and Forward across those screens. Confirm the URL, content, and active row agree.
5. Save the protected Owner without changing access. Confirm the roster returns without a document reload and playback continues.
6. Use the logo to return to the library; confirm its prior state and current track position remain.
7. Sign Out and confirm Login appears and playback stops.

## Evidence

Prior corrections were checkpointed in `1881c0b` before this batch. Progress: 15/15 implementation checkboxes complete; owner manual acceptance remains open. Exact direct-task time, skill/process overhead, and total elapsed time were not recorded; do not reconstruct estimates.

- Initial RED: five navigation tests failed because the controller did not exist. Review-fix RED: create/edit completion left the old submit control disabled after a failed destination read.
- GREEN: 40 focused JavaScript checks and 40 Python checks passed. Production-parity validation passed.
- Dedicated Admin: 8/8 passed in 1.4 minutes, including both new FTC-PERMISSIONS-013 cases. Auth lifecycle: 6/6 passed in 46.8 seconds.
- Initial browser setup failed before scenario execution because the new test requested two nonexistent fixtures. The author switched to the existing action fixtures' page objects, without changing the user flow or assertions. Evidence remains in `test-results/persistent-settings-admin-initial.*`.
- Successful browser logs: `test-results/persistent-settings-admin-r1.*` and `test-results/persistent-settings-auth-r1.*`; traces remain under their matching `test-results/playwright-artifacts/` folders.
- Auth r1 passed its assertions but logged an unavailable temporary library root. The auth-only fixture had not explicitly initialized its normal Postgres root and empty inventory. Setup/reset now initialize those for every invocation, including runs without generated audio. Existing table reset already clears root settings, so the exact previous-run origin of the logged path is not proven. Final sequential Admin/Auth reruns checked stderr as well as assertions.
- Final sequential verification after the fixture correction: Admin r2 passed 8/8 in 1.1 minutes; Auth r2 passed 6/6 in 39.6 seconds. Both exited successfully with no application error/traceback in stderr. All tracked child processes exited and scoped ports were clear after each wave. Logs remain in `test-results/persistent-settings-admin-r2.*` and `test-results/persistent-settings-auth-r2.*`.
- Visual QA passed its normal-flow capture diagnostic (1/1, 16.1 seconds total). Captures are `test-results/persistent-settings-qa/{1280,390}-{users,account}.png`. At desktop width both views retain a 248 × 715 sidebar; at 390px both retain the same 390 × 151 navigation area, with no document horizontal overflow. The bottom player stays visible in both layouts. The ignored diagnostic initially lacked its ESM package boundary; that setup-only error was corrected before launching the capture run.
- Narrow-screen caveat: long track title/time text crowds in the bottom player at 390px, visible in both captures. This batch does not change player CSS or architecture; that visual polish remains a separate follow-up, not a claim of pristine mobile player layout.
- Review fixes covered the Back/Forward library URL, superseded requests, persistent-outlet listener cleanup, and GET-only navigation retry after a completed mutation. The reviewer withdrew a proposed Space-key exception because the owner-locked frontend contract reserves Space for playback outside editable text fields.
- These focused results do not constitute a release or full-repository regression run. The owner will perform manual acceptance; no push or merge belongs to this batch.

## Changed files

23 public files belong to this batch:

1. `docs/superpowers/plans/2026-09-02-persistent-settings-shell.md`
2. `music_app/static/css/account.css`
3. `music_app/static/css/admin-members.css`
4. `music_app/static/css/settings-navigation.css`
5. `music_app/static/js/account.js`
6. `music_app/static/js/admin-members.js`
7. `music_app/static/js/settings-navigation.js`
8. `music_app/templates/account.html`
9. `music_app/templates/admin-account-detail.html`
10. `music_app/templates/admin-members.html`
11. `music_app/templates/index.html`
12. `music_app/templates/partials/admin-settings-nav.html`
13. `playwright.phase7-admin.config.js`
14. `tests/e2e/phase7/admin-management/persistentSettings.spec.js`
15. `tests/e2e/phase7/poms/authPages.js`
16. `tests/e2e/phase7/poms/settingsShell.js`
17. `tests/e2e/support/phase7AuthApp.py`
18. `tests/e2e/support/phase7PlaybackFixture.py`
19. `tests/js/phase7-account-admin-presentation.test.js`
20. `tests/js/runtime/account.test.js`
21. `tests/js/runtime/admin-members.test.js`
22. `tests/js/runtime/settings-navigation.test.js`
23. `tests/py/test_account_asgi.py`

Private documentation includes the Users/Permissions functional case and index, plus the approved screenshot, before screenshot, and prompt under `docs/design-mockups/components/persistent-settings/v001/`. Unrelated AGENTS, non-album, modal-runtime, generated runtime-bundle, and attachment edits remain outside this batch.
