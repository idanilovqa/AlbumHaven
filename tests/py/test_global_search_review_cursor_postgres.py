"""Retained Social codec compatibility and actual Search continuation safety.

Synthetic test cursors are decrypted/resealed only through the existing shared
codec boundary. Routes issue every starting Search cursor; no Search-service
module, replacement parser, invented scope builder, or opaque-text-only oracle.
"""
from copy import deepcopy
from datetime import timedelta
from hashlib import sha256
import json
from uuid import uuid4

import pytest

from music_app.services import social_cursors
from tests.py.test_global_private_search_postgres import (
    db, isolated_urls, connect, HMAC, album_ref,
)

SECRET = HMAC["hmac"]["secret"]


@pytest.mark.parametrize("position", [None, 1, 9223372036854775807])
@pytest.mark.parametrize("scope", [["friends", 41, 73], ["activity", 41, 8, "recent"]])
def test_existing_integer_social_cursor_payload_and_roundtrip_are_unchanged(position, scope):
    token = social_cursors.encode_social_cursor(position, secret=SECRET, scope=scope)
    if position is None:
        assert token is None
        assert social_cursors.decode_social_cursor(token, secret=SECRET, scope=scope) == 0
        return
    # Also prove compatibility with an independently constructed legacy token.
    legacy = {"scope": scope, "position": position}
    fixture_token = social_cursors._cipher(SECRET).encrypt(json.dumps(legacy).encode()).decode()
    assert json.loads(social_cursors._cipher(SECRET).decrypt(token.encode())) == legacy
    assert social_cursors.decode_social_cursor(fixture_token, secret=SECRET, scope=scope) == position
    assert social_cursors.decode_social_cursor(token, secret=SECRET, scope=scope) == position
    with pytest.raises(ValueError):
        social_cursors.decode_social_cursor(token, secret=SECRET, scope=scope + ["changed"])


def open_cursor(token):
    assert isinstance(token, str) and token
    return json.loads(social_cursors._cipher(SECRET).decrypt(token.encode()))


def seal_cursor(payload):
    return social_cursors._cipher(SECRET).encrypt(json.dumps(payload).encode()).decode()


def first_cursor(db, kind):
    params = {"search_page_size": "1"}
    if kind == "detail":
        params["search_detail_album_ref"] = album_ref(db, db.main_album)
    else:
        params.update(all_artists="1", search_presentation="tracks" if kind == "tracks" else "albums")
        if kind in {"albums", "sidebar"}:
            for index in range(52 if kind == "sidebar" else 2):
                artist = db.artist("AAA Cursor Artist " + str(index).zfill(3))
                db.track(db.album(artist, "Cursor Album " + str(index)), "Cursor Witness")
    first = db.read(**params)
    field = "sidebar" if kind == "sidebar" else "page"
    assert first[field]["has_more"] is True
    return first[field]["next_cursor"], params


@pytest.mark.parametrize("kind", ["albums", "tracks", "sidebar", "detail"])
def test_decrypted_native_search_cursor_contains_safe_ids_and_digests_not_private_sort_data(db, kind):
    token, params = first_cursor(db, kind)
    payload = open_cursor(token)
    assert set(payload) == {"version", "scope", "kind", "position", "selection"}
    assert payload["version"] == 2 and type(payload["version"]) is int
    assert payload["kind"] == kind
    assert isinstance(payload["scope"], list)
    assert set(payload["position"]) == {"anchor", "pending"}
    assert set(payload["selection"]) == {"state", "artist", "witness", "pending"}

    def check(value):
        if isinstance(value, dict):
            assert not {"path", "private_path", "album_key", "track_key", "alias", "sort", "order_tuple"} & value.keys()
            if "digest" in value:
                assert set(value) == {"id", "digest", "readable"}
                assert type(value["id"]) is int and 0 < value["id"] <= 9223372036854775807
                assert len(value["digest"]) == 64 and all(c in "0123456789abcdef" for c in value["digest"])
                assert type(value["readable"]) is bool
            for item in value.values():
                check(item)
        elif isinstance(value, list):
            for item in value:
                check(item)
    check(payload)
    text = json.dumps(payload)
    for value in db.tracks.values():
        assert value["path"] not in text and value["key"] not in text and value["title"] not in text
    for value in db.albums.values():
        assert value["key"] not in text and value["name"] not in text
    assert all(name not in text for name in db.artist_names.values())
    key = "search_sidebar_cursor" if kind == "sidebar" else "search_cursor"
    db.read(**params, **{key: token})


