from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timezone


JsonDict = dict[str, object]
AlbumFinder = Callable[[set[str]], list[JsonDict]]
ProblematicAlbumFinder = Callable[[set[str]], JsonDict | None]


def build_move_follow_up(
    moved_track_paths: set[str],
    *,
    find_albums_by_track_paths: AlbumFinder,
    find_problematic_album_by_track_paths: ProblematicAlbumFinder,
) -> JsonDict:
    updated_albums = find_albums_by_track_paths(moved_track_paths)
    updated_problematic_album = find_problematic_album_by_track_paths(moved_track_paths)
    return {
        "updated_album": updated_albums[0] if updated_albums else None,
        "updated_albums": updated_albums,
        "updated_problematic_album": updated_problematic_album,
        "requires_view_refresh": True,
    }


def build_completed_move_task(
    *,
    action: str,
    source_folder: str,
    destination_folder: str,
    moved_track_paths: set[str],
    follow_up: JsonDict,
) -> JsonDict:
    updated_albums = list(follow_up.get("updated_albums") or [])
    return {
        "kind": "move-album",
        "status": "completed",
        "action": action,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source_folder": source_folder,
        "destination_folder": destination_folder,
        "moved_track_count": len(moved_track_paths),
        "moved_track_paths": sorted(moved_track_paths),
        "updated_album_count": len(updated_albums),
        "requires_view_refresh": bool(follow_up.get("requires_view_refresh")),
    }


def build_move_response(
    *,
    action: str,
    source_folder: str,
    destination_folder: str,
    moved_track_paths: set[str],
    follow_up: JsonDict,
) -> JsonDict:
    payload = {
        "ok": True,
        "action": action,
        "source_folder": source_folder,
        "destination_folder": destination_folder,
        "moved_track_paths": sorted(moved_track_paths),
        "move_task": build_completed_move_task(
            action=action,
            source_folder=source_folder,
            destination_folder=destination_folder,
            moved_track_paths=moved_track_paths,
            follow_up=follow_up,
        ),
    }
    payload.update(follow_up)
    return payload
