-- depends on: 0258_invalidate_gallery_on_split_labels.sql
-- MusicBrainz Delivery 2, "MusicBrainz: artist undecided" (owner 2026-11-19, approved 2026-11-21).
-- A split name's album that stays undecided keeps what its evidence says about each MusicBrainz
-- artist of the name, for Problematic Files to propose one. A suggestion never decides an album:
-- only a choice the owner makes writes an identity, so nothing here invalidates the gallery.
-- Additive only and no backfill: each artist's next re-check fills its rows.
create table if not exists library.local_album_artist_suggestions (
  library_id bigint not null,
  album_key text not null,
  artist_mbid uuid not null references integration.musicbrainz_artists(mbid) on delete restrict,
  -- How many of the sampled recordings lead to this artist.
  found_count integer not null check (found_count >= 0),
  sampled_count integer not null check (sampled_count between 0 and 3),
  -- A decided album of this artist in the same artist folder, by its title: never a path.
  folder_album text check (folder_album is null or char_length(folder_album) between 1 and 1024),
  favoured boolean not null default false,
  matcher_version integer not null check (matcher_version >= 1),
  observed_at timestamptz not null,
  primary key (library_id, album_key, artist_mbid),
  constraint local_album_artist_suggestions_album_fkey foreign key (library_id, album_key)
    references library.local_albums(library_id, album_key) on update cascade on delete cascade,
  check (found_count <= sampled_count),
  check (not favoured or found_count > 0)
);

create unique index if not exists local_album_artist_suggestions_favoured_idx
  on library.local_album_artist_suggestions (library_id, album_key) where favoured;

comment on table library.local_album_artist_suggestions is
  'What an undecided split-name album''s evidence says about each artist of the name; proposed, never applied.';

revoke all on table library.local_album_artist_suggestions from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    grant select on table library.local_album_artist_suggestions to album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    -- A re-check replaces an artist's suggestions.
    grant select, insert, update, delete on table library.local_album_artist_suggestions to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant select, insert, update, delete on table library.local_album_artist_suggestions to album_haven_migrator;
  end if;
end $$;
