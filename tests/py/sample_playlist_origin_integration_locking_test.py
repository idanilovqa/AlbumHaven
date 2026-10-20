"""Global typed-origin acquisition and coexistence with the real legacy reader.

All cases are authored/unrun for later authorized native CI. Real authority,
real 0144 tuples, real SQL locks and real inventory_rows are never replaced.
"""
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from uuid import uuid4
import re

import psycopg
import pytest
from library_mix_postgres_support import mix_db, mix_urls
from sample_playlist_origin_support import sample_top, origin, capture_origin, track_ref
from test_sample_playlist_receipts_live import (
    receipts, sources, complete, destinations, retained, no_provider, options,
)
from test_sample_playlist_origins_live import expected_proof
from music_app.services.owned_playlists import PlaylistError
from sample_playlist_origin_integration_support import (
    SQLTrace, is_album_update, is_track_update, is_edition_share, is_album_probe,
    another_owner, receipts_for, no_survivors, assert_real_wait, cancel_connections,
    observe_legacy, top_order, add_album, album_set,
)


def sorted_sql(call):
    # A singleton equality has only one acquisition; flattened results still
    # prove ascending order across an implementation's ordered singleton phase.
    assert (re.search(r"\border by (?:[a-z_]\w*\.)?id\b", call.sql)
            or re.search(r"\bid\s*=\s*%", call.sql)), call.sql


def assert_ordered_prefix(trace, albums, tracks, *, top=None):
    """Exact SQL-order proof, not inferred from actor/account serialization."""
    calls = trace.calls
    first_track = next(i for i, call in enumerate(calls) if is_track_update(call))
    first_dependent = min(i for i, call in enumerate(calls)
                          if is_track_update(call) or is_album_probe(call) or is_edition_share(call))
    album_calls = [call for call in calls[:first_dependent] if is_album_update(call)]
    assert album_calls
    for call in album_calls:
        sorted_sql(call)
    assert [row["id"] for call in album_calls for row in call.rows] == sorted(albums)
    assert trace.rows_for(is_album_update, before=first_track) == sorted(albums)
    # Any eligible_editions SHARE is already covered by complete album UPDATE.
    shares = [i for i, call in enumerate(calls) if is_edition_share(call)]
    if top is not None:
        assert shares
        assert max(i for i, call in enumerate(calls[:first_track]) if is_album_update(call)) < shares[0]
        binding_calls = [(i, call) for i, call in enumerate(calls[:shares[0]])
                         if "lock_top_native_catalog_binding" in call.sql]
        expected_members = top_order(top)
        assert len(binding_calls) == len(expected_members)
        assert [str(call.params[4]) for _, call in binding_calls] == sorted(str(row["catalog_ref"]) for row in expected_members)
        assert {tuple(map(str, call.params)) for _, call in binding_calls} == {
            (top.top["top_ref"], str(row["ref"]), str(top.db.library), top.top["revision"], str(row["catalog_ref"]))
            for row in expected_members}
        assert max(i for i, _ in binding_calls) < min(i for i, call in enumerate(calls) if is_album_update(call))
    else:
        assert not shares
        assert not any("lock_top_native_catalog_binding" in call.sql for call in calls)
    selected = calls[first_track]
    assert "for update nowait" in selected.sql
    sorted_sql(selected)
    assert [row["id"] for row in selected.rows] == sorted(tracks)
    # The next tracks-first legacy statement is a real reacquisition of our rows.
    legacy = next(i for i in range(first_track + 1, len(calls)) if is_track_update(calls[i]))
    assert "nowait" not in calls[legacy].sql
    assert set(row["id"] for row in calls[legacy].rows) <= set(tracks)
    album_share = next(i for i in range(legacy + 1, len(calls))
                       if "from library.local_albums" in calls[i].sql and "for share" in calls[i].sql)
    assert first_track < legacy < album_share
    assert all("pg_advisory" not in call.sql and "lock_timeout" not in call.sql for call in calls)


