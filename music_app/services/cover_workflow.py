from __future__ import annotations

import base64
import hashlib
import io
import os
from dataclasses import dataclass
from pathlib import Path
import re
import tempfile
from threading import Lock
from typing import Callable

from music_app.services.cover_remote_image_downloads import fetch_remote_image
from music_app.services.covers import Image, reserve_existing_cover_variant
from music_app.services.library_roots import get_library_roots, iter_library_root_paths, resolve_configured_media_path


_ALBUM_DISC_MARKER_RE = re.compile(
    r"(?<![A-Za-z0-9])(?:cd|disc|disk)\s*[-_.]?\s*(?P<number>\d{1,2})(?![A-Za-z0-9])",
    re.IGNORECASE,
)
_LOCAL_COVER_SELECTION_LOCKS_GUARD = Lock()
_LOCAL_COVER_SELECTION_LOCKS: dict[str, tuple[Lock, int]] = {}


@dataclass(frozen=True)
class CoverAlbumContext:
    album_root: Path
    track_paths: set[str]


@dataclass
class LocalCoverPromotion:
    cover_path: Path
    prior_cover_existed: bool
    prior_cover_bytes: bytes | None
    reserve_artifact: Path | None
    promoted_cover_revision: str = ""
    selection_lock_key: str = ""
    selection_lock: Lock | None = None
    prior_cover_atime_ns: int | None = None
    prior_cover_mtime_ns: int | None = None
    prior_reserve_artifacts: frozenset[Path] = frozenset()
    reserve_artifacts: frozenset[Path] = frozenset()


def normalize_music_file_path(config: dict[str, object], raw_path: str) -> Path | None:
    return resolve_configured_media_path(config, raw_path)


def is_disc_like_folder(path: Path) -> bool:
    return bool(_ALBUM_DISC_MARKER_RE.search(path.name or ""))


def resolve_album_root_from_track_paths(
    config: dict[str, object],
    track_paths: set[str],
) -> Path | None:
    configured_roots = get_library_roots(config)
    configured_root_paths = [
        Path(str(root.get("path") or "")).resolve(strict=False)
        for root in configured_roots
        if isinstance(root, dict) and str(root.get("path") or "").strip()
    ]
    resolved_dirs: list[Path] = []
    for raw_path in track_paths:
        raw_text = str(raw_path or "")
        if not raw_text:
            continue
        resolved = resolve_configured_media_path(
            config,
            raw_text,
            configured_root_paths=configured_root_paths,
        )
        if resolved is None:
            return None
        parent = resolved.parent
        if is_disc_like_folder(parent) and parent.parent != parent:
            parent = parent.parent
        resolved_dirs.append(parent)
    if not resolved_dirs:
        return None
    resolved_album_roots = [path.resolve(strict=False) for path in resolved_dirs]
    if len(resolved_album_roots) == 1:
        album_root = resolved_album_roots[0]
    else:
        try:
            common_root = Path(os.path.commonpath([str(path) for path in resolved_album_roots])).resolve(strict=False)
        except Exception:
            return None
        unique_album_roots = {
            os.path.normcase(str(path)): path
            for path in resolved_album_roots
        }
        if len(unique_album_roots) == 1:
            album_root = next(iter(unique_album_roots.values()))
        else:
            if not all(_is_path_within(path, common_root) for path in resolved_album_roots):
                return None
            album_root = common_root
    if not _is_valid_album_root(config, album_root, configured_roots=configured_roots):
        return None
    return album_root


def resolve_album_context(
    config: dict[str, object],
    album: dict[str, object],
) -> CoverAlbumContext | None:
    track_paths = {
        str(track.get("path") or "")
        for track in album.get("tracks", [])
        if isinstance(track, dict) and str(track.get("path") or "")
    }
    album_root = resolve_album_root_from_track_paths(config, track_paths)
    if album_root is None or not track_paths:
        return None
    return CoverAlbumContext(album_root=album_root, track_paths=track_paths)


def _is_path_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except Exception:
        return False
    return True


def _matching_library_roots(
    config: dict[str, object],
    path: Path,
    *,
    configured_roots: list[dict[str, object]] | None = None,
) -> list[tuple[dict[str, object], Path]]:
    matches: list[tuple[dict[str, object], Path]] = []
    roots = get_library_roots(config) if configured_roots is None else configured_roots
    for root in roots:
        if not isinstance(root, dict):
            continue
        root_path = Path(str(root.get("path") or "")).resolve(strict=False)
        if _is_path_within(path, root_path):
            matches.append((root, root_path))
    return matches


