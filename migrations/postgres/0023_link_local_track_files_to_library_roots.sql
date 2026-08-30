-- Root-linkage repair only. This migration does not add alias, MBID, MusicBrainz,
-- Last.fm, or normalization tables and is unrelated to the prohibited alias/MBID 0023.

create or replace function library.local_path_style(path_value text)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when btrim(coalesce(path_value, '')) ~ '^[A-Za-z]:[\\/]' then 'windows'
    when btrim(coalesce(path_value, '')) ~ '^(\\\\|//)[^\\/]+[\\/][^\\/]+' then 'windows'
    when btrim(coalesce(path_value, '')) ~ '^/' then 'posix'
    else 'unknown'
  end;
$$;

create or replace function library.local_path_key(path_value text)
returns text
language sql
immutable
parallel safe
as $$
  select case library.local_path_style(path_value)
    when 'windows' then lower(
      regexp_replace(
        replace(btrim(coalesce(path_value, '')), '/', E'\\'),
        E'\\\\+$',
        ''
      )
    )
    when 'posix' then case
      when btrim(coalesce(path_value, '')) ~ '^/+$' then '/'
      else regexp_replace(btrim(coalesce(path_value, '')), '/+$', '')
    end
    else ''
  end;
$$;

create or replace function library.local_track_file_root_resolution(
  requested_library_id bigint,
  requested_private_path text,
  requested_metadata jsonb
)
returns table (
  library_root_id bigint,
  resolution_status text,
  candidate_count integer,
  resolution_method text
)
language sql
stable
parallel safe
as $$
  with input as (
    select
      library.local_path_style(requested_private_path) as private_path_style,
      library.local_path_key(requested_private_path) as private_path_key,
      array_remove(array[
        nullif(btrim(requested_metadata ->> 'library_root_id'), ''),
        nullif(btrim(requested_metadata #>> '{scan_cache,file_entry,library_root_id}'), ''),
        nullif(btrim(requested_metadata #>> '{scan_cache,file_entry,root_provenance,root_id}'), '')
      ], null) as logical_root_ids,
      array_remove(array[
        nullif(btrim(requested_metadata ->> 'library_root_path'), ''),
        nullif(btrim(requested_metadata ->> 'root_path'), ''),
        nullif(btrim(requested_metadata ->> 'music_root'), ''),
        nullif(btrim(requested_metadata #>> '{scan_cache,file_entry,library_root_path}'), ''),
        nullif(btrim(requested_metadata #>> '{scan_cache,file_entry,root_path}'), ''),
        nullif(btrim(requested_metadata #>> '{scan_cache,file_entry,music_root}'), ''),
        nullif(btrim(requested_metadata #>> '{scan_cache,file_entry,root_provenance,path}'), ''),
        nullif(btrim(requested_metadata #>> '{scan_cache,file_entry,root_provenance,root_path}'), '')
      ], null) as explicit_root_paths
  ),
  active_roots as (
    select
      library.library_roots.id,
      library.local_path_style(library.library_roots.root_path) as root_path_style,
      library.local_path_key(library.library_roots.root_path) as root_path_key,
      nullif(btrim(library.library_roots.metadata ->> 'root_id'), '') as logical_root_id
    from library.library_roots
    where library.library_roots.library_id = requested_library_id
      and library.library_roots.is_active is true
      and library.local_path_style(library.library_roots.root_path) in ('windows', 'posix')
      and library.local_path_key(library.library_roots.root_path) <> ''
  ),
  candidate_rows as (
    select active_roots.id, 0 as priority, length(active_roots.root_path_key) as match_length,
           'logical-root-id'::text as method
    from active_roots, input
    where active_roots.logical_root_id = any(input.logical_root_ids)
    union all
    select active_roots.id, 1, length(active_roots.root_path_key), 'explicit-root-path'::text
    from active_roots, input
    where exists (
      select 1
      from unnest(input.explicit_root_paths) as explicit_path(path_value)
      where library.local_path_style(explicit_path.path_value) = active_roots.root_path_style
        and library.local_path_key(explicit_path.path_value) = active_roots.root_path_key
    )
    union all
    select active_roots.id, 2, length(active_roots.root_path_key), 'longest-path-containment'::text
    from active_roots, input
    where input.private_path_style = active_roots.root_path_style
      and (
        input.private_path_key = active_roots.root_path_key
        or (
          active_roots.root_path_style = 'posix'
          and active_roots.root_path_key = '/'
          and left(input.private_path_key, 1) = '/'
        )
        or left(input.private_path_key, length(active_roots.root_path_key) + 1)
           = active_roots.root_path_key || case active_roots.root_path_style
               when 'windows' then E'\\'
               else '/'
             end
      )
  ),
  deduplicated_candidates as (
    select distinct on (candidate_rows.id)
      candidate_rows.id,
      candidate_rows.priority,
      candidate_rows.match_length,
      candidate_rows.method
    from candidate_rows
    order by candidate_rows.id, candidate_rows.priority, candidate_rows.match_length desc,
             candidate_rows.method
  ),
  priority_candidates as (
    select
      deduplicated_candidates.*,
      min(deduplicated_candidates.priority) over () as best_priority
    from deduplicated_candidates
  ),
  length_candidates as (
    select
      priority_candidates.*,
      max(priority_candidates.match_length) over () as best_match_length
    from priority_candidates
    where priority_candidates.priority = priority_candidates.best_priority
  ),
  finalists as (
    select *
    from length_candidates
    where length_candidates.priority < 2
       or length_candidates.match_length = length_candidates.best_match_length
  )
  select
    case when count(*) = 1 then min(finalists.id) end as library_root_id,
    case
      when count(*) = 1 then 'resolved'
      when count(*) = 0 then 'unresolved'
      else 'ambiguous'
    end as resolution_status,
    count(*)::integer as candidate_count,
    coalesce(min(finalists.method), 'none') as resolution_method
  from finalists;
$$;

-- Remove the branch-only, Windows-specific predecessor after the resolver no
-- longer depends on it. This also keeps repeated execution convergent.
drop function if exists library.windows_path_key(text);

create or replace function library.require_local_track_file_root_id(
  requested_library_id bigint,
  requested_private_path text,
  requested_metadata jsonb
)
returns bigint
language plpgsql
stable
as $$
declare
  resolution record;
begin
  select *
    into resolution
    from library.local_track_file_root_resolution(
      requested_library_id,
      requested_private_path,
      requested_metadata
    );
  if resolution.resolution_status <> 'resolved' then
    raise exception 'Local track file root linkage is % for path %',
      resolution.resolution_status,
      requested_private_path
      using errcode = '23514',
            detail = format(
              'library_id=%s candidate_count=%s method=%s',
              requested_library_id,
              resolution.candidate_count,
              resolution.resolution_method
            );
  end if;
  return resolution.library_root_id;
end;
$$;

with pending as (
  select
    library.local_track_files.id,
    library.local_tracks.library_id,
    library.local_track_files.private_path,
    library.local_track_files.metadata
  from library.local_track_files
  join library.local_tracks
    on library.local_tracks.id = library.local_track_files.track_id
  where library.local_track_files.library_root_id is null
),
resolved as (
  select pending.*, resolution.*
  from pending
  cross join lateral library.local_track_file_root_resolution(
    pending.library_id,
    pending.private_path,
    pending.metadata
  ) resolution
  where resolution.resolution_status = 'resolved'
)
update library.local_track_files
   set library_root_id = resolved.library_root_id,
       metadata = library.local_track_files.metadata || jsonb_build_object(
         'root_linkage',
         jsonb_build_object(
           'status', 'resolved',
           'method', resolved.resolution_method,
           'migration', '0023_link_local_track_files_to_library_roots'
         )
       )
from resolved
where library.local_track_files.id = resolved.id;

with pending as (
  select
    library.local_track_files.id,
    library.local_tracks.library_id,
    library.local_track_files.private_path,
    library.local_track_files.metadata
  from library.local_track_files
  join library.local_tracks
    on library.local_tracks.id = library.local_track_files.track_id
  where library.local_track_files.library_root_id is null
),
unresolved as (
  select pending.*, resolution.*
  from pending
  cross join lateral library.local_track_file_root_resolution(
    pending.library_id,
    pending.private_path,
    pending.metadata
  ) resolution
)
update library.local_track_files
   set metadata = library.local_track_files.metadata || jsonb_build_object(
     'root_linkage',
     jsonb_build_object(
       'status', unresolved.resolution_status,
       'candidate_count', unresolved.candidate_count,
       'method', unresolved.resolution_method,
       'migration', '0023_link_local_track_files_to_library_roots'
     )
   )
from unresolved
where library.local_track_files.id = unresolved.id;

do $$
declare
  unresolved_count bigint;
begin
  select count(*)
    into unresolved_count
    from library.local_track_files
    join library.local_tracks
      on library.local_tracks.id = library.local_track_files.track_id
    where library.local_track_files.library_root_id is null;
  if unresolved_count > 0 then
    raise exception '% local_track_files remain without library_root_id',
      unresolved_count
      using errcode = '23514',
            detail = format('unresolved_local_track_file_count=%s', unresolved_count),
            hint = 'Configure or repair active library-root path/provenance mappings, then rerun migration 0023.';
  end if;
end;
$$;

revoke all on function library.local_path_style(text) from public;
revoke all on function library.local_path_key(text) from public;
revoke all on function library.local_track_file_root_resolution(bigint, text, jsonb) from public;
revoke all on function library.require_local_track_file_root_id(bigint, text, jsonb) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant execute on function library.local_path_style(text) to album_haven_app;
    grant execute on function library.local_path_key(text) to album_haven_app;
    grant execute on function library.local_track_file_root_resolution(bigint, text, jsonb) to album_haven_app;
    grant execute on function library.require_local_track_file_root_id(bigint, text, jsonb) to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant execute on function library.local_path_style(text) to album_haven_migrator;
    grant execute on function library.local_path_key(text) to album_haven_migrator;
    grant execute on function library.local_track_file_root_resolution(bigint, text, jsonb) to album_haven_migrator;
    grant execute on function library.require_local_track_file_root_id(bigint, text, jsonb) to album_haven_migrator;
  end if;
end;
$$;
