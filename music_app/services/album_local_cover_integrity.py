"""Select artwork only from the album's accepted physical sources."""
from __future__ import annotations

from pathlib import Path
from collections.abc import Mapping

from music_app.services.album_local_membership import physical_album_folder, physical_album_root
from music_app.services.covers import image_dimensions, score_image
from music_app.services.cover_refresh_policy import automatic_cover_repair_minimum_edge

_IMAGE_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".webp"})
_LOCAL_COVER_FIELDS = (
    "cover_path", "cover_revision", "local_cover_width", "local_cover_height",
    "cover_validation_path", "cover_validation_mtime_ns", "cover_validation_size",
)


def inferred_local_cover_belongs_to_track(cover_path: object, track_path: object) -> bool:
    cover_value = str(cover_path or "").strip()
    track_value = str(track_path or "").strip()
    return bool(
        cover_value
        and track_value
        and Path(cover_value).is_relative_to(Path(physical_album_root(track_value)))
    )


def clear_ambiguous_folder_covers(
    file_cache: dict[str, dict[str, object]],
) -> dict[str, dict[str, object]]:
    """Drop inferred folder art when one physical folder contains multiple releases."""
    albums_by_folder: dict[str, set[str]] = {}
    folder_by_cache_path: dict[str, str] = {}
    roots_by_cover_path: dict[str, set[str]] = {}
    for cache_path, entry in file_cache.items():
        path = str(entry.get("path") or cache_path).strip()
        if not path:
            continue
        folder = physical_album_folder(path)
        folder_by_cache_path[cache_path] = folder
        albums_by_folder.setdefault(folder, set()).add(
            " ".join(str(entry.get("album") or "").casefold().split())
        )
        cover_path = str(entry.get("cover_path") or "").strip()
        if cover_path:
            roots_by_cover_path.setdefault(cover_path.casefold(), set()).add(
                physical_album_root(path)
            )

    ambiguous_folders = {
        folder for folder, albums in albums_by_folder.items() if len(albums) > 1
    }
    changed: dict[str, dict[str, object]] = {}
    for cache_path, entry in file_cache.items():
        path = str(entry.get("path") or cache_path).strip()
        cover_path = str(entry.get("cover_path") or "").strip()
        ambiguous_inferred_cover = (
            folder_by_cache_path.get(cache_path) in ambiguous_folders
            and physical_album_folder(cover_path) == folder_by_cache_path.get(cache_path)
        )
        foreign_inferred_cover = (
            str(entry.get("cover_selection_origin") or "").casefold() == "automatic"
            and len(roots_by_cover_path.get(cover_path.casefold(), set())) > 1
            and not inferred_local_cover_belongs_to_track(cover_path, path)
        )
        if (
            not path
            or not cover_path
            or not (ambiguous_inferred_cover or foreign_inferred_cover)
            or str(entry.get("cover_selection_origin") or "").casefold() == "user"
            or str(entry.get("cover_selection_provenance") or "").casefold() == "explicit"
            or bool(entry.get("remote_cover_url"))
        ):
            continue
        for field in _LOCAL_COVER_FIELDS:
            entry[field] = None
        if not entry.get("remote_cover_url"):
            entry["cover_selection_origin"] = None
            entry["cover_selection_provenance"] = None
        changed[cache_path] = dict(entry)
    return changed


def apply_scoped_local_cover(album, file_cache: Mapping[str, Mapping[str, object]], rejected_paths) -> None:
    if getattr(album, "remote_cover_url", None) or getattr(album, "cover_selection_provenance", None) == "explicit":
        return
    roots = {Path(physical_album_root(track.path)) for track in album.tracks}
    if not roots:
        return
    active = Path(album.cover_path) if album.cover_path else None
    inherited = False
    if active and not any(active.is_relative_to(root) for root in roots):
        inherited = any(
            str(entry.get("cover_path") or "") == str(active)
            and active.is_relative_to(Path(physical_album_root(path)))
            for path, entry in file_cache.items() if path in rejected_paths
        )
    # Inventory reconstruction repairs proven source contamination only.
    # Cover discovery and quality upgrades belong to the cover workflow.
    if not inherited:
        return
    folders = roots | {Path(track.path).parent for track in album.tracks}
    candidates = set()
    for folder in folders:
        try:
            candidates.update(path for path in folder.iterdir() if path.is_file() and path.suffix.lower() in _IMAGE_EXTENSIONS)
        except OSError:
            continue
    candidates = {
        path for path in candidates
        if any(path.resolve().is_relative_to(root.resolve()) for root in roots)
        and all(edge > 0 for edge in image_dimensions(path))
    }
    if not candidates and not inherited:
        return
    chosen = min(candidates, key=lambda path: (
        not all(edge >= automatic_cover_repair_minimum_edge() for edge in image_dimensions(path)),
        *score_image(path), str(path).casefold(),
    )) if candidates else None
    if chosen == active:
        return
    if active and not inherited and (chosen is None or any(
        edge < automatic_cover_repair_minimum_edge() for edge in image_dimensions(chosen)
    )):
        return
    if inherited or album.cover_selection_origin == "user":
        album.cover_selection_repair_previous = {
            "cover_path": str(active),
            "cover_selection_origin": album.cover_selection_origin,
            "cover_revision": album.cover_revision,
        }
    album.cover_path = chosen
    album.cover_selection_origin = "automatic"
    album.cover_revision = None
    dimensions = image_dimensions(chosen) if chosen else (None, None)
    album.local_cover_width, album.local_cover_height = dimensions
    for track in album.tracks:
        track.cover_path = chosen
        track.cover_revision = None
        track.local_cover_width, track.local_cover_height = dimensions
