"""0153 defense-in-depth pairing and exact frozen predecessor preservation."""
from copy import deepcopy
from pathlib import Path
import hashlib
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb
import pytest
from library_mix_postgres_support import mix_db, mix_urls
from test_sample_playlist_receipts_live import capture, retained, PROTOCOL, no_provider
from test_sample_playlist_sources_live import manual_source
from test_sample_playlist_save import payload, save
from sample_playlist_origin_support import origin, capture_origin

SOURCE_PAIRS = [("library", protocol) for protocol in (
    "library_selection_v1", "complete_inventory_selection_v1", "library_mix_selection_v1",
    "artist_popular_selection_v1", "artist_loved_selection_v1")] + [
    ("activity", "complete_activity_selection_v1"), ("activity", "missing_activity_selection_v1"),
    ("playlist", "missing_playlist_selection_v1")]


def test_exact_0153_and_frozen_0151_0152_are_constraints_only():
    directory = Path(__file__).resolve().parents[2] / "migrations" / "postgres"
    expected = {
        "0151_sample_playlist_source_receipts.sql": "b3481917904db5eaa3559ef577d9eea97da6562614ddee53c210e2dedebdc93e",
        "0152_sample_playlist_item_provenance.sql": "0d1af3fc0065b8b04e8fbe204b6a858c07e7e40f120777dc7ec9ac7e97e85bcc",
        "0153_sample_playlist_typed_origins.sql": "7945ece2667a81c73de2d5f69c17aa645480bf5aaac2d757018831e37d9db845",
    }
    for name, digest in expected.items():
        assert hashlib.sha256((directory / name).read_bytes()).hexdigest() == digest


def test_dedicated_v2_save_is_positive_library_sample_item_provenance(mix_db):
    """Precisely replaces the old library-kind SQL-negative cell, not v1 denial."""
    db = mix_db; source = capture_origin(db, origin(db))
    result = save(db, payload(source)); items = db.state(result["playlist_id"])[1]
    assert items and all(row["source_kind"] == "library" and row["source_protocol"] == PROTOCOL for row in items)
    assert retained(db, source["source"]["ref"])[0]["origin_descriptor"]["version"] == 2


@pytest.mark.parametrize("kind,protocol", SOURCE_PAIRS)
def test_normal_migrated_source_constraints_preserve_every_old_pair(mix_db, kind, protocol):
    db = mix_db; source = capture(db, manual_source(db)); key = source["source"]["ref"]
    with db.connect() as con:
        con.execute("update app.playlist_creation_sources set source_kind=%s,protocol=%s,origin_descriptor=null where ref=%s",
                    (kind, protocol, key))
    row = retained(db, key)[0]
    assert (row["source_kind"], row["protocol"], row["origin_descriptor"]) == (kind, protocol, None)


@pytest.mark.parametrize("kind,descriptor", [
    ("library", {"version": 1}), ("playlist", {"version": 2, "request": {"origin": {"kind": "album_set"}}}),
    ("library", {"version": 2}), ("library", {"version": 2, "request": {}}),
    ("library", {"version": 2, "request": {"origin": None}}),
    ("library", {"version": 2, "request": {"origin": {}}}),
    ("library", {"version": 2, "request": {"origin": {"kind": "playlist"}}}),
    ("library", {"version": 2, "request": {"origin": {"kind": "album_set"}, "playlist_ref": "alias"}}),
    ("library", {"version": 2, "request": {"origin": {"kind": "album_set"}, "revision": "1"}}),
    ("library", {"version": "2", "request": {"origin": {"kind": "album_set"}}}),
    ("library", {"version": True, "request": {"origin": {"kind": "album_set"}}}),
    ("library", {"version": 3, "request": {"origin": {"kind": "album_set"}}}),
    ("library", {}), ("library", []), ("library", None),
])
def test_sql_rejects_crossed_incomplete_or_unknown_version_origin_pair(mix_db, kind, descriptor):
    db = mix_db; source = capture(db, manual_source(db)); key = source["source"]["ref"]
    before = retained(db, key)
    with pytest.raises(psycopg.errors.CheckViolation) as error:
        with db.connect() as con:
            con.execute("update app.playlist_creation_sources set source_kind=%s,origin_descriptor=%s where ref=%s",
                        (kind, Jsonb(descriptor) if descriptor is not None else None, key))
    assert error.value.diag.constraint_name == "playlist_sample_source_origin_v1"
    assert retained(db, key) == before


def test_sql_activity_sample_remains_forbidden(mix_db):
    db = mix_db; source = capture(db, manual_source(db)); key = source["source"]["ref"]
    with pytest.raises(psycopg.errors.CheckViolation):
        with db.connect() as con:
            con.execute("update app.playlist_creation_sources set source_kind='activity' where ref=%s", (key,))


@pytest.mark.parametrize("kind", ["album_top", "album_set", "album_details"])
def test_sql_only_legal_v2_origin_kinds_are_admitted_for_full_application_validation(mix_db, kind):
    db = mix_db; source = capture(db, manual_source(db)); key = source["source"]["ref"]
    # This is deliberately SQL-only: minimal shape must STILL fail the application
    # validator. Passing this constraint cannot manufacture a valid Sample source.
    with db.connect() as con:
        con.execute("update app.playlist_creation_sources set source_kind='library',origin_descriptor=%s where ref=%s",
                    (Jsonb({"version": 2, "request": {"origin": {"kind": kind}}}), key))
    from test_sample_playlist_receipts_live import read
    from music_app.services.owned_playlists import PlaylistError
    with pytest.raises(PlaylistError, match="source_changed"):
        read(db, source | {"source": source["source"] | {"kind": "library"}})
