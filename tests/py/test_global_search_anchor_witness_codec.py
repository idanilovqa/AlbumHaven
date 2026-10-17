"""Additive assertions for the frozen v2 optional-hint/selection-pending contract.

Only the already-public Social module is imported. Missing Search callables fail
an explicit capability assertion, never collection via an absent future module.
No production authority, SQL, configuration, or private service is substituted.
"""
from copy import deepcopy
import json

import pytest

from music_app.services import social_cursors

SECRET = "synthetic-top-route-and-context-key-32-bytes"
SCOPE = ["synthetic-search", 41, 73, "own-love-v1"]
KINDS = ["albums", "sidebar", "tracks", "detail"]


def identity(identifier=1, *, readable=True):
    return {"id": identifier, "digest": format(identifier, "064x"), "readable": readable}


def selected(*, pending=False):
    artist = identity(7)
    return {"state": "selected", "artist": artist, "witness": identity(8),
            "pending": {"anchor": None, "pending": {"candidate": deepcopy(artist), "witness": identity(9)}}
            if pending else None}


def payload(kind="albums", *, hint=True):
    position = {"anchor": identity(1), "pending": {"candidate": identity(2), "witness": identity(3)}}
    if hint:
        position["anchor_witness"] = identity(4)
    return {"version": 2, "scope": SCOPE, "kind": kind, "position": position, "selection": selected()}


def codec():
    encode = getattr(social_cursors, "encode_search_cursor", None)
    decode = getattr(social_cursors, "decode_search_cursor", None)
    assert callable(encode) and callable(decode), "The existing Social owner must expose the approved Search codec"
    return encode, decode


def seal(value):
    return social_cursors._cipher(SECRET).encrypt(json.dumps(value).encode()).decode()


def assert_roundtrip(value):
    encode, decode = codec()
    token = encode(value["position"], secret=SECRET, scope=value["scope"],
                   kind=value["kind"], selection=value["selection"])
    assert json.loads(social_cursors._cipher(SECRET).decrypt(token.encode())) == value
    assert decode(token, secret=SECRET, scope=SCOPE, kind=value["kind"]) == value
    # Independently sealed old/new payloads exercise decoding apart from encode.
    assert decode(seal(value), secret=SECRET, scope=SCOPE, kind=value["kind"]) == value


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("pending", [False, True])
def test_old_two_key_positions_remain_byte_shape_compatible(kind, pending):
    value = payload(kind, hint=False)
    if not pending:
        value["position"]["pending"] = None
    assert set(value["position"]) == {"anchor", "pending"}
    assert_roundtrip(value)


@pytest.mark.parametrize("kind", ["albums", "sidebar"])
@pytest.mark.parametrize("pending", [False, True])
def test_new_anchor_hint_roundtrips_separately_from_next_candidate(kind, pending):
    value = payload(kind)
    if not pending:
        value["position"]["pending"] = None
    assert_roundtrip(value)
    assert set(value) == {"version", "scope", "kind", "position", "selection"}
    assert set(value["position"]) == {"anchor", "pending", "anchor_witness"}
    assert set(value["position"]["anchor_witness"]) == {"id", "digest", "readable"}
    assert value["position"]["anchor_witness"]["readable"] is True
    if pending:
        assert value["position"]["anchor_witness"] != value["position"]["pending"]["witness"]


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("last_witness", [None, identity(9)])
def test_selected_requalification_preserves_artist_and_successful_witness(kind, last_witness):
    value = payload(kind, hint=kind in {"albums", "sidebar"})
    value["selection"] = selected(pending=True)
    value["selection"]["pending"]["pending"]["witness"] = last_witness
    assert_roundtrip(value)
    assert value["selection"]["artist"] == identity(7)
    assert value["selection"]["witness"] == identity(8)


def reject(value):
    encode, decode = codec()
    with pytest.raises(ValueError):
        encode(value["position"], secret=SECRET, scope=SCOPE,
               kind=value["kind"], selection=value["selection"])
    with pytest.raises(ValueError):
        decode(seal(value), secret=SECRET, scope=SCOPE, kind=value["kind"])


