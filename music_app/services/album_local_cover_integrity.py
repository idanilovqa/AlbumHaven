"""Select artwork only from the album's accepted physical sources."""
from __future__ import annotations

from pathlib import Path
from collections.abc import Mapping

from music_app.services.album_local_membership import physical_album_root
from music_app.services.covers import image_dimensions, score_image
from music_app.services.cover_refresh_policy import automatic_cover_repair_minimum_edge

_IMAGE_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".webp"})


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
    # Unknown legacy selections remain protected unless their invalid source is proven.
    if album.cover_selection_origin == "user" and not inherited and active and all(
        edge >= automatic_cover_repair_minimum_edge() for edge in image_dimensions(active)
    ):
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
