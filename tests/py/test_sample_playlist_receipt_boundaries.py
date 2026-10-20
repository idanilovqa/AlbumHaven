"""Bounded R2 supplement: independent oracles, corruption and real owner fences."""
from dataclasses import replace
from datetime import timedelta, timezone
from decimal import Decimal
from uuid import uuid4
from copy import deepcopy
import hashlib
import json

import pytest
from psycopg.types.json import Jsonb
from library_mix_postgres_support import mix_db, mix_urls, MixDatabase
from music_app.services.owned_playlists import PlaylistError, CREATE
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.playlist_native_targets import PlaylistNativeTargets
from music_app.services.private_native_targets import PrivateNativeTargets
from test_sample_playlist_sources_live import manual_source
from test_sample_playlist_receipts_live import (
    capture, read, recovery, retained, destinations, options, forbidden, no_provider,
    sources, complete, snapshots, evaluator, receipts, PROTOCOL,
)


def test_other_library_cannot_read_or_recover_actor_owned_receipt(mix_db, mix_urls, tmp_path):
    db = mix_db
    source = capture(db, manual_source(db))
    other = MixDatabase(mix_urls, tmp_path / "other-library")
    other.root_path.mkdir()
    try:
        other.setup()
        with other.connect() as con:
            con.execute("insert into library.library_memberships(account_id,library_id,membership_role) values(%s,%s,'member')", (db.owner.account_id, other.library))
            con.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,%s,'library',%s)", (db.owner.account_id, CREATE, other.library))
            # The ordinary owner's existing Browse grant is library scoped too.
            from music_app.services.owned_playlists import BROWSE
            con.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,%s,'library',%s)", (db.owner.account_id, BROWSE, other.library))
        actor = replace(db.owner, current_library_id=other.library,
            library_relationships=other.owner.library_relationships,
            capability_grants=other.owner.capability_grants)
        for operation in (lambda: read(other, source, context=other.context(actor)),
                          lambda: recovery(other, source["source"]["ref"], context=other.context(actor))):
            with pytest.raises(PlaylistError, match="source_unavailable") as error:
                operation()
            assert error.value.status_code == 404
    finally:
        other.cleanup()


def test_same_scope_legacy_request_key_collision_is_unavailable_not_input_conflict(mix_db):
    db = mix_db
    parent = manual_source(db)
    key = str(uuid4())
    with db.service._authorized(db.context(), None) as (con, live, now):
        complete._header(con, live, now, protocol="complete_inventory_selection_v1", kind="library", source_ref=key)
    before = retained(db, key)
    with pytest.raises(PlaylistError, match="source_unavailable") as error:
        capture(db, parent, key=key)
    assert error.value.status_code == 404 and retained(db, key) == before


def test_parent_becoming_private_removes_capturing_nonowner_browse(mix_db):
    db = mix_db
    parent = manual_source(db)
    with db.connect() as con:
        actor = db.member(con)
        con.execute("update app.playlists set visibility='server_shared' where ref=%s", (parent["playlist_id"],))
    source = capture(db, parent, context=db.context(actor))
    with db.connect() as con:
        con.execute("update app.playlists set visibility='private' where ref=%s", (parent["playlist_id"],))
    with pytest.raises(PlaylistError):
        read(db, source, context=db.context(actor))


@pytest.mark.parametrize("fence", ["clock", "parent", "resource"])
def test_empty_selection_keeps_final_read_fences(mix_db, monkeypatch, fence):
    db = mix_db
    parent = manual_source(db, (0,))
    # Candidate is admitted and local but excluded by an explicit Length choice.
    source = capture(db, parent, opts=options(length="over_10"))
    assert source["entries"] == []
    original = sources.selected_entries
    after_selection = False
    def selected(connection, *args, **kwargs):
        nonlocal after_selection
        result = original(connection, *args, **kwargs)
        assert result == []
        after_selection = True
        if fence == "clock": db.clock_time += sources.SOURCE_LIFETIME
        elif fence == "parent":
            connection.execute("update app.playlists set revision=revision+1 where ref=%s", (parent["playlist_id"],))
        return result
    def constraints(context):
        denied = after_selection and fence == "resource" and context.resource and context.resource.resource_kind == "track"
        return PolicyEvaluationConstraints(deployment_allowed=not denied)
    monkeypatch.setattr(sources, "selected_entries", selected)
    with pytest.raises(PlaylistError):
        read(db, source, constraints=constraints)
    assert after_selection


