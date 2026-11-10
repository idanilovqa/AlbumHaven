"""Read-only, request-scoped presentation of already materialized copies."""

from collections.abc import Mapping
import math
from pathlib import PurePosixPath


def _text(value: object) -> str:
    return value if isinstance(value, str) else ""


def _basename(value: object) -> str:
    name = _text(value).replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]
    return "" if name in (".", "..") or (len(name) == 2 and name[1] == ":") else name


def _number(value: object, *, positive: bool = False) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        return value if math.isfinite(value) and (value > 0 if positive else value >= 0) else None
    except OverflowError:
        return None


def _integer(value: object) -> int | None:
    return value if isinstance(value, int) and _number(value, positive=True) is not None else None


def project_duplicate_copy_review(sources: object, *, include_paths: bool) -> list[dict[str, object]]:
    """Allowlist scalar display data without changing sources or reading media.

    Copy numbers belong only to this response, never to a physical-file action.
    A file extension is a format label, not evidence of a codec or audio quality.
    """
    if not isinstance(sources, list):
        return []
    copies: list[dict[str, object]] = []
    for source in sources:
        if not isinstance(source, Mapping) or not isinstance(source.get("tracks"), list):
            continue
        tracks = []
        for track in source["tracks"]:
            if not isinstance(track, Mapping):
                continue
            path = _text(track.get("path"))
            file_name = _basename(path or track.get("file_name"))
            if not file_name:
                continue
            projected = {
                "title": _text(track.get("title")),
                "file_name": file_name,
                "track_number": _integer(track.get("track_number")),
                "disc_number": _integer(track.get("disc_number")),
                "artist": _text(track.get("artist")),
                "year": _integer(track.get("year")),
                "duration_seconds": _number(track.get("duration_seconds")),
                "format": PurePosixPath(file_name).suffix.lstrip(".").upper(),
                "codec": _text(track.get("codec")) or None,
                "bitrate": _number(track.get("bitrate"), positive=True),
                "sample_rate": _number(track.get("sample_rate"), positive=True),
                "bit_depth": _number(track.get("bit_depth"), positive=True),
            }
            if include_paths:
                projected["path"] = path
            tracks.append(projected)
        if not tracks:
            continue
        durations = [track["duration_seconds"] for track in tracks]
        folder_path = _text(source.get("folder_path"))
        copy = {
            "copy_number": len(copies) + 1,
            "folder_name": _basename(folder_path or source.get("folder_name")),
            "track_count": len(tracks),
            "total_duration_seconds": _number(sum(durations)) if all(value is not None for value in durations) else None,
            "tracks": tracks,
        }
        if include_paths:
            copy["folder_path"] = folder_path
        copies.append(copy)
    return copies if len(copies) > 1 else []
