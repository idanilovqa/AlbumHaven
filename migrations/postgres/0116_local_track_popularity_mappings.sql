-- App-owned mappings contain validated identity evidence, never raw media/tags.
create table library.track_popularity_mapping_versions (
  track_id bigint not null references library.local_tracks(id) on delete cascade,
  revision uuid not null,
  inventory_revision text not null check (inventory_revision ~ '^[0-9a-f]{64}$'),
  recording_mbid uuid not null,
  artist_mbid uuid,
  source_entity_id text not null check (octet_length(source_entity_id) between 1 and 512),
  mapped_at timestamptz not null,
  primary key (track_id, revision)
);

create table library.track_popularity_mapping_slots (
  track_id bigint primary key references library.local_tracks(id) on delete cascade,
  current_revision uuid,
  checked_inventory_revision text check (checked_inventory_revision ~ '^[0-9a-f]{64}$'),
  last_attempt_at timestamptz,
  retry_after timestamptz,
  last_result text check (last_result in ('ready', 'missing_global_metric',
    'missing_provider_mapping', 'ambiguous_attribution', 'provider_unavailable')),
  foreign key (track_id, current_revision)
    references library.track_popularity_mapping_versions(track_id, revision)
);

create index track_popularity_mapping_sources_idx
  on library.track_popularity_mapping_versions(source_entity_id, recording_mbid);

-- Cross-process request budget/lease. No provider I/O runs in a transaction.
create table catalog.popularity_api_refresh_state (
  provider text primary key check (provider = 'lastfm'),
  lease_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz not null default now(),
  check ((lease_token is null) = (lease_until is null))
);

insert into catalog.popularity_api_refresh_state(provider) values ('lastfm');

create table library.popularity_refresh_jobs (
  library_id bigint primary key references library.libraries(id) on delete cascade,
  run_ref uuid not null,
  status text not null check (status in ('queued','running','complete','blocked','cancelled')),
  upper_track_id bigint not null check (upper_track_id >= 0),
  last_track_id bigint not null default 0 check (last_track_id >= 0 and last_track_id <= upper_track_id),
  started_at timestamptz not null,
  updated_at timestamptz not null,
  next_batch_at timestamptz not null,
  examined_tracks bigint not null default 0 check (examined_tracks >= 0),
  provider_requests bigint not null default 0 check (provider_requests >= 0)
);

-- The bootstrap grants UPDATE and readonly SELECT on new library tables by
-- default. Reset those grants before assigning only the adapter's operations.
-- Accepted mapping history is append-only for the application role; mutable
-- current pointers, job progress and the provider lease have separate owners.
revoke all on library.track_popularity_mapping_versions,
  library.track_popularity_mapping_slots, library.popularity_refresh_jobs,
  catalog.popularity_api_refresh_state from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname='album_haven_readonly') then
    revoke all on library.track_popularity_mapping_versions,
      library.track_popularity_mapping_slots, library.popularity_refresh_jobs,
      catalog.popularity_api_refresh_state from album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname='album_haven_app') then
    revoke all on library.track_popularity_mapping_versions,
      library.track_popularity_mapping_slots, library.popularity_refresh_jobs,
      catalog.popularity_api_refresh_state from album_haven_app;
    grant usage on schema library, catalog to album_haven_app;
    grant select, insert on library.track_popularity_mapping_versions,
      library.track_popularity_mapping_slots, library.popularity_refresh_jobs to album_haven_app;
    grant update(current_revision, checked_inventory_revision, last_attempt_at,
      retry_after, last_result) on library.track_popularity_mapping_slots to album_haven_app;
    grant update(run_ref, status, upper_track_id, last_track_id, started_at,
      updated_at, next_batch_at, examined_tracks, provider_requests)
      on library.popularity_refresh_jobs to album_haven_app;
    grant select on catalog.popularity_api_refresh_state to album_haven_app;
    grant update(lease_token, lease_until, next_attempt_at)
      on catalog.popularity_api_refresh_state to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname='album_haven_migrator') then
    grant usage on schema library, catalog to album_haven_migrator;
    grant all on library.track_popularity_mapping_versions,
      library.track_popularity_mapping_slots, library.popularity_refresh_jobs,
      catalog.popularity_api_refresh_state to album_haven_migrator;
  end if;
end $$;
