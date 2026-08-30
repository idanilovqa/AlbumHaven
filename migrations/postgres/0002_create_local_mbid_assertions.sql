create table if not exists library.local_mbid_assertions (
  id bigint generated always as identity primary key,
  library_id bigint not null references library.libraries(id) on delete cascade,
  artist_id bigint references library.local_artists(id) on delete cascade,
  album_id bigint references library.local_albums(id) on delete cascade,
  track_id bigint references library.local_tracks(id) on delete cascade,
  target_kind text not null,
  target_key text not null,
  evidence_source text not null,
  mbid uuid,
  mbid_assertion_state text not null,
  confidence numeric(5, 4),
  explanation text,
  observed_at timestamptz not null default now(),
  migration_run_id bigint references ops.migration_runs(id) on delete set null,
  source_payload jsonb not null default '{}'::jsonb
);

create index if not exists local_mbid_assertions_library_id_idx
  on library.local_mbid_assertions (library_id);

create index if not exists local_mbid_assertions_artist_id_idx
  on library.local_mbid_assertions (artist_id);

create index if not exists local_mbid_assertions_album_id_idx
  on library.local_mbid_assertions (album_id);

create index if not exists local_mbid_assertions_track_id_idx
  on library.local_mbid_assertions (track_id);

create index if not exists local_mbid_assertions_migration_run_id_idx
  on library.local_mbid_assertions (migration_run_id);

create index if not exists local_mbid_assertions_library_kind_state_idx
  on library.local_mbid_assertions (library_id, target_kind, mbid_assertion_state);

create index if not exists local_mbid_assertions_source_state_idx
  on library.local_mbid_assertions (evidence_source, mbid_assertion_state);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'local_mbid_assertions_target_kind_check'
      and conrelid = 'library.local_mbid_assertions'::regclass
  ) then
    alter table library.local_mbid_assertions
      add constraint local_mbid_assertions_target_kind_check
      check (target_kind in ('artist', 'album', 'track'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'local_mbid_assertions_target_fk_match_check'
      and conrelid = 'library.local_mbid_assertions'::regclass
  ) then
    alter table library.local_mbid_assertions
      add constraint local_mbid_assertions_target_fk_match_check
      check (
        (target_kind = 'artist' and artist_id is not null and album_id is null and track_id is null)
        or (target_kind = 'album' and artist_id is null and album_id is not null and track_id is null)
        or (target_kind = 'track' and artist_id is null and album_id is null and track_id is not null)
      );
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    execute 'grant select on table library.local_mbid_assertions to album_haven_readonly';
    execute 'grant select on sequence library.local_mbid_assertions_id_seq to album_haven_readonly';
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    execute 'grant select, insert, update on table library.local_mbid_assertions to album_haven_app';
    execute 'grant usage, select on sequence library.local_mbid_assertions_id_seq to album_haven_app';
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    execute 'grant select, insert, update on table library.local_mbid_assertions to album_haven_migrator';
    execute 'grant usage, select on sequence library.local_mbid_assertions_id_seq to album_haven_migrator';
  end if;
end $$;
