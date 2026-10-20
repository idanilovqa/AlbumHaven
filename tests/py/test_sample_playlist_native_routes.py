"""Real production router contracts; service spies prove transport, not SQL/E2E.

Authored without running/importing the application. Explicit options are fixtures,
not product defaults. Reuses the existing authenticated ASGI boundary harness.
"""
from copy import deepcopy
from dataclasses import asdict

import pytest
from test_library_mix_route_boundary import boundary, assert_error
from library_mix_postgres_support import mix_db, mix_urls
from tests.py.owned_playlist_testing import SOURCE, SOURCE_REVISION, PLAYLIST, ENTRY_A, ENTRY_B, LIBRARY
from music_app.services import sample_playlist_receipts as receipts
from music_app.services.owned_playlists import inventory_identity, PlaylistError
from test_sample_playlist_receipts_live import options, no_provider

SAMPLE = "/playlists/creation-source/sample"
REPRESENTATIVES = SAMPLE + "/representatives"
QUEUE = SAMPLE + "/native-queue"
KEY = "00000000-0000-4000-8000-000000000091"


def body(**changes):
    return {"playlist_ref": PLAYLIST, "revision": "1", "options": asdict(options("random")),
            "request_key": KEY, "random_order": [f"inventory-track:{LIBRARY}:9223372036854775807"], **changes}


def spy(monkeypatch, name):
    calls = []
    def observe(owner, context, *args, **kwargs):
        calls.append((owner, context, args, deepcopy(kwargs)))
        return {"status": "ready", "data": {"actor_scope": {"account_id": context.actor.account_id,
                                                                 "library_id": context.library_id}}}
    monkeypatch.setattr(receipts, name, observe)
    return calls


def test_capture_inventory_bigint_is_exact_internal_integer(boundary, monkeypatch):
    calls = spy(monkeypatch, "capture")
    response = boundary.request("POST", SAMPLE, payload=body())
    assert response[0] == 200 and len(calls) == 1
    owner, context, positional, args = calls[0]
    assert owner is boundary.owner and positional == ()
    assert args["random_order"] == (9223372036854775807,)
    assert type(args["random_order"][0]) is int
    assert args["options"] == options("random")
    assert args["playlist_ref"] == PLAYLIST and args["revision"] == "1"
    assert args["request_key"] == KEY and args["constraints"] is boundary.constraints


@pytest.mark.parametrize("value", [9223372036854775807, True, None, "9223372036854775807",
    f"inventory-track:{LIBRARY}:9223372036854775808", f"inventory-track:{LIBRARY}:01",
    f"inventory-track:{LIBRARY}:0", f"inventory-track:{LIBRARY}:-1",
    f"inventory-track:{LIBRARY}:1.0", f"inventory-track:{LIBRARY}:1e3",
    f"inventory-track:{LIBRARY + 1}:1"])
def test_capture_rejects_lossy_noncanonical_or_foreign_inventory_refs(boundary, monkeypatch, value):
    calls = spy(monkeypatch, "capture")
    response = boundary.request("POST", SAMPLE, payload=body(random_order=[value]))
    expected = 409 if value == f"inventory-track:{LIBRARY + 1}:1" else 422
    assert response[0] == expected and calls == []


@pytest.mark.parametrize("field,value", [("revision", True), ("playlist_ref", "bad"),
    ("request_key", "bad"), ("random_order", None), ("extra", 1)])
def test_capture_rejects_bad_shape_before_receipt_owner(boundary, monkeypatch, field, value):
    calls = spy(monkeypatch, "capture")
    assert boundary.request("POST", SAMPLE, payload=body(**{field: value}))[0] == 422
    assert calls == []


@pytest.mark.parametrize("field,value", [("songs_per_group", True), ("selection_method", "unknown"),
    ("styles", ["style:rock"]), ("countries", ["country:GB"]), ("unknown_facets", None)])
def test_explicit_option_normalization_rejects_unsupported_values(boundary, monkeypatch, field, value):
    calls = spy(monkeypatch, "capture")
    opts = asdict(options("random")); opts[field] = value
    assert boundary.request("POST", SAMPLE, payload=body(options=opts))[0] == 422
    assert calls == []


def test_most_listened_requires_null_random_order(boundary, monkeypatch):
    calls = spy(monkeypatch, "capture")
    opts = asdict(options())
    assert boundary.request("POST", SAMPLE, payload=body(options=opts, random_order=[]))[0] == 422
    assert calls == []
    assert boundary.request("POST", SAMPLE, payload=body(options=opts, random_order=None))[0] == 200
    assert calls[0][3]["random_order"] is None


