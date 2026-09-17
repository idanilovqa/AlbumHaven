# Task9 initial Python failure triage

Initial complete inventory: **4728 passed, 102 failed, 88 setup errors, 8 skipped in 499.52 seconds**. Evidence: `.codex-restart/task9-full-python.log`. Read-only diagnosis; no test or production fixes/reruns during inventory.

## Setup errors: confirmed shared-database lifecycle conflict (88)

All four configured migrator/app and fake-E2E setup/runtime URLs identify the same database (checked as booleans without exposing credentials). Existing migration tests, including test_lastfm_session_conflict_identity_migration_postgres.py, deliberately drop app/integration/library/ops during cleanup. Later new log_store/scoped_store/ledger fixtures assume preapplied schemas and fail inserting app.accounts. Provision a separate uniquely owned migrated contract database for these fixtures, with exact scoped-row cleanup; keep destructive migration tests on their own existing test database. Do not use the manual database, broaden schema deletion, or skip tests.

- `tests/py/test_log_history_postgres.py`: 9 setup errors.
- `tests/py/test_log_history_read_consistency.py`: 2 setup errors.
- `tests/py/test_log_history_retry_persistence.py`: 2 setup errors.
- `tests/py/test_loop_reorder.py`: 26 setup errors.
- `tests/py/test_settings_lastfm_account_credentials.py`: 1 setup errors.
- `tests/py/test_settings_loop_style_postgres.py`: 8 setup errors.
- `tests/py/test_settings_measured_listen_ledger.py`: 25 setup errors.
- `tests/py/test_settings_measured_provider_receipts.py`: 4 setup errors.
- `tests/py/test_settings_measured_retry_account.py`: 4 setup errors.
- `tests/py/test_settings_measured_statistics.py`: 1 setup errors.
- `tests/py/test_settings_scoped_root_persistence.py`: 3 setup errors.
- `tests/py/test_settings_scrobble_status_counts.py`: 3 setup errors.

## Failed assertions and calls (102)

The two navigation asset cases are confirmed product regressions; four migration replay cases are infrastructure failures; two real database behavior cases remain unresolved product/contract candidates requiring focused reproduction after isolation repair. The other 94 failures have stale fixture/projection/dependency evidence; subsequent focused runs must retain their original behavioral assertions.

### 1. `tests/py/test_admin_members_asgi.py::test_owner_role_projects_all_inherited_permissions_and_submittable_values`

**Stale fixture / approved contract.** Permission catalog now has14 rows vs hardcoded12; add approved loop-create/log-export keys while preserving role/editability and exact submitted permissions.

### 2. `tests/py/test_admin_members_asgi.py::test_nonowner_role_remains_listener_with_editable_explicit_permissions[/admin/accounts/41-selected_keys0]`

**Stale fixture / approved contract.** Permission catalog now has14 rows vs hardcoded12; add approved loop-create/log-export keys while preserving role/editability and exact submitted permissions.

### 3. `tests/py/test_admin_members_asgi.py::test_nonowner_role_remains_listener_with_editable_explicit_permissions[/admin/accounts/new-selected_keys1]`

**Stale fixture / approved contract.** Permission catalog now has14 rows vs hardcoded12; add approved loop-create/log-export keys while preserving role/editability and exact submitted permissions.

### 4. `tests/py/test_api_read_asgi_routes.py::test_asgi_status_route_preserves_current_payload_shape`

**Stale fixture / approved contract.** Fixture has no trusted current-library scope; log_history_revision is empty fail-closed rather than old process epoch:counter. Supply scoped actor/revision owner and assert scoped token.

### 5. `tests/py/test_api_read_asgi_routes.py::test_asgi_utility_read_routes_preserve_payloads_statuses_and_problematic_fallback_without_flask_bridge`

**Stale fixture / approved contract.** Minimal logger lacks warning while persisted watcher-health/read path fails; provide proper fake logger and authorized scoped history/loop dependencies.

### 6. `tests/py/test_api_read_asgi_routes.py::test_asgi_loops_and_log_history_use_asgi_config_without_flask_bridge`

**Stale fixture / approved contract.** Routes now require valid current actor/library. Old no-actor/transient-history fixtures receive403. Supply trusted scope and replace obsolete process-only history expectation with scoped persisted snapshot.

### 7. `tests/py/test_api_read_asgi_routes.py::test_asgi_log_history_returns_non_cacheable_empty_transient_snapshot`

**Stale fixture / approved contract.** Routes now require valid current actor/library. Old no-actor/transient-history fixtures receive403. Supply trusted scope and replace obsolete process-only history expectation with scoped persisted snapshot.

### 8. `tests/py/test_api_read_asgi_routes.py::test_asgi_problematic_files_use_postgres_repository_without_fixture_env_or_runtime_hydration`

**Stale fixture / approved contract.** Actual projection now includes operational_items and watcher_health warning; align expected projection and provide watcher-health dependency without restoring old payload omission.

### 9. `tests/py/test_api_wave_a_asgi_routes.py::test_asgi_library_settings_routes_preserve_read_and_validation_payloads`

**Stale fixture / approved contract.** New root read/write requires valid current actor, both current-host binding and explicit scoped store. Old fixture reaches403 before intended read/validation. Supply exact authorized host/library mocks; retain overlap/scan/write assertions.

### 10. `tests/py/test_api_wave_a_asgi_routes.py::test_asgi_library_settings_read_uses_asgi_config_without_flask_bridge`

**Stale fixture / approved contract.** New root read/write requires valid current actor, both current-host binding and explicit scoped store. Old fixture reaches403 before intended read/validation. Supply exact authorized host/library mocks; retain overlap/scan/write assertions.

### 11. `tests/py/test_api_wave_a_asgi_routes.py::test_asgi_library_settings_write_uses_asgi_state_without_bridge_context`

**Stale fixture / approved contract.** New root read/write requires valid current actor, both current-host binding and explicit scoped store. Old fixture reaches403 before intended read/validation. Supply exact authorized host/library mocks; retain overlap/scan/write assertions.

### 12. `tests/py/test_api_wave_a_asgi_routes.py::test_asgi_library_settings_post_persists_settings_and_starts_refresh`

**Stale fixture / approved contract.** New root read/write requires valid current actor, both current-host binding and explicit scoped store. Old fixture reaches403 before intended read/validation. Supply exact authorized host/library mocks; retain overlap/scan/write assertions.

### 13. `tests/py/test_api_wave_a_asgi_routes.py::test_asgi_library_settings_post_rejects_overlapping_roots`

**Stale fixture / approved contract.** New root read/write requires valid current actor, both current-host binding and explicit scoped store. Old fixture reaches403 before intended read/validation. Supply exact authorized host/library mocks; retain overlap/scan/write assertions.

### 14. `tests/py/test_api_wave_a_asgi_routes.py::test_asgi_library_settings_write_returns_scan_blocked_without_bridge_context`