@pytest.mark.parametrize("kind", ["album_top", "album_set", "album_details"])
def test_global_album_then_nowait_track_order_preserves_real_proof_and_output(sample_top, monkeypatch, kind):
    db = sample_top.db
    legacy = observe_legacy(monkeypatch)
    with SQLTrace().install(db.service) as trace:
        source = capture_origin(db, origin(db, kind, sample_top.top))
    tracks = db.tracks if kind != "album_details" else [db.tracks[i] for i in (3, 1, 0)]
    assert_ordered_prefix(trace, db.albums, tracks, top=sample_top if kind == "album_top" else None)
    assert legacy and all(lock[2]["lock"] is True for lock in legacy)
    assert len(trace.connections) == 1
    row = retained(db, source["source"]["ref"])[0]
    assert row["origin_descriptor"]["origin_proof"] == expected_proof(sample_top, kind)
    expected = [db.tracks[0], db.tracks[3]]
    assert [entry["inventory_track_ref"] for entry in source["entries"]] == [
        f"inventory-track:{db.library}:{identity}" for identity in expected]
    assert any("from app.accounts" in call.sql and "for update" in call.sql for call in trace.calls)


@pytest.mark.parametrize("key", ["", "bound-extra-edition"])
def test_top_locks_every_linked_candidate_including_unbound_before_eligibility_share(sample_top, key):
    db = sample_top.db
    extra = add_album(db, key=key)
    with db.connect() as con:
        con.execute("insert into library.catalog_album_links(library_id,local_album_id,catalog_ref) values(%s,%s,%s)",
                    (db.library, extra, sample_top.catalog[0]))
    with SQLTrace().install(db.service) as trace:
        source = capture_origin(db, origin(db, "album_top", sample_top.top))
    first_share = next(i for i, call in enumerate(trace.calls) if is_edition_share(call))
    assert trace.rows_for(is_album_update, before=first_share) == sorted([*db.albums, extra])
    assert not any(is_track_update(call) for call in trace.calls[:first_share])
    proof = retained(db, source["source"]["ref"])[0]["origin_descriptor"]["origin_proof"]
    assert proof["members"][1]["omission"] == (None if key == "" else "ambiguous_edition")
    assert proof["members"][1]["inventory_album_ref"] == (f"inventory-album:{db.library}:{db.albums[0]}" if key == "" else None)


def test_details_loose_and_album_tracks_share_one_global_nowait_acquisition(mix_db):
    db = mix_db
    with db.connect() as con:
        con.execute("update library.local_tracks set album_id=null where id=%s", (db.tracks[0],))
        db.rebind_mappings(con, [db.tracks[0]])
    selected = [db.tracks[3], db.tracks[0], db.tracks[4]]
    value = {"kind": "album_details", "track_refs": [f"inventory-track:{db.library}:{track}" for track in selected]}
    with SQLTrace().install(db.service) as trace:
        source = capture_origin(db, value)
    assert_ordered_prefix(trace, [db.albums[1]], selected)
    descriptor = retained(db, source["source"]["ref"])[0]["origin_descriptor"]
    assert [fact["track_id"] for fact in descriptor["facts"]] == selected
    assert descriptor["facts"][1]["album_ref"] is None


