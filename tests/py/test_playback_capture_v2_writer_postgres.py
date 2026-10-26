"""Future real PostgreSQL N14 adapter cases. Authored only; entirely unrun.

Requires separately admitted synthetic DB, exact0154, N9 parser and N14 owner.
Calls only the private writer directly; public v2 rejection is never disabled.
"""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from threading import Event
from uuid import uuid4

import pytest

from music_app.services.playback_capture import CaptureError, POSITION_PROTOCOL, PROTOCOL, canonical_json
from music_app.services import playback_capture_postgres as repository
from music_app.services.private_library_authority import PrivateLibraryAuthorityError
from tests.py.test_playback_capture_postgres import CaptureDatabase, capture_db, urls
from music_app.services.playback_capture_history_revision import HISTORY_REVISION_BYTES


def _run(ordinal=0, binding=1, **changes):
    value = dict(source_start48=ordinal,frames=2,output_start=256+ordinal,
        ordinal_start=ordinal,epoch=1,anchor_before=None,anchor_after=None,
        quality="unknown",binding_serial=binding,generation=1,stream_id=binding,
        source_base48=0,continuity_serial=1)
    value.update(changes)
    return value


def _data(db, *, owner=None, capture=None, runs=None):
    return dict(protocol=POSITION_PROTOCOL,device_uuid=db.payload["device_uuid"],
        capture_uuid=capture or db.payload["capture_uuid"],sequence=1,initial_path=db.path,
        evidence=dict(owner_uuid=owner or str(uuid4()),runs=[_run()] if runs is None else runs,
                      anchors=[],gaps=[],terminal=False,terminal_reason=None))


def _write(db, data, **kwargs):
    return repository._record_position_checkpoint(db.app_url,db.context,data,expected_scope=db.guard,
        clock=lambda: db.now,connect=kwargs.pop("connect",db.connector()),**kwargs)


def _global(db):
    with db.connect() as c:
        return c.execute("select reserved_bytes from integration.playback_capture_budget where is_global").fetchone()["reserved_bytes"]


def _gap():
    return dict(ordinal_start=0,ordinal_end=6,positive_frames=1,output_start=256,
                output_end=262,epoch=None,reasons=["queue_capacity"])


def test_real_writer_exact_charges_projection_and_retry_with_lost_ack(capture_db):
    db = capture_db; before = _global(db); data = _data(db)
    data["evidence"]["gaps"] = [_gap()]
    with pytest.raises(OSError,match="acknowledgement"):
        _write(db,data,connect=db.connector(fail_commit=True))
    charged = _global(db)
    assert "set local lock_timeout = '250ms'" in db.sql
    assert "set local statement_timeout = '1000ms'" in db.sql
    account_lock = next(i for i,q in enumerate(db.sql) if "from app.accounts" in q and "for update" in q)
    owner_lookup = next(i for i,q in enumerate(db.sql) if q.startswith("select * from integration.playback_capture_owner"))
    assert account_lock < owner_lookup
    receipt = _write(db,data)
    assert _write(db,data) == receipt and _global(db) == charged
    with db.connect() as c:
        parent = c.execute("select * from integration.playback_capture_session where account_id=%s",(db.account,)).fetchone()
        checkpoint = c.execute("select * from integration.playback_capture_checkpoint where session_id=%s",(parent["id"],)).fetchone()
        original_receipt = {k:receipt[k] for k in ("sequence","digest","accepted_known_frames","accepted_lost_frames","terminal")}
        expected_cp = 192+len(canonical_json(data["evidence"]).encode())+len(canonical_json(original_receipt).encode())
        assert checkpoint["reservation_bytes"] == expected_cp
        assert checkpoint["evidence"] == data["evidence"] and checkpoint["receipt_body"] == original_receipt
        assert charged-before == 1024+384+320+384+expected_cp+HISTORY_REVISION_BYTES
        history = c.execute("select * from integration.playback_capture_history_revision where account_id=%s",(db.account,)).fetchone()
        budget = c.execute("select * from integration.playback_capture_budget where account_id=%s",(db.account,)).fetchone()
        assert history["reservation_bytes"] == HISTORY_REVISION_BYTES
        assert history["account_budget_id"] == budget["id"]
        assert history["append_revision"] == 1 and history["raw_checkpoint_cut"] == checkpoint["id"]
        assert budget["reserved_bytes"] == charged-before
        assert c.execute("select count(*) as n from integration.playback_capture_owner where account_id=%s",(db.account,)).fetchone()["n"] == 1
        loss = c.execute("select * from integration.playback_capture_loss where checkpoint_id=%s",(checkpoint["id"],)).fetchone()
        assert [loss[k] for k in ("gap_index","ordinal_start","ordinal_end","output_start","output_end","reservation_bytes")] == [0,0,6,256,262,384]
        assert loss["owner_id"] == parent["owner_id"]

    # A later checkpoint reserves only its own run/body, never another H3 row.
    second = deepcopy(data); second["sequence"] = 2
    second["evidence"].update(runs=[_run(2)],gaps=[])
    second_receipt = _write(db,second)
    after_second = _global(db)
    assert _write(db,second) == second_receipt and _global(db) == after_second
    with db.connect() as c:
        cp = c.execute("select * from integration.playback_capture_checkpoint where session_id=%s and sequence=2",(parent["id"],)).fetchone()
        body = {k:second_receipt[k] for k in ("sequence","digest","accepted_known_frames","accepted_lost_frames","terminal")}
        expected_second_cp = 192+len(canonical_json(second["evidence"]).encode())+len(canonical_json(body).encode())
        assert cp["reservation_bytes"] == expected_second_cp
        assert after_second-charged == 320+expected_second_cp
        current = c.execute("select * from integration.playback_capture_history_revision where account_id=%s",(db.account,)).fetchone()
        assert current["reservation_bytes"] == HISTORY_REVISION_BYTES and current["append_revision"] == 2
        assert current["raw_checkpoint_cut"] == cp["id"]
        assert c.execute("select reserved_bytes from integration.playback_capture_budget where account_id=%s",(db.account,)).fetchone()["reserved_bytes"] == after_second-before