**Stale fixture / approved contract.** New root read/write requires valid current actor, both current-host binding and explicit scoped store. Old fixture reaches403 before intended read/validation. Supply exact authorized host/library mocks; retain overlap/scan/write assertions.

### 15. `tests/py/test_api_wave_a_asgi_routes.py::test_asgi_ignore_album_version_uses_asgi_dependencies_without_flask_context`

**Stale fixture / approved contract.** Finalizer builder now captures immutable history_scope; expected exact kwargs omit it. Add explicit scope owner and preserve all mutation/logging assertions.

### 16. `tests/py/test_api_wave_a_asgi_routes.py::test_asgi_mark_album_version_uses_asgi_state_aliases_and_logging_without_flask_context`

**Stale fixture / approved contract.** Finalizer builder now captures immutable history_scope; expected exact kwargs omit it. Add explicit scope owner and preserve all mutation/logging assertions.

### 17. `tests/py/test_api_wave_a_asgi_routes.py::test_asgi_unmark_album_version_uses_asgi_config_and_logging_without_flask_context`

**Stale fixture / approved contract.** Finalizer builder now captures immutable history_scope; expected exact kwargs omit it. Add explicit scope owner and preserve all mutation/logging assertions.

### 18. `tests/py/test_api_wave_a_asgi_routes.py::test_selected_postgres_media_compensation_is_path_scoped_and_restores_exception`

**Stale fixture / approved contract.** Direct finalizer uses object/SimpleNamespace request lacking state when capturing history scope. Provide realistic request plus scoped actor resolver; retain path-scoped compensation/projection assertions.

### 19. `tests/py/test_api_wave_a_asgi_routes.py::test_selected_postgres_album_edit_skips_unrelated_relation_projection_rebuild`

**Stale fixture / approved contract.** Direct finalizer uses object/SimpleNamespace request lacking state when capturing history scope. Provide realistic request plus scoped actor resolver; retain path-scoped compensation/projection assertions.

### 20. `tests/py/test_api_wave_b_asgi_routes.py::test_asgi_integrations_and_foobar_asset_routes_preserve_payload_and_file_headers`

**Stale fixture / approved contract.** Authenticated integration/provider routes now require actual actor/library and account-owned credential. Old fixtures receive403/KeyError before intended branch. Supply scope-aware dependencies; retain validation, safe logging and side-effect assertions.

### 21. `tests/py/test_api_wave_b_asgi_routes.py::test_asgi_integrations_lastfm_enrichment_uses_route_sources`

**Stale fixture / approved contract.** Authenticated integration/provider routes now require actual actor/library and account-owned credential. Old fixtures receive403/KeyError before intended branch. Supply scope-aware dependencies; retain validation, safe logging and side-effect assertions.

### 22. `tests/py/test_api_wave_b_asgi_routes.py::test_asgi_lastfm_and_playback_routes_preserve_validation_side_effects`

**Stale fixture / approved contract.** Authenticated integration/provider routes now require actual actor/library and account-owned credential. Old fixtures receive403/KeyError before intended branch. Supply scope-aware dependencies; retain validation, safe logging and side-effect assertions.

### 23. `tests/py/test_api_wave_b_asgi_routes.py::test_asgi_lastfm_settings_disconnects_saved_session`

**Stale fixture / approved contract.** Authenticated integration/provider routes now require actual actor/library and account-owned credential. Old fixtures receive403/KeyError before intended branch. Supply scope-aware dependencies; retain validation, safe logging and side-effect assertions.

### 24. `tests/py/test_api_wave_b_asgi_routes.py::test_asgi_lastfm_settings_authenticates_and_saves_session`

**Stale fixture / approved contract.** Authenticated integration/provider routes now require actual actor/library and account-owned credential. Old fixtures receive403/KeyError before intended branch. Supply scope-aware dependencies; retain validation, safe logging and side-effect assertions.

### 25. `tests/py/test_api_wave_b_asgi_routes.py::test_asgi_lastfm_settings_records_safe_history_when_provider_rejects_connection`

**Stale fixture / approved contract.** Authenticated integration/provider routes now require actual actor/library and account-owned credential. Old fixtures receive403/KeyError before intended branch. Supply scope-aware dependencies; retain validation, safe logging and side-effect assertions.

### 26. `tests/py/test_api_wave_b_asgi_routes.py::test_asgi_lastfm_settings_records_safe_history_before_reraising_unexpected_connection_error`

**Stale fixture / approved contract.** Authenticated integration/provider routes now require actual actor/library and account-owned credential. Old fixtures receive403/KeyError before intended branch. Supply scope-aware dependencies; retain validation, safe logging and side-effect assertions.

### 27. `tests/py/test_api_wave_b_asgi_routes.py::test_asgi_lastfm_settings_preserves_original_error_when_history_and_diagnostic_logging_fail`

**Stale fixture / approved contract.** Authenticated integration/provider routes now require actual actor/library and account-owned credential. Old fixtures receive403/KeyError before intended branch. Supply scope-aware dependencies; retain validation, safe logging and side-effect assertions.

### 28. `tests/py/test_api_wave_b_asgi_routes.py::test_asgi_lastfm_settings_saves_and_validates_timezone`

**Stale fixture / approved contract.** Authenticated integration/provider routes now require actual actor/library and account-owned credential. Old fixtures receive403/KeyError before intended branch. Supply scope-aware dependencies; retain validation, safe logging and side-effect assertions.

### 29. `tests/py/test_api_wave_b_asgi_routes.py::test_asgi_lastfm_settings_requires_username_and_password`

**Stale fixture / approved contract.** Authenticated integration/provider routes now require actual actor/library and account-owned credential. Old fixtures receive403/KeyError before intended branch. Supply scope-aware dependencies; retain validation, safe logging and side-effect assertions.

### 30. `tests/py/test_api_wave_b_asgi_routes.py::test_asgi_lastfm_playback_mutations_reject_invalid_json_payloads[headers0-{-/utilities/integrations/lastfm]`

**Stale fixture / approved contract.** Authenticated integration/provider routes now require actual actor/library and account-owned credential. Old fixtures receive403/KeyError before intended branch. Supply scope-aware dependencies; retain validation, safe logging and side-effect assertions.

### 31. `tests/py/test_api_wave_b_asgi_routes.py::test_asgi_lastfm_playback_mutations_reject_invalid_json_payloads[headers1-{-/utilities/integrations/lastfm]`

**Stale fixture / approved contract.** Authenticated integration/provider routes now require actual actor/library and account-owned credential. Old fixtures receive403/KeyError before intended branch. Supply scope-aware dependencies; retain validation, safe logging and side-effect assertions.

### 32. `tests/py/test_api_wave_b_asgi_routes.py::test_asgi_lastfm_playback_mutations_reject_invalid_json_payloads[headers2-"not-an-object"-/utilities/integrations/lastfm]`

