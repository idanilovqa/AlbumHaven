# Cover Preparation Responsiveness Implementation Plan

**Goal:** Keep existing cover preparation responsive and describe its actual state without invented progress or completed scan stages.

**Architecture:** Reuse Starlette's installed `run_in_threadpool` at the ASGI route boundary for the existing synchronous bulk-cover admission/preparation call. Preserve service ownership, locks, generation checks and existing payloads; correct presentation in the existing status helpers and scan-stage rendering.

**Tech Stack:** Python, Starlette, existing cover service, JavaScript runtime modules and generated runtime bundle.

## Owner request and scope

The owner requested correction of cover preparation responsiveness and misleading progress in the current workflow. This is a bug correction within the existing screen, not a new screen, permission model, cover-maintenance composition or client capability. The active cover fetch must remain untouched. Backend deployment is deferred until a verified safe terminal state; completion of source edits is not permission to restart an active worker.

This focused delivery complements `2026-09-24-gallery-performance-and-family-corrections.md`. It does not close that plan's performance, manual acceptance, design, E2E or publication gates.

## Delivery contract

- Outcome: another request can run while bulk-cover preparation is waiting; preparation is labeled honestly; a cover-only operation does not imply discovery, metadata or relations ran.
- Checklist IDs: CPR-1 route responsiveness, CPR-2 preparation presentation, CPR-3 cover-only stage truth, CPR-4 verification and safe activation.
- Prerequisites: existing bulk-cover route, `start_manual_cover_refresh_request`, existing status fields and approved screen/component structure.
- Preserve existing admission locking, already-running rejection, queued-after-indexing behavior, cancellation and scan/cover generation protections. Do not move these decisions into the route or add an executor.
- No API payload, endpoint, status schema, persistence schema, permission or deployment-mode changes.
- Preserve existing scan-stage behavior for genuine scans. Keep unrelated dirty work outside this delivery's review and staging scope.

## Files and responsibilities

- `music_app/routes/api_wave_d_asgi_routes.py`: await the existing threadpool helper around `start_manual_cover_refresh_request` with unchanged arguments and response construction.
- `music_app/services/cover_refresh_runtime.py`: existing admission and worker ownership; inspect for compatibility, with no service rewrite planned.
- `music_app/static/js/runtime/loader-status-helpers.js`: use “Preparing cover search” for the preparing phase; do not manufacture percentage or ETA from stale/unknown totals.
- `music_app/static/js/runtime/status-ui-helpers.js`: preparation-specific indicator tooltip without fabricated `0 / 0` completed counts; preserve numeric fetching progress.
- `music_app/static/js/runtime/core-state-and-helpers.js`: keep non-cover stages inactive for cover-only operations; preserve normal scan transitions and preparing headline.
- `music_app/static/css/runtime/cover-lookup-drawer-and-related.css`: use the existing phase guide's inactive appearance.
- `music_app/static/js/runtime/gallery-refresh-and-status.js`: allow matching preparation elapsed-time updates during pending admission without accepting stale idle status or superseded action reads; keep polling scheduled.
- `music_app/static/js/runtime/utility-loaders-and-cover-lookup.js`: publish the optimistic preparing state and begin status polling before admission responds.
- `music_app/static/js/runtime-bundle.js`: regenerate using the existing build command after source changes; never hand-edit.
- `tests/py/test_api_wave_d_asgi_routes.py`: deterministic concurrent-request regression using held preparation and a second API request.
- `tests/js/runtime/library-cover-progress.test.js`, `tests/js/runtime/status-request-ownership.test.js`, `tests/js/runtime/library-scan-full-page.test.js`: preparation copy/count semantics, polling ownership and stage-state regressions.

## Implementation and acceptance checklist

