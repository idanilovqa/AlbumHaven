"""Saved Top membership/locks/omissions are source truth, never display hints."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from threading import Event
from uuid import uuid4

import pytest
from library_mix_postgres_support import mix_db, mix_urls
from music_app.services.owned_playlists import PlaylistError
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.owned_album_tops_postgres import PostgresOwnedAlbumTopsService
from sample_playlist_origin_support import origin, capture_origin, sample_top, album_ref, track_ref
from test_sample_playlist_receipts_live import read, retained, no_provider, forbidden, destinations, receipts, sources
from test_sample_playlist_origins_live import expected_proof
from test_sample_playlist_receipt_concurrency import assert_pg_wait
from test_sample_playlist_save import payload, save, ledger


@contextmanager
def record_sql(owner):
    original = owner._connect; logs = []; connections = []
    class Observed:
        def __init__(self, real): self.real = real
        def __getattr__(self, name): return getattr(self.real, name)
        def execute(self, sql, params=None, *args, **kwargs):
            cursor = self.real.execute(sql, params, *args, **kwargs)
            logs.append((" ".join(str(sql).lower().split()), params, self.real.info.backend_pid))
            return cursor
    @contextmanager
    def connect(url):
        with original(url) as con:
            connections.append(con.info.backend_pid); yield Observed(con)
    owner._connect = connect
    try: yield logs, connections
    finally: owner._connect = original


def viewer(case):
    db = case.db
    with db.connect() as con:
        actor = db.member(con)
        ref = str(uuid4())
        con.execute("insert into app.album_list_access_grants(ref,top_ref,library_id,account_id,role) values(%s,%s,%s,%s,'viewer')",
                    (ref, case.top["top_ref"], db.library, actor.account_id))
    return actor, ref


def test_full_saved_membership_uses_real_top_tuple_catalog_lock_and_single_connection(sample_top, monkeypatch):
    case = sample_top; db = case.db
    monkeypatch.setattr(PostgresOwnedAlbumTopsService, "admit_inventory_album", forbidden)
    with record_sql(db.service) as (logs, connections):
        source = capture_origin(db, origin(db, "album_top", case.top))
    assert len(connections) == 1 and {row[2] for row in logs} == set(connections)
    parent = next(i for i, (sql, _, _) in enumerate(logs) if "from app.album_lists" in sql and "for share" in sql)
    bindings = [(i, params) for i, (sql, params, _) in enumerate(logs) if "lock_top_native_catalog_binding" in sql]
    assert bindings and all(i > parent for i, _ in bindings)
    # Initial lock pass is catalog/ref order, not curator order. Rechecks may repeat.
    first = [params for _, params in bindings[:2]]
    assert [str(params[4]) for params in first] == sorted(case.catalog)
    members = expected_proof(case, "album_top")["members"]
    assert {(str(p[0]), str(p[1]), p[2], p[3], str(p[4])) for p in first} == {
        (case.top["top_ref"], m["item_ref"], db.library, int(case.top["revision"]), m["catalog_ref"]) for m in members}
    assert retained(db, source["source"]["ref"])[0]["origin_descriptor"]["origin_proof"]["members"] == members
    assert not any("insert into app.album_list" in sql or "insert into catalog." in sql for sql, _, _ in logs)


def test_parentless_set_never_uses_catalog_or_fabricated_top_tuple(sample_top):
    db = sample_top.db
    with record_sql(db.service) as (logs, connections): capture_origin(db, origin(db))
    assert len(connections) == 1
    assert not any("lock_top_native_catalog_binding" in sql or "catalog_album_links" in sql or "from app.album_lists" in sql for sql, _, _ in logs)
    assert any("library.local_albums" in sql and ("for update" in sql or "for share" in sql) for sql, _, _ in logs)


@pytest.mark.parametrize("change", ["revision", "position", "member", "binding", "ambiguous"])
def test_retained_saved_top_rejects_complete_membership_and_admitted_binding_changes(sample_top, change):
    case = sample_top; db = case.db; source = capture_origin(db, origin(db, "album_top", case.top))
    with db.connect() as con:
        if change == "revision": con.execute("update app.album_lists set revision=revision+1 where ref=%s", (case.top["top_ref"],))
        elif change == "position":
            before_order = con.execute("select ref,curator_position from app.album_list_items where top_ref=%s order by curator_position,ref",
                                       (case.top["top_ref"],)).fetchall()
            assert len(before_order) >= 2
            # Move only the first member to an unused end slot. This changes the
            # ordered proof without a conflicting swap or disabled uniqueness.
            end = max(row["curator_position"] for row in before_order) + 1
            con.execute("update app.album_list_items set curator_position=%s where top_ref=%s and ref=%s",
                        (end, case.top["top_ref"], before_order[0]["ref"]))
            after_order = con.execute("select ref,curator_position from app.album_list_items where top_ref=%s order by curator_position,ref",
                                      (case.top["top_ref"],)).fetchall()
            assert [row["ref"] for row in after_order] == [row["ref"] for row in before_order[1:] + before_order[:1]]
        elif change == "member": con.execute("delete from app.album_list_items where top_ref=%s and catalog_ref=%s", (case.top["top_ref"], case.catalog[0]))
        elif change == "binding": con.execute("delete from library.catalog_album_links where local_album_id=%s", (db.albums[0],))
        else:
            identity = con.execute("insert into library.local_albums(library_id,album_key,title) values(%s,%s,'Alternate') returning id", (db.library, uuid4().hex)).fetchone()["id"]
            con.execute("insert into library.catalog_album_links(library_id,local_album_id,catalog_ref) values(%s,%s,%s)", (db.library, identity, case.catalog[0]))
    before = destinations(db)
    with pytest.raises(PlaylistError): read(db, source)
    with pytest.raises(PlaylistError): save(db, payload(source))
    assert destinations(db) == before


@pytest.mark.parametrize("reason", ["unavailable", "ambiguous_edition"])
def test_saved_top_omissions_are_retained_and_do_not_grow_when_mapping_changes(sample_top, reason):
    case = sample_top; db = case.db; extra = None
    with db.connect() as con:
        if reason == "unavailable": con.execute("delete from library.catalog_album_links where local_album_id=%s", (db.albums[0],))
        else:
            extra = con.execute("insert into library.local_albums(library_id,album_key,title) values(%s,%s,'Alternate') returning id", (db.library, uuid4().hex)).fetchone()["id"]
            con.execute("insert into library.catalog_album_links(library_id,local_album_id,catalog_ref) values(%s,%s,%s)", (db.library, extra, case.catalog[0]))
    source = capture_origin(db, origin(db, "album_top", case.top), native=True)
    descriptor = retained(db, source["source"]["ref"])[0]["origin_descriptor"]
    assert len(descriptor["origin_proof"]["members"]) == 2
    omitted = descriptor["origin_proof"]["members"][1]
    assert omitted["inventory_album_ref"] is None and omitted["track_refs"] == [] and omitted["omission"] == reason
    assert source["origin_diagnostics"] == [[1, reason]]
    with db.connect() as con:
        if reason == "unavailable": con.execute("insert into library.catalog_album_links(library_id,local_album_id,catalog_ref) values(%s,%s,%s)", (db.library, db.albums[0], case.catalog[0]))
        else: con.execute("delete from library.local_albums where id=%s", (extra,))
    assert read(db, source, native=True) == source
    fresh = capture_origin(db, origin(db, "album_top", case.top), native=True)
    assert fresh["origin_diagnostics"] == [] and len(fresh["entries"]) > len(source["entries"])


def test_ambiguous_private_alternative_does_not_leak_ambiguity(sample_top):
    case = sample_top; db = case.db
    with db.connect() as con:
        extra = con.execute("insert into library.local_albums(library_id,album_key,title) values(%s,%s,'Private alternative') returning id", (db.library, uuid4().hex)).fetchone()["id"]
        con.execute("insert into library.catalog_album_links(library_id,local_album_id,catalog_ref) values(%s,%s,%s)", (db.library, extra, case.catalog[0]))
    def constraints(ctx):
        return PolicyEvaluationConstraints(deployment_allowed=not (ctx.resource and ctx.resource.resource_kind == "album" and ctx.resource.resource_ref == str(extra)))
    source = capture_origin(db, origin(db, "album_top", case.top), native=True, constraints=constraints)
    assert source["origin_diagnostics"] == [[1, "unavailable"]]
    assert "Private alternative" not in repr(source) and "ambiguous_edition" not in repr(source)


def test_viewer_grant_is_read_after_real_parent_lock_wait(sample_top, monkeypatch):
    case = sample_top; db = case.db; actor, grant = viewer(case); key = str(uuid4())
    ready = Event(); pids = []; original = db.service._connect
    @contextmanager
    def observed(url):
        with original(url) as con:
            pids.append(con.info.backend_pid); ready.set(); yield con
    monkeypatch.setattr(db.service, "_connect", observed)
    pool = ThreadPoolExecutor(max_workers=1)
    try:
        with db.connect() as blocker:
            blocker.execute("select ref from app.album_lists where ref=%s for update", (case.top["top_ref"],))
            blocker.execute("delete from app.album_list_access_grants where ref=%s", (grant,))
            future = pool.submit(capture_origin, db, origin(db, "album_top", case.top), key=key, context=db.context(actor))
            assert ready.wait(10)
            assert_pg_wait(db, pids[0], blocker.info.backend_pid)
            assert not future.done()
        with pytest.raises(PlaylistError): future.result(timeout=10)
        assert retained(db, key) == (None, [])
    finally: pool.shutdown(wait=True, cancel_futures=True)


def test_saved_top_final_access_fence_runs_after_ledger_insert(sample_top, monkeypatch):
    case = sample_top; db = case.db; actor, grant = viewer(case)
    source = capture_origin(db, origin(db, "album_top", case.top), context=db.context(actor)); body = payload(source)
    original = db.service._connect; removed = []; before = destinations(db)
    class Connection:
        def __init__(self, real): self.real = real
        def __getattr__(self, name): return getattr(self.real, name)
        def execute(self, sql, params=None, *args, **kwargs):
            result = self.real.execute(sql, params, *args, **kwargs)
            if "insert into app.playlist_operations" in " ".join(str(sql).lower().split()):
                # Force a changed current Top policy without inventing a grant.
                removed.append(True)
            return result
    @contextmanager
    def connect(url):
        with original(url) as con: yield Connection(con)
    def constraints(ctx):
        return PolicyEvaluationConstraints(deployment_allowed=not (removed and ctx.resource and ctx.resource.resource_kind == "album_top"))
    monkeypatch.setattr(db.service, "_connect", connect)
    with pytest.raises(PlaylistError): save(db, body, context=db.context(actor), constraints=constraints)
    assert removed == [True] and destinations(db) == before


def test_order_preserving_curator_position_offset_does_not_change_retained_membership(sample_top):
    case = sample_top; db = case.db
    source = capture_origin(db, origin(db, "album_top", case.top))
    with db.connect() as con:
        before = con.execute("select ref,curator_position from app.album_list_items where top_ref=%s order by curator_position,ref",
                             (case.top["top_ref"],)).fetchall()
        # Descending single-row updates keep every intermediate slot unoccupied.
        offset = max(row["curator_position"] for row in before) + 10
        for row in reversed(before):
            con.execute("update app.album_list_items set curator_position=%s where top_ref=%s and ref=%s",
                        (row["curator_position"] + offset, case.top["top_ref"], row["ref"]))
        after = con.execute("select ref,curator_position from app.album_list_items where top_ref=%s order by curator_position,ref",
                            (case.top["top_ref"],)).fetchall()
        assert [row["ref"] for row in before] == [row["ref"] for row in after]
    assert read(db, source) == source


def test_expanded_album_track_bound_rejects_5001_without_truncation_or_receipt_write(mix_db):
    db = mix_db
    with db.connect() as con:
        con.execute("delete from library.local_tracks where album_id=%s", (db.albums[0],))
        con.execute("insert into library.local_tracks(library_id,album_id,track_key,title,track_number) select %s,%s,%s || n::text,'Bounded synthetic',n from generate_series(1,%s) n", (db.library, db.albums[0], uuid4().hex, 5001))
    value = {"kind": "album_set", "selections": [{"kind": "local", "inventory_album_ref": album_ref(db)}]}; key = str(uuid4())
    with pytest.raises(PlaylistError, match="source_too_large") as error: capture_origin(db, value, key=key)
    assert error.value.status_code == 413 and retained(db, key) == (None, [])