**Stale fixture / approved contract.** Authenticated integration/provider routes now require actual actor/library and account-owned credential. Old fixtures receive403/KeyError before intended branch. Supply scope-aware dependencies; retain validation, safe logging and side-effect assertions.

### 33. `tests/py/test_api_wave_b_asgi_routes.py::test_asgi_playback_session_scrobble_logs_success_history_entry`

**Stale fixture / approved contract.** Authenticated integration/provider routes now require actual actor/library and account-owned credential. Old fixtures receive403/KeyError before intended branch. Supply scope-aware dependencies; retain validation, safe logging and side-effect assertions.

### 34. `tests/py/test_api_wave_b_asgi_routes.py::test_asgi_playback_session_scrobble_reports_disconnected_no_send`

**Stale fixture / approved contract.** Authenticated integration/provider routes now require actual actor/library and account-owned credential. Old fixtures receive403/KeyError before intended branch. Supply scope-aware dependencies; retain validation, safe logging and side-effect assertions.

### 35. `tests/py/test_api_wave_b_asgi_routes.py::test_asgi_playback_session_complete_persists_listen_history`

**Stale fixture / approved contract.** Authenticated completion intentionally rejects unversioned old payload400; use valid rendered-pcm-v1 payload/ledger scope and own credential, retain successful persistence assertion.

### 36. `tests/py/test_api_wave_d_asgi_routes.py::test_asgi_cover_lookup_gallery_validation_and_start_queue`

**Stale fixture / approved contract.** Optional history capture now resolves request actor; minimal ASGI fixture lacks auth_policy_config/current actor and falls into environment bootstrap config, raising missing username. Supply valid request actor/resolver and immutable history scope, not machine credentials.

### 37. `tests/py/test_api_wave_d_asgi_routes.py::test_asgi_cover_lookup_local_cover_actions_update_asgi_state_without_flask_bridge`

**Stale fixture / approved contract.** Optional history capture now resolves request actor; minimal ASGI fixture lacks auth_policy_config/current actor and falls into environment bootstrap config, raising missing username. Supply valid request actor/resolver and immutable history scope, not machine credentials.

### 38. `tests/py/test_api_wave_d_asgi_routes.py::test_asgi_local_cover_selection_persists_before_success_and_logs_safe_completion`

**Stale fixture / approved contract.** Optional history capture now resolves request actor; minimal ASGI fixture lacks auth_policy_config/current actor and falls into environment bootstrap config, raising missing username. Supply valid request actor/resolver and immutable history scope, not machine credentials.

### 39. `tests/py/test_api_wave_d_asgi_routes.py::test_asgi_local_cover_selection_persistence_failure_restores_prior_cover_and_removes_reserve_artifact`

**Stale fixture / approved contract.** Optional history capture now resolves request actor; minimal ASGI fixture lacks auth_policy_config/current actor and falls into environment bootstrap config, raising missing username. Supply valid request actor/resolver and immutable history scope, not machine credentials.

### 40. `tests/py/test_api_wave_d_asgi_routes.py::test_asgi_local_cover_revision_failure_after_promotion_restores_prior_cover_before_persistence`

**Stale fixture / approved contract.** Optional history capture now resolves request actor; minimal ASGI fixture lacks auth_policy_config/current actor and falls into environment bootstrap config, raising missing username. Supply valid request actor/resolver and immutable history scope, not machine credentials.

### 41. `tests/py/test_api_wave_d_asgi_routes.py::test_asgi_local_cover_selection_runtime_refresh_failure_keeps_committed_success_and_logs_safely`

**Stale fixture / approved contract.** Optional history capture now resolves request actor; minimal ASGI fixture lacks auth_policy_config/current actor and falls into environment bootstrap config, raising missing username. Supply valid request actor/resolver and immutable history scope, not machine credentials.

### 42. `tests/py/test_api_wave_d_asgi_routes.py::test_asgi_local_cover_selection_runtime_fallback_repairs_live_state_before_success`

**Stale fixture / approved contract.** Optional history capture now resolves request actor; minimal ASGI fixture lacks auth_policy_config/current actor and falls into environment bootstrap config, raising missing username. Supply valid request actor/resolver and immutable history scope, not machine credentials.

### 43. `tests/py/test_api_wave_d_asgi_routes.py::test_asgi_local_cover_selection_requeues_interrupted_manual_full_rescan`

**Stale fixture / approved contract.** Optional history capture now resolves request actor; minimal ASGI fixture lacks auth_policy_config/current actor and falls into environment bootstrap config, raising missing username. Supply valid request actor/resolver and immutable history scope, not machine credentials.

### 44. `tests/py/test_api_wave_d_asgi_routes.py::test_asgi_local_cover_selection_expands_partial_payload_to_full_live_album`

**Stale fixture / approved contract.** Optional history capture now resolves request actor; minimal ASGI fixture lacks auth_policy_config/current actor and falls into environment bootstrap config, raising missing username. Supply valid request actor/resolver and immutable history scope, not machine credentials.

### 45. `tests/py/test_api_wave_d_asgi_routes.py::test_asgi_local_cover_selection_persistence_failure_is_safe_and_never_reports_success`

**Stale fixture / approved contract.** Optional history capture now resolves request actor; minimal ASGI fixture lacks auth_policy_config/current actor and falls into environment bootstrap config, raising missing username. Supply valid request actor/resolver and immutable history scope, not machine credentials.

### 46. `tests/py/test_api_wave_d_asgi_routes.py::test_asgi_local_cover_selection_log_history_failure_never_masks_persistence_outcome[False-200]`

**Stale fixture / approved contract.** Optional history capture now resolves request actor; minimal ASGI fixture lacks auth_policy_config/current actor and falls into environment bootstrap config, raising missing username. Supply valid request actor/resolver and immutable history scope, not machine credentials.

### 47. `tests/py/test_api_wave_d_asgi_routes.py::test_asgi_local_cover_selection_log_history_failure_never_masks_persistence_outcome[True-500]`

**Stale fixture / approved contract.** Optional history capture now resolves request actor; minimal ASGI fixture lacks auth_policy_config/current actor and falls into environment bootstrap config, raising missing username. Supply valid request actor/resolver and immutable history scope, not machine credentials.

### 48. `tests/py/test_api_wave_d_asgi_routes.py::test_asgi_cover_lookup_local_select_delete_and_pasted_image_validation`

**Stale fixture / approved contract.** Optional history capture now resolves request actor; minimal ASGI fixture lacks auth_policy_config/current actor and falls into environment bootstrap config, raising missing username. Supply valid request actor/resolver and immutable history scope, not machine credentials.

### 49. `tests/py/test_api_wave_d_asgi_routes.py::test_asgi_cover_lookup_add_remote_merges_existing_candidates_and_remote_image_fetch`

**Stale fixture / approved contract.** Optional history capture now resolves request actor; minimal ASGI fixture lacks auth_policy_config/current actor and falls into environment bootstrap config, raising missing username. Supply valid request actor/resolver and immutable history scope, not machine credentials.