def test_late_cross_parent_middle_run_and_owner_charge_once(capture_db):
    db = capture_db
    a = _data(db,runs=[_run(0,1),_run(4,3)])
    _write(db,a)
    b = _data(db,owner=a["evidence"]["owner_uuid"],capture=str(uuid4()),runs=[_run(2,2)])
    before_b = _global(db); receipt = _write(db,b)
    with db.connect() as c:
        rows = c.execute("""select r.*,p.capture_uuid from integration.playback_capture_run r
            join integration.playback_capture_checkpoint cp on cp.id=r.checkpoint_id
            join integration.playback_capture_session p on p.id=cp.session_id
            where p.account_id=%s order by r.ordinal_start""",(db.account,)).fetchall()
        assert [r["ordinal_start"] for r in rows] == [0,2,4]
        assert len({r["owner_id"] for r in rows}) == 1
        cp = c.execute("""select cp.reservation_bytes from integration.playback_capture_checkpoint cp
            join integration.playback_capture_session p on p.id=cp.session_id
            where p.account_id=%s and p.capture_uuid=%s""",(db.account,b["capture_uuid"])).fetchone()
        assert _global(db)-before_b == 384+320+cp["reservation_bytes"]
        assert receipt["accepted_known_frames"] == 2


@pytest.mark.parametrize("change", [
    dict(generation=2,epoch=1,binding_serial=2,stream_id=2),
    dict(continuity_serial=3),dict(output_start=257),dict(epoch=1),
])
def test_real_cross_checkpoint_causal_failure_rolls_back(capture_db, change):
    db = capture_db
    data = _data(db,runs=[_run(epoch=2 if change==dict(epoch=1) else 1)])
    _write(db,data); before = _global(db)
    next_data = deepcopy(data); next_data["sequence"] = 2
    next_data["evidence"]["runs"] = [_run(2,**change)]
    with pytest.raises(CaptureError,match="capture_conflict"):
        _write(db,next_data)
    assert _global(db) == before
    assert db.rows()[0]["last_sequence"] == 1


