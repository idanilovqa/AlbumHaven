from __future__ import annotations

import hashlib
from collections.abc import Mapping
from pathlib import Path

from music_app.services.library import album_to_dict


def _active_cover_state_for_track_paths(
    file_cache: dict[str, object] | None,
    track_paths: set[str],
) -> tuple[Path | None, str | None]:
    normalized_cache = file_cache if isinstance(file_cache, dict) else {}
    for track_path in track_paths:
        entry = normalized_cache.get(track_path)
        cover_value = str(entry.get("cover_path") or "").strip() if isinstance(entry, dict) else ""
        if cover_value:
            revision_value = str(entry.get("cover_revision") or "").strip() or None
            return Path(cover_value), revision_value
    return None, None


def active_cover_path_for_track_paths(
    file_cache: dict[str, object] | None,
    track_paths: set[str],
) -> Path | None:
    active_cover_path, _revision = _active_cover_state_for_track_paths(
        file_cache,
        track_paths,
    )
    return active_cover_path


def active_remote_cover_for_track_paths(
    file_cache: dict[str, object] | None,
    track_paths: set[str],
) -> dict[str, object] | None:
    normalized_cache = file_cache if isinstance(file_cache, dict) else {}
    for track_path in track_paths:
        entry = normalized_cache.get(track_path)
        if not isinstance(entry, dict):
            continue
        remote_url = str(entry.get("remote_cover_url") or "").strip()
        if not remote_url:
            continue
        width = int(entry.get("remote_cover_width") or 0)
        height = int(entry.get("remote_cover_height") or 0)
        return {
            "id": f"saved-remote:{hashlib.sha1(remote_url.encode('utf-8', 'ignore')).hexdigest()}",
            "url": remote_url,
            "thumbnail_url": str(entry.get("remote_cover_thumbnail_url") or remote_url),
            "source": str(entry.get("remote_cover_source") or ""),
            "source_label": str(entry.get("remote_cover_source_label") or ""),
            "album_url": str(entry.get("remote_cover_album_url") or ""),
            "width": width,
            "height": height,
            "resolution": f"{width}x{height}" if width > 0 and height > 0 else "Unknown",
        }
    return None


def resolve_authoritative_album_track_paths(
    library_state: dict[str, object],
    selected_track_paths: set[str],
) -> set[str]:
    """Resolve selected paths to exactly one complete live album inventory."""
    normalized_selected_paths = {
        str(path or "").strip()
        for path in selected_track_paths
        if str(path or "").strip()
    }
    if not normalized_selected_paths:
        raise ValueError("Cover selection requires at least one live track path.")

    matching_album_track_sets: list[set[str]] = []
    resolved_selected_paths: set[str] = set()
    for album in list(library_state.get("albums", []) or []):
        album_track_paths = {
            str(getattr(track, "path", "") or "").strip()
            for track in list(getattr(album, "tracks", []) or [])
            if str(getattr(track, "path", "") or "").strip()
        }
        album_selected_paths = album_track_paths & normalized_selected_paths
        if not album_selected_paths:
            continue
        matching_album_track_sets.append(album_track_paths)
        resolved_selected_paths.update(album_selected_paths)

    if resolved_selected_paths != normalized_selected_paths:
        raise ValueError("Every selected track must resolve to the live album inventory.")
    if len(matching_album_track_sets) != 1:
        raise ValueError("Cover selection must resolve to exactly one live album.")
    authoritative_track_paths = matching_album_track_sets[0]
    if not authoritative_track_paths:
        raise ValueError("The selected live album has no track inventory.")
    return authoritative_track_paths


def iter_local_cover_candidates(
    album_root: Path,
    *,
    image_extensions: set[str],
    image_dimensions,
    is_squareish_cover,
    active_cover_path: Path | None,
) -> list[dict[str, object]]:
    candidates: list[dict[str, object]] = []
    for path in album_root.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in image_extensions:
            continue
        width, height = image_dimensions(path)
        candidates.append(
            {
                "path": str(path),
                "filename": path.name,
                "relative_path": str(path.relative_to(album_root)),
                "width": width,
                "height": height,
                "resolution": f"{width}x{height}" if width > 0 and height > 0 else "Unknown",
                "is_squareish": is_squareish_cover(width, height),
                "is_active": bool(active_cover_path and path == active_cover_path),
                "area": width * height if width > 0 and height > 0 else 0,
                "depth": len(path.relative_to(album_root).parts),
            }
        )
    candidates.sort(
        key=lambda item: (
            not bool(item.get("is_squareish")),
            -int(item.get("area") or 0),
            int(item.get("depth") or 0),
            str(item.get("relative_path") or "").casefold(),
        )
    )
    return candidates


