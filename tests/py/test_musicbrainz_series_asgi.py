"""The owner marks a MusicBrainz series as Series or Featured In from the Series tree
(Delivery 2, S6; owner 2026-11-17, 5B). "Hidden" is never offered."""
from __future__ import annotations

import pytest

from music_app.services.private_route_boundary import private_action_for_route
from tests.py.asgi_testing import collect_route_paths
from tests.py.test_musicbrainz_enrichment_asgi import actor_with, app_for
from tests.py.test_musicbrainz_lookup_asgi import Service as LookupService
from tests.py.test_musicbrainz_lookup_asgi import request

PITCHFORK = "d5471f85-4b54-45da-9de7-c9ad9843c4bd"
PATH = f"/api/musicbrainz/series/{PITCHFORK}/kind"


class Series:
    def __init__(self, *, fail=False):
        self.fail = fail
        self.calls = []

    def set_series_owner_kind(self, *, mbid, owner_kind, observed_at):
        self.calls.append((mbid, owner_kind))
        if self.fail:
            raise RuntimeError("database unavailable")
        if mbid != PITCHFORK:
            return None
        return {"mbid": mbid, "kind": owner_kind or "series", "owner_kind": owner_kind, "private": "x"}


def owner():
    return actor_with("library.metadata_matches.review")


def app(actor=None, series=None):
    built = app_for(actor or owner(), LookupService())
    built.state.musicbrainz_series_repository = series or Series()
    return built


def test_the_route_is_registered_with_the_musicbrainz_review_capability():
    assert "/api/musicbrainz/series/{mbid}/kind" in collect_route_paths(app())
    assert private_action_for_route("PUT", "/api/musicbrainz/series/{mbid}/kind") == "library.metadata_matches.review"


@pytest.mark.parametrize("kind,shown", [("featured_in", "featured_in"), ("series", "series"), (None, "series")])
def test_the_owner_marks_a_series_or_returns_it_to_the_musicbrainz_default(kind, shown):
    series = Series()

    status, payload = request(app(series=series), "PUT", PATH, json_body={"kind": kind})

    assert (status, payload) == (200, {"series": {"mbid": PITCHFORK, "kind": shown, "owner_kind": kind}})
    assert series.calls == [(PITCHFORK, kind)]


@pytest.mark.parametrize("body", [{"kind": "hidden"}, {"kind": "Featured In"}, {"kind": ""}, {"kind": 1},
                                  {"kind": ["series"]}, {}, {"kind": "series", "name": "x"}, None])
def test_hidden_and_anything_but_series_featured_in_or_null_are_refused(body):
    series = Series()

    status, _payload = request(app(series=series), "PUT", PATH, json_body=body)

    assert status == 400
    assert series.calls == []


def test_a_malformed_series_id_is_refused():
    series = Series()

    assert request(app(series=series), "PUT", "/api/musicbrainz/series/not-a-uuid/kind",
                   json_body={"kind": "series"})[0] == 400
    assert series.calls == []


def test_an_unknown_or_hidden_series_is_not_found():
    other = "00000000-0000-4000-8000-000000000001"

    assert request(app(), "PUT", f"/api/musicbrainz/series/{other}/kind", json_body={"kind": "series"})[0] == 404


@pytest.mark.parametrize("actor", [
    actor_with("library.metadata_matches.review", owner=False),
    actor_with("library.browse.read"),
])
def test_a_member_who_is_not_the_owner_or_lacks_the_capability_is_refused_and_nothing_is_written(actor):
    series = Series()

    status, _payload = request(app(actor, series), "PUT", PATH, json_body={"kind": "featured_in"})

    assert status == 403
    assert series.calls == []


def test_a_failing_store_is_unavailable_not_an_error_page():
    assert request(app(series=Series(fail=True)), "PUT", PATH, json_body={"kind": "series"})[0] == 503
