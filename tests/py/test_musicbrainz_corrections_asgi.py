"""Routes and Problematic Files rows for MusicBrainz data corrections (Delivery 2, S4)."""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from music_app.routes.musicbrainz_corrections_asgi import (
    load_problematic_correction_items,
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
    ("/api/musicbrainz/corrections", "GET", "library.problems.read"),
    ("/api/musicbrainz/corrections/queue", "GET", "library.problems.read"),
    ("/api/musicbrainz/corrections/queue", "POST", "library.metadata_matches.review"),
    ("/api/musicbrainz/corrections/queue/{entry_id}", "DELETE", "library.metadata_matches.review"),
    ("/api/musicbrainz/corrections/settings", "PUT", "library.metadata_matches.review"),
    ("/api/musicbrainz/lookups/{request_id}", "DELETE", "catalogue.enrichment.request"),
]
CORRECTION = {"field": "album_artist", "label": "Album artist", "current": "Christian Vander",
              "proposed": "Magma", "tracks": []}
ALBUM = {"album_key": "wurdah", "album_title": "Wurdah Ïtah", "artist_name": "Christian Vander", "year": 1974,
         "cover_path": "covers/wurdah.jpg", "track_count": 12, "file_types": ["FLAC"], "release_mbid": RELEASE, "queued_at": None,
         "corrections": [dict(CORRECTION)]}


class Corrections:
    def __init__(self, albums=(ALBUM,), *, fail=False):
        self.albums = [dict(album) for album in albums]
        self.fail = fail
        self.calls = []

    def list_correction_summaries(self):
        self.calls.append(("list_correction_summaries", {}))
        if self.fail:
            raise RuntimeError("database unavailable")
        return [{**{key: value for key, value in album.items() if key not in {"corrections", "track_count", "file_types"}},
                 "correction_count": len(album["corrections"])} for album in self.albums]

    def get_correction(self, *, album_key):
        self.calls.append(("get_correction", {"album_key": album_key}))
        if self.fail:
            raise RuntimeError("database unavailable")
        return next((album for album in self.albums if album["album_key"] == album_key), None)

    def queue_correction(self, *, album_key, actor_account_id):
        self.calls.append(("queue_correction", {"album_key": album_key, "actor_account_id": actor_account_id}))
        if self.fail:
            raise RuntimeError("database unavailable")
        return {"entry_id": 4, "queued_at": NOW.isoformat()} if album_key == "wurdah" else None

    def list_queue(self):
        return {"items": [{**ALBUM, "entry_id": 4, "queued_at": NOW.isoformat(), "queued_by_account_id": 7,
                           "corrections": [{**CORRECTION, "private": "x"}]}],
                "settings": {"auto_submit_bulks": True, "next_run_at": NOW.isoformat(), "changed_by": 7}}

    def remove_queued(self, *, entry_id):
        self.calls.append(("remove_queued", {"entry_id": entry_id}))
        return entry_id == 4

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
    ("GET", "/api/musicbrainz/corrections?album_key=wurdah", None),
    ("GET", "/api/musicbrainz/corrections/queue", None),
    ("POST", "/api/musicbrainz/corrections/queue", {"album_key": "wurdah"}),
    ("DELETE", "/api/musicbrainz/corrections/queue/4", None),
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


def test_add_to_queue_names_only_the_album_and_the_actor_comes_from_the_session():
    corrections = Corrections()

    status, payload = request(app(corrections=corrections), "POST", "/api/musicbrainz/corrections/queue",
                              json_body={"album_key": "wurdah"})

    assert (status, payload) == (201, {"entry_id": 4, "queued_at": NOW.isoformat()})
    assert corrections.calls == [("queue_correction", {"album_key": "wurdah", "actor_account_id": 7})]


@pytest.mark.parametrize("body", [
    {}, {"album_key": ""}, {"album_key": 5}, {"album_key": "wurdah", "corrections": [CORRECTION]},
    {"album_key": "x" * 1025},
])
def test_add_to_queue_rejects_anything_but_one_album_key(body):
    corrections = Corrections()

    status, _payload = request(app(corrections=corrections), "POST", "/api/musicbrainz/corrections/queue",
                               json_body=body)

    assert status == 400 and corrections.calls == []


def test_an_album_without_a_correction_is_not_queued():
    status, _payload = request(app(), "POST", "/api/musicbrainz/corrections/queue", json_body={"album_key": "agrees"})

    assert status == 404


def test_the_queue_lists_entries_and_settings_without_private_fields():
    status, payload = request(app(), "GET", "/api/musicbrainz/corrections/queue")

    assert status == 200
    (item,) = payload["items"]
    assert "queued_by_account_id" not in item and "private" not in item["corrections"][0]
    assert (item["entry_id"], item["album_title"], item["corrections"][0]["proposed"]) == (4, "Wurdah Ïtah", "Magma")
    assert payload["settings"] == {"auto_submit_bulks": True, "next_run_at": NOW.isoformat()}


