"""Strict query and positive immutable-snapshot projection, without authority."""
import hashlib
import json
import re
from uuid import UUID

from music_app.services.owned_album_tops import AlbumTopError
from music_app.services.public_album_metadata import MAX_METADATA_ROWS, MAX_METADATA_TEXT

_LIMIT = re.compile(r"[1-9][0-9]{0,2}\Z", re.ASCII)
_MAX_BIGINT = 2**63 - 1
MAX_PUBLIC_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_PUBLIC_PNG_BYTES = 327680
_DIGEST = re.compile(r"[0-9a-f]{64}\Z", re.ASCII)
_DECIMAL = re.compile(r"[1-9][0-9]{0,18}\Z", re.ASCII)
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


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
    if type(publication["contract_version"]) is not int or publication["contract_version"] not in (1, 2):
        raise AlbumTopError("unavailable", 404)
    result = {"share_ref": public_ref(share_ref), "publication_ref": snapshot_ref(publication["ref"]),
              "publication_revision": str(snapshot_integer(publication["publication_revision"]))}
    if publication["contract_version"] == 2:
        result["publication_contract_version"] = 2
    return result


def snapshot_item(row, *, share_ref, publication_contract_version=1):
    if type(row["contract_version"]) is not int or row["contract_version"] != 1:
        raise AlbumTopError("unavailable", 404)
    if type(publication_contract_version) is not int or publication_contract_version not in (1, 2):
        raise AlbumTopError("unavailable", 404)
    artwork_ref = None
    if publication_contract_version == 2:
        if type(row["included"]) is not bool or not row["included"] and row["asset_ref"] is not None:
            raise AlbumTopError("unavailable", 404)
        if row["included"]:
            artwork_ref = snapshot_ref(row["asset_ref"])
    item_ref = snapshot_ref(row["item_ref"])
    return {"item_ref": item_ref,
            "original_position": str(snapshot_integer(row["original_position"])),
            "curator_position": snapshot_integer(row["curator_position"], maximum=MAX_METADATA_ROWS),
            "album_ref": snapshot_ref(row["catalog_ref"]),
            "presentation_ref": snapshot_ref(row["presentation_ref"]),
            "title": snapshot_text(row["title"]), "artist": snapshot_text(row["artist"]),
            "year": None if row["year"] is None else snapshot_integer(row["year"], maximum=9999),
            "artwork_ref": artwork_ref,
            "details_path": f"/public/album-tops/{public_ref(share_ref)}/items/{item_ref}"}


def snapshot_track(row):
    return {"track_ref": snapshot_ref(row["ref"]),
            "position": snapshot_integer(row["position"], maximum=MAX_METADATA_ROWS),
            "title": snapshot_text(row["title"]), "artist": snapshot_text(row["artist"]),
            "duration_ms": None if row["duration_ms"] is None else
                snapshot_integer(row["duration_ms"], minimum=0, maximum=2**31 - 1)}


def public_artwork_path(*, share_ref, publication_ref, item_ref, asset_ref):
    """A path identifies immutable content; it conveys no access authority."""
    return (f"/public/album-tops/{public_ref(share_ref)}/publications/{public_ref(publication_ref)}"
            f"/items/{public_ref(item_ref)}/artwork/{public_ref(asset_ref)}.png")


def snapshot_png(asset, *, head_only):
    """Validate retained sanitized bytes without decoding or reading a file."""
    if type(head_only) is not bool or not isinstance(asset, dict):
        raise AlbumTopError("unavailable", 404)
    if (type(asset.get("sanitizer_contract")) is not int or asset["sanitizer_contract"] != 1
            or asset.get("mime_type") != "image/png"
            or type(asset.get("content_digest")) is not str
            or not _DIGEST.fullmatch(asset["content_digest"])):
        raise AlbumTopError("unavailable", 404)
    snapshot_ref(asset["ref"])
    snapshot_integer(asset["width"], maximum=256)
    snapshot_integer(asset["height"], maximum=256)
    length = snapshot_integer(asset["byte_length"], maximum=MAX_PUBLIC_PNG_BYTES)
    if snapshot_integer(asset["stored_length"], maximum=MAX_PUBLIC_PNG_BYTES) != length:
        raise AlbumTopError("unavailable", 404)
    body = b""
    if not head_only:
        body = asset.get("png")
        if (type(body) is not bytes or len(body) != length or not body.startswith(_PNG_SIGNATURE)
                or hashlib.sha256(body).hexdigest() != asset["content_digest"]):
            raise AlbumTopError("unavailable", 404)
    return {"content_type": "image/png", "content_length": length, "body": body}


