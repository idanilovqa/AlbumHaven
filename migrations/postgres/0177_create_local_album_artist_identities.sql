-- Matcher version 4 (owner decision, 2026-11-08): an album whose title, track titles and
-- track count certainly match one MusicBrainz artist's release takes that artist, whatever
-- the artist's other albums show. One row per local album records that identity; a local
-- name whose albums belong to several MusicBrainz artists ("Amarok") becomes the new
-- `per_album` match state instead of a multiple match. Rows follow an album's re-key and
-- leave with the album. `tag_differs` marks an album whose tag names another artist, for a
-- later approved tag correction; nothing here changes media or tags.
create table if not exists library.local_album_artist_identities (
  library_id bigint not null,
  album_key text not null,
  artist_mbid uuid not null references integration.musicbrainz_artists(mbid) on delete restrict,
  decision_source text not null default 'automatic' check (decision_source in ('automatic', 'manual')),
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  tag_differs boolean not null default false,
  matcher_version integer not null check (matcher_version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (library_id, album_key),
  constraint local_album_artist_identities_album_fkey foreign key (library_id, album_key)
    references library.local_albums(library_id, album_key)
    on update cascade on delete cascade
);

create index if not exists local_album_artist_identities_artist_mbid_idx
  on library.local_album_artist_identities (artist_mbid);

comment on table library.local_album_artist_identities is
  'The MusicBrainz artist each local album certainly belongs to (title, track titles and track count agree).';

alter table library.local_artist_musicbrainz_matches
  drop constraint if exists local_artist_musicbrainz_matches_state_check;
alter table library.local_artist_musicbrainz_matches
  add constraint local_artist_musicbrainz_matches_state_check check (
    state in ('pending', 'matched', 'ambiguous', 'not_found', 'conflict', 'manual_review', 'per_album')
  );

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    grant select on table library.local_album_artist_identities to album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    -- A re-check replaces an artist's automatic album identities.
    grant select, insert, update, delete on table library.local_album_artist_identities to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant select, insert, update on table library.local_album_artist_identities to album_haven_migrator;
  end if;
end $$;