@pytest.mark.parametrize("operation", ["resolve", "queue"])
def test_generic_persisted_playlist_native_owner_rejects_sample_before_media_resolution(mix_db, monkeypatch, operation):
    db = mix_db
    source = capture(db, manual_source(db))
    monkeypatch.setattr(PrivateNativeTargets, "resolve", forbidden)
    monkeypatch.setattr(PrivateNativeTargets, "resolve_play_queue", forbidden)
    owner = PlaylistNativeTargets(db.config, playlists=db.service, media_resolver=forbidden)
    ref, entry = source["source"]["ref"], source["entries"][0]["entry_ref"]
    before = destinations(db)
    with pytest.raises(PlaylistError, match="playlist_unavailable"):
        if operation == "resolve":
            owner.resolve(db.context(), playlist_ref=ref, item_ref=entry, intent="play")
        else:
            owner.queue(db.context(), playlist_ref=ref, revision="1", item_refs=[entry], starting_item_ref=entry)
    assert destinations(db) == before


def independent_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
        ensure_ascii=False, allow_nan=False).encode("utf-8")).hexdigest()


def rehash(value):
    for key in ("request", "facts", "ranking", "result"):
        value[key + "_digest"] = None if key == "ranking" and value[key] is None else independent_hash(
            {"domain": key + "_v1", "value": value[key]})
    return value