@pytest.mark.parametrize("kind", ["album_top", "album_set", "album_details"])
def test_legacy_tracks_first_conflict_fails_origin_nowait_and_rolls_back_everything(sample_top, monkeypatch, kind):
    db = sample_top.db
    actor, legacy_owner = another_owner(db)
    key = str(uuid4())
    before = destinations(db), receipts_for(db, db.owner)
    legacy_held, allow_legacy_album, origin_ready, release_origin = (Event() for _ in range(4))
    pids = {}
    legacy_calls = observe_legacy(monkeypatch)
    header_calls = []
    original_header = complete._header
    def header(connection, live, *args, **kwargs):
        header_calls.append((live.actor.account_id, kwargs.get("source_ref")))
        return original_header(connection, live, *args, **kwargs)
    monkeypatch.setattr(complete, "_header", header)

    def legacy_after(call, con):
        if is_track_update(call) and not legacy_held.is_set():
            assert "nowait" not in call.sql  # unchanged actual legacy owner
            pids["legacy"] = con.info.backend_pid
            legacy_held.set()
            assert allow_legacy_album.wait(10), "Controller did not release real legacy tracks lock"

    def origin_before(call, con):
        if is_track_update(call) and not origin_ready.is_set():
            # Fail immediately on old code, rather than creating an unbounded test deadlock.
            assert "for update nowait" in call.sql, "Typed selected-track acquisition must fail fast"
            pids["origin"] = con.info.backend_pid
            origin_ready.set()
            assert release_origin.wait(10), "Controller did not release typed NOWAIT attempt"

    legacy_trace, origin_trace = SQLTrace(after=legacy_after), SQLTrace(before=origin_before)
    pool = ThreadPoolExecutor(max_workers=2)
    finished = False
    try:
        with legacy_trace.install(legacy_owner), origin_trace.install(db.service):
            old = pool.submit(complete.CompletePlaylistSources(playlists=legacy_owner).from_inventory,
                              db.context(actor), [track_ref(db, 0), track_ref(db, 3)])
            assert legacy_held.wait(10)
            pending = pool.submit(capture_origin, db, origin(db, kind, sample_top.top), key=key)
            assert origin_ready.wait(10)
            assert pids["legacy"] != pids["origin"]
            assert origin_trace.rows_for(is_album_update) == sorted(db.albums)
            allow_legacy_album.set()
            # Real legacy now holds tracks and waits on the typed origin's parent.
            assert_real_wait(db, pids["legacy"], pids["origin"])
            assert not old.done() and not pending.done()
            release_origin.set()
            with pytest.raises(PlaylistError, match="concurrent_change") as error:
                pending.result(timeout=10)
            assert error.value.status_code == 409
            legacy_result = old.result(timeout=10)["data"]
            finished = True
        failures = [call for call in origin_trace.calls if call.error is not None]
        assert len(failures) == 1
        assert is_track_update(failures[0]) and "nowait" in failures[0].sql
        assert getattr(failures[0].error, "sqlstate", None) == "55P03"
        # No SQL after the failed statement, no retry connection/new capture key.
        assert origin_trace.calls[-1] is failures[0]
        assert len(origin_trace.connections) == 1
        assert not any(pid == pids["origin"] for pid, _, _ in legacy_calls)
        assert header_calls == [(actor.account_id, None)]
        assert [entry["inventory_track_ref"] for entry in legacy_result["entries"]] == [track_ref(db, 0), track_ref(db, 3)]
        no_survivors(db, key, before)
        # The only added receipt is the independently successful ordinary source.
        assert len(receipts_for(db, actor)) == 1
    finally:
        allow_legacy_album.set()
        release_origin.set()
        if not finished:
            cancel_connections(origin_trace, legacy_trace)
        pool.shutdown(wait=True, cancel_futures=True)


def test_origin_owns_tracks_first_then_legacy_waits_without_changing_canonical_result(sample_top):
    db = sample_top.db
    actor, legacy_owner = another_owner(db)
    held, release, legacy_entered = Event(), Event(), Event()
    pids = {}
    def after(call, con):
        if is_track_update(call) and not held.is_set():
            assert "for update nowait" in call.sql
            pids["origin"] = con.info.backend_pid
            held.set()
            assert release.wait(10)
    def legacy_before(call, con):
        if is_track_update(call) and not legacy_entered.is_set():
            assert "nowait" not in call.sql
            pids["legacy"] = con.info.backend_pid
            legacy_entered.set()
    origin_trace, legacy_trace = SQLTrace(after=after), SQLTrace(before=legacy_before)
    pool = ThreadPoolExecutor(max_workers=2)
    finished = False
    try:
        with origin_trace.install(db.service), legacy_trace.install(legacy_owner):
            current = pool.submit(capture_origin, db, origin(db, "album_top", sample_top.top))
            assert held.wait(10)
            old = pool.submit(complete.CompletePlaylistSources(playlists=legacy_owner).from_inventory,
                              db.context(actor), [track_ref(db, 0), track_ref(db, 3)])
            assert legacy_entered.wait(10)
            assert_real_wait(db, pids["legacy"], pids["origin"])
            release.set()
            result = current.result(timeout=10)
            old.result(timeout=10)
            finished = True
        assert_ordered_prefix(origin_trace, db.albums, db.tracks, top=sample_top)
        assert retained(db, result["source"]["ref"])[0]["origin_descriptor"]["origin_proof"] == expected_proof(sample_top, "album_top")
        assert [row["inventory_track_ref"] for row in result["entries"]] == [track_ref(db, 0), track_ref(db, 3)]
    finally:
        release.set()
        if not finished:
            cancel_connections(origin_trace, legacy_trace)
        pool.shutdown(wait=True, cancel_futures=True)


