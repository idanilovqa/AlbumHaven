"""Shared fake-mirror pieces for MusicBrainz resolver tests.

Album evidence needs more than a title: a local album and the release group it
matches share a year, and the release closest in track count shares its tracks.
"""
from __future__ import annotations

import hashlib
from urllib.parse import parse_qs, urlparse

OK = {"status": "network", "http_status": 200, "cache_hit": False}
YEAR = 2000
TRACKS = (("Opening", 200), ("Closing", 300))


def albums(*titles: str, year: int = YEAR) -> list[dict[str, object]]:
    """Local albums: each title with the shared year and two tracks."""
    return [{"title": title, "year": year,
             "tracks": [{"title": name, "duration_seconds": seconds} for name, seconds in TRACKS]}
            for title in titles]


def group_id(artist_mbid: str, title: str) -> str:
    digest = hashlib.sha1(f"{artist_mbid}/{title}".encode()).hexdigest()
    return f"{digest[:8]}-{digest[8:12]}-4{digest[13:16]}-8{digest[17:20]}-{digest[20:32]}"


def release_groups_payload(artist_mbid: str, titles: list[str], *, year: int = YEAR, offset: int = 0) -> dict:
    page = titles[offset:offset + 100]
    return {"release-group-count": len(titles), "release-groups": [
        {"id": group_id(artist_mbid, title), "title": title, "first-release-date": str(year)} for title in page]}


def release_paths(url: str, *, releases: dict[str, list[dict]] | None = None,
                  discs: dict[str, list[dict]] | None = None, lookups: dict[str, dict] | None = None):
    """Answer release search, release-group release lists, an artist's releases with
    their discs, release lookups and release tracklists.

    ``releases`` maps a release search's title to its results; anything else
    searched finds nothing. ``discs`` maps an artist to its releases with media, and
    ``lookups`` a release MBID to its lookup payload. Every release group has one
    release with the shared tracks.
    """
    parsed = urlparse(url)
    query = parse_qs(parsed.query)
    if parsed.path.endswith("/release/"):
        text = query["query"][0]
        found = next((items for title, items in (releases or {}).items() if title in text), [])
        return {"count": len(found), "releases": found}, OK
    if parsed.path.endswith("/release") and "artist" in query:
        found = (discs or {}).get(query["artist"][0], [])
        return {"release-count": len(found), "releases": found}, OK
    if "/release/" in parsed.path and "release-groups" in query.get("inc", [""])[0]:
        payload = (lookups or {}).get(parsed.path.rsplit("/", 1)[-1])
        return (payload, OK) if payload else (None, {"status": "network", "http_status": 404, "cache_hit": False})
    if parsed.path.endswith("/release"):
        group = query["release-group"][0]
        return {"releases": [{"id": group, "date": str(YEAR), "media": [{"track-count": len(TRACKS)}]}]}, OK
    if "/release/" in parsed.path:
        return {"media": [{"tracks": [{"title": name, "length": seconds * 1000} for name, seconds in TRACKS]}]}, OK
    return None
