from __future__ import annotations

from dataclasses import dataclass
import errno
import hashlib
import stat
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Callable, Iterable, Mapping


_MANAGED_MARKERS = (
    (".album-haven", "cover_variants"),
    (".album-haven", "v1", "cover_variants"),
    ("display-cover-cache", "cover_variants"),
)
_GENERATED_COVER_PREVIEW_STEM = "album-haven-preview"
_APP_ARTIFACT_DIRECTORY = ".album-haven"


def remove_empty_album_preview_directories(
    directory: Path, *, emptied_directory: Path | None = None,
) -> None:
    """Prune empty generated directories without touching album or user files."""
    if directory.name != _APP_ARTIFACT_DIRECTORY:
        return
    try:
        if emptied_directory is not None:
            emptied_directory.relative_to(directory)
            ancestors = [emptied_directory]
            while ancestors[-1] != directory:
                ancestors.append(ancestors[-1].parent)
            # Check from the cache root before traversing any intermediate junction.
            for parent in reversed(ancestors):
                info = parent.lstat()
                if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                    return
            for parent in ancestors:
                parent.rmdir()
            return
        _remove_empty_preview_subtree(directory)
    except FileNotFoundError:
        pass
    except OSError as exc:
        if exc.errno not in (errno.ENOTEMPTY, errno.EEXIST):
            raise


def remove_album_folder_previews(directory: Path) -> None:
    """Delete an album folder's unreachable generated preview cache.

    Used once previews live in a separate location: the album-folder cache is a
    regenerable app artifact, so its managed subtrees are removed and the then
    empty ``.album-haven`` directory is pruned. Unknown files are kept.
    """
    if directory.name != _APP_ARTIFACT_DIRECTORY or _is_link_or_junction(directory):
        return
    for managed in (directory / "cover_variants", directory / "v1" / "cover_variants"):
        if not managed.is_dir() or any(
            _is_link_or_junction(parent) for parent in (managed, managed.parent)
        ):
            continue
        _remove_regular_preview_tree(managed)
    remove_empty_album_preview_directories(directory)


def _is_link_or_junction(path: Path) -> bool:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
    )


def _remove_regular_preview_tree(directory: Path) -> None:
    # Never follow a link or junction out of the generated cache.
    for child in directory.iterdir():
        if _is_link_or_junction(child):
            continue
        if child.is_dir():
            _remove_regular_preview_tree(child)
        else:
            child.unlink(missing_ok=True)
    try:
        directory.rmdir()
    except OSError as exc:
        if exc.errno not in (errno.ENOTEMPTY, errno.EEXIST, errno.ENOENT):
            raise


def _remove_empty_preview_subtree(directory: Path) -> None:
    # Windows junctions must not turn cache cleanup into traversal outside the cache.
    info = directory.lstat()
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
        return
    for child in directory.iterdir():
        if child.is_dir():
            _remove_empty_preview_subtree(child)
    try:
        directory.rmdir()
    except OSError as exc:
        if exc.errno not in (errno.ENOTEMPTY, errno.EEXIST, errno.ENOENT):
            raise


def is_generated_cover_artifact(path: Path, album_root: Path) -> bool:
    stem = path.stem.casefold()
    relative_parts = path.relative_to(album_root).parts
    return (
        _APP_ARTIFACT_DIRECTORY in (part.casefold() for part in relative_parts)
        or stem == _GENERATED_COVER_PREVIEW_STEM
        or stem.startswith(f"{_GENERATED_COVER_PREVIEW_STEM}-")
    )


@dataclass(frozen=True)
class PreviewStorageSnapshot:
    mode: str = "album_folders"
    active_root: Path | str | None = None
    requested_mode: str | None = None
    requested_root: Path | str | None = None
    operation_state: str = "idle"