def _is_valid_album_root(
    config: dict[str, object],
    album_root: Path,
    *,
    configured_roots: list[dict[str, object]] | None = None,
) -> bool:
    matching_roots = _matching_library_roots(
        config,
        album_root,
        configured_roots=configured_roots,
    )
    if len(matching_roots) != 1:
        return False
    root, root_path = matching_roots[0]
    try:
        relative_parts = album_root.relative_to(root_path).parts
    except Exception:
        return False
    if not relative_parts:
        return False
    return len(relative_parts) >= _minimum_album_folder_depth(root)


def _minimum_album_folder_depth(root: dict[str, object]) -> int:
    layout_mode = str(root.get("layout_mode") or "artist").strip()
    if layout_mode == "album-at-root":
        return 1
    if layout_mode == "genre/artist":
        return 3
    return 2


def validate_local_cover_source(config: dict[str, object], album_root: Path, source_path: str) -> Path:
    resolved_album_root = album_root.resolve(strict=False)
    if not any(_is_path_within(resolved_album_root, root) for root in iter_library_root_paths(config)):
        raise ValueError("Selected image is outside the configured library roots")
    candidate = Path(str(source_path or "").strip())
    resolved = candidate.resolve(strict=True)
    try:
        resolved.relative_to(resolved_album_root)
    except Exception as exc:
        raise ValueError("Selected image is outside the album folder") from exc
    if not resolved.is_file():
        raise FileNotFoundError("Selected image was not found")
    return resolved


def save_pasted_image_as_authoritative_cover(data_url: str, album_root: Path) -> Path:
    match = re.match(
        r"^data:(image/[a-z0-9.+-]+);base64,(.+)$",
        str(data_url or "").strip(),
        flags=re.IGNORECASE | re.DOTALL,
    )
    if not match:
        raise ValueError("Clipboard image format is invalid.")
    mime_type = str(match.group(1) or "").strip().casefold()
    encoded = re.sub(r"\s+", "", str(match.group(2) or ""))
    try:
        raw_bytes = base64.b64decode(encoded, validate=True)
    except Exception as exc:
        raise ValueError("Clipboard image data could not be decoded.") from exc
    target = album_root / "cover.jpg"
    if Image is None:
        if mime_type != "image/jpeg":
            raise ValueError("Clipboard image saving requires Pillow for non-JPEG images.")
        target.write_bytes(raw_bytes)
        return target
    try:
        with Image.open(io.BytesIO(raw_bytes)) as img:
            converted = img.convert("RGB")
            converted.save(target, format="JPEG", quality=95)
    except Exception as exc:
        raise ValueError("Clipboard image could not be processed.") from exc
    return target


def decode_image_bytes(raw_bytes: bytes) -> tuple[object, int, int] | None:
    if Image is None:
        return None
    try:
        img = Image.open(io.BytesIO(raw_bytes))
        img.load()
        width, height = img.size
        return img, int(width or 0), int(height or 0)
    except Exception:
        return None


def prepare_remote_cover_bytes_for_authoritative_write(raw_bytes: bytes) -> bytes | None:
    decoded = decode_image_bytes(raw_bytes)
    if decoded is None:
        return None
    img, _width, _height = decoded
    try:
        converted = img.convert("RGB")
        try:
            encoded = io.BytesIO()
            converted.save(encoded, format="JPEG", quality=95)
            return encoded.getvalue()
        finally:
            try:
                converted.close()
            except Exception:
                pass
    finally:
        try:
            img.close()
        except Exception:
            pass


def write_prepared_remote_cover_bytes(
    album_root: Path,
    prepared_bytes: bytes,
) -> Path | None:
    promotion = begin_prepared_remote_cover_promotion(album_root, prepared_bytes)
    if promotion is None:
        return None
    complete_local_image_promotion(promotion)
    return promotion.cover_path


def write_remote_cover_bytes_as_authoritative_cover(album_root: Path, raw_bytes: bytes) -> Path | None:
    prepared_bytes = prepare_remote_cover_bytes_for_authoritative_write(raw_bytes)
    if prepared_bytes is None:
        return None
    return write_prepared_remote_cover_bytes(album_root, prepared_bytes)


