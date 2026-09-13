from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote
import shutil
import math
import re
import subprocess
import tempfile
import uuid

from config import PERSISTENCE_BACKEND_POSTGRES
from music_app.services.ffmpeg_runtime import (
    hidden_subprocess_creation_flags,
    resolve_ffmpeg_executable as _resolve_ffmpeg_executable,
)
from music_app.services.persistence_selection import select_runtime_persistence_adapter
from music_app.services.saved_loops_postgres import SavedLoopsPostgresAdapter, LoopOrderError


_NO_WINDOW_CREATION_FLAGS = hidden_subprocess_creation_flags()


def loops_dir(config, *, account_id=None, library_id=None) -> Path:
    path = Path(config["DATA_DIR"]) / "loops"
    if account_id is not None or library_id is not None:
        if type(account_id) is not int or type(library_id) is not int or account_id <= 0 or library_id <= 0:
            raise LoopOrderError(403, 'Library scope is required')
        path = path / f'account-{account_id}' / f'library-{library_id}'
    path.mkdir(parents=True, exist_ok=True)
    return path


def loop_previews_dir(config, *, account_id=None, library_id=None) -> Path:
    path = Path(config["DATA_DIR"]) / "loop_previews"
    if account_id is not None or library_id is not None:
        if type(account_id) is not int or type(library_id) is not int or account_id <= 0 or library_id <= 0:
            raise LoopOrderError(403, 'Library scope is required')
        path = path / f'account-{account_id}' / f'library-{library_id}'
    path.mkdir(parents=True, exist_ok=True)
    return path


def resolve_loop_original_window(loop, get_parent):
    """Resolve historical media-relative coordinates without fabricating ancestry."""
    current = loop
    offset = 0.0
    seen = set()
    try:
        duration = float(loop["end_seconds"]) - float(loop["start_seconds"])
        if not math.isfinite(duration) or duration <= 0:
            return None
        while isinstance(current, dict):
            key = str(current.get("id") or "")
            if key in seen:
                return None
            seen.add(key)
            local_start = float(current["start_seconds"])
            local_end = float(current["end_seconds"])
            local_duration = local_end - local_start
            if not math.isfinite(local_start) or not math.isfinite(local_end) or local_start < 0 or local_duration <= 0:
                return None
            if offset + duration > local_duration + 0.001:
                return None
            if current.get("original_start_seconds") is not None and current.get("original_end_seconds") is not None:
                start = float(current["original_start_seconds"])
                end = float(current["original_end_seconds"])
                if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
                    return None
                if abs((end - start) - local_duration) > 0.001:
                    return None
                return round(offset + start, 3), round(offset + start + duration, 3)
            start = float(current["start_seconds"])
            if not math.isfinite(start) or start < 0:
                return None
            offset += start
            parent_id = str(current.get("parent_loop_id") or "")
            if not parent_id:
                return round(offset, 3), round(offset + duration, 3)
            current = get_parent(parent_id)
        return None
    except (KeyError, TypeError, ValueError, OverflowError):
        return None


def load_loops(config, *, account_id=None, library_id=None) -> list[dict[str, object]]:
    selection = select_runtime_persistence_adapter("saved_loops", config)
    if selection.effective_backend == PERSISTENCE_BACKEND_POSTGRES:
        adapter = SavedLoopsPostgresAdapter(config)
        items = adapter.load_scoped_loops(account_id=account_id,library_id=library_id) if account_id is not None else adapter.load_loops()
        by_id = {str(item.get("id") or ""): item for item in items}
        for item in items:
            original = resolve_loop_original_window(item, by_id.get)
            if original is not None:
                item["original_start_seconds"], item["original_end_seconds"] = original
            elif "original_start_seconds" in item or "original_end_seconds" in item:
                item["original_start_seconds"] = item["original_end_seconds"] = None
        return items
    raise RuntimeError("Saved loop runtime metadata requires Postgres persistence.")


