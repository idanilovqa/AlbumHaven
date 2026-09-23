# Postgres Migrations

This directory contains repo-owned Postgres SQL migrations for Album Haven.

Migration `0065_native_player_component_provenance.sql` permits an optional
`native_components` array in structured player styles and recent sets. Its unique
values are `surface`, `controls`, `waveform`, and `handles`. An omitted or empty
array means every component is explicitly customized, preserving older saved
styles. Named components retain the native player treatment until edited; their
stored color groups remain complete editor values. The account Appearance API
validates and round-trips this field with the existing revisioned preferences.
The migration replaces the existing JSON validator without changing columns,
saved rows, capabilities, or function privileges.

Migration `0066_allow_appearance_panel_outline.sql` permits an optional
`panel_outline` RGB color or JSON null in interaction overrides. Omitted values
retain the default outline. It replaces only the aggregate shape constraint,
preserving existing rows, other validation, and function privileges.

Migration `0067_add_scanned_exception_candidate_index.sql` adds a partial index
for active files tagged Interview or Non-album rarity, including the accepted
non-hyphenated alias. The Loose Tracks query uses a separate candidate branch
with the matching predicate, preserving the album-name index from `0045`.
Final classification still honors explicit exception overrides, including clears.
The migration changes no saved rows or privileges.

Use lowercase, zero-padded filenames and apply them in lexical order:

```text
0001_create_current_stack_schemas.sql
0002_create_local_mbid_assertions.sql
0003_add_local_mbid_projection_provenance.sql
0004_add_lastfm_backfill_identities.sql
0005_add_policy_context_hooks.sql
0006_scope_lastfm_sync_identities.sql
0007_scope_cover_lookup_task_identities.sql
0008_scope_saved_loop_identities.sql
0009_create_user_discovery_preferences.sql
0010_create_virtual_artist_snapshots.sql
0011_create_log_history.sql
0012_create_discovery_lookup_snapshots.sql
0013_create_virtual_release_snapshots.sql
0014_update_bootstrap_owner_nominem.sql
0015_create_local_artist_family_links.sql
0016_grant_local_artist_family_link_delete.sql
0017_create_e2e_problematic_fixture_seeds.sql
0018_repair_saved_loop_relations.sql
0019_create_local_album_featured_artists.sql
0020_grant_runtime_delete_privileges.sql
0021_add_problematic_file_generated_projection.sql
0022_fix_lastfm_pending_scrobble_conflict_identity.sql
0023_link_local_track_files_to_library_roots.sql
0024_add_library_search_trigram_indexes.sql
0025_grant_local_album_featured_artist_delete.sql
0026_create_album_ratings.sql
0027_repair_cover_lookup_task_delete_grant.sql
0028_repair_cover_lookup_task_conflict_identity.sql
0029_repair_lastfm_session_conflict_identity.sql
0030_drop_log_history.sql
0031_add_problematic_active_track_index.sql
0032_expand_problematic_active_track_index.sql
0033_repair_section14_album_identity_corruption.sql
0034_reconcile_semantic_local_albums.sql
0035_enforce_semantic_local_album_identity.sql
0036_add_problematic_candidate_index.sql
0037_add_problematic_track_candidate_index.sql
0038_add_problematic_required_text_candidate.sql
0039_repair_semantic_album_reconciliation_delete_grants.sql
0040_repair_ignored_repairs_delete_grant.sql
0041_create_local_album_cover_candidate_snapshots.sql
0042_track_distinct_cover_improvement_alerts.sql
0043_create_local_track_waveform_peaks.sql
0044_create_tag_edit_intents.sql
0045_add_non_album_candidate_index.sql
0046_add_local_auth_lifecycle.sql
0047_add_auth_preauth_tokens.sql
0048_add_password_reset_transactions.sql
0049_enforce_single_use_password_reset_exchange.sql
0050_add_security_audit_cleanup_index.sql
0051_add_auth_throttle_cleanup_index.sql
0052_add_managed_account_invitations.sql
0053_create_user_appearance_preferences.sql
0054_add_appearance_palettes_and_player_colors.sql
0055_waveform_recent_colors.sql
0056_compact_player_appearance_profiles.sql
0057_aggregate_appearance_workspace.sql
0058_album_details_appearance.sql
0059_alert_appearance_family.sql
0060_player_aware_interaction_outline.sql
0061_create_missing_album_removal_function.sql
0062_narrow_readonly_account_privileges.sql
0063_replace_missing_album_removal_lock_snapshot.sql
0064_grant_library_membership_delete.sql
0065_native_player_component_provenance.sql
0066_allow_appearance_panel_outline.sql
0067_add_scanned_exception_candidate_index.sql
0068_scoped_saved_loop_orders.sql
0069_scoped_operational_log_versions.sql
0070_appearance_loop_control_style.sql
0071_allow_harbor_mint_appearance_palette.sql
0072_measured_local_listen_sessions.sql
0073_preserve_measured_listen_history.sql
0074_create_saved_loop_waveform_peaks.sql
0075_appearance_device_sections.sql
0076_docked_compact_player_behavior.sql
0077_allow_parchment_pine_appearance_palette.sql
0078_add_compact_player_motion_and_floating_edge.sql
0079_docked_compact_player_regular_style.sql
0063_create_durable_job_foundation.sql
0064_request_durable_job_cancellation.sql
0065_harden_durable_job_boundaries.sql
0066_grant_worker_authorization_reads.sql
0067_add_job_transition_retention_index.sql
0068_create_scan_job_intents.sql
0069_grant_worker_targeted_reconciliation.sql
0070_authorize_full_scan_lifecycle.sql
0071_grant_worker_full_scan_execution.sql
0072_create_durable_cover_job_state.sql
0073_grant_worker_cover_lookup.sql
0074_grant_worker_cover_refresh.sql
0075_create_remote_cover_save_checkpoints.sql
0076_complete_durable_scan_status_projection.sql
0077_create_lastfm_retry_job_state.sql
0078_grant_worker_lastfm_retry.sql
0079_create_auth_mail_job_state.sql
0080_grant_worker_auth_mail.sql
0081_validate_durable_worker_startup.sql
0082_retire_vacated_structural_album.sql
```