### 50. `tests/py/test_api_wave_d_asgi_routes.py::test_asgi_cover_refresh_routes_preserve_manual_payloads_and_cancel_status`

**Stale fixture / approved contract.** Optional history capture now resolves request actor; minimal ASGI fixture lacks auth_policy_config/current actor and falls into environment bootstrap config, raising missing username. Supply valid request actor/resolver and immutable history scope, not machine credentials.

### 51. `tests/py/test_api_wave_d_asgi_routes.py::test_asgi_cover_refresh_manual_single_returns_500_on_refresh_failure`

**Stale fixture / approved contract.** Optional history capture now resolves request actor; minimal ASGI fixture lacks auth_policy_config/current actor and falls into environment bootstrap config, raising missing username. Supply valid request actor/resolver and immutable history scope, not machine credentials.

### 52. `tests/py/test_app_factory.py::test_create_asgi_app_lifespan_starts_retry_worker_and_shutdown`

**Stale fixture / approved contract.** Lifespan now constructs targeted reconciler via select_scan_cache_adapter; unit config intentionally has no DB or placeholder localhost URL. Stub owned startup repository/reconciler seam (and host binding where needed), preserving shutdown ordering and safe-config assertions. Do not connect placeholder URLs.

### 53. `tests/py/test_app_factory.py::test_create_asgi_app_lifespan_gates_startup_on_relation_projection_readiness`

**Stale fixture / approved contract.** Lifespan now constructs targeted reconciler via select_scan_cache_adapter; unit config intentionally has no DB or placeholder localhost URL. Stub owned startup repository/reconciler seam (and host binding where needed), preserving shutdown ordering and safe-config assertions. Do not connect placeholder URLs.

### 54. `tests/py/test_app_factory.py::test_create_asgi_app_lifespan_marks_empty_startup_scan_pending_without_starting_it`

**Stale fixture / approved contract.** Lifespan now constructs targeted reconciler via select_scan_cache_adapter; unit config intentionally has no DB or placeholder localhost URL. Stub owned startup repository/reconciler seam (and host binding where needed), preserving shutdown ordering and safe-config assertions. Do not connect placeholder URLs.

### 55. `tests/py/test_app_factory.py::test_create_asgi_app_lifespan_schedules_only_incomplete_hydrated_metadata_repair[True-expected_scan_calls0]`

**Stale fixture / approved contract.** Lifespan now constructs targeted reconciler via select_scan_cache_adapter; unit config intentionally has no DB or placeholder localhost URL. Stub owned startup repository/reconciler seam (and host binding where needed), preserving shutdown ordering and safe-config assertions. Do not connect placeholder URLs.

### 56. `tests/py/test_app_factory.py::test_create_asgi_app_lifespan_schedules_only_incomplete_hydrated_metadata_repair[False-expected_scan_calls1]`

**Stale fixture / approved contract.** Lifespan now constructs targeted reconciler via select_scan_cache_adapter; unit config intentionally has no DB or placeholder localhost URL. Stub owned startup repository/reconciler seam (and host binding where needed), preserving shutdown ordering and safe-config assertions. Do not connect placeholder URLs.

### 57. `tests/py/test_app_factory.py::test_empty_postgres_startup_submits_one_scan_and_keeps_root_and_status_available`

**Stale fixture / approved contract.** Lifespan now constructs targeted reconciler via select_scan_cache_adapter; unit config intentionally has no DB or placeholder localhost URL. Stub owned startup repository/reconciler seam (and host binding where needed), preserving shutdown ordering and safe-config assertions. Do not connect placeholder URLs.

### 58. `tests/py/test_app_factory.py::test_create_asgi_app_lifespan_does_not_start_duplicate_or_masked_scan[durable-inventory-hydrated]`

**Stale fixture / approved contract.** Lifespan now constructs targeted reconciler via select_scan_cache_adapter; unit config intentionally has no DB or placeholder localhost URL. Stub owned startup repository/reconciler seam (and host binding where needed), preserving shutdown ordering and safe-config assertions. Do not connect placeholder URLs.

### 59. `tests/py/test_app_factory.py::test_create_asgi_app_lifespan_does_not_start_duplicate_or_masked_scan[runtime-albums-nonempty]`

**Stale fixture / approved contract.** Lifespan now constructs targeted reconciler via select_scan_cache_adapter; unit config intentionally has no DB or placeholder localhost URL. Stub owned startup repository/reconciler seam (and host binding where needed), preserving shutdown ordering and safe-config assertions. Do not connect placeholder URLs.

### 60. `tests/py/test_app_factory.py::test_create_asgi_app_lifespan_does_not_start_duplicate_or_masked_scan[runtime-file-cache-nonempty]`

**Stale fixture / approved contract.** Lifespan now constructs targeted reconciler via select_scan_cache_adapter; unit config intentionally has no DB or placeholder localhost URL. Stub owned startup repository/reconciler seam (and host binding where needed), preserving shutdown ordering and safe-config assertions. Do not connect placeholder URLs.

### 61. `tests/py/test_app_factory.py::test_create_asgi_app_lifespan_does_not_start_duplicate_or_masked_scan[scan-already-active]`

**Stale fixture / approved contract.** Lifespan now constructs targeted reconciler via select_scan_cache_adapter; unit config intentionally has no DB or placeholder localhost URL. Stub owned startup repository/reconciler seam (and host binding where needed), preserving shutdown ordering and safe-config assertions. Do not connect placeholder URLs.

### 62. `tests/py/test_app_factory.py::test_create_asgi_app_lifespan_does_not_start_duplicate_or_masked_scan[startup-failure-visible]`

**Stale fixture / approved contract.** Lifespan now constructs targeted reconciler via select_scan_cache_adapter; unit config intentionally has no DB or placeholder localhost URL. Stub owned startup repository/reconciler seam (and host binding where needed), preserving shutdown ordering and safe-config assertions. Do not connect placeholder URLs.

### 63. `tests/py/test_isolated_postgres_live.py::test_live_admin_account_updates_serialize_on_the_same_target`

**Infrastructure migration replay.** 0065 ADD COLUMN replays against existing column. prepare_isolated_database resets rows then applies every SQL; existing ops.schema_migrations survives. Use checksum-verified migration ledger to skip applied SQL and atomically record pending SQL. Never edit applied migration checksum.

### 64. `tests/py/test_isolated_postgres_live.py::test_live_phase_7_partial_indexes_match_representative_runtime_predicates`

**Infrastructure migration replay.** 0065 ADD COLUMN replays against existing column. prepare_isolated_database resets rows then applies every SQL; existing ops.schema_migrations survives. Use checksum-verified migration ledger to skip applied SQL and atomically record pending SQL. Never edit applied migration checksum.

