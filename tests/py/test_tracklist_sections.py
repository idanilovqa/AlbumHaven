"""Tracklist sub-sections (MusicBrainz Delivery 2, S8): one test per rule, with negatives.

Owner case: Dissection, "Storm of the Light's Bane / Where Dead Angels Lie", one local disc of
13 tracks; tracks 9-13 sit under the Discogs heading "Where Dead Angels Lie". Providers are
replayed from a hand-built fixture; nothing calls MusicBrainz or Discogs.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from music_app.services import musicbrainz_release_identity as release_identity
from music_app.services.discogs_metadata import DiscogsMetadataClient
from music_app.services.library_browse_postgres import _apply_track_sections
from music_app.services.musicbrainz_client import MusicBrainzClient
from music_app.services.musicbrainz_discogs_fallback import resolve_with_discogs
from music_app.services.musicbrainz_release_identity import MusicBrainzAlbumReleaseProcessor
from music_app.services.tracklist_sections import (
    discogs_sections,
    local_discs,
    musicbrainz_sections,
    wants_discogs_sections,
)
from tests.py.musicbrainz_test_mirror import OK

FIXTURE = json.loads((Path(__file__).resolve().parents[1] / "fixtures" / "musicbrainz"
                      / "delivery-2-discogs-release-663181.json").read_text(encoding="utf-8"))
DISSECTION_TITLE = "Storm of the Light's Bane / Where Dead Angels Lie"
MB_RELEASE = "7d1f4c2e-0b8a-4f53-9c51-6c3d2a6e6631"
SECTION = "Where Dead Angels Lie"
NOW = datetime(2026, 11, 16, 12, 0, tzinfo=timezone.utc)
DISSECTION_SECTIONS = [{"disc_number": 1, "track_number": number, "section": SECTION} for number in range(9, 14)]


def _tracks(count: int, *, disc: int = 1, prefix: str = "Track") -> list[dict[str, object]]:
    return [{"title": f"{prefix} {number}", "duration_seconds": 200, "disc_number": disc, "track_number": number}
            for number in range(1, count + 1)]


def _discogs_release_payload() -> dict[str, object]:
    return FIXTURE["discogs"]["/releases/663181"]


def _discogs(calls: list[str] | None = None, *, fail: bool = False) -> DiscogsMetadataClient:
    def get_json(path, _params):
        if calls is not None:
            calls.append(path)
        return None if fail else FIXTURE["discogs"].get(path)
    return DiscogsMetadataClient(get_json)


def _musicbrainz(calls: list[str]) -> MusicBrainzClient:
    def get_json(url, _user_agent):
        parsed = urlparse(url)
        path = parsed.path.removeprefix("/ws/2") + (f"?{parsed.query}" if parsed.query else "")
        calls.append(path)
        payload = FIXTURE["musicbrainz"].get(path)
        return (payload, OK) if payload else (None, {"status": "network", "http_status": 404})
    return MusicBrainzClient(base_url="http://127.0.0.1:5050/ws/2", user_agent="Test", get_json=get_json)


def _medium(count: int, *, title: str | None = None, position: int = 1) -> dict[str, object]:
    return {"position": position, "title": title, "track_count": count,
            "tracks": [{"position": number, "title": f"Track {number}"} for number in range(1, count + 1)]}


# Discogs headings ------------------------------------------------------------------------

def test_a_discogs_release_names_each_tracks_heading_and_headings_are_not_tracks():
    release = _discogs().release(663181)["release"]
    assert len(release["tracks"]) == 13
    assert [track["section"] for track in release["tracks"]] == [None] * 8 + [SECTION] * 5


def test_dissection_tracks_9_to_13_sit_under_the_discogs_heading():
    tracks = _discogs().release(663181)["release"]["tracks"]
    assert discogs_sections(local_discs(_tracks(13)), tracks) == DISSECTION_SECTIONS


def test_a_heading_that_opens_the_disc_names_the_disc_not_a_section():
    tracks = [{"disc": 1, "section": "Storm of the Light's Bane"}] * 8 + [{"disc": 1, "section": SECTION}] * 5
    assert discogs_sections(local_discs(_tracks(13)), tracks) == DISSECTION_SECTIONS
    assert discogs_sections(local_discs(_tracks(13)), [{"disc": 1, "section": "Whole Album"}] * 13) == []


def test_a_heading_that_names_a_cd_is_never_a_section():
    tracks = [{"disc": 1, "section": None}] * 8 + [{"disc": 1, "section": "CD 2: Where Dead Angels Lie"}] * 5
    assert discogs_sections(local_discs(_tracks(13)), tracks) == []


def test_alien_style_cd_names_on_a_real_multi_disc_release_stay_discs():
    # Two local discs; Discogs heads each disc with its CD name, MusicBrainz titles each medium.
    local = local_discs(_tracks(10, disc=1) + _tracks(8, disc=2, prefix="Live"))
    discogs = ([{"disc": 1, "section": "CD 1: Alien"}] * 10 + [{"disc": 2, "section": "CD 2: Alien Live"}] * 8)
    assert discogs_sections(local, discogs) == []
    release = {"media": [_medium(10, title="Alien"), _medium(8, title="Alien Live", position=2)]}
    assert musicbrainz_sections(local, release) == []


def test_tracks_that_differ_from_the_release_get_no_sections():
    tracks = _discogs().release(663181)["release"]["tracks"]
    assert discogs_sections(local_discs(_tracks(12)), tracks) == []
    assert musicbrainz_sections(local_discs(_tracks(12)), {"media": [_medium(8), _medium(5, title=SECTION)]}) == []


# MusicBrainz medium titles ---------------------------------------------------------------

def test_musicbrainz_medium_titles_of_media_on_one_local_disc_are_sections():
    release = {"media": [_medium(8, title="Storm of the Light's Bane"), _medium(5, title=SECTION, position=2)]}
    assert musicbrainz_sections(local_discs(_tracks(13)), release) == DISSECTION_SECTIONS


# When Discogs is asked ------------------------------------------------------------------

def test_a_slash_title_asks_discogs_unless_musicbrainz_names_its_media():
    assert wants_discogs_sections(DISSECTION_TITLE, {"media": [_medium(13)]})
    assert not wants_discogs_sections(DISSECTION_TITLE, {"media": [_medium(13, title="Storm")]})
    assert not wants_discogs_sections("Storm of the Light's Bane", {"media": [_medium(13)]})
    # "AC/DC" style slashes without spaces are names, not two albums.
    assert not wants_discogs_sections("Live/Dead", {"media": [_medium(13)]})


class _Repository:
    def __init__(self, title: str):
        self.title = title
        self.recorded = None

    def claim_due_job(self, **_kwargs):
        return {"id": 1, "attempt_count": 0}

    def load_context(self, **_kwargs):
        return [{"artist_mbid": "b5c6e1ad-4f5a-4b1a-9a1e-0123456789ab", "local_name": "Dissection",
                 "albums": [{"id": 5, "title": self.title, "tracks": _tracks(13)}]}]

    def record(self, *, outcomes, **_kwargs):
        self.recorded = outcomes

    def finish(self, **_kwargs):
        pass

    def unsized_series(self, **_kwargs):
        return []


def _process(monkeypatch, *, title=DISSECTION_TITLE, media=None, discogs=None):
    release = {"id": MB_RELEASE, "media": media or [_medium(13)]}
    monkeypatch.setattr(release_identity, "resolve_album_releases", lambda context, client: {
        "classification": "complete", "release_groups": {}, "releases": {MB_RELEASE: release},
        "albums": [{"local_album_id": 5, "local_title": title, "state": "release", "release_mbid": MB_RELEASE,
                    "track_sections": musicbrainz_sections(local_discs(_tracks(13)), release)}]})
    repository, mb_calls = _Repository(title), []
    MusicBrainzAlbumReleaseProcessor(repository=repository, client=_musicbrainz(mb_calls), discogs=discogs,
                                     now=lambda: NOW).process_next(worker_id="w")
    return repository.recorded[0]["albums"][0]["track_sections"], mb_calls


def test_dissection_resolves_end_to_end_through_the_musicbrainz_discogs_link(monkeypatch):
    discogs_calls = []
    sections, mb_calls = _process(monkeypatch, discogs=_discogs(discogs_calls))
    assert sections == DISSECTION_SECTIONS
    assert mb_calls == [f"/release/{MB_RELEASE}?inc=url-rels&fmt=json"]
    assert discogs_calls == ["/releases/663181"]


def test_musicbrainz_medium_names_or_a_plain_title_never_ask_discogs(monkeypatch):
    discogs_calls = []
    named = [_medium(13, title="Storm of the Light's Bane")]
    assert _process(monkeypatch, media=named, discogs=_discogs(discogs_calls)) == ([], [])
    assert _process(monkeypatch, title="Storm of the Light's Bane", discogs=_discogs(discogs_calls)) == ([], [])
    assert discogs_calls == []


def test_without_a_discogs_key_or_answer_the_album_has_no_sections(monkeypatch):
    assert _process(monkeypatch, discogs=None) == ([], [])
    assert _process(monkeypatch, discogs=_discogs(fail=True))[0] == []


# The Discogs fallback -------------------------------------------------------------------

class _NoMusicBrainz:
    def search_releases_by_barcode(self, _barcode):
        return {"classification": "complete", "releases": []}

    def search_artists(self, _name):
        return {"classification": "complete", "candidates": []}


def test_a_discogs_fallback_album_keeps_the_releases_headings():
    payload = _discogs_release_payload()

    def get_json(path, _params):
        if path == "/database/search":
            return {"results": [{"id": 101523, "title": "Dissection"}]}
        if path == "/artists/101523/releases":
            return {"pagination": {"pages": 1}, "releases": [
                {"id": 663181, "type": "release", "title": payload["title"], "year": 2002, "role": "Main"}]}
        if path == "/artists/101523":
            return {"name": "Dissection", "namevariations": [], "aliases": []}
        return FIXTURE["discogs"][path]

    tracks = [{**track, "title": item["title"]} for track, item in zip(
        _tracks(13), [item for item in payload["tracklist"] if item["type_"] == "track"])]
    outcome = resolve_with_discogs(
        {"local_name": "Dissection", "albums": [{"id": 5, "title": DISSECTION_TITLE, "year": 2002, "tracks": tracks}]},
        discogs=DiscogsMetadataClient(get_json), musicbrainz=_NoMusicBrainz())
    assert outcome["albums"][0]["track_sections"] == DISSECTION_SECTIONS


# Album details ---------------------------------------------------------------------------

def test_album_details_name_the_heading_on_each_track_row_only():
    album = {"track_rows": [{"disc_number": 1, "track_number": number} for number in (8, 9, 13)]}
    rows = _apply_track_sections(album, DISSECTION_SECTIONS)["track_rows"]
    assert [row.get("section") for row in rows] == [None, SECTION, SECTION]
    assert _apply_track_sections({"track_rows": [{"track_number": 9}]}, [])["track_rows"] == [{"track_number": 9}]