- [ ] CPR-1: Establish a failing concurrent-request regression, then reuse `await run_in_threadpool(start_manual_cover_refresh_request, ...)` at the existing route boundary. Retain the awaited response and exception handling. Verify another API request completes while preparation is held; release and join all test-owned work.
- [ ] CPR-2: Establish failing preparation presentation cases with nonzero stale totals/ETA. Show “Preparing cover search” and omit percentage/ETA until the phase provides meaningful progress. Preserve real elapsed time and separately reported downloaded-cover counts; retain failure, cancellation and connection-loss states.
- [ ] CPR-3: Establish failing cover-only stage cases. Discovery, metadata and relations remain inactive; only the actual cover stage is active. Verify genuine scan stages still transition normally.
- [x] CPR-4: Run the focused checks below under the single-pytest-process rule, rebuild the runtime, and complete at least two full relevant-diff review passes. Validate and repair all findings before broader review.

Focused commands, run by the implementation owner after coordinating pytest ownership:

```powershell
python -m pytest tests/py/test_api_wave_d_asgi_routes.py -k bulk_cover_preparation_does_not_block_cover_lookup_api
node --test --test-concurrency=1 tests/js/runtime/library-cover-progress.test.js tests/js/runtime/status-request-ownership.test.js tests/js/runtime/library-scan-full-page.test.js
```

Expected: the new cases fail before their respective correction and pass afterward; existing focused cases remain green. A focused pass does not establish production performance or release acceptance.

## Compatibility, rollback and checkpoint

Existing callers receive the same response shape and await the same preparation result. The scheduling boundary changes, not admission semantics. UI changes consume existing fields. No migration is required. Rollback restores only this delivery's route scheduling, status presentation and generated bundle; unrelated work remains intact.

Static UI assets may be rebuilt and activated without restarting the backend or touching the active fetch. Before backend activation, prove the active fetch reached a safe terminal state, then follow the deployment runbook with this actual worktree. Do not cancel or restart the active fetch merely to test the correction. After backend activation, manually verify responsive status/lookup requests during preparation, truthful preparation copy and inactive non-cover stages, followed by ordinary progress and terminal-state rendering.

Merge/publish checkpoint: retain manual acceptance and all applicable hosted review, complete CI, security and release gates. Record evidence and exact delivered scope before publication. An accumulated branch requires a safe split plan; this document does not authorize publishing unrelated changes. Implementation, tests, manual activation and release are unverified when this plan is created.

## Verification evidence

The implementation owner reports three focused Python cases and 104 focused JavaScript cases passing. The second review found the indicator tooltip still displayed `0 / 0` completed searches during preparation. A focused regression reproduced that finding before the preparation-specific tooltip correction and passed afterward. The documentation/review worker did not rerun tests.

The implementation owner rebuilt the 77-module runtime bundle and reports successful syntax verification. A root-agent HTTP GET of `http://localhost:5003/static/js/runtime-bundle.js` returned 200 and confirmed the served bundle contains preparing, inactive-stage and pending-polling code. The root agent also verified the generated bundle matches the sources and that served CSS returned HTTP 200 with `li.is-inactive`. These checks prove static asset delivery, not browser visual verification or backend activation. The final full third review pass cleared the complete scoped diff after the tooltip repair; local review reconciliation is complete. Manual acceptance, backend activation, complete CI and publication remain open.

Exact changed files for this correction (some also contain unrelated preexisting changes, which are excluded from this slice):

- `docs/superpowers/plans/2026-10-07-cover-preparation-responsiveness.md`
- `music_app/routes/api_wave_d_asgi_routes.py`
- `music_app/static/css/runtime/cover-lookup-drawer-and-related.css`
- `music_app/static/js/runtime/core-state-and-helpers.js`
- `music_app/static/js/runtime/gallery-refresh-and-status.js` (preparation polling only)
- `music_app/static/js/runtime/loader-status-helpers.js`
- `music_app/static/js/runtime/status-ui-helpers.js` (preparation tooltip only)
- `music_app/static/js/runtime/utility-loaders-and-cover-lookup.js`
- `music_app/static/js/runtime-bundle.js` (generated changes corresponding to this correction)
- `tests/py/test_api_wave_d_asgi_routes.py`
- `tests/js/runtime/library-cover-progress.test.js`
- `tests/js/runtime/status-request-ownership.test.js` (preparation cases only)
- `tests/js/runtime/library-scan-full-page.test.js`

Task timing and skill/process overhead were not recorded; no elapsed-time estimate is asserted.
