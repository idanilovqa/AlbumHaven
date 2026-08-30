from __future__ import annotations

"""Phase 3 owner for server-shaped gallery playback context.

Selected-artist and Album Top read seams reuse this module for visible-order,
playability, and end-behavior hints instead of rebuilding that context in the
browser.
"""

_DEFAULT_END_BEHAVIOR_BY_KIND = {
    "album_top": "continue",
    "artist_page": "stop",
}


def _album_value(album: object, field: str, default=None):
    if isinstance(album, dict):
        return album.get(field, default)
    return getattr(album, field, default)


def _track_path(track: object) -> str:
    if isinstance(track, dict):
        return str(track.get("path") or "").strip()
    return str(getattr(track, "path", "") or "").strip()


def album_can_play_in_gallery_context(album: object) -> bool:
    explicit_can_play = _album_value(album, "can_play", None)
    if explicit_can_play is not None:
        return bool(explicit_can_play)

    open_directory_paths = _album_value(album, "open_directory_paths", None)
    if isinstance(open_directory_paths, list) and any(str(path or "").strip() for path in open_directory_paths):
        return True

    tracks = _album_value(album, "tracks", None)
    if isinstance(tracks, list):
        return any(_track_path(track) for track in tracks)

    return False


def gallery_has_playable_albums(albums: list[object]) -> bool:
    return any(album_can_play_in_gallery_context(album) for album in (albums or []))


def build_gallery_playback_context(
    *,
    kind: str,
    ordered_albums: list[object],
    end_behavior: str | None = None,
) -> dict[str, object]:
    normalized_kind = str(kind or "").strip()
    if normalized_kind not in _DEFAULT_END_BEHAVIOR_BY_KIND:
        raise ValueError(f"Unsupported gallery playback context kind: {normalized_kind!r}")

    resolved_end_behavior = str(
        end_behavior or _DEFAULT_END_BEHAVIOR_BY_KIND[normalized_kind]
    ).strip()
    if resolved_end_behavior not in {"continue", "stop"}:
        raise ValueError(f"Unsupported gallery playback end behavior: {resolved_end_behavior!r}")

    ordered_album_refs: list[str] = []
    albums_payload: list[dict[str, object]] = []
    seen_refs: set[str] = set()
    for album in ordered_albums or []:
        album_ref = str(_album_value(album, "key", "") or "").strip()
        if not album_ref or album_ref in seen_refs:
            continue
        seen_refs.add(album_ref)
        ordered_album_refs.append(album_ref)
        albums_payload.append({
            "album_ref": album_ref,
            "can_play": album_can_play_in_gallery_context(album),
        })

    return {
        "kind": normalized_kind,
        "end_behavior": resolved_end_behavior,
        "ordered_album_refs": ordered_album_refs,
        "albums": albums_payload,
    }