def test_complete_descriptor_and_output_match_independent_fixture_oracle(mix_db):
    db = mix_db
    parent = manual_source(db, (0, 1, 3))
    ids = [db.tracks[i] for i in (0, 1, 3)]
    with db.connect() as con:
        members = con.execute("select ref,position,local_track_id,original_local_track_id from app.playlist_items where playlist_ref=%s order by position,ref", (parent["playlist_id"],)).fetchall()
        inventory = sources.inventory_rows(con, db.library, ids)
        mappings = con.execute("select m.* from library.track_popularity_mapping_versions m join library.track_popularity_mapping_slots s on s.track_id=m.track_id and s.current_revision=m.revision where m.track_id=any(%s)", (ids,)).fetchall()
        observations = con.execute("select o.* from catalog.popularity_source_observations o join catalog.popularity_source_slots s on (s.provider,s.metric,s.source_entity_id,s.current_revision)=(o.provider,o.metric,o.source_entity_id,o.source_revision) where o.source_entity_id=any(%s)", ([db.source_ids[i] for i in ids],)).fetchall()
    mapping_by_id = {row["track_id"]: row for row in mappings}
    observation_by_source = {row["source_entity_id"]: row for row in observations}
    facts, ranking = [], []
    inventory_fields = ("original_local_track_id", "inventory_evidence", "title", "artist", "album_title",
        "original_album_id", "release_year", "disc_number", "track_number", "duration_seconds", "availability")
    for position, (track, index) in enumerate(zip(ids, (0, 1, 3))):
        mapped = mapping_by_id[track]
        group = index // 3
        mapping = {"track_id": track, "mapping_revision": str(mapped["revision"]), "provider": "lastfm",
            "source_entity_id": db.source_ids[track], "canonical_recording_id": db.recordings[track],
            "recording_evidence": "lastfm.track.getInfo.mbid", "canonical_artist_id": db.artist_mbids[group],
            "artist_evidence": "lastfm.track.getInfo.artist.mbid"}
        facts.append({"track_id": track, "canonical_recording_id": db.recordings[track],
            "recording_evidence": "lastfm.track.getInfo.mbid", "album_ref": f"inventory-album:{db.library}:{db.albums[group]}",
            "primary_artist_ref": "musicbrainz-artist:" + db.artist_mbids[group],
            "source_position": members[position]["position"], "disc_number": 1, "track_number": index % 3 + 1,
            "duration_seconds": {"type": "decimal", "sign": 0, "digits": [1, 8, 0, 0, 0, 0], "exponent": -3},
            "styles": None, "countries": None,
            "inventory_digest": independent_hash({name: inventory[track].get(name) for name in inventory_fields}),
            "identity_evidence": {"mapping": mapping, "asserted_recording": None, "asserted_track_artist": None}})
        observation = observation_by_source[db.source_ids[track]]
        ranking.append({"track_id": track, "mapping": mapping,
            "popularity": {"local_track_id": track, "mapping_revision": str(mapped["revision"]),
                "observation": {"provider": "lastfm", "metric": "overall_scrobbles", "source_entity_id": db.source_ids[track],
                    "source_revision": str(observation["source_revision"]),
                    "observed_at": observation["observed_at"].astimezone(timezone.utc).isoformat(timespec="microseconds"),
                    "imported_at": observation["imported_at"].astimezone(timezone.utc).isoformat(timespec="microseconds"),
                    "count": (300, 200, 90)[position], "attribution_state": "resolved"}}})
    source = capture(db, parent)
    row, entries = retained(db, source["source"]["ref"])
    by_track = {entry["original_local_track_id"]: entry for entry in entries}
    expected = rehash({"version": 1,
        "request": {"playlist_ref": parent["playlist_id"], "revision": parent["revision"],
            "options": {"selection_basis": "per_album", "songs_per_group": 1, "unknown_facets": "include",
                        "selection_method": "most_listened", "length": None, "styles": None, "countries": None},
            "random_order": None},
        "membership_digest": independent_hash([[str(m["ref"]), m["position"], m["local_track_id"], m["original_local_track_id"]] for m in members]),
        "facts": facts, "ranking": ranking,
        "result": {"track_ids": [ids[0], ids[2]], "entry_order": [str(by_track[i]["ref"]) for i in (ids[0], ids[2])],
            "random_order": None, "diagnostics": [[ids[1], "quota_exceeded"]],
            "group_counts": [[f"inventory-album:{db.library}:{album}", 1] for album in db.albums]},
        "source_diagnostics": []})
    assert row["origin_descriptor"] == expected
    assert source["diagnostics"] == [[ids[1], "quota_exceeded"]]
    assert source["source_diagnostics"] == []
    assert source["group_counts"] == expected["result"]["group_counts"]
    assert [entry["inventory_track_ref"] for entry in source["entries"]] == [f"inventory-track:{db.library}:{i}" for i in (ids[0], ids[2])]


@pytest.mark.parametrize("mutation,operation", [
    ("boolean_count", "read"), ("extra_fact_key", "recovery"), ("duplicate_track", "replay"),
    ("reversed_association", "read"), ("mapping_disagreement", "recovery"), ("negative_group", "replay"),
])
def test_rehashed_malformed_descriptor_still_fails_exact_validator(mix_db, mutation, operation):
    db = mix_db
    parent = manual_source(db, (0, 1, 3))
    key = str(uuid4())
    source = capture(db, parent, key=key)
    descriptor = deepcopy(retained(db, key)[0]["origin_descriptor"])
    if mutation == "boolean_count": descriptor["ranking"][0]["popularity"]["observation"]["count"] = True
    elif mutation == "extra_fact_key": descriptor["facts"][0]["unexpected"] = "extra"
    elif mutation == "duplicate_track": descriptor["result"]["track_ids"][1] = descriptor["result"]["track_ids"][0]
    elif mutation == "reversed_association": descriptor["result"]["entry_order"].reverse()
    elif mutation == "mapping_disagreement": descriptor["ranking"][0]["mapping"]["canonical_recording_id"] = str(uuid4())
    else: descriptor["result"]["group_counts"][0][1] = -1
    rehash(descriptor)
    with db.connect() as con:
        con.execute("update app.playlist_creation_sources set origin_descriptor=%s where ref=%s", (Jsonb(descriptor), key))
    with pytest.raises(PlaylistError, match="source_changed"):
        read(db, source) if operation == "read" else recovery(db, key) if operation == "recovery" else capture(db, parent, key=key)


