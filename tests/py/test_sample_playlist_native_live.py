"""Additive Sample native owner contracts on uniquely owned migrated fixtures.

No execution performed. Uses real authority, retained source, inventory, roots,
media resolver and target owner. Forwarding spies never replace admission logic.
"""
from contextlib import contextmanager
from dataclasses import asdict, replace
from datetime import timedelta
from uuid import uuid4
import json

import pytest
from library_mix_postgres_support import mix_db, mix_urls
from test_library_mix_persistence_live import grant_media, MEDIA
from test_sample_playlist_receipts_live import (
    receipts, sources, snapshots, evaluator, complete, capture, read, retained,
    destinations, options, forbidden, no_provider, PROTOCOL,
)
from test_sample_playlist_sources_live import manual_source, snapshot
from music_app.services.owned_playlists import PlaylistError
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_native_targets import PrivateNativeTargets
from music_app.services import listen_history_postgres as history


def representatives(db, parent, **kwargs):
    return receipts.representatives(db.service, db.context(), playlist_ref=parent["playlist_id"],
        revision=parent["revision"], options=kwargs.pop("options", options("random")), **kwargs)


def queue_body(source, **changes):
    refs = [entry["entry_ref"] for entry in source["entries"]]
    return {"source_ref": source["source"]["ref"], "source_revision": source["source"]["revision"],
            "entry_refs": refs, "starting_entry_ref": refs[0], **changes}


def queue(db, source, *, payload=None, **kwargs):
    return receipts.native_queue(db.service, db.context(), payload or queue_body(source),
        media_resolver=db.media_resolver, **kwargs)


def receipt_count(db):
    with db.connect() as con:
        return con.execute("select count(*) as n from app.playlist_creation_sources where library_id=%s",
                           (db.library,)).fetchone()["n"]


@pytest.mark.parametrize("length,unknown", [(None, "include"), ("up_to_3", "exclude"), ("over_10", "include")])
def test_representatives_match_actual_evaluator_before_quota_without_state_or_observations(mix_db, monkeypatch, length, unknown):
    db = mix_db
    parent = manual_source(db, (4, 1, 3, 0, 2, 5))
    opts = options("random", length=length, unknown_facets=unknown)
    before = destinations(db), receipt_count(db), db.state(parent["playlist_id"])
    monkeypatch.setattr(snapshots.inventory, "normalize_cached_inventory_row", forbidden)
    result = representatives(db, parent, options=opts)
    assert result["status"] == "ready"
    data = result["data"]
    assert set(data) == {"parent", "options", "representative_refs", "actor_scope"}
    assert data["parent"] == {"playlist_ref": parent["playlist_id"], "revision": parent["revision"]}
    assert data["options"] == asdict(opts)
    assert data["actor_scope"] == {"account_id": db.owner.account_id, "library_id": db.library}
    refs = data["representative_refs"]
    expected = [] if length == "over_10" else [f"inventory-track:{db.library}:{db.tracks[i]}" for i in (4, 1, 3, 0, 2, 5)]
    assert refs == expected and len(refs) == len(set(refs))
    ids = tuple(int(ref.rsplit(":", 1)[1]) for ref in refs)
    with snapshot(db, parent, selection_method="random") as captured:
        selection = evaluator.evaluate_sample_playlist(captured.candidates,
            replace(opts, songs_per_group=5000), random_order=tuple(reversed(ids)))
    assert selection.track_ids == tuple(reversed(ids))
    assert str(db.root_path) not in json.dumps(data)
    assert (destinations(db), receipt_count(db), db.state(parent["playlist_id"])) == before


def test_representatives_rejects_most_listened_without_receipt(mix_db):
    db = mix_db; parent = manual_source(db)
    before = receipt_count(db)
    with pytest.raises((PlaylistError, ValueError)):
        representatives(db, parent, options=options())
    assert receipt_count(db) == before


