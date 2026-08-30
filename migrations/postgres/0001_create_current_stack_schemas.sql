create schema if not exists app;
create schema if not exists library;
create schema if not exists integration;
create schema if not exists ops;

create table if not exists ops.schema_migrations (
  migration_name text primary key,
  checksum text not null,
  applied_at timestamptz not null default now()
);

create table if not exists app.accounts (
  id bigint generated always as identity primary key,
  display_name text not null,
  account_kind text not null default 'bootstrap_owner',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists app.bootstrap_owners (
  id bigint generated always as identity primary key,
  account_id bigint not null references app.accounts(id) on delete cascade,
  owner_key text not null,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create unique index if not exists bootstrap_owners_account_id_idx
  on app.bootstrap_owners (account_id);

create unique index if not exists bootstrap_owners_owner_key_idx
  on app.bootstrap_owners (owner_key);

create table if not exists app.account_sessions (
  id bigint generated always as identity primary key,
  account_id bigint not null references app.accounts(id) on delete cascade,
  session_token_hash text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

create unique index if not exists account_sessions_token_hash_idx
  on app.account_sessions (session_token_hash);

create index if not exists account_sessions_account_id_idx
  on app.account_sessions (account_id);

create table if not exists app.capabilities (
  id bigint generated always as identity primary key,
  account_id bigint not null references app.accounts(id) on delete cascade,
  capability_key text not null,
  scope_kind text not null default 'global',
  scope_id bigint,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists capabilities_account_id_idx
  on app.capabilities (account_id);

create unique index if not exists capabilities_active_scope_idx
  on app.capabilities (account_id, capability_key, scope_kind, scope_id)
  nulls not distinct
  where revoked_at is null;

create table if not exists library.libraries (
  id bigint generated always as identity primary key,
  owner_account_id bigint references app.accounts(id) on delete set null,
  name text not null,
  library_kind text not null default 'local',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists libraries_owner_account_id_idx
  on library.libraries (owner_account_id);

create unique index if not exists libraries_owner_name_kind_idx
  on library.libraries (owner_account_id, name, library_kind);

create table if not exists library.library_memberships (
  id bigint generated always as identity primary key,
  library_id bigint not null references library.libraries(id) on delete cascade,
  account_id bigint not null references app.accounts(id) on delete cascade,
  membership_role text not null default 'owner',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists library_memberships_account_id_idx
  on library.library_memberships (account_id);

create index if not exists library_memberships_library_id_idx
  on library.library_memberships (library_id);

create unique index if not exists library_memberships_library_account_idx
  on library.library_memberships (library_id, account_id);

create table if not exists library.library_roots (
  id bigint generated always as identity primary key,
  library_id bigint not null references library.libraries(id) on delete cascade,
  root_path text not null,
  root_kind text not null default 'main',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists library_roots_library_id_idx
  on library.library_roots (library_id);

create unique index if not exists library_roots_library_path_idx
  on library.library_roots (library_id, root_path);

create table if not exists library.library_root_provenance (
  id bigint generated always as identity primary key,
  library_root_id bigint not null references library.library_roots(id) on delete cascade,
  source_family text not null,
  source_path text,
  observed_at timestamptz not null default now(),
  source_payload jsonb not null default '{}'::jsonb
);

create index if not exists library_root_provenance_library_root_id_idx
  on library.library_root_provenance (library_root_id);

create index if not exists library_root_provenance_source_family_observed_at_idx
  on library.library_root_provenance (source_family, observed_at);

create table if not exists library.library_root_settings (
  id bigint generated always as identity primary key,
  library_id bigint not null references library.libraries(id) on delete cascade,
  layout_mode text not null default 'artist_album',
  root_categories jsonb not null default '{}'::jsonb,
  settings_payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create unique index if not exists library_root_settings_library_unique_idx
  on library.library_root_settings (library_id);

create table if not exists library.move_policy_settings (
  id bigint generated always as identity primary key,
  library_id bigint not null references library.libraries(id) on delete cascade,
  policy_key text not null,
  policy_payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists move_policy_settings_library_id_idx
  on library.move_policy_settings (library_id);

create unique index if not exists move_policy_settings_library_policy_idx
  on library.move_policy_settings (library_id, policy_key);

create table if not exists library.local_artists (
  id bigint generated always as identity primary key,
  library_id bigint not null references library.libraries(id) on delete cascade,
  artist_key text not null,
  name text not null,
  sort_name text,
  mbid uuid,
  mbid_assertion_state text not null default 'unreviewed',
  evidence_source text,
  evidence_confidence numeric(5, 4),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists local_artists_library_id_idx
  on library.local_artists (library_id);

create index if not exists local_artists_library_state_idx
  on library.local_artists (library_id, mbid_assertion_state);

create index if not exists local_artists_library_source_state_idx
  on library.local_artists (library_id, evidence_source, mbid_assertion_state);

create unique index if not exists local_artists_library_artist_key_idx
  on library.local_artists (library_id, artist_key);

create table if not exists library.local_albums (
  id bigint generated always as identity primary key,
  library_id bigint not null references library.libraries(id) on delete cascade,
  artist_id bigint references library.local_artists(id) on delete set null,
  album_key text not null,
  title text not null,
  release_year integer,
  mbid uuid,
  mbid_assertion_state text not null default 'unreviewed',
  evidence_source text,
  evidence_confidence numeric(5, 4),
  cover_path text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists local_albums_library_id_idx
  on library.local_albums (library_id);

create index if not exists local_albums_artist_id_idx
  on library.local_albums (artist_id);

create index if not exists local_albums_library_state_idx
  on library.local_albums (library_id, mbid_assertion_state);

create index if not exists local_albums_library_source_state_idx
  on library.local_albums (library_id, evidence_source, mbid_assertion_state);

create unique index if not exists local_albums_library_album_key_idx
  on library.local_albums (library_id, album_key);

create table if not exists library.local_album_featured_artists (
  id bigint generated always as identity primary key,
  library_id bigint not null references library.libraries(id) on delete cascade,
  album_id bigint not null references library.local_albums(id) on delete cascade,
  artist_id bigint not null references library.local_artists(id) on delete cascade,
  featured_kind text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  constraint local_album_featured_artists_featured_kind_check check (
    featured_kind in ('owner', 'featured_member', 'featured_track_artist')
  )
);

create index if not exists local_album_featured_artists_library_id_idx
  on library.local_album_featured_artists (library_id);

create index if not exists local_album_featured_artists_album_id_idx
  on library.local_album_featured_artists (album_id);

create index if not exists local_album_featured_artists_artist_id_idx
  on library.local_album_featured_artists (artist_id);

create index if not exists local_album_featured_artists_library_artist_idx
  on library.local_album_featured_artists (library_id, artist_id);

create unique index if not exists local_album_featured_artists_identity_idx
  on library.local_album_featured_artists (library_id, album_id, artist_id, featured_kind);

create table if not exists library.local_tracks (
  id bigint generated always as identity primary key,
  library_id bigint not null references library.libraries(id) on delete cascade,
  album_id bigint references library.local_albums(id) on delete set null,
  artist_id bigint references library.local_artists(id) on delete set null,
  track_key text not null,
  title text not null,
  disc_number integer,
  track_number integer,
  duration_seconds numeric(12, 3),
  mbid uuid,
  mbid_assertion_state text not null default 'unreviewed',
  evidence_source text,
  evidence_confidence numeric(5, 4),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists local_tracks_library_id_idx
  on library.local_tracks (library_id);

create index if not exists local_tracks_album_id_idx
  on library.local_tracks (album_id);

create index if not exists local_tracks_artist_id_idx
  on library.local_tracks (artist_id);

create index if not exists local_tracks_library_seen_idx
  on library.local_tracks (library_id, last_seen_at);

create index if not exists local_tracks_library_source_state_idx
  on library.local_tracks (library_id, evidence_source, mbid_assertion_state);

create unique index if not exists local_tracks_library_track_key_idx
  on library.local_tracks (library_id, track_key);

create table if not exists library.local_track_files (
  id bigint generated always as identity primary key,
  track_id bigint not null references library.local_tracks(id) on delete cascade,
  library_root_id bigint references library.library_roots(id) on delete set null,
  private_path text not null,
  relative_path text,
  file_size_bytes bigint,
  modified_at timestamptz,
  content_signature text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists local_track_files_track_id_idx
  on library.local_track_files (track_id);

create index if not exists local_track_files_library_root_id_idx
  on library.local_track_files (library_root_id);

create unique index if not exists local_track_files_private_path_idx
  on library.local_track_files (private_path);

create table if not exists library.local_artist_mbid_assertions (
  id bigint generated always as identity primary key,
  artist_id bigint not null references library.local_artists(id) on delete cascade,
  evidence_source text not null,
  mbid uuid,
  mbid_assertion_state text not null,
  confidence numeric(5, 4),
  explanation text,
  observed_at timestamptz not null default now(),
  source_payload jsonb not null default '{}'::jsonb
);

create index if not exists local_artist_mbid_assertions_artist_id_idx
  on library.local_artist_mbid_assertions (artist_id);

create index if not exists local_artist_mbid_assertions_source_state_idx
  on library.local_artist_mbid_assertions (evidence_source, mbid_assertion_state);

create table if not exists library.ignored_versions (
  id bigint generated always as identity primary key,
  library_id bigint not null references library.libraries(id) on delete cascade,
  version_key text not null,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists ignored_versions_library_id_idx
  on library.ignored_versions (library_id);

create unique index if not exists ignored_versions_library_key_idx
  on library.ignored_versions (library_id, version_key);

create table if not exists library.ignored_repairs (
  id bigint generated always as identity primary key,
  library_id bigint not null references library.libraries(id) on delete cascade,
  repair_key text not null,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists ignored_repairs_library_id_idx
  on library.ignored_repairs (library_id);

create unique index if not exists ignored_repairs_library_key_idx
  on library.ignored_repairs (library_id, repair_key);

create table if not exists library.manual_versions (
  id bigint generated always as identity primary key,
  library_id bigint not null references library.libraries(id) on delete cascade,
  child_key text not null,
  parent_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists manual_versions_library_id_idx
  on library.manual_versions (library_id);

create unique index if not exists manual_versions_library_child_idx
  on library.manual_versions (library_id, child_key);

create table if not exists library.separate_releases (
  id bigint generated always as identity primary key,
  library_id bigint not null references library.libraries(id) on delete cascade,
  release_key text not null,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists separate_releases_library_id_idx
  on library.separate_releases (library_id);

create unique index if not exists separate_releases_library_key_idx
  on library.separate_releases (library_id, release_key);

create table if not exists library.exception_overrides (
  id bigint generated always as identity primary key,
  library_id bigint not null references library.libraries(id) on delete cascade,
  track_id bigint references library.local_tracks(id) on delete set null,
  track_key text,
  override_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists exception_overrides_library_id_idx
  on library.exception_overrides (library_id);

create index if not exists exception_overrides_track_id_idx
  on library.exception_overrides (track_id);

create unique index if not exists exception_overrides_library_track_key_idx
  on library.exception_overrides (library_id, track_key);

create table if not exists app.track_preferences (
  id bigint generated always as identity primary key,
  account_id bigint not null references app.accounts(id) on delete cascade,
  library_id bigint references library.libraries(id) on delete cascade,
  track_id bigint references library.local_tracks(id) on delete cascade,
  track_key text not null,
  rating integer,
  love_tier text,
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists track_preferences_account_id_idx
  on app.track_preferences (account_id);

create index if not exists track_preferences_library_id_idx
  on app.track_preferences (library_id);

create index if not exists track_preferences_track_id_idx
  on app.track_preferences (track_id);

create unique index if not exists track_preferences_account_track_key_idx
  on app.track_preferences (account_id, track_key);

create table if not exists app.saved_loops (
  id bigint generated always as identity primary key,
  account_id bigint references app.accounts(id) on delete set null,
  library_id bigint references library.libraries(id) on delete cascade,
  track_id bigint references library.local_tracks(id) on delete set null,
  loop_key text not null,
  source_private_path text,
  loop_private_path text,
  start_seconds numeric(12, 3) not null,
  end_seconds numeric(12, 3) not null,
  parent_loop_id bigint references app.saved_loops(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists saved_loops_account_id_idx
  on app.saved_loops (account_id);

create index if not exists saved_loops_library_id_idx
  on app.saved_loops (library_id);

create index if not exists saved_loops_track_id_idx
  on app.saved_loops (track_id);

create index if not exists saved_loops_parent_loop_id_idx
  on app.saved_loops (parent_loop_id);

create unique index if not exists saved_loops_loop_key_idx
  on app.saved_loops (loop_key);

create table if not exists integration.lastfm_settings (
  id bigint generated always as identity primary key,
  account_id bigint not null references app.accounts(id) on delete cascade,
  provider_username text,
  timezone_name text,
  settings_payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create unique index if not exists lastfm_settings_account_unique_idx
  on integration.lastfm_settings (account_id);

create table if not exists integration.lastfm_sessions (
  id bigint generated always as identity primary key,
  account_id bigint not null references app.accounts(id) on delete cascade,
  provider_username text,
  session_key_encrypted text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists lastfm_sessions_account_id_idx
  on integration.lastfm_sessions (account_id);

create table if not exists integration.pending_scrobbles (
  id bigint generated always as identity primary key,
  library_id bigint references library.libraries(id) on delete cascade,
  account_id bigint references app.accounts(id) on delete set null,
  track_id bigint references library.local_tracks(id) on delete set null,
  track_key text,
  played_at timestamptz not null,
  attempt_count integer not null default 0,
  next_attempt_at timestamptz,
  status text not null default 'pending',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists pending_scrobbles_library_id_idx
  on integration.pending_scrobbles (library_id);

create index if not exists pending_scrobbles_account_id_idx
  on integration.pending_scrobbles (account_id);

create index if not exists pending_scrobbles_track_id_idx
  on integration.pending_scrobbles (track_id);

create index if not exists pending_scrobbles_status_next_attempt_idx
  on integration.pending_scrobbles (status, next_attempt_at);

create table if not exists integration.scrobble_retry_state (
  id bigint generated always as identity primary key,
  pending_scrobble_id bigint references integration.pending_scrobbles(id) on delete cascade,
  provider_name text not null default 'lastfm',
  retry_status text not null,
  attempt_count integer not null default 0,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz,
  last_error text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists scrobble_retry_state_pending_scrobble_id_idx
  on integration.scrobble_retry_state (pending_scrobble_id);

create index if not exists scrobble_retry_state_provider_next_attempt_idx
  on integration.scrobble_retry_state (provider_name, next_attempt_at);

create table if not exists integration.listen_history (
  id bigint generated always as identity primary key,
  library_id bigint references library.libraries(id) on delete cascade,
  account_id bigint references app.accounts(id) on delete set null,
  track_id bigint references library.local_tracks(id) on delete set null,
  track_key text,
  played_at timestamptz not null,
  listen_source text not null default 'local',
  source_family text,
  source_entry_id text,
  scrobble_status text,
  request_origin text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists listen_history_library_id_played_at_idx
  on integration.listen_history (library_id, played_at);

create index if not exists listen_history_account_id_played_at_idx
  on integration.listen_history (account_id, played_at);

create index if not exists listen_history_track_id_idx
  on integration.listen_history (track_id);

create unique index if not exists listen_history_source_identity_idx
  on integration.listen_history (source_family, source_entry_id)
  where source_family is not null and source_entry_id is not null;

create table if not exists integration.lastfm_loved_tracks (
  id bigint generated always as identity primary key,
  account_id bigint not null references app.accounts(id) on delete cascade,
  library_id bigint references library.libraries(id) on delete cascade,
  track_id bigint references library.local_tracks(id) on delete set null,
  track_key text not null,
  provider_username text,
  lastfm_loved boolean not null default true,
  loved_at timestamptz,
  observed_at timestamptz not null default now(),
  source_payload jsonb not null default '{}'::jsonb
);

create index if not exists lastfm_loved_tracks_account_id_idx
  on integration.lastfm_loved_tracks (account_id);

create index if not exists lastfm_loved_tracks_library_id_idx
  on integration.lastfm_loved_tracks (library_id);

create index if not exists lastfm_loved_tracks_track_id_idx
  on integration.lastfm_loved_tracks (track_id);

create unique index if not exists lastfm_loved_tracks_account_track_key_idx
  on integration.lastfm_loved_tracks (account_id, track_key);

create table if not exists ops.cover_lookup_tasks (
  id bigint generated always as identity primary key,
  library_id bigint references library.libraries(id) on delete cascade,
  task_key text not null,
  status text not null,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  album_key text,
  selected_cover_private_path text,
  provider_payload jsonb not null default '{}'::jsonb,
  error_message text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists cover_lookup_tasks_library_id_idx
  on ops.cover_lookup_tasks (library_id);

create index if not exists cover_lookup_tasks_status_requested_at_idx
  on ops.cover_lookup_tasks (status, requested_at);

create unique index if not exists cover_lookup_tasks_task_key_idx
  on ops.cover_lookup_tasks (task_key);

create table if not exists ops.migration_runs (
  id bigint generated always as identity primary key,
  migration_name text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  dry_run boolean not null default true,
  status text not null default 'running',
  report_path text,
  summary jsonb not null default '{}'::jsonb
);

create index if not exists migration_runs_status_started_at_idx
  on ops.migration_runs (status, started_at);

create table if not exists ops.migration_source_summaries (
  id bigint generated always as identity primary key,
  migration_run_id bigint not null references ops.migration_runs(id) on delete cascade,
  source_family text not null,
  source_path text,
  source_count bigint not null default 0,
  target_count bigint not null default 0,
  skipped_count bigint not null default 0,
  error_count bigint not null default 0,
  warning_count bigint not null default 0,
  summary_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists migration_source_summaries_migration_run_id_idx
  on ops.migration_source_summaries (migration_run_id);

create index if not exists migration_source_summaries_source_family_idx
  on ops.migration_source_summaries (source_family);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'track_preferences_love_tier_check'
      and conrelid = 'app.track_preferences'::regclass
  ) then
    alter table app.track_preferences
      add constraint track_preferences_love_tier_check
      check (love_tier is null or love_tier in ('off', 'loved', 'obsessed'));
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    execute 'grant usage on schema app, library, integration, ops to album_haven_readonly';
    execute 'grant select on all tables in schema app, library, integration, ops to album_haven_readonly';
    execute 'grant select on all sequences in schema app, library, integration, ops to album_haven_readonly';
    execute 'alter default privileges in schema app grant select on tables to album_haven_readonly';
    execute 'alter default privileges in schema library grant select on tables to album_haven_readonly';
    execute 'alter default privileges in schema integration grant select on tables to album_haven_readonly';
    execute 'alter default privileges in schema ops grant select on tables to album_haven_readonly';
    execute 'alter default privileges in schema app grant select on sequences to album_haven_readonly';
    execute 'alter default privileges in schema library grant select on sequences to album_haven_readonly';
    execute 'alter default privileges in schema integration grant select on sequences to album_haven_readonly';
    execute 'alter default privileges in schema ops grant select on sequences to album_haven_readonly';
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    execute 'grant usage on schema app, library, integration, ops to album_haven_app';
    execute 'revoke all on all tables in schema app, library, integration, ops from album_haven_app';
    execute 'revoke all on all sequences in schema app, library, integration, ops from album_haven_app';
    execute 'grant select, insert, update on all tables in schema app, library, integration to album_haven_app';
    execute 'grant select, insert, update on table ops.cover_lookup_tasks to album_haven_app';
    execute 'grant usage, select on all sequences in schema app, library, integration to album_haven_app';
    execute 'grant usage, select on sequence ops.cover_lookup_tasks_id_seq to album_haven_app';
    execute 'alter default privileges in schema app grant select, insert, update on tables to album_haven_app';
    execute 'alter default privileges in schema library grant select, insert, update on tables to album_haven_app';
    execute 'alter default privileges in schema integration grant select, insert, update on tables to album_haven_app';
    execute 'alter default privileges in schema app grant usage, select on sequences to album_haven_app';
    execute 'alter default privileges in schema library grant usage, select on sequences to album_haven_app';
    execute 'alter default privileges in schema integration grant usage, select on sequences to album_haven_app';
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'saved_loops_time_order_check'
      and conrelid = 'app.saved_loops'::regclass
  ) then
    alter table app.saved_loops
      add constraint saved_loops_time_order_check
      check (end_seconds > start_seconds);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'track_preferences_rating_range_check'
      and conrelid = 'app.track_preferences'::regclass
  ) then
    alter table app.track_preferences
      add constraint track_preferences_rating_range_check
      check (rating is null or rating between 1 and 5);
  end if;
end $$;