@pytest.mark.parametrize("value,expected", [
    (None, None), (180, {"type": "int", "value": "180"}),
    (180.0, {"type": "float", "value": "0x1.6800000000000p+7"}),
    (Decimal("180.000"), {"type": "decimal", "sign": 0, "digits": [1, 8, 0, 0, 0, 0], "exponent": -3}),
    (Decimal("-0.00"), {"type": "decimal", "sign": 1, "digits": [0], "exponent": -2}),
])
def test_exact_scalar_duration_representation(value, expected):
    assert receipts._duration_value(value) == expected


@pytest.mark.parametrize("value", [True, False, -1, float("nan"), float("inf"), Decimal("NaN"), Decimal("Infinity"), "180"])
def test_invalid_duration_scalars_never_gain_numeric_authority(value):
    with pytest.raises(PlaylistError, match="source_changed"):
        receipts._duration_value(value)


def test_timestamp_is_exact_utc_microseconds_and_rejects_naive():
    from datetime import datetime, timezone
    value = datetime(2026, 10, 20, 4, 5, 6, 7, tzinfo=timezone(timedelta(hours=2)))
    assert receipts._utc_timestamp(value) == "2026-10-20T02:05:06.000007+00:00"
    with pytest.raises(PlaylistError, match="source_changed"):
        receipts._utc_timestamp(value.replace(tzinfo=None))


@pytest.mark.parametrize("maximum", [524288, 2097152])
@pytest.mark.parametrize("delta", [-1, 0, 1])
def test_canonical_utf8_request_and_descriptor_inclusive_edges(maximum, delta):
    size = maximum + delta
    # A multibyte prefix distinguishes bytes from Python character count.
    value = "é" + "x" * (size - 4)  # two quote bytes + two UTF-8 bytes.
    if delta > 0:
        with pytest.raises(PlaylistError, match="source_too_large") as error:
            receipts._json_bytes(value, maximum)
        assert error.value.status_code == 413
    else:
        encoded = receipts._json_bytes(value, maximum)
        assert len(encoded) == size and encoded.startswith(b'"\xc3\xa9')


@pytest.mark.parametrize("value", [float("nan"), float("inf"), {"value": Decimal("1.0")}])
def test_canonical_json_does_not_coerce_unsupported_or_nonfinite_scalars(value):
    with pytest.raises(PlaylistError, match="source_changed"):
        receipts._json_bytes(value, 2097152)


def test_each_descriptor_write_is_preflighted_on_the_same_connection(mix_db, monkeypatch):
    db = mix_db
    parent = manual_source(db)
    connect = db.service._connect
    traces = []
    class ConnectionTrace:
        def __init__(self, con): self.con = con
        def __getattr__(self, name): return getattr(self.con, name)
        def execute(self, query, params=None, **kwargs):
            sql = " ".join(str(query).lower().split())
            if "octet_length" in sql and "jsonb" in sql:
                assert params is not None and "%s" in sql
                traces.append(("size", self, params))
            elif (sql.startswith("insert into app.playlist_creation_sources") or
                  sql.startswith("update app.playlist_creation_sources") and "origin_descriptor" in sql):
                value = params.get("origin_descriptor") if isinstance(params, dict) else params[0]
                assert isinstance(value, Jsonb)
                encoded = value.obj
                assert traces and traces[-1][0] == "size" and traces[-1][1] is self
                checked = traces[-1][2][0]
                checked = checked.obj if isinstance(checked, Jsonb) else json.loads(checked)
                assert checked == encoded
                traces.append(("write", self, deepcopy(encoded)))
            return self.con.execute(query, params, **kwargs)
    class Scope:
        def __init__(self, url): self.con = connect(url)
        def __enter__(self): return ConnectionTrace(self.con.__enter__())
        def __exit__(self, *args): return self.con.__exit__(*args)
    monkeypatch.setattr(db.service, "_connect", Scope)
    source = capture(db, parent)
    writes = [value for kind, _, value in traces if kind == "write"]
    assert len(writes) == 2
    assert writes[0]["result"]["entry_order"] == []
    assert writes[1]["result"]["entry_order"] == [entry["entry_ref"] for entry in source["entries"]]


