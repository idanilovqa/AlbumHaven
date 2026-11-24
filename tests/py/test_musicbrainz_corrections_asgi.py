"""Routes and Problematic Files rows for MusicBrainz data corrections (Delivery 2, S4)."""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from types import SimpleNamespace
from urllib.parse import quote

import pytest

from music_app.routes.musicbrainz_corrections_asgi import (
    project_correction_into_problematic_detail,
    project_correction_problems_into_problematic_files,
)
from music_app.services.private_route_boundary import private_action_for_route
from tests.py.asgi_testing import collect_route_paths
from tests.py.test_musicbrainz_enrichment_asgi import actor_with, app_for
from tests.py.test_musicbrainz_lookup_asgi import Service as LookupService
from tests.py.test_musicbrainz_lookup_asgi import request

RELEASE = "6f3c2a1e-0000-4000-8000-0000000c0de1"
NOW = datetime(2026, 11, 16, 10, 20, tzinfo=timezone.utc)
ROUTES = [
    ("/api/musicbrainz/corrections/albums", "GET", "library.problems.read"),
    ("/api/musicbrainz/corrections", "GET", "library.problems.read"),
    ("/api/musicbrainz/corrections/edits", "GET", "library.problems.read"),
    ("/api/musicbrainz/corrections/edits/{kind}", "GET", "library.problems.read"),
    ("/api/musicbrainz/corrections/albums/{action}", "POST", "library.metadata_matches.review"),
    ("/api/musicbrainz/corrections/kinds/{kind}/approve", "POST", "library.metadata_matches.review"),
    ("/api/musicbrainz/corrections/settings", "PUT", "library.metadata_matches.review"),
    ("/api/musicbrainz/lookups/{request_id}", "DELETE", "catalogue.enrichment.request"),
]
CORRECTION = {"field": "album_artist", "label": "Album artist", "disc_number": 0, "track_number": 0,
              "current_value": "Fixture Singer", "proposed_value": "Fixture Band", "kind": "album_artist_renamed",
              "mode": "review", "state": "pending"}
ALBUM = {"album_key": "lumor", "album_title": "Lumor Ïvel", "artist_name": "Fixture Singer", "year": 1974,
         "cover_path": "covers/lumor.jpg", "track_count": 12, "file_types": ["FLAC"], "release_mbid": RELEASE, "queued_at": None,
         "corrections": [dict(CORRECTION)]}


class Corrections:
    def __init__(self, albums=(ALBUM,), *, fail=False):
        self.albums = [dict(album) for album in albums]
        self.fail = fail
        self.calls = []

    def list_correction_summaries(self, *, album_keys=None, offset=0, limit=None):
        self.calls.append(("list_correction_summaries", {"album_keys": album_keys, "offset": offset, "limit": limit}))
        if self.fail:
            raise RuntimeError("database unavailable")
        rows = [{**{key: value for key, value in album.items() if key not in {"corrections", "track_count", "file_types"}},
                 "correction_count": len(album["corrections"])} for album in self.albums
                if album_keys is None or album["album_key"] in album_keys]
        return {"items": rows[offset:None if limit is None else offset + limit], "total": len(self.albums)}

    def get_correction(self, *, album_key):
        self.calls.append(("get_correction", {"album_key": album_key}))
        if self.fail:
            raise RuntimeError("database unavailable")
        return next((album for album in self.albums if album["album_key"] == album_key), None)

    def edits_queue(self, *, section):
        self.calls.append(("edits_queue", {"section": section}))
        return {"kinds": [{"kind": "case", "albums": 1, "rows": 2, "private": "x"}],
                "settings": {"auto_submit_bulks": True, "next_run_at": NOW.isoformat(), "changed_by": 7}}

    def edits_queue_page(self, *, section, kind, after, limit):
        self.calls.append(("edits_queue_page", {"section": section, "kind": kind, "after": after, "limit": limit}))
        albums = [{**ALBUM, "album_key": f"album-{number}", "sort_title": "lumor ïvel",
                   "rows": [{**CORRECTION, "private": "x"}]} for number in range(3)]
        return [album for album in albums if after is None or (album["sort_title"], album["album_key"]) > after][:limit]

    def _decide(self, name, album_key, actor_account_id):
        self.calls.append((name, {"album_key": album_key, "actor_account_id": actor_account_id}))
        if self.fail:
            raise RuntimeError("database unavailable")
        return 2 if album_key == "lumor" else 0

    def undo_album(self, **kwargs):
        return self._decide("undo_album", **kwargs)

    def approve_album(self, **kwargs):
        return self._decide("approve_album", **kwargs)

    def skip_album(self, **kwargs):
        return self._decide("skip_album", **kwargs)

    def approve_kind(self, *, kind, actor_account_id):
        self.calls.append(("approve_kind", {"kind": kind, "actor_account_id": actor_account_id}))
        return 5

    def save_settings(self, *, auto_submit_bulks, actor_account_id):
        self.calls.append(("save_settings", {"auto_submit_bulks": auto_submit_bulks,
                                             "actor_account_id": actor_account_id}))
        return {"auto_submit_bulks": auto_submit_bulks, "next_run_at": NOW.isoformat() if auto_submit_bulks else None}


