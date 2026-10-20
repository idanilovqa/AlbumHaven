"""Additive accepted Save-R2 contracts. Authored only; never executed locally.

Uses real migrated tables and the existing transaction/command owner. All options
are explicit fixture choices, not defaults. Historical 621 cases are untouched.
"""
from contextlib import contextmanager
from dataclasses import replace
from datetime import timedelta
from uuid import uuid4

import pytest
from library_mix_postgres_support import mix_db, mix_urls
from music_app.services import library_mix_postgres as mixes
from music_app.services.owned_playlists import PlaylistError, normalize_playlist_command, CREATE
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from test_sample_playlist_sources_live import manual_source
from test_sample_playlist_receipts_live import (
    capture, retained, destinations, forbidden, options, receipts, snapshots,
    evaluator, sources, complete, PROTOCOL, no_provider,
)


def payload(source, **changes):
    return {"request_key": str(uuid4()), "mode": "ordinary", "source_protocol": PROTOCOL,
            "source": dict(source["source"]), "title": "Explicit Sample Save",
            "description": "Retained order", "entry_refs": [e["entry_ref"] for e in source.get("entries", [])],
            **changes}


def save(db, body, **kwargs):
    return db.service.execute(kwargs.pop("context", db.context()),
                              normalize_playlist_command("create", body), **kwargs)


def ledger(db, key):
    with db.connect() as con:
        return con.execute("select * from app.playlist_operations where actor_account_id=%s and library_id=%s and request_key=%s",
                           (db.owner.account_id, db.library, key)).fetchall()


@pytest.mark.parametrize("method", ["most_listened", "random"])
def test_complete_save_is_owner_manual_playlist_with_exact_provenance(mix_db, monkeypatch, method):
    db = mix_db
    parent = manual_source(db, (4, 1, 3, 0, 2, 5))
    source = capture(db, parent, method=method,
                     order=tuple(db.tracks[i] for i in (5, 2, 0, 3, 1, 4)) if method == "random" else None)
    old_parent = db.state(parent["playlist_id"])
    old_source = retained(db, source["source"]["ref"])
    body = payload(source)
    monkeypatch.setattr(evaluator, "evaluate_sample_playlist", forbidden)
    monkeypatch.setattr(snapshots.inventory, "normalize_cached_inventory_row", forbidden)
    monkeypatch.setattr(receipts, "read", forbidden)
    monkeypatch.setattr(receipts, "capture", forbidden)
    monkeypatch.setattr(mixes, "save_recipe", forbidden)
    result = save(db, body)
    playlist, items, recipe = db.state(result["playlist_id"])
    assert result["action"] == "create" and result["request_key"] == body["request_key"]
    assert result["added_count"] == len(source["entries"]) and result["changed"] is True
    assert playlist["owner_account_id"] == db.owner.account_id and playlist["library_id"] == db.library
    assert playlist["title"] == body["title"] and playlist["description"] == body["description"]
    assert recipe is None
    assert [str(i["source_entry_ref"]) for i in items] == body["entry_refs"]
    assert [i["original_local_track_id"] for i in items] == old_source[0]["origin_descriptor"]["result"]["track_ids"]
    assert all(i["source_protocol"] == PROTOCOL and i["source_kind"] == "playlist"
               and str(i["source_ref"]) == source["source"]["ref"]
               and str(i["source_revision"]) == source["source"]["revision"] for i in items)
    assert len(ledger(db, body["request_key"])) == 1
    assert db.state(parent["playlist_id"]) == old_parent
    assert retained(db, source["source"]["ref"]) == old_source


@pytest.mark.parametrize("change", ["empty", "subset", "reverse", "duplicate", "foreign", "parent", "revision",
                                      "kind", "mode", "mix_order", "recipe", "owner", "library"])
def test_invalid_sample_command_never_writes_destination_or_operation(mix_db, change):
    db = mix_db
    parent = manual_source(db, (0, 1, 3))
    source = capture(db, parent)
    body = payload(source)
    if change == "empty": body["entry_refs"] = []
    elif change == "subset": body["entry_refs"] = body["entry_refs"][:1]
    elif change == "reverse": body["entry_refs"].reverse()
    elif change == "duplicate": body["entry_refs"] *= 2
    elif change == "foreign": body["entry_refs"][0] = str(uuid4())
    elif change == "parent": body["source"] = {"kind": "playlist", "ref": parent["playlist_id"], "revision": parent["revision"]}
    elif change == "revision": body["source"]["revision"] = str(uuid4())
    elif change == "kind": body["source"]["kind"] = "library"
    elif change == "mode": body["mode"] = "missing"
    elif change == "mix_order": body["mix_playback_order"] = "random"
    elif change == "recipe": body["recipe"] = {}
    elif change == "owner": body["owner_account_id"] = db.owner.account_id
    else: body["library_id"] = db.library
    before = destinations(db)
    with pytest.raises(PlaylistError): save(db, body)
    assert destinations(db) == before and ledger(db, body["request_key"]) == []