### 65. `tests/py/test_isolated_postgres_live.py::test_live_cover_upgrade_compare_and_swap_rejects_stale_automatic_state`

**Infrastructure migration replay.** 0065 ADD COLUMN replays against existing column. prepare_isolated_database resets rows then applies every SQL; existing ops.schema_migrations survives. Use checksum-verified migration ledger to skip applied SQL and atomically record pending SQL. Never edit applied migration checksum.

### 66. `tests/py/test_isolated_postgres_live.py::test_live_isolated_postgres_pristine_bootstrap_cleanup_and_second_run`

**Infrastructure migration replay.** 0065 ADD COLUMN replays against existing column. prepare_isolated_database resets rows then applies every SQL; existing ops.schema_migrations survives. Use checksum-verified migration ledger to skip applied SQL and atomically record pending SQL. Never edit applied migration checksum.

### 67. `tests/py/test_isolated_postgres_live.py::test_live_targeted_album_rename_commits_without_rebuilding_unrelated_inventory`

**Unresolved real database behavior.** Track/file IDs survive but album_id changes3 to7. Inspect semantic destination grouping vs prior whole-album identity contract; do not blindly replace expected ID. Focused reproduction after DB isolation repair.

### 68. `tests/py/test_isolated_postgres_live.py::test_live_scan_snapshot_replaces_only_scan_owned_featured_artist_memberships`

**Unresolved real database behavior.** Browse excludes Archived Owner, but relation builder returns it after scan-owned membership replacement. Inspect load_relation_source_rows_sql and builder owner evidence; preserve manually curated membership assertions.

### 69. `tests/py/test_lastfm_pytest_safety.py::test_app_lifespan_receives_only_safe_lastfm_and_database_config`

**Stale fixture / approved contract.** Lifespan now constructs targeted reconciler via select_scan_cache_adapter; unit config intentionally has no DB or placeholder localhost URL. Stub owned startup repository/reconciler seam (and host binding where needed), preserving shutdown ordering and safe-config assertions. Do not connect placeholder URLs.

### 70. `tests/py/test_loop_error_projection.py::test_encoding_failure_does_not_expose_private_diagnostics[create]`

**Stale fixture / approved contract.** New creation logger scope traverses direct fake request without state/actor; provide trusted scoped request fixture so real encoding/public-projection branch remains exercised.

### 71. `tests/py/test_loop_public_projection.py::test_create_response_projects_both_created_item_and_refreshed_collection`

**Stale fixture / approved contract.** New creation logger scope traverses direct fake request without state/actor; provide trusted scoped request fixture so real encoding/public-projection branch remains exercised.

### 72. `tests/py/test_playback_capability_projection.py::test_status_projects_current_loop_create_grant_without_retaining_cached_authority`

**Stale fixture / approved contract.** Cached current_actor is SimpleNamespace(role_name) rather than CurrentActor and is rejected before new history/loop scope. Use actual actor or explicit resolver seam with current-library relationship; retain grant change assertions.

### 73. `tests/py/test_playback_capability_projection.py::test_saved_loops_project_each_effective_action_without_role_inference`

**Stale fixture / approved contract.** Cached current_actor is SimpleNamespace(role_name) rather than CurrentActor and is rejected before new history/loop scope. Use actual actor or explicit resolver seam with current-library relationship; retain grant change assertions.

### 74. `tests/py/test_playback_stream_asgi.py::test_lifespan_shutdown_closes_live_socket_with_1001_and_leaves_zero_decoders`

**Stale fixture / approved contract.** Lifespan now constructs targeted reconciler via select_scan_cache_adapter; unit config intentionally has no DB or placeholder localhost URL. Stub owned startup repository/reconciler seam (and host binding where needed), preserving shutdown ordering and safe-config assertions. Do not connect placeholder URLs.

### 75. `tests/py/test_postgres_migrations.py::test_postgres_migration_filenames_are_zero_padded_sql_and_lexically_ordered`

**Stale fixture / approved contract.** Pinned last24 migration filename list predates0063-0067. Update complete ordered discovery contract without weakening filename/checksum checks.

### 76. `tests/py/test_postgres_structural_tag_edit.py::test_selected_postgres_structural_finalizer_uses_authoritative_album_finder`

**Stale fixture / approved contract.** Direct finalizer passes object() request, now invalid for immutable history-scope capture. Provide proper request/state/actor seam; preserve exact release-date and field compensation.

### 77. `tests/py/test_postgres_structural_tag_edit.py::test_selected_postgres_year_compensation_restores_exact_release_date`

**Stale fixture / approved contract.** Direct finalizer passes object() request, now invalid for immutable history-scope capture. Provide proper request/state/actor seam; preserve exact release-date and field compensation.

### 78. `tests/py/test_postgres_structural_tag_edit.py::test_selected_postgres_compensation_restores_only_fields_changed_per_path`

**Stale fixture / approved contract.** Direct finalizer passes object() request, now invalid for immutable history-scope capture. Provide proper request/state/actor seam; preserve exact release-date and field compensation.

### 79. `tests/py/test_repair_previews.py::test_build_encoding_repair_preview_can_skip_preview_rows_for_summary_only_calls`

**Stale fixture / approved contract.** Summary projection now includes suggested_edits:[] from approved Task3; update expected shape only while retaining no-preview-row behavior.

### 80. `tests/py/test_runtime_shutdown.py::test_asgi_lifespan_awaits_peak_and_pcm_registry_shutdown_before_runtime_shutdown`

**Stale fixture / approved contract.** Lifespan now constructs targeted reconciler via select_scan_cache_adapter; unit config intentionally has no DB or placeholder localhost URL. Stub owned startup repository/reconciler seam (and host binding where needed), preserving shutdown ordering and safe-config assertions. Do not connect placeholder URLs.

### 81. `tests/py/test_runtime_shutdown.py::test_asgi_lifespan_attempts_every_cleanup_stage_before_raising[waveform-shutdown]`

**Stale fixture / approved contract.** Lifespan now constructs targeted reconciler via select_scan_cache_adapter; unit config intentionally has no DB or placeholder localhost URL. Stub owned startup repository/reconciler seam (and host binding where needed), preserving shutdown ordering and safe-config assertions. Do not connect placeholder URLs.

### 82. `tests/py/test_runtime_shutdown.py::test_asgi_lifespan_attempts_every_cleanup_stage_before_raising[pcm-shutdown]`

**Stale fixture / approved contract.** Lifespan now constructs targeted reconciler via select_scan_cache_adapter; unit config intentionally has no DB or placeholder localhost URL. Stub owned startup repository/reconciler seam (and host binding where needed), preserving shutdown ordering and safe-config assertions. Do not connect placeholder URLs.

### 83. `tests/py/test_runtime_shutdown.py::test_asgi_lifespan_attempts_every_cleanup_stage_before_raising[runtime-shutdown]`

