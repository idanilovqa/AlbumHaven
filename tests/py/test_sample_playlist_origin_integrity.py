"""Versioned proof association remains strict even after attacker recomputation."""
from copy import deepcopy
import json
from uuid import uuid4

import pytest
from psycopg.types.json import Jsonb
from library_mix_postgres_support import mix_db, mix_urls
from music_app.services.owned_playlists import PlaylistError
from test_sample_playlist_receipts_live import receipts, read, recovery, retained, destinations, no_provider
from test_sample_playlist_save import payload, save
from test_sample_playlist_native_live import queue
from sample_playlist_origin_support import KINDS, origin, capture_origin, sample_top, track_ref, album_ref
from test_sample_playlist_origins_live import independent_digest


def rehash(value):
    for field, domain in (("request", "request_v2"), ("origin_proof", "membership_v2"),
                           ("facts", "facts_v1"), ("ranking", "ranking_v1"), ("result", "result_v1")):
        key = "membership_digest" if field == "origin_proof" else field + "_digest"
        value[key] = None if field == "ranking" and value[field] is None else independent_digest(domain, value[field])
    return value


MUTATIONS = [
    "proof_extra", "member_extra", "missing_member", "reordered_members", "index_bool", "index_gap",
    "index_negative", "wrong_proof_kind", "album_mismatch", "track_foreign", "track_duplicate",
    "tracks_reversed", "fake_catalog", "fake_item", "remote_on_local", "omission_with_tracks",
    "fact_unassociated", "fact_duplicate", "fact_wrong_position", "result_entry_mismatch",
    "request_extra", "request_parent_alias", "unknown_omission", "diagnostic_index_alias",
]


@pytest.mark.parametrize("mutation", MUTATIONS)
def test_rehashed_v2_corruption_cannot_forge_proof_identity_or_order(mix_db, mutation):
    db = mix_db; value = origin(db); source = capture_origin(db, value); key = source["source"]["ref"]
    descriptor = deepcopy(retained(db, key)[0]["origin_descriptor"])
    proof = descriptor["origin_proof"]; member = proof["members"][0]
    if mutation == "proof_extra": proof["parent"] = "invented"
    elif mutation == "member_extra": member["title"] = "untrusted"
    elif mutation == "missing_member": proof["members"].pop()
    elif mutation == "reordered_members": proof["members"].reverse()
    elif mutation == "index_bool": member["index"] = False
    elif mutation == "index_gap": member["index"] = 3
    elif mutation == "index_negative": member["index"] = -1
    elif mutation == "wrong_proof_kind": proof["kind"] = "album_details"
    elif mutation == "album_mismatch": member["inventory_album_ref"] = album_ref(db, 0)
    elif mutation == "track_foreign": member["track_refs"][0] = f"inventory-track:{db.library + 1}:1"
    elif mutation == "track_duplicate": member["track_refs"][1] = member["track_refs"][0]
    elif mutation == "tracks_reversed": member["track_refs"].reverse()
    elif mutation == "fake_catalog": member["catalog_ref"] = str(uuid4())
    elif mutation == "fake_item": member["item_ref"] = str(uuid4())
    elif mutation == "remote_on_local": member["remote_admission_ref"] = str(uuid4())
    elif mutation == "omission_with_tracks": member["omission"] = "unavailable"
    elif mutation == "fact_unassociated": descriptor["facts"][0]["track_id"] = 9223372036854775807
    elif mutation == "fact_duplicate": descriptor["facts"][1] = deepcopy(descriptor["facts"][0])
    elif mutation == "fact_wrong_position": descriptor["facts"][0]["source_position"] = 999
    elif mutation == "result_entry_mismatch": descriptor["result"]["entry_order"].reverse()
    elif mutation == "request_extra": descriptor["request"]["actor"] = db.owner.account_id
    elif mutation == "request_parent_alias": descriptor["request"]["origin"]["revision"] = "1"
    elif mutation == "unknown_omission": member["omission"] = "download_required"
    else: descriptor["source_diagnostics"] = [[0, "unavailable"]]
    with db.connect() as con:
        con.execute("update app.playlist_creation_sources set origin_descriptor=%s where ref=%s", (Jsonb(rehash(descriptor)), key))
    before = destinations(db)
    with pytest.raises(PlaylistError, match="source_changed") as error: read(db, source)
    assert error.value.status_code == 409 and destinations(db) == before


