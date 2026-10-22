"""Receipt corruption, minimal schema admission and closed legacy consumers."""
from copy import deepcopy
from datetime import timedelta
from uuid import UUID, uuid4

import psycopg
from psycopg.types.json import Jsonb
import pytest
from library_mix_postgres_support import mix_db, mix_urls
from music_app.services import library_mix_postgres as mixes
from music_app.services.owned_playlists import (
    PlaylistError, normalize_playlist_command, SOURCE_PROTOCOL_KINDS,
    COMPLETE_INVENTORY_PROTOCOL, COMPLETE_ACTIVITY_PROTOCOL,
)
from test_sample_playlist_sources_live import manual_source
from test_sample_playlist_receipts_live import (
    capture, read, recovery, retained, destinations, forbidden, PROTOCOL,
    complete, sources, evaluator, snapshots, options,
)


@pytest.mark.parametrize("mutation", ["top_extra", "top_missing", "request_extra", "facts_extra", "version_bool",
    "result_extra", "duplicate_id", "duplicate_entry", "missing_entry", "extra_entry", "swapped_entries",
    "unknown_entry", "request_digest", "facts_digest", "ranking_digest", "result_digest", "ranking_mismatch"])
def test_corrupt_descriptor_is_never_repaired_or_evaluated(mix_db, monkeypatch, mutation):
    db = mix_db
    source = capture(db, manual_source(db, (0, 1, 3)))
    key = source["source"]["ref"]
    row, entries = retained(db, key)
    value = deepcopy(row["origin_descriptor"])
    if mutation == "top_extra": value["extra"] = True
    elif mutation == "top_missing": del value["source_diagnostics"]
    elif mutation == "request_extra": value["request"]["extra"] = True
    elif mutation == "facts_extra": value["facts"][0]["extra"] = True
    elif mutation == "version_bool":
        # Schema correctly rejects this before any adapter call, without bypass.
        with db.connect() as con:
            with pytest.raises(psycopg.errors.CheckViolation):
                con.execute("update app.playlist_creation_sources set origin_descriptor=%s where ref=%s", (Jsonb(value | {"version": True}), key))
        return
    elif mutation == "result_extra": value["result"]["extra"] = True
    elif mutation == "duplicate_id": value["result"]["track_ids"][1] = value["result"]["track_ids"][0]
    elif mutation == "duplicate_entry": value["result"]["entry_order"][1] = value["result"]["entry_order"][0]
    elif mutation == "missing_entry": value["result"]["entry_order"].pop()
    elif mutation == "extra_entry": value["result"]["entry_order"].append(str(uuid4()))
    elif mutation == "swapped_entries": value["result"]["entry_order"].reverse()
    elif mutation == "unknown_entry": value["result"]["entry_order"][0] = str(uuid4())
    elif mutation == "ranking_mismatch": value["ranking"][0]["track_id"] = db.tracks[-1]
    else: value[mutation] = "0" * 64
    with db.connect() as con:
        con.execute("update app.playlist_creation_sources set origin_descriptor=%s where ref=%s", (Jsonb(value), key))
    before = retained(db, key)
    monkeypatch.setattr(evaluator, "evaluate_sample_playlist", forbidden)
    with pytest.raises(PlaylistError, match="source_changed"):
        read(db, source)
    assert retained(db, key) == before


@pytest.mark.parametrize("mutation", ["entry_deleted", "entry_extra", "entry_identity", "entry_evidence", "revision", "protocol_kind"])
def test_corrupt_sql_associations_are_rejected_independently_of_descriptor_hash(mix_db, mutation):
    db = mix_db
    source = capture(db, manual_source(db, (0, 1, 3)))
    key = source["source"]["ref"]
    row, entries = retained(db, key)
    with db.connect() as con:
        if mutation == "entry_deleted":
            con.execute("delete from app.playlist_creation_entries where ref=%s", (entries[0]["ref"],))
        elif mutation == "entry_extra":
            current = sources.inventory_rows(con, db.library, [db.tracks[-1]])
            sources._observe_page(con, row, list(current.values()))
        elif mutation == "entry_identity":
            con.execute("update app.playlist_creation_entries set original_local_track_id=%s where ref=%s", (db.tracks[-1], entries[0]["ref"]))
        elif mutation == "entry_evidence":
            con.execute("update app.playlist_creation_entries set evidence_digest=%s where ref=%s", ("f" * 64, entries[0]["ref"]))
        elif mutation == "revision":
            source = source | {"source": source["source"] | {"revision": str(uuid4())}}
        else:
            con.execute("update app.playlist_creation_sources set protocol='complete_inventory_selection_v1',source_kind='library' where ref=%s", (key,))
    with pytest.raises(PlaylistError, match="source_changed"):
        read(db, source)