def save_loops(config, loops: list[dict[str, object]]) -> None:
    selection = select_runtime_persistence_adapter("saved_loops", config)
    if selection.effective_backend == PERSISTENCE_BACKEND_POSTGRES:
        SavedLoopsPostgresAdapter(config).save_loops(
            [item for item in (loops or []) if isinstance(item, dict)]
        )
        return
    raise RuntimeError("Saved loop runtime metadata requires Postgres persistence.")


def get_loop(config, loop_id: str, *, account_id=None, library_id=None) -> dict[str, object] | None:
    for item in load_loops(config, **({"account_id":account_id,"library_id":library_id} if account_id is not None else {})):
        if str(item.get("id") or "") == str(loop_id or ""):
            return item
    return None


def resolve_loop_media_path(config, loop_id: str, *, account_id=None, library_id=None) -> Path | None:
    item = get_loop(config, loop_id, **({"account_id":account_id,"library_id":library_id} if account_id is not None else {}))
    if not item:
        return None

    requested_id = str(loop_id or "")
    safe_id = "".join(ch for ch in requested_id if ch.isalnum() or ch in {"-", "_"})
    if not safe_id or safe_id != requested_id:
        return None

    root = loops_dir(config).resolve()
    if account_id is not None:
        path = Path(str(item.get('path') or '')).expanduser().resolve()
        try:
            path.relative_to(root)
        except ValueError:
            return None
        if not path.is_file():
            return None
        owned_root = loops_dir(config,account_id=account_id,library_id=library_id).resolve()
        if not path.is_relative_to(owned_root) and not SavedLoopsPostgresAdapter(config).is_unique_scoped_artifact(account_id=account_id,library_id=library_id,loop_id=loop_id,path=str(path)):
            return None
        return path
    canonical_path = (root / f"{safe_id}.mp3").resolve()
    try:
        canonical_path.relative_to(root)
    except ValueError:
        return None

    if canonical_path.is_file():
        return canonical_path

    path = Path(str(item.get("path") or "")).expanduser().resolve()
    try:
        path.relative_to(root)
    except ValueError:
        return None
    return path if path.is_file() else None


def _preview_id(loop_id: str, semitones: int) -> str:
    safe_loop_id = "".join(ch for ch in str(loop_id or "") if ch.isalnum() or ch in {"-", "_"})
    pitch_part = f"p{semitones:+d}".replace("+", "plus").replace("-", "minus")
    return f"{safe_loop_id}_{pitch_part}"


def resolve_loop_preview_path(config, preview_id: str, *, account_id=None, library_id=None) -> Path | None:
    match = re.fullmatch(r'([A-Za-z0-9_-]+)_p(plus|minus)([1-9]|1[0-2])', str(preview_id or ''))
    if not match:
        return None
    scope = {'account_id':account_id,'library_id':library_id} if account_id is not None else {}
    if scope and get_loop(config, match[1], **scope) is None:
        return None
    root = loop_previews_dir(config, **scope).resolve()
    path = (root / f'{preview_id}.mp3').resolve()
    if not root.is_relative_to(loop_previews_dir(config).resolve()) or not path.is_relative_to(root):
        return None
    return path if path.is_file() else None


def probe_loop_source_duration(path: Path) -> float:
    from music_app.services.waveform_peaks import _audio_duration_seconds
    return _audio_duration_seconds(path)