@pytest.mark.parametrize("after", [
    _run(2,source_start48=0,epoch=2),
    _run(2,2,source_start48=400,source_base48=400,generation=2,epoch=2,continuity_serial=2),
    _run(2,continuity_serial=2),
])
def test_real_safe_loop_seek_and_loss_break_preserve_actual_provenance(capture_db, after):
    db = capture_db; data = _data(db); _write(db,data)
    next_data = deepcopy(data); next_data["sequence"] = 2; next_data["evidence"]["runs"] = [after]
    _write(db,next_data)
    with db.connect() as c:
        row = c.execute("""select r.* from integration.playback_capture_run r
            join integration.playback_capture_checkpoint cp on cp.id=r.checkpoint_id
            join integration.playback_capture_session p on p.id=cp.session_id
            where p.account_id=%s and cp.sequence=2""",(db.account,)).fetchone()
        for key in ("source_start48","generation","epoch","binding_serial","stream_id","source_base48","continuity_serial"):
            assert row[key] == after[key]


def test_existing_binding_cannot_move_to_another_capture_parent(capture_db):
    db = capture_db; a = _data(db); _write(db,a); before = _global(db)
    b = _data(db,owner=a["evidence"]["owner_uuid"],capture=str(uuid4()),runs=[_run(2,1)])
    with pytest.raises(CaptureError,match="capture_conflict"): _write(db,b)
    assert _global(db) == before and len(db.rows()) == 1


def test_late_gap_only_checkpoint_is_preserved_without_inventing_positive_frames(capture_db):
    db = capture_db; data = _data(db); _write(db,data)
    late = deepcopy(data); late["sequence"] = 2
    late["evidence"].update(runs=[],gaps=[_gap()])
    receipt = _write(db,late)
    assert receipt["accepted_known_frames"] == 2 and receipt["accepted_lost_frames"] == 1
    with db.connect() as c:
        row = c.execute("""select cp.* from integration.playback_capture_checkpoint cp
            join integration.playback_capture_session p on p.id=cp.session_id
            where p.account_id=%s and cp.sequence=2""",(db.account,)).fetchone()
        assert row["evidence"]["gaps"] == [_gap()]
        assert c.execute("select count(*) as n from integration.playback_capture_loss where checkpoint_id=%s",(row["id"],)).fetchone()["n"] == 1
        assert c.execute("select count(*) as n from integration.playback_capture_run where checkpoint_id=%s",(row["id"],)).fetchone()["n"] == 0


@pytest.mark.parametrize("mode", ["gap_only","account_quota","global_quota","final_authority"])
def test_no_owner_only_commit_on_failed_admission(capture_db, monkeypatch, mode):
    db = capture_db; before = _global(db); data = _data(db)
    error = CaptureError
    if mode == "gap_only":
        data["evidence"].update(runs=[],gaps=[_gap()])
    elif mode.endswith("quota"):
        monkeypatch.setattr(repository,"ACCOUNT_BYTES" if mode=="account_quota" else "GLOBAL_BYTES",0)
    else:
        error = PrivateLibraryAuthorityError
        def denied(*a, **k): raise PrivateLibraryAuthorityError("Synthetic final denial")
        monkeypatch.setattr(repository,"_final_authority",denied)
    with pytest.raises(error): _write(db,data)
    assert _global(db) == before and not db.rows()
    with db.connect() as c:
        assert c.execute("select id from integration.playback_capture_owner where account_id=%s",(db.account,)).fetchone() is None
        assert c.execute("select id from integration.playback_capture_budget where account_id=%s",(db.account,)).fetchone() is None


def test_scoped_owner_serialization_across_two_concurrent_parents(capture_db):
    db = capture_db; a = _data(db)
    b = _data(db,owner=a["evidence"]["owner_uuid"],capture=str(uuid4()),runs=[_run(2,2)])
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(_write,db,data) for data in (a,b)]
        assert all(f.result(timeout=5)["accepted_known_frames"] == 2 for f in futures)
    with db.connect() as c:
        assert c.execute("select count(*) as n from integration.playback_capture_owner where account_id=%s",(db.account,)).fetchone()["n"] == 1
    assert len(db.rows()) == 2