def download_remote_cover_to_folder(
    folder: Path,
    image_url: str,
    user_agent: str,
    *,
    fetch_remote_image_func: Callable[..., object] = fetch_remote_image,
    write_cover_func: Callable[[Path, bytes], Path | None] = write_remote_cover_bytes_as_authoritative_cover,
) -> tuple[Path | None, dict[str, object]]:
    # Private-media writeback boundary: this mutates the user's local album folder.
    detail: dict[str, object] = {
        "source": "manual-remote",
        "url": str(image_url or "").strip(),
        "folder": str(folder),
        "written_path": None,
        "reason": "",
    }
    normalized_url = str(image_url or "").strip()
    if not normalized_url:
        detail["reason"] = "missing_image_url"
        return None, detail
    download = fetch_remote_image_func(
        normalized_url,
        user_agent=user_agent,
        service="manual-remote",
        context=f"manual-cover-download:{folder.name}",
    )
    raw_bytes = getattr(download, "payload", None)
    if not raw_bytes:
        detail["reason"] = "candidate_download_failed"
        return None, detail
    written = write_cover_func(folder, raw_bytes)
    if not written:
        detail["reason"] = "write_returned_no_file"
        return None, detail
    detail["reason"] = "cover_written"
    detail["written_path"] = str(written)
    return written, detail


def promote_local_image_to_authoritative_cover(source_path: Path, album_root: Path) -> Path:
    promotion = begin_local_image_promotion(source_path, album_root)
    complete_local_image_promotion(promotion)
    return promotion.cover_path


def _atomic_replace_file_bytes(
    target: Path,
    raw_bytes: bytes,
    *,
    atime_ns: int | None = None,
    mtime_ns: int | None = None,
) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=target.parent,
            prefix=f".{target.name}.",
            suffix=".tmp",
            delete=False,
        ) as temp_file:
            temp_path = Path(temp_file.name)
            temp_file.write(raw_bytes)
            temp_file.flush()
            os.fsync(temp_file.fileno())
        if atime_ns is not None and mtime_ns is not None:
            os.utime(temp_path, ns=(atime_ns, mtime_ns))
        os.replace(temp_path, target)
        temp_path = None
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def begin_local_image_promotion(
    source_path: Path,
    album_root: Path,
    *,
    serialize_selection: bool = False,
) -> LocalCoverPromotion:
    lock_key, selection_lock = (
        _acquire_local_cover_selection_lock(album_root)
        if serialize_selection
        else ("", None)
    )
    try:
        resolved_source = source_path.resolve(strict=True)
        target = album_root / "cover.jpg"
        prior_cover_existed = target.is_file()
        prior_cover_stat = target.stat() if prior_cover_existed else None
        prior_cover_bytes = target.read_bytes() if prior_cover_existed else None
        if resolved_source == target.resolve(strict=False):
            raw_bytes = target.read_bytes()
            return LocalCoverPromotion(
                cover_path=target,
                prior_cover_existed=prior_cover_existed,
                prior_cover_bytes=prior_cover_bytes,
                reserve_artifact=None,
                promoted_cover_revision=hashlib.sha256(raw_bytes).hexdigest(),
                selection_lock_key=lock_key,
                selection_lock=selection_lock,
                prior_cover_atime_ns=(
                    prior_cover_stat.st_atime_ns
                    if prior_cover_stat is not None
                    else None
                ),
                prior_cover_mtime_ns=(
                    prior_cover_stat.st_mtime_ns
                    if prior_cover_stat is not None
                    else None
                ),
            )
        raw_bytes = resolved_source.read_bytes()
        promotion = LocalCoverPromotion(
            cover_path=target,
            prior_cover_existed=prior_cover_existed,
            prior_cover_bytes=prior_cover_bytes,
            reserve_artifact=None,
            promoted_cover_revision=hashlib.sha256(raw_bytes).hexdigest(),
            selection_lock_key=lock_key,
            selection_lock=selection_lock,
            prior_cover_atime_ns=(
                prior_cover_stat.st_atime_ns
                if prior_cover_stat is not None
                else None
            ),
            prior_cover_mtime_ns=(
                prior_cover_stat.st_mtime_ns
                if prior_cover_stat is not None
                else None
            ),
        )
        _atomic_replace_file_bytes(target, raw_bytes)
    except Exception:
        if "promotion" in locals():
            if promotion.prior_cover_existed:
                current_bytes = (
                    promotion.cover_path.read_bytes()
                    if promotion.cover_path.is_file()
                    else None
                )
                if current_bytes != (promotion.prior_cover_bytes or b""):
                    _atomic_replace_file_bytes(
                        promotion.cover_path,
                        promotion.prior_cover_bytes or b"",
                        atime_ns=promotion.prior_cover_atime_ns,
                        mtime_ns=promotion.prior_cover_mtime_ns,
                    )
            else:
                promotion.cover_path.unlink(missing_ok=True)
            if promotion.reserve_artifact is not None:
                promotion.reserve_artifact.unlink(missing_ok=True)
            complete_local_image_promotion(promotion)
        else:
            if selection_lock is not None:
                _release_local_cover_selection_lock(lock_key, selection_lock)
        raise
    return promotion


