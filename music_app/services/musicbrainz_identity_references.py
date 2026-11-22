"""Reads the identifiers typed or pasted into MusicBrainz Info. No lookup and no storage."""
from __future__ import annotations

import re
import urllib.parse

from music_app.services.cover_provider_discogs import parse_discogs_release_id
from music_app.services.musicbrainz_client import _valid_mbid

_MAX_INPUT = 2048
_INVALID = {"status": "invalid"}
_MUSICBRAINZ_PATH = re.compile(r"^/([a-z-]+)/([^/]+)(?:/.*)?$")
_DISCOGS_ID = re.compile(r"r?(\d{1,12})|\[r(\d{1,12})\]", re.ASCII)
_DISCOGS_LOCALE = re.compile(r"^/[a-z]{2}(?:_[A-Z]{2})?(?=/)")
_DISCOGS_OTHER_PAGE = re.compile(r"^/(artist|master|label)/\d+(?:[-/].*)?$", re.ASCII)


def _input(value: object) -> str:
    text = value.strip() if isinstance(value, str) else ""
    return text if len(text) <= _MAX_INPUT else ""


def _site_path(text: str, site: str) -> str | None:
    """The path of a link to ``site`` or one of its subdomains; the scheme may be omitted."""
    try:
        parts = urllib.parse.urlsplit(text if "://" in text else f"https://{text}")
    except ValueError:
        return None
    host = parts.hostname or ""
    if parts.scheme not in {"http", "https"} or parts.username is not None:
        return None
    return parts.path if host == site or host.endswith(f".{site}") else None


def read_musicbrainz_reference(value: object) -> dict[str, object]:
    """A release or release group; a bare id has no entity until it is looked up."""
    text = _input(value)
    if mbid := _valid_mbid(text):
        return {"status": "ok", "entity": None, "mbid": mbid}
    match = _MUSICBRAINZ_PATH.match(_site_path(text, "musicbrainz.org") or "")
    mbid = _valid_mbid(match[2]) if match else None
    if not mbid:
        return _INVALID.copy()
    if match[1] not in {"release", "release-group"}:
        return {"status": "wrong_entity", "entity": match[1]}
    return {"status": "ok", "entity": match[1], "mbid": mbid}


def read_discogs_reference(value: object) -> dict[str, object]:
    """A Discogs release, as a link, an id or the [r123] code Discogs shows."""
    text = _input(value)
    if match := _DISCOGS_ID.fullmatch(text):
        release_id = int(match[1] or match[2])
    else:
        path = _DISCOGS_LOCALE.sub("", _site_path(text, "discogs.com") or "")
        if other := _DISCOGS_OTHER_PAGE.match(path):
            return {"status": "wrong_entity", "entity": other[1]}
        release_id = parse_discogs_release_id(path)
    if not release_id or release_id >= 10**12:
        return _INVALID.copy()
    return {"status": "ok", "release_id": release_id}
