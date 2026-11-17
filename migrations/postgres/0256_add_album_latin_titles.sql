-- depends on: 0255_add_track_latin_titles_and_release_language.sql
-- MusicBrainz Delivery 2, S7 (owner 2026-11-17, approved b3-1d3). Additive only.
--
-- Each album's shown Latin title ("Byousoku 5 senchimeetoru…"), made like a track's (0255):
-- romaji when the matched release's MusicBrainz language is Japanese or the title has kana,
-- otherwise pinyin for ideographs; stored with a search key folded the way a query is, so
-- plain queries find the album by it. Phone album rows show it under the title. A background
-- step fills and refreshes the rows; tags, keys and sorting keep the real title.
create table if not exists library.local_album_latin_titles (
  album_id bigint primary key references library.local_albums(id) on delete cascade,
  library_id bigint not null,
  -- The album title the Latin form was made from; a row whose title changed is redone.
  source_title text not null,
  -- Null when no Latin form is known (no fallback for the script).
  latin text check (char_length(latin) between 1 and 2048),
  search_key text check (search_key ~ '^[a-z0-9]+$'),
  -- The album's release decision or MusicBrainz answer the row was made from (their latest
  -- update); a newer one redoes it. Null when the album has neither.
  source_updated_at timestamptz,
  check ((latin is null) = (search_key is null))
);

do $latin_title_index$
declare
  trigram_schema text;
begin
  select namespace.nspname into trigram_schema
  from pg_catalog.pg_extension extension
  join pg_catalog.pg_namespace namespace on namespace.oid = extension.extnamespace
  where extension.extname = 'pg_trgm';
  if trigram_schema is null then
    raise exception using errcode = '42704', message = 'Extension pg_trgm is not installed.';
  end if;
  execute pg_catalog.format(
    $index$
      create index if not exists local_album_latin_titles_search_key_trgm_idx
      on library.local_album_latin_titles using gin (search_key %I.gin_trgm_ops) where search_key is not null
    $index$, trigram_schema);
end
$latin_title_index$;

-- The few albums whose title has a character beyond Latin, Cyrillic and general punctuation,
-- as for tracks (0255): the background refresh reads only these. The pattern is
-- music_app.services.track_transliteration._BEYOND_LATIN, written identically.
create index if not exists local_albums_beyond_latin_title_idx
  on library.local_albums (library_id)
  where title ~ '[^\x01-\u024f\u0400-\u052f\u1e00-\u1eff\u2000-\u206f]';

comment on table library.local_album_latin_titles is
  'Each album''s shown Latin title (S7) and its folded search key; derived, rebuilt from titles and MusicBrainz.';

revoke all on table library.local_album_latin_titles from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    grant select on table library.local_album_latin_titles to album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, insert, update, delete on table library.local_album_latin_titles to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant select, insert, update, delete on table library.local_album_latin_titles to album_haven_migrator;
  end if;
end $$;
