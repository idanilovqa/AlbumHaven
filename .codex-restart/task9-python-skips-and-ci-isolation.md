# Task 9 Python skip policy and CI database isolation follow-up

Read-only diagnosis of `.codex-restart/task9-full-python.log`: 4728 passed, 102 failed, 88 errors, 8 skipped. No additional pytest invocation. Initial full functional/performance inventory remains the prerequisite for production/test fixes.

## Eight skips

The log lacks `-rs`, but its per-file progress identifies four skips in `test_cover_lookup_live_provider_smoke.py`, one in `test_postgres_structural_tag_edit.py`, and three in `test_problematic_file_projection_migration_postgres.py`. Source has exactly the matching skip gates.

Allowed by `tests/ci/pytest-allowed-skips.json` (four parameterizations):

- `test_cover_lookup_live_provider_smoke.py::test_live_music_service_cover_lookup_smoke_logs_duration_and_returns_candidates[apple-Apple Music]`
- `test_cover_lookup_live_provider_smoke.py::test_live_music_service_cover_lookup_smoke_logs_duration_and_returns_candidates[deezer-Deezer]`
- `test_cover_lookup_live_provider_smoke.py::test_live_music_service_cover_lookup_smoke_logs_duration_and_returns_candidates[youtube_music-YouTube Music]`
- `test_cover_lookup_live_provider_smoke.py::test_live_music_service_cover_lookup_smoke_logs_duration_and_returns_candidates[spotify-Spotify]`

Source line 10 skips unless `ALBUM_HAVEN_RUN_LIVE_PROVIDER_TESTS=1`; the exact reason is `Set ALBUM_HAVEN_RUN_LIVE_PROVIDER_TESTS=1 to run live provider smoke tests.` The policy matches only these node IDs and this reason. These are intentional external-service opt-in checks.

Not allowed (four missing local setup prerequisites):

- `test_postgres_structural_tag_edit.py::test_live_postgres_blank_album_restore_preserves_mixed_track_identity_and_atomicity` (739): `_isolated_runtime_database_url_or_skip` (701) requires `ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL`; the subsequent setup check also requires `ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL`.
- `test_problematic_file_projection_migration_postgres.py::test_problematic_file_projection_migration_upgrades_and_reruns_idempotently` (109): setup URL required by helper at 48.
- `test_problematic_file_projection_migration_postgres.py::test_problematic_text_candidate_function_matches_python_strong_signal_contract` (210): same setup helper.
- `test_problematic_file_projection_migration_postgres.py::test_album_haven_app_upsert_executes_generated_candidate_function` (239): runtime URL required by helper at 67, then setup URL.

Both SCAN_PERFORMANCE environment keys are absent from the saved session env file used by `.codex-restart/task9-unit-inventory.py`, and absent in the inspected current environment. The runner adds only CONTRACT, not either scan alias. Psycopg was available to hundreds of live tests. Thus these four skips are setup gaps, not exemptions to add. Restore both explicit aliases to the destructive migration-test database before the final run. Preserve the existing strict database/role safety checks. Run the existing JUnit allowed-skip validator on final local evidence too; do not accept a green pytest process with unapproved skips.

## CI isolation must accompany local isolation

`.github/workflows/pr-gates.yml` Python job provisions one database (approximately 255), exports SCAN_PERFORMANCE setup/runtime and CONTRACT from that same database (275), executes pytest with JUnit, validates skips (296), and tears down that one state file under `always()` (300).

The 88 new contract setup errors are a separate lifecycle conflict: existing migration tests intentionally drop/reset app/integration/library/ops on FAKE_E2E, while new contract fixtures assume their pre-migrated CONTRACT database survives and use `DATABASE_MIGRATOR_URL` for setup. Those aliases currently resolve to the same database. See `task9-python-failure-triage.md` for exact failing nodes and destructive owners.

Required bounded repair, both CI and local runner:

1. Provision two unique, task-owned databases using the existing bootstrap contract and distinct suffixes/state files: a destructive migration-test database and a pre-migrated application-contract database. Keep the manual app database completely separate.
2. Map FAKE_E2E setup/runtime and both SCAN_PERFORMANCE aliases to the destructive database. Map DATABASE_MIGRATOR_URL, DATABASE_APP_URL, ALBUM_HAVEN_APP_DATABASE_URL, DATABASE_READONLY_URL and CONTRACT to the application-contract database. Audit other consumers before finalizing aliases; do not merely change CONTRACT while its fixture setup still reads global DATABASE_MIGRATOR_URL.
3. Preserve credentials for both database/role sets in one protected, task-owned pgpass file, or use an equally explicit supported per-connection mechanism. Never print its contents. The bootstrap exports PGPASSFILE and all global/FAKE_E2E aliases and overwrites its process environment (script 133-141 and 458-475), so a second invocation alone silently replaces the first mapping and pgpass selection. Capture both provisioned contracts privately and write final explicit alias mappings after both complete.
4. Use separate `always()` teardown steps for both state files, so failure of one cleanup does not prevent the other; include partial-provision failure handling. The bootstrap teardown removes its own pgpass and state files (505-506). A separately combined pgpass file needs its own exact-path cleanup after both database teardowns. Do not share state paths or delete unrelated databases, roles, files, or process trees.
5. Keep application contracts on uniquely owned rows and existing exact-row cleanup. Keep destructive schema-reset tests on their dedicated database. Migration ledger replay repair is independently required and must preserve applied checksums.
6. Verify workflow/bootstrap contract tests, collect every required initial suite first, then perform focused repair verification and final complete suites under this same isolation and skip policy. No current CI or runner implementation has been changed by this diagnosis.
