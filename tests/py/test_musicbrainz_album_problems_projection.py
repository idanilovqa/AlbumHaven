"""Albums MusicBrainz has no info on, in the owner's Problematic Files (Delivery 2, S5)."""
from __future__ import annotations

import json
import logging
from pathlib import Path
from types import SimpleNamespace

from music_app.routes.musicbrainz_enrichment_asgi import (
    load_problematic_album_items,
    project_album_problem_into_problematic_detail,
    project_album_problems_into_problematic_files,
)

LABEL = "MusicBrainz has no info"
FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "musicbrainz" / "problematic-album-summary-item.json"
CAROUSEL = {"album_key": "carousel", "album_title": "…Карусель Эпох…", "year": 2004, "cover_path": None,
            "local_artist_id": 9, "artist_name": "R.D.(Роман Дрозд)"}
WINGS = {"album_key": "wings", "album_title": "...And the Wings Embraced Us", "year": 1995, "cover_path": None,
         "local_artist_id": 4, "artist_name": "Lacrimas Profundere"}


def _request(rows, *, owner=True, fail=False, calls=None):
    def list_album_attention(*, album_key=None):
        if calls is not None:
            calls.append(album_key)
        if fail:
            raise RuntimeError("database unavailable")
        return [row for row in rows if album_key is None or row["album_key"] == album_key]

    actor = SimpleNamespace(account_id=3, current_library_id=1,
                            library_relationships=(SimpleNamespace(library_id=1, is_primary_owner=owner),))
    return SimpleNamespace(
        state=SimpleNamespace(current_actor=actor),
        app=SimpleNamespace(state=SimpleNamespace(
            musicbrainz_enrichment_api_service=SimpleNamespace(list_album_attention=list_album_attention),
            config={"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://fixture"}, logger=logging.getLogger("test"))),
    )


def _payload():
    return {"items": [{"key": "wings::year::1995", "name": "...And the Wings Embraced Us",
                       "problem_reasons": ["Missing cover art"]},
                      {"key": "zed", "name": "Zed", "problem_reasons": ["Missing year"]}], "count": 2}


def test_a_listed_album_gains_the_label_and_an_unlisted_one_becomes_its_own_row_by_name():
    payload = _payload()

    project_album_problems_into_problematic_files(_request([CAROUSEL, WINGS]), payload)

    assert [item["key"] for item in payload["items"]] == ["wings::year::1995", "zed", "musicbrainz-album:carousel"]
    wings = payload["items"][0]
    assert (wings["problem_reasons"], wings["musicbrainz_album_key"]) == (["Missing cover art", LABEL], "wings")
    # The same row the client's summary validation accepts (musicbrainz-lookups.test.js).
    assert payload["items"][2] == json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert payload["count"] == 3
    assert "musicbrainz_album_key" not in payload["items"][1]


def test_the_label_is_never_added_twice():
    payload = _payload()
    payload["items"][0]["problem_reasons"].append(LABEL)
    project_album_problems_into_problematic_files(_request([WINGS]), payload)
    assert payload["items"][0]["problem_reasons"] == ["Missing cover art", LABEL]
    assert payload["count"] == 2


def test_non_owners_and_failures_leave_the_payload_unchanged():
    for request in (_request([CAROUSEL, WINGS], owner=False), _request([CAROUSEL, WINGS], fail=True)):
        payload = _payload()
        project_album_problems_into_problematic_files(request, payload)
        assert payload == _payload()


def test_preloaded_album_rows_are_merged_without_another_query():
    items = load_problematic_album_items(_request([CAROUSEL]))
    payload = _payload()
    project_album_problems_into_problematic_files(_request([], fail=True), payload, items)
    assert payload["items"][-1]["key"] == "musicbrainz-album:carousel"


def test_a_loaded_album_detail_keeps_its_label_and_only_that_album_is_read():
    calls = []
    detail = {"key": "wings::year::1995", "problem_reasons": ["Missing cover art"]}
    project_album_problem_into_problematic_detail(_request([WINGS], calls=calls), detail)
    assert detail["problem_reasons"] == ["Missing cover art", LABEL]
    assert calls == ["wings"]

    other = {"key": "zed", "problem_reasons": ["Missing year"]}
    project_album_problem_into_problematic_detail(_request([WINGS]), other)
    assert other == {"key": "zed", "problem_reasons": ["Missing year"]}

    stranger = {"key": "wings", "problem_reasons": []}
    project_album_problem_into_problematic_detail(_request([WINGS], owner=False), stranger)
    assert stranger == {"key": "wings", "problem_reasons": []}


def test_the_album_attention_query_reads_only_automatic_missing_album_flags_of_present_albums():
    from music_app.services.musicbrainz_enrichment_postgres import _ALBUM_ATTENTION_SQL

    sql = " ".join(_ALBUM_ATTENTION_SQL.split())
    assert "flags.target_kind = 'album'" in sql and "flags.source = 'automatic'" in sql
    assert "flags.reason = 'missing_from_musicbrainz'" in sql
    assert "from library.local_tracks tracks" in sql
