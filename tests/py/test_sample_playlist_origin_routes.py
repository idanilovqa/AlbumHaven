"""Closed R2 typed-origin union through the existing authenticated ASGI router."""
from copy import deepcopy
from dataclasses import asdict

import pytest
from test_library_mix_route_boundary import boundary
from test_sample_playlist_native_routes import spy, SAMPLE, REPRESENTATIVES, KEY
from test_sample_playlist_receipts_live import options
from tests.py.owned_playlist_testing import PLAYLIST, LIBRARY

ORIGINS = [
    {"kind": "album_top", "top_ref": PLAYLIST, "revision": "9223372036854775807"},
    {"kind": "album_set", "selections": [{"kind": "local", "inventory_album_ref": f"inventory-album:{LIBRARY}:9007199254740993"}, {"kind": "unavailable"}]},
    {"kind": "album_details", "track_refs": [f"inventory-track:{LIBRARY}:9223372036854775807"]},
]


def body(value=None, **patch):
    return {"origin": deepcopy(value or ORIGINS[0]), "options": asdict(options()),
            "random_order": None, "request_key": KEY, **patch}


@pytest.mark.parametrize("value", ORIGINS)
def test_capture_dispatches_exact_typed_origin_without_parent_alias(boundary, monkeypatch, value):
    calls = spy(monkeypatch, "capture")
    response = boundary.request("POST", SAMPLE, payload=body(value))
    assert response[0] == 200 and len(calls) == 1
    owner, context, positional, arguments = calls[0]
    assert owner is boundary.owner and positional == ()
    assert arguments == {"origin": value, "options": options(), "request_key": KEY,
                         "random_order": None, "constraints": boundary.constraints}


@pytest.mark.parametrize("value", ORIGINS)
def test_acquisition_is_exact_origin_options_and_has_no_hidden_token(boundary, monkeypatch, value):
    calls = spy(monkeypatch, "representatives")
    request = {"origin": value, "options": asdict(options("random"))}
    assert boundary.request("POST", REPRESENTATIVES, payload=request)[0] == 200
    assert calls[0][3] == {"origin": value, "options": options("random"), "constraints": boundary.constraints}
    for extra in ({"request_key": KEY}, {"random_order": []}, {"playlist_ref": PLAYLIST}, {"evidence": "cached"}):
        assert boundary.request("POST", REPRESENTATIVES, payload=request | extra)[0] == 422
    assert len(calls) == 1


@pytest.mark.parametrize("patch", [
    {"playlist_ref": PLAYLIST}, {"revision": "1"}, {"actor_account_id": 1},
    {"library_id": LIBRARY}, {"source": {}}, {"remote_acquisition_ref": KEY},
    {"origin": None}, {"origin": []}, {"origin": {"kind": "playlist", "playlist_ref": PLAYLIST}},
    {"origin": {"kind": "activity"}}, {"origin": {"kind": "album_set", "selections": [], "revision": "1"}},
])
def test_union_rejects_mixed_legacy_or_injected_context_before_owner(boundary, monkeypatch, patch):
    calls = spy(monkeypatch, "capture")
    assert boundary.request("POST", SAMPLE, payload=body(**patch))[0] == 422
    assert calls == []


@pytest.mark.parametrize("revision", [True, 1, 1.0, "0", "01", "+1", " 1", "1.0", "1e1", "9223372036854775808"])
def test_saved_top_revision_is_canonical_decimal_bigint(boundary, monkeypatch, revision):
    calls = spy(monkeypatch, "capture")
    assert boundary.request("POST", SAMPLE, payload=body(ORIGINS[0] | {"revision": revision}))[0] == 422
    assert calls == []


@pytest.mark.parametrize("kind,field,prefix", [("album_set", "selections", "album"), ("album_details", "track_refs", "track")])
@pytest.mark.parametrize("suffix", ["0", "01", "-1", "+1", "1.0", "1e3", " 1", "9223372036854775808"])
def test_inventory_selectors_never_accept_numeric_aliases(boundary, monkeypatch, kind, field, prefix, suffix):
    ref = f"inventory-{prefix}:{LIBRARY}:{suffix}"
    value = {"kind": kind, field: [{"kind": "local", "inventory_album_ref": ref}] if kind == "album_set" else [ref]}
    calls = spy(monkeypatch, "capture")
    assert boundary.request("POST", SAMPLE, payload=body(value))[0] == 422
    assert calls == []


