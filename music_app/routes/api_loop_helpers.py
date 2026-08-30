from __future__ import annotations

from collections.abc import Callable
from pathlib import Path


JsonDict = dict[str, object]
ConfigDict = dict[str, object]
LoopGetter = Callable[[ConfigDict, str], JsonDict | None]
LoopSourceResolver = Callable[[ConfigDict, str], Path | None]
TrackPathNormalizer = Callable[[str], Path | None]


def validate_loop_create_payload(payload: JsonDict):
    name = str(payload.get("name") or "").strip()
    if not name:
        return None, ({"ok": False, "error": "Loop name is required"}, 400)
    try:
        start_seconds = float(payload.get("start_seconds"))
        end_seconds = float(payload.get("end_seconds"))
    except (TypeError, ValueError):
        return None, ({"ok": False, "error": "Loop start and end times are required"}, 400)
    if end_seconds <= start_seconds:
        return None, ({"ok": False, "error": "Loop end must be after loop start"}, 400)
    return {
        "name": name,
        "start_seconds": start_seconds,
        "end_seconds": end_seconds,
        "parent_loop_id": str(payload.get("source_loop_id") or "").strip(),
    }, None


def resolve_loop_creation_source(
    payload: JsonDict,
    *,
    config: ConfigDict,
    get_loop: LoopGetter,
    resolve_loop_media_path: LoopSourceResolver,
    normalize_music_file_path: TrackPathNormalizer,
    file_cache: dict[str, object],
):
    parent_loop_id = str(payload.get("source_loop_id") or "").strip()
    parent_loop = get_loop(config, parent_loop_id) if parent_loop_id else None

    if parent_loop:
        source_path = resolve_loop_media_path(config, parent_loop_id)
        if source_path is None:
            return None, ({"ok": False, "error": "Saved loop source file was not found"}, 400)
        return {
            "source_path": source_path,
            "artist": str(parent_loop.get("artist") or ""),
            "title": str(parent_loop.get("title") or ""),
            "album": str(parent_loop.get("album") or ""),
            "cover_path": str(parent_loop.get("cover_path") or ""),
            "parent_loop_id": parent_loop_id,
        }, None

    source_path = normalize_music_file_path(str(payload.get("source_path") or ""))
    if source_path is None:
        return None, ({"ok": False, "error": "Source file was not found or is outside the music library"}, 400)
    entry = file_cache.get(str(source_path)) if isinstance(file_cache, dict) else None
    entry = entry if isinstance(entry, dict) else {}
    return {
        "source_path": source_path,
        "artist": str(payload.get("artist") or entry.get("artist") or entry.get("album_artist") or ""),
        "title": str(payload.get("title") or entry.get("title") or source_path.stem),
        "album": str(payload.get("album") or entry.get("album") or ""),
        "cover_path": str(payload.get("cover_path") or entry.get("cover_path") or ""),
        "parent_loop_id": "",
    }, None


def parse_required_loop_id(payload: JsonDict):
    loop_id = str(payload.get("loop_id") or "").strip()
    if not loop_id:
        return None, ({"ok": False, "error": "Missing loop id"}, 400)
    return loop_id, None


def parse_pitch_semitones(payload: JsonDict):
    try:
        semitones = int(payload.get("semitones") or 0)
    except (TypeError, ValueError):
        return None, ({"ok": False, "error": "Invalid pitch value"}, 400)
    return max(-12, min(12, semitones)), None
