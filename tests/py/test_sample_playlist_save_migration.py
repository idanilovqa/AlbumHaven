"""Save-only provenance migration: normal migrated fixture, no fixture DDL."""
import hashlib
from pathlib import Path
import re

import psycopg
from psycopg.types.json import Jsonb
import pytest
from library_mix_postgres_support import mix_db, mix_urls
from test_sample_playlist_sources_live import manual_source

LEGACY = [("library", p) for p in ("library_selection_v1", "complete_inventory_selection_v1",
          "library_mix_selection_v1", "artist_popular_selection_v1", "artist_loved_selection_v1")] + [
          ("activity", "complete_activity_selection_v1"), ("activity", "missing_activity_selection_v1"),
          ("playlist", "missing_playlist_selection_v1"), ("playlist", "playlist_copy_v1")]
SAMPLE = "sample_playlist_selection_v1"


@pytest.mark.parametrize("kind,protocol", LEGACY + [("playlist", SAMPLE), ("library", None), ("activity", None), ("playlist", None)])
def test_normal_migrated_constraint_preserves_every_pair_and_null(mix_db, kind, protocol):
    db = mix_db
    parent = manual_source(db, (0,))
    if protocol == "playlist_copy_v1":
        original = parent; original_state = db.state(original["playlist_id"])
        lineage = {"playlist_ref": original["playlist_id"],
            "playlist_item_ref": str(original_state[1][0]["ref"]), "playlist_revision": original["revision"]}
        parent = manual_source(db, (0,))
    with db.connect() as con:
        if protocol == "playlist_copy_v1":
            con.execute("""update app.playlist_items set source_kind=%s,source_protocol=%s,
                source_ref=null,source_entry_ref=null,source_revision=null,source_label=null,source_lineage=%s
                where playlist_ref=%s""", (kind, protocol, Jsonb(lineage), parent["playlist_id"]))
        else:
            con.execute("update app.playlist_items set source_kind=%s,source_protocol=%s where playlist_ref=%s", (kind, protocol, parent["playlist_id"]))
    row = db.state(parent["playlist_id"])[1][0]
    assert (row["source_kind"], row["source_protocol"]) == (kind, protocol)
    if protocol == "playlist_copy_v1":
        assert row["source_lineage"] == lineage
        assert all(row[field] is None for field in ("source_ref", "source_entry_ref", "source_revision", "source_label"))
        assert db.state(original["playlist_id"]) == original_state


@pytest.mark.parametrize("kind", ["activity"])
def test_sample_wrong_kind_is_rejected_by_named_constraint(mix_db, kind):
    db = mix_db
    parent = manual_source(db, (0,))
    before = db.state(parent["playlist_id"])
    with pytest.raises(psycopg.errors.CheckViolation) as caught:
        with db.connect() as con:
            con.execute("update app.playlist_items set source_kind=%s,source_protocol=%s where playlist_ref=%s", (kind, SAMPLE, parent["playlist_id"]))
    assert caught.value.diag.constraint_name == "playlist_items_source_protocol_kind"
    assert db.state(parent["playlist_id"]) == before


def test_save_migration_changes_only_exact_item_constraint_and_not_receipt0151():
    root = Path(__file__).resolve().parents[2]
    directory = root / "migrations" / "postgres"
    # Approved phase successor: pin the original 0152 bytes exactly.
    # The new 0153 receives its own independent exact assertion.
    migration = directory / "0152_sample_playlist_item_provenance.sql"
    assert hashlib.sha256(migration.read_bytes()).hexdigest() == "0d1af3fc0065b8b04e8fbe204b6a858c07e7e40f120777dc7ec9ac7e97e85bcc"
    text = re.sub(r'--[^\n]*', '', migration.read_text())
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
    statements = [re.sub(r'\s+', '', statement).lower() for statement in text.split(';') if statement.strip()]
    assert statements == [
        'altertableapp.playlist_itemsdropconstraintplaylist_items_source_protocol_kind',
        "altertableapp.playlist_itemsaddconstraintplaylist_items_source_protocol_kindcheck("
        "source_protocolisnullor(source_kind='library'andsource_protocolin('library_selection_v1',"
        "'complete_inventory_selection_v1','library_mix_selection_v1','artist_popular_selection_v1','artist_loved_selection_v1'))"
        "or(source_kind='activity'andsource_protocolin('complete_activity_selection_v1','missing_activity_selection_v1'))"
        "or(source_kind='playlist'andsource_protocolin('missing_playlist_selection_v1','playlist_copy_v1','sample_playlist_selection_v1')))"
    ]
    assert hashlib.sha256((directory / '0151_sample_playlist_source_receipts.sql').read_bytes()).hexdigest() == 'b3481917904db5eaa3559ef577d9eea97da6562614ddee53c210e2dedebdc93e'
