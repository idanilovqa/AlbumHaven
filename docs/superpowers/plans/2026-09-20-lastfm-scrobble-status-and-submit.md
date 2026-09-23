# Last.fm Scrobble Status And Submit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show Album Haven accepted scrobbles, the connected Last.fm account total, and scoped pending scrobbles, then let an authorized user submit retryable pending rows without contacting a real test account.

**Architecture:** Keep credential management unchanged. Add a best-effort scoped status endpoint and a capability-gated scoped submit endpoint. Reuse the existing Last.fm provider, retry transition, Postgres listen-history, global alert, and Log History seams. Extend the loopback provider for production-path E2E coverage.

**Tech Stack:** FastAPI, psycopg/Postgres, plain runtime JavaScript under the approved Utilities current-stack exception, shared Button and notification components, Node tests, pytest, Playwright.

## Global Constraints

- Capability is `integration.lastfm.scrobbles.submit`, scoped to the authenticated user's account and current library.
- Web is required for self-hosted and hosted deployments; Tauri is optional; Android, TV, and Apple are unsupported in this delivery.
- `Scrobbled` means Album Haven submissions accepted by Last.fm. `LastFM Total` means `user.getInfo` lifetime playcount. `Pending` uses the canonical retryable predicate.
- Manual Submit bypasses time backoff only. It cannot bypass reauthentication, exhausted, permanent, attempting, sent, uncertain, or accepted guards.
- Failure uses the shared bottom-right Error alert and writes one scoped, secret-free Log History event.
- Tests use only the owned loopback Last.fm provider. No browser interception, real account, direct pending-row seed, or test-only production route.
- Preserve unrelated saved-loop work already present in the worktree. Stage and commit only files owned by this delivery.
- Do not mark `AH-W02-022` or `AH-W02-023` complete; this current-stack delivery does not add durable jobs or the broader sync review model.

---

### Task 1: Record Approved Capability And Functional Contracts

**Files:**
- Modify: `C:/Repositories/album-haven-internal/docs/permissions-and-capabilities.md`
- Modify: `C:/Repositories/album-haven-internal/docs/future-feature-plans/lastfm-sync-and-scrobbling-plan.md`
- Modify: `C:/Repositories/album-haven-internal/docs/functional-test-cases/playback-and-lastfm.md`

**Interfaces:**
- Produces: approved action key, scope, client matrix, mockup override, `FTC-PLAYBACK-LASTFM-013` revision, and new `FTC-PLAYBACK-LASTFM-017` contract.

- [ ] Add the approved `integration.lastfm.scrobbles.submit` registry row with own-account/current-library scope, deployment matrix, server-owned `allowed_actions` projection, and denial cases.
- [ ] Record the current-stack bridge delivery under LF-008/LF-009 without checking the durable roadmap items.
- [ ] Change FTC-001 copy from `Queued` to `Pending`, extend FTC-013 with all three counters, and add FTC-017 for failure alert/log persistence and immediate recovery.
- [ ] Verify the docs contain no unresolved approval language for this delivery and still preserve future durable-job work.

### Task 2: Add Provider Total Read

**Files:**
- Modify: `music_app/services/lastfm.py`
- Modify: `tests/py/test_lastfm_provider_protocol.py`

**Interfaces:**
- Produces: `get_lastfm_total_scrobbles(config: dict[str, Any], *, session: LastfmSession) -> int`.

- [ ] Add failing protocol tests for a valid nonnegative `<user><playcount>` result and missing, invalid, or negative values.
- [ ] Run the exact tests and confirm the expected missing-symbol or wrong-result failures.
- [ ] Implement `user.getInfo` through `_post_lastfm`, passing the captured scoped session username and parsing a nonnegative integer. Raise retryable `LastfmError(error_kind="malformed_response")` for invalid provider data.
- [ ] Run the provider protocol tests and confirm they pass.

### Task 3: Correct Scoped Pending And Manual Retry Semantics

**Files:**
- Modify: `music_app/services/listen_history.py`
- Modify: `music_app/services/listen_history_postgres.py`
- Modify: `music_app/services/lastfm_retry.py`
- Modify: `music_app/services/lastfm_sync_bridge.py`
- Modify: `tests/py/test_listen_history.py`
- Modify: `tests/py/test_lastfm_retry.py`
- Modify: `tests/py/test_settings_measured_retry_account.py`
- Modify: `tests/py/test_settings_scrobble_status_counts.py`