Section 3 owns the first baseline schema migration. Do not add future-feature reservation schemas here. Phase 6 migration files should stay current-stack scoped and target app-owned durable data for `album_haven_core`.

`0011_create_log_history.sql` records the former Postgres Log History design. `0030_drop_log_history.sql` removes that table after the owner rejected database persistence for diagnostic history. Keep both migrations unchanged and apply them in order. The live runtime has no Postgres Log History seam. FastAPI exposes only a bounded process-memory snapshot, and the browser owns durable Log History in origin/profile-scoped IndexedDB.

`0033_repair_section14_album_identity_corruption.sql` is a bounded data repair. It merges only exact legacy base-key/year-key album twins with matching library, artist, normalized title, release year, and blank edition, and repairs only the literal malformed empty-ID3 artist projection `['']` when the tracks identify one real artist and one same-title/year destination album. Ambiguous malformed projections are left untouched and reported as migration warnings.

`0034_reconcile_semantic_local_albums.sql` is the one-time full dependency-graph repair for album rows that share one normalized library, canonical artist, title, release year, and edition. Explicit separate-release markers are preserved; blank or whitespace-only album-artist tags fall back to the canonical artist name.

`0035_enforce_semantic_local_album_identity.sql` adds the row-local `semantic_identity_discriminator` and an immediate `NULLS NOT DISTINCT` partial unique index. Ordinary albums use the empty discriminator, while an exact pre-existing separate-release marker assigns each row its `album_key`. Because uniqueness is immediate, a marker must be written before inserting a second otherwise-identical explicit release. Marker removal is rejected atomically while duplicate rows still depend on it. Full scan publication relies on this index instead of running a full-library duplicate validation pass.

`0036_add_problematic_candidate_index.sql` and `0037_add_problematic_track_candidate_index.sql` add narrow covering indexes for cold Problematic Files candidate discovery. Migration `0038_add_problematic_required_text_candidate.sql` upgrades both fresh and already-migrated databases with a small partial index for files whose generated album, album-artist, artist, or title projection is blank. Candidate discovery unions those rare album identities into the main narrow result without evaluating four text expressions across every active file or reading wide metadata/path payloads.

`0039_repair_semantic_album_reconciliation_delete_grants.sql` restores only the two runtime `DELETE` privileges needed by semantic-album reconciliation on upgraded databases whose migration ledger omitted `0020_grant_runtime_delete_privileges.sql`. It grants `album_haven_app` access to `library.ignored_versions` and `library.manual_versions` without changing readonly or unrelated privileges.

`0040_repair_ignored_repairs_delete_grant.sql` restores the runtime `DELETE` privilege needed to replace legacy ignored-repair rows atomically on upgraded databases whose migration ledger omitted `0020_grant_runtime_delete_privileges.sql`. It grants only `library.ignored_repairs` deletion to `album_haven_app`.

