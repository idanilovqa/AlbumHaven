"""Applied MusicBrainz data corrections, shown in place of tag values (Delivery 2, S4; owner
2026-11-16, "Data Correction flow", option A).

The one place an applied correction reaches a payload: album details and its track table get
``display_title`` and ``display_artist`` beside the unchanged tag fields, only where they
differ. Album keys, sorting, search and the tag editor keep the real tags.
"""
from __future__ import annotations

from collections.abc import MutableMapping
from typing import Any

from music_app.services.musicbrainz_corrections_postgres import album_display_rows

_TRACK_FIELDS = {"title": "display_title", "artist": "display_artist"}


def _number(value: object, default: int = 0) -> int:
    try:
        return int(value or default)
    except (TypeError, ValueError):
        return default


def apply_correction_display(connection: Any, album: MutableMapping[str, object], *, album_id: object) -> None:
    """Add the applied corrections of the album (by its row id) to its details payload."""
    if not album_id:
        return
    applied = album_display_rows(connection, album_id=album_id)
    if not applied:
        return
    album_fields = {"album": ("name", "display_title"), "album_artist": ("album_artist", "display_artist")}
    tracks = {}
    for track in album.get("tracks") or []:
        if isinstance(track, MutableMapping):
            tracks[(_number(track.get("disc_number"), 1), _number(track.get("track_number")))] = track
    for correction in applied:
        field, proposed = correction["field"], correction["proposed_value"]
        if field in album_fields:
            tag_field, display_field = album_fields[field]
            if album.get(tag_field) != proposed:
                album[display_field] = proposed
            continue
        track = tracks.get((_number(correction["disc_number"], 1), _number(correction["track_number"])))
        if track is not None and track.get(field) != proposed:
            track[_TRACK_FIELDS[field]] = proposed