def _format_timestamp(value: float) -> str:
    value = max(0.0, float(value or 0.0))
    minutes = int(value // 60)
    seconds = value - minutes * 60
    return f"{minutes:02d}:{seconds:06.3f}"


def create_loop_file(config, source_path: Path, start_seconds: float, end_seconds: float, loop_id: str, **scope) -> Path:
    ffmpeg = _resolve_ffmpeg_executable()
    if not ffmpeg:
        raise RuntimeError("ffmpeg was not found. Install project dependencies with pip install -r requirements.txt to enable MP3 loop saving.")

    start = max(0.0, float(start_seconds))
    end = max(0.0, float(end_seconds))
    if end <= start:
        raise ValueError("Loop end must be after loop start.")

    safe_id = str(loop_id or uuid.uuid4().hex)
    output_path = loops_dir(config, **scope) / f"{safe_id}.mp3"
    with tempfile.TemporaryDirectory(prefix="album_haven_loop_") as tmp:
        temp_source = Path(tmp) / source_path.name
        shutil.copy2(source_path, temp_source)
        command = [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            _format_timestamp(start),
            "-i",
            str(temp_source),
            "-t",
            _format_timestamp(end - start),
            "-vn",
            "-codec:a",
            "libmp3lame",
            "-q:a",
            "2",
            str(output_path),
        ]
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
            creationflags=_NO_WINDOW_CREATION_FLAGS,
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or "ffmpeg failed to create the loop.")
    return output_path


def _run_ffmpeg(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        capture_output=True,
        text=True,
        check=False,
        creationflags=_NO_WINDOW_CREATION_FLAGS,
    )


def create_pitch_preview_file(config, loop_id: str, source_path: Path, semitones: int, **scope) -> tuple[str, Path]:
    pitch = max(-12, min(12, int(semitones)))
    preview_id = _preview_id(loop_id, pitch)
    output_path = loop_previews_dir(config, **scope) / f"{preview_id}.mp3"
    if output_path.exists():
        return preview_id, output_path

    ffmpeg = _resolve_ffmpeg_executable()
    if not ffmpeg:
        raise RuntimeError("ffmpeg was not found. Install project dependencies with pip install -r requirements.txt to enable pitch previews.")

    ratio = 2 ** (pitch / 12)
    rubberband_command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source_path),
        "-vn",
        "-af",
        f"rubberband=pitch={ratio:.8f}",
        "-codec:a",
        "libmp3lame",
        "-q:a",
        "2",
        str(output_path),
    ]
    result = _run_ffmpeg(rubberband_command)
    if result.returncode == 0:
        return preview_id, output_path

    if output_path.exists():
        output_path.unlink(missing_ok=True)

    # Fallback: pitch via sample-rate change, then restore tempo with atempo.
    fallback_command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source_path),
        "-vn",
        "-af",
        f"asetrate=44100*{ratio:.8f},aresample=44100,atempo={1 / ratio:.8f}",
        "-codec:a",
        "libmp3lame",
        "-q:a",
        "2",
        str(output_path),
    ]
    fallback = _run_ffmpeg(fallback_command)
    if fallback.returncode != 0:
        if output_path.exists():
            output_path.unlink(missing_ok=True)
        error = fallback.stderr.strip() or result.stderr.strip() or "ffmpeg failed to create the pitch preview."
        raise RuntimeError(error)
    return preview_id, output_path


def add_loop(config, item: dict[str, object], **scope) -> dict[str, object]:
    if scope:
        return SavedLoopsPostgresAdapter(config).add_scoped_loop(item=item, **scope)
    loops = load_loops(config)
    loops.insert(0, item)
    save_loops(config, loops)
    return item


def reorder_loops(config, ordered_ids: list[object], *, song_key=None, expected_revision=None, **scope):
    if scope:
        return SavedLoopsPostgresAdapter(config).reorder_scoped_loops(ordered_ids=ordered_ids,song_key=song_key,expected_revision=expected_revision,**scope)
    loops = load_loops(config)
    if not loops:
        return []

    by_id = {
        str(item.get("id") or ""): item
        for item in loops
        if isinstance(item, dict) and str(item.get("id") or "")
    }
    seen: set[str] = set()
    reordered: list[dict[str, object]] = []

    for raw_id in ordered_ids:
        loop_id = str(raw_id or "")
        if not loop_id or loop_id in seen:
            continue
        item = by_id.get(loop_id)
        if item is None:
            continue
        reordered.append(item)
        seen.add(loop_id)

    for item in loops:
        loop_id = str(item.get("id") or "")
        if not loop_id or loop_id in seen:
            continue
        reordered.append(item)
        seen.add(loop_id)

    save_loops(config, reordered)
    return reordered