def serialize_cover_gallery_payload(
    *,
    album_root: Path,
    track_paths: set[str],
    file_cache: dict[str, object] | None,
    image_extensions: set[str],
    image_dimensions,
    is_squareish_cover,
    task_payload: dict[str, object] | None = None,
    candidate_snapshot: Mapping[str, object] | None = None,
) -> dict[str, object]:
    active_cover_path, active_cover_revision = _active_cover_state_for_track_paths(
        file_cache,
        track_paths,
    )
    active_remote_cover = active_remote_cover_for_track_paths(file_cache, track_paths)
    local_candidates = iter_local_cover_candidates(
        album_root,
        image_extensions=image_extensions,
        image_dimensions=image_dimensions,
        is_squareish_cover=is_squareish_cover,
        active_cover_path=None if active_remote_cover else active_cover_path,
    )
    if active_cover_revision and not active_remote_cover:
        for candidate in local_candidates:
            if candidate.get("is_active"):
                candidate["cover_revision"] = active_cover_revision
                break
    return {
        "ok": True,
        "album_root": str(album_root),
        "active_cover_path": str(active_cover_path) if active_cover_path else None,
        "remote_cover": active_remote_cover,
        "local_covers": [item for item in local_candidates if item.get("is_squareish")],
        "other_art": [item for item in local_candidates if not item.get("is_squareish")],
        "task": task_payload if task_payload else None,
        "candidate_snapshot": serialize_cover_candidate_snapshot(candidate_snapshot),
    }


def serialize_cover_candidate_snapshot(
    candidate_snapshot: Mapping[str, object] | None,
) -> dict[str, object] | None:
    if candidate_snapshot is None:
        return None

    raw_candidates = candidate_snapshot.get("candidates")
    malformed = not isinstance(raw_candidates, list)
    candidates = (
        [dict(candidate) for candidate in raw_candidates if isinstance(candidate, Mapping)]
        if isinstance(raw_candidates, list)
        else []
    )
    automatic_improvement_revision = _nonnegative_int(
        candidate_snapshot.get("automatic_improvement_revision")
    )
    seen_automatic_improvement_revision = _nonnegative_int(
        candidate_snapshot.get("seen_automatic_improvement_revision")
    )
    diagnostic = str(candidate_snapshot.get("diagnostic") or "").strip() or None
    if malformed:
        diagnostic = "malformed_candidate_snapshot"

    payload: dict[str, object] = {
        "candidates": candidates,
        "search_kind": str(candidate_snapshot.get("search_kind") or "").strip() or None,
        "status": str(candidate_snapshot.get("status") or "").strip() or None,
        "revision": _nonnegative_int(candidate_snapshot.get("revision")),
        "best_candidate_id": (
            str(candidate_snapshot.get("best_candidate_id") or "").strip() or None
        ),
        "automatic_improvement_revision": automatic_improvement_revision,
        "seen_automatic_improvement_revision": seen_automatic_improvement_revision,
        "unseen_automatic_improvement": (
            not malformed
            and automatic_improvement_revision > seen_automatic_improvement_revision
        ),
        "diagnostic": diagnostic,
    }
    updated_at = _timestamp_text(candidate_snapshot.get("updated_at"))
    if updated_at:
        payload["updated_at"] = updated_at
    search_generation = str(candidate_snapshot.get("search_generation") or "").strip()
    if search_generation:
        payload["search_generation"] = search_generation
    return payload


def _timestamp_text(value: object) -> str | None:
    isoformat = getattr(value, "isoformat", None)
    text = str(isoformat() if callable(isoformat) else value or "").strip()
    return text or None


