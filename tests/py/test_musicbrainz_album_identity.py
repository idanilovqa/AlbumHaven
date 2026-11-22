"""The owner's manual album identity: "Assign artist" for an undecided split album (row approved
2026-11-21). MusicBrainz Info saves through the same service."""
from __future__ import annotations

from contextlib import nullcontext
from datetime import datetime, timezone

import pytest

from music_app.services.musicbrainz_album_identity_postgres import MusicBrainzAlbumIdentityPostgresRepository
from music_app.services.private_route_boundary import private_action_for_route
from tests.py.asgi_testing import collect_route_paths
from tests.py.test_musicbrainz_enrichment_asgi import actor_with, app_for
from tests.py.test_musicbrainz_lookup_asgi import Service as LookupService
from tests.py.test_musicbrainz_lookup_asgi import request

NOW = datetime(2026, 11, 22, 12, 0, tzinfo=timezone.utc)
NORWAY = "166ef05e-53f7-44b8-a5d5-3944c188e12d"
PATH = "/api/musicbrainz/albums/artist"
TARGET = {"library_id": 1, "album_key": "ark", "local_artist_id": 12, "local_artist_name": "Ark",
          "canonical_name": "Ark", "match_state": "per_album", "decided": False}


class _Connection:
    def __init__(self, target=TARGET):
        self.target, self.calls = target, []

    def __enter__(self):
        return self

    def __exit__(self, *_error):
        return None

    def transaction(self):
        return nullcontext()

    def execute(self, sql, params=None):
        flat = " ".join(sql.lower().split())
        self.calls.append((flat, params))
        row = None
        if "as album_artist" in flat:
            row = self.target and {"local_artist_id": self.target["local_artist_id"]}
        elif "as decided" in flat:
            row = self.target
        elif "insert into library.local_album_artist_identities" in flat:
            row = {"album_key": "ark"}
        return type("Cursor", (), {"fetchone": lambda _self: row})()

    def writes(self):
        return [sql for sql, _params in self.calls if sql.startswith(("insert", "delete", "update"))]


def _assign(connection, queued=None):
    repository = MusicBrainzAlbumIdentityPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/album_haven_test"},
        connect=lambda _url: connection,
        queue_album_releases=(lambda **values: queued.append(values)) if queued is not None else (lambda **_values: None))
    return repository.assign_suggested_artist(
        album_key="ark", artist_mbid=NORWAY, actor_account_id=3, observed_at=NOW, request_ref="r1")


def test_assign_stores_a_manual_identity_for_that_album_only():
    connection, queued = _Connection(), []

    assert _assign(connection, queued) == "assigned"

    writes = connection.writes()
    identity = next(sql for sql in writes if "local_album_artist_identities" in sql)
    assert "'manual'" in identity
    assert "on conflict (library_id, album_key) do nothing" in identity, "an existing choice is never changed"
    assert not any("local_artist_musicbrainz_matches" in sql for sql in writes), "the artist's match is untouched"
    assert not any("local_tracks" in sql or "local_track_files" in sql for sql in writes), "no tag or file"
    for sql, params in connection.calls:
        if sql.startswith(("insert", "delete", "update")) and "album_key" in sql:
            assert params["album_key"] == "ark"
    assert any("insert into app.security_audit_events" in sql for sql in writes)
    assert any(sql.startswith("delete from library.local_album_artist_suggestions") for sql in writes)
    assert [item["local_artist_id"] for item in queued] == [12]


def test_the_artist_s_lock_is_taken_before_the_album_is_read_for_the_decision():
    connection = _Connection()
    _assign(connection)

    lock = next(n for n, (sql, _p) in enumerate(connection.calls) if "pg_advisory_xact_lock" in sql)
    decision = next(n for n, (sql, _p) in enumerate(connection.calls) if "as decided" in sql)
    assert lock < decision
    decided_by = connection.calls[decision][0]
    assert "for update of albums" in decided_by
    assert "library.metadata_matches.review" in decided_by, "the actor is checked in the transaction"


