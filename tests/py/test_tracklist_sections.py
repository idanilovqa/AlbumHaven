"""Tracklist sub-sections (MusicBrainz Delivery 2, S8): one test per rule, with negatives.

Owner case: Dissection, "Storm of the Light's Bane / Where Dead Angels Lie", one local disc of
13 tracks; tracks 9-13 sit under the Discogs heading "Where Dead Angels Lie". Providers are
replayed from a hand-built fixture; nothing calls MusicBrainz or Discogs.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
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
    section_retry_at,
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


def _discogs(calls: list[str] | None = None, *, fail: bool = False,
             searches: list[dict[str, object]] | None = None) -> DiscogsMetadataClient:
    """Replays the fixture; a search answers the recorded entry whose parameters it sends."""
    def get_json(path, params):
        if calls is not None:
            calls.append(path if path != "/database/search" else
                         f"search {params.get('barcode') or (params.get('artist'), params.get('release_title'))}")
        if fail:
            return None
        if path == "/database/search":
            sent = {key: value for key, value in params.items() if key != "per_page"}
            entries = FIXTURE["discogs_searches"] if searches is None else searches
            return {"results": next((entry["results"] for entry in entries if entry["params"] == sent), [])}
        return FIXTURE["discogs"].get(path)
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


def _dissection_tracks() -> list[dict[str, object]]:
    """The owner's files: one disc, tracks 1-13, local spellings with curly apostrophes."""
    titles = [item["title"] for item in _discogs_release_payload()["tracklist"] if item["type_"] == "track"]
    return [{"title": title.replace("'", "’"), "duration_seconds": 200, "disc_number": 1, "track_number": number}
            for number, title in enumerate(titles, start=1)]


class _Repository:
    def __init__(self, title: str, tracks: list[dict[str, object]]):
        self.title = title
        self.tracks = tracks
        self.recorded = None

    def claim_due_job(self, **_kwargs):
        return {"id": 1, "attempt_count": 0}

    def enqueue(self, **_kwargs):
        return 0

    def load_context(self, **_kwargs):
        return [{"artist_mbid": "b5c6e1ad-4f5a-4b1a-9a1e-0123456789ab", "local_name": "Dissection",
                 "albums": [{"id": 5, "title": self.title, "tracks": self.tracks}]}]

    def record(self, *, outcomes, **_kwargs):
        self.recorded = outcomes

    def finish(self, **_kwargs):
        pass

    def unsized_series(self, **_kwargs):
        return []


def _process(monkeypatch, *, title=DISSECTION_TITLE, media=None, discogs=None, release_mbid=MB_RELEASE,
             barcode=None, tracks=None, result_of=None):
    release = {"id": release_mbid, "barcode": barcode, "media": media or [_medium(13)]}
    monkeypatch.setattr(release_identity, "resolve_album_releases", lambda context, client: {
        "classification": "complete", "release_groups": {}, "releases": {release_mbid: release},
        "albums": [{"local_album_id": 5, "local_title": title, "state": "release", "release_mbid": release_mbid,
                    "track_sections": musicbrainz_sections(local_discs(_tracks(13)), release)}]})
    repository, mb_calls = _Repository(title, tracks or _tracks(13)), []
    MusicBrainzAlbumReleaseProcessor(repository=repository, client=_musicbrainz(mb_calls), discogs=discogs,
                                     now=lambda: NOW).process_next(worker_id="w")
    album = repository.recorded[0]["albums"][0]
    if result_of is not None:
        result_of.update(album)
    return album["track_sections"], mb_calls


def test_dissection_resolves_end_to_end_through_the_musicbrainz_discogs_link(monkeypatch):
    discogs_calls = []
    sections, mb_calls = _process(monkeypatch, discogs=_discogs(discogs_calls))
    assert sections == DISSECTION_SECTIONS
    assert mb_calls == [f"/release/{MB_RELEASE}?inc=url-rels&fmt=json"]
    assert discogs_calls == ["/releases/663181"]


# The sandbox6 match: release 458ab977 has one untitled medium and no Discogs link.
SANDBOX_RELEASE = "458ab977-dfbb-4d44-bbf0-9bdcb426dc19"
CURLY_TITLE = DISSECTION_TITLE.replace("'", "’")


def _search(monkeypatch, *, barcode="0727361664626", searches=None):
    calls = []
    sections, mb_calls = _process(monkeypatch, title=CURLY_TITLE, release_mbid=SANDBOX_RELEASE, barcode=barcode,
                                  tracks=_dissection_tracks(), discogs=_discogs(calls, searches=searches))
    assert mb_calls == [f"/release/{SANDBOX_RELEASE}?inc=url-rels&fmt=json"]  # the link is asked first
    return sections, calls


def test_without_a_musicbrainz_link_the_barcode_search_finds_the_certain_release(monkeypatch):
    sections, calls = _search(monkeypatch)
    assert sections == DISSECTION_SECTIONS
    assert calls == ["search 0727361664626", "/releases/663181"]


def test_without_a_barcode_answer_the_artist_and_title_search_finds_it(monkeypatch):
    # The 1995 eight-track album is listed first and rejected on its tracks.
    sections, calls = _search(monkeypatch, barcode=None)
    assert sections == DISSECTION_SECTIONS
    assert calls == ["search ('Dissection', \"Storm of the Light's Bane / Where Dead Angels Lie\")",
                     "/releases/1995001", "/releases/663181"]


