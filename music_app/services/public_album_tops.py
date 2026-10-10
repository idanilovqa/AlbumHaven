"""Strict query and positive immutable-snapshot projection, without authority."""
import re
from uuid import UUID

from music_app.services.owned_album_tops import AlbumTopError
from music_app.services.public_album_metadata import MAX_METADATA_ROWS, MAX_METADATA_TEXT

_LIMIT = re.compile(r"[1-9][0-9]{0,2}\Z", re.ASCII)
_MAX_BIGINT = 2**63 - 1


def validate_public_page(*, kind, cursor=None, limit=None):
    """Validate the typed service boundary independently of the raw HTTP query."""
    if type(kind) is not str or kind not in {"top", "item"}:
        raise AlbumTopError("invalid_query", 400)
    default, maximum = (50, 100) if kind == "top" else (100, 250)
    if limit is None:
        limit = default
    if (type(limit) is not int or not 1 <= limit <= maximum
            or cursor is not None and (type(cursor) is not str or not 1 <= len(cursor) <= 4096)):
        raise AlbumTopError("invalid_query", 400)
    return {"cursor": cursor, "limit": limit}


def normalize_public_top_query(query_pairs, *, kind):
    """Preserve duplicate keys until validation; never coerce a wire scalar."""
    if type(query_pairs) not in {list, tuple} or len(query_pairs) > 2:
        raise AlbumTopError("invalid_query", 400)
    values = {}
    for pair in query_pairs:
        if (type(pair) not in {list, tuple} or len(pair) != 2
                or type(pair[0]) is not str or pair[0] not in {"cursor", "limit"}
                or pair[0] in values or type(pair[1]) is not str):
            raise AlbumTopError("invalid_query", 400)
        values[pair[0]] = pair[1]
    if "limit" in values:
        if not _LIMIT.fullmatch(values["limit"]):
            raise AlbumTopError("invalid_query", 400)
        values["limit"] = int(values["limit"])
    return validate_public_page(kind=kind, **values)


def public_ref(value):
    """Canonical route identity; malformed targets share the unavailable result."""
    if type(value) is not str or len(value) != 36:
        raise AlbumTopError("unavailable", 404)
    try:
        if str(UUID(value)) != value:
            raise ValueError
    except ValueError:
        raise AlbumTopError("unavailable", 404) from None
    return value


def snapshot_ref(value):
    return public_ref(str(value) if type(value) is UUID else value)


def snapshot_integer(value, *, minimum=1, maximum=_MAX_BIGINT):
    if type(value) is not int or not minimum <= value <= maximum:
        raise AlbumTopError("unavailable", 404)
    return value


def snapshot_text(value, *, maximum=MAX_METADATA_TEXT, empty=False):
    if (type(value) is not str or len(value) > maximum or not empty and not value.strip()
            or any(ord(character) < 32 or ord(character) == 127 for character in value)):
        raise AlbumTopError("unavailable", 404)
    try:
        value.encode("utf-8", errors="strict")
    except UnicodeError:
        raise AlbumTopError("unavailable", 404) from None
    return value


def snapshot_header(publication, share_ref):
    if type(publication["contract_version"]) is not int or publication["contract_version"] != 1:
        raise AlbumTopError("unavailable", 404)
    return {"share_ref": public_ref(share_ref), "publication_ref": snapshot_ref(publication["ref"]),
            "publication_revision": str(snapshot_integer(publication["publication_revision"]))}


def snapshot_item(row, *, share_ref):
    if type(row["contract_version"]) is not int or row["contract_version"] != 1:
        raise AlbumTopError("unavailable", 404)
    item_ref = snapshot_ref(row["item_ref"])
    return {"item_ref": item_ref,
            "original_position": str(snapshot_integer(row["original_position"])),
            "curator_position": snapshot_integer(row["curator_position"], maximum=MAX_METADATA_ROWS),
            "album_ref": snapshot_ref(row["catalog_ref"]),
            "presentation_ref": snapshot_ref(row["presentation_ref"]),
            "title": snapshot_text(row["title"]), "artist": snapshot_text(row["artist"]),
            "year": None if row["year"] is None else snapshot_integer(row["year"], maximum=9999),
            "artwork_ref": None,
            "details_path": f"/public/album-tops/{public_ref(share_ref)}/items/{item_ref}"}


def snapshot_track(row):
    return {"track_ref": snapshot_ref(row["ref"]),
            "position": snapshot_integer(row["position"], maximum=MAX_METADATA_ROWS),
            "title": snapshot_text(row["title"]), "artist": snapshot_text(row["artist"]),
            "duration_ms": None if row["duration_ms"] is None else
                snapshot_integer(row["duration_ms"], minimum=0, maximum=2**31 - 1)}
