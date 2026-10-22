"""Three origins, one retained evaluator/validator/Save/player ownership path.

Authored/unrun. Every forwarding spy calls its real owner. Setup uses uniquely
owned normal migrated rows, never fixture DDL or private authority substitutes.
"""
from contextlib import contextmanager
from copy import deepcopy
from datetime import timedelta
from uuid import uuid4
import hashlib
import json

import pytest
from library_mix_postgres_support import mix_db, mix_urls
from music_app.services.owned_playlists import PlaylistError, BROWSE
from music_app.services.owned_album_tops_postgres import PostgresOwnedAlbumTopsService
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_native_targets import PrivateNativeTargets
from music_app.services import listen_history_postgres as history
from test_sample_playlist_receipts_live import (
    receipts, sources, snapshots, evaluator, complete, options, read, recovery,
    retained, destinations, forbidden, no_provider, PROTOCOL,
)
from test_sample_playlist_save import payload, save, ledger
from test_sample_playlist_native_live import queue, queue_body, receipt_count
from test_library_mix_persistence_live import grant_media, MEDIA
from sample_playlist_origin_support import KINDS, album_ref, track_ref, origin, capture_origin, acquire_origin, sample_top


def independent_digest(domain, value):
    return hashlib.sha256(json.dumps({"domain": domain, "value": value},
        sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")).hexdigest()


def proof_member(index, *, item=None, catalog=None, remote=None, album=None, tracks=(), omission=None):
    return {"index": index, "item_ref": item, "catalog_ref": catalog,
        "remote_admission_ref": remote, "inventory_album_ref": album,
        "track_refs": list(tracks), "omission": omission}


def expected_proof(case, kind):
    db = case.db
    if kind == "album_details":
        return {"kind": kind, "members": [proof_member(n, tracks=[track_ref(db, i)]) for n, i in enumerate((3, 1, 0))]}
    if kind == "album_set":
        return {"kind": kind, "members": [proof_member(n, album=album_ref(db, i),
            tracks=[track_ref(db, t) for t in range(i * 3, i * 3 + 3)]) for n, i in enumerate((1, 0))]}
    with db.connect() as con:
        members = con.execute("select ref,catalog_ref from app.album_list_items where top_ref=%s order by curator_position,ref",
                              (case.top["top_ref"],)).fetchall()
    return {"kind": kind, "members": [proof_member(n, item=str(member["ref"]), catalog=str(member["catalog_ref"]),
        album=album_ref(db, i), tracks=[track_ref(db, t) for t in range(i * 3, i * 3 + 3)])
        for n, (member, i) in enumerate(zip(members, (1, 0)))]}


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("method", ["most_listened", "random"])
def test_exact_typed_descriptor_domains_and_truthful_non_grant_projection(sample_top, kind, method):
    case = sample_top; db = case.db; value = origin(db, kind, case.top)
    before = destinations(db), receipt_count(db)
    acquired = acquire_origin(db, value) if method == "random" else None
    order = tuple(int(ref.rsplit(":", 1)[1]) for ref in reversed(acquired["representative_refs"])) if acquired else None
    source = capture_origin(db, value, method=method, order=order, native=True)
    row, entries = retained(db, source["source"]["ref"]); descriptor = row["origin_descriptor"]
    assert row["source_kind"] == source["source"]["kind"] == "library"
    assert row["protocol"] == source["source_protocol"] == PROTOCOL
    assert descriptor["version"] == 2 and type(descriptor["version"]) is int
    assert set(descriptor) == {"version", "request", "request_digest", "origin_proof", "membership_digest",
        "facts", "facts_digest", "ranking", "ranking_digest", "result", "result_digest", "source_diagnostics"}
    assert set(descriptor["request"]) == {"origin", "options", "random_order"}
    assert descriptor["request"]["origin"] == value
    assert descriptor["origin_proof"] == expected_proof(case, kind)
    for key, domain in (("request", "request_v2"), ("origin_proof", "membership_v2"),
                        ("facts", "facts_v1"), ("ranking", "ranking_v1"), ("result", "result_v1")):
        digest_key = "membership_digest" if key == "origin_proof" else key + "_digest"
        assert descriptor[digest_key] == (None if key == "ranking" and method == "random" else independent_digest(domain, descriptor[key]))
    assert (descriptor["ranking"] is None) == (method == "random")
    assert [e["entry_ref"] for e in source["entries"]] == descriptor["result"]["entry_order"]
    assert [int(e["inventory_track_ref"].rsplit(":", 1)[1]) for e in source["entries"]] == descriptor["result"]["track_ids"]
    assert source["origin_diagnostics"] == [] and source["source_diagnostics"] == []
    assert source["allowed_actions"] == {"can_read": True, "can_use_for_playlist": False, "can_play": False}
    assert all(e["allowed_actions"]["can_select"] is False for e in source["entries"])
    assert "origin_diagnostics" not in descriptor and "request_key" not in descriptor["request"]
    assert destinations(db) == before[0] and receipt_count(db) == before[1] + 1
    for secret in (str(db.root_path), "inventory_digest", "identity_evidence", "origin_proof"):
        assert secret not in json.dumps(source)


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("operation", ["read", "recovery", "replay"])
def test_retained_result_never_reranks_or_renews_after_observation_churn(sample_top, monkeypatch, kind, operation):
    db = sample_top.db; value = origin(db, kind, sample_top.top); key = str(uuid4())
    source = capture_origin(db, value, key=key)
    with db.connect() as con: db.observe(con, db.tracks[1], 999999)
    before = retained(db, key), destinations(db), receipt_count(db)
    monkeypatch.setattr(evaluator, "evaluate_sample_playlist", forbidden)
    monkeypatch.setattr(complete, "_header", forbidden)
    original = snapshots.inventory.read_inventory; reads = []
    def inventory(connection, *args, **kwargs):
        reads.append(connection.info.backend_pid)
        assert kwargs["include_popularity"] is False and kwargs["lock"] is True
        return original(connection, *args, **kwargs)
    monkeypatch.setattr(snapshots.inventory, "read_inventory", inventory)
    actual = read(db, source) if operation == "read" else recovery(db, key) if operation == "recovery" else capture_origin(db, value, key=key)
    assert actual == source and reads
    assert (retained(db, key), destinations(db), receipt_count(db)) == before


@pytest.mark.parametrize("kind", KINDS)
def test_random_acquisition_is_no_receipt_and_current_facts_not_hidden_evidence(sample_top, kind):
    db = sample_top.db; value = origin(db, kind, sample_top.top)
    before = destinations(db), receipt_count(db)
    acquired = acquire_origin(db, value, options=options("random", songs_per_group=5000))
    assert set(acquired) == {"origin", "options", "representative_refs", "actor_scope"}
    assert acquired["origin"] == value
    assert (destinations(db), receipt_count(db)) == before
    with db.connect() as con:
        con.execute("update library.local_tracks set title=title || ' changed' where id=%s", (db.tracks[0],))
        db.rebind_mappings(con, [db.tracks[0]])
    order = tuple(int(ref.rsplit(":", 1)[1]) for ref in acquired["representative_refs"])
    source = capture_origin(db, value, method="random", order=order, opts=options("random", songs_per_group=5000))
    assert any("changed" in entry["title"] for entry in source["entries"] if entry["inventory_track_ref"] == track_ref(db, 0))
    assert retained(db, source["source"]["ref"])[0]["origin_descriptor"]["ranking"] is None


@pytest.mark.parametrize("kind", KINDS)
def test_representative_set_change_between_acquisition_and_capture_rejects(sample_top, kind):
    db = sample_top.db; value = origin(db, kind, sample_top.top)
    acquired = acquire_origin(db, value); key = str(uuid4())
    order = tuple(int(ref.rsplit(":", 1)[1]) for ref in acquired["representative_refs"])
    with db.connect() as con:
        con.execute("delete from library.local_tracks where id=%s", (db.tracks[0],))
    with pytest.raises((PlaylistError, ValueError)):
        capture_origin(db, value, key=key, method="random", order=order)
    assert retained(db, key) == (None, [])


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("change", ["track_album", "track_identity", "membership", "album_denied", "track_denied"])
def test_current_origin_resource_and_membership_cannot_be_replaced_by_cached_rows(sample_top, kind, change):
    db = sample_top.db; value = origin(db, kind, sample_top.top)
    source = capture_origin(db, value); constraints = None
    if change.endswith("denied"):
        resource = change.split("_")[0]
        constraints = lambda ctx: PolicyEvaluationConstraints(deployment_allowed=not (
            ctx.action == BROWSE and ctx.resource and ctx.resource.resource_kind == resource))
    else:
        with db.connect() as con:
            if change == "track_album": con.execute("update library.local_tracks set album_id=%s where id=%s", (db.albums[1], db.tracks[0]))
            elif change == "track_identity": con.execute("update library.track_popularity_mapping_slots set current_revision=null where track_id=%s", (db.tracks[0],))
            else: con.execute("delete from library.local_tracks where id=%s", (db.tracks[0],))
    before = destinations(db)
    with pytest.raises(PlaylistError): read(db, source, constraints=constraints)
    assert destinations(db) == before


@pytest.mark.parametrize("kind", ["album_set", "album_details"])
def test_supplied_local_missing_or_denied_refs_fail_instead_of_omission(mix_db, kind):
    db = mix_db; value = origin(db, kind); key = str(uuid4())
    supplied_kind = "album" if kind == "album_set" else "track"
    constraints = lambda ctx: PolicyEvaluationConstraints(deployment_allowed=not (
        ctx.action == BROWSE and ctx.resource and ctx.resource.resource_kind == supplied_kind))
    with pytest.raises(PlaylistError): capture_origin(db, value, key=key, constraints=constraints)
    assert retained(db, key) == (None, [])


def test_explicit_set_has_no_catalog_binding_dependency_or_parent(mix_db, monkeypatch):
    db = mix_db; value = origin(db)
    monkeypatch.setattr(PostgresOwnedAlbumTopsService, "admit_inventory_album", forbidden)
    monkeypatch.setattr(PostgresOwnedAlbumTopsService, "_top", forbidden)
    source = capture_origin(db, value)
    descriptor = retained(db, source["source"]["ref"])[0]["origin_descriptor"]
    assert descriptor["request"]["origin"] == value
    assert all(m["catalog_ref"] is None and m["item_ref"] is None for m in descriptor["origin_proof"]["members"])
    assert read(db, source) == source


def test_details_selection_is_not_whole_album_or_cached_title_authority(mix_db):
    db = mix_db; value = {"kind": "album_details", "track_refs": [track_ref(db, 1)]}
    source = capture_origin(db, value)
    descriptor = retained(db, source["source"]["ref"])[0]["origin_descriptor"]
    assert descriptor["result"]["track_ids"] == [db.tracks[1]]
    assert [fact["track_id"] for fact in descriptor["facts"]] == [db.tracks[1]]
    assert descriptor["origin_proof"] == {"kind": "album_details", "members": [proof_member(0, tracks=[track_ref(db, 1)])]}
    assert "playlist_ref" not in descriptor["request"] and "revision" not in descriptor["request"]


def test_details_loose_track_does_not_acquire_invented_album_identity(mix_db):
    db = mix_db
    with db.connect() as con:
        con.execute("update library.local_tracks set album_id=null where id=%s", (db.tracks[0],))
        db.rebind_mappings(con, [db.tracks[0]])
    value = {"kind": "album_details", "track_refs": [track_ref(db, 0)]}
    source = capture_origin(db, value)
    descriptor = retained(db, source["source"]["ref"])[0]["origin_descriptor"]
    assert descriptor["origin_proof"]["members"] == [proof_member(0, tracks=[track_ref(db, 0)])]
    assert descriptor["facts"][0]["album_ref"] is None
    assert read(db, source) == source


def test_indexed_unavailable_placeholders_are_fixed_and_not_track_diagnostics(mix_db):
    db = mix_db
    value = {"kind": "album_set", "selections": [{"kind": "unavailable"},
        {"kind": "local", "inventory_album_ref": album_ref(db)}, {"kind": "unavailable"}]}
    source = capture_origin(db, value, native=True)
    descriptor = retained(db, source["source"]["ref"])[0]["origin_descriptor"]
    assert descriptor["origin_proof"]["members"] == [proof_member(0, omission="unavailable"),
        proof_member(1, album=album_ref(db), tracks=[track_ref(db, i) for i in (0, 1, 2)]), proof_member(2, omission="unavailable")]
    assert source["origin_diagnostics"] == [[0, "unavailable"], [2, "unavailable"]]
    assert source["source_diagnostics"] == []
    assert read(db, source, native=True) == source


def test_authorized_empty_album_and_all_unavailable_keep_empty_preview_not_save(mix_db):
    db = mix_db
    with db.connect() as con: con.execute("delete from library.local_tracks where album_id=%s", (db.albums[0],))
    source = capture_origin(db, {"kind": "album_set", "selections": [
        {"kind": "local", "inventory_album_ref": album_ref(db)}, {"kind": "unavailable"}]}, native=True)
    assert source["entries"] == []
    assert source["origin_diagnostics"] == [[0, "tracks_unavailable"], [1, "unavailable"]]
    assert source["native_actions"]["can_save"] is False
    before = destinations(db)
    with pytest.raises(PlaylistError): save(db, payload(source))
    assert destinations(db) == before


@pytest.mark.parametrize("kind", KINDS)
def test_same_save_owner_and_exact_library_item_provenance(sample_top, monkeypatch, kind):
    db = sample_top.db; source = capture_origin(db, origin(db, kind, sample_top.top)); body = payload(source)
    before = retained(db, source["source"]["ref"])
    monkeypatch.setattr(evaluator, "evaluate_sample_playlist", forbidden)
    monkeypatch.setattr(receipts, "capture", forbidden)
    actual = save(db, body); parent, items, recipe = db.state(actual["playlist_id"])
    assert recipe is None and parent["owner_account_id"] == db.owner.account_id
    assert [str(item["source_entry_ref"]) for item in items] == body["entry_refs"]
    assert [item["original_local_track_id"] for item in items] == before[0]["origin_descriptor"]["result"]["track_ids"]
    assert all(item["source_kind"] == "library" and item["source_protocol"] == PROTOCOL for item in items)
    assert len(ledger(db, body["request_key"])) == 1 and retained(db, source["source"]["ref"]) == before


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("ending", ["expiry", "cleanup", "identity"])
def test_successful_operation_replay_precedes_live_origin_validation(sample_top, monkeypatch, kind, ending):
    db = sample_top.db; source = capture_origin(db, origin(db, kind, sample_top.top)); body = payload(source)
    result = save(db, body)
    if ending == "expiry": db.clock_time += sources.SOURCE_LIFETIME
    else:
        with db.connect() as con:
            if ending == "cleanup": con.execute("delete from app.playlist_creation_sources where ref=%s", (source["source"]["ref"],))
            else: con.execute("delete from library.local_tracks where id=%s", (db.tracks[0],))
    before = destinations(db)
    monkeypatch.setattr(receipts, "validated_source", forbidden)
    assert save(db, body) == result and destinations(db) == before
    with pytest.raises(PlaylistError, match="idempotency_key_reused"): save(db, body | {"title": "Changed"})


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("fence", ["identity", "album", "track", "session", "expiry"])
def test_final_save_fence_after_actual_ledger_insert_rolls_back_all_writes(sample_top, monkeypatch, kind, fence):
    db = sample_top.db; source = capture_origin(db, origin(db, kind, sample_top.top)); body = payload(source)
    before = destinations(db); armed = [False]; observed = []
    original = db.service._connect
    class Connection:
        def __init__(self, real): self.real = real
        def __getattr__(self, name): return getattr(self.real, name)
        def execute(self, sql, params=None, *args, **kwargs):
            result = self.real.execute(sql, params, *args, **kwargs)
            if "insert into app.playlist_operations" in " ".join(str(sql).lower().split()):
                observed.append(self.real.info.backend_pid); armed[0] = True
                if fence == "identity": self.real.execute("update library.track_popularity_mapping_slots set current_revision=null where track_id=%s", (db.tracks[0],))
                elif fence == "session": db.clock_time += timedelta(days=2)
                elif fence == "expiry": db.clock_time += sources.SOURCE_LIFETIME
            return result
    @contextmanager
    def connect(url):
        with original(url) as con: yield Connection(con)
    def constraints(ctx):
        denied = armed[0] and ctx.action == BROWSE and ctx.resource and ctx.resource.resource_kind == fence
        return PolicyEvaluationConstraints(deployment_allowed=not denied)
    monkeypatch.setattr(db.service, "_connect", connect)
    with pytest.raises(PlaylistError): save(db, body, constraints=constraints)
    assert len(observed) == 1 and destinations(db) == before and ledger(db, body["request_key"]) == []


@pytest.mark.parametrize("kind", KINDS)
def test_native_queue_is_shared_retained_order_and_fresh_media_only(sample_top, monkeypatch, kind):
    db = sample_top.db; grant_media(db)
    source = capture_origin(db, origin(db, kind, sample_top.top)); refs = [e["entry_ref"] for e in source["entries"]]
    before = destinations(db); observed = []; real = PrivateNativeTargets.resolve_play_queue
    def resolve(self, connection, live, ids, **kwargs):
        observed.append(connection.info.backend_pid)
        return real(self, connection, live, ids, **kwargs)
    monkeypatch.setattr(PrivateNativeTargets, "resolve_play_queue", resolve)
    result = queue(db, source, payload=queue_body(source, starting_entry_ref=refs[-1]))
    assert result["source"]["kind"] == "library" and result["starting_item_ref"] == refs[-1]
    assert [row["playlist_item_id"] for row in result["tracks"]] == refs and len(observed) == 1
    with db.connect() as con: con.execute("delete from app.capabilities where account_id=%s and capability_key=%s", (db.owner.account_id, MEDIA))
    assert read(db, source) == source
    with pytest.raises(PlaylistError): queue(db, source)
    assert destinations(db) == before


@pytest.mark.parametrize("kind", KINDS)
def test_final_player_fence_runs_after_actual_targets_and_counts(sample_top, monkeypatch, kind):
    db = sample_top.db; grant_media(db); source = capture_origin(db, origin(db, kind, sample_top.top))
    original = history.read_scoped_track_play_counts; seen = []
    def counts(connection, **kwargs):
        result = original(connection, **kwargs); seen.append(connection.info.backend_pid)
        connection.execute("update library.track_popularity_mapping_slots set current_revision=null where track_id=%s", (db.tracks[0],))
        return result
    monkeypatch.setattr(history, "read_scoped_track_play_counts", counts)
    with pytest.raises(PlaylistError): queue(db, source)
    assert len(seen) == 1


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("failure", ["expired", "missing"])
def test_typed_receipt_lookup_keeps_expiry_and_missing_semantics_without_recreation(sample_top, monkeypatch, kind, failure):
    db = sample_top.db; value = origin(db, kind, sample_top.top); key = str(uuid4())
    source = capture_origin(db, value, key=key)
    if failure == "expired": db.clock_time += sources.SOURCE_LIFETIME
    else:
        with db.connect() as con: con.execute("delete from app.playlist_creation_sources where ref=%s", (key,))
    before = retained(db, key), receipt_count(db)
    monkeypatch.setattr(complete, "_header", forbidden)
    monkeypatch.setattr(evaluator, "evaluate_sample_playlist", forbidden)
    for callback in (lambda: read(db, source), lambda: recovery(db, key)):
        with pytest.raises(PlaylistError, match="source_expired" if failure == "expired" else "source_unavailable"):
            callback()
    assert (retained(db, key), receipt_count(db)) == before


@pytest.mark.parametrize("kind", KINDS)
def test_same_capture_key_cannot_change_declared_origin(sample_top, kind):
    db = sample_top.db; value = origin(db, kind, sample_top.top); key = str(uuid4())
    capture_origin(db, value, key=key); before = retained(db, key)
    other = origin(db, "album_details" if kind != "album_details" else "album_set")
    with pytest.raises(PlaylistError, match="request_key_conflict"):
        capture_origin(db, other, key=key)
    assert retained(db, key) == before
