"""Routes for the owner's manual MusicBrainz lookups (Delivery 2, S5)."""
from __future__ import annotations

import json

import pytest

from music_app.services.private_route_boundary import private_action_for_route
from urllib.parse import parse_qsl

from tests.py.asgi_testing import collect_route_paths, decode_json, run_asgi_request
from tests.py.test_musicbrainz_enrichment_asgi import Service as ArtistService
from tests.py.test_musicbrainz_enrichment_asgi import actor_with, app_for

MBID = "6f3c2a1e-0000-4000-8000-00000000b51d"
LOOKUP_ROUTES = [
    ("/api/musicbrainz/lookups", "POST", "catalogue.enrichment.request"),
    ("/api/musicbrainz/lookups", "GET", "library.problems.read"),
    ("/api/musicbrainz/lookups/target?album_key=k1", "GET", "library.problems.read"),
    ("/api/musicbrainz/lookups/batches/5", "GET", "library.problems.read"),
    ("/api/musicbrainz/lookups/batches/5/dismiss", "POST", "catalogue.enrichment.request"),
]
BATCH = {"batch_id": 5, "started_at": "2026-11-16T10:00:00+00:00", "finished_at": None, "total": 2, "matched": 1,
         "not_matched": 0, "artists": 1, "albums": 1, "single_title": None, "single_artist_name": None,
         "single_target_kind": None, "single_outcome": None, "single_problem_label": None}
ITEM = {"request_id": 9, "target_kind": "album", "local_artist_id": 41, "artist_name": "Dream Theater",
        "album_key": "k1", "album_title": "Octavarium", "year": 2005, "state": "finished", "outcome": "matched",
        "result_mbid": MBID, "problem_label": None, "problem_occurrence_id": None}


class Service(ArtistService):
    def request_lookup(self, **kwargs):
        self.calls.append(("request_lookup", kwargs))
        if kwargs.get("album_key") == "missing":
            return None
        return {"request_id": 9, "state": "queued", "batch_id": None, "library_id": 23}

    def list_lookups(self):
        self.calls.append(("list_lookups", {}))
        return {"queued": [{"request_id": 9, "target_kind": "artist", "local_artist_id": 41,
                            "artist_name": "Ktzat Acheret", "album_key": None, "album_title": None, "year": None,
                            "requested_at": "2026-11-16T09:00:00+00:00", "requested_by_account_id": 7}],
                "queue_starts_at": "2026-11-16T10:00:00+00:00",
                "batches": [{**BATCH, "library_id": 23}]}

    def lookup_target(self, *, album_key):
        self.calls.append(("lookup_target", {"album_key": album_key}))
        if album_key != "k1":
            return None
        return {"album_key": "k1", "local_artist_id": 41, "artist_name": "Dream Theater",
                "artist_has_mbid": True, "album_has_mbid": False, "library_id": 23}

    def get_lookup_batch(self, *, batch_id):
        self.calls.append(("get_lookup_batch", {"batch_id": batch_id}))
        return {**BATCH, "items": [{**ITEM, "job_id": 77}]} if batch_id == 5 else None

    def dismiss_lookup_batch(self, *, batch_id):
        self.calls.append(("dismiss_lookup_batch", {"batch_id": batch_id}))
        return {"dismissed": batch_id == 5}


def request(app, method, path, *, json_body=None):
    path, _sep, query = path.partition("?")
    status, _headers, body = run_asgi_request(app, method, path, json_body=json_body,
                                              query=dict(parse_qsl(query)) or None)
    return status, decode_json(body)


def owner():
    return actor_with("catalogue.enrichment.request", "library.problems.read")


def test_lookup_routes_are_registered_with_the_musicbrainz_owner_capabilities():
    paths = collect_route_paths(app_for(owner(), Service()))
    for path, method, capability in LOOKUP_ROUTES:
        route = path.split("?")[0].replace("/5", "/{batch_id}")
        assert route in paths
        assert private_action_for_route(method, route) == capability


@pytest.mark.parametrize("body", [
    {"target_kind": "album", "mode": "queue", "album_key": "k1"},
    {"target_kind": "artist", "mode": "queue", "album_key": "k1"},
    {"target_kind": "artist", "mode": "search", "local_artist_id": 41},
])
def test_a_lookup_names_one_artist_or_album_and_the_actor_comes_from_the_session(body):
    service = Service()
    status, payload = request(app_for(owner(), service), "POST", "/api/musicbrainz/lookups", json_body=body)

    assert status == 202
    assert payload == {"request_id": 9, "state": "queued", "batch_id": None}
    assert service.calls == [("request_lookup", {**body, "actor_account_id": 7})]


