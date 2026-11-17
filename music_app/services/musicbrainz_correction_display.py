"""Applied MusicBrainz data corrections, shown in place of tag values (Delivery 2, S4; owner
2026-11-16, "Data Correction flow", option A).

Where an applied correction reaches a payload: album details and its track table, and gallery
cards, get ``display_title`` and ``display_artist`` beside the unchanged tag fields, only where
they differ. Album keys, sorting and the tag editor keep the real tags; search matches both
(the corrected values are stored and indexed beside the tags, 0198).
"""
from __future__ import annotations

from collections.abc import Mapping, MutableMapping
from typing import Any

from music_app.services.musicbrainz_corrections_postgres import album_display_rows
from music_app.services.musicbrainz_enrichment_postgres import _connect, _row_mapping

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


_PAYLOAD_SQL = """
    select albums.album_key, albums.corrected_title, albums.corrected_album_artist
    from library.local_albums albums
    where albums.album_key = any(%(album_keys)s::text[])
      and (albums.corrected_title is not null or albums.corrected_album_artist is not null);
"""


def project_correction_display(config: Mapping[str, object], payload: object, *, connect=None) -> object:
    """Gallery cards: each album in a view payload gets ``display_title`` and ``display_artist``
    from its stored corrected values, only when they differ from the tag (album keys, sorting
    and the tag fields are unchanged). One indexed read per response; a failure changes nothing."""
    albums: list[MutableMapping[str, object]] = []

    def visit(value: object) -> None:
        if isinstance(value, MutableMapping):
            if value.get("key") and "name" in value and "album_artist" in value:
                albums.append(value)
            for nested in tuple(value.values()):
                visit(nested)
        elif isinstance(value, list):
            for nested in value:
                visit(nested)

    visit(payload)
    database_url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
    if not albums or not database_url:
        return payload
    try:
        with (connect or _connect)(database_url) as connection:
            rows = {str(row["album_key"]): row for row in map(_row_mapping, connection.execute(
                _PAYLOAD_SQL, {"album_keys": sorted({str(album["key"]) for album in albums})}).fetchall())}
    except Exception:
        return payload
    for album in albums:
        row = rows.get(str(album["key"]))
        if not row:
            continue
        if row.get("corrected_title") and row["corrected_title"] != album.get("name"):
            album["display_title"] = row["corrected_title"]
        if row.get("corrected_album_artist") and row["corrected_album_artist"] != album.get("album_artist"):
            album["display_artist"] = row["corrected_album_artist"]
    return payload
