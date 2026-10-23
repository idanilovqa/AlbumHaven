create or replace function library.search_utf8_hex(value text)
returns text
language sql
immutable
parallel safe
strict
set search_path = pg_catalog
as $function$
  select pg_catalog.encode(pg_catalog.convert_to(value, 'UTF8'), 'hex')
$function$;

revoke all on function library.search_utf8_hex(text) from public;

do $privileges$
begin
  if pg_catalog.to_regrole('album_haven_app') is not null then
    grant execute on function library.search_utf8_hex(text) to album_haven_app;
  end if;
  if pg_catalog.to_regrole('album_haven_migrator') is not null then
    grant execute on function library.search_utf8_hex(text) to album_haven_migrator;
  end if;
end
$privileges$;

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

  if not pg_catalog.has_schema_privilege(
    current_user,
    trigram_schema,
    'USAGE'
  ) then
    raise exception using
      errcode = '42501',
      message = pg_catalog.format(
        'Migration role %I lacks USAGE on pg_trgm schema %I.',
        current_user,
        trigram_schema
      );
  end if;

  execute pg_catalog.format(
    $index$
      create index if not exists local_tracks_search_utf8_hex_trgm_idx
      on library.local_tracks using gin (
        library.search_utf8_hex(lower(btrim(coalesce(title, ''))))
        %I.gin_trgm_ops
      )
    $index$,
    trigram_schema
  );

  execute pg_catalog.format(
    $index$
      create index if not exists local_track_files_search_utf8_hex_trgm_idx
      on library.local_track_files using gin (
        library.search_utf8_hex(lower(coalesce(private_path, '')))
        %I.gin_trgm_ops
      )
    $index$,
    trigram_schema
  );
end
$indexes$;