@pytest.mark.parametrize("field,maximum", [
    ("facts", 5000), ("ranking", 5000), ("request_random", 5000), ("selected", 5000), ("entry_order", 5000), ("random", 5000),
    ("groups", 5000), ("diagnostics", 20000), ("source_diagnostics", 5000),
])
def test_each_descriptor_array_over_bound_is_rejected_not_truncated(mix_db, field, maximum):
    db = mix_db
    source = capture(db, manual_source(db))
    descriptor = deepcopy(retained(db, source["source"]["ref"])[0]["origin_descriptor"])
    if field in ("facts", "ranking", "source_diagnostics"):
        array = descriptor[field]
    elif field == "request_random":
        descriptor["request"]["random_order"] = []
        array = descriptor["request"]["random_order"]
    else:
        key = {"selected": "track_ids", "entry_order": "entry_order", "random": "random_order",
               "groups": "group_counts", "diagnostics": "diagnostics"}[field]
        if field == "random":
            descriptor["result"][key] = []
        array = descriptor["result"][key]
    exemplar = deepcopy(array[0]) if array else [db.tracks[0], "quota_exceeded"]
    array[:] = [deepcopy(exemplar) for _ in range(maximum + 1)]
    rehash(descriptor)
    with pytest.raises(PlaylistError, match="source_too_large"):
        receipts._validate_descriptor_shape(descriptor)
    assert len(array) == maximum + 1


def test_independent_shape_accepts_array_ceiling_before_separate_byte_gate():
    from uuid import UUID
    count = 5000
    facts = [{"track_id": i, "canonical_recording_id": str(UUID(int=i)), "recording_evidence": "owner-verified",
        "album_ref": f"inventory-album:1:{i}", "primary_artist_ref": None, "source_position": i - 1,
        "disc_number": 1, "track_number": 1, "duration_seconds": None, "styles": None, "countries": None,
        "inventory_digest": "a" * 64, "identity_evidence": {"mapping": None,
            "asserted_recording": {"canonical_id": str(UUID(int=i)), "source": "owner-verified"},
            "asserted_track_artist": None}} for i in range(1, count + 1)]
    order = list(range(1, count + 1))
    descriptor = rehash({"version": 1, "request": {"playlist_ref": str(UUID(int=10000)), "revision": "1",
        "options": {"selection_basis": "per_album", "songs_per_group": 1, "unknown_facets": "include",
            "selection_method": "random", "length": None, "styles": None, "countries": None}, "random_order": order},
        "membership_digest": "b" * 64, "facts": facts, "ranking": None,
        "result": {"track_ids": order, "entry_order": [str(UUID(int=i + 20000)) for i in order],
            "random_order": order, "diagnostics": [], "group_counts": [[f"inventory-album:1:{i}", 1] for i in order]},
        "source_diagnostics": []})
    assert receipts._validate_descriptor_shape(descriptor) is None
    # Cardinality alone does not authorize storage. Actual JSON bytes still have
    # their independent stricter cap; this large explanatory receipt exceeds it.
    assert len(json.dumps(descriptor, sort_keys=True, separators=(",", ":")).encode()) > 2097152
    with pytest.raises(PlaylistError, match="source_too_large"):
        receipts._json_bytes(descriptor, 2097152)