@pytest.mark.parametrize("consumer,alias", [
    ("create", "complete"), ("create", "mix"),
    ("complete_read", "sample"), ("complete_read", "complete"), ("complete_read", "mix"),
    ("mix_read", "sample"), ("mix_read", "complete"), ("mix_read", "mix"),
    ("mix_queue", "sample"), ("mix_queue", "complete"), ("mix_queue", "mix"),
])
def test_sample_ref_cannot_be_consumed_via_direct_or_forged_legacy_protocol(mix_db, consumer, alias):
    db = mix_db
    source = capture(db, manual_source(db))
    before = destinations(db), retained(db, source["source"]["ref"])
    protocol = PROTOCOL if alias == "sample" else COMPLETE_INVENTORY_PROTOCOL if alias == "complete" else "library_mix_selection_v1"
    kind = "playlist" if alias == "sample" else "library"
    with pytest.raises(PlaylistError):
        if consumer == "create":
            command = normalize_playlist_command("create", {"request_key": str(uuid4()),
                "source_protocol": protocol, "mode": "ordinary", "source": source["source"] | {"kind": kind},
                "title": "Must not save", "entry_refs": [entry["entry_ref"] for entry in source["entries"]]})
            db.service.execute(db.context(), command)
        elif consumer == "complete_read":
            complete.CompletePlaylistSources(playlists=db.service).read(db.context(),
                ref=source["source"]["ref"], revision=source["source"]["revision"], protocol=protocol)
        elif consumer == "mix_read":
            mixes.read_capture(db.service, db.context(), source["source"]["ref"], source["source"]["revision"], protocol=protocol)
        else:
            mixes.native_queue(db.service, db.context(), {"source_ref": source["source"]["ref"],
                "source_revision": source["source"]["revision"],
                "entry_refs": [entry["entry_ref"] for entry in source["entries"]],
                "starting_entry_ref": source["entries"][0]["entry_ref"]}, protocol=protocol, media_resolver=db.media_resolver)
    assert (destinations(db), retained(db, source["source"]["ref"])) == before
    assert SOURCE_PROTOCOL_KINDS[PROTOCOL] == "playlist"


@pytest.mark.parametrize("explicit", [False, True])
def test_shared_header_preserves_default_or_uses_explicit_uuid_with_fresh_revision(mix_db, explicit):
    db = mix_db
    key = str(uuid4())
    with db.service._authorized(db.context(), None) as (con, live, now):
        source = complete._header(con, live, now, protocol=COMPLETE_INVENTORY_PROTOCOL, kind="library",
            **({"source_ref": key.upper()} if explicit else {}))
        assert str(UUID(source["revision"])) == source["revision"]
        assert str(UUID(source["ref"])) == source["ref"]
        assert source["revision"] != source["ref"]
        if explicit: assert source["ref"] == key
        assert source["expires_at"] == now + timedelta(minutes=30)
        assert source["origin_descriptor"] is None
    row, entries = retained(db, source["ref"])
    assert row is not None and entries == []


@pytest.mark.parametrize("descriptor", [None, [], {}, {"version": None}, {"version": "1"}, {"version": True}, {"version": 2}])
def test_migration_rejects_missing_or_wrong_sample_version_shape(mix_db, descriptor):
    db = mix_db
    key = str(uuid4())
    with pytest.raises(psycopg.errors.CheckViolation):
        with db.connect() as con:
            complete._header(con, db.context(), db.clock_time, protocol=PROTOCOL, kind="playlist", origin=descriptor, source_ref=key)
    assert retained(db, key) == (None, [])


@pytest.mark.parametrize("protocol,kind", [
    ("library_selection_v1", "library"), ("complete_inventory_selection_v1", "library"),
    ("library_mix_selection_v1", "library"), ("artist_popular_selection_v1", "library"),
    ("artist_loved_selection_v1", "library"), ("complete_activity_selection_v1", "activity"),
    ("missing_activity_selection_v1", "activity"), ("missing_playlist_selection_v1", "playlist"),
])
def test_migration_preserves_every_retained_legacy_pair_and_null_origin(mix_db, protocol, kind):
    db = mix_db
    with db.connect() as con:
        source = complete._header(con, db.context(), db.clock_time, protocol=protocol, kind=kind)
    assert retained(db, source["ref"])[0]["origin_descriptor"] is None


@pytest.mark.parametrize("kind", ["library", "activity"])
def test_migration_rejects_sample_with_wrong_kind(mix_db, kind):
    db = mix_db
    with pytest.raises(psycopg.errors.CheckViolation):
        with db.connect() as con:
            complete._header(con, db.context(), db.clock_time, protocol=PROTOCOL, kind=kind, origin={"version": 1})