**Interfaces:**
- Produces: `pending_scrobble_count(config, *, account_id=None, library_id=None)`, `retry_pending_lastfm_scrobbles(..., account_id=None, library_id=None, bypass_backoff=False)`, and `process_pending_scrobble_attempt(..., bypass_backoff=False)`.

- [ ] Add failing tests proving exhausted/uncertain/accepted rows do not count as pending, account and library filters cannot leak, and scoped `pending_after` stays scoped.
- [ ] Add failing tests proving `bypass_backoff=True` ignores only time backoff, not reauthentication or terminal guards, and non-attempted failures increment `failed`.
- [ ] Run the exact retry/listen tests and confirm their expected failures.
- [ ] Harden the shared pending predicate and matching scoped SQL.
- [ ] Add paired account/library scope validation and filtering to pending count and retry loading. Replace the global `pending_after` calculation with the scoped count.
- [ ] Thread `bypass_backoff` separately from `reauthenticated`; preserve every duplicate-prevention and terminal-state check.
- [ ] Count `failed` independently from `attempted` in the summary.
- [ ] Run all four focused Python files and confirm they pass.

### Task 4: Add Capability-Gated Status And Submit Routes

**Files:**
- Modify: `music_app/routes/api_wave_b_asgi_routes.py`
- Modify: `music_app/services/private_route_boundary.py`
- Modify: `music_app/routes/admin_asgi.py`
- Modify: `music_app/services/admin_account_creation.py`
- Modify: `music_app/services/log_history.py`
- Modify: `tests/py/test_api_wave_b_asgi_routes.py`
- Modify: `tests/py/test_private_route_boundary.py`
- Modify: `tests/py/test_log_history.py`

**Interfaces:**
- Produces: `GET /utilities/integrations/lastfm/scrobbles` and `POST /utilities/integrations/lastfm/scrobbles/submit`.
- Consumes: Task 2 provider total and Task 3 scoped retry interfaces.

- [ ] Add failing route tests for scoped status success, unavailable provider total, capability denial, disconnected/disabled submission, full success, partial failure, unexpected failure, and safe history fields.
- [ ] Add failing boundary/catalog tests for `integration.lastfm.scrobbles.submit` and a log normalization test for all five aggregate counters.
- [ ] Run the exact route, boundary, and log tests and confirm expected failures.
- [ ] Register the action in the route boundary and account capability catalogs without granting cross-account authority.
- [ ] Implement the best-effort GET response `{ok, scrobbled, pending, lastfm_total, can_submit}` from request-derived scope.
- [ ] Implement the POST result contract. Return success only when `failed == 0` and scoped `pending_after == 0`; otherwise emit a provider-safe response and one scoped `history=True` event.
- [ ] Extend numeric Log History normalization for `attempted`, `succeeded`, `pending_before`, and `pending_after`.
- [ ] Run the focused Python tests and confirm they pass.

### Task 5: Render Counters And Submit In The Live Last.fm Section

**Files:**
- Modify: `music_app/static/js/runtime/core-state-and-helpers.js`
- Modify: `music_app/static/js/runtime/utility-list-builders.js`
- Modify: `music_app/static/js/runtime/utility-loaders-and-cover-lookup.js`
- Modify: `music_app/static/js/runtime/bootstrap-utility-event-handlers.js`
- Modify: `music_app/static/css/runtime/utilities.css`
- Modify: `tests/js/runtime/utility-integration-settings.test.js`
- Generate: `music_app/static/js/runtime-bundle.js`

**Interfaces:**
- Consumes: Task 4 endpoints.
- Produces: semantic stat elements and `[data-submit-lastfm-scrobbles]` action using the shared Button component.

- [ ] Add failing Node tests for the three separate labels, loading/unavailable total, disconnected hiding, pending-zero disabling, and submit-in-flight copy.
- [ ] Add failing handler tests for successful refresh and `showRepairAlert` on failure.
- [ ] Run the exact Node test file and confirm expected failures.
- [ ] Add owned summary/loading/submitting state, fetch summary after Integrations load, and refresh it after connect and Submit.
- [ ] Render the three stat lines and bottom-right shared Submit button. Use `showRepairAlert` for the global bottom-right error and the existing success notification for success.
- [ ] Add only the layout CSS needed to keep Submit at the section's bottom-right; reuse shared Button styling.
- [ ] Run the Node tests, then `npm run build:runtime`, and rerun the bundle/source consistency check.