def test_acquisition_is_not_capture_authority_after_parent_revision_change(mix_db):
    db = mix_db; parent = manual_source(db, (0, 1, 3))
    acquired = representatives(db, parent)["data"]
    with db.connect() as con:
        con.execute("update app.playlists set revision=revision+1 where ref=%s", (parent["playlist_id"],))
    key = str(uuid4())
    order = tuple(int(ref.rsplit(":", 1)[1]) for ref in acquired["representative_refs"])
    with pytest.raises(PlaylistError): capture(db, parent, method="random", order=order, key=key)
    assert retained(db, key) == (None, [])


def test_acquisition_permutation_rejects_changed_representative_set(mix_db):
    db = mix_db; parent = manual_source(db, (0, 1, 3))
    acquired = representatives(db, parent)["data"]
    key = str(uuid4())
    order = tuple(int(ref.rsplit(":", 1)[1]) for ref in acquired["representative_refs"])
    def constraints(ctx):
        return PolicyEvaluationConstraints(deployment_allowed=not (ctx.resource and
            ctx.resource.resource_kind == "track" and ctx.resource.resource_ref == str(db.tracks[1])))
    with pytest.raises((PlaylistError, ValueError)):
        capture(db, parent, key=key, method="random", order=order, constraints=constraints)
    assert retained(db, key) == (None, [])


@pytest.mark.parametrize("method", ["random", "most_listened"])
def test_native_queue_keeps_exact_captured_order_and_real_targets_no_writes(mix_db, monkeypatch, method):
    db = mix_db; grant_media(db)
    parent = manual_source(db, (0, 1, 3))
    source = capture(db, parent, method=method,
                     order=tuple(db.tracks[i] for i in (3, 1, 0)) if method == "random" else None)
    refs = [entry["entry_ref"] for entry in source["entries"]]
    before = destinations(db), retained(db, source["source"]["ref"]), receipt_count(db)
    monkeypatch.setattr(evaluator, "evaluate_sample_playlist", forbidden)
    monkeypatch.setattr(receipts, "capture", forbidden)
    monkeypatch.setattr(complete, "_header", forbidden)
    monkeypatch.setattr(snapshots.inventory, "normalize_cached_inventory_row", forbidden)
    calls = []; resolve = PrivateNativeTargets.resolve_play_queue
    def targets(self, connection, context, track_ids, **kwargs):
        calls.append((connection.info.backend_pid, list(track_ids), kwargs["constraints"]))
        return resolve(self, connection, context, track_ids, **kwargs)
    monkeypatch.setattr(PrivateNativeTargets, "resolve_play_queue", targets)
    result = queue(db, source, payload=queue_body(source, starting_entry_ref=refs[-1]))
    assert result["source"] == source["source"] and result["source_protocol"] == PROTOCOL
    assert result["starting_item_ref"] == refs[-1]
    assert [row["playlist_item_id"] for row in result["tracks"]] == refs
    assert result["unavailable_item_refs"] == [] and len(calls) == 1
    for entry, row in zip(source["entries"], result["tracks"]):
        assert row["native_target"]["playlist_item_id"] == entry["entry_ref"]
        assert row["native_target"]["inventory_track_ref"] == entry["inventory_track_ref"]
        assert row["play_count"] == 0
    assert (destinations(db), retained(db, source["source"]["ref"]), receipt_count(db)) == before
    assert read(db, source) == source  # Dedicated native actions do not mutate the frozen DTO.


@pytest.mark.parametrize("change", ["reverse", "subset", "duplicate", "foreign", "start", "extra", "revision", "parent"])
def test_native_queue_rejects_nonexact_input_before_target_resolution(mix_db, monkeypatch, change):
    db = mix_db; grant_media(db); parent = manual_source(db, (0, 1, 3))
    source = capture(db, parent); body = queue_body(source)
    if change == "reverse": body["entry_refs"].reverse()
    elif change == "subset": body["entry_refs"] = body["entry_refs"][:1]
    elif change == "duplicate": body["entry_refs"] *= 2
    elif change == "foreign": body["entry_refs"][0] = str(uuid4())
    elif change == "start": body["starting_entry_ref"] = str(uuid4())
    elif change == "extra": body["path"] = "/browser/supplied.flac"
    elif change == "revision": body["source_revision"] = str(uuid4())
    else: body["source_ref"] = parent["playlist_id"]
    monkeypatch.setattr(PrivateNativeTargets, "resolve_play_queue", forbidden)
    with pytest.raises(PlaylistError): queue(db, source, payload=body)