@pytest.mark.parametrize("consumer", ["read", "recovery", "replay", "save", "queue"])
def test_all_dedicated_consumers_share_the_same_origin_validator(mix_db, consumer):
    db = mix_db; value = origin(db); source = capture_origin(db, value); key = source["source"]["ref"]
    descriptor = deepcopy(retained(db, key)[0]["origin_descriptor"])
    descriptor["origin_proof"]["members"][0]["track_refs"].reverse()
    with db.connect() as con:
        con.execute("update app.playlist_creation_sources set origin_descriptor=%s where ref=%s", (Jsonb(rehash(descriptor)), key))
    callbacks = {"read": lambda: read(db, source), "recovery": lambda: recovery(db, key),
        "replay": lambda: capture_origin(db, value, key=key), "save": lambda: save(db, payload(source)), "queue": lambda: queue(db, source)}
    before = destinations(db)
    with pytest.raises(PlaylistError, match="source_changed"): callbacks[consumer]()
    assert destinations(db) == before


@pytest.mark.parametrize("field,domain", [("request", "request_v1"), ("origin_proof", "membership_v1"),
    ("facts", "facts_v2"), ("ranking", "ranking_v2"), ("result", "result_v2")])
def test_v2_accepts_only_the_exact_domain_separation(mix_db, field, domain):
    db = mix_db; source = capture_origin(db, origin(db)); key = source["source"]["ref"]
    descriptor = deepcopy(retained(db, key)[0]["origin_descriptor"])
    digest = "membership_digest" if field == "origin_proof" else field + "_digest"
    descriptor[digest] = independent_digest(domain, descriptor[field])
    with db.connect() as con:
        con.execute("update app.playlist_creation_sources set origin_descriptor=%s where ref=%s", (Jsonb(descriptor), key))
    with pytest.raises(PlaylistError, match="source_changed"): read(db, source)


@pytest.mark.parametrize("version", [True, 2.0, "2", 0, 1, 3, None])
def test_application_version_is_exact_integer_not_sql_numeric_equivalence(mix_db, version):
    db = mix_db; source = capture_origin(db, origin(db))
    value = deepcopy(retained(db, source["source"]["ref"])[0]["origin_descriptor"]); value["version"] = version
    with pytest.raises(PlaylistError, match="source_changed"):
        receipts._validate_descriptor_shape(value)


@pytest.mark.parametrize("field,maximum", [("proof", 5000), ("facts", 5000), ("ranking", 5000),
    ("result_ids", 5000), ("entry_order", 5000), ("request_random", 5000), ("result_random", 5000), ("groups", 5000), ("source_diagnostics", 5000), ("diagnostics", 20000)])
def test_stored_v2_cardinality_fails_413_before_deep_validation(mix_db, field, maximum):
    db = mix_db; source = capture_origin(db, origin(db)); value = deepcopy(retained(db, source["source"]["ref"])[0]["origin_descriptor"])
    if field == "proof": value["origin_proof"]["members"] = [None] * (maximum + 1)
    elif field in ("facts", "ranking", "source_diagnostics"): value[field] = [None] * (maximum + 1)
    elif field == "request_random": value["request"]["random_order"] = [None] * (maximum + 1)
    elif field == "result_random": value["result"]["random_order"] = [None] * (maximum + 1)
    else:
        key = {"result_ids": "track_ids", "groups": "group_counts"}.get(field, field)
        value["result"][key] = [None] * (maximum + 1)
    with pytest.raises(PlaylistError, match="source_too_large") as error:
        receipts._validate_descriptor_shape(value)
    assert error.value.status_code == 413


