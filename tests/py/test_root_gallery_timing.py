"""Numeric-only diagnostics for the real root-gallery preparation path."""
import json
import logging
from types import SimpleNamespace

import pytest

from music_app.services import gallery_projection_postgres as projection
from music_app.services import library_browse_postgres as browse
from tests.py.test_library_browse_postgres import _browse_album_row, _EmptyAlbumRatingsService


@pytest.mark.parametrize(
    ("query_params", "expected"),
    [
        ({"gallery_page_size": "50"}, True),
        ({"gallery_page_size": "50", "gallery_anchor_artist": "Distant Artist"}, False),
        ({"gallery_page_size": "50", "gallery_cursor": "revision:50"}, False),
    ],
)
def test_root_gallery_support_state_is_loaded_only_for_the_initial_page(query_params, expected):
    assert browse._root_gallery_request_needs_support_state(query_params) is expected


@pytest.mark.parametrize("followup", [False, True])
@pytest.mark.parametrize("ready", [False, True])
def test_root_gallery_phase_diagnostics_preserve_payload_and_exclude_private_data(
    monkeypatch, caplog, ready, followup,
):
    rows = [_browse_album_row(artist="Private Artist", album_id=1, album_key="private-album", title="Private Album")]
    state = browse._root_sidebar_view_state({})
    snapshot = browse._prepare_root_gallery_snapshot(rows, [], {}, state)
    calls = []

    class Connection:
        def execute(self, sql, params=None):
            calls.append(sql)
            if sql in (browse._root_gallery_membership_sql(), browse._root_gallery_page_rows_sql()):
                result = rows
            elif sql == browse._relation_alias_maps_sql():
                result = [{"alias_to_canonical": {}, "canonical_to_aliases": {}}]
            else:
                assert sql.startswith("SET TRANSACTION")
                result = []
            return SimpleNamespace(fetchall=lambda: result)

        def rollback(self):
            calls.append("rollback")

        def close(self):
            calls.append("close")

    repository = browse.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "private-credential", "MUSIC_DIR": "C:/Private/Music",
         "SHARED_LIBRARY_BROWSE_ONLY": not ready},
        connect=lambda _: Connection(), album_ratings_service=_EmptyAlbumRatingsService(),
    )
    monkeypatch.setattr(projection, "gallery_projection_context", lambda _: {"library_id": 1})
    monkeypatch.setattr(projection, "load_gallery_projection_page",
                        lambda _connection, _state, params, **_kwargs:
                        browse._select_root_gallery_snapshot_page(snapshot, params) if ready else None)
    monkeypatch.setattr(projection, "queue_gallery_projection_snapshot", lambda *_a, **_k: None)
    monkeypatch.setattr(repository, "_load_relation_alias_maps",
                        lambda **_: {"alias_to_canonical": {}, "canonical_to_aliases": {}})
    monkeypatch.setattr(repository, "_load_missing_album_rows", lambda **_: [])
    monkeypatch.setattr(repository, "_load_non_album_entries", lambda **_: [])
    support_state_calls = []

    def load_support_state(**kwargs):
        support_state_calls.append(kwargs)
        return {"ignored_version_keys": [], "manual_version_links": {}}

    monkeypatch.setattr(repository._inventory_repository, "load_support_state", load_support_state)
    monkeypatch.setattr(browse, "_queue_display_cover_variants_for_groups", lambda *_: None)
    with caplog.at_level(logging.INFO, logger=browse.__name__):
        payload = repository.build_root_startup_preview_payload(query_params={
            "gallery_page_size": "8",
            **({"gallery_anchor_artist": "Private Artist"} if followup else {}),
        })

    assert payload["album_count"] == 1
    assert payload["artist_groups"][0]["artist"] == "Private Artist"
    assert len(payload["artist_groups"][0]["albums"]) == 1
    assert len(support_state_calls) == (0 if followup else 1)
    assert ("ignored_version_keys" in payload) is (not followup)
    assert ("manual_version_links" in payload) is (not followup)
    assert calls[-2:] == ["rollback", "close"]
    assert calls.count(browse._root_gallery_membership_sql()) == (0 if ready else 1)
    records = [record for record in caplog.records if record.msg == "Root gallery preparation completed %s"]
    assert len(records) == 1
    diagnostics = json.loads(records[0].args[0])
    assert diagnostics["projection_hit"] is ready
    assert diagnostics["paged"] is True
    assert diagnostics["page_occurrence_count"] == 1
    assert diagnostics["album_count"] == 1
    assert diagnostics["artist_count"] == 1
    assert diagnostics["elapsed_ms"] >= 0
    assert diagnostics["thread_cpu_ms"] >= 0
    assert {"connection", "projection_lookup", "aliases", "support", "page_hydration"} <= diagnostics["phase_ms"].keys()
    assert ("membership_query" in diagnostics["phase_ms"]) is (not ready)
    assert ("snapshot_prepare" in diagnostics["phase_ms"]) is (not ready)
    assert all(value >= 0 for value in diagnostics["phase_ms"].values())
    assert all(value not in records[0].getMessage() for value in
               ("Private Artist", "Private Album", "private-album", "private-credential", "C:/Private"))
