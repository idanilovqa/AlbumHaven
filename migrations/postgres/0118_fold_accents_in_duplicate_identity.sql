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
