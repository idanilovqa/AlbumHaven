alter table library.local_artists
  add column if not exists mbid_assertion_migration_run_id bigint references ops.migration_runs(id) on delete set null,
  add column if not exists mbid_assertion_scan_run_ref text;

alter table library.local_albums
  add column if not exists mbid_assertion_migration_run_id bigint references ops.migration_runs(id) on delete set null,
  add column if not exists mbid_assertion_scan_run_ref text;

alter table library.local_tracks
  add column if not exists mbid_assertion_migration_run_id bigint references ops.migration_runs(id) on delete set null,
  add column if not exists mbid_assertion_scan_run_ref text;

alter table library.local_artist_mbid_assertions
  add column if not exists migration_run_id bigint references ops.migration_runs(id) on delete set null,
  add column if not exists mbid_assertion_scan_run_ref text;

create index if not exists local_artists_mbid_assertion_migration_run_id_idx
  on library.local_artists (mbid_assertion_migration_run_id);

create index if not exists local_albums_mbid_assertion_migration_run_id_idx
  on library.local_albums (mbid_assertion_migration_run_id);

create index if not exists local_tracks_mbid_assertion_migration_run_id_idx
  on library.local_tracks (mbid_assertion_migration_run_id);

create index if not exists local_artists_library_source_state_migration_idx
  on library.local_artists (
    library_id,
    evidence_source,
    mbid_assertion_state,
    mbid_assertion_migration_run_id
  );

create index if not exists local_albums_library_source_state_migration_idx
  on library.local_albums (
    library_id,
    evidence_source,
    mbid_assertion_state,
    mbid_assertion_migration_run_id
  );

create index if not exists local_tracks_library_source_state_migration_idx
  on library.local_tracks (
    library_id,
    evidence_source,
    mbid_assertion_state,
    mbid_assertion_migration_run_id
  );

create index if not exists local_artist_mbid_assertions_migration_run_id_idx
  on library.local_artist_mbid_assertions (migration_run_id);

create index if not exists local_artist_mbid_assertions_scan_run_ref_idx
  on library.local_artist_mbid_assertions (mbid_assertion_scan_run_ref);
