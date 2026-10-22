from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Callable, Iterable


_MANAGED_MARKERS = (
    (".album-haven", "cover_variants"),
    (".album-haven", "v1", "cover_variants"),
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
        mode = self.snapshot.requested_mode or self.snapshot.mode
        root = (
            self.snapshot.requested_root
            if self.snapshot.requested_mode
            else self.snapshot.active_root
        )
        return _cache_root(source_path, mode=mode, root=root)

    def read_cache_roots(self, source_path: Path) -> tuple[Path, ...]:
        roots = [self.write_cache_root(source_path)]
        if self.snapshot.requested_mode:
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


def managed_preview_relative_path(preview_path: Path | str) -> Path | None:
    parts = Path(preview_path).parts
    normalized = tuple(part.casefold() for part in parts)
    for index, part in enumerate(normalized):
        if part != "cover_variants" or len(parts) - index < 3:
            continue
        prefix = normalized[max(0, index - 2) : index]
        if ".album-haven" in prefix or "v1" in prefix:
            return Path("v1", *parts[index:])
    return None


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