@pytest.mark.parametrize("selector", [
    {"kind": "catalog", "catalog_ref": PLAYLIST}, {"kind": "local", "local_album_id": 1},
    {"kind": "local", "inventory_album_ref": 9007199254740993},
    {"kind": "local", "inventory_album_ref": True},
    {"kind": "unavailable", "title": "Remote private title"},
    {"kind": "unavailable", "remote_admission_ref": PLAYLIST},
    {"kind": "local", "inventory_album_ref": f"inventory-album:{LIBRARY}:1", "catalog_ref": PLAYLIST},
])
def test_parentless_catalog_and_remote_evidence_are_not_authority(boundary, monkeypatch, selector):
    calls = spy(monkeypatch, "capture")
    value = {"kind": "album_set", "selections": [selector]}
    assert boundary.request("POST", SAMPLE, payload=body(value))[0] == 422
    assert calls == []


@pytest.mark.parametrize("value", [
    {"kind": "album_set", "selections": [{"kind": "local", "inventory_album_ref": f"inventory-album:{LIBRARY}:1"}] * 2},
    {"kind": "album_details", "track_refs": [f"inventory-track:{LIBRARY}:1"] * 2},
])
def test_repeated_actual_selectors_reject_not_dedupe(boundary, monkeypatch, value):
    calls = spy(monkeypatch, "capture")
    assert boundary.request("POST", SAMPLE, payload=body(value))[0] == 422
    assert calls == []


def test_repeated_unavailable_selectors_remain_distinct_indexes(boundary, monkeypatch):
    calls = spy(monkeypatch, "capture")
    value = {"kind": "album_set", "selections": [{"kind": "unavailable"}] * 2}
    assert boundary.request("POST", SAMPLE, payload=body(value))[0] == 200
    assert calls[0][3]["origin"] == value


@pytest.mark.parametrize("field", ["selections", "track_refs", "random_order"])
def test_list_limit_plus_one_fails_413_before_owner(boundary, monkeypatch, field):
    calls = spy(monkeypatch, "capture")
    if field == "selections":
        value = body({"kind": "album_set", field: [{"kind": "unavailable"}] * 5001})
    elif field == "track_refs":
        value = body({"kind": "album_details", field: [f"inventory-track:{LIBRARY}:{i}" for i in range(1, 5002)]})
    else:
        value = body(options=asdict(options("random")), random_order=[f"inventory-track:{LIBRARY}:{i}" for i in range(1, 5002)])
    assert boundary.request("POST", SAMPLE, payload=value)[0] == 413
    assert calls == []


def test_selector_limit_is_inclusive_without_truncation(boundary, monkeypatch):
    calls = spy(monkeypatch, "capture")
    value = {"kind": "album_set", "selections": [{"kind": "unavailable"}] * 5000}
    assert boundary.request("POST", SAMPLE, payload=body(value))[0] == 200
    assert len(calls[0][3]["origin"]["selections"]) == 5000


def test_utf8_command_bound_precedes_origin_and_digest_work(boundary, monkeypatch):
    calls = spy(monkeypatch, "capture")
    assert boundary.request("POST", SAMPLE, payload=body({"kind": "album_details", "track_refs": ["é" * 262145]}))[0] == 413
    assert calls == []


@pytest.mark.parametrize("field", ["origin", "options", "random_order", "request_key"])
def test_capture_requires_all_four_keys(boundary, monkeypatch, field):
    calls = spy(monkeypatch, "capture"); request = body(); del request[field]
    assert boundary.request("POST", SAMPLE, payload=request)[0] == 422
    assert calls == []


def test_v2_random_transport_decodes_only_order_and_preserves_origin_strings(boundary, monkeypatch):
    calls = spy(monkeypatch, "capture")
    value = ORIGINS[2]
    assert boundary.request("POST", SAMPLE, payload=body(value, options=asdict(options("random")),
        random_order=value["track_refs"]))[0] == 200
    assert calls[0][3]["random_order"] == (9223372036854775807,)
    assert calls[0][3]["origin"] == value


@pytest.mark.parametrize("value", [
    {"kind": "album_set", "selections": [{"kind": "local", "inventory_album_ref": f"inventory-album:{LIBRARY + 1}:1"}]},
    {"kind": "album_details", "track_refs": [f"inventory-track:{LIBRARY + 1}:1"]},
])
def test_foreign_inventory_scope_never_reaches_receipt_owner(boundary, monkeypatch, value):
    calls = spy(monkeypatch, "capture")
    assert boundary.request("POST", SAMPLE, payload=body(value))[0] == 409
    assert calls == []


@pytest.mark.parametrize("top_ref", ["bad", 1, True, "00000000000040008000000000000001"])
def test_saved_top_ref_requires_canonical_uuid(boundary, monkeypatch, top_ref):
    calls = spy(monkeypatch, "capture")
    assert boundary.request("POST", SAMPLE, payload=body(ORIGINS[0] | {"top_ref": top_ref}))[0] == 422
    assert calls == []