@pytest.mark.parametrize("change,status,code", [
    ("version", 409, "stale_context"), ("scope", 409, "stale_context"),
    ("kind", 409, "stale_context"),
    ("unknown-kind", 400, "invalid_private_search_request"),
    ("missing-position", 400, "invalid_private_search_request"),
    ("boolean-id", 400, "invalid_private_search_request"),
    ("oversize-id", 400, "invalid_private_search_request"),
    ("extra-private-field", 400, "invalid_private_search_request"),
    ("boolean-version", 400, "invalid_private_search_request"),
])
def test_structurally_valid_scope_errors_and_malformed_payloads_have_distinct_route_errors(db, change, status, code):
    token, params = first_cursor(db, "tracks")
    value = deepcopy(open_cursor(token))
    if change == "version":
        value["version"] = 3
    elif change == "boolean-version":
        value["version"] = True
    elif change == "scope":
        value["scope"] = value["scope"] + ["changed"]
    elif change == "kind":
        value["kind"] = "albums"
    elif change == "unknown-kind":
        value["kind"] = "private-unknown-kind"
    elif change == "missing-position":
        value.pop("position")
    elif change == "extra-private-field":
        value["position"]["anchor"]["path"] = "/synthetic-global-search/forbidden-cursor-value"
    else:
        value["position"]["anchor"]["id"] = True if change == "boolean-id" else 9223372036854775808
    db.read(**params, search_cursor=seal_cursor(value), expected=status, code=code)


def test_result_and_sidebar_cursors_coexist_only_under_identical_live_scope(db):
    token, params = first_cursor(db, "sidebar")
    first = db.read(**params)
    result_token = first["page"]["next_cursor"]
    assert result_token
    db.read(**params, search_cursor=result_token, search_sidebar_cursor=token)
    changed = open_cursor(token)
    changed["scope"] = changed["scope"] + ["changed"]
    db.read(**params, search_cursor=result_token, search_sidebar_cursor=seal_cursor(changed),
        expected=409, code="stale_context")


def test_changed_live_session_rejects_old_cursor_even_with_fresh_valid_context(db):
    token, params = first_cursor(db, "tracks")
    with connect(db.setup) as connection:
        session = connection.execute("""insert into app.account_sessions
            (account_id,session_token_hash,created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at)
            values(%s,%s,%s,%s,%s,%s,%s) returning id""",
            (db.account, sha256(uuid4().bytes).digest(), db.now, db.now, db.now,
             db.now + timedelta(hours=12), db.now + timedelta(days=1))).fetchone()["id"]
    db.sessions[db.account] = session
    db.read(**params, search_cursor=token, expected=409, code="stale_context")


@pytest.mark.parametrize("change", ["album", "deny-anchor", "delete-anchor"])
def test_detail_cursor_remains_bound_to_album_and_current_visible_anchor(db, change):
    token, params = first_cursor(db, "detail")
    if change == "album":
        album = db.album(db.albums[db.main_album]["artist"], "Different Detail Album")
        db.track(album, "Different Detail Witness")
        params["search_detail_album_ref"] = album_ref(db, album)
        code = "stale_context"
    else:
        # Native detail order begins with Obsessed Track (track number 1).
        anchor = open_cursor(token)["position"]["anchor"]["id"]
        assert anchor == db.obsessed
        if change == "deny-anchor":
            db.denied.add(("track", str(anchor)))
        else:
            with connect(db.setup) as connection:
                connection.execute("delete from library.local_tracks where id=%s and library_id=%s", (anchor, db.library))
        code = "search_cursor_restart_required"
    db.read(**params, search_cursor=token, expected=409, code=code)
