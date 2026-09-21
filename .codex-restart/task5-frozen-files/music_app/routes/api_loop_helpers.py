from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
import math

from music_app.services.loops import resolve_loop_original_window


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
    if not math.isfinite(start_seconds) or not math.isfinite(end_seconds) or start_seconds < 0:
        return None, ({"ok": False, "error": "Loop times must be finite and nonnegative"}, 400)
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
    scope=None,
):
    parent_loop_id = str(payload.get("source_loop_id") or "").strip()
    parent_loop = get_loop(config, parent_loop_id) if parent_loop_id else None
    if parent_loop_id and not parent_loop:
        return None, ({"ok": False, "error": "Saved loop source was not found"}, 400)
    try:
        start_seconds = float(payload.get("start_seconds") or 0)
        end_seconds = float(payload.get("end_seconds") or 0)
    except (TypeError, ValueError, OverflowError):
        return None, ({"ok": False, "error": "Loop times must be finite and nonnegative"}, 400)
    if not math.isfinite(start_seconds) or not math.isfinite(end_seconds) or start_seconds < 0 or end_seconds <= start_seconds:
        return None, ({"ok": False, "error": "Loop times must define a finite positive range"}, 400)

    if parent_loop:
        if scope:
            from music_app.services.saved_loops_postgres import SavedLoopsPostgresAdapter, LoopOrderError
            try:
                SavedLoopsPostgresAdapter(config).resolve_scoped_source(**scope, item={
                    'parent_loop_id':parent_loop_id,'start_seconds':start_seconds,'end_seconds':end_seconds,
                })
            except LoopOrderError as error:
                return None, (error.payload,error.status_code)
        original = resolve_loop_original_window(parent_loop, lambda key: get_loop(config, key))
        if original is None:
            return None, ({"ok": False, "error": "Original song timestamps are unavailable for this saved loop"}, 409)
        if end_seconds > original[1] - original[0] + 0.001:
            return None, ({"ok": False, "error": "Loop range exceeds the saved source duration"}, 400)
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
            "original_start_seconds": round(original[0] + start_seconds, 3),
            "original_end_seconds": round(original[0] + end_seconds, 3),
        }, None

    source_path = normalize_music_file_path(str(payload.get("source_path") or ""))
    if source_path is None:
        return None, ({"ok": False, "error": "Source file was not found or is outside the music library"}, 400)
    if scope:
        from music_app.services.saved_loops_postgres import SavedLoopsPostgresAdapter, LoopOrderError
        try:
            track_id, _parent_id = SavedLoopsPostgresAdapter(config).resolve_scoped_source(**scope, item={
                'source_path': str(source_path), 'start_seconds': start_seconds, 'end_seconds': end_seconds,
            })
        except LoopOrderError as error:
            return None, (error.payload,error.status_code)
    entry = file_cache.get(str(source_path)) if isinstance(file_cache, dict) else None
    entry = entry if isinstance(entry, dict) else {}
    cover_path = str((entry.get('cover_path') if scope else payload.get('cover_path') or entry.get('cover_path')) or '')
    if scope and not cover_path:
        cover_path = SavedLoopsPostgresAdapter(config).get_scoped_track_cover(**scope,track_id=track_id)
    return {
        "source_path": source_path,
        "artist": str(payload.get("artist") or entry.get("artist") or entry.get("album_artist") or ""),
        "title": str(payload.get("title") or entry.get("title") or source_path.stem),
        "album": str(payload.get("album") or entry.get("album") or ""),
        "cover_path": cover_path,
        "parent_loop_id": "",
        "original_start_seconds": start_seconds,
        "original_end_seconds": end_seconds,
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