def _safe_unlink_child(path: Path, root: Path) -> None:
    try:
        resolved = path.expanduser().resolve()
        resolved.relative_to(root.resolve())
    except Exception:
        return
    if resolved.exists() and resolved.is_file():
        resolved.unlink()


def delete_loop(config, loop_id: str, **scope) -> tuple[bool, list[dict[str, object]]]:
    if scope:
        target = get_loop(config,loop_id,**scope)
        deleted, remaining = SavedLoopsPostgresAdapter(config).delete_scoped_loop(loop_id=loop_id,**scope)
        if deleted and target:
            # New scoped artifacts are owned; shared legacy bytes are retained.
            root = loops_dir(config,**scope)
            _safe_unlink_child(Path(str(target.get('path') or '')),root)
            if re.fullmatch(r'[A-Za-z0-9_-]+',loop_id):
                for preview in loop_previews_dir(config,**scope).glob(f'{loop_id}_p*.mp3'):
                    _safe_unlink_child(preview,loop_previews_dir(config,**scope))
        return deleted, remaining
    target_id = str(loop_id or "")
    loops = load_loops(config)
    target = next((item for item in loops if str(item.get("id") or "") == target_id), None)
    if not target:
        return False, loops

    remaining = [item for item in loops if str(item.get("id") or "") != target_id]
    save_loops(config, remaining)

    loop_root = loops_dir(config)
    preview_root = loop_previews_dir(config)
    _safe_unlink_child(Path(str(target.get("path") or "")), loop_root)
    safe_id = "".join(ch for ch in target_id if ch.isalnum() or ch in {"-", "_"})
    if safe_id and safe_id == target_id:
        _safe_unlink_child(loop_root / f"{safe_id}.mp3", loop_root)
        for preview in preview_root.glob(f"{safe_id}_*.mp3"):
            _safe_unlink_child(preview, preview_root)
    return True, remaining


def build_loop_item(
    *,
    loop_id: str,
    name: str,
    path: Path,
    source_path: Path,
    start_seconds: float,
    end_seconds: float,
    artist: str = "",
    title: str = "",
    album: str = "",
    cover_path: str = "",
    parent_loop_id: str = "",
    original_start_seconds: float | None = None,
    original_end_seconds: float | None = None,
) -> dict[str, object]:
    return {
        "id": loop_id,
        "name": name,
        "path": str(path),
        "source_path": str(source_path),
        "start_seconds": round(float(start_seconds), 3),
        "end_seconds": round(float(end_seconds), 3),
        "duration_seconds": round(float(end_seconds) - float(start_seconds), 3),
        "original_start_seconds": round(float(original_start_seconds), 3) if original_start_seconds is not None else (round(float(start_seconds), 3) if not parent_loop_id else None),
        "original_end_seconds": round(float(original_end_seconds), 3) if original_end_seconds is not None else (round(float(end_seconds), 3) if not parent_loop_id else None),
        "artist": artist,
        "title": title,
        "album": album,
        "cover_path": cover_path,
        "parent_loop_id": parent_loop_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


_PUBLIC_LOOP_FIELDS = frozenset({
    'id','name','artist','title','album','year','created_at','start_seconds','end_seconds',
    'duration_seconds','parent_loop_id','original_start_seconds','original_end_seconds',
    'song_key','song_identity_status','order_revision','can_reorder',
})


def project_loop_for_client(item):
    result = {key:value for key,value in item.items() if key in _PUBLIC_LOOP_FIELDS
              and (value is None or isinstance(value,(str,int,float,bool)))}
    result['cover_url'] = '/cover?loop_id=' + quote(str(item.get('id') or ''),safe='') if item.get('cover_path') else ''
    return result


def project_loop_order_for_client(snapshot):
    result = {key:snapshot[key] for key in ('ok','error','song_key','order_revision','ordered_ids') if key in snapshot}
    if 'loops' in snapshot:
        result['loops'] = [project_loop_for_client(item) for item in snapshot['loops']]
    return result
