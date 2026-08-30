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

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    execute 'grant select on table library.local_album_featured_artists to album_haven_readonly';
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    execute 'grant select, insert, update on table library.local_album_featured_artists to album_haven_app';
    execute 'grant usage, select on sequence library.local_album_featured_artists_id_seq to album_haven_app';
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    execute 'grant select, insert, update on table library.local_album_featured_artists to album_haven_migrator';
    execute 'grant usage, select on sequence library.local_album_featured_artists_id_seq to album_haven_migrator';
  end if;
end $$;
