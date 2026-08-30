from __future__ import annotations

import re
from collections import defaultdict
from collections.abc import Iterable
from pathlib import Path, PurePosixPath, PureWindowsPath

from music_app.services.library_roots import configured_library_root_paths_snapshot
from music_app.services.metadata import normalize_exception_value
from music_app.services.utils import repair_display_text

_UNKNOWN_VALUES = {"", "unknown", "unknown artist", "unknown album", "none", "null"}
_NON_ALBUM_ALBUM_VALUE_RE = re.compile(r"^[!\-\s\[\(]*non[\s\-_]*album(?:\b.*)?$", re.IGNORECASE)
_DISC_FOLDER_RE = re.compile(r"(?<![A-Za-z0-9])(?:cd|disc|disk)\s*[-_.]?\s*(\d{1,2})(?![A-Za-z0-9])", re.IGNORECASE)


def has_meaningful_album_name(value: object) -> bool:
    text = str(value or "").strip()
    return bool(text and text.casefold() not in _UNKNOWN_VALUES)


def is_loose_track_album_value(value: object) -> bool:
    text = " ".join(str(value or "").strip().split())
    if not text:
        return False
    normalized = text.casefold()
    if normalized in _UNKNOWN_VALUES:
        return False
    return bool(_NON_ALBUM_ALBUM_VALUE_RE.match(text))


def _display_track_title(entry: dict[str, object]) -> str:
    title = str(entry.get("title") or "").strip()
    if title and title.casefold() not in _UNKNOWN_VALUES:
        return title
    return Path(str(entry.get("path") or "")).stem


def _normalized_artist(entry: dict[str, object]) -> str:
    normalized_artist = repair_display_text(
        str(entry.get("album_artist") or entry.get("artist") or "Unknown Artist")
    )
    return normalized_artist or str(entry.get("album_artist") or entry.get("artist") or "Unknown Artist")


def _lexical_relative_parts(
    path: str,
    configured_root_paths: tuple[Path, ...],
) -> tuple[str, ...] | None:
    raw_path = str(path or "").strip()
    if not raw_path:
        return None
    path_type = (
        PureWindowsPath
        if re.match(r"^[A-Za-z]:[\\/]", raw_path) or "\\" in raw_path
        else PurePosixPath
    )
    candidate = path_type(raw_path)
    for configured_root in configured_root_paths:
        root = path_type(str(configured_root))
        try:
            relative = candidate.relative_to(root)
        except ValueError:
            continue
        if relative.parts and all(part not in {"", ".", ".."} for part in relative.parts):
            return tuple(relative.parts)
    return None


def _relative_parent_parts(
    path: str,
    configured_root_paths: tuple[Path, ...],
) -> list[str]:
    rel_parts = _lexical_relative_parts(path, configured_root_paths)
    if rel_parts is not None:
        return list(rel_parts[:-1])

    path_parts = list(Path(path).parts)
    if path_parts and path_parts[0].endswith(("\\", ":")):
        path_parts = path_parts[1:]
    return path_parts[:-1]


def _display_path(path: str, configured_root_paths: tuple[Path, ...]) -> str:
    rel_parts = _lexical_relative_parts(path, configured_root_paths)
    if rel_parts:
        return str(Path(*rel_parts))
    return path


def _normalized_year(value: object) -> int | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        year = int(text)
    except (TypeError, ValueError):
        return None
    return year if year > 0 else None


def _positive_track_number(value: object) -> int | None:
    try:
        number = int(str(value or "").split("/", 1)[0].strip())
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _album_container(path: object) -> PurePosixPath | PureWindowsPath | None:
    raw_path = str(path or "").strip()
    if not raw_path:
        return None
    path_type = PureWindowsPath if re.match(r"^[A-Za-z]:[\\/]", raw_path) or "\\" in raw_path else PurePosixPath
    parent = path_type(raw_path).parent
    if _DISC_FOLDER_RE.search(parent.name) and parent.parent != parent:
        parent = parent.parent
    return parent


def _folder_signal_key(value: object) -> str:
    raw_value = str(value or "")
    display_value = repair_display_text(raw_value) or raw_value
    return re.sub(r"[^\w]+", "", display_value.casefold(), flags=re.UNICODE)


