-- depends on: 0191_create_discogs_fallback_identity.sql
-- MusicBrainz Delivery 2: Discogs's answer for a matched band's album that MusicBrainz lacks.
-- Additive only, no backfill. The artist fallback (0191) asks only for artists MusicBrainz
-- did not find, so without this "not found on Discogs" would mean "never asked".
--
-- A row is an answer; no row, or a signature other than the album's, means still waiting.
create table if not exists library.local_album_discogs_lookups (
  library_id bigint not null,
  album_key text not null,
  state text not null check (state in ('found', 'not_found')),
  discogs_release_id bigint references integration.discogs_releases(id) on delete restrict,
  searched_signature text not null check (char_length(searched_signature) between 1 and 64),
  observed_at timestamptz not null,
  primary key (library_id, album_key),
  foreign key (library_id, album_key) references library.local_albums(library_id, album_key)
    on update cascade on delete cascade,
  check ((state = 'found') = (discogs_release_id is not null))
);

create index if not exists local_album_discogs_lookups_not_found_idx
  on library.local_album_discogs_lookups (library_id, album_key) where state = 'not_found';

revoke all on table library.local_album_discogs_lookups from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    grant select on table library.local_album_discogs_lookups to album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, insert, update, delete on table library.local_album_discogs_lookups to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant select, insert, update, delete on table library.local_album_discogs_lookups to album_haven_migrator;
  end if;
end $$;