class PreviewStoragePolicy:
    def __init__(self, snapshot: PreviewStorageSnapshot) -> None:
        self.snapshot = snapshot

    def write_cache_root(self, source_path: Path) -> Path:
        use_requested = (
            self.snapshot.requested_mode is not None
            and self.snapshot.operation_state != "canceled"
        )
        mode = self.snapshot.requested_mode if use_requested else self.snapshot.mode
        root = (
            self.snapshot.requested_root
            if use_requested
            else self.snapshot.active_root
        )
        return _cache_root(source_path, mode=mode, root=root)

    def read_cache_roots(self, source_path: Path) -> tuple[Path, ...]:
        roots = []
        if self.snapshot.requested_mode:
            roots.append(
                _cache_root(
                    source_path,
                    mode=self.snapshot.requested_mode,
                    root=self.snapshot.requested_root,
                )
            )
        roots.append(
            _cache_root(
                source_path,
                mode=self.snapshot.mode,
                root=self.snapshot.active_root,
            )
        )
        return tuple(dict.fromkeys(roots))

    def is_managed_preview_path(self, path: Path | str) -> bool:
        candidate = Path(path).resolve(strict=False)
        if is_managed_preview_path(candidate):
            return True
        for root in (self.snapshot.active_root, self.snapshot.requested_root):
            if root is not None and _is_relative_to(
                candidate,
                Path(root).resolve(strict=False) / "v1" / "cover_variants",
            ):
                return True
        return False


def preview_storage_policy_from_mapping(
    state: Mapping[str, object] | None,
) -> PreviewStoragePolicy:
    state = state or {}
    return PreviewStoragePolicy(
        PreviewStorageSnapshot(
            mode=str(state.get("mode") or "album_folders"),
            active_root=state.get("active_root"),
            requested_mode=(
                str(state["requested_mode"])
                if state.get("requested_mode")
                else None
            ),
            requested_root=state.get("requested_root"),
            operation_state=str(state.get("operation_state") or "idle"),
        )
    )


def managed_preview_relative_path(preview_path: Path | str) -> Path | None:
    parts = Path(preview_path).parts
    normalized = tuple(part.casefold() for part in parts)
    for index, part in enumerate(normalized):
        if part != "cover_variants" or len(parts) - index < 3:
            continue
        prefix = normalized[max(0, index - 2) : index]
        if any(marker in prefix for marker in (".album-haven", "v1", "display-cover-cache")):
            return Path("v1", *parts[index:])
    return None


def record_generated_preview(repository, source_path: Path, preview_path: Path) -> None:
    relative_path = managed_preview_relative_path(preview_path)
    if relative_path is None or not preview_path.is_file():
        return
    digest = hashlib.sha256()
    byte_count = 0
    with preview_path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
            byte_count += len(chunk)
    repository.record_inventory(
        current_path=str(preview_path),
        album_preview_path=str(
            source_path.parent / ".album-haven" / Path(*relative_path.parts[1:])
        ),
        managed_relative_path=relative_path.as_posix(),
        byte_count=byte_count,
        sha256=digest.hexdigest(),
    )


def is_managed_preview_path(path: Path | str) -> bool:
    parts = tuple(part.casefold() for part in Path(path).parts)
    return any(
        parts[index : index + len(marker)] == marker
        for marker in _MANAGED_MARKERS
        for index in range(len(parts) - len(marker) + 1)
    )


def validate_custom_root(
    root: Path | str,
    library_roots: Iterable[Path | str],
    *,
    probe: Callable[[Path], bool] | None = None,
) -> Path:
    candidate = Path(root)
    if not candidate.is_absolute():
        raise ValueError("Preview storage path must be absolute on the server.")
    resolved = candidate.resolve(strict=False)
    for library_root in library_roots:
        library = Path(library_root).resolve(strict=False)
        if _is_relative_to(resolved, library) or _is_relative_to(library, resolved):
            raise ValueError("Preview storage path may not overlap a music root.")
    if not (probe or _probe_writable)(resolved):
        raise ValueError("Preview storage path must be accessible and writable.")
    return resolved


def _cache_root(source_path: Path, *, mode: str, root: Path | str | None) -> Path:
    if mode == "custom":
        if root is None:
            raise ValueError("Custom preview storage has no configured root.")
        return Path(root) / "v1"
    return Path(source_path).parent / ".album-haven"


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _probe_writable(path: Path) -> bool:
    try:
        path.mkdir(parents=True, exist_ok=True)
        with NamedTemporaryFile(prefix=".album-haven-write-probe-", dir=path, delete=True):
            pass
        return True
    except OSError:
        return False
