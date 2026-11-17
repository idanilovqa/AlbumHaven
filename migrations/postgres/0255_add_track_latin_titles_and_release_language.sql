-- depends on: 0252_create_musicbrainz_release_transliterations.sql
-- MusicBrainz Delivery 2, S7 (owner 2026-11-17). Additive only.
--
-- 1. "Use MB language": a title written only in ideographs is read as Japanese (romaji) when
--    the matched release's MusicBrainz language is Japanese, otherwise as Chinese (pinyin).
--    The language is stored with the release's transliteration answer; '' when MusicBrainz
--    gives none. Rows answered before this migration have none yet and are asked once more.
-- 2. "Exact pronunciation, but search would still find them with plain queries": each track's
--    shown Latin form ("Tiān mén") is stored with a search key folded the way a query is
--    (no tone marks or accents, lower case, letters and digits only), so "tian men",
--    "tianmen" and "Tian Men" all find it. A background step fills and refreshes the rows.
alter table integration.musicbrainz_release_transliterations
  add column if not exists language text check (language ~ '^([a-z]{3})?$');

create table if not exists library.local_track_latin_titles (
  track_id bigint primary key references library.local_tracks(id) on delete cascade,
  library_id bigint not null,
  -- The track title the Latin form was made from; a row whose title changed is redone.
  source_title text not null,
  -- Null when no Latin form is known (no MusicBrainz form, no fallback for the script).
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
      create index if not exists local_track_latin_titles_search_key_trgm_idx
      on library.local_track_latin_titles using gin (search_key %I.gin_trgm_ops) where search_key is not null
    $index$, trigram_schema);
end
$latin_title_index$;

comment on table library.local_track_latin_titles is
  'Each track''s shown Latin form (S7) and its folded search key; derived, rebuilt from titles and MusicBrainz.';

revoke all on table library.local_track_latin_titles from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    grant select on table library.local_track_latin_titles to album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, insert, update, delete on table library.local_track_latin_titles to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant select, insert, update, delete on table library.local_track_latin_titles to album_haven_migrator;
  end if;
end $$;
