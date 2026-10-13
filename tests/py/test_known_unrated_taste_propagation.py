"""Nullable taste state at pure authorized repository/DTO seams; no live DB."""
from copy import deepcopy
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from music_app.services import friends_postgres
from music_app.services import home_activity_comparison_postgres as comparison
from music_app.services import subject_home_taste as subject
from music_app.services.allowed_actions import AllowedActions


class Cursor:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return deepcopy(self.rows)


class ComparisonConnection:
    """Records snapshot writes while providing one exact canonical resource."""
    def __init__(self, kind):
        self.kind = kind
        self.updated = []
        self.calls = []
        self.page_read = False

    def execute(self, sql, params):
        self.calls.append((sql, params))
        if "select row_key,payload" in sql:
            if self.page_read:
                return Cursor([])
            self.page_read = True
            return Cursor([{"row_key": f"{self.kind}:23", "payload": {
                "yours": {"listen_count": 3, "rating": None, "favorite": None},
                "friend": {"listen_count": 2, "rating": None, "favorite": None},
            }}])
        if "update app.activity_snapshot_rows set payload" in sql:
            self.updated.append(deepcopy(params[0].obj))
        return Cursor([])


def materialize(monkeypatch, facts, *, kind="tracks", readable=True):
    singular = "track" if kind == "tracks" else "album"
    connection = ComparisonConnection(singular)
    observed = []
    monkeypatch.setattr(friends_postgres, "read_friend_taste_page", lambda *args, **kwargs: {"rows": [], "next_after": None})

    def load(connection, **kwargs):
        observed.append(kwargs)
        return {"items": {23: deepcopy(facts)}}

    monkeypatch.setattr(friends_postgres, "load_friend_taste", load)
    monkeypatch.setattr(comparison, "_resources", lambda *args: {23: [(singular, 23)]})
    actions = AllowedActions(("library.social.history.read", "library.social.taste.read") if readable else ())
    comparison.finalize_comparison(connection, snapshot_id=91,
        scope=SimpleNamespace(account_id=11, library_id=17, source_account_id=19),
        query=SimpleNamespace(kind=kind), project=SimpleNamespace(policy=lambda *args: actions),
        secret=b"known-unrated-fixture-only", window=SimpleNamespace(start=datetime(2026, 10, 1, tzinfo=timezone.utc)))
    assert observed == [{"account_id": 11, "library_id": 17, "target_account_id": 19, "kind": kind, "resource_ids": [23]}]
    return connection


@pytest.mark.parametrize("kind,positive", [("tracks", 5), ("albums", 10)])
@pytest.mark.parametrize("unrated_side", ["own", "friend"])
def test_comparison_materialization_preserves_each_authorized_nullable_taste_state(monkeypatch, kind, positive, unrated_side):
    facts = {"own_rating": positive, "friend_rating": positive,
        "own_taste_state": "available", "friend_taste_state": "available"}
    facts[f"{unrated_side}_rating"] = None
    connection = materialize(monkeypatch, facts, kind=kind)
    assert len(connection.updated) == 1
    payload = connection.updated[0]
    for side, prefix in (("yours", "own"), ("friend", "friend")):
        assert payload[side]["taste_state"] == "available"
        assert payload[side]["rating"] == (None if prefix == unrated_side else positive)
    assert payload["yours"]["listen_count"] == 3
    assert payload["friend"]["listen_count"] == 2


@pytest.mark.parametrize("state", ["unavailable", "denied", None])
def test_comparison_does_not_borrow_available_taste_from_the_other_side(monkeypatch, state):
    connection = materialize(monkeypatch, {"own_rating": None, "own_taste_state": "available",
        "friend_rating": None, "friend_taste_state": state})
    payload = connection.updated[0]
    assert payload["yours"]["rating"] is None and payload["yours"]["taste_state"] == "available"
    assert payload["friend"]["rating"] is None
    assert payload["friend"].get("taste_state") != "available"


def test_comparison_cannot_publish_known_unrated_when_resource_taste_authority_is_denied(monkeypatch):
    connection = materialize(monkeypatch, {"own_rating": None, "friend_rating": None,
        "own_taste_state": "available", "friend_taste_state": "available"}, readable=False)
    assert connection.updated == []
    assert comparison._zero_side()["rating"] is None
    assert comparison._zero_side().get("taste_state") != "available"


def test_subject_album_existing_unrated_row_is_available_but_absent_identity_stays_absent():
    class Connection:
        def execute(self, sql, params):
            self.params = params
            return Cursor([{"id": 23, "rating": None}])

    connection = Connection()
    result = subject.load_subject_album_taste(connection, account_id=19, library_id=17, album_ids=[23, 24])
    assert result == {23: {"rating": None, "favorite": None, "taste_state": "available"}}
    assert connection.params == (19, 17, [23, 24])
    assert 24 not in result


def test_subject_track_known_null_requires_matching_native_preference_receipt(monkeypatch):
    class Connection:
        def execute(self, sql, params):
            assert params == (17, [23, 24, 25])
            return Cursor([{"id": 23, "track_key": "unrated"}, {"id": 24, "track_key": "missing"}, {"id": 25, "track_key": "conflict"}])

    scopes = []

    def preferences(connection, keys, **scope):
        scopes.append((keys, scope))
        return {"unrated": {"track_id": 23, "rating": None, "love_tier": "off"},
            "conflict": {"track_id": 26, "rating": None, "love_tier": "off"}}

    monkeypatch.setattr(subject, "load_track_preferences_on_connection", preferences)
    result = subject.load_subject_track_taste(Connection(), account_id=19, library_id=17, track_ids=[23, 24, 25])
    assert result == {23: {"rating": None, "love_tier": "off", "taste_state": "available"}}
    assert scopes == [(["unrated", "missing", "conflict"], {"account_id": 19, "library_id": 17})]