def test_distinct_actor_top_b_a_and_explicit_a_b_wait_at_sorted_album_phase(sample_top):
    db = sample_top.db
    actor, other_owner = another_owner(db)
    held, release, other_entered = Event(), Event(), Event()
    pids = {}
    def top_after(call, con):
        if is_album_update(call) and not held.is_set():
            sorted_sql(call)
            pids["top"] = con.info.backend_pid
            held.set()
            assert release.wait(10)
    def other_before(call, con):
        if is_album_update(call) and not other_entered.is_set():
            sorted_sql(call)
            pids["set"] = con.info.backend_pid
            other_entered.set()
    top_trace, set_trace = SQLTrace(after=top_after), SQLTrace(before=other_before)
    pool = ThreadPoolExecutor(max_workers=2)
    finished = False
    try:
        with top_trace.install(db.service), set_trace.install(other_owner):
            first = pool.submit(capture_origin, db, origin(db, "album_top", sample_top.top))
            assert held.wait(10)
            second = pool.submit(receipts.capture, other_owner, db.context(actor),
                                 origin=album_set(db, db.albums), options=options(),
                                 request_key=str(uuid4()))
            assert other_entered.wait(10)
            assert pids["top"] != pids["set"]
            assert_real_wait(db, pids["set"], pids["top"])
            release.set()
            top_result, set_result = first.result(timeout=10), second.result(timeout=10)["data"]
            finished = True
        assert_ordered_prefix(top_trace, db.albums, db.tracks, top=sample_top)
        assert_ordered_prefix(set_trace, db.albums, db.tracks)
        assert [row["inventory_track_ref"] for row in top_result["entries"]] == [track_ref(db, 0), track_ref(db, 3)]
        assert [row["inventory_track_ref"] for row in set_result["entries"]] == [track_ref(db, 0), track_ref(db, 3)]
    finally:
        release.set()
        if not finished:
            cancel_connections(top_trace, set_trace)
        pool.shutdown(wait=True, cancel_futures=True)


def test_real55p03_outside_typed_selected_nowait_is_not_mapped_by_generic_authorized(mix_db):
    db = mix_db
    before = destinations(db), receipts_for(db)
    with db.connect() as blocker:
        blocker.execute("select id from library.local_tracks where id=%s for update", (db.tracks[0],)).fetchall()
        with pytest.raises(psycopg.errors.LockNotAvailable) as error:
            with db.service._authorized(db.context(), None) as (con, live, _now):
                con.execute("select id from library.local_tracks where library_id=%s and id=%s for update nowait",
                            (live.library_id, db.tracks[0])).fetchall()
        assert error.value.sqlstate == "55P03"
    assert (destinations(db), receipts_for(db)) == before


@pytest.mark.parametrize("kind", ["album_set", "album_details"])
def test_new_lower_parent_after_discovery_rejects_before_legacy_without_late_album_lock(mix_db, monkeypatch, kind):
    db = mix_db
    planned, release = Event(), Event()
    key = str(uuid4())
    before = destinations(db), receipts_for(db, db.owner)
    legacy = observe_legacy(monkeypatch)
    def before_sql(call, con):
        if is_track_update(call) and not planned.is_set():
            assert "for update nowait" in call.sql
            planned.set()
            assert release.wait(10)
    value = album_set(db, [db.albums[1]]) if kind == "album_set" else {
        "kind": "album_details", "track_refs": [track_ref(db, 3)]}
    trace = SQLTrace(before=before_sql)
    pool = ThreadPoolExecutor(max_workers=1)
    finished = False
    try:
        with trace.install(db.service):
            pending = pool.submit(capture_origin, db, value, key=key)
            assert planned.wait(10)
            with db.connect() as changer:
                changer.execute("update library.local_tracks set album_id=%s where id=%s",
                                (db.albums[0], db.tracks[3]))
            release.set()
            with pytest.raises(PlaylistError, match="source_changed") as error:
                pending.result(timeout=10)
            assert error.value.status_code == 409
            finished = True
        assert trace.rows_for(is_album_update) == [db.albums[1]]
        assert legacy == []
        no_survivors(db, key, before)
    finally:
        release.set()
        if not finished:
            cancel_connections(trace)
        pool.shutdown(wait=True, cancel_futures=True)