class Lookups(LookupService):
    def remove_queued_lookup(self, *, request_id):
        self.calls.append(("remove_queued_lookup", {"request_id": request_id}))
        return {"removed": request_id == 9}


def owner():
    return actor_with("catalogue.enrichment.request", "library.problems.read", "library.metadata_matches.review")


def app(actor=None, corrections=None, lookups=None):
    built = app_for(actor or owner(), lookups or Lookups())
    built.state.musicbrainz_correction_service = corrections or Corrections()
    return built


def test_routes_are_registered_with_the_musicbrainz_owner_capabilities():
    paths = collect_route_paths(app())
    for path, method, capability in ROUTES:
        assert path in paths
        assert private_action_for_route(method, path) == capability


@pytest.mark.parametrize("method,path,body", [
    ("GET", "/api/musicbrainz/corrections/albums", None),
    ("GET", "/api/musicbrainz/corrections?album_key=lumor", None),
    ("GET", "/api/musicbrainz/corrections/edits?section=applied", None),
    ("GET", "/api/musicbrainz/corrections/edits/case?section=applied", None),
    ("POST", "/api/musicbrainz/corrections/albums/undo", {"album_key": "lumor"}),
    ("POST", "/api/musicbrainz/corrections/kinds/edition_suffix/approve", {}),
    ("PUT", "/api/musicbrainz/corrections/settings", {"auto_submit_bulks": True}),
    ("DELETE", "/api/musicbrainz/lookups/9", None),
])
def test_a_member_who_is_not_the_library_owner_is_refused_and_nothing_runs(method, path, body):
    corrections, lookups = Corrections(), Lookups()
    member = actor_with("catalogue.enrichment.request", "library.problems.read", "library.metadata_matches.review",
                        owner=False)

    status, _payload = request(app(member, corrections, lookups), method, path, json_body=body)

    assert status == 403
    assert corrections.calls == [] and lookups.calls == []


@pytest.mark.parametrize("action,method", [("undo", "undo_album"), ("approve", "approve_album"),
                                           ("skip", "skip_album")])
def test_album_decisions_name_only_the_album_and_the_actor_comes_from_the_session(action, method):
    corrections = Corrections()

    status, payload = request(app(corrections=corrections), "POST", f"/api/musicbrainz/corrections/albums/{action}",
                              json_body={"album_key": "lumor"})

    assert (status, payload) == (200, {"decided": 2})
    assert corrections.calls == [(method, {"album_key": "lumor", "actor_account_id": 7})]


@pytest.mark.parametrize("path,body", [
    ("/api/musicbrainz/corrections/albums/undo", {}),
    ("/api/musicbrainz/corrections/albums/undo", {"album_key": 5}),
    ("/api/musicbrainz/corrections/albums/undo", {"album_key": "lumor", "rows": []}),
    ("/api/musicbrainz/corrections/albums/delete", {"album_key": "lumor"}),
])
def test_album_decisions_reject_anything_but_one_album_key_and_a_known_action(path, body):
    corrections = Corrections()

    assert request(app(corrections=corrections), "POST", path, json_body=body)[0] == 400
    assert corrections.calls == []


def test_an_album_with_nothing_to_change_is_not_found():
    assert request(app(), "POST", "/api/musicbrainz/corrections/albums/skip", json_body={"album_key": "other"})[0] == 404


@pytest.mark.parametrize("kind", ["track_artist_renamed", "track_artist_joined", "album_artist_renamed",
                                  "album_artist_joined", "case", "whole_album", "nonsense"])
def test_artist_automatic_and_unknown_kinds_are_refused_as_a_kind(kind):
    corrections = Corrections()

    assert request(app(corrections=corrections), "POST", f"/api/musicbrainz/corrections/kinds/{kind}/approve",
                   json_body={})[0] == 400
    assert corrections.calls == []


