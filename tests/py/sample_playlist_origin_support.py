"""Typed-origin test inputs over existing migrated owners, no authority substitutes."""
from dataclasses import replace
from types import SimpleNamespace
from uuid import uuid4

import pytest
from music_app.services.current_actor import CapabilityGrant
from music_app.services.owned_album_tops import normalize_top_command
from music_app.services.owned_album_tops_postgres import PostgresOwnedAlbumTopsService
from test_sample_playlist_receipts_live import options, receipts

KINDS = ("album_top", "album_set", "album_details")


def album_ref(db, index=0):
    return f"inventory-album:{db.library}:{db.albums[index]}"


def track_ref(db, index=0):
    return f"inventory-track:{db.library}:{db.tracks[index]}"


def origin(db, kind="album_set", top=None):
    if kind == "album_top":
        return {"kind": kind, "top_ref": top["top_ref"], "revision": top["revision"]}
    if kind == "album_set":
        return {"kind": kind, "selections": [{"kind": "local", "inventory_album_ref": album_ref(db, i)} for i in (1, 0)]}
    return {"kind": kind, "track_refs": [track_ref(db, i) for i in (3, 1, 0)]}


def capture_origin(db, value, *, key=None, method="most_listened", order=None, opts=None, **kwargs):
    return receipts.capture(db.service, kwargs.pop("context", db.context()), origin=value,
        options=opts or options(method), random_order=order,
        request_key=key or str(uuid4()), **kwargs)["data"]


def acquire_origin(db, value, **kwargs):
    return receipts.representatives(db.service, kwargs.pop("context", db.context()),
        origin=value, options=kwargs.pop("options", options("random")), **kwargs)["data"]


@pytest.fixture
def sample_top(mix_db):
    """Build Top membership through real admission/create, then remove mutation grants.

    Setup admission is fixture construction only. Sample must not call it. Existing
    MixDatabase owns accounts, inventory and cleanup; this fixture owns Top/catalog.
    """
    db = mix_db
    actions = ("library.album_tops.create", "library.album_tops.manage", "library.album_tops.items.manage")
    original = db.owner
    with db.connect() as con:
        for action in actions:
            con.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,%s,'library',%s)",
                        (db.owner.account_id, action, db.library))
    db.owner = replace(db.owner, capability_grants=(*db.owner.capability_grants,
        *(CapabilityGrant(action, "library", db.library) for action in actions)))
    tops = PostgresOwnedAlbumTopsService(db.config, connect=db.app_connect, clock=lambda: db.clock_time)
    catalog = []
    try:
        for identity in db.albums:
            catalog.append(tops.admit_inventory_album(db.context(), album_id=identity)["album_ref"])
        top = tops.execute(db.context(), normalize_top_command("create", {
            "request_key": str(uuid4()), "title": "Typed Sample fixture", "description": "",
            "album_refs": list(reversed(catalog))}))
        with db.connect() as con:
            con.execute("delete from app.capabilities where account_id=%s and capability_key=any(%s)",
                        (db.owner.account_id, list(actions)))
        db.owner = original
        yield SimpleNamespace(db=db, tops=tops, top=top, catalog=catalog)
    finally:
        db.owner = original
        with db.connect() as con:
            con.execute("delete from app.album_list_operations where library_id=%s", (db.library,))
            con.execute("delete from app.album_lists where library_id=%s", (db.library,))
            con.execute("delete from library.catalog_album_links where library_id=%s", (db.library,))
            for ref in catalog:
                con.execute("delete from catalog.release_groups where ref=%s", (ref,))
