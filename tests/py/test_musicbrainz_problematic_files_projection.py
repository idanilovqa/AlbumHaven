from __future__ import annotations

import json
import logging
from pathlib import Path
from types import SimpleNamespace

from music_app.routes.musicbrainz_enrichment_asgi import (
    project_artist_problems_into_problematic_files,
)


def _actor(*, owner=True):
    return SimpleNamespace(
        account_id=3,
        current_library_id=1,
        library_relationships=(SimpleNamespace(library_id=1, is_primary_owner=owner),),
    )


def _request(rows, *, owner=True, fail=False):
    def list_present_artist_review(*, include_gallery_artist=True):
        assert include_gallery_artist is False, "Problematic Files never loads the Gallery alias map"
        if fail:
            raise RuntimeError("database unavailable")
        return rows

    service = SimpleNamespace(list_artist_attention=list_present_artist_review)
    return SimpleNamespace(
        state=SimpleNamespace(current_actor=_actor(owner=owner)),
        app=SimpleNamespace(state=SimpleNamespace(
            musicbrainz_enrichment_api_service=service, logger=logging.getLogger("test"),
        )),
    )


ALBUMS = [
    {"key": "album-b", "name": "Bravo", "album_artist": "Zed"},
    {"key": "album-k", "name": "Kingdom of the Night", "album_artist": "Axxis"},
]
ROWS = [
    {"local_artist_id": 7, "local_artist_name": "Axxis", "unresolved_reason": "MBID: Multiple matches",
     "problem_occurrence_id": 19, "local_album_count": 12, "evidence_summary": "private detail"},
    {"local_artist_id": 8, "local_artist_name": "Matched", "unresolved_reason": None,
     "problem_occurrence_id": None},
]


def test_owner_sees_artist_rows_merged_by_name_without_reordering_album_rows():
    payload = {"items": [dict(item) for item in ALBUMS], "count": 2}

    project_artist_problems_into_problematic_files(_request(ROWS), payload)

    assert [item["key"] for item in payload["items"]] == [
        "musicbrainz-artist:7", "album-b", "album-k",
    ]
    # The same row the client's summary validation accepts
    # (tests/js/runtime/musicbrainz-problematic-files.test.js).
    fixture = Path(__file__).resolve().parents[1] / "fixtures" / "musicbrainz" / "problematic-artist-summary-item.json"
    assert payload["items"][0] == json.loads(fixture.read_text(encoding="utf-8"))
    assert payload["count"] == 3


def test_non_owners_and_failures_leave_the_existing_payload_unchanged():
    for request in (_request(ROWS, owner=False), _request(ROWS, fail=True)):
        payload = {"items": [dict(item) for item in ALBUMS], "count": 2}
        project_artist_problems_into_problematic_files(request, payload)
        assert payload == {"items": ALBUMS, "count": 2}


def test_bounded_first_page_stays_compact_without_artist_rows():
    payload = {"items": [dict(item) for item in ALBUMS], "count": 2, "complete": False}

    project_artist_problems_into_problematic_files(_request(ROWS), payload)

    assert [item["key"] for item in payload["items"]] == ["album-b", "album-k"]
    assert payload["count"] == 2