def infer_blank_album_membership(
    target: dict[str, object],
    entries: Iterable[object],
) -> str | None:
    """Return a conservative sibling-inferred album for one blank-tag track."""
    if has_meaningful_album_name(target.get("album")):
        return None
    target_number = _positive_track_number(target.get("track_number"))
    target_container = _album_container(target.get("path"))
    if target_number is None or target_container is None:
        return None

    numbered_siblings: list[tuple[str, int]] = []
    target_path = str(target.get("path") or "").casefold()
    for candidate in entries:
        if not isinstance(candidate, dict):
            continue
        candidate_path = str(candidate.get("path") or "")
        if not candidate_path or candidate_path.casefold() == target_path:
            continue
        if _album_container(candidate_path) != target_container:
            continue
        candidate_number = _positive_track_number(candidate.get("track_number"))
        candidate_album = repair_display_text(str(candidate.get("album") or "")).strip()
        if candidate_number is None or not has_meaningful_album_name(candidate_album) or is_loose_track_album_value(candidate_album):
            continue
        numbered_siblings.append((candidate_album, candidate_number))

    album_names = {album.casefold(): album for album, _number in numbered_siblings}
    if len(numbered_siblings) < 2 or len(album_names) != 1:
        return None
    inferred_album = next(iter(album_names.values()))
    if not any(abs(number - target_number) == 1 for _album, number in numbered_siblings):
        return None
    album_key = _folder_signal_key(inferred_album)
    if not album_key or not any(album_key in _folder_signal_key(part) for part in target_container.parts):
        return None
    return inferred_album


