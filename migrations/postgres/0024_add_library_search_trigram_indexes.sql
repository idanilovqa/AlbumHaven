create extension if not exists pg_trgm with schema library;

do $migration$
declare
  trigram_schema name;
begin
  select namespace.nspname
    into trigram_schema
  from pg_catalog.pg_extension as extension
  join pg_catalog.pg_namespace as namespace
    on namespace.oid = extension.extnamespace
  where extension.extname = 'pg_trgm';

  if trigram_schema is null then
    raise exception using
      errcode = '42704',
      message = 'Required extension pg_trgm is not installed.';
  end if;

  if not pg_catalog.has_schema_privilege(
    current_user,
    trigram_schema,
    'USAGE'
  ) then
    raise exception using
      errcode = '42501',
      message = pg_catalog.format(
        'Migration role %I lacks USAGE on the pg_trgm schema %I.',
        current_user,
        trigram_schema
      ),
      hint = pg_catalog.format(
        'Ensure role %I has USAGE on schema %I, or have the extension owner deliberately relocate pg_trgm to library before retrying.',
        current_user,
        trigram_schema
      );
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_opclass as operator_class
    join pg_catalog.pg_am as access_method
      on access_method.oid = operator_class.opcmethod
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = operator_class.opcnamespace
    where namespace.nspname = trigram_schema
      and operator_class.opcname = 'gin_trgm_ops'
      and access_method.amname = 'gin'
  ) then
    raise exception using
      errcode = '42704',
      message = pg_catalog.format(
        'Extension pg_trgm in schema %I does not expose the required GIN operator class gin_trgm_ops.',
        trigram_schema
      );
  end if;

  execute pg_catalog.format(
    $index$
      create index if not exists local_albums_normalized_title_trgm_idx
        on library.local_albums
        using gin ((lower(btrim(coalesce(title, '')))) %I.gin_trgm_ops)
    $index$,
    trigram_schema
  );

  execute pg_catalog.format(
    $index$
      create index if not exists local_artists_normalized_name_trgm_idx
        on library.local_artists
        using gin ((lower(btrim(coalesce(name, '')))) %I.gin_trgm_ops)
    $index$,
    trigram_schema
  );

  execute pg_catalog.format(
    $index$
      create index if not exists local_albums_normalized_credited_artist_trgm_idx
        on library.local_albums
        using gin (
          (lower(btrim(coalesce(metadata ->> 'album_artist', ''))))
          %I.gin_trgm_ops
        )
    $index$,
    trigram_schema
  );

  execute pg_catalog.format(
    $index$
      create index if not exists local_tracks_normalized_title_trgm_idx
        on library.local_tracks
        using gin ((lower(btrim(coalesce(title, '')))) %I.gin_trgm_ops)
    $index$,
    trigram_schema
  );

  execute pg_catalog.format(
    $index$
      create index if not exists local_track_files_normalized_basename_trgm_idx
        on library.local_track_files
        using gin (
          (lower(btrim(regexp_replace(coalesce(private_path, ''), '^.*[\\/]', ''))))
          %I.gin_trgm_ops
        )
    $index$,
    trigram_schema
  );

  execute pg_catalog.format(
    $index$
      create index if not exists local_track_files_normalized_stem_trgm_idx
        on library.local_track_files
        using gin (
          (
            lower(
              btrim(
                regexp_replace(
                  regexp_replace(coalesce(private_path, ''), '^.*[\\/]', ''),
                  '\.[^.]*$',
                  ''
                )
              )
            )
          )
          %I.gin_trgm_ops
        )
    $index$,
    trigram_schema
  );
end
$migration$;