@pytest.mark.parametrize("representation", ["json", "jsonb_text"])
def test_two_mib_preflight_uses_utf8_and_actual_jsonb_text(mix_db, representation):
    db = mix_db; before = destinations(db)
    # Keep an otherwise structurally valid real descriptor. Padding is one
    # existing diagnostic text scalar, not an unknown key that fails first.
    source = capture_origin(db, origin(db))
    value = deepcopy(retained(db, source["source"]["ref"])[0]["origin_descriptor"])
    value["source_diagnostics"] = [[value["facts"][0]["track_id"], "x"]]
    count = 2097152 - len(json_bytes(value)) - 100
    value["source_diagnostics"][0][1] = "é" * 1048576 if representation == "json" else "x" * count
    if representation == "jsonb_text":
        import json
        assert len(json_bytes(value)) < 2097152
        assert len(json.dumps(value, ensure_ascii=False).encode("utf-8")) > 2097152
    with db.service._authorized(db.context(), None) as (con, live, now):
        with pytest.raises(PlaylistError, match="source_too_large") as error:
            receipts._preflight(con, value)
        assert error.value.status_code == 413
    assert destinations(db) == before


def json_bytes(value):
    import json
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


@pytest.mark.parametrize("kind", KINDS)
def test_generic_mix_and_persisted_playlist_queue_do_not_admit_typed_sample(sample_top, monkeypatch, kind):
    from music_app.services import library_mix_postgres as mixes
    from music_app.services.playlist_native_targets import PlaylistNativeTargets
    from music_app.services.private_native_targets import PrivateNativeTargets
    from test_sample_playlist_receipts_live import forbidden
    db = sample_top.db; source = capture_origin(db, origin(db, kind, sample_top.top)); refs = [e["entry_ref"] for e in source["entries"]]
    monkeypatch.setattr(PrivateNativeTargets, "resolve_play_queue", forbidden)
    with pytest.raises(PlaylistError): db.queue(source)
    with pytest.raises(PlaylistError):
        PlaylistNativeTargets(db.config, playlists=db.service).queue(db.context(),
            playlist_ref=source["source"]["ref"], revision="1", item_refs=refs, starting_item_ref=refs[0])


@pytest.mark.parametrize("members,expected", [(2500, None), (2501, "source_too_large")])
def test_saved_top_expanded_occurrences_are_counted_before_union_dedupe(mix_db, members, expected):
    """Pure descriptor seam covers future-valid overlap without illegal DB links.

    Today's catalog_album_links PK prevents one inventory album being linked to
    two catalog rows; this test never disables that guard or spoofs SQL authority.
    """
    from uuid import UUID
    from test_sample_playlist_origins_live import proof_member
    db = mix_db
    source = capture_origin(db, {"kind": "album_details", "track_refs": [track_ref(db, 0), track_ref(db, 1)]})
    value = deepcopy(retained(db, source["source"]["ref"])[0]["origin_descriptor"])
    value["request"]["origin"] = {"kind": "album_top", "top_ref": str(UUID(int=100)), "revision": "1"}
    value["origin_proof"] = {"kind": "album_top", "members": [proof_member(i,
        item=str(UUID(int=1000 + i)), catalog=str(UUID(int=10000 + i)), album=album_ref(db),
        tracks=[track_ref(db, 0), track_ref(db, 1)]) for i in range(members)]}
    rehash(value)
    assert len(value["facts"]) == 2 and len(value["origin_proof"]["members"]) <= 5000
    assert sum(len(row["track_refs"]) for row in value["origin_proof"]["members"]) == members * 2
    # Isolate occurrence cardinality from the independent receipt byte ceiling.
    # This small fact union fits even with spaced JSON; it is not an assertion
    # that a 5000-distinct-fact retained receipt can fit within 2 MiB.
    assert len(json.dumps(value, ensure_ascii=False).encode("utf-8")) < 2097152
    if expected:
        with pytest.raises(PlaylistError, match=expected) as error: receipts._validate_descriptor_shape(value)
        assert error.value.status_code == 413
    else:
        assert receipts._validate_descriptor_shape(value) is None
        assert [row["source_position"] for row in value["facts"]] == [0, 1]
