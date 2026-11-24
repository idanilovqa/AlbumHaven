-- depends on: 0198_add_musicbrainz_correction_rows_and_decisions.sql
-- MusicBrainz Delivery 2, S4. Additive only. Search matches an album's applied corrected title
-- and album artist beside its tags (owner 2026-11-16: "Search corrected too"). Without an index
-- on each corrected value the planner cannot combine 0024's tag trigram indexes with the
-- corrected arm, and scans every album on each search. The same normalized trigram indexes as
-- 0024's, partial like 0198's track indexes: only albums that carry a corrected value.
do $corrected_album_indexes$
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
      create index if not exists local_albums_corrected_title_trgm_idx
      on library.local_albums using gin (
        (lower(btrim(coalesce(corrected_title, '')))) %I.gin_trgm_ops
      ) where corrected_title is not null
    $index$, trigram_schema);
  execute pg_catalog.format(
    $index$
      create index if not exists local_albums_corrected_album_artist_trgm_idx
      on library.local_albums using gin (
        (lower(btrim(coalesce(corrected_album_artist, '')))) %I.gin_trgm_ops
      ) where corrected_album_artist is not null
    $index$, trigram_schema);
end
$corrected_album_indexes$;
