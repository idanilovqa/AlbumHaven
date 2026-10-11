# Problematic Files regression checks

Run these checks immediately after relevant changes, before handoff. See the
mandatory gate in `AGENTS.md`. Execute stages serially; do not overlap Python,
Node, or browser runs. Full release CI remains required.

## Database and API

Use the existing isolated PostgreSQL provisioning workflow. Set
`ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL` and its validated setup credentials
to that isolated database, never a sandbox or production database. The physical
SQL tests skip without it; a skipped test does not satisfy this gate.

```powershell
python -m pytest tests/py/test_library_browse_postgres.py tests/py/test_api_read_asgi_routes.py -k problematic -q
python -m pytest tests/py/test_multi_root_duplicates.py tests/py/test_problematic_albums.py tests/py/test_problematic_detail_identity.py tests/py/test_problematic_physical_files_postgres.py tests/py/test_problematic_file_projection_migration_postgres.py -q
```

Check bounded candidate hydration, one read snapshot, compact summary/detail
separation, cache misses, single-flight invalidation, and indexed physical-folder
reads. Keep real SQL EXPLAIN checks; mocked row fixtures cannot prove query cost.

## JavaScript and components

```powershell
node --test --test-concurrency=1 tests/js/runtime/utility-problematic-load-diagnostics.test.js tests/js/runtime/utility-problematic-tab.test.js tests/js/runtime/problematic-files-virtual-list.test.js tests/js/runtime/utility-problematic-focused-track-render.test.js tests/js/runtime/problem-exclusion-mutations.test.js tests/js/problematic-payload-evidence.test.js tests/js/performance-change-impact.test.js tests/js/e2e-performance-helper-guards.test.js
npx playwright test problematicFilesVirtualFocus.spec.js --config=playwright.component.config.js --workers=1
```

Require bounded first-page painting, complete-list reconciliation, obsolete
request protection, reused initial detail, error handling, and bounded virtual
rows with stable focus. Payload guards must inspect every row, not only row one.

## Real application

Run the `problematic-files` functional area through the exact cases in
`tests/ci/functional-shards.json`, using `scripts/run-functional-e2e-local.ps1`.
Also retain settings-shell and tag-edit integration cases affecting this surface.

Run both existing measured targets against the approved
`utility-problematic-files` fixture profile using
`scripts/ci/run-performance-shard.ps1 -Targets utility-problematic-files,problematic-files-focused`
with the normal isolated database, fixture, browser, and output arguments.
Alternatively, in an already provisioned supported performance environment:

```powershell
npm run test:e2e:performance -- --test utility-problematic-files --headless --performance-contract local
npm run test:e2e:performance -- --test problematic-files-focused --headless --performance-contract local
```

Both targets are required even when one fails. Preserve reports and traces.
Verify cold and warm loading, compact bounded and full summaries, exactly one
request for each summary phase, no redundant initial-detail request, populated
visible detail, searching/filtering, and scrolling. Retain the approved readiness
budget of 1000 ms plus 200 ms grace and all other existing benchmark budgets.
A shell appearing without usable content is not readiness.

The CI change-impact contract selects both targets for PF dependencies. Update
that mapping and its tests whenever ownership moves. No setup error, skipped
suite, narrower test selection, or repeated run replaces a failed measurement.
