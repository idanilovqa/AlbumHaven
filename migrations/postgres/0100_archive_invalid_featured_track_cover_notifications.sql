-- Archive notification tasks that 0099 mapped from a synthetic one-track
-- featured-artist album onto an unrelated multi-track album.
-- Rollback: restore metadata.source_family from
-- album_identity_reconciliation_repair.previous_source_family and remove the
-- two repair keys. The task rows and candidate snapshots are preserved.

with reconciled_tasks as materialized (
  select
    tasks.id as task_row_id,
    tasks.metadata ->> 'source_family' as previous_source_family,
    tasks.metadata #>> '{source_payload,artist}' as source_artist,
    tasks.metadata #>> '{source_payload,album}' as source_album,
    (tasks.metadata #>> '{album_identity_reconciliation,previous_album_id}')::bigint
      as previous_album_id,
    (tasks.metadata #>> '{album_identity_reconciliation,current_album_id}')::bigint
      as current_album_id,
    paths.private_path
  from ops.cover_lookup_tasks as tasks
  cross join lateral jsonb_array_elements_text(
    coalesce(tasks.metadata #> '{source_payload,track_paths}', '[]'::jsonb)
  ) as paths(private_path)
  where tasks.metadata ->> 'source_family' in (
    'cover_lookup_notifications',
    'runtime_cover_lookup_notifications_adapter'
  )
    and not (tasks.metadata ? 'notification_obsolete_reason')
    and jsonb_array_length(
      coalesce(tasks.metadata #> '{source_payload,track_paths}', '[]'::jsonb)
    ) = 1
    and coalesce(
      tasks.metadata #>> '{album_identity_reconciliation,previous_album_id}',
      ''
    ) ~ '^[1-9][0-9]*$'
    and coalesce(
      tasks.metadata #>> '{album_identity_reconciliation,current_album_id}',
      ''
    ) ~ '^[1-9][0-9]*$'
),
invalid_reconciliations as materialized (
  select
    reconciled_tasks.*,
    previous_counts.previous_track_count,
    current_counts.current_track_count
  from reconciled_tasks
  join library.local_albums as current_album
    on current_album.id = reconciled_tasks.current_album_id
  join library.local_artists as current_artist
    on current_artist.id = current_album.artist_id
  join library.local_track_files as task_file
    on task_file.private_path = reconciled_tasks.private_path
   and task_file.scan_cache_stale is false
  join library.local_tracks as task_track
    on task_track.id = task_file.track_id
   and task_track.album_id = current_album.id
  join library.local_artists as task_artist
    on task_artist.id = task_track.artist_id
  cross join lateral (
    select count(*) as previous_track_count
    from library.local_tracks as previous_track
    join library.local_track_files as previous_file
      on previous_file.track_id = previous_track.id
     and previous_file.scan_cache_stale is false
    where previous_track.album_id = reconciled_tasks.previous_album_id
  ) as previous_counts
  cross join lateral (
    select count(*) as current_track_count
    from library.local_tracks as current_track
    join library.local_track_files as current_file
      on current_file.track_id = current_track.id
     and current_file.scan_cache_stale is false
    where current_track.album_id = reconciled_tasks.current_album_id
  ) as current_counts
  where previous_counts.previous_track_count = 0
    and current_counts.current_track_count > 1
    and nullif(btrim(reconciled_tasks.source_artist), '') is not null
    and nullif(btrim(reconciled_tasks.source_album), '') is not null
    and lower(btrim(reconciled_tasks.source_artist)) <>
        lower(btrim(current_artist.name))
    and lower(btrim(reconciled_tasks.source_album)) <>
        lower(btrim(current_album.title))
    and position(
      lower(btrim(reconciled_tasks.source_artist))
      in lower(btrim(task_artist.name))
    ) > 0
)
update ops.cover_lookup_tasks as tasks
set metadata = coalesce(tasks.metadata, '{}'::jsonb) || jsonb_build_object(
  'source_family', 'obsolete_cover_lookup_notifications',
  'notification_obsolete_reason',
    'invalid_featured_track_album_reconciliation',
  'album_identity_reconciliation_repair', jsonb_build_object(
    'kind', 'archive_invalid_featured_track_album_reconciliation',
    'previous_source_family', invalid_reconciliations.previous_source_family,
    'previous_album_id', invalid_reconciliations.previous_album_id,
    'current_album_id', invalid_reconciliations.current_album_id
  )
)
from invalid_reconciliations
where tasks.id = invalid_reconciliations.task_row_id;