`0041_create_local_album_cover_candidate_snapshots.sql` adds the album-scoped Postgres snapshot for up to 24 durable remote cover candidates, search-generation status, and automatic-improvement review revisions. It also classifies legacy albums with existing local or remote covers as user-controlled and grants the application and migrator only the bounded read-and-upsert privileges needed by the snapshot repository.

`0042_track_distinct_cover_improvement_alerts.sql` records the stable candidate ID behind the latest automatic-improvement alert. Repeated automatic generations that rediscover that same candidate do not create another unseen alert; a later distinct qualifying candidate does.

`0043_create_local_track_waveform_peaks.sql` adds a compact, track-file-scoped cache for generated stereo waveform peaks. File stat and scan-owned content validators plus the analyzer version invalidate stale results; the table never exposes or duplicates raw media.

`0044_create_tag_edit_intents.sql` adds the durable cross-boundary journal for Edit Tags. Each row records old and requested per-path values before media I/O; unfinished rows are reconciled against real files before startup hydration, and terminal completion is committed with the canonical inventory mutation. The application and migrator retain their bounded journal privileges, while the migration explicitly revokes readonly `SELECT` because the rows contain private paths and tag snapshots.

`0045_add_non_album_candidate_index.sql` adds a narrow partial index for active track files whose generated album marker identifies a non-album candidate, keeping that cold discovery path off the full active-file set.

`0046_add_local_auth_lifecycle.sql` adds normalized managed-account identity and contact fields, focused credentials, hashed reset tokens, durable throttles, bounded revocable sessions, append-only security audit events, and a durable mail outbox. Existing accounts receive unique transitional `pending-account-*` identities with non-routable `.invalid` contact addresses for later owner reconciliation, and all legacy sessions are hashed and explicitly revoked rather than promoted into Phase 7 authentication. Named foreign-key and runtime lookup indexes support the lifecycle queries; explicit application and migrator grants preserve role separation, while readonly access is revoked from secret-adjacent auth and delivery tables.

`0047_add_auth_preauth_tokens.sql` adds short-lived, purpose-bound login preflight state for one-time CSRF enforcement. Only SHA-256 token hashes are stored; consumed and expired rows are queryable for bounded cleanup, and the runtime role receives only the privileges needed to issue, consume, and clean up this state.

`0048_add_password_reset_transactions.sql` adds short-lived, hashed clean-URL reset transactions so raw emailed reset tokens leave the browser address bar before a password is submitted.

`0049_enforce_single_use_password_reset_exchange.sql` makes each emailed password-reset token exchangeable only once. It retains the earliest transaction if a pre-release database contains duplicate exchanges, then enforces the invariant with a unique index.

`0050_add_security_audit_cleanup_index.sql` adds the global UTC timestamp and ID index used by the migrator-owned bounded audit-retention command. It grants no runtime deletion privilege; `album_haven_app` remains append-only for security audit events.

`0051_add_auth_throttle_cleanup_index.sql` adds the expiry and ID index used by the bounded throttle cleanup command. It does not expand privileges; the runtime role already owns the narrow delete permission required to remove expired HMAC-keyed buckets.

`0053_create_user_appearance_preferences.sql` adds two optional RGB background overrides keyed directly by account ID. The primary key also supports account-scoped reads; a null value preserves each surface's existing default. Both values update together. The application role receives only select, insert, and update, while account deletion cascades to preferences. No new sequence, bootstrap-owner lookup, or file-backed fallback is introduced.

`0054_add_appearance_palettes_and_player_colors.sql` extends account appearance with a validated palette ID, one of three panel companions, and an optional complete player-background/waveform-fill/waveform-edge color group. Existing custom background rows remain unchanged. Palette selection excludes conflicting legacy colors, and legacy background writes preserve the player group. Existing account-keyed table privileges and index cover these additions; no new sequence or grant is required.

`0055_waveform_recent_colors.sql` adds a per-account newest-first history of up to five distinct waveform colors. It seeds only persisted custom fill and edge values when adding the column. A bounded immutable helper deduplicates ordered candidates during the same account upsert; explicit selections merge with current server history instead of replacing it with a client snapshot. Constraints reject invalid RGB, null members, duplicates, oversized or multidimensional arrays. Only app and migration roles receive helper execution privileges; existing table grants remain sufficient.

`0056_compact_player_appearance_profiles.sql` adds the Docked/Floating Compact Player choice and scopes Appearance rows by trusted client profile. Existing account rows become `desktop` without changing their saved colors, palette, player group, or waveform history; web desktop and Tauri share that profile. Composite account/profile ownership prevents cross-profile collisions, while constraints reserve independent `mobile`, `tv`, and `apple` rows for future clients. Existing table grants remain sufficient and no client-controlled account or profile field is introduced.

