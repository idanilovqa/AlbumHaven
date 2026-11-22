"""What a reference entered in MusicBrainz Info is, checked against one album's tracks.

Asks MusicBrainz and writes nothing: at most two entity lookups, one edition browse and
three tracklists. A release pins the edition. A release group pins one only by the
matcher's certain evidence. A different tracklist is reported and never refused (owner
2026-11-22).
"""
from __future__ import annotations

from music_app.services.musicbrainz_evidence import album_signals
from music_app.services.musicbrainz_identity_references import read_musicbrainz_reference
from music_app.services.musicbrainz_release_identity import _CERTAIN_SIGNALS, _MAX_EDITIONS, _edition_rank
from music_app.services.musicbrainz_track_order import pair_tracks
from music_app.services.tracklist_sections import local_discs


class _Unavailable(Exception):
    """MusicBrainz did not answer, so nothing is verified."""


def verify_musicbrainz_reference(client, value: object, tracks: list[dict[str, object]]) -> dict[str, object]:
    reference = read_musicbrainz_reference(value)
    if reference["status"] != "ok":
        return reference
    entity, mbid = reference["entity"], reference["mbid"]
    ordered = [track for disc in local_discs(tracks) for track in disc]
    try:
        if entity != "release":
            if found := _answer(client.lookup_release_group(mbid, artist_credit=True)):
                return _release_group(client, found["release_group"], ordered)
        if entity != "release-group":
            if found := _answer(client.lookup_release_tracklist(mbid)):
                return _release(found["release"], ordered)
    except _Unavailable:
        return {"status": "unavailable"}
    return {"status": "not_found"}


def _answer(found: dict[str, object]) -> dict[str, object] | None:
    if found.get("classification") == "complete":
        return found
    if found.get("classification") == "not_found":
        return None
    raise _Unavailable


def _compare(release: dict[str, object], tracks: list[dict[str, object]]) -> dict[str, object]:
    remote = [track for medium in release.get("media") or [] for track in medium.get("tracks") or []]
    certain = _CERTAIN_SIGNALS <= album_signals({"tracks": tracks}, {"tracks": remote})
    return {"release": release, "certain": certain, "count": len(remote),
            "matches": certain and len(remote) == len(tracks), "paired": pair_tracks(tracks, release)}


def _pinned(compared: dict[str, object] | None) -> dict[str, object]:
    """The release to store. One with another tracklist never lends its titles by position."""
    if not compared:
        return {"release_mbid": None, "match_quality": None, "track_pairing": []}
    matches, paired = compared["matches"], compared["paired"]
    return {"release_mbid": compared["release"]["canonical_id"],
            "match_quality": paired["quality"] if matches else "ambiguous",
            "track_pairing": paired["pairing"] if matches else []}


def _release(release: dict[str, object], tracks: list[dict[str, object]]) -> dict[str, object]:
    if not release.get("release_group_id"):
        raise _Unavailable
    compared = _compare(release, tracks)
    return {"status": "ok", "entity": "release", "title": release["title"], "year": _year(release.get("date")),
            "artist_credit": release["artist_credit"], "release_group_mbid": release["release_group_id"],
            "tracklist": {"matches": compared["matches"], "local": len(tracks), "release": compared["count"]},
            **_pinned(compared)}


def _release_group(client, group: dict[str, object], tracks: list[dict[str, object]]) -> dict[str, object]:
    listing = _answer(client.release_group_editions(group["canonical_id"])) or {}
    editions = sorted((edition for edition in listing.get("releases") or [] if edition["track_count"]),
                      key=lambda edition: (abs(edition["track_count"] - len(tracks)), edition["date"] or "9999"))
    near = [edition for edition in editions if abs(edition["track_count"] - len(tracks)) <= 1]
    best = None
    for edition in near[:_MAX_EDITIONS]:
        found = _answer(client.lookup_release_tracklist(edition["id"]))
        if not found:
            continue
        compared = _compare(found["release"], tracks)
        if not compared["certain"]:
            continue
        if best is None or _rank(compared) > _rank(best):
            best = compared
        if best["matches"] and best["paired"]["quality"] == "order_exact":
            break
    tracklist = None
    if editions:
        tracklist = {"matches": bool(best and best["matches"]), "local": len(tracks),
                     "release": best["count"] if best else editions[0]["track_count"]}
    # The album keeps the name its own edition credits (owner 2026-11-22).
    credit = (best["release"]["artist_credit"] if best else None) or group["artist_credit"]
    return {"status": "ok", "entity": "release-group", "title": group["title"],
            "year": _year(group.get("first_release_date")), "artist_credit": credit,
            "release_group_mbid": group["canonical_id"], "tracklist": tracklist, **_pinned(best)}


def _rank(compared: dict[str, object]) -> tuple[object, ...]:
    return compared["matches"], *_edition_rank(compared["paired"])


def _year(date: object) -> int | None:
    text = str(date or "")[:4]
    return int(text) if text.isdecimal() and len(text) == 4 else None
