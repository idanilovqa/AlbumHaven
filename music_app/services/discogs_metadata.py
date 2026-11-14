"""Discogs database reads for the MusicBrainz fallback (Delivery 2, S3).

Discogs is used only when MusicBrainz lacks an artist or release, and never for anything
MusicBrainz already answers. Requests go through the existing Discogs transport (key and
secret from the operator's configuration, its rate-limit handling, Album Haven's user
agent). Each method returns plain projections of the fields the fallback reads.
"""
from __future__ import annotations

import re
from collections.abc import Callable

JsonDict = dict[str, object]
# ``get_json(path, params) -> dict | None``; None is a provider failure (rate limit,
# network, authentication), never "not found".
DiscogsGetter = Callable[[str, dict[str, object]], "JsonDict | None"]
_DURATION = re.compile(r"^(?:(\d+):)?(\d{1,3}):(\d{2})$")
_TRAILING_NUMBER = re.compile(r"\s+\(\d+\)$")


def duration_ms(value: object) -> int | None:
    """Discogs writes durations as "m:ss" or "h:mm:ss"; empty means unknown."""
    match = _DURATION.match(str(value or "").strip())
    if not match:
        return None
    hours, minutes, seconds = (int(part or 0) for part in match.groups())
    return ((hours * 60 + minutes) * 60 + seconds) * 1000


def artist_name(value: object) -> str:
    """Discogs numbers same-named artists: "Amarok (2)" is "Amarok"."""
    return _TRAILING_NUMBER.sub("", str(value or "").strip())


def _credits(items: object) -> list[JsonDict]:
    return [{"id": int(item["id"]), "name": artist_name(item.get("name")), "anv": str(item.get("anv") or "") or None,
             "join": str(item.get("join") or "")}
            for item in items or [] if isinstance(item, dict) and str(item.get("id") or "").isdigit()]


class DiscogsMetadataClient:
    def __init__(self, get_json: DiscogsGetter) -> None:
        self._get_json = get_json

    def _get(self, path: str, **params: object) -> JsonDict:
        payload = self._get_json(path, {key: value for key, value in params.items() if value is not None})
        if payload is None:
            return {"classification": "provider_unavailable"}
        if not isinstance(payload, dict):
            return {"classification": "invalid_response"}
        return {"classification": "complete", "payload": payload}

    def search_artists(self, name: str, *, limit: int = 10) -> JsonDict:
        found = self._get("/database/search", q=name, type="artist", per_page=limit)
        if found["classification"] != "complete":
            return found
        return {"classification": "complete", "artists": [
            {"id": int(item["id"]), "name": artist_name(item.get("title"))}
            for item in found["payload"].get("results") or [] if isinstance(item, dict) and item.get("id")]}

    def search_releases(self, *, title: str | None = None, artist: str | None = None, barcode: str | None = None,
                        limit: int = 10) -> JsonDict:
        found = self._get("/database/search", type="release", release_title=title, artist=artist, barcode=barcode,
                          per_page=limit)
        if found["classification"] != "complete":
            return found
        return {"classification": "complete", "releases": [
            {"id": int(item["id"]), "title": str(item.get("title") or ""), "year": str(item.get("year") or "") or None,
             "master_id": int(item["master_id"]) if str(item.get("master_id") or "").isdigit() and
             int(item["master_id"]) else None}
            for item in found["payload"].get("results") or [] if isinstance(item, dict) and item.get("id")]}

    def artist(self, artist_id: int) -> JsonDict:
        found = self._get(f"/artists/{int(artist_id)}")
        if found["classification"] != "complete":
            return found
        payload = found["payload"]
        return {"classification": "complete", "artist": {
            "id": int(artist_id), "name": artist_name(payload.get("name")),
            "real_name": str(payload.get("realname") or "").strip() or None,
            "name_variations": [str(name).strip() for name in payload.get("namevariations") or [] if str(name).strip()],
            "aliases": _credits(payload.get("aliases")),
            "urls": [str(url) for url in payload.get("urls") or [] if str(url).startswith("http")],
        }}

    def artist_releases(self, artist_id: int, *, max_pages: int = 2, per_page: int = 100) -> JsonDict:
        """Masters and releases the artist is a main artist of (not appearances)."""
        items: list[JsonDict] = []
        for page in range(1, max_pages + 1):
            found = self._get(f"/artists/{int(artist_id)}/releases", page=page, per_page=per_page, sort="year")
            if found["classification"] != "complete":
                return {**found, "releases": items}
            payload = found["payload"]
            for item in payload.get("releases") or []:
                if not isinstance(item, dict) or not item.get("id") or str(item.get("role") or "Main") != "Main":
                    continue
                kind = str(item.get("type") or "release")
                items.append({"id": int(item["id"]), "kind": kind, "title": str(item.get("title") or ""),
                              "year": str(item.get("year") or "") or None,
                              "main_release": int(item["main_release"]) if kind == "master" and
                              str(item.get("main_release") or "").isdigit() else None})
            pagination = payload.get("pagination") or {}
            if page >= int(pagination.get("pages") or 1):
                break
        return {"classification": "complete", "releases": items}

    def release(self, release_id: int) -> JsonDict:
        found = self._get(f"/releases/{int(release_id)}")
        if found["classification"] != "complete":
            return found
        payload = found["payload"]
        tracks = [
            {"position": str(track.get("position") or ""), "title": str(track.get("title") or ""),
             "length": duration_ms(track.get("duration")), "artists": _credits(track.get("artists"))}
            for track in payload.get("tracklist") or []
            # Headings and index entries are not tracks.
            if isinstance(track, dict) and str(track.get("type_") or "track") == "track"
        ]
        return {"classification": "complete", "release": {
            "id": int(release_id), "title": str(payload.get("title") or ""),
            "year": str(payload.get("year") or "") or None,
            "master_id": int(payload["master_id"]) if str(payload.get("master_id") or "").isdigit() and
            int(payload["master_id"]) else None,
            "artists": _credits(payload.get("artists")),
            "barcodes": sorted({re.sub(r"\D", "", str(item.get("value") or ""))
                                for item in payload.get("identifiers") or []
                                if isinstance(item, dict) and str(item.get("type") or "") == "Barcode"} - {""}),
            "tracks": tracks,
        }}