@pytest.mark.parametrize("body", [
    {},
    {"target_kind": "album", "mode": "queue"},
    {"target_kind": "album", "mode": "queue", "local_artist_id": 41},
    {"target_kind": "artist", "mode": "queue", "local_artist_id": True},
    {"target_kind": "artist", "mode": "queue", "local_artist_id": 0},
    {"target_kind": "artist", "mode": "queue", "local_artist_id": 41, "album_key": "k1"},
    {"target_kind": "artist", "mode": "queue", "local_artist_id": 41, "library_id": 99},
    {"target_kind": "release", "mode": "queue", "album_key": "k1"},
    {"target_kind": "album", "mode": "now", "album_key": "k1"},
    {"target_kind": "album", "mode": "queue", "album_key": "  "},
])
def test_an_invalid_lookup_request_is_rejected_before_the_service(body):
    service = Service()
    status, payload = request(app_for(owner(), service), "POST", "/api/musicbrainz/lookups", json_body=body)

    assert status == 400
    assert payload == {"detail": "Invalid MusicBrainz lookup request."}
    assert service.calls == []


def test_an_unknown_album_is_not_found():
    status, _payload = request(app_for(owner(), Service()), "POST", "/api/musicbrainz/lookups",
                               json_body={"target_kind": "album", "mode": "search", "album_key": "missing"})
    assert status == 404


def test_the_queue_batches_and_one_batch_return_only_their_safe_fields():
    app = app_for(owner(), Service())

    list_status, listed = request(app, "GET", "/api/musicbrainz/lookups")
    batch_status, batch = request(app, "GET", "/api/musicbrainz/lookups/batches/5")
    target_status, target = request(app, "GET", "/api/musicbrainz/lookups/target?album_key=k1")

    assert list_status == batch_status == target_status == 200
    assert listed["queued"][0]["artist_name"] == "Ktzat Acheret"
    assert listed["queue_starts_at"] == "2026-11-16T10:00:00+00:00"
    assert listed["batches"] == [BATCH]
    assert batch == {"batch": {**BATCH, "items": [ITEM]}}
    assert target == {"target": {"album_key": "k1", "local_artist_id": 41, "artist_name": "Dream Theater",
                                 "artist_has_mbid": True, "album_has_mbid": False}}
    serialized = json.dumps([listed, batch, target])
    for forbidden in ("library_id", "job_id", "requested_by_account_id"):
        assert forbidden not in serialized


def test_unknown_batch_or_target_is_not_found_and_only_a_finished_card_can_be_dismissed():
    app = app_for(owner(), Service())

    assert request(app, "GET", "/api/musicbrainz/lookups/batches/6")[0] == 404
    assert request(app, "GET", "/api/musicbrainz/lookups/target?album_key=nope")[0] == 404
    assert request(app, "POST", "/api/musicbrainz/lookups/batches/6/dismiss", json_body={})[0] == 404
    assert request(app, "POST", "/api/musicbrainz/lookups/batches/5/dismiss",
                   json_body={"library_id": 99})[0] == 400
    assert request(app, "POST", "/api/musicbrainz/lookups/batches/5/dismiss", json_body={}) == (
        200, {"dismissed": True})


@pytest.mark.parametrize(("path", "method", "capability"), LOOKUP_ROUTES)
def test_each_lookup_route_denies_a_missing_capability_and_a_non_owner(path, method, capability):
    body = {"target_kind": "artist", "mode": "queue", "local_artist_id": 41} if method == "POST" else None
    for actor in (actor_with(), actor_with(capability, owner=False, membership_role="administrator")):
        service = Service()
        status, payload = request(app_for(actor, service), method, path, json_body=body)

        assert status == 403, capability
        assert payload == {"detail": "Action not permitted."}
        assert service.calls == []


def test_musicbrainz_sync_starts_the_queued_lookups_before_queueing_the_library():
    from datetime import datetime, timezone

    from music_app.services.musicbrainz_enrichment_api import MusicBrainzEnrichmentApiService

    calls = []
    now = datetime(2026, 11, 16, 9, 0, tzinfo=timezone.utc)

    class Lookups:
        def start_queued(self, **kwargs):
            calls.append(("start_queued", kwargs))

    class Repository:
        def enqueue_eligible_artists(self, **kwargs):
            calls.append(("enqueue_eligible_artists", kwargs))
            return {"enqueued_count": 3}

    service = MusicBrainzEnrichmentApiService(Repository(), None, lookups=Lookups(), now=lambda: now)

    assert service.enqueue_eligible_artists(reason="library_menu_sync") == {"enqueued_count": 3}
    assert calls == [("start_queued", {"observed_at": now, "due_only": False}),
                     ("enqueue_eligible_artists", {"reason": "library_menu_sync", "observed_at": now})]