def test_empty_sample_rejected_without_changing_ordinary_empty_create(mix_db):
    db = mix_db
    parent = manual_source(db)
    # Explicit supported length excludes these 180-second fixtures.
    source = capture(db, parent, opts=options(length="over_10"))
    assert source["entries"] == []
    before = destinations(db)
    with pytest.raises(PlaylistError): save(db, payload(source))
    assert destinations(db) == before
    ordinary = db.service.begin_source(db.context())["data"]
    body = payload(ordinary, source_protocol="library_selection_v1", entry_refs=[])
    result = save(db, body)
    assert db.state(result["playlist_id"])[1:] == ([], None)


@pytest.mark.parametrize("change", ["expired", "deleted", "parent_revision", "membership", "identity", "entry_evidence", "descriptor", "create", "track", "album"])
def test_currentness_and_authority_failures_are_not_laundered_by_save(mix_db, change):
    db = mix_db
    parent = manual_source(db, (0, 1, 3))
    source = capture(db, parent)
    body = payload(source)
    constraints = None
    if change == "expired": db.clock_time += sources.SOURCE_LIFETIME
    elif change in ("track", "album"):
        constraints = lambda ctx: PolicyEvaluationConstraints(deployment_allowed=not (ctx.resource and ctx.resource.resource_kind == change))
    else:
        with db.connect() as con:
            if change == "deleted": con.execute("delete from app.playlist_creation_sources where ref=%s", (source["source"]["ref"],))
            elif change == "parent_revision": con.execute("update app.playlists set revision=revision+1 where ref=%s", (parent["playlist_id"],))
            elif change == "membership": con.execute("update app.playlist_items set position=position+20 where playlist_ref=%s", (parent["playlist_id"],))
            elif change == "identity": con.execute("update library.track_popularity_mapping_slots set current_revision=null where track_id=%s", (db.tracks[0],))
            elif change == "entry_evidence": con.execute("update app.playlist_creation_entries set evidence_digest=%s where source_ref=%s", ("0"*64, source["source"]["ref"]))
            elif change == "descriptor": con.execute("update app.playlist_creation_sources set origin_descriptor=jsonb_set(origin_descriptor,'{result_digest}',to_jsonb(%s::text)) where ref=%s", ("0"*64, source["source"]["ref"]))
            else: con.execute("delete from app.capabilities where account_id=%s and capability_key=%s", (db.owner.account_id, CREATE))
    before = destinations(db)
    with pytest.raises(PlaylistError): save(db, body, constraints=constraints)
    assert destinations(db) == before and ledger(db, body["request_key"]) == []


@pytest.mark.parametrize("change", ["expiry", "cleanup", "parent_revision", "ranking"])
def test_committed_replay_precedes_live_source_validation(mix_db, monkeypatch, change):
    db = mix_db
    parent = manual_source(db, (0, 1, 3))
    source = capture(db, parent)
    body = payload(source)
    result = save(db, body)
    if change == "expiry": db.clock_time += sources.SOURCE_LIFETIME
    else:
        with db.connect() as con:
            if change == "cleanup": con.execute("delete from app.playlist_creation_sources where ref=%s", (source["source"]["ref"],))
            elif change == "parent_revision": con.execute("update app.playlists set revision=revision+1 where ref=%s", (parent["playlist_id"],))
            else: db.observe(con, db.tracks[1], 999999)
    before = destinations(db)
    monkeypatch.setattr(snapshots, "_playlist_sample_snapshot", forbidden)
    monkeypatch.setattr(evaluator, "evaluate_sample_playlist", forbidden)
    assert save(db, body) == result
    assert db.service.read_operation(db.context(), body["request_key"]) == {"status": "committed", "receipt": result}
    assert destinations(db) == before
    with pytest.raises(PlaylistError, match="idempotency_key_reused"):
        save(db, body | {"title": "Different command"})


@pytest.mark.parametrize("change", ["session", "actor", "destination_access"])
def test_committed_operation_still_requires_original_scope_and_destination_access(mix_db, change):
    db = mix_db
    source = capture(db, manual_source(db))
    body = payload(source)
    result = save(db, body)
    context = db.context()
    with db.connect() as con:
        if change == "destination_access":
            other = db.member(con)
            con.execute("update app.playlists set owner_account_id=%s, visibility='private' where ref=%s", (other.account_id, result["playlist_id"]))
        else:
            actor = db.member(con)
            if change == "session":
                con.execute("update app.account_sessions set account_id=%s where id=%s", (db.owner.account_id, actor.session_id))
                actor = replace(db.owner, session_id=actor.session_id)
            context = db.context(actor)
    before = destinations(db)
    with pytest.raises(PlaylistError): save(db, body, context=context)
    assert destinations(db) == before


