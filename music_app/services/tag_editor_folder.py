from __future__ import annotations

import re
from collections.abc import Collection, Mapping
from pathlib import Path

from music_app.services.library_roots import configured_library_root_paths_snapshot
from music_app.services.metadata import read_editable_tag_values


_EDITABLE_PHYSICAL_FIELDS = {
    "album",
    "album_artist",
    "artist",
    "title",
    "genre",
    "year",
    "track_number",
    "disc_number",
    "edition",
    "album_rating",
}
_MAX_FOLDER_FILES = 500
_NATURAL_PART = re.compile(r"(\d+)")


def _natural_name_key(path: Path) -> tuple[object, ...]:
    return tuple(
        int(part) if part.isdigit() else part.casefold()
        for part in _NATURAL_PART.split(path.name)
    )


def _is_within_any_root(path: Path, roots: Collection[Path]) -> bool:
    return any(path.is_relative_to(root.resolve(strict=False)) for root in roots)


def load_tag_editor_folder_files(
    config: Mapping[str, object],
    source_path: str,
    *,
    indexed_paths: Collection[str],
) -> dict[str, object]:
    normalized_source = str(source_path or "").strip()
    indexed_keys = {str(Path(value).resolve(strict=False)).casefold() for value in indexed_paths}
    source = Path(normalized_source).resolve(strict=True)
    if not source.is_file() or str(source).casefold() not in indexed_keys:
        raise ValueError("The selected source file is not in this editor.")

    roots = configured_library_root_paths_snapshot(dict(config))
    if not roots or not _is_within_any_root(source, roots):
        raise ValueError("The selected source folder is outside the active library.")

    supported = {
        str(extension).casefold()
        for extension in config.get("SUPPORTED_EXTENSIONS", ())
        if str(extension).strip()
    }
    candidates = sorted(
        (
            candidate
            for candidate in (
                entry.resolve(strict=True)
                for entry in source.parent.iterdir()
                if entry.is_file() and entry.suffix.casefold() in supported
            )
            if candidate.parent == source.parent and _is_within_any_root(candidate, roots)
        ),
        key=_natural_name_key,
    )
    if len(candidates) > _MAX_FOLDER_FILES:
        raise ValueError("The selected folder contains too many audio files.")

    tracks: list[dict[str, object]] = []
    for candidate in candidates:
        try:
            values = read_editable_tag_values(candidate, set(_EDITABLE_PHYSICAL_FIELDS))
        except (OSError, RuntimeError, ValueError):
            continue
        tracks.append({"path": str(candidate), **values})

    return {"folder_path": str(source.parent), "tracks": tracks}
