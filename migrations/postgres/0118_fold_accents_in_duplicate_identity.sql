-- Duplicate albums must match regardless of Latin accent marks, so
-- «Non al denaro non all'amore né al cielo» and «… Nè Al Cielo» are one
-- release in two places. The identity folds accents the same way search does
-- (library.fold_search_accents: Latin letters only, so й and ё stay distinct),
-- then collapses whitespace. Its expression index is rebuilt for the new values.
create or replace function library.duplicate_identity_text(value text)
returns text
language sql
immutable
parallel safe
strict
set search_path = pg_catalog, pg_temp
as $$
  select btrim(regexp_replace(library.fold_search_accents(value), '[[:space:]]+', ' ', 'g'))
$$;

reindex index library.local_track_files_active_duplicate_identity_idx;

-- 0112's stored album identity was computed with the old function; replacing the
-- function does not recompute stored generated values, so rewrite the column with
-- the same expression.
alter table library.local_track_files
  alter column scan_file_album_identity set expression as (
    case when jsonb_typeof(metadata #> '{scan_cache,file_entry}') = 'object'
      then library.duplicate_identity_text(
        nullif(lower(btrim(metadata #>> '{scan_cache,file_entry,album}')), '')
      )
    end
  );

-- Search matches a track file's CD name (disc subtitle). Without an index that
-- match read every file's metadata on every search; this partial trigram index
-- covers only files that have a CD name, like 0092's file-path prefilter.
do $indexes$
declare
  trigram_schema text;
begin
  select namespace.nspname
    into trigram_schema
  from pg_catalog.pg_extension extension
  join pg_catalog.pg_namespace namespace
    on namespace.oid = extension.extnamespace
  where extension.extname = 'pg_trgm';

  if trigram_schema is null then
    raise exception using
      errcode = '42704',
      message = 'Extension pg_trgm is not installed.';
  end if;

  execute pg_catalog.format(
    $index$
      create index if not exists local_track_files_disc_subtitle_search_trgm_idx
      on library.local_track_files using gin (
        library.search_utf8_hex(lower(btrim(metadata #>> '{scan_cache,file_entry,disc_subtitle}')))
        %I.gin_trgm_ops
      )
      where btrim(metadata #>> '{scan_cache,file_entry,disc_subtitle}') <> ''
    $index$,
    trigram_schema
  );
end
$indexes$;