@pytest.mark.parametrize("stage", ["parent", "identity", "session", "expiry", "failure", "track", "album"])
def test_final_fences_enclose_actual_operation_ledger_and_rollback_all_writes(mix_db, monkeypatch, stage):
    db = mix_db
    parent = manual_source(db, (0, 1, 3))
    source = capture(db, parent)
    body = payload(source)
    before = destinations(db)
    real_authorized = db.service._authorized
    connections, ledger_writes = [], []
    resource_denied = [False]
    def constraints(ctx):
        return PolicyEvaluationConstraints(deployment_allowed=not (resource_denied[0]
            and ctx.resource and ctx.resource.resource_kind == stage))

    class ObservedConnection:
        def __init__(self, real): self.real = real
        def __getattr__(self, name): return getattr(self.real, name)
        def execute(self, query, params=None, **kwargs):
            result = self.real.execute(query, params, **kwargs)
            if "insert into app.playlist_operations" in str(query).lower():
                ledger_writes.append(self.real.info.backend_pid)
                assert self.real.execute("select count(*) as n from app.playlists where ref=%s", (params[5],)).fetchone()["n"] == 1
                if stage == "parent": self.real.execute("update app.playlist_items set position=position+20 where playlist_ref=%s", (parent["playlist_id"],))
                elif stage == "identity": self.real.execute("update library.track_popularity_mapping_slots set current_revision=null where track_id=%s", (db.tracks[0],))
                elif stage == "session": db.clock_time += timedelta(days=2)
                elif stage == "expiry": db.clock_time += sources.SOURCE_LIFETIME
                elif stage in ("track", "album"): resource_denied[0] = True
                else: raise RuntimeError("after actual ledger insert")
            return result

    @contextmanager
    def authorized(*args, **kwargs):
        with real_authorized(*args, **kwargs) as (con, live, now):
            connections.append(con.info.backend_pid)
            yield ObservedConnection(con), live, now
    monkeypatch.setattr(db.service, "_authorized", authorized)
    with pytest.raises((PlaylistError, RuntimeError)): save(db, body, constraints=constraints)
    assert len(connections) == 1 and ledger_writes == connections
    assert destinations(db) == before and ledger(db, body["request_key"]) == []
    monkeypatch.setattr(db.service, "_authorized", real_authorized)
    db.clock_time -= timedelta(days=2) if stage == "session" else sources.SOURCE_LIFETIME if stage == "expiry" else timedelta(0)
    # The same key/command remains usable after rollback. SQL mutations rolled back too.
    resource_denied[0] = False
    result = save(db, body, constraints=constraints)
    assert len(ledger(db, body["request_key"])) == 1
    assert result["request_key"] == body["request_key"]


def test_single_real_validation_scope_stays_open_through_operation_insert(mix_db, monkeypatch):
    db = mix_db
    source = capture(db, manual_source(db, (0, 1, 3)))
    body = payload(source)
    real_snapshot, real_authorized = snapshots._playlist_sample_snapshot, db.service._authorized
    authorized_connections, snapshot_connections, events = [], [], []

    @contextmanager
    def authorized(*args, **kwargs):
        with real_authorized(*args, **kwargs) as value:
            authorized_connections.append(value[0])
            yield value

    @contextmanager
    def snapshot(owner, connection, live, **kwargs):
        assert kwargs['include_observations'] is False
        snapshot_connections.append(connection)
        with real_snapshot(owner, connection, live, **kwargs) as value:
            events.append('yield')
            yield value
            row = connection.execute('select receipt from app.playlist_operations where actor_account_id=%s and library_id=%s and request_key=%s',
                                     (db.owner.account_id, db.library, body['request_key'])).fetchone()
            assert row is not None, 'Ledger insert must be inside the final validation scope'
            events.append('ledger-before-final-fences')
        events.append('final-fences-complete')
    monkeypatch.setattr(db.service, '_authorized', authorized)
    monkeypatch.setattr(snapshots, '_playlist_sample_snapshot', snapshot)
    monkeypatch.setattr(receipts, 'read', forbidden)
    monkeypatch.setattr(receipts, 'capture', forbidden)
    save(db, body)
    assert len(authorized_connections) == 1 and snapshot_connections == authorized_connections
    assert events == ['yield', 'ledger-before-final-fences', 'final-fences-complete']