def test_representatives_dispatches_only_explicit_parent_options(boundary, monkeypatch):
    calls = spy(monkeypatch, "representatives")
    payload = {key: value for key, value in body().items() if key in {"playlist_ref", "revision", "options"}}
    assert boundary.request("POST", REPRESENTATIVES, payload=payload)[0] == 200
    assert len(calls) == 1 and calls[0][3]["options"] == options("random")
    assert set(calls[0][3]) == {"playlist_ref", "revision", "options", "constraints"}
    assert boundary.request("POST", REPRESENTATIVES, payload={**payload, "request_key": KEY})[0] == 422
    assert len(calls) == 1


@pytest.mark.parametrize("query,consumer", [({"source_ref": SOURCE, "source_revision": SOURCE_REVISION}, "read"),
                                          ({"request_key": KEY}, "read_capture")])
def test_lookup_uses_only_its_exact_read_consumer(boundary, monkeypatch, query, consumer):
    captured = spy(monkeypatch, "capture")
    read = spy(monkeypatch, "read"); recover = spy(monkeypatch, "read_capture")
    assert boundary.request("GET", SAMPLE, query=query)[0] == 200
    assert captured == []
    assert len(read if consumer == "read" else recover) == 1
    assert (recover if consumer == "read" else read) == []


@pytest.mark.parametrize("query", [{}, {"source_ref": SOURCE}, {"source_revision": SOURCE_REVISION},
    {"request_key": KEY, "source_ref": SOURCE, "source_revision": SOURCE_REVISION},
    {"request_key": KEY, "extra": "x"}])
def test_lookup_rejects_mixed_missing_extra_fields_without_capture(boundary, monkeypatch, query):
    calls = {name: spy(monkeypatch, name) for name in ("capture", "read", "read_capture")}
    assert boundary.request("GET", SAMPLE, query=query)[0] == 422
    assert all(not value for value in calls.values())


@pytest.mark.parametrize("path", [SAMPLE, REPRESENTATIVES, QUEUE])
def test_sample_post_preserves_existing_csrf_and_origin_perimeter(boundary, monkeypatch, path):
    calls = {name: spy(monkeypatch, name) for name in ("capture", "representatives", "native_queue")}
    assert boundary.request("POST", path, payload={}, omit=("x-album-haven-csrf",))[0] == 403
    assert boundary.request("POST", path, payload={}, headers={"origin": "https://untrusted.test"})[0] == 403
    assert all(not value for value in calls.values())


@pytest.mark.parametrize("value", ["inventory-track:1:1", "inventory-track:9223372036854775807:9223372036854775807"])
def test_existing_inventory_codec_keeps_full_bigint(value):
    library, track = inventory_identity(value)
    assert value == f"inventory-track:{library}:{track}"


def test_native_queue_dispatch_keeps_full_order_and_truthful_sample_tuple(boundary, monkeypatch):
    payload = {"source_ref": SOURCE, "source_revision": SOURCE_REVISION,
               "entry_refs": [ENTRY_B, ENTRY_A], "starting_entry_ref": ENTRY_A}
    calls = []
    response = {"source": {"kind": "playlist", "ref": SOURCE, "revision": SOURCE_REVISION},
        "source_protocol": "sample_playlist_selection_v1", "starting_item_ref": ENTRY_A,
        "tracks": [{"playlist_item_id": ENTRY_A, "play_count": 0, "native_target": {
            "playlist_item_id": ENTRY_A, "inventory_track_ref": f"inventory-track:{LIBRARY}:1",
            "path": "/synthetic/native/1.wav", "track_ref": "/synthetic/native/1.wav"}}],
        "unavailable_item_refs": [ENTRY_B]}
    def native(owner, context, supplied, *, constraints=None):
        calls.append((owner, context, deepcopy(supplied), constraints))
        return response
    monkeypatch.setattr(receipts, "native_queue", native)
    status, headers, result = boundary.request("POST", QUEUE, payload=payload)
    assert status == 200 and headers["cache-control"] == "private, no-store"
    assert result == {"status": "ready", "data": response, "context_ref": boundary.context_ref()}
    assert len(calls) == 1 and calls[0][0] is boundary.owner
    assert calls[0][2] == payload and calls[0][3] is boundary.constraints


@pytest.mark.parametrize("missing", list(asdict(options("random"))))
def test_capture_requires_every_explicit_option_even_null_fields(boundary, monkeypatch, missing):
    calls = spy(monkeypatch, "capture")
    opts = asdict(options("random")); del opts[missing]
    assert boundary.request("POST", SAMPLE, payload=body(options=opts))[0] == 422
    assert calls == []