def bound_snapshot_response(value):
    """Complete bounded DTO serialization before the last service policy fence."""
    body = json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("utf-8")
    if len(body) > MAX_PUBLIC_RESPONSE_BYTES:
        raise AlbumTopError("unavailable", 503)


def validate_snapshot_v2(value, *, share_ref, item_ref, limit):
    """Strict public DTO boundary before JSON/HTML rendering or image URLs."""
    def record(row, keys):
        if type(row) is not dict or set(row) != set(keys):
            raise AlbumTopError("unavailable", 503)

    def decimal(value):
        if (type(value) is not str or not _DECIMAL.fullmatch(value)
                or len(value) == 19 and value > str(_MAX_BIGINT)):
            raise AlbumTopError("unavailable", 503)

    def item(row):
        record(row, ("item_ref", "original_position", "curator_position", "album_ref", "presentation_ref",
                     "title", "artist", "year", "artwork_ref", "details_path"))
        for key in ("item_ref", "album_ref", "presentation_ref"):
            public_ref(row[key])
        decimal(row["original_position"])
        snapshot_integer(row["curator_position"], maximum=MAX_METADATA_ROWS)
        snapshot_text(row["title"])
        snapshot_text(row["artist"])
        if row["year"] is not None:
            snapshot_integer(row["year"], maximum=9999)
        if row["artwork_ref"] is not None:
            public_ref(row["artwork_ref"])
        if row["details_path"] != f"/public/album-tops/{share_ref}/items/{row['item_ref']}":
            raise AlbumTopError("unavailable", 503)

    common = ("share_ref", "publication_ref", "publication_revision", "publication_contract_version",
              "next_cursor", "allowed_actions")
    record(value, (*common, *(('item', 'tracks', 'track_count') if item_ref is not None
                             else ('title', 'description', 'items'))))
    if (type(value["publication_contract_version"]) is not int or value["publication_contract_version"] != 2
            or value["share_ref"] != public_ref(share_ref)):
        raise AlbumTopError("unavailable", 503)
    public_ref(value["publication_ref"])
    decimal(value["publication_revision"])
    record(value["allowed_actions"], ("can_read", "can_open_item"))
    if any(value["allowed_actions"][key] is not True for key in ("can_read", "can_open_item")):
        raise AlbumTopError("unavailable", 503)
    cursor = value["next_cursor"]
    if cursor is not None and (type(cursor) is not str or not 1 <= len(cursor) <= 4096):
        raise AlbumTopError("unavailable", 503)
    validate_public_page(kind="item" if item_ref is not None else "top", limit=limit)
    if item_ref is None:
        snapshot_text(value["title"], maximum=100)
        snapshot_text(value["description"], empty=True)
        rows, position, identity = value["items"], "curator_position", "item_ref"
    else:
        item(value["item"])
        if value["item"]["item_ref"] != public_ref(item_ref):
            raise AlbumTopError("unavailable", 503)
        snapshot_integer(value["track_count"], minimum=0, maximum=MAX_METADATA_ROWS)
        rows, position, identity = value["tracks"], "position", "track_ref"
    if type(rows) is not list or len(rows) > limit:
        raise AlbumTopError("unavailable", 503)
    previous, seen = None, set()
    for row in rows:
        if item_ref is None:
            item(row)
        else:
            record(row, ("track_ref", "position", "title", "artist", "duration_ms"))
            public_ref(row["track_ref"])
            snapshot_integer(row["position"], maximum=MAX_METADATA_ROWS)
            snapshot_text(row["title"])
            snapshot_text(row["artist"])
            if row["duration_ms"] is not None:
                snapshot_integer(row["duration_ms"], minimum=0, maximum=2**31 - 1)
            if row["position"] > value["track_count"]:
                raise AlbumTopError("unavailable", 503)
        if row[identity] in seen or previous is not None and row[position] != previous + 1:
            raise AlbumTopError("unavailable", 503)
        previous = row[position]
        seen.add(row[identity])
    if cursor is not None and (len(rows) != limit or item_ref is not None and previous >= value["track_count"]):
        raise AlbumTopError("unavailable", 503)
    bound_snapshot_response(value)
    return value