@pytest.mark.parametrize("starting", [False, True])
def test_current_media_denial_partitions_or_rejects_start_without_reordering(mix_db, starting):
    db = mix_db; grant_media(db); parent = manual_source(db, (0, 1, 3))
    source = capture(db, parent)
    refs = [e["entry_ref"] for e in source["entries"]]
    denied = int(source["entries"][-1]["inventory_track_ref"].rsplit(":", 1)[1])
    def constraints(ctx):
        blocked = ctx.action == MEDIA and ctx.resource and ctx.resource.resource_ref == str(denied)
        return PolicyEvaluationConstraints(deployment_allowed=not blocked)
    body = queue_body(source, starting_entry_ref=refs[-1] if starting else refs[0])
    if starting:
        with pytest.raises(PlaylistError, match="item_unavailable"): queue(db, source, payload=body, constraints=constraints)
    else:
        result = queue(db, source, payload=body, constraints=constraints)
        assert result["unavailable_item_refs"] == [refs[-1]]
        assert [r["playlist_item_id"] for r in result["tracks"]] == refs[:-1]


@pytest.mark.parametrize("change", ["media", "root", "file"])
def test_native_target_owner_rechecks_current_media_files_and_roots(mix_db, change):
    db = mix_db; grant_media(db); parent = manual_source(db, (0, 1, 3)); source = capture(db, parent)
    with db.connect() as con:
        if change == "media":
            con.execute("update app.capabilities set revoked_at=now() where account_id=%s and capability_key=%s", (db.owner.account_id, MEDIA))
        elif change == "root": con.execute("update library.library_roots set is_active=false where id=%s", (db.root_id,))
        else: con.execute("update library.local_track_files set metadata=jsonb_set(metadata,'{scan_cache,stale}','true'::jsonb) where library_root_id=%s", (db.root_id,))
    with pytest.raises(PlaylistError): queue(db, source)


@pytest.mark.parametrize("stage", ["parent", "identity", "session", "expiry", "track", "album", "media"])
def test_native_final_context_fences_run_after_actual_targets_and_counts(mix_db, monkeypatch, stage):
    db = mix_db; grant_media(db); parent = manual_source(db, (0, 1, 3)); source = capture(db, parent)
    before = destinations(db), retained(db, source["source"]["ref"])
    denied = [False]; calls = []
    original = history.read_scoped_track_play_counts
    def constraints(ctx):
        blocked = denied[0] and ctx.resource and (ctx.action == MEDIA if stage == "media"
                                                 else ctx.resource.resource_kind == stage)
        return PolicyEvaluationConstraints(deployment_allowed=not blocked)
    def counts(connection, **kwargs):
        result = original(connection, **kwargs); calls.append(connection.info.backend_pid)
        if stage == "parent": connection.execute("update app.playlist_items set position=position+20 where playlist_ref=%s", (parent["playlist_id"],))
        elif stage == "identity": connection.execute("update library.track_popularity_mapping_slots set current_revision=null where track_id=%s", (db.tracks[0],))
        elif stage == "session": db.clock_time += timedelta(days=2)
        elif stage == "expiry": db.clock_time += sources.SOURCE_LIFETIME
        else: denied[0] = True
        return result
    monkeypatch.setattr(history, "read_scoped_track_play_counts", counts)
    with pytest.raises(PlaylistError): queue(db, source, constraints=constraints)
    assert len(calls) == 1
    assert (destinations(db), retained(db, source["source"]["ref"])) == before