BAD_HINTS = [None, {}, [], True, identity(True), identity(0), identity(-1),
             identity(9223372036854775808), {**identity(), "id": "1"},
             {**identity(), "digest": "A" * 64}, {**identity(), "digest": "g" * 64},
             {**identity(), "digest": "a" * 63}, {**identity(), "digest": 7},
             {**identity(), "readable": False}, {**identity(), "readable": 1},
             {**identity(), "path": "/synthetic/forbidden"},
             {"id": 1, "digest": "a" * 64}]


@pytest.mark.parametrize("kind", ["albums", "sidebar"])
@pytest.mark.parametrize("bad_hint", BAD_HINTS)
def test_malformed_anchor_hint_is_rejected_by_both_codec_directions(kind, bad_hint):
    value = payload(kind)
    value["position"]["anchor_witness"] = deepcopy(bad_hint)
    reject(value)


@pytest.mark.parametrize("change", ["tracks", "detail", "null-anchor", "unreadable-anchor", "unknown-position-field"])
def test_anchor_hint_is_only_valid_on_readable_album_or_sidebar_anchors(change):
    value = payload()
    if change in {"tracks", "detail"}:
        value["kind"] = change
    elif change == "null-anchor":
        value["position"]["anchor"] = None
    elif change == "unreadable-anchor":
        value["position"]["anchor"]["readable"] = False
    else:
        value["position"]["unknown"] = None
    reject(value)


@pytest.mark.parametrize("change", ["different-candidate", "different-digest", "different-readable", "outer-anchor",
                                     "anchor-hint", "null-pending", "extra-key", "bad-witness", "missing-candidate"])
def test_selected_pending_is_exact_same_artist_position_without_outer_anchor(change):
    value = payload()
    value["selection"] = selected(pending=True)
    position = value["selection"]["pending"]
    pending = position["pending"]
    if change == "different-candidate":
        pending["candidate"] = identity(99)
    elif change == "different-digest":
        pending["candidate"]["digest"] = "a" * 64
    elif change == "different-readable":
        pending["candidate"]["readable"] = False
    elif change == "outer-anchor":
        position["anchor"] = identity(7)
    elif change == "anchor-hint":
        position["anchor_witness"] = identity(8)
    elif change == "null-pending":
        position["pending"] = None
    elif change == "extra-key":
        position["unknown"] = None
    elif change == "bad-witness":
        pending["witness"] = identity(True)
    else:
        pending.pop("candidate")
    reject(value)


@pytest.mark.parametrize("kind", ["albums", "sidebar"])
def test_pending_page_existing_sidebar_position_may_use_optional_anchor_hint(kind):
    value = payload(kind)
    value["selection"] = {"state": "pending_page", "artist": None, "witness": None,
                          "pending": deepcopy(value["position"])}
    assert_roundtrip(value)


@pytest.mark.parametrize("position", [None, 1, 9223372036854775807])
def test_integer_social_payload_is_unchanged_after_search_extension(position):
    token = social_cursors.encode_social_cursor(position, secret=SECRET, scope=["friends", 1])
    if position is None:
        assert token is None
        assert social_cursors.decode_social_cursor(token, secret=SECRET, scope=["friends", 1]) == 0
    else:
        legacy = {"scope": ["friends", 1], "position": position}
        assert json.loads(social_cursors._cipher(SECRET).decrypt(token.encode())) == legacy
        assert social_cursors.decode_social_cursor(seal(legacy), secret=SECRET, scope=["friends", 1]) == position


@pytest.mark.parametrize("change", ["ciphertext", "scope", "kind"])
def test_new_hint_cannot_escape_existing_encryption_or_scope_binding(change):
    encode, decode = codec()
    value = payload()
    token = encode(value["position"], secret=SECRET, scope=SCOPE, kind="albums", selection=value["selection"])
    scope, kind = SCOPE, "albums"
    if change == "ciphertext":
        index = len(token) // 2
        token = token[:index] + ("A" if token[index] != "A" else "B") + token[index + 1:]
    elif change == "scope":
        scope = SCOPE + ["other-actor"]
    else:
        kind = "sidebar"
    with pytest.raises(ValueError):
        decode(token, secret=SECRET, scope=scope, kind=kind)