@pytest.mark.parametrize("empty", [False, True])
def test_actual_read_adapter_adds_separate_native_actions_without_widening_receipt_dto(boundary, mix_db, empty):
    from test_sample_playlist_sources_live import manual_source
    from test_sample_playlist_receipts_live import capture, read
    db = mix_db
    parent = manual_source(db, (0, 1, 3))
    source = capture(db, parent, opts=options(length="over_10") if empty else options())
    boundary.app.state.owned_playlists_service = db.service
    boundary.resolver.actor = db.owner
    before = read(db, source)
    response = boundary.request("GET", SAMPLE,
        query={"source_ref": source["source"]["ref"], "source_revision": source["source"]["revision"]})
    assert response[0] == 200
    data = response[2]["data"]
    assert data["native_actions"]["can_save"] is (not empty)
    # Fixture deliberately has Browse/Create, but no current media grant.
    assert data["native_actions"]["can_play"] is False
    assert data["allowed_actions"] == {"can_read": True, "can_use_for_playlist": False, "can_play": False}
    assert all(entry["allowed_actions"]["can_select"] is False for entry in data["entries"])
    assert [entry["entry_ref"] for entry in data["entries"]] == [entry["entry_ref"] for entry in before["entries"]]
    assert "native_actions" not in before and read(db, source) == before
    assert str(db.root_path) not in str(data)


def test_actual_native_hints_use_current_media_owner_inside_single_held_validation(boundary, mix_db, monkeypatch):
    from contextlib import contextmanager
    from test_sample_playlist_sources_live import manual_source
    from test_sample_playlist_receipts_live import capture, read
    from test_library_mix_persistence_live import grant_media, MEDIA
    from music_app.services import private_native_targets as targets
    from music_app.services.policy_evaluator import PolicyEvaluationConstraints
    db = mix_db; grant_media(db)
    parent = manual_source(db, (0, 1, 3)); source = capture(db, parent)
    before = read(db, source)
    denied_ref = source["entries"][-1]["entry_ref"]
    denied_id = source["entries"][-1]["inventory_track_ref"].rsplit(":", 1)[1]
    def constraints(ctx):
        blocked = ctx.action == MEDIA and ctx.resource and ctx.resource.resource_ref == denied_id
        return PolicyEvaluationConstraints(deployment_allowed=not blocked)
    boundary.app.state.owned_playlists_service = db.service
    boundary.app.state.policy_constraint_resolver = constraints
    boundary.resolver.actor = db.owner
    # Use the fixture's real configured-root confinement function at the existing
    # injectable resolver seam. Neither media admission nor file reads are mocked.
    monkeypatch.setattr(targets, "resolve_configured_media_path", db.media_resolver)
    authorized = db.service._authorized
    validate = receipts.validated_source
    resolve = targets.PrivateNativeTargets.resolve_play_queue
    transactions, validations, resolved, held = [], [], [], []
    @contextmanager
    def observe_authority(*args, **kwargs):
        with authorized(*args, **kwargs) as opened:
            transactions.append(opened[0].info.backend_pid)
            yield opened
    @contextmanager
    def observe_validation(owner, connection, live, retained, **kwargs):
        with validate(owner, connection, live, retained, **kwargs) as rows:
            validations.append(connection.info.backend_pid)
            held.append(connection)
            try:
                yield rows
            finally:
                held.pop()
    def observe_targets(self, connection, live, track_ids, **kwargs):
        assert held == [connection]
        resolved.append(connection.info.backend_pid)
        return resolve(self, connection, live, track_ids, **kwargs)
    monkeypatch.setattr(db.service, "_authorized", observe_authority)
    monkeypatch.setattr(receipts, "validated_source", observe_validation)
    monkeypatch.setattr(targets.PrivateNativeTargets, "resolve_play_queue", observe_targets)
    response = boundary.request("GET", SAMPLE,
        query={"source_ref": source["source"]["ref"], "source_revision": source["source"]["revision"]})
    assert response[0] == 200
    data = response[2]["data"]
    assert len(transactions) == 1 and transactions == validations == resolved and held == []
    assert data["native_actions"] == {"can_save": True, "can_play": True}
    assert data["allowed_actions"] == before["allowed_actions"]
    assert [entry["entry_ref"] for entry in data["entries"]] == [entry["entry_ref"] for entry in before["entries"]]
    for entry, original in zip(data["entries"], before["entries"]):
        assert entry["native_actions"]["can_play"] is (entry["entry_ref"] != denied_ref)
        assert entry["allowed_actions"] == original["allowed_actions"]
        assert entry["allowed_actions"]["can_select"] is False
        assert "native_actions" not in original
    for private in ("path", "private_path", "root_path", "native_target"):
        assert f"'{private}':" not in str(data)
    assert str(db.root_path) not in str(data)