def begin_prepared_remote_cover_promotion(
    album_root: Path,
    prepared_bytes: bytes,
    *,
    serialize_selection: bool = False,
) -> LocalCoverPromotion | None:
    decoded = decode_image_bytes(prepared_bytes)
    if decoded is None:
        return None
    prepared_image, _width, _height = decoded
    try:
        prepared_image.close()
    except Exception:
        pass

    lock_key, selection_lock = (
        _acquire_local_cover_selection_lock(album_root)
        if serialize_selection
        else ("", None)
    )
    target = album_root / "cover.jpg"
    promotion: LocalCoverPromotion | None = None
    try:
        prior_cover_existed = target.is_file()
        prior_cover_stat = target.stat() if prior_cover_existed else None
        prior_cover_bytes = target.read_bytes() if prior_cover_existed else None
        promotion = LocalCoverPromotion(
            cover_path=target,
            prior_cover_existed=prior_cover_existed,
            prior_cover_bytes=prior_cover_bytes,
            reserve_artifact=None,
            promoted_cover_revision=hashlib.sha256(prepared_bytes).hexdigest(),
            selection_lock_key=lock_key,
            selection_lock=selection_lock,
            prior_cover_atime_ns=(
                prior_cover_stat.st_atime_ns
                if prior_cover_stat is not None
                else None
            ),
            prior_cover_mtime_ns=(
                prior_cover_stat.st_mtime_ns
                if prior_cover_stat is not None
                else None
            ),
        )
        promotion.reserve_artifact = reserve_existing_cover_variant(
            album_root,
            prepared_bytes,
        )
        _atomic_replace_file_bytes(target, prepared_bytes)
    except Exception:
        if promotion is not None:
            rollback_local_image_promotion(promotion)
        elif selection_lock is not None:
            _release_local_cover_selection_lock(lock_key, selection_lock)
        raise
    return promotion


def begin_remote_cover_promotion(
    album_root: Path,
    raw_bytes: bytes,
    *,
    serialize_selection: bool = False,
) -> LocalCoverPromotion | None:
    prepared_bytes = prepare_remote_cover_bytes_for_authoritative_write(raw_bytes)
    if prepared_bytes is None:
        return None
    return begin_prepared_remote_cover_promotion(
        album_root,
        prepared_bytes,
        serialize_selection=serialize_selection,
    )


def begin_external_cover_write_promotion(
    album_root: Path,
    *,
    serialize_selection: bool = True,
) -> LocalCoverPromotion:
    lock_key, selection_lock = (
        _acquire_local_cover_selection_lock(album_root)
        if serialize_selection
        else ("", None)
    )
    target = album_root / "cover.jpg"
    try:
        prior_cover_existed = target.is_file()
        prior_cover_stat = target.stat() if prior_cover_existed else None
        return LocalCoverPromotion(
            cover_path=target,
            prior_cover_existed=prior_cover_existed,
            prior_cover_bytes=(target.read_bytes() if prior_cover_existed else None),
            reserve_artifact=None,
            selection_lock_key=lock_key,
            selection_lock=selection_lock,
            prior_cover_atime_ns=(
                prior_cover_stat.st_atime_ns
                if prior_cover_stat is not None
                else None
            ),
            prior_cover_mtime_ns=(
                prior_cover_stat.st_mtime_ns
                if prior_cover_stat is not None
                else None
            ),
            prior_reserve_artifacts=frozenset(
                album_root.glob("cover-existing-*.jpg")
            ),
        )
    except Exception:
        if selection_lock is not None:
            _release_local_cover_selection_lock(lock_key, selection_lock)
        raise


def record_external_cover_write(promotion: LocalCoverPromotion) -> None:
    if promotion.cover_path.is_file():
        promotion.promoted_cover_revision = cover_revision_for_path(
            promotion.cover_path
        )
    new_reserve_artifacts = (
        set(promotion.cover_path.parent.glob("cover-existing-*.jpg"))
        - set(promotion.prior_reserve_artifacts)
    )
    promotion.reserve_artifacts = frozenset(new_reserve_artifacts)
    promotion.reserve_artifact = (
        next(iter(new_reserve_artifacts))
        if len(new_reserve_artifacts) == 1
        else None
    )
    if len(new_reserve_artifacts) > 1:
        raise RuntimeError("Remote cover write created multiple reserve artifacts")