def test_a_review_kind_is_approved_whole():
    corrections = Corrections()

    status, payload = request(app(corrections=corrections), "POST",
                              "/api/musicbrainz/corrections/kinds/edition_suffix/approve", json_body={})

    assert (status, payload) == (200, {"decided": 5})
    assert corrections.calls == [("approve_kind", {"kind": "edition_suffix", "actor_account_id": 7})]


def test_the_edits_queue_lists_kinds_and_pages_albums_without_private_fields():
    corrections = Corrections()

    status, kinds = request(app(corrections=corrections), "GET", "/api/musicbrainz/corrections/edits?section=review")
    after = quote(json.dumps(["lumor ïvel", "album-0"]))
    _status, page = request(app(corrections=corrections), "GET",
                            f"/api/musicbrainz/corrections/edits/case?section=applied&after={after}&limit=1")

    assert status == 200
    assert kinds["kinds"] == [{"kind": "case", "albums": 1, "rows": 2}]
    assert kinds["settings"] == {"auto_submit_bulks": True, "next_run_at": NOW.isoformat()}
    assert [album["album_key"] for album in page["albums"]] == ["album-1"]
    assert json.loads(page["next_after"]) == ["lumor ïvel", "album-1"]
    assert "sort_title" not in page["albums"][0]
    for bad in ("nonsense", '["only one"]', '[1, 2]', '["a", "\\u0000"]'):
        assert request(app(), "GET", f"/api/musicbrainz/corrections/edits/case?after={quote(bad)}")[0] == 400
    assert "private" not in page["albums"][0]["rows"][0]
    assert request(app(), "GET", "/api/musicbrainz/corrections/edits?section=all")[0] == 400


@pytest.mark.parametrize("body", [{}, {"auto_submit_bulks": "true"}, {"auto_submit_bulks": 1},
                                  {"auto_submit_bulks": True, "next_run_at": "now"}])
def test_auto_submit_bulks_takes_exactly_one_boolean(body):
    corrections = Corrections()

    status, _payload = request(app(corrections=corrections), "PUT", "/api/musicbrainz/corrections/settings",
                               json_body=body)

    assert status == 400 and corrections.calls == []


def test_auto_submit_bulks_is_saved_by_the_session_actor():
    corrections = Corrections()

    status, payload = request(app(corrections=corrections), "PUT", "/api/musicbrainz/corrections/settings",
                              json_body={"auto_submit_bulks": True})

    assert (status, payload["settings"]["auto_submit_bulks"]) == (200, True)
    assert corrections.calls == [("save_settings", {"auto_submit_bulks": True, "actor_account_id": 7})]


def test_a_failing_store_is_unavailable_not_an_error_page():
    status, payload = request(app(corrections=Corrections(fail=True)), "POST",
                              "/api/musicbrainz/corrections/albums/undo", json_body={"album_key": "lumor"})

    assert status == 503 and payload["detail"] == "MusicBrainz corrections are unavailable."


def test_only_a_waiting_lookup_is_removed():
    lookups = Lookups()

    assert request(app(lookups=lookups), "DELETE", "/api/musicbrainz/lookups/9")[0] == 200
    assert request(app(lookups=lookups), "DELETE", "/api/musicbrainz/lookups/8")[0] == 404
    assert lookups.calls == [("remove_queued_lookup", {"request_id": 9}), ("remove_queued_lookup", {"request_id": 8})]


def _pf_request(corrections, *, owner=True):
    actor = SimpleNamespace(account_id=3, current_library_id=1,
                            library_relationships=(SimpleNamespace(library_id=1, is_primary_owner=owner),))
    return SimpleNamespace(state=SimpleNamespace(current_actor=actor), app=SimpleNamespace(state=SimpleNamespace(
        musicbrainz_correction_service=corrections, config={}, logger=logging.getLogger("test"))))


def test_one_album_correction_returns_its_stored_rows():
    corrections = Corrections()

    status, payload = request(app(corrections=corrections), "GET", "/api/musicbrainz/corrections?album_key=lumor")

    assert status == 200
    assert payload["correction"] == {"album_key": "lumor", "correction_count": 1, "corrections": [CORRECTION]}
    assert corrections.calls == [("get_correction", {"album_key": "lumor"})]
    assert request(app(corrections=corrections), "GET", "/api/musicbrainz/corrections?album_key=none")[0] == 404


SAMPLE = {**ALBUM, "album_key": "sample", "album_title": "The Sample", "artist_name": "The Example Project"}