def test_a_search_that_finds_only_another_release_stores_no_sections(monkeypatch):
    only_1995 = [{"params": entry["params"], "results": [{"id": 1995001, "title": "Storm Of The Light's Bane"}]}
                 for entry in FIXTURE["discogs_searches"]]
    sections, calls = _search(monkeypatch, searches=only_1995)
    assert sections == []
    assert calls.count("/releases/1995001") == 2 and "/releases/663181" not in calls


def test_the_curly_apostrophe_title_is_searched_and_agrees_as_a_straight_one(monkeypatch):
    # Covered end to end above (CURLY_TITLE and curly track titles); the sent title is straight.
    _sections, calls = _search(monkeypatch, barcode=None)
    assert "’" not in calls[0] and "Light's" in calls[0]


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


# Discogs unavailable: hourly retries (owner 2026-11-16) ----------------------------------

FAILED = datetime(2026, 11, 16, 12, 0, tzinfo=timezone.utc)


def test_retries_are_hourly_for_a_day_then_daily_and_stop_after_a_week():
    assert section_retry_at(FAILED, FAILED) == FAILED + timedelta(hours=1)
    assert section_retry_at(FAILED, FAILED + timedelta(hours=23)) == FAILED + timedelta(hours=24)
    assert section_retry_at(FAILED, FAILED + timedelta(hours=24)) == FAILED + timedelta(hours=48)
    assert section_retry_at(FAILED, FAILED + timedelta(days=6)) == FAILED + timedelta(days=7)
    assert section_retry_at(FAILED, FAILED + timedelta(days=7)) is None


def test_a_discogs_outage_marks_a_slash_album_for_retry(monkeypatch):
    album = {}
    assert _process(monkeypatch, discogs=_discogs(fail=True), result_of=album)[0] == []
    assert album["discogs_sections_unavailable"] is True


def test_a_missing_release_or_a_definitive_miss_is_never_retried(monkeypatch):
    # The link leads to a release Discogs no longer has (404).
    gone = DiscogsMetadataClient(lambda path, params: {"__not_found__": True})
    album = {}
    _process(monkeypatch, discogs=gone, result_of=album)
    assert not album.get("discogs_sections_unavailable")
    # No link and no certain match: a definitive miss.
    only_1995 = [{"params": entry["params"], "results": [{"id": 1995001, "title": "Storm Of The Light's Bane"}]}
                 for entry in FIXTURE["discogs_searches"]]
    album = {}
    _process(monkeypatch, title=CURLY_TITLE, release_mbid=SANDBOX_RELEASE, barcode="0727361664626",
             tracks=_dissection_tracks(), discogs=_discogs(searches=only_1995), result_of=album)
    assert not album.get("discogs_sections_unavailable")


class _RetryRepository(_Repository):
    def __init__(self, first_failed_at):
        super().__init__(CURLY_TITLE, _dissection_tracks())
        self.first_failed_at = first_failed_at
        self.stored = []

    def claim_due_job(self, **_kwargs):
        return None

    def claim_section_retry(self, *, now):
        return {"library_id": 1, "album_key": "dissection", "local_album_id": 5, "title": CURLY_TITLE,
                "local_name": "Dissection", "release_mbid": SANDBOX_RELEASE, "barcode": "0727361664626",
                "media": [_medium(13)], "tracks": _dissection_tracks(), "first_failed_at": self.first_failed_at}

    def store_section_retry(self, **kwargs):
        self.stored.append(kwargs)


def _retry(first_failed_at, now, discogs):
    repository = _RetryRepository(first_failed_at)
    result = MusicBrainzAlbumReleaseProcessor(repository=repository, client=_musicbrainz([]), discogs=discogs,
                                              now=lambda: now).process_next(worker_id="w")
    return result, repository.stored


def test_a_due_retry_after_a_5xx_stores_the_headings_once_discogs_answers():
    result, stored = _retry(FAILED, FAILED + timedelta(hours=1), _discogs())
    assert result["state"] == "succeeded"
    assert stored == [{"row": stored[0]["row"], "track_sections": DISSECTION_SECTIONS, "retry_at": None,
                       "observed_at": FAILED + timedelta(hours=1)}]


def test_a_due_retry_that_fails_again_backs_off_and_stops_after_a_week():
    _result, stored = _retry(FAILED, FAILED + timedelta(hours=2), _discogs(fail=True))
    assert (stored[0]["track_sections"], stored[0]["retry_at"]) == (None, FAILED + timedelta(hours=3))
    _result, stored = _retry(FAILED, FAILED + timedelta(days=2), _discogs(fail=True))
    assert stored[0]["retry_at"] == FAILED + timedelta(days=3)
    _result, stored = _retry(FAILED, FAILED + timedelta(days=7), _discogs(fail=True))
    assert (stored[0]["track_sections"], stored[0]["retry_at"]) == (None, None)


def test_a_retry_that_ends_in_a_definitive_miss_stops_retrying():
    only_1995 = [{"params": entry["params"], "results": [{"id": 1995001, "title": "Storm Of The Light's Bane"}]}
                 for entry in FIXTURE["discogs_searches"]]
    _result, stored = _retry(FAILED, FAILED + timedelta(hours=1), _discogs(searches=only_1995))
    assert (stored[0]["track_sections"], stored[0]["retry_at"]) == ([], None)