**Stale fixture / approved contract.** Lifespan now constructs targeted reconciler via select_scan_cache_adapter; unit config intentionally has no DB or placeholder localhost URL. Stub owned startup repository/reconciler seam (and host binding where needed), preserving shutdown ordering and safe-config assertions. Do not connect placeholder URLs.

### 84. `tests/py/test_scan_state.py::test_failed_relation_publication_keeps_prior_live_scan_state`

**Stale fixture / approved contract.** Structured history callback now explicitly carries history_scope:None when no proven background provenance. Add field to exact fixture expectation; keep bounded count/errors/order and fail-closed provenance.

### 85. `tests/py/test_settings_navigation_assets.py::test_navigation_stylesheet_uses_current_runtime_revision_on_every_shell[True]`

**Confirmed product regression.** Both hosted/nonhosted shells omit runtime revision on navigation-tree.css; actual manual cached CSS keeps hidden search rows visible. Add current revision to shared asset URL and retain assertions.

### 86. `tests/py/test_settings_navigation_assets.py::test_navigation_stylesheet_uses_current_runtime_revision_on_every_shell[False]`

**Confirmed product regression.** Both hosted/nonhosted shells omit runtime revision on navigation-tree.css; actual manual cached CSS keeps hidden search rows visible. Add current revision to shared asset URL and retain assertions.

### 87. `tests/py/test_shared_app_bar_templates.py::test_library_app_bar_is_above_both_sidebar_and_main_content`

**Stale fixture / approved contract.** Direct Jinja fixture lacks required playback_allowed_actions supplied by real shell. Add denied/allowed projection object to fixture; retain appbar DOM/handler/ordering assertions.

### 88. `tests/py/test_shared_app_bar_templates.py::test_library_search_preserves_selected_scope_and_repeated_categories`

**Stale fixture / approved contract.** Direct Jinja fixture lacks required playback_allowed_actions supplied by real shell. Add denied/allowed projection object to fixture; retain appbar DOM/handler/ordering assertions.

### 89. `tests/py/test_shared_app_bar_templates.py::test_library_app_bar_owns_sources_and_aligns_search_with_gallery_body`

**Stale fixture / approved contract.** Direct Jinja fixture lacks required playback_allowed_actions supplied by real shell. Add denied/allowed projection object to fixture; retain appbar DOM/handler/ordering assertions.

### 90. `tests/py/test_shared_app_bar_templates.py::test_gallery_template_hosts_exact_controls_and_album_type_defaults`

**Stale fixture / approved contract.** Direct Jinja fixture lacks required playback_allowed_actions supplied by real shell. Add denied/allowed projection object to fixture; retain appbar DOM/handler/ordering assertions.

### 91. `tests/py/test_shared_app_bar_templates.py::test_library_actions_retain_handlers_and_server_filtered_admin_entry[False]`

**Stale fixture / approved contract.** Direct Jinja fixture lacks required playback_allowed_actions supplied by real shell. Add denied/allowed projection object to fixture; retain appbar DOM/handler/ordering assertions.

### 92. `tests/py/test_shared_app_bar_templates.py::test_library_actions_retain_handlers_and_server_filtered_admin_entry[True]`

**Stale fixture / approved contract.** Direct Jinja fixture lacks required playback_allowed_actions supplied by real shell. Add denied/allowed projection object to fixture; retain appbar DOM/handler/ordering assertions.

### 93. `tests/py/test_shared_app_bar_templates.py::test_settings_shell_owns_bar_above_navigation_with_no_duplicate_sidebar_brand[index.html]`

**Stale fixture / approved contract.** Direct Jinja fixture lacks required playback_allowed_actions supplied by real shell. Add denied/allowed projection object to fixture; retain appbar DOM/handler/ordering assertions.

### 94. `tests/py/test_shared_app_bar_templates.py::test_hosted_settings_keeps_bottom_player_outside_both_switchable_shells`

**Stale fixture / approved contract.** Direct Jinja fixture lacks required playback_allowed_actions supplied by real shell. Add denied/allowed projection object to fixture; retain appbar DOM/handler/ordering assertions.

### 95. `tests/py/test_shared_app_bar_templates.py::test_mobile_artist_drawer_has_a_reachable_existing_action_outside_the_drawer`

**Stale fixture / approved contract.** Direct Jinja fixture lacks required playback_allowed_actions supplied by real shell. Add denied/allowed projection object to fixture; retain appbar DOM/handler/ordering assertions.

### 96. `tests/py/test_state.py::test_hydration_file_errors_use_bounded_structured_history`

**Stale fixture / approved contract.** Structured history callback now explicitly carries history_scope:None when no proven background provenance. Add field to exact fixture expectation; keep bounded count/errors/order and fail-closed provenance.

### 97. `tests/py/test_state.py::test_scan_music_incremental_bounds_structured_file_error_history`

**Stale fixture / approved contract.** Structured history callback now explicitly carries history_scope:None when no proven background provenance. Add field to exact fixture expectation; keep bounded count/errors/order and fail-closed provenance.

### 98. `tests/py/test_view_payloads.py::test_build_view_payload_caches_search_buckets_between_same_query_requests`

**Stale fixture / approved contract.** Search bucket projection now includes artist_name_match_artists:[Neal Morse]; expected shape stale. Retain cache call-count and same-query reuse checks.

### 99. `tests/py/test_web_account_menu.py::test_shell_menu_uses_policy_projection_and_session_bound_csrf[False]`

**Stale fixture / approved contract.** Real shell adds library.loops.create policy projection call; expected invocation list only accounts.read. Add exact required action, preserve CSRF/menu assertions.

### 100. `tests/py/test_web_account_menu.py::test_shell_menu_uses_policy_projection_and_session_bound_csrf[True]`

**Stale fixture / approved contract.** Real shell adds library.loops.create policy projection call; expected invocation list only accounts.read. Add exact required action, preserve CSRF/menu assertions.

### 101. `tests/py/test_web_bootstrap.py::test_asgi_track_and_loop_media_routes_preserve_private_file_policy`

**Stale fixture / approved contract.** Loop media now requires live scoped stored ownership, old global path route fixture403. Supply current actor/library and stored artifact lookup; do not restore canonical global fallback.

### 102. `tests/py/test_web_bootstrap.py::test_app_js_loads_generated_runtime_bundle_after_bootstrap_payload_setup`

**Stale fixture / approved contract.** Expected app.js prebundle component set lacks approved button-component/unfolding-action dependencies. Align ordered assets and retain one generated bundle/bootstrap ordering.

## Exact setup-error inventory