def _page():
    return {"items": [{"key": "lumor::year::1974", "name": "Lumor Ïvel", "problem_reasons": ["Missing year"],
                       "detail_loaded": False},
                      {"key": "musicbrainz-artist:7", "entity_kind": "artist", "name": "Axxis"}], "count": 2,
            "initial_detail": {"key": "lumor::year::1974", "problem_reasons": ["Missing year"]}}


def test_listed_albums_gain_the_label_from_stored_counts_only():
    corrections = Corrections([ALBUM, SAMPLE])
    payload = _page()

    project_correction_problems_into_problematic_files(_pf_request(corrections), payload)

    assert corrections.calls == [("list_correction_summaries", {"album_keys": ["lumor", "lumor"], "offset": 0,
                                                                 "limit": None})]
    listed = payload["items"][0]
    assert listed["problem_reasons"] == ["Missing year", "Data Correction Needed"]
    assert listed["musicbrainz_correction"] == {"album_key": "lumor", "correction_count": 1}
    assert payload["initial_detail"]["problem_reasons"] == ["Missing year", "Data Correction Needed"]
    assert payload["musicbrainz_correction_album_count"] == 2


def test_correction_only_albums_never_enlarge_the_complete_list():
    without = _page()
    project_correction_problems_into_problematic_files(_pf_request(Corrections([])), without)
    many = [{**ALBUM, "album_key": f"album-{number}", "album_title": f"Album {number}"} for number in range(5000)]
    payload = _page()

    project_correction_problems_into_problematic_files(_pf_request(Corrections([ALBUM, *many])), payload)

    assert len(payload["items"]) == len(without["items"]) == payload["count"] == 2
    # Only the label, its count and the total grow the response, by a fixed amount.
    growth = len(json.dumps(payload)) - len(json.dumps(without))
    assert 0 < growth < 400


def test_correction_only_albums_come_in_pages():
    corrections = Corrections([ALBUM, SAMPLE])

    status, first = request(app(corrections=corrections), "GET", "/api/musicbrainz/corrections/albums?offset=0&limit=1")
    _status, second = request(app(corrections=corrections), "GET", "/api/musicbrainz/corrections/albums?offset=1&limit=1")

    assert status == 200
    assert [item["key"] for item in first["items"]] == ["musicbrainz-correction:lumor"]
    assert (first["total"], first["next_offset"], second["next_offset"]) == (2, 1, None)
    row = second["items"][0]
    # The response names the cover by an opaque reference, never by its path.
    assert "cover_path" not in row and row.pop("cover_ref")
    assert row == {
        "key": "musicbrainz-correction:sample", "entity_kind": "musicbrainz_correction", "name": "The Sample",
        "album_artist": "The Example Project", "year": 1974,
        "problem_reasons": ["Data Correction Needed"],
        "musicbrainz_correction": {"album_key": "sample", "correction_count": 1},
        "detail_loaded": False,
    }


@pytest.mark.parametrize("query", ["offset=-1", "limit=0", "limit=201"])
def test_pages_are_bounded(query):
    assert request(app(), "GET", f"/api/musicbrainz/corrections/albums?{query}")[0] == 400


def test_a_loaded_detail_keeps_its_label_and_correction():
    corrections = Corrections()
    detail = {"key": "lumor", "problem_reasons": ["Missing year"]}

    project_correction_into_problematic_detail(_pf_request(corrections), detail)

    assert detail["problem_reasons"] == ["Missing year", "Data Correction Needed"]
    assert detail["musicbrainz_correction"]["corrections"] == [CORRECTION]
    assert corrections.calls == [("get_correction", {"album_key": "lumor"})]


def test_a_loaded_detail_with_only_automatic_changes_gets_no_label():
    automatic = {**CORRECTION, "field": "title", "kind": "case", "mode": "auto", "state": "applied"}
    corrections = Corrections([{**ALBUM, "corrections": [automatic]}])
    detail = {"key": "lumor", "problem_reasons": ["Missing year"]}

    project_correction_into_problematic_detail(_pf_request(corrections), detail)

    assert detail == {"key": "lumor", "problem_reasons": ["Missing year"]}


def test_non_owners_and_failures_leave_problematic_files_unchanged():
    payload = {"items": [{"key": "a", "name": "A"}], "count": 1}

    for request_ in (_pf_request(Corrections(), owner=False), _pf_request(Corrections(fail=True))):
        project_correction_problems_into_problematic_files(request_, payload)
        assert payload == {"items": [{"key": "a", "name": "A"}], "count": 1}