def test_account_delete_waits_for_writer_then_redacts_real_committed_graph(capture_db):
    db = capture_db; data = _data(db); data["evidence"]["gaps"] = [_gap()]
    before = _global(db); inserted=Event(); release=Event(); deleting=Event()
    def after(sql, params):
        if sql.lower().startswith("insert into integration.playback_capture_checkpoint"):
            inserted.set()
            assert release.wait(5)
    def delete_account():
        with db.connect() as c:
            deleting.set()
            c.execute("delete from app.accounts where id=%s",(db.account,))
    with ThreadPoolExecutor(max_workers=2) as pool:
        write=pool.submit(_write,db,data,connect=db.connector(after=after))
        try:
            assert inserted.wait(5)
            deletion=pool.submit(delete_account)
            assert deleting.wait(5)
        finally:
            release.set()
        write.result(timeout=5); deletion.result(timeout=5)
    with db.connect() as c:
        p = c.execute("select * from integration.playback_capture_session where original_track_id=%s",(db.track,)).fetchone()
        cp = c.execute("select * from integration.playback_capture_checkpoint where session_id=%s",(p["id"],)).fetchone()
        assert p["account_id"] is None and p["owner_id"] is None and p["owner_uuid"] is None
        assert cp["evidence_redacted"] and cp["digest"] is None and "owner_uuid" not in cp["evidence"]
        assert "digest" not in cp["receipt_body"]
        assert _global(db)-before == 384+320+384+cp["reservation_bytes"]


def test_owner_uuid_and_device_do_not_join_different_accounts(capture_db, urls):
    a = capture_db; b = CaptureDatabase(urls)
    try:
        b.setup()
        b.payload["device_uuid"] = a.payload["device_uuid"]
        first = _data(a)
        second = _data(b,owner=first["evidence"]["owner_uuid"])
        _write(a,first); _write(b,second)
        with a.connect() as c:
            rows = c.execute("select id,account_id from integration.playback_capture_owner where account_id=any(%s)",
                             ([a.account,b.account],)).fetchall()
            assert len(rows) == 2 and len({r["id"] for r in rows}) == 2
    finally:
        b.cleanup()


def test_real_v1_collision_rejected_without_rewriting_protocol_or_receipt(capture_db):
    db = capture_db; data = _data(db); _write(db,data); before = _global(db)
    legacy = deepcopy(db.payload)
    with pytest.raises(CaptureError,match="capture_conflict"): db.record(legacy)
    assert _global(db) == before and db.rows()[0]["evidence_version"] == POSITION_PROTOCOL
    assert _write(db,data)["accepted_known_frames"] == 2


def test_real_v2_collision_with_v1_rejected_and_v1_replay_unchanged(capture_db):
    db = capture_db; original = db.record(); before = _global(db)
    with pytest.raises(CaptureError,match="capture_conflict"): _write(db,_data(db))
    assert _global(db) == before and db.record() == original
    assert db.rows()[0]["evidence_version"] == PROTOCOL


def test_public_v2_gate_does_not_call_storage_even_with_schema_installed(capture_db):
    db = capture_db; data = _data(db); db.sql.clear()
    with pytest.raises(CaptureError,match="unsupported_capture_version"): db.record(data)
    assert db.sql == [] and not db.rows()


@pytest.mark.parametrize("change", ["digest","sequence","owner"])
def test_real_retry_conflicts_do_not_rewrite_receipt_or_charge(capture_db, change):
    db = capture_db; data = _data(db); receipt = _write(db,data); before = _global(db)
    altered = deepcopy(data)
    if change == "digest":
        altered["evidence"]["runs"][0]["frames"] = 3
    elif change == "sequence":
        altered["sequence"] = 3
    else:
        altered["evidence"]["owner_uuid"] = str(uuid4())
    with pytest.raises(CaptureError): _write(db,altered)
    assert _global(db) == before and db.rows()[0]["last_sequence"] == 1
    assert _write(db,data) == receipt and _global(db) == before


def test_terminal_checkpoint_retains_owner_and_exact_replay(capture_db):
    db = capture_db; data = _data(db); _write(db,data)
    terminal = deepcopy(data); terminal["sequence"] = 2
    terminal["evidence"].update(runs=[],terminal=True,terminal_reason="ended")
    receipt = _write(db,terminal); before = _global(db)
    assert receipt["terminal"] and receipt["accepted_known_frames"] == 2
    assert _write(db,terminal) == receipt and _global(db) == before
    with db.connect() as c:
        cp = c.execute("""select cp.* from integration.playback_capture_checkpoint cp
            join integration.playback_capture_session p on p.id=cp.session_id
            where p.account_id=%s and cp.sequence=2""",(db.account,)).fetchone()
        assert cp["evidence"]["owner_uuid"] == data["evidence"]["owner_uuid"]
        assert cp["digest"] == receipt["digest"]