@pytest.mark.parametrize("stage", ["parent", "session", "track"])
def test_representative_read_runs_actual_snapshot_post_yield_fences(mix_db, monkeypatch, stage):
    db = mix_db; parent = manual_source(db, (0, 1, 3)); denied = [False]
    before = receipt_count(db)
    original = snapshots._playlist_sample_snapshot
    def constraints(ctx):
        return PolicyEvaluationConstraints(deployment_allowed=not (denied[0] and ctx.resource and ctx.resource.resource_kind == "track"))
    @contextmanager
    def observed(owner, connection, live, **kwargs):
        with original(owner, connection, live, **kwargs) as captured:
            yield captured
            if stage == "parent": connection.execute("update app.playlist_items set position=position+20 where playlist_ref=%s", (parent["playlist_id"],))
            elif stage == "session": db.clock_time += timedelta(days=2)
            else: denied[0] = True
    monkeypatch.setattr(snapshots, "_playlist_sample_snapshot", observed)
    with pytest.raises(PlaylistError): representatives(db, parent, constraints=constraints)
    assert receipt_count(db) == before


def test_representative_read_preserves_existing_complete_source_bound(mix_db, monkeypatch):
    db = mix_db; parent = manual_source(db, (0, 1, 3))
    monkeypatch.setattr(snapshots, "MAX_PLAYLIST_ITEMS_PER_COMMAND", 2)
    with pytest.raises(PlaylistError, match="source_too_large"):
        representatives(db, parent)


def test_native_queue_empty_capture_rejects_without_media_resolution(mix_db, monkeypatch):
    db = mix_db; grant_media(db); parent = manual_source(db)
    source = capture(db, parent, opts=options(length="over_10"))
    assert source["entries"] == []
    monkeypatch.setattr(PrivateNativeTargets, "resolve_play_queue", forbidden)
    with pytest.raises(PlaylistError):
        queue(db, source, payload={"source_ref": source["source"]["ref"],
            "source_revision": source["source"]["revision"], "entry_refs": [], "starting_entry_ref": str(uuid4())})


def test_representatives_deduplicate_canonical_copies_in_source_order_before_quota(mix_db):
    db = mix_db
    # Unique fixture-owned tag evidence: second physical copy resolves to the
    # first recording through the already-supported Random asserted identity seam.
    with db.connect() as con:
        con.execute("update library.local_tracks set mbid=%s,mbid_assertion_state='asserted',evidence_source='owner-verified' where id=%s",
                    (db.recordings[db.tracks[0]], db.tracks[1]))
        con.execute("update library.local_track_files set metadata=jsonb_set(metadata,'{scan_cache,file_entry,musicbrainz_recording_id}',to_jsonb(%s::text)) where track_id=%s",
                    (db.recordings[db.tracks[0]], db.tracks[1]))
        con.execute("update library.track_popularity_mapping_slots set current_revision=null where track_id=%s", (db.tracks[1],))
    parent = manual_source(db, (1, 0, 3))
    with snapshot(db, parent, selection_method="random") as captured:
        first, duplicate, other = captured.candidates
        assert (first.track_id, duplicate.track_id, other.track_id) == tuple(db.tracks[i] for i in (1, 0, 3))
        assert first.canonical_recording_id == duplicate.canonical_recording_id == db.recordings[db.tracks[0]]
        assert first.recording_evidence == "owner-verified"
    result = representatives(db, parent)["data"]
    assert result["representative_refs"] == [f"inventory-track:{db.library}:{db.tracks[i]}" for i in (1, 3)]
    order = (db.tracks[3], db.tracks[1])
    with snapshot(db, parent, selection_method="random") as captured:
        selected = evaluator.evaluate_sample_playlist(captured.candidates, options("random"), random_order=order)
    assert selected.track_ids == order
    assert (db.tracks[0], "duplicate_canonical_recording") in selected.diagnostics
    with pytest.raises(ValueError):
        evaluator.evaluate_sample_playlist(captured.candidates, options("random"),
            random_order=(db.tracks[3], db.tracks[0]))