def _nonnegative_int(value: object) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def apply_cover_selection_for_tracks(
    *,
    library_state: dict[str, object],
    track_paths: set[str],
    schedule_cache_updates_save,
    cache_path,
    find_updated_albums,
    find_problematic_album,
    cover_path: Path | None = None,
    remote_cover_url: str | None = None,
    remote_cover_thumbnail_url: str | None = None,
    remote_cover_source: str | None = None,
    remote_cover_source_label: str | None = None,
    remote_cover_album_url: str | None = None,
    remote_cover_width: int | None = None,
    remote_cover_height: int | None = None,
    cover_revision: str | None = None,
    persist_cache_update: bool = True,
) -> tuple[list[dict[str, object]], dict[str, object] | None]:
    updated_file_cache = dict(library_state.get("file_cache", {}) or {})
    cover_value = str(cover_path) if cover_path else None
    revision_value = str(cover_revision or "").strip() or None
    remote_url_value = str(remote_cover_url or "").strip() or None
    remote_thumb_value = str(remote_cover_thumbnail_url or "").strip() or None
    remote_source_value = str(remote_cover_source or "").strip() or None
    remote_source_label_value = str(remote_cover_source_label or "").strip() or None
    remote_album_url_value = str(remote_cover_album_url or "").strip() or None
    changed_paths: set[str] = set()

    for track_path in track_paths:
        entry = updated_file_cache.get(track_path)
        if not isinstance(entry, dict):
            continue
        if (
            entry.get("cover_path") == cover_value
            and (str(entry.get("cover_revision") or "").strip() or None) == revision_value
            and (str(entry.get("remote_cover_url") or "").strip() or None) == remote_url_value
            and (str(entry.get("remote_cover_thumbnail_url") or "").strip() or None) == remote_thumb_value
            and (str(entry.get("remote_cover_source") or "").strip() or None) == remote_source_value
            and (str(entry.get("remote_cover_source_label") or "").strip() or None) == remote_source_label_value
            and (str(entry.get("remote_cover_album_url") or "").strip() or None) == remote_album_url_value
            and int(entry.get("remote_cover_width") or 0) == int(remote_cover_width or 0)
            and int(entry.get("remote_cover_height") or 0) == int(remote_cover_height or 0)
        ):
            continue
        next_entry = dict(entry)
        next_entry["cover_path"] = cover_value
        next_entry["cover_revision"] = revision_value
        next_entry["remote_cover_url"] = remote_url_value
        next_entry["remote_cover_thumbnail_url"] = remote_thumb_value
        next_entry["remote_cover_source"] = remote_source_value
        next_entry["remote_cover_source_label"] = remote_source_label_value
        next_entry["remote_cover_album_url"] = remote_album_url_value
        next_entry["remote_cover_width"] = int(remote_cover_width or 0) or None
        next_entry["remote_cover_height"] = int(remote_cover_height or 0) or None
        updated_file_cache[track_path] = next_entry
        changed_paths.add(track_path)

    if not changed_paths:
        return find_updated_albums(track_paths), find_problematic_album(track_paths)

    library_state["file_cache"] = updated_file_cache
    for album in list(library_state.get("albums", []) or []):
        album_tracks = list(getattr(album, "tracks", []) or [])
        album_paths = {
            str(getattr(track, "path", "") or "")
            for track in album_tracks
            if str(getattr(track, "path", "") or "")
        }
        if not album_paths & changed_paths:
            continue
        _set_cover_fields(
            album,
            cover_value=cover_value,
            revision_value=revision_value,
            remote_url_value=remote_url_value,
            remote_thumb_value=remote_thumb_value,
            remote_source_value=remote_source_value,
            remote_source_label_value=remote_source_label_value,
            remote_album_url_value=remote_album_url_value,
            remote_cover_width=remote_cover_width,
            remote_cover_height=remote_cover_height,
        )
        for track in album_tracks:
            if str(getattr(track, "path", "") or "") not in changed_paths:
                continue
            _set_cover_fields(
                track,
                cover_value=cover_value,
                revision_value=revision_value,
                remote_url_value=remote_url_value,
                remote_thumb_value=remote_thumb_value,
                remote_source_value=remote_source_value,
                remote_source_label_value=remote_source_label_value,
                remote_album_url_value=remote_album_url_value,
                remote_cover_width=remote_cover_width,
                remote_cover_height=remote_cover_height,
            )
    from music_app.services.problematic_albums import invalidate_problematic_albums_payload_cache
    from music_app.services.utility_rules import invalidate_utility_rules_payload_cache
    invalidate_problematic_albums_payload_cache(library_state)
    invalidate_utility_rules_payload_cache(library_state)

    if persist_cache_update:
        schedule_cache_updates_save(
            cache_path,
            {
                path_str: updated_file_cache[path_str]
                for path_str in changed_paths
                if isinstance(updated_file_cache.get(path_str), dict)
            },
        )
    return find_updated_albums(track_paths), find_problematic_album(track_paths)


