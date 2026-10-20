"""Independent real owner interleavings. Provider waits occur outside DB locks."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from threading import Event, Lock
from uuid import uuid4
import re
import pytest
from psycopg import errors
from psycopg.types.json import Jsonb
from library_mix_postgres_support import mix_db, mix_urls
from music_app.services.owned_playlists import PlaylistError
from sample_facet_support import (
    KEY, acquisition, country, enrich, envelope, grant_refresh, manual_source, primary_row,
    set_country, strict_result, target, sql_probe,
)
from test_sample_facet_bounds_live import add_tracks


@pytest.mark.parametrize("same_evidence", [False, True])
@pytest.mark.parametrize("initial_absence", [False, True])
def test_two_real_acquisitions_capture_same_previous_then_delayed_result_cannot_replace_newer(
        mix_db, monkeypatch, same_evidence, initial_absence):
    db = mix_db; parent = manual_source(db, (0,)); grant_refresh(db)
    if not initial_absence:
        set_country(db, envelope(db, "FR"))
    entered, release = Event(), Event(); guard = Lock(); entered_count = 0
    def network(mbid, _n, _cancel):
        nonlocal entered_count
        with guard:
            entered_count += 1; first = entered_count == 1
        if first:
            entered.set(); assert release.wait(10), "Concurrent acquisition not released"
            return strict_result(mbid, "GB" if same_evidence else "DE")
        return strict_result(mbid, "GB")
    calls = acquisition(monkeypatch, network)
    pool = ThreadPoolExecutor(max_workers=2)
    try:
        earlier = pool.submit(enrich, db, parent); assert entered.wait(10)
        newer = pool.submit(enrich, db, parent); assert newer.result(timeout=10)[0]["status"] == "stored_known"
        stored_b = country(db); release.set()
        assert earlier.result(timeout=10)[0]["status"] == ("unchanged" if same_evidence else "concurrent_change")
        assert country(db) == stored_b and len(calls) == 2
    finally:
        release.set(); pool.shutdown(wait=True, cancel_futures=True)


def test_duplicate_local_artist_targets_reject_entire_initial_batch(mix_db, monkeypatch):
    db = mix_db; parent = manual_source(db, (0, 1)); grant_refresh(db)
    calls = acquisition(monkeypatch)
    with pytest.raises(PlaylistError, match="invalid_command"):
        enrich(db, parent, [target(db, 0), target(db, 1)])
    assert calls == [] and KEY not in primary_row(db)["metadata"]


def test_exactly_25_distinct_local_rows_with_same_canonical_artist_are_separate_finite_cas_targets(mix_db, monkeypatch):
    db = mix_db; indexes = add_tracks(db, 25, distinct_artists=True)
    parent = manual_source(db, tuple(indexes)); grant_refresh(db)
    targets = [{"track_ref": f"inventory-track:{db.library}:{db.tracks[i]}",
        "primary_artist_ref": "musicbrainz-artist:" + db.artist_mbids[0]} for i in indexes]
    calls = acquisition(monkeypatch)
    with sql_probe(monkeypatch, db) as log:
        results = enrich(db, parent, targets, method="random")
    assert [r["status"] for r in results] == ["stored_known"] * 25
    assert [{k: v for k, v in r.items() if k != "status"} for r in results] == targets
    assert len(calls) == 25
    updates = [row for row in log if row["sql"].startswith("update library.local_artists")]
    assert len(updates) == 25
    for row in updates:
        assert "library_id" in row["sql"] and "returning" in row["sql"]
        assert KEY in row["sql"] or KEY in repr(row["params"])
    with db.connect() as con:
        stored = con.execute("""select a.id,a.metadata from library.local_tracks t
            join library.local_artists a on a.id=t.artist_id and a.library_id=t.library_id
            where t.library_id=%s and t.id=any(%s) order by t.id""",
            (db.library, [db.tracks[i] for i in indexes])).fetchall()
    assert len(stored) == 25
    assert len({row["metadata"][KEY]["envelope_revision"] for row in stored}) == 25
    assert all(row["metadata"][KEY]["local_artist_id"] == str(row["id"]) for row in stored)


def test_country_writer_lock_order_scoping_and_same_connection_final_fences(mix_db, monkeypatch):
    db = mix_db; parent = manual_source(db, (0,)); grant_refresh(db); acquisition(monkeypatch)
    with sql_probe(monkeypatch, db) as log:
        assert enrich(db, parent)[0]["status"] == "stored_known"
    updates = [i for i, row in enumerate(log) if row["sql"].startswith("update library.local_artists")]
    assert len(updates) == 1
    end = updates[0]; connection = log[end]["connection"]
    same = [(i, row) for i, row in enumerate(log) if row["connection"] is connection]
    def position(table, lock=None, *, after=-1, before=None, extra=None):
        return next(i for i, row in same if after < i < (end if before is None else before)
            and table in row["sql"] and (lock is None or lock in row["sql"])
            and (extra is None or extra(row["sql"])))
    advisory = position("pg_advisory_xact_lock")
    upgrade = position("library.local_artists", "for update nowait", after=advisory)
    assert advisory < upgrade < end
    accounts = position("from app.accounts", "for update", before=advisory)
    session = position("from app.account_sessions", "for update", after=accounts, before=advisory)
    bootstrap = position("from app.bootstrap_owners", "for share", after=session, before=advisory)
    membership = position("from library.library_memberships", "for share of m,l", after=bootstrap, before=advisory)
    grants = position("from app.capabilities", "for share", after=membership, before=advisory)
    assert accounts < session < bootstrap < membership < grants < advisory
    assert "join library.libraries" in log[membership]["sql"]
    assert "album-haven:sample-country-v1" in log[advisory]["sql"] or "album-haven:sample-country-v1" in log[advisory]["params"]
    parent_lock = position("from app.playlists", "for share", after=advisory, before=upgrade)
    members = position("from app.playlist_items", after=parent_lock, before=upgrade)
    tracks = position("from library.local_tracks", "for update", after=members, before=upgrade)
    albums = position("from library.local_albums", "for share", after=tracks, before=upgrade)
    track_artists = position("from library.local_artists", "for share", after=albums, before=upgrade,
        extra=lambda sql: "select artist_id from library.local_tracks" in sql)
    files = position("from library.local_track_files", "for share", after=track_artists, before=upgrade)
    roots = position("from library.library_roots", "for share", after=files, before=upgrade)
    album_artists = position("from library.local_artists", "for share", after=roots, before=upgrade,
        extra=lambda sql: "select a.artist_id from library.local_albums" in sql)
    assert advisory < parent_lock < members < tracks < albums < track_artists < files < roots < album_artists < upgrade
    for index in (tracks, albums, track_artists, files, roots, album_artists):
        assert re.search(r"\border by (?:[a-z_]\w*\.)?id\b", log[index]["sql"])
        identities = [row["id"] for row in log[index]["rows"]]
        assert identities == sorted(identities) and identities
    assert "library_id" in log[upgrade]["sql"] and "id" in log[upgrade]["sql"]
    assert "library_id" in log[end]["sql"] and "returning" in log[end]["sql"]
    assert any(i > end and "app.account_sessions" in row["sql"] for i, row in same)


def test_artist_nowait_contention_is_concurrent_change_without_application_retry(mix_db, monkeypatch):
    db = mix_db; parent = manual_source(db, (0,)); grant_refresh(db)
    holder = db.connect(); artist = primary_row(db)["id"]
    # A compatible reader lets source SHARE locks complete, but prevents an
    # UPDATE upgrade. Using an UPDATE holder would block earlier source locks.
    holder.execute("select id from library.local_artists where library_id=%s and id=%s for share",
        (db.library, artist)).fetchone()
    calls = acquisition(monkeypatch)
    pool = ThreadPoolExecutor(max_workers=1)
    try:
        result = pool.submit(enrich, db, parent).result(timeout=10)
        assert result[0]["status"] == "concurrent_change" and len(calls) == 1
        assert KEY not in primary_row(db)["metadata"]
    finally:
        holder.rollback(); holder.close()
        pool.shutdown(wait=True, cancel_futures=True)


def test_conditional_write_affected_row_mismatch_rolls_back_and_never_reports_stored(mix_db, monkeypatch):
    db = mix_db; parent = manual_source(db, (0,)); grant_refresh(db); acquisition(monkeypatch)
    changed = False
    def before(con, event):
        nonlocal changed
        if event["sql"].startswith("update library.local_artists") and not changed:
            changed = True
            # Same-transaction mutation proves the actual conditional predicate,
            # rather than replacing its cursor or faking a zero row count.
            value = envelope(db, "DE")
            con.execute("update library.local_artists set metadata=metadata||%s where library_id=%s and id=%s",
                (Jsonb({KEY: value}), db.library, primary_row(db)["id"]))
    with sql_probe(monkeypatch, db, before=before):
        result = enrich(db, parent)
    assert changed and result[0]["status"] == "concurrent_change"
    assert KEY not in primary_row(db)["metadata"], "Failed target transaction must roll back its fixture mutation too"


@pytest.mark.parametrize("error_class", [errors.SerializationFailure, errors.DeadlockDetected])
def test_injected_database_failure_after_write_rolls_back_without_application_retry(mix_db, monkeypatch, error_class):
    db = mix_db; parent = manual_source(db, (0,)); grant_refresh(db)
    old = envelope(db, "FR"); set_country(db, old)
    calls = acquisition(monkeypatch); attempted = []
    def after(con, event):
        if event["sql"].startswith("update library.local_artists"):
            attempted.append(con)
            # Deliberately injected SQLSTATE, not real serialization/deadlock
            # contention evidence. The actual transaction context must unwind.
            raise error_class("Injected Country commit failure")
    with sql_probe(monkeypatch, db, after=after) as statements:
        with pytest.raises(PlaylistError, match="concurrent_change") as error:
            enrich(db, parent)
    # Existing _authorized maps these SQLSTATEs only after rollback. Do not
    # silently convert them to the CAS/NOWAIT per-target acknowledgement.
    assert error.value.code == "concurrent_change" and error.value.status_code == 409
    assert len(calls) == len(attempted) == 1
    assert country(db) == old
    write_index = next(i for i, row in enumerate(statements)
        if row["sql"].startswith("update library.local_artists"))
    assert not any(row["connection"] is attempted[0] for row in statements[write_index + 1:])