- `tests/py/test_log_history_postgres.py::test_keyset_same_timestamp_has_no_gaps_and_export_uses_identical_snapshot`
- `tests/py/test_log_history_postgres.py::test_backdated_arrivals_and_same_id_updates_cannot_change_captured_snapshot`
- `tests/py/test_log_history_postgres.py::test_normalized_half_open_filter_is_identical_for_page_and_export`
- `tests/py/test_log_history_postgres.py::test_library_scope_and_cursor_query_binding_cannot_be_broadened`
- `tests/py/test_log_history_postgres.py::test_page_size_is_bounded_at_500`
- `tests/py/test_log_history_postgres.py::test_retention_uses_recording_time_and_only_prunes_requested_library`
- `tests/py/test_log_history_postgres.py::test_scope_redaction_happens_before_storage_and_projection`
- `tests/py/test_log_history_postgres.py::test_100001_event_export_refuses_instead_of_returning_a_truncated_success`
- `tests/py/test_log_history_postgres.py::test_append_serialization_prevents_late_lower_revisions_entering_old_snapshot`
- `tests/py/test_log_history_read_consistency.py::test_concurrent_prune_after_snapshot_validation_never_returns_silent_partial_history[page]`
- `tests/py/test_log_history_read_consistency.py::test_concurrent_prune_after_snapshot_validation_never_returns_silent_partial_history[export]`
- `tests/py/test_log_history_retry_persistence.py::test_pending_adapter_returns_trusted_row_scope_separate_from_payload`
- `tests/py/test_log_history_retry_persistence.py::test_retry_update_touches_only_exact_scoped_persisted_row`
- `tests/py/test_loop_reorder.py::test_order_persists_only_current_actor_library_song_and_keeps_row_ids`
- `tests/py/test_loop_reorder.py::test_invalid_membership_never_silently_appends_drops_or_writes[ids0]`
- `tests/py/test_loop_reorder.py::test_invalid_membership_never_silently_appends_drops_or_writes[ids1]`
- `tests/py/test_loop_reorder.py::test_invalid_membership_never_silently_appends_drops_or_writes[ids2]`
- `tests/py/test_loop_reorder.py::test_invalid_membership_never_silently_appends_drops_or_writes[ids3]`
- `tests/py/test_loop_reorder.py::test_invalid_membership_never_silently_appends_drops_or_writes[ids4]`
- `tests/py/test_loop_reorder.py::test_invalid_membership_never_silently_appends_drops_or_writes[ids5]`
- `tests/py/test_loop_reorder.py::test_revision_requires_nonnegative_integer[-1]`
- `tests/py/test_loop_reorder.py::test_revision_requires_nonnegative_integer[True]`
- `tests/py/test_loop_reorder.py::test_revision_requires_nonnegative_integer[1.5]`
- `tests/py/test_loop_reorder.py::test_revision_requires_nonnegative_integer[0]`
- `tests/py/test_loop_reorder.py::test_revision_requires_nonnegative_integer[None]`
- `tests/py/test_loop_reorder.py::test_stale_order_returns_only_current_scoped_snapshot`
- `tests/py/test_loop_reorder.py::test_foreign_song_is_not_visible_even_if_loop_keys_match`
- `tests/py/test_loop_reorder.py::test_two_concurrent_reorders_with_same_token_have_one_commit`
- `tests/py/test_loop_reorder.py::test_unresolved_historical_rows_remain_owned_visible_and_not_reorderable`
- `tests/py/test_loop_reorder.py::test_delete_advances_same_song_revision_and_preserves_tombstone`
- `tests/py/test_loop_reorder.py::test_unresolved_delete_does_not_change_resolved_song_revision`
- `tests/py/test_loop_reorder.py::test_nested_creation_uses_parent_song_and_invalidates_old_order`
- `tests/py/test_loop_reorder.py::test_membership_writers_wait_for_the_same_song_order_lock[create]`
- `tests/py/test_loop_reorder.py::test_membership_writers_wait_for_the_same_song_order_lock[delete]`
- `tests/py/test_loop_reorder.py::test_direct_creation_derives_song_only_from_exact_current_library_file[False]`
- `tests/py/test_loop_reorder.py::test_direct_creation_derives_song_only_from_exact_current_library_file[True]`
- `tests/py/test_loop_reorder.py::test_invalid_cross_library_track_relation_is_preserved_as_unresolved`
- `tests/py/test_loop_reorder.py::test_direct_creation_rejects_window_beyond_authoritative_track_duration`
- `tests/py/test_loop_reorder.py::test_direct_subsecond_source_uses_truncated_zero_duration_interval`
- `tests/py/test_settings_lastfm_account_credentials.py::test_scoped_credential_roundtrip_does_not_read_or_overwrite_another_account`
- `tests/py/test_settings_loop_style_postgres.py::test_style_round_trip_is_account_and_client_profile_owned`
- `tests/py/test_settings_loop_style_postgres.py::test_denied_style_change_does_not_write_any_part_of_the_aggregate`
- `tests/py/test_settings_loop_style_postgres.py::test_unchanged_and_omitted_style_allow_unrelated_edits_after_grant_loss`
- `tests/py/test_settings_loop_style_postgres.py::test_missing_row_uses_capsule_as_comparison_default_without_grant`
- `tests/py/test_settings_loop_style_postgres.py::test_old_background_writer_preserves_the_saved_loop_choice`
- `tests/py/test_settings_loop_style_postgres.py::test_two_same_revision_style_saves_have_exactly_one_winner`
- `tests/py/test_settings_loop_style_postgres.py::test_stale_denied_style_write_returns_current_revision_without_overwriting`
- `tests/py/test_settings_loop_style_postgres.py::test_legacy_palette_write_preserves_style_and_profile_owned_writes_do_not_cross`
- `tests/py/test_settings_measured_listen_ledger.py::test_identical_completion_retry_keeps_one_measured_row_and_identity`
- `tests/py/test_settings_measured_listen_ledger.py::test_concurrent_identical_completions_atomically_deduplicate`
- `tests/py/test_settings_measured_listen_ledger.py::test_concurrent_conflicting_same_sequence_has_one_commit_and_one409`
- `tests/py/test_settings_measured_listen_ledger.py::test_newer_monotonic_update_reuses_row_and_older_sequence_is_ignored`
- `tests/py/test_settings_measured_listen_ledger.py::test_newer_sequence_cannot_rewrite_identity_or_regress_counters[changes0]`
- `tests/py/test_settings_measured_listen_ledger.py::test_newer_sequence_cannot_rewrite_identity_or_regress_counters[changes1]`
- `tests/py/test_settings_measured_listen_ledger.py::test_newer_sequence_cannot_rewrite_identity_or_regress_counters[changes2]`
- `tests/py/test_settings_measured_listen_ledger.py::test_newer_sequence_cannot_rewrite_identity_or_regress_counters[changes3]`
- `tests/py/test_settings_measured_listen_ledger.py::test_finalized_session_cannot_be_reopened`
- `tests/py/test_settings_measured_listen_ledger.py::test_malformed_measurement_never_inserts_a_ledger_row[changes0]`
- `tests/py/test_settings_measured_listen_ledger.py::test_malformed_measurement_never_inserts_a_ledger_row[changes1]`
- `tests/py/test_settings_measured_listen_ledger.py::test_malformed_measurement_never_inserts_a_ledger_row[changes2]`
- `tests/py/test_settings_measured_listen_ledger.py::test_malformed_measurement_never_inserts_a_ledger_row[changes3]`
- `tests/py/test_settings_measured_listen_ledger.py::test_malformed_measurement_never_inserts_a_ledger_row[changes4]`
- `tests/py/test_settings_measured_listen_ledger.py::test_malformed_measurement_never_inserts_a_ledger_row[changes5]`
- `tests/py/test_settings_measured_listen_ledger.py::test_malformed_measurement_never_inserts_a_ledger_row[changes6]`
- `tests/py/test_settings_measured_listen_ledger.py::test_malformed_measurement_never_inserts_a_ledger_row[changes7]`
- `tests/py/test_settings_measured_listen_ledger.py::test_malformed_measurement_never_inserts_a_ledger_row[changes8]`
- `tests/py/test_settings_measured_listen_ledger.py::test_same_device_and_session_ids_remain_independent_across_scopes`
- `tests/py/test_settings_measured_listen_ledger.py::test_foreign_track_cannot_be_claimed_by_payload_or_matching_display_text`
- `tests/py/test_settings_measured_listen_ledger.py::test_scrobble_update_changes_same_scoped_row_without_duplicate`
- `tests/py/test_settings_measured_listen_ledger.py::test_legacy_collection_save_preserves_measured_family`
- `tests/py/test_settings_measured_listen_ledger.py::test_same_sequence_requires_identical_accepted_completion_payload[changes0]`
- `tests/py/test_settings_measured_listen_ledger.py::test_same_sequence_requires_identical_accepted_completion_payload[changes1]`
- `tests/py/test_settings_measured_listen_ledger.py::test_same_sequence_requires_identical_accepted_completion_payload[changes2]`
- `tests/py/test_settings_measured_provider_receipts.py::test_concurrent_duplicate_completion_sends_once_and_reuses_scoped_receipt`
- `tests/py/test_settings_measured_provider_receipts.py::test_foreign_scope_cannot_send_or_record_receipt_for_owned_track`
- `tests/py/test_settings_measured_provider_receipts.py::test_immediate_scrobble_then_final_completion_preserves_server_receipt`
- `tests/py/test_settings_measured_provider_receipts.py::test_sent_unconfirmed_receipt_survives_next_sequence_without_resubmission`
- `tests/py/test_settings_measured_retry_account.py::test_measured_retry_uses_each_persisted_account_credential_once`
- `tests/py/test_settings_measured_retry_account.py::test_measured_retry_does_not_resubmit_uncertain_receipt`
- `tests/py/test_settings_measured_retry_account.py::test_measured_retry_records_actual_provider_outcome_with_row_scope[False]`
- `tests/py/test_settings_measured_retry_account.py::test_measured_retry_records_actual_provider_outcome_with_row_scope[True]`
- `tests/py/test_settings_measured_statistics.py::test_statistics_are_scoped_completed_measured_totals_without_duplicate_retries`
- `tests/py/test_settings_scoped_root_persistence.py::test_scoped_root_save_read_never_uses_bootstrap_or_foreign_library`
- `tests/py/test_settings_scoped_root_persistence.py::test_unchanged_offline_root_is_preserved_but_new_unavailable_root_is_rejected`
- `tests/py/test_settings_scoped_root_persistence.py::test_scoped_root_save_retains_root_provenance_records`
- `tests/py/test_settings_scrobble_status_counts.py::test_status_counts_use_the_actual_actor_library_rows`
- `tests/py/test_settings_scrobble_status_counts.py::test_authenticated_integrations_projection_retains_real_counts`
- `tests/py/test_settings_scrobble_status_counts.py::test_scoped_counts_preserve_typed_status_when_payload_omits_legacy_flag`