`0057_aggregate_appearance_workspace.sql` stores the revisioned Main elements, Player & Seekbar, and Selection accent workspace in one account/profile row. It migrates the legacy accent and custom player colors, bounds complete player history to five sets, and supplies the conditional-save revision used to prevent lost updates.

`0058_album_details_appearance.sql` adds the account-owned Album Details layout and currently-playing perimeter-animation choices to that same revisioned appearance row. Closed constraints preserve the three approved layouts and enabled/disabled motion choices; no separate preference store or client-selected owner/profile key is introduced.

`0059_alert_appearance_family.sql` adds the account-owned curated alert-family choice to the revisioned appearance row. The closed `ember`, `signal`, and `quiet` values coordinate Error, Warning, and Info treatments; `ember` preserves the approved default red-black alert style.

`0060_player_aware_interaction_outline.sql` replaces the legacy Item hover border and Keyboard focus keys with one source-aware `item_outline` object. Existing rows preserve the visible focus color first, fall back to the hover-border color, and otherwise use the automatic source. Reruns rewrite only rows that still carry either legacy key. The replacement constraint accepts the four retained interaction colors plus the closed automatic, theme, player, or custom outline contract.

`0061_create_missing_album_removal_function.sql` moves confirmed missing-album deletion behind a bounded security-definer function. The application role can execute the function without receiving direct delete privileges on library inventory tables.

`0062_narrow_readonly_account_privileges.sql` removes table-wide readonly access to account identity data and restores only the non-private operational columns needed for approved verification. The sanitized security-audit table remains readable under the deployment's operator-access policy.

`0063_replace_missing_album_removal_lock_snapshot.sql` acquires the inventory publication lock in a separate statement before the volatile missing-album removal function reads inventory. A removal that waits for a publisher sees its committed active files before deciding whether deletion is allowed. The function retains its original guards, result shape, security-definer scope, and execution grants.

`0064_grant_library_membership_delete.sql` grants the application role `DELETE` only on `library.library_memberships` so the existing authorized access-removal transaction can complete. Other runtime and readonly privileges are unchanged.

`0063_create_durable_job_foundation.sql` adds the private shared job ledger, transition history, and worker heartbeat tables. It closes the initial job-kind and state sets, enforces bounded JSON and coherent lease/terminal state, and adds claim, status, retry, and retention indexes. The application can enqueue and request cancellation, the dedicated worker can claim and transition work, and neither the worker nor readonly role receives deletion access; retention remains migrator-owned.

`0064_request_durable_job_cancellation.sql` replaces direct application updates with a narrowly granted, migrator-owned cancellation function. It atomically cancels queued or retry-wait work with one transition, records only cooperative cancellation metadata for running work, and leaves terminal or inaccessible jobs unchanged.

`0065_harden_durable_job_boundaries.sql` closes transition history to legal state-machine edges, narrows worker updates to orchestration columns, and preserves the first accepted running-job cancellation metadata when requests repeat.

`0066_grant_worker_authorization_reads.sql` grants the worker only the non-secret, column-scoped account, ownership, library-membership, capability, and request-origin reads required to revalidate durable-job authority from stable identifiers. It grants no table-wide reads, sequence access, or access to private identity, credential, origin-key, or filesystem fields.

`0067_add_job_transition_retention_index.sql` adds the timestamp-and-ID index used by bounded migrator-owned transition retention. It grants no runtime deletion privilege.

`0068_create_scan_job_intents.sql` adds private full-scan and targeted-reconciliation intent records, stable root references, active full-scan exclusion, lifecycle synchronization, bounded checkpointing, orphan recovery, and claimed-intent loaders. Generic jobs retain only stable intent identities; raw paths remain in the private scan domain.

`0069_grant_worker_targeted_reconciliation.sql` adds claimed-scope revalidation and a lease-fenced targeted inventory publication boundary. The worker receives only the narrow functions and columns needed to reconstruct authorized roots and publish one claimed reconciliation.

`0070_authorize_full_scan_lifecycle.sql` adds an atomic created-versus-already-active acceptance result and domain-linked active full-scan cancellation. Authorized library operators can request cancellation without direct scan-domain table access, while malformed or unlinked generic jobs remain outside the cancellation boundary.

