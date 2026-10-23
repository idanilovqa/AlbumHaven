do $compatibility$
begin
  if current_setting('server_version_num')::integer >= 180000 then
    execute $function$
      create or replace function library.duplicate_identity_text(value text)
      returns text
      language sql
      immutable
      parallel safe
      strict
      set search_path = pg_catalog, pg_temp
      as $body$
        select btrim(
          regexp_replace(
            normalize(casefold(value collate "und-x-icu"), NFC),
            '[[:space:]]+',
            ' ',
            'g'
          )
        );
      $body$;
    $function$;
  else
    execute $function$
      create or replace function library.duplicate_identity_text(value text)
      returns text
      language sql
      immutable
      parallel safe
      strict
      set search_path = pg_catalog, pg_temp
      as $body$
        select btrim(
          regexp_replace(
            normalize(lower(value collate "und-x-icu"), NFC),
            '[[:space:]]+',
            ' ',
            'g'
          )
        );
      $body$;
    $function$;
  end if;
end;
$compatibility$;

create or replace function library.duplicate_identity_year(value text)
returns integer
language sql
immutable
parallel safe
strict
set search_path = pg_catalog, pg_temp
as $$
  with normalized as (
    select split_part(normalize(btrim(value), NFKC), '/', 1) as year
  )
  select case
    when year ~ '^[0-9]{4}$'
      and year::integer between 1000 and 9999
    then year::integer
  end
  from normalized;
$$;

revoke all on function library.duplicate_identity_text(text) from public;
revoke all on function library.duplicate_identity_year(text) from public;

do $privileges$
begin
  if pg_catalog.to_regrole('album_haven_app') is not null then
    grant execute on function library.duplicate_identity_text(text) to album_haven_app;
    grant execute on function library.duplicate_identity_year(text) to album_haven_app;
  end if;
  if pg_catalog.to_regrole('album_haven_migrator') is not null then
    grant execute on function library.duplicate_identity_text(text) to album_haven_migrator;
    grant execute on function library.duplicate_identity_year(text) to album_haven_migrator;
  end if;
end
$privileges$;

create index if not exists local_track_files_active_duplicate_identity_idx
  on library.local_track_files (
    library.duplicate_identity_text(scan_file_album_artist),
    library.duplicate_identity_text(scan_file_album),
    library.duplicate_identity_year(scan_file_year)
  )
  include (track_id)
  where scan_cache_stale is false
    and scan_file_entry_is_object is true;
