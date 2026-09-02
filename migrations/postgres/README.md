# Postgres Migrations

This directory contains repo-owned Postgres SQL migrations for Album Haven.

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

Set `PGPASSFILE` when passwordless local automation is required. Keep migration SQL idempotent and review query plans for index-sensitive changes.