`0071_grant_worker_full_scan_execution.sql` adds claim-scoped current-root loading, private monotonic full-scan progress, and a lease-fenced same-transaction publication boundary that records the committed inventory revision. That publication transaction also inserts exactly one server-owned, path-free `post_scan_cover_refresh` job keyed by library and resulting revision; an immutable-identity collision aborts the publication instead of accepting mismatched work. A claimed follow-up validator rechecks the exact active lease and current inventory revision. The worker receives only these narrow scan-domain functions; authenticated status reads use a separate application-only projection so private current paths never enter generic job data.

`0072_create_durable_cover_job_state.sql` adds stable album, root, actor, origin, candidate-generation, revision, cancellation, and linked-job identities to cover lookup tasks; adds the bounded bulk-refresh progress projection; and registers retry-safe `cover_bulk_refresh` work without weakening existing job kinds. Historical notification metadata is scrubbed of album payloads and track paths while the private selected-cover column remains in the cover domain.

`0073_grant_worker_cover_lookup.sql` adds claim-scoped cover-task validation, current album/root/path reconstruction, bounded cancellation observation, and row-revision-plus-lease-fenced task publication. The worker receives only execute access to these narrow functions; private paths and provider results remain confined to the cover domain.

`0074_grant_worker_cover_refresh.sql` adds atomic user bulk-refresh acceptance, one shared claimed execution scope for manual and post-scan refreshes, durable progress and cancellation, and an authenticated status projection. The worker reconstructs private inventory only through lease-fenced functions, while generic job rows and status retain opaque IDs, counts, and safe labels.

`0075_create_remote_cover_save_checkpoints.sql` adds atomic remote-selection acceptance and a private, revisioned checkpoint record for download, owned-artifact, selection, promotion, publication, rollback, and ambiguous recovery states. The worker can load private candidate/root/path scope and advance or publish only through an active lease-fenced job.

`0076_complete_durable_scan_status_projection.sql` keeps authenticated scan status authoritative through publication. It projects the committed album count, exposes relation publication as active scan work, and bridges the atomically queued post-scan cover job into cover progress without exposing generic job identities or private paths.

`0077_create_lastfm_retry_job_state.sql` makes each accepted Last.fm provider retry an explicit one-attempt durable job. It adds stable pending-row and active-session identities, bounded attempt and disposition state, idempotent source identity, and a due-retry index while keeping scrobble payloads in the private integration domain.

`0078_grant_worker_lastfm_retry.sql` adds the lease-fenced validation, secret-loading, attempt transition, terminal convergence, and bounded legacy-adoption functions used by the worker. The worker receives execute access only and retains no direct Last.fm table access; possible-send outcomes converge to held ambiguity instead of automatic replay.

`0079_create_auth_mail_job_state.sql` extends the existing mail outbox with stable actor, origin, accepted-attempt, checkpoint, revision, provider-disposition, and current-job fences. It classifies legacy token-bearing invitation and reset work as non-replayable, preserves completed evidence, and supports atomic tokenless intent plus generic-job composition without copying recipients, tokens, links, messages, or SMTP settings into the generic ledger.

`0080_grant_worker_auth_mail.sql` adds category-specific claimed authorization, minimum delivery-context loading, hash-only token issuance, send checkpoints, terminal convergence, welcome retry scheduling, and bounded legacy-welcome adoption. The dedicated worker receives execute access only to lease-fenced functions and no broad reads of accounts, credentials, tokens, mail outbox, throttles, audit records, or settings; uncertain invitation and reset delivery remains ambiguous and is never replayed automatically.

`0081_validate_durable_worker_startup.sql` adds the closed startup contract used before a worker advertises readiness. It requires the exact registered handler set, every handler-owned function and execute grant, generic-ledger table and update-column grants, and transition-sequence usage. It returns only a boolean and exposes no schema, role, path, credential, or job detail.

`0082_retire_vacated_structural_album.sql` adds narrow application and worker boundaries for retiring zero-track album rows after structural and durable targeted reconciliation. It validates and locks same-library identities, preserves real track tombstones and cover-save checkpoint references, moves durable key/ID dependents with conflict-safe semantics, and sweeps only exact artist/title/year/edition siblings. The family-wide `separate_releases` marker does not protect an otherwise empty duplicate row; track ownership and active cover checkpoints remain row-specific guards. The targeted worker entry point additionally requires the current job attempt, lease, intent, and committed publication before using server-recorded affected album keys. Roles receive only function execution rather than destructive table privileges.

Durable-jobs launch, health, shutdown, promotion, rollback, retention, and troubleshooting guidance is maintained in [`docs/operations/postgres-durable-jobs.md`](../../docs/operations/postgres-durable-jobs.md).

Set `PGPASSFILE` when passwordless local automation is required. Keep migration SQL idempotent and review query plans for index-sensitive changes.