def apply_authoritative_local_cover_fallback(
    *,
    library_state: dict[str, object],
    track_paths: set[str],
    cover_path: Path,
    cover_revision: str,
) -> None:
    """Apply the minimal in-memory state required after a committed selection."""
    normalized_paths = {
        str(path or "").strip() for path in track_paths if str(path or "").strip()
    }
    current_file_cache = library_state.get("file_cache")
    if not normalized_paths or not isinstance(current_file_cache, dict):
        raise RuntimeError("Authoritative cover fallback requires the selected track cache.")
    missing_paths = [
        path
        for path in sorted(normalized_paths)
        if not isinstance(current_file_cache.get(path), dict)
    ]
    if missing_paths:
        raise RuntimeError(
            "Authoritative cover fallback could not find every selected track entry."
        )
    matching_albums: list[tuple[object, list[object]]] = []
    for album in list(library_state.get("albums", []) or []):
        matching_tracks = [
            track
            for track in list(getattr(album, "tracks", []) or [])
            if str(getattr(track, "path", "") or "") in normalized_paths
        ]
        if matching_tracks:
            matching_albums.append((album, matching_tracks))
    if len(matching_albums) != 1:
        raise RuntimeError(
            "Authoritative cover fallback must patch exactly one matching album."
        )

    cover_value = str(cover_path)
    revision_value = str(cover_revision or "").strip()
    updated_file_cache = dict(current_file_cache)
    for track_path in normalized_paths:
        entry = dict(updated_file_cache[track_path])
        _set_local_cover_fields_on_mapping(
            entry,
            cover_value=cover_value,
            revision_value=revision_value,
        )
        updated_file_cache[track_path] = entry
    library_state["file_cache"] = updated_file_cache

    for album, matching_tracks in matching_albums:
        _set_cover_fields(
            album,
            cover_value=cover_value,
            revision_value=revision_value,
            remote_url_value=None,
            remote_thumb_value=None,
            remote_source_value=None,
            remote_source_label_value=None,
            remote_album_url_value=None,
            remote_cover_width=None,
            remote_cover_height=None,
        )
        if (
            str(getattr(album, "cover_path", "") or "") != cover_value
            or str(getattr(album, "cover_revision", "") or "") != revision_value
        ):
            raise RuntimeError("Authoritative cover fallback could not patch a matching album.")
        for track in matching_tracks:
            _set_cover_fields(
                track,
                cover_value=cover_value,
                revision_value=revision_value,
                remote_url_value=None,
                remote_thumb_value=None,
                remote_source_value=None,
                remote_source_label_value=None,
                remote_album_url_value=None,
                remote_cover_width=None,
                remote_cover_height=None,
            )
            if (
                str(getattr(track, "cover_path", "") or "") != cover_value
                or str(getattr(track, "cover_revision", "") or "") != revision_value
            ):
                raise RuntimeError(
                    "Authoritative cover fallback could not patch a matching track."
                )
    from music_app.services.problematic_albums import invalidate_problematic_albums_payload_cache
    from music_app.services.utility_rules import invalidate_utility_rules_payload_cache

    invalidate_problematic_albums_payload_cache(library_state)
    invalidate_utility_rules_payload_cache(library_state)


def _set_local_cover_fields_on_mapping(
    entry: dict[str, object],
    *,
    cover_value: str,
    revision_value: str,
) -> None:
    entry["cover_path"] = cover_value
    entry["cover_revision"] = revision_value
    entry["remote_cover_url"] = None
    entry["remote_cover_thumbnail_url"] = None
    entry["remote_cover_source"] = None
    entry["remote_cover_source_label"] = None
    entry["remote_cover_album_url"] = None
    entry["remote_cover_width"] = None
    entry["remote_cover_height"] = None


def _set_cover_fields(
    media_item,
    *,
    cover_value: str | None,
    revision_value: str | None,
    remote_url_value: str | None,
    remote_thumb_value: str | None,
    remote_source_value: str | None,
    remote_source_label_value: str | None,
    remote_album_url_value: str | None,
    remote_cover_width: int | None,
    remote_cover_height: int | None,
) -> None:
    try:
        setattr(media_item, "cover_path", cover_value)
        setattr(media_item, "cover_revision", revision_value)
        setattr(media_item, "remote_cover_url", remote_url_value)
        setattr(media_item, "remote_cover_thumbnail_url", remote_thumb_value)
        setattr(media_item, "remote_cover_source", remote_source_value)
        setattr(media_item, "remote_cover_source_label", remote_source_label_value)
        setattr(media_item, "remote_cover_album_url", remote_album_url_value)
        setattr(media_item, "remote_cover_width", int(remote_cover_width or 0) or None)
        setattr(media_item, "remote_cover_height", int(remote_cover_height or 0) or None)
    except Exception:
        return


def find_albums_by_track_paths(
    albums: list[object] | None,
    track_paths: set[str],
) -> list[dict[str, object]]:
    if not track_paths:
        return []
    matches: list[dict[str, object]] = []
    for album in albums or []:
        album_paths = {
            str(getattr(track, "path", "") or "")
            for track in getattr(album, "tracks", [])
            if str(getattr(track, "path", "") or "")
        }
        if album_paths & track_paths:
            matches.append(album_to_dict(album))
    return matches