def rollback_local_image_promotion(promotion: LocalCoverPromotion) -> None:
    try:
        current_revision = (
            cover_revision_for_path(promotion.cover_path)
            if promotion.cover_path.is_file()
            else None
        )
        if current_revision == promotion.promoted_cover_revision:
            if promotion.prior_cover_existed:
                if (
                    not promotion.cover_path.is_file()
                    or promotion.cover_path.read_bytes() != (promotion.prior_cover_bytes or b"")
                ):
                    _atomic_replace_file_bytes(
                        promotion.cover_path,
                        promotion.prior_cover_bytes or b"",
                        atime_ns=promotion.prior_cover_atime_ns,
                        mtime_ns=promotion.prior_cover_mtime_ns,
                    )
            else:
                promotion.cover_path.unlink(missing_ok=True)
        reserve_artifacts = set(promotion.reserve_artifacts)
        if promotion.reserve_artifact is not None:
            reserve_artifacts.add(promotion.reserve_artifact)
        for reserve_artifact in reserve_artifacts:
            reserve_artifact.unlink(missing_ok=True)
    finally:
        complete_local_image_promotion(promotion)


def complete_local_image_promotion(promotion: LocalCoverPromotion) -> None:
    selection_lock = promotion.selection_lock
    if selection_lock is None:
        return
    promotion.selection_lock = None
    _release_local_cover_selection_lock(
        promotion.selection_lock_key,
        selection_lock,
    )


def _acquire_local_cover_selection_lock(album_root: Path) -> tuple[str, Lock]:
    lock_key = str(album_root.resolve(strict=False)).casefold()
    with _LOCAL_COVER_SELECTION_LOCKS_GUARD:
        selection_lock, reference_count = _LOCAL_COVER_SELECTION_LOCKS.get(
            lock_key,
            (Lock(), 0),
        )
        _LOCAL_COVER_SELECTION_LOCKS[lock_key] = (
            selection_lock,
            reference_count + 1,
        )
    selection_lock.acquire()
    return lock_key, selection_lock


def _release_local_cover_selection_lock(lock_key: str, selection_lock: Lock) -> None:
    selection_lock.release()
    with _LOCAL_COVER_SELECTION_LOCKS_GUARD:
        registered_lock, reference_count = _LOCAL_COVER_SELECTION_LOCKS.get(
            lock_key,
            (selection_lock, 1),
        )
        if registered_lock is selection_lock and reference_count <= 1:
            _LOCAL_COVER_SELECTION_LOCKS.pop(lock_key, None)
        elif registered_lock is selection_lock:
            _LOCAL_COVER_SELECTION_LOCKS[lock_key] = (
                registered_lock,
                reference_count - 1,
            )


def run_serialized_cover_selection(album_root: Path, action: Callable[[], object]) -> object:
    """Run a short cover write/persist/apply transaction under the album lock."""
    lock_key, selection_lock = _acquire_local_cover_selection_lock(album_root)
    try:
        return action()
    finally:
        _release_local_cover_selection_lock(lock_key, selection_lock)


def cover_revision_for_path(cover_path: Path) -> str:
    """Return the stable revision of the exact bytes served as the local cover."""
    return hashlib.sha256(cover_path.read_bytes()).hexdigest()


def choose_best_remaining_local_cover(
    album_root: Path,
    *,
    image_extensions: set[str],
    image_dimensions,
    is_squareish_cover,
    score_image,
) -> Path | None:
    candidates = [
        path for path in album_root.rglob("*") if path.is_file() and path.suffix.lower() in image_extensions
    ]
    if not candidates:
        return None
    return min(
        candidates,
        key=lambda path: (
            not is_squareish_cover(*image_dimensions(path)),
            *score_image(path),
        ),
    )


def delete_local_cover_and_choose_next(
    *,
    album_root: Path,
    source_path: Path,
    active_cover_path: Path | None,
    image_extensions: set[str],
    image_dimensions,
    is_squareish_cover,
    score_image,
) -> Path | None:
    source_path.unlink()
    if not active_cover_path or source_path != active_cover_path:
        return active_cover_path
    next_source = choose_best_remaining_local_cover(
        album_root,
        image_extensions=image_extensions,
        image_dimensions=image_dimensions,
        is_squareish_cover=is_squareish_cover,
        score_image=score_image,
    )
    return next_source if next_source and next_source.exists() else None