@pytest.mark.parametrize("change", [
    {"decided": True}, {"match_state": "matched"}, {"canonical_name": None},
], ids=["already decided or chosen", "no longer split", "not one of the proposed artists"])
def test_an_album_that_changed_is_refused_and_nothing_is_written(change):
    connection, queued = _Connection({**TARGET, **change}), []

    assert _assign(connection, queued) == "changed"
    assert connection.writes() == [] and queued == []


def test_an_unknown_album_is_not_found():
    connection = _Connection(None)
    assert _assign(connection) == "not_found"
    assert connection.writes() == []


def test_an_artist_named_unlike_the_tag_marks_the_album_for_data_correction():
    for canonical, differs in (("Ark", False), ("Noah's Vessel", True)):
        connection = _Connection({**TARGET, "canonical_name": canonical})
        _assign(connection)
        params = next(p for sql, p in connection.calls
                      if sql.startswith("insert into library.local_album_artist_identities"))
        assert params["tag_differs"] is differs


def test_a_failed_release_lookup_queue_never_undoes_the_assignment():
    def fail(**_values):
        raise RuntimeError("database unavailable")

    repository = MusicBrainzAlbumIdentityPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/album_haven_test"},
        connect=lambda _url: _Connection(), queue_album_releases=fail)
    assert repository.assign_suggested_artist(
        album_key="ark", artist_mbid=NORWAY, actor_account_id=3, observed_at=NOW, request_ref="r1") == "assigned"


class _Identities:
    def __init__(self, result="assigned"):
        self.result, self.calls = result, []

    def assign_suggested_artist(self, **values):
        self.calls.append(values)
        if self.result == "fail":
            raise RuntimeError("database unavailable")
        return self.result


def _app(identities, actor=None):
    built = app_for(actor or actor_with("library.metadata_matches.review"), LookupService())
    built.state.musicbrainz_album_identity_repository = identities
    return built


def _put(identities, body, actor=None):
    return request(_app(identities, actor), "PUT", PATH, json_body=body)


def test_the_route_needs_the_metadata_review_capability():
    assert PATH in collect_route_paths(_app(_Identities()))
    assert private_action_for_route("PUT", PATH) == "library.metadata_matches.review"


def test_assign_takes_the_actor_from_the_session():
    identities = _Identities()

    status, payload = _put(identities, {"album_key": "ark", "artist_mbid": NORWAY.upper()})

    assert (status, payload) == (200, {"assigned": True})
    (call,) = identities.calls
    assert (call["album_key"], call["artist_mbid"]) == ("ark", NORWAY)
    assert call["actor_account_id"] and call["request_ref"]


@pytest.mark.parametrize("body", [
    None, {}, {"album_key": "ark"}, {"album_key": "", "artist_mbid": NORWAY}, {"album_key": 4, "artist_mbid": NORWAY},
    {"album_key": "ark", "artist_mbid": "not-an-mbid"}, {"album_key": "ark", "artist_mbid": NORWAY, "actor": 1},
])
def test_anything_but_one_album_and_one_artist_is_refused(body):
    identities = _Identities()
    assert _put(identities, body)[0] == 400
    assert identities.calls == []


@pytest.mark.parametrize("result,status", [("changed", 409), ("not_found", 404), ("fail", 503)])
def test_failures_are_readable(result, status):
    assert _put(_Identities(result), {"album_key": "ark", "artist_mbid": NORWAY})[0] == status


@pytest.mark.parametrize("actor", [
    actor_with("library.metadata_matches.review", owner=False),
    actor_with("library.browse.read"),
], ids=["not the owner", "no capability"])
def test_without_permission_nothing_is_written(actor):
    identities = _Identities()
    assert _put(identities, {"album_key": "ark", "artist_mbid": NORWAY}, actor)[0] == 403
    assert identities.calls == []