## Independent read-only follow-up: two live PG behavior candidates

Both candidate tests explicitly drop all application schemas and rebuild their own dataset at entry, so their observed assertions are not explained by the later 88 missing-schema setup errors. Both direct `PostgresScanCacheAdapter.save_snapshot` fixture calls omit `observed_library_root_ids`. Current persistence passes omission as an empty set and `_mark_stale_track_files_sql` only marks absent paths stale within an explicitly observed root. This is the approved unavailable-root protection; production traversal captures the set in `state.py` and forwards it through publication/cache persistence.

- `test_live_targeted_album_rename_commits_without_rebuilding_unrelated_inventory`: its second snapshot removes the third Old Album file, but no observed-root evidence is supplied. The third file therefore remains active. Structural SQL counts three source files versus two edited inputs and correctly follows the split path, yielding album ID 7 rather than the asserted retained ID 3. Reproduce unchanged first, then add only `observed_library_root_ids={"structural-root"}` to the owned snapshot fixture calls; retain every stable-ID, metadata, rating, stale-file and unrelated-inventory assertion.
- `test_live_scan_snapshot_replaces_only_scan_owned_featured_artist_memberships`: the second snapshot removes Archived Owner's path but supplies no observed-root evidence. Its scan-owned featured membership is removed, so browse output excludes it, while its still-active track remains in `load_relation_source_rows_sql`; the relation builder correctly sees Archived Owner. Reproduce unchanged first, then add only `observed_library_root_ids={"scan-membership-root"}` to the owned snapshot fixture calls; retain every curated-membership and relation assertion.

These are strong fixture-contract diagnoses from the executed failures and actual SQL, not claimed focused GREEN results. No tests, application source, or fixtures were changed during this read-only investigation.

Related functional FTC-TAGS-021 immediate merge (16 expected,13 observed) remains a separate candidate. Its assertion reads runtime logical album inventory, not a potentially ambiguous titled DOM card, and asserts exactly one matching source title. The generated startup seed omits observed IDs but writes into a newly reset database, so it has no prior removed paths to stale. Normal scan traversal supplies observed IDs. The failure occurs immediately after an accepted asynchronous edit, before `accepted.waitForCompletion`, so inspect the optimistic merge/canonical refresh response and retained runtime inventory before attributing it to backend stale-root handling. No evidence yet proves a shared root cause.


### Separate functional cleanup independence finding

`tests/e2e/helpers/ddtStudioRecordsFixture.js` imports/restores only ID3/TDRC/TRCK. Its expected rows and physical reset do not restore TALB, although the consolidation scenario changes album titles. The SQL reset cannot repair those physical frames; a later restart can republish a leftover split identity. The scenario also fails before `accepted.waitForCompletion`, while its `afterEach` runs physical restoration before stopping/restarting the app. A still-pending tag writer can therefore race fixture restoration. This is a distinct cleanup defect that can explain downstream fixture failure; it does not establish the cause of the initial immediate13-versus16 renderer assertion. After inventory, reproduce cleanup after an early split/merge failure, restore all mutated physical fields, and ensure owned writes are stopped or settled before restoration; retain the original user-flow assertions.
