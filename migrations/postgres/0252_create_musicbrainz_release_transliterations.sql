-- depends on: 0190_create_musicbrainz_release_identity.sql
-- MusicBrainz Delivery 2, S7 (owner 2026-11-17, 1A and 1E): the Latin tracklist of a matched
-- release, from the pseudo-release MusicBrainz links to it by "transl-tracklisting". Album
-- details show it after a track title in another script than Latin or Cyrillic. Additive only
-- and MusicBrainz-derived: tags, keys, sorting and search keep the real titles.
--
-- One row per release, asked once and reused for 30 days; a failed ask rests a day. The row is
-- written when the ask starts (failed_at doubles as its hold) and completed with checked_at.
create table if not exists integration.musicbrainz_release_transliterations (
  release_mbid uuid primary key references integration.musicbrainz_releases(mbid) on delete cascade,
  -- The Latin pseudo-release; null when MusicBrainz links none, or no local title needs one.
  transliteration_mbid uuid,
  -- [{"position", "tracks": [{"position", "title"}]}], positions as the matched release's media.
  media jsonb not null default '[]'::jsonb check (jsonb_typeof(media) = 'array'),
  checked_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (transliteration_mbid is not null or media = '[]'::jsonb)
);

comment on table integration.musicbrainz_release_transliterations is
  'Latin track titles of a matched release from its MusicBrainz transl-tracklisting pseudo-release; display data only.';

revoke all on table integration.musicbrainz_release_transliterations from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    grant select on table integration.musicbrainz_release_transliterations to album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, insert, update on table integration.musicbrainz_release_transliterations to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant select, insert, update on table integration.musicbrainz_release_transliterations to album_haven_migrator;
  end if;
end $$;
