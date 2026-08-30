from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid

from config import PERSISTENCE_BACKEND_POSTGRES
from music_app.services.ffmpeg_runtime import (
    hidden_subprocess_creation_flags,
    resolve_ffmpeg_executable as _resolve_ffmpeg_executable,
)
from music_app.services.persistence_selection import select_runtime_persistence_adapter
from music_app.services.saved_loops_postgres import SavedLoopsPostgresAdapter


_NO_WINDOW_CREATION_FLAGS = hidden_subprocess_creation_flags()


def loops_dir(config) -> Path:
    path = Path(config["DATA_DIR"]) / "loops"
    path.mkdir(parents=True, exist_ok=True)
    return path


def loop_previews_dir(config) -> Path:
    path = Path(config["DATA_DIR"]) / "loop_previews"
    path.mkdir(parents=True, exist_ok=True)
    return path


def load_loops(config) -> list[dict[str, object]]:
    selection = select_runtime_persistence_adapter("saved_loops", config)
    if selection.effective_backend == PERSISTENCE_BACKEND_POSTGRES:
        return SavedLoopsPostgresAdapter(config).load_loops()
    raise RuntimeError("Saved loop runtime metadata requires Postgres persistence.")


def save_loops(config, loops: list[dict[str, object]]) -> None:
    selection = select_runtime_persistence_adapter("saved_loops", config)
    if selection.effective_backend == PERSISTENCE_BACKEND_POSTGRES:
        SavedLoopsPostgresAdapter(config).save_loops(
            [item for item in (loops or []) if isinstance(item, dict)]
        )
        return
    raise RuntimeError("Saved loop runtime metadata requires Postgres persistence.")


def get_loop(config, loop_id: str) -> dict[str, object] | None:
    for item in load_loops(config):
        if str(item.get("id") or "") == str(loop_id or ""):
            return item
    return None


def resolve_loop_media_path(config, loop_id: str) -> Path | None:
    item = get_loop(config, loop_id)
    if not item:
        return None

    requested_id = str(loop_id or "")
    safe_id = "".join(ch for ch in requested_id if ch.isalnum() or ch in {"-", "_"})
    if not safe_id or safe_id != requested_id:
        return None

    root = loops_dir(config).resolve()
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


def resolve_loop_preview_path(config, preview_id: str) -> Path | None:
    safe_id = "".join(ch for ch in str(preview_id or "") if ch.isalnum() or ch in {"-", "_"})
    if not safe_id:
        return None
    path = (loop_previews_dir(config) / f"{safe_id}.mp3").resolve()
    root = loop_previews_dir(config).resolve()
    try:
        path.relative_to(root)
    except ValueError:
        return None
    return path if path.exists() else None


def _format_timestamp(value: float) -> str:
    value = max(0.0, float(value or 0.0))
    minutes = int(value // 60)
    seconds = value - minutes * 60
    return f"{minutes:02d}:{seconds:06.3f}"


def create_loop_file(config, source_path: Path, start_seconds: float, end_seconds: float, loop_id: str) -> Path:
    ffmpeg = _resolve_ffmpeg_executable()
    if not ffmpeg:
        raise RuntimeError("ffmpeg was not found. Install project dependencies with pip install -r requirements.txt to enable MP3 loop saving.")

    start = max(0.0, float(start_seconds))
    end = max(0.0, float(end_seconds))
    if end <= start:
        raise ValueError("Loop end must be after loop start.")

    safe_id = str(loop_id or uuid.uuid4().hex)
    output_path = loops_dir(config) / f"{safe_id}.mp3"
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


def create_pitch_preview_file(config, loop_id: str, source_path: Path, semitones: int) -> tuple[str, Path]:
    pitch = max(-12, min(12, int(semitones)))
    preview_id = _preview_id(loop_id, pitch)
    output_path = loop_previews_dir(config) / f"{preview_id}.mp3"
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


def add_loop(config, item: dict[str, object]) -> dict[str, object]:
    loops = load_loops(config)
    loops.insert(0, item)
    save_loops(config, loops)
    return item


def reorder_loops(config, ordered_ids: list[object]) -> list[dict[str, object]]:
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


def delete_loop(config, loop_id: str) -> tuple[bool, list[dict[str, object]]]:
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
) -> dict[str, object]:
    return {
        "id": loop_id,
        "name": name,
        "path": str(path),
        "source_path": str(source_path),
        "start_seconds": round(float(start_seconds), 3),
        "end_seconds": round(float(end_seconds), 3),
        "duration_seconds": round(float(end_seconds) - float(start_seconds), 3),
        "artist": artist,
        "title": title,
        "album": album,
        "cover_path": cover_path,
        "parent_loop_id": parent_loop_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
