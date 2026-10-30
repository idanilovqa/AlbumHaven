-- Restore only cover-task albums proven by complete paths plus one exact
-- artist/title/year target. Ambiguous or incomplete legacy rows stay untouched.

drop table if exists pg_temp.synthetic_unknown_cover_task_mappings;

create temporary table synthetic_unknown_cover_task_mappings (
  task_row_id bigint primary key,
  previous_album_id bigint not null,
  current_unknown_album_id bigint not null,
  target_album_id bigint not null,
  target_album_key text not null
) on commit drop;

with tasks as materialized (
  select
    tasks.id as task_row_id,
    tasks.library_id,
    (tasks.metadata #>> '{source_payload,album_payload,album_id}')::bigint
      as previous_album_id,
    tasks.metadata #>> '{source_payload,artist}' as source_artist,
    tasks.metadata #>> '{source_payload,album}' as source_album,
    nullif(tasks.metadata #>> '{source_payload,year}', '')::integer as source_year,
    tasks.metadata #> '{source_payload,track_paths}' as track_paths
  from ops.cover_lookup_tasks as tasks
  where tasks.metadata ->> 'source_family' in (
    'cover_lookup_notifications',
    'runtime_cover_lookup_notifications_adapter'
  )
    and coalesce(
      tasks.metadata #>> '{source_payload,album_payload,album_id}', ''
    ) ~ '^[1-9][0-9]*$'
    and jsonb_array_length(
      coalesce(tasks.metadata #> '{source_payload,track_paths}', '[]'::jsonb)
    ) > 0
    and nullif(btrim(tasks.metadata #>> '{source_payload,artist}'), '') is not null
    and nullif(btrim(tasks.metadata #>> '{source_payload,album}'), '') is not null
),
target_candidates as materialized (
  select
    tasks.task_row_id,
    tasks.library_id,
    tasks.previous_album_id,
    tasks.track_paths,
    min(albums.id) as target_album_id,
    min(albums.album_key) as target_album_key
  from tasks
  join library.local_artists as artists
    on artists.library_id = tasks.library_id
   and lower(btrim(artists.name)) = lower(btrim(tasks.source_artist))
  join library.local_albums as albums
    on albums.library_id = tasks.library_id
   and albums.artist_id = artists.id
   and lower(btrim(albums.title)) = lower(btrim(tasks.source_album))
   and (tasks.source_year is null or albums.release_year = tasks.source_year)
  group by tasks.task_row_id, tasks.library_id, tasks.previous_album_id, tasks.track_paths
  having count(*) = 1
),
task_paths as materialized (
  select
    targets.*,
    paths.private_path,
    count(*) over (partition by targets.task_row_id) as requested_path_count
  from target_candidates as targets
  cross join lateral jsonb_array_elements_text(targets.track_paths) as paths(private_path)
),
resolved_paths as materialized (
  select
    task_paths.*,
    files.track_id,
    tracks.album_id as current_album_id
  from task_paths
  join library.local_track_files as files
    on files.private_path = task_paths.private_path
   and files.scan_cache_stale is false
  join library.local_tracks as tracks
    on tracks.id = files.track_id
   and tracks.library_id = task_paths.library_id
  join library.local_albums as current_album
    on current_album.id = tracks.album_id
   and current_album.library_id = task_paths.library_id
  left join library.local_artists as current_artist
    on current_artist.id = current_album.artist_id
  where lower(btrim(coalesce(current_album.title, ''))) in (
      '', 'unknown', 'unknown artist', 'unknown album', 'none', 'null'
    )
    and lower(btrim(coalesce(current_artist.name, ''))) in (
      '', 'unknown', 'unknown artist', 'unknown album', 'none', 'null'
    )
)
insert into synthetic_unknown_cover_task_mappings (
  task_row_id,
  previous_album_id,
  current_unknown_album_id,
  target_album_id,
  target_album_key
)
select
  resolved_paths.task_row_id,
  resolved_paths.previous_album_id,
  min(resolved_paths.current_album_id),
  resolved_paths.target_album_id,
  resolved_paths.target_album_key
from resolved_paths
group by
  resolved_paths.task_row_id,
  resolved_paths.previous_album_id,
  resolved_paths.target_album_id,
  resolved_paths.target_album_key,
  resolved_paths.requested_path_count
having count(distinct resolved_paths.private_path)
         = resolved_paths.requested_path_count
   and count(distinct resolved_paths.current_album_id) = 1
   and min(resolved_paths.current_album_id) <> resolved_paths.target_album_id;

with conflicting_paths as materialized (
  select paths.private_path
  from synthetic_unknown_cover_task_mappings as mappings
  join ops.cover_lookup_tasks as tasks on tasks.id = mappings.task_row_id
  cross join lateral jsonb_array_elements_text(
    tasks.metadata #> '{source_payload,track_paths}'
  ) as paths(private_path)
  group by paths.private_path
  having count(distinct mappings.target_album_id) > 1
),
conflicting_tasks as materialized (
  select distinct mappings.task_row_id
  from synthetic_unknown_cover_task_mappings as mappings
  join ops.cover_lookup_tasks as tasks on tasks.id = mappings.task_row_id
  cross join lateral jsonb_array_elements_text(
    tasks.metadata #> '{source_payload,track_paths}'
  ) as paths(private_path)
  join conflicting_paths on conflicting_paths.private_path = paths.private_path
)
delete from synthetic_unknown_cover_task_mappings as mappings
using conflicting_tasks
where mappings.task_row_id = conflicting_tasks.task_row_id;

with track_targets as materialized (
  select
    files.track_id,
    min(mappings.target_album_id) as target_album_id
  from synthetic_unknown_cover_task_mappings as mappings
  join ops.cover_lookup_tasks as tasks on tasks.id = mappings.task_row_id
  cross join lateral jsonb_array_elements_text(
    tasks.metadata #> '{source_payload,track_paths}'
  ) as paths(private_path)
  join library.local_track_files as files
    on files.private_path = paths.private_path
   and files.scan_cache_stale is false
  group by files.track_id
  having count(distinct mappings.target_album_id) = 1
)
update library.local_tracks as tracks
set album_id = track_targets.target_album_id
from track_targets
where tracks.id = track_targets.track_id
  and tracks.album_id <> track_targets.target_album_id;

update ops.cover_lookup_tasks as tasks
set metadata = jsonb_set(
  jsonb_set(
    jsonb_set(
      jsonb_set(
        coalesce(tasks.metadata, '{}'::jsonb),
        '{source_payload,album_payload,album_id}',
        to_jsonb(mappings.target_album_id),
        true
      ),
      '{source_payload,album_payload,id}',
      to_jsonb(mappings.target_album_id),
      true
    ),
    '{source_payload,album_payload,key}',
    to_jsonb(mappings.target_album_key),
    true
  ),
  '{source_payload,album_payload,_persisted_album_key}',
  to_jsonb(mappings.target_album_key),
  true
) || jsonb_build_object(
  'synthetic_unknown_identity_repair',
  jsonb_build_object(
    'previous_album_id', mappings.previous_album_id,
    'current_unknown_album_id', mappings.current_unknown_album_id,
    'target_album_id', mappings.target_album_id,
    'target_album_key', mappings.target_album_key
  )
)
from synthetic_unknown_cover_task_mappings as mappings
where tasks.id = mappings.task_row_id;

drop table pg_temp.synthetic_unknown_cover_task_mappings;
