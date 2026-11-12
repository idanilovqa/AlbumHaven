-- Match the Unicode collation/version boundary already used by migration 0093.
do $compatibility$
declare
  fold_function text := case when current_setting('server_version_num')::integer >= 180000
    then 'casefold' else 'lower' end;
begin
execute format($definition$
create or replace function library.fold_search_accents(value text)
returns text
language sql
immutable
parallel safe
strict
security invoker
set search_path = pg_catalog
as $function$
  select normalize(
    regexp_replace(normalize(%s(btrim(value) collate "und-x-icu"), NFD) collate "C", U&'([a-z])[\0300-\036f]+', '\1', 'g'),
    NFC
  )
$function$;
$definition$, fold_function);
end;
$compatibility$;

revoke all on function library.fold_search_accents(text) from public;

do $privileges$
begin
  if pg_catalog.to_regrole('album_haven_app') is not null then
    grant execute on function library.fold_search_accents(text) to album_haven_app;
  end if;
  if pg_catalog.to_regrole('album_haven_migrator') is not null then
    grant execute on function library.fold_search_accents(text) to album_haven_migrator;
  end if;
end
$privileges$;

do $indexes$
declare
  trigram_schema text;
begin
  select namespace.nspname into trigram_schema
  from pg_catalog.pg_extension extension
  join pg_catalog.pg_namespace namespace on namespace.oid = extension.extnamespace
  where extension.extname = 'pg_trgm';

  if trigram_schema is null then
    raise exception 'Extension pg_trgm is not installed.';
  end if;

  execute pg_catalog.format(
    'create index if not exists local_artists_name_accent_trgm_idx '
    'on library.local_artists using gin (library.fold_search_accents(name) %I.gin_trgm_ops)',
    trigram_schema
  );
  execute pg_catalog.format(
    'create index if not exists local_albums_album_artist_accent_trgm_idx '
    'on library.local_albums using gin (library.fold_search_accents(metadata ->> ''album_artist'') %I.gin_trgm_ops)',
    trigram_schema
  );
  execute pg_catalog.format(
    'create index if not exists local_albums_artists_accent_trgm_idx '
    'on library.local_albums using gin (library.fold_search_accents(metadata ->> ''artists'') %I.gin_trgm_ops)',
    trigram_schema
  );
end
$indexes$;