def build_non_album_album_groups(entries: list[dict[str, object]]) -> list[dict[str, object]]:
    buckets: dict[tuple[str, str, str, str], dict[str, object]] = {}
    for entry in entries:
        exception_type = normalize_exception_value(entry.get("exception_type"))
        album_name = repair_display_text(str(entry.get("album") or "")) or str(entry.get("album") or "")
        if not exception_type and has_meaningful_album_name(album_name) and not is_loose_track_album_value(album_name):
            continue
        artist = _normalized_artist(entry)
        exception_label = exception_type or "Loose Tracks"
        bucket_kind = "album" if has_meaningful_album_name(album_name) and not is_loose_track_album_value(album_name) else "type"
        bucket_name = album_name if bucket_kind == "album" else exception_label
        year_text = str(entry.get("year") or "").strip() if bucket_kind == "album" else ""
        key = (artist, bucket_kind, bucket_name, year_text)
        bucket = buckets.setdefault(key, {
            "key": f"non-album::{artist.casefold()}::{bucket_kind}::{bucket_name.casefold()}::{year_text.casefold()}",
            "name": bucket_name,
            "album_artist": artist,
            "cover_path": entry.get("cover_path"),
            "remote_cover_url": entry.get("remote_cover_url"),
            "remote_cover_thumbnail_url": entry.get("remote_cover_thumbnail_url"),
            "remote_cover_source": entry.get("remote_cover_source"),
            "remote_cover_source_label": entry.get("remote_cover_source_label"),
            "remote_cover_album_url": entry.get("remote_cover_album_url"),
            "remote_cover_width": entry.get("remote_cover_width"),
            "remote_cover_height": entry.get("remote_cover_height"),
            "year": entry.get("year") if bucket_kind == "album" else None,
            "edition": exception_label if bucket_kind != "album" else (exception_type or None),
            "album_rating": 0,
            "total_duration_seconds": 0,
            "tracks": [],
            "is_non_album": True,
            "non_album_kind": bucket_kind,
            "exception_type": exception_type or None,
        })
        duration = int(entry.get("duration_seconds") or 0)
        bucket["total_duration_seconds"] += duration
        if not bucket.get("cover_path") and entry.get("cover_path"):
            bucket["cover_path"] = entry.get("cover_path")
        if not bucket.get("remote_cover_url") and entry.get("remote_cover_url"):
            bucket["remote_cover_url"] = entry.get("remote_cover_url")
            bucket["remote_cover_thumbnail_url"] = entry.get("remote_cover_thumbnail_url")
            bucket["remote_cover_source"] = entry.get("remote_cover_source")
            bucket["remote_cover_source_label"] = entry.get("remote_cover_source_label")
            bucket["remote_cover_album_url"] = entry.get("remote_cover_album_url")
            bucket["remote_cover_width"] = entry.get("remote_cover_width")
            bucket["remote_cover_height"] = entry.get("remote_cover_height")
        bucket["tracks"].append({
            "path": str(entry.get("path") or ""),
            "title": _display_track_title(entry),
            "track_number": entry.get("track_number"),
            "disc_number": entry.get("disc_number"),
            "disc_number_raw": entry.get("disc_number_raw"),
            "artist": str(entry.get("artist") or artist),
            "album": bucket_name if bucket_kind == "album" else "",
            "album_artist": artist,
            "year": entry.get("year"),
            "edition": str(entry.get("edition") or ""),
            "album_rating": int(entry.get("album_rating") or 0),
            "exception_type": exception_type or None,
            "cover_path": entry.get("cover_path"),
            "remote_cover_url": entry.get("remote_cover_url"),
            "remote_cover_thumbnail_url": entry.get("remote_cover_thumbnail_url"),
            "remote_cover_source": entry.get("remote_cover_source"),
            "remote_cover_source_label": entry.get("remote_cover_source_label"),
            "remote_cover_album_url": entry.get("remote_cover_album_url"),
            "remote_cover_width": entry.get("remote_cover_width"),
            "remote_cover_height": entry.get("remote_cover_height"),
            "duration_seconds": entry.get("duration_seconds"),
        })

    for bucket in buckets.values():
        bucket["tracks"].sort(key=lambda track: (
            int(track.get("disc_number") or 999),
            int(track.get("track_number") or 999),
            str(track.get("title") or "").casefold(),
        ))
        bucket["total_duration_display"] = (
            str(bucket["total_duration_seconds"] // 60)
            + ":"
            + str(bucket["total_duration_seconds"] % 60).zfill(2)
            if bucket["total_duration_seconds"]
            else ""
        )
    groups: dict[str, list[dict[str, object]]] = defaultdict(list)
    for bucket in buckets.values():
        groups[str(bucket.get("album_artist") or "Unknown Artist")].append(bucket)
    return [
        {
            "artist": artist,
            "albums": sorted(items, key=lambda item: (str(item.get("name") or "").casefold(), str(item.get("year") or ""))),
        }
        for artist, items in sorted(groups.items(), key=lambda pair: pair[0].casefold())
    ]


def build_non_album_track_list(
    entries: list[dict[str, object]],
    *,
    config: object | None = None,
    configured_root_paths: tuple[Path, ...] | None = None,
) -> list[dict[str, object]]:
    if not entries:
        return []
    root_paths = (
        configured_root_paths
        if configured_root_paths is not None
        else configured_library_root_paths_snapshot(config)
        if isinstance(config, dict)
        else ()
    )
    tracks = []
    for entry in entries:
        exception_type = normalize_exception_value(entry.get("exception_type"))
        album_value = entry.get("album")
        rel_parts = _relative_parent_parts(
            str(entry.get("path") or ""),
            root_paths,
        )
        is_direct_artist_file = len(rel_parts) == 2
        if (
            has_meaningful_album_name(album_value)
            and not is_loose_track_album_value(album_value)
            and not exception_type
            and not is_direct_artist_file
        ):
            continue
        year = _normalized_year(entry.get("year"))
        path = str(entry.get("path") or "")
        tracks.append({
            "path": path,
            "artist": _normalized_artist(entry),
            "tag_artist": str(entry.get("artist") or ""),
            "album_artist": str(entry.get("album_artist") or ""),
            "album": str(album_value or ""),
            "title": _display_track_title(entry),
            "genre": str(entry.get("genre") or ""),
            "year": year,
            "year_label": str(year) if year is not None else "Unknown",
            "track_number": entry.get("track_number"),
            "disc_number": entry.get("disc_number"),
            "exception_type": exception_type or "",
            "edition": str(entry.get("edition") or ""),
            "album_rating": entry.get("album_rating"),
            "reason_label": exception_type or "Unmarked",
            "display_path": _display_path(path, root_paths),
            "duration_seconds": entry.get("duration_seconds"),
        })
    return sorted(
        tracks,
        key=lambda item: (
            str(item.get("artist") or "").casefold(),
            item.get("year") is None,
            int(item.get("year") or 0),
            str(item.get("title") or "").casefold(),
        ),
    )
