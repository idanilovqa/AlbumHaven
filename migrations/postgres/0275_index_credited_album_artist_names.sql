-- depends on: 0192_create_musicbrainz_album_credits_and_artist_groups.sql
-- MusicBrainz Delivery 2: search finds an album by the name its release credits, where
-- that isn't the artist's main one, beside its tags. Additive only. The index holds just the releases credited to one
-- artist under another name than the main one, written as the search's predicate is, so a search
-- reads the matching releases' albums and never every release.
do $credited_name_index$
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
      create index if not exists musicbrainz_releases_credited_name_trgm_idx
      on integration.musicbrainz_releases using gin (
        (lower(btrim(coalesce(artist_credit -> 0 ->> 'name', '')))) %I.gin_trgm_ops
      ) where jsonb_array_length(artist_credit) = 1
          and artist_credit -> 0 ->> 'name' is distinct from artist_credit -> 0 ->> 'artist_name'
    $index$, trigram_schema);
end
$credited_name_index$;
