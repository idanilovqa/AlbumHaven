-- Windows normcase uses Unicode lower, not full case folding; POSIX keys stay exact.
create or replace function ops.cover_path_key(path text, windows_paths boolean)
returns text
language sql
immutable
parallel safe
strict
security invoker
set search_path = pg_catalog
as $$
  select case when windows_paths
    then lower(replace(path, chr(92), '/') collate "und-x-icu")
    else path end;
$$;

-- The hash narrows candidates; callers must still compare the exact path sets.
create or replace function ops.cover_lookup_track_path_set(paths jsonb, windows_paths boolean)
returns jsonb
language sql
immutable
parallel safe
security invoker
set search_path = pg_catalog
as $$
  select coalesce(jsonb_agg(path order by path collate "C"), '[]'::jsonb)
  from (
    select distinct ops.cover_path_key(path, windows_paths) collate "C" as path
    from jsonb_array_elements_text(
      case when jsonb_typeof(paths) = 'array' then paths else '[]'::jsonb end
    ) as entries(path)
    where path is not null
  ) as normalized;
$$;

revoke all on function ops.cover_lookup_track_path_set(jsonb, boolean) from public;
revoke all on function ops.cover_path_key(text, boolean) from public;
do $privileges$
begin
  if pg_catalog.to_regrole('album_haven_app') is not null then
    grant execute on function ops.cover_path_key(text, boolean) to album_haven_app;
    grant execute on function ops.cover_lookup_track_path_set(jsonb, boolean) to album_haven_app;
  end if;
  if pg_catalog.to_regrole('album_haven_migrator') is not null then
    grant execute on function ops.cover_path_key(text, boolean) to album_haven_migrator;
    grant execute on function ops.cover_lookup_track_path_set(jsonb, boolean) to album_haven_migrator;
  end if;
end
$privileges$;

create index if not exists cover_lookup_tasks_windows_track_set_idx
on ops.cover_lookup_tasks (library_id, md5(ops.cover_lookup_track_path_set(coalesce(
  metadata -> 'track_paths', metadata #> '{source_payload,track_paths}', '[]'::jsonb
), true)::text));

create index if not exists cover_lookup_tasks_posix_track_set_idx
on ops.cover_lookup_tasks (library_id, md5(ops.cover_lookup_track_path_set(coalesce(
  metadata -> 'track_paths', metadata #> '{source_payload,track_paths}', '[]'::jsonb
), false)::text));