def test_capture_uses_exact_normalized_request_byte_guard(mix_db, monkeypatch):
    db = mix_db
    parent = manual_source(db)
    original = receipts._json_bytes
    calls = []
    def encoded(value, maximum):
        if maximum == 524288:
            calls.append(deepcopy(value))
        return original(value, maximum)
    monkeypatch.setattr(receipts, "_json_bytes", encoded)
    source = capture(db, parent)
    descriptor = retained(db, source["source"]["ref"])[0]["origin_descriptor"]
    assert calls and all(value == descriptor["request"] for value in calls)


def test_final_jsonb_growth_is_rejected_before_write_despite_canonical_bytes_fitting(mix_db, monkeypatch):
    db = mix_db
    parent = manual_source(db, (0,))
    track = db.tracks[0]
    with db.connect() as con:
        con.execute("update library.track_popularity_mapping_slots set current_revision=null where track_id=%s", (track,))
        con.execute("update library.local_tracks set mbid=%s,mbid_assertion_state='asserted',evidence_source='probe' where id=%s", (db.recordings[track], track))
    baseline = capture(db, parent, method="random", order=(track,))
    descriptor = deepcopy(retained(db, baseline["source"]["ref"])[0]["origin_descriptor"])
    with db.connect() as con:
        old_size = con.execute("select octet_length(%s::jsonb::text) as n", (Jsonb(descriptor),)).fetchone()["n"]
    # This fixture's used asserted source appears exactly twice: candidate
    # recording_evidence and its asserted_recording identity provenance.
    padding = (2097152 - old_size) // 2 + 1
    evidence = "probe" + "x" * padding
    descriptor["facts"][0]["recording_evidence"] = evidence
    descriptor["facts"][0]["identity_evidence"]["asserted_recording"]["source"] = evidence
    rehash(descriptor)
    initial = deepcopy(descriptor)
    initial["result"]["entry_order"] = []
    rehash(initial)
    assert len(json.dumps(descriptor, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()) < 2097152
    with db.connect() as con:
        final_size = con.execute("select octet_length(%s::jsonb::text) as n", (Jsonb(descriptor),)).fetchone()["n"]
        initial_size = con.execute("select octet_length(%s::jsonb::text) as n", (Jsonb(initial),)).fetchone()["n"]
        assert initial_size <= 2097152 < final_size
        con.execute("update library.local_tracks set evidence_source=%s where id=%s", (evidence, track))
    connect = db.service._connect
    oversized_probes, writes = [], []
    class Trace:
        def __init__(self, con): self.con = con
        def __getattr__(self, name): return getattr(self.con, name)
        def execute(self, query, params=None, **kwargs):
            sql = " ".join(str(query).lower().split())
            if sql.startswith(("insert into app.playlist_creation_sources", "update app.playlist_creation_sources")):
                assert not oversized_probes, "Adapter attempted descriptor write after oversized JSONB preflight"
                writes.append(sql)
            cursor = self.con.execute(query, params, **kwargs)
            if "octet_length" in sql and "jsonb" in sql:
                class SizeCursor:
                    def fetchone(inner):
                        row = cursor.fetchone()
                        assert len(row) == 1
                        if next(iter(row.values())) > 2097152:
                            oversized_probes.append(row)
                        return row
                    def __getattr__(inner, name): return getattr(cursor, name)
                return SizeCursor()
            return cursor
    class Scope:
        def __init__(self, url): self.con = connect(url)
        def __enter__(self): return Trace(self.con.__enter__())
        def __exit__(self, *args): return self.con.__exit__(*args)
    monkeypatch.setattr(db.service, "_connect", Scope)
    key = str(uuid4())
    with pytest.raises(PlaylistError, match="source_too_large") as error:
        capture(db, parent, key=key, method="random", order=(track,))
    assert error.value.status_code == 413
    assert len(writes) == 1 and len(oversized_probes) == 1
    assert retained(db, key) == (None, [])