@pytest.mark.parametrize("size", [2097151, 2097152, 2097153])
def test_sample_jsonb_byte_limit_is_defense_in_depth(mix_db, size):
    db = mix_db
    key = str(uuid4())
    with db.connect() as con:
        base = {"version": 1, "padding": ""}
        overhead = con.execute("select octet_length(%s::jsonb::text) as n", (Jsonb(base),)).fetchone()["n"]
    descriptor = base | {"padding": "x" * (size - overhead)}
    def insert():
        with db.connect() as con:
            assert con.execute("select octet_length(%s::jsonb::text) as n", (Jsonb(descriptor),)).fetchone()["n"] == size
            complete._header(con, db.context(), db.clock_time, protocol=PROTOCOL, kind="playlist",
                origin=descriptor, source_ref=key)
    if size > 2097152:
        with pytest.raises(psycopg.errors.CheckViolation): insert()
        assert retained(db, key) == (None, [])
    else:
        insert()
        assert retained(db, key)[0]["origin_descriptor"] == descriptor


def test_runtime_oversized_exact_evidence_fails_413_before_header_insert(mix_db, monkeypatch):
    import json
    from test_sample_playlist_receipts_live import receipts
    db = mix_db
    evidence = "evidence:" + "é" * 700
    assert len(evidence.encode("utf-8")) <= 2048
    # Legal indexed scalars, matching asserted/tag identities and ordinary
    # active-root file rows make the aggregate descriptor, not setup, too large.
    seeds = [(uuid4().hex, str(uuid4())) for _ in range(1024)]
    with db.connect() as con:
        added = con.execute("""insert into library.local_tracks
            (library_id,artist_id,album_id,track_key,title,disc_number,track_number,
             duration_seconds,mbid,mbid_assertion_state,evidence_source)
            select a.library_id,a.artist_id,a.id,seed.track_key,'Receipt byte fixture',
                1,1,180,seed.mbid,'asserted',%s
            from library.local_albums a
            cross join unnest(%s::text[],%s::uuid[]) as seed(track_key,mbid)
            where a.library_id=%s and a.id=%s returning id""",
            (evidence, [seed[0] for seed in seeds], [seed[1] for seed in seeds], db.library, db.albums[0])).fetchall()
        tracks = tuple(sorted(row["id"] for row in added))
        assert len(tracks) == 1024 < 5001
        con.execute("""insert into library.local_track_files
            (track_id,library_root_id,private_path,content_signature,metadata)
            select t.id,%s,%s||t.id::text||'.wav','receipt-byte-fixture',
                jsonb_build_object('scan_cache',jsonb_build_object('file_entry',
                    jsonb_build_object('musicbrainz_recording_id',t.mbid::text,
                        'musicbrainz_artist_ids',jsonb_build_array(%s::text),
                        'musicbrainz_album_artist_ids',jsonb_build_array(%s::text))))
            from library.local_tracks t where t.library_id=%s and t.id=any(%s::bigint[])""",
            (db.root_id, str(db.root_path / 'receipt-byte-'), db.artist_mbids[0],
             db.artist_mbids[0], db.library, list(tracks)))
    start = len(db.tracks)
    db.tracks.extend(tracks)
    parent = manual_source(db, range(start, len(db.tracks)))
    key = str(uuid4())
    before = destinations(db)
    original_preflight = receipts._preflight
    probes = []
    def preflight(connection, value):
        # A forwarding observation of the real live-capture descriptor proves
        # it is coherent and over the byte cap before the header boundary.
        receipts._descriptor_parts(value)
        assert [fact["track_id"] for fact in value["facts"]] == list(tracks)
        assert value["result"]["track_ids"] == [tracks[0]]
        assert value["result"]["entry_order"] == []
        for fact in value["facts"]:
            identity = fact["identity_evidence"]
            assert identity["mapping"] is None
            assert fact["recording_evidence"] == identity["asserted_recording"]["source"] == evidence
        canonical_size = len(json.dumps(value, sort_keys=True, separators=(",", ":"),
            ensure_ascii=False, allow_nan=False).encode("utf-8"))
        jsonb_size = connection.execute("select octet_length(%s::jsonb::text) as n", (Jsonb(value),)).fetchone()["n"]
        assert canonical_size > 2097152 and jsonb_size > 2097152
        probes.append((canonical_size, jsonb_size))
        return original_preflight(connection, value)
    monkeypatch.setattr(receipts, "_preflight", preflight)
    monkeypatch.setattr(complete, "_header", forbidden)
    with pytest.raises(PlaylistError, match="source_too_large") as error:
        capture(db, parent, key=key, method="random", order=tracks)
    assert error.value.status_code == 413 and len(probes) == 1
    assert retained(db, key) == (None, [])
    assert destinations(db) == before

# Imported autouse fixture also protects this independently scheduled module.
from test_sample_playlist_receipts_live import no_provider
