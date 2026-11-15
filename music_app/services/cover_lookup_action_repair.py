from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4


_CANDIDATE_SQL = """
with notification_tasks as materialized (
  select
    tasks.id,
    tasks.library_id,
    tasks.task_key,
    tasks.status,
    tasks.completed_at,
    coalesce((tasks.metadata ->> 'notification_action_taken')::boolean, false)
      as notification_action_taken,
    case
      when jsonb_array_length(coalesce(tasks.metadata -> 'track_paths', '[]'::jsonb)) > 0
      then tasks.metadata -> 'track_paths'
      else coalesce(tasks.metadata #> '{source_payload,track_paths}', '[]'::jsonb)
    end as track_paths
  from ops.cover_lookup_tasks as tasks
  where tasks.metadata ->> 'source_family' = 'runtime_cover_lookup_notifications_adapter'
), terminal_tasks as materialized (
  select *
  from notification_tasks
  where status in ('completed', 'failed', 'canceled')
), resolved_tasks as materialized (
  select
    terminal_tasks.id,
    count(*) as requested_path_count,
    count(files.id) as resolved_path_count,
    count(distinct tracks.album_id) as resolved_album_count,
    min(tracks.album_id) as album_id
  from terminal_tasks
  cross join lateral jsonb_array_elements_text(terminal_tasks.track_paths) as paths(private_path)
  left join library.local_track_files as files
    on files.private_path = paths.private_path
   and files.scan_cache_stale is false
  left join library.local_tracks as tracks
    on tracks.id = files.track_id
   and tracks.library_id = terminal_tasks.library_id
  group by terminal_tasks.id
), active_path_sets as materialized (
  select track_paths
  from notification_tasks
  where status in ('pending', 'running')
)
select
  terminal_tasks.task_key,
  terminal_tasks.completed_at,
  albums.id as album_id,
  albums.title,
  albums.cover_path,
  albums.metadata ->> 'cover_revision' as cover_revision
from terminal_tasks
join resolved_tasks on resolved_tasks.id = terminal_tasks.id
join library.local_albums as albums
  on albums.library_id = terminal_tasks.library_id
 and albums.id = resolved_tasks.album_id
left join library.local_artists as artists on artists.id = albums.artist_id
where resolved_tasks.requested_path_count > 0
  and resolved_tasks.requested_path_count = resolved_tasks.resolved_path_count
  and resolved_tasks.resolved_album_count = 1
  and not terminal_tasks.notification_action_taken
  and albums.metadata ->> 'cover_selection_origin' = 'user'
  and albums.metadata ->> 'cover_selection_provenance' = 'explicit'
  and albums.cover_path is not null
  and albums.metadata ->> 'cover_revision' is not null
  and lower(btrim(albums.title)) not in ('', 'unknown', 'unknown album', 'none', 'null')
  and lower(btrim(coalesce(artists.name, ''))) not in (
    '', 'unknown', 'unknown artist', 'none', 'null'
  )
  and not exists (
    select 1 from active_path_sets
    where active_path_sets.track_paths @> terminal_tasks.track_paths
      and active_path_sets.track_paths <@ terminal_tasks.track_paths
  )
order by terminal_tasks.completed_at, terminal_tasks.task_key;
"""

_APPLY_SQL = """
update ops.cover_lookup_tasks
set metadata = jsonb_set(
      jsonb_set(metadata, '{notification_action_taken}', 'true'::jsonb, true),
      '{source_payload,notification_action_taken}',
      'true'::jsonb,
      true
    ) || jsonb_build_object(
      'notification_action_repair',
      jsonb_build_object(
        'batch_id', %(batch_id)s::text,
        'source', 'proven_post_search_explicit_local_cover',
        'applied_at', now()::text
      )
    )
where metadata ->> 'source_family' = 'runtime_cover_lookup_notifications_adapter'
  and task_key = any(%(task_keys)s::text[])
  and status in ('completed', 'failed', 'canceled')
  and not coalesce((metadata ->> 'notification_action_taken')::boolean, false)
returning task_key;
"""

_ROLLBACK_SQL = """
update ops.cover_lookup_tasks
set metadata = jsonb_set(
      jsonb_set(metadata, '{notification_action_taken}', 'false'::jsonb, true),
      '{source_payload,notification_action_taken}',
      'false'::jsonb,
      true
    ) - 'notification_action_repair'
where metadata #>> '{notification_action_repair,batch_id}' = %(batch_id)s
returning task_key;
"""


def _utc(value: object) -> datetime:
    parsed = value if isinstance(value, datetime) else datetime.fromisoformat(str(value))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def proven_post_search_cover(row: dict[str, object], *, modified_at=None) -> bool:
    path = Path(str(row.get("cover_path") or ""))
    revision = str(row.get("cover_revision") or "").strip().casefold()
    try:
        selected_at = (
            modified_at(path)
            if modified_at is not None
            else datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
        )
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        completed_at = _utc(row["completed_at"])
    except (KeyError, OSError, TypeError, ValueError):
        return False
    return digest == revision and _utc(selected_at) > completed_at


def plan_repair(connection) -> list[dict[str, object]]:
    return [
        dict(row)
        for row in connection.execute(_CANDIDATE_SQL).fetchall()
        if proven_post_search_cover(dict(row))
    ]


def apply_repair(connection, rows: list[dict[str, object]]) -> tuple[str, list[str]]:
    batch_id = uuid4().hex
    task_keys = [str(row["task_key"]) for row in rows]
    if not task_keys:
        return batch_id, []
    updated = connection.execute(
        _APPLY_SQL,
        {"batch_id": batch_id, "task_keys": task_keys},
    ).fetchall()
    return batch_id, [str(row["task_key"]) for row in updated]


def rollback_repair(connection, batch_id: str) -> list[str]:
    updated = connection.execute(_ROLLBACK_SQL, {"batch_id": batch_id}).fetchall()
    return [str(row["task_key"]) for row in updated]