def test_removing_an_entry_and_a_missing_entry():
    corrections = Corrections()

    assert request(app(corrections=corrections), "DELETE", "/api/musicbrainz/corrections/queue/4")[0] == 200
    assert request(app(corrections=corrections), "DELETE", "/api/musicbrainz/corrections/queue/5")[0] == 404


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
    status, payload = request(app(corrections=Corrections(fail=True)), "POST", "/api/musicbrainz/corrections/queue",
                              json_body={"album_key": "wurdah"})

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


def test_one_album_correction_is_compared_when_opened():
    corrections = Corrections()

    status, payload = request(app(corrections=corrections), "GET", "/api/musicbrainz/corrections?album_key=wurdah")

    assert status == 200
    assert payload["correction"] == {"album_key": "wurdah", "release_mbid": RELEASE, "queued_at": None,
                                     "correction_count": 1, "corrections": [CORRECTION], "track_count": 12,
                                     "file_types": ["FLAC"]}
    assert corrections.calls == [("get_correction", {"album_key": "wurdah"})]
    assert request(app(corrections=corrections), "GET", "/api/musicbrainz/corrections?album_key=none")[0] == 404


def test_the_list_reads_stored_counts_and_never_compares():
    corrections = Corrections()
    payload = {"items": [{"key": "a", "name": "A"}], "count": 1}

    project_correction_problems_into_problematic_files(_pf_request(corrections), payload)

    assert corrections.calls == [("list_correction_summaries", {})]


def test_the_bounded_first_page_labels_listed_albums_but_adds_no_rows():
    payload = {"items": [{"key": "wurdah", "name": "Wurdah Ïtah", "problem_reasons": []}], "count": 1,
               "complete": False}
    secret = {**ALBUM, "album_key": "secret", "album_title": "The Secret"}

    project_correction_problems_into_problematic_files(_pf_request(Corrections([ALBUM, secret])), payload)

    assert [item["key"] for item in payload["items"]] == ["wurdah"]
    assert payload["items"][0]["problem_reasons"] == ["Data Correction Needed"]


def test_a_listed_album_gains_the_label_and_another_album_is_added_by_name():
    secret = {**ALBUM, "album_key": "secret", "album_title": "The Secret", "artist_name": "The Alan Parsons Project"}
    payload = {"items": [{"key": "wurdah::year::1974", "name": "Wurdah Ïtah", "problem_reasons": ["Missing year"],
                          "detail_loaded": False},
                         {"key": "musicbrainz-artist:7", "entity_kind": "artist", "name": "Axxis"}], "count": 2,
               "initial_detail": {"key": "wurdah::year::1974", "problem_reasons": ["Missing year"]}}

    project_correction_problems_into_problematic_files(_pf_request(Corrections([ALBUM, secret])), payload)

    assert [item["key"] for item in payload["items"]] == [
        "musicbrainz-artist:7", "musicbrainz-correction:secret", "wurdah::year::1974"]
    _artist, added, listed = payload["items"]
    assert listed["problem_reasons"] == ["Missing year", "Data Correction Needed"]
    assert listed["musicbrainz_correction"] == {"album_key": "wurdah", "release_mbid": RELEASE, "queued_at": None,
                                                "correction_count": 1}
    assert payload["initial_detail"]["problem_reasons"] == ["Missing year", "Data Correction Needed"]
    assert added == {
        "key": "musicbrainz-correction:secret", "entity_kind": "musicbrainz_correction", "name": "The Secret",
        "album_artist": "The Alan Parsons Project", "year": 1974, "cover_path": "covers/wurdah.jpg",
        "problem_reasons": ["Data Correction Needed"],
        "musicbrainz_correction": {"album_key": "secret", "release_mbid": RELEASE, "queued_at": None,
                                   "correction_count": 1},
        "detail_loaded": False,
    }
    assert payload["count"] == 3


def test_a_loaded_detail_keeps_its_label_and_correction():
    corrections = Corrections()
    detail = {"key": "wurdah", "problem_reasons": ["Missing year"]}

    project_correction_into_problematic_detail(_pf_request(corrections), detail)

    assert detail["problem_reasons"] == ["Missing year", "Data Correction Needed"]
    assert detail["musicbrainz_correction"]["corrections"] == [CORRECTION]
    assert corrections.calls == [("get_correction", {"album_key": "wurdah"})]


def test_non_owners_and_failures_leave_problematic_files_unchanged():
    payload = {"items": [{"key": "a", "name": "A"}], "count": 1}

    for request_ in (_pf_request(Corrections(), owner=False), _pf_request(Corrections(fail=True))):
        assert load_problematic_correction_items(request_) == []
        project_correction_problems_into_problematic_files(request_, payload)
        assert payload == {"items": [{"key": "a", "name": "A"}], "count": 1}
