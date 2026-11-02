drop table if exists pg_temp.cover_lookup_notification_album_mappings;

create temporary table cover_lookup_notification_album_mappings (
  task_row_id bigint primary key,
  previous_album_id bigint not null,
  current_album_id bigint not null,
  current_album_key text not null
) on commit drop;

with task_paths as materialized (
  select
    tasks.id as task_row_id,
    tasks.library_id,
    (tasks.metadata #>> '{source_payload,album_payload,album_id}')::bigint
      as previous_album_id,
    paths.private_path,
    count(*) over (partition by tasks.id) as requested_path_count
  from ops.cover_lookup_tasks as tasks
  cross join lateral jsonb_array_elements_text(
    coalesce(tasks.metadata #> '{source_payload,track_paths}', '[]'::jsonb)
  ) as paths(private_path)
  where tasks.metadata ->> 'source_family' in (
    'cover_lookup_notifications',
    'runtime_cover_lookup_notifications_adapter'
  )
    and coalesce(
      tasks.metadata #>> '{source_payload,album_payload,album_id}',
      ''
    ) ~ '^[1-9][0-9]*$'
),
resolved_paths as materialized (
  select
    task_paths.task_row_id,
    task_paths.previous_album_id,
    task_paths.requested_path_count,
    files.private_path,
    tracks.album_id
  from task_paths
  join library.local_track_files as files
    on files.private_path = task_paths.private_path
   and files.scan_cache_stale is false
  join library.local_tracks as tracks
    on tracks.id = files.track_id
   and tracks.library_id = task_paths.library_id
   and tracks.album_id is not null
)
insert into cover_lookup_notification_album_mappings (
  task_row_id,
  previous_album_id,
  current_album_id,
  current_album_key
)
select
  resolved_paths.task_row_id,
  resolved_paths.previous_album_id,
  min(resolved_paths.album_id) as current_album_id,
  min(albums.album_key) as current_album_key
from resolved_paths
join library.local_albums as albums
  on albums.id = resolved_paths.album_id
group by
  resolved_paths.task_row_id,
  resolved_paths.previous_album_id,
  resolved_paths.requested_path_count
having count(distinct resolved_paths.private_path) =
       resolved_paths.requested_path_count
   and count(distinct resolved_paths.album_id) = 1
   and resolved_paths.previous_album_id <> min(resolved_paths.album_id);

insert into library.local_album_cover_candidate_snapshots (
  album_id,
  search_generation,
  search_kind,
  status,
  revision,
  candidates,
  best_candidate_id,
  automatic_improvement_revision,
  seen_automatic_improvement_revision,
  started_at,
  updated_at,
  finished_at,
  automatic_improvement_candidate_id
)
select distinct on (mappings.current_album_id)
  mappings.current_album_id,
  snapshots.search_generation,
  snapshots.search_kind,
  snapshots.status,
  snapshots.revision,
  snapshots.candidates,
  snapshots.best_candidate_id,
  snapshots.automatic_improvement_revision,
  snapshots.seen_automatic_improvement_revision,
  snapshots.started_at,
  snapshots.updated_at,
  snapshots.finished_at,
  snapshots.automatic_improvement_candidate_id
from cover_lookup_notification_album_mappings as mappings
join library.local_album_cover_candidate_snapshots as snapshots
  on snapshots.album_id = mappings.previous_album_id
order by mappings.current_album_id, snapshots.updated_at desc
on conflict (album_id) do update
set
  search_generation = case
    when jsonb_array_length(library.local_album_cover_candidate_snapshots.candidates) = 0
     and jsonb_array_length(excluded.candidates) > 0
    then excluded.search_generation
    else library.local_album_cover_candidate_snapshots.search_generation
  end,
  search_kind = case
    when jsonb_array_length(library.local_album_cover_candidate_snapshots.candidates) = 0
     and jsonb_array_length(excluded.candidates) > 0
    then excluded.search_kind
    else library.local_album_cover_candidate_snapshots.search_kind
  end,
  status = case
    when jsonb_array_length(library.local_album_cover_candidate_snapshots.candidates) = 0
     and jsonb_array_length(excluded.candidates) > 0
    then excluded.status
    else library.local_album_cover_candidate_snapshots.status
  end,
  revision = case
    when jsonb_array_length(library.local_album_cover_candidate_snapshots.candidates) = 0
     and jsonb_array_length(excluded.candidates) > 0
    then excluded.revision
    else library.local_album_cover_candidate_snapshots.revision
  end,
  candidates = case
    when jsonb_array_length(library.local_album_cover_candidate_snapshots.candidates) = 0
     and jsonb_array_length(excluded.candidates) > 0
    then excluded.candidates
    else library.local_album_cover_candidate_snapshots.candidates
  end,
  best_candidate_id = case
    when jsonb_array_length(library.local_album_cover_candidate_snapshots.candidates) = 0
     and jsonb_array_length(excluded.candidates) > 0
    then excluded.best_candidate_id
    else library.local_album_cover_candidate_snapshots.best_candidate_id
  end,
  automatic_improvement_revision = greatest(
    library.local_album_cover_candidate_snapshots.automatic_improvement_revision,
    excluded.automatic_improvement_revision
  ),
  seen_automatic_improvement_revision = greatest(
    library.local_album_cover_candidate_snapshots.seen_automatic_improvement_revision,
    excluded.seen_automatic_improvement_revision
  ),
  updated_at = greatest(
    library.local_album_cover_candidate_snapshots.updated_at,
    excluded.updated_at
  ),
  automatic_improvement_candidate_id = coalesce(
    library.local_album_cover_candidate_snapshots.automatic_improvement_candidate_id,
    excluded.automatic_improvement_candidate_id
  );

update ops.cover_lookup_tasks as tasks
set metadata = jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            coalesce(tasks.metadata, '{}'::jsonb),
            '{source_payload,album_payload,album_id}',
            to_jsonb(mappings.current_album_id),
            true
          ),
          '{source_payload,album_payload,id}',
          to_jsonb(mappings.current_album_id),
          true
        ),
        '{source_payload,album_payload,key}',
        to_jsonb(mappings.current_album_key),
        true
      ),
      '{source_payload,album_payload,_persisted_album_key}',
      to_jsonb(mappings.current_album_key),
      true
    ) || jsonb_build_object(
      'album_identity_reconciliation',
      jsonb_build_object(
        'previous_album_id', mappings.previous_album_id,
        'current_album_id', mappings.current_album_id,
        'current_album_key', mappings.current_album_key
      )
    )
from cover_lookup_notification_album_mappings as mappings
where tasks.id = mappings.task_row_id;

drop table if exists pg_temp.cover_lookup_notification_album_mappings;