### Task 6: Extend The Loopback Last.fm Provider

**Files:**
- Modify: `tests/e2e/support/isolatedLibraryApp.py`
- Modify: `tests/e2e/helpers/lastfmProviderHelpers.js`
- Modify: `tests/e2e/helpers/index.js`
- Modify: `tests/py/test_isolated_library_app.py`

**Interfaces:**
- Produces: loopback-only provider state for `playcount` and `scrobble_mode`, a `user.getInfo` response, and helper controls/evidence reads.

- [ ] Add failing fixture tests for `user.getInfo`, accepted scrobble increment, retryable error code 11, loopback-only controls, reset behavior, and evidence redaction.
- [ ] Run the exact fixture tests and confirm expected failures.
- [ ] Add locked provider state with deterministic defaults and controls outside the Album Haven application routes.
- [ ] Handle `user.getInfo` before generic session-key validation; record only safe username/method evidence.
- [ ] Increment provider playcount only on accepted `track.scrobble`; preserve failure mode until reset.
- [ ] Add helper functions that reject non-loopback URLs and reset state in cleanup.
- [ ] Run fixture tests and provider safety/parity checks.

### Task 7: Add Production-Path Playwright Acceptance

**Files:**
- Modify: `tests/e2e/poms/utilityIntegrationsTab.js`
- Modify: `tests/e2e/actions/utilityIntegrationsActions.js`
- Modify: `tests/e2e/specs/lastfmProductionPath.spec.js`
- Modify: `tests/ci/test-data-matrix.json`
- Modify: `tests/ci/functional-shards.json`

**Interfaces:**
- Consumes: Tasks 4-6 production and fixture contracts.
- Produces: updated FTC-013 and new FTC-017 acceptance evidence.

- [ ] Add semantic POM locators for each count, Submit, and the global bottom-right error alert. Keep selectors out of the spec.
- [ ] Add action methods for reading counts and submitting while waiting on the real POST endpoint.
- [ ] Extend FTC-013 with Pending zero and provider total assertions.
- [ ] Add FTC-017 using production playback to create the pending row, then verify failed Submit, alert position, persisted safe Logs entry, provider recovery, immediate backoff bypass, and exactly-once accepted retry.
- [ ] Register FTC-017's owned-mutation database/filesystem/provider contracts in both CI inventories.
- [ ] Run static E2E parity and shard validation.
- [ ] Run the focused Last.fm Playwright project once with one worker. Inspect the rendered state and trace before changing any failed contract.

### Task 8: Reconcile, Review, And Verify

**Files:**
- Modify only files required by validated review findings.

**Interfaces:**
- Consumes: complete delivery diff.
- Produces: focused verification evidence and owner manual test script.

- [ ] Review the complete relevant diff twice for correctness, scope, duplicate prevention, secret handling, capability denial, UI component reuse, test parity, and unnecessary code.
- [ ] Fix every validated finding and repeat a full pass when a substantive finding appears.
- [ ] Run focused Python tests in one pytest process, focused Node tests, runtime bundle validation, static parity/shard checks, and the focused Last.fm Playwright test.
- [ ] Run `git diff --check` and confirm no unrelated saved-loop file entered this delivery.
- [ ] Commit only this delivery's files with a Conventional Commit message.
- [ ] Provide the owner a manual script covering connected counts, unavailable total, pending-zero disabled state, failed Submit alert/Logs, and successful recovery. Wait for manual acceptance before publication and any final functional-E2E acceptance gate that repository policy reserves for post-acceptance execution.

## Plan Self-Review

- Spec coverage: capability, deployment matrix, status semantics, backoff-only override, bottom-right alert, safe Logs, loopback provider, and both acceptance cases map to Tasks 1-7.
- Scope: no schema, React toolchain, durable job, import model, or unrelated refactor.
- Type consistency: route and service names match the design; the provider total remains nullable only at the route/UI boundary.
- Placeholders: none.
