"""Existing retained remote Top facts are omissions, never acquisition authority."""
from dataclasses import replace
from uuid import uuid4

import pytest
from music_app.services.current_actor import CapabilityGrant
from music_app.services.owned_playlists import CREATE
from music_app.services.owned_playlists_postgres import PostgresOwnedPlaylistsService
from music_app.services import sample_playlist_receipts as receipts
from music_app.services.private_native_targets import PrivateNativeTargets
from tests.py.album_top_native_queue_postgres_support import native_queue, db, urls
from tests.py.remote_top_postgres_support import remote
from tests.py.remote_top_retention_postgres_support import retained
from tests.py.test_album_top_remote_membership_postgres import mixed
from test_sample_playlist_receipts_live import options, forbidden, no_provider


def test_remote_saved_top_with_coincident_local_inventory_never_acquires_or_imports(native_queue, mixed, monkeypatch):
    case = native_queue; database = case.db
    assert mixed.db is database
    top, _ = mixed.create(local=False); item = mixed.read(top)["items"][0]
    assert item["source_kind"] == "remote_summary"
    with database.connect() as con:
        con.execute("update library.catalog_album_links set catalog_ref=%s where local_album_id=%s", (item["catalog_ref"], case.tracks[0]["album_id"]))
        con.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,%s,'library',%s)",
                    (database.owner.account_id, CREATE, database.library))
    database.owner = replace(database.owner, capability_grants=(*database.owner.capability_grants, CapabilityGrant(CREATE, "library", database.library)))
    owner = PostgresOwnedPlaylistsService(database.service._config, connect=database.service._connect,
                                        clock=lambda: database.now)
    before = mixed.snapshot(); calls = len(mixed.remote.calls)
    monkeypatch.setattr(PrivateNativeTargets, "resolve", forbidden)
    monkeypatch.setattr(PrivateNativeTargets, "resolve_play_queue", forbidden)
    request = {"kind": "album_top", "top_ref": top["top_ref"], "revision": top["revision"]}
    key = str(uuid4())
    source = receipts.capture(owner, database.context(), origin=request, options=options(),
        random_order=None, request_key=key)["data"]
    assert source["entries"] == []
    with database.connect() as con:
        descriptor = con.execute("select origin_descriptor from app.playlist_creation_sources where ref=%s", (key,)).fetchone()["origin_descriptor"]
    members = descriptor["origin_proof"]["members"]
    assert len(members) == 1
    assert members[0]["item_ref"] == item["ref"] and members[0]["catalog_ref"] == item["catalog_ref"]
    assert members[0]["remote_admission_ref"] is not None
    assert members[0]["inventory_album_ref"] is None and members[0]["track_refs"] == [] and members[0]["omission"] == "remote_summary"
    assert descriptor["facts"] == [] and descriptor["source_diagnostics"] == []
    assert receipts.read(owner, database.context(), source_ref=key, source_revision=source["source"]["revision"])["data"] == source
    assert mixed.snapshot() == before and len(mixed.remote.calls) == calls and case.probes == []
    assert case.tracks[0]["title"] not in repr(source)
