"""Live reservation/cascade/anonymization checks, only on admitted synthetic DB."""
import json

import pytest

from music_app.services.playback_capture import CaptureError
from music_app.services import playback_capture_postgres as repository
from tests.py.test_playback_capture_postgres import capture_db, urls


def _global(db):
    with db.connect() as c:
        return c.execute('select reserved_bytes from integration.playback_capture_budget where is_global').fetchone()['reserved_bytes']


def test_account_deletion_preserves_anonymous_rows_and_global_reservation(capture_db):
    db=capture_db;before=_global(db);receipt=db.record();parent=db.rows()[0]
    with db.connect() as c:
        account_charge=c.execute('select reserved_bytes from integration.playback_capture_budget where account_id=%s',
                                 (db.account,)).fetchone()['reserved_bytes']
    assert _global(db)==before+account_charge
    with db.connect() as c:c.execute('delete from app.accounts where id=%s',(db.account,))
    assert _global(db)==before+account_charge
    with db.connect() as c:
        row=c.execute('select * from integration.playback_capture_session where id=%s',(parent['id'],)).fetchone()
        assert all(row[key] is None for key in ('account_id','auth_session_guard','device_uuid','capture_uuid','v1_session_uuid','account_budget_id'))
        assert row['original_album_id']==db.album
        checkpoint=c.execute('select * from integration.playback_capture_checkpoint where session_id=%s',(parent['id'],)).fetchone()
        assert checkpoint['account_budget_id'] is None
        assert set(checkpoint['receipt_body'])=={'sequence','digest','accepted_known_frames','accepted_lost_frames','terminal'}
        assert set(checkpoint['evidence'])=={'runs','anchors','gaps','terminal','terminal_reason'}
        stored=json.dumps([checkpoint['evidence'],checkpoint['receipt_body']])
        assert db.payload['capture_uuid'] not in stored and db.path not in stored and db.guard not in stored
        c.execute('delete from integration.playback_capture_session where id=%s',(parent['id'],))
    assert _global(db)==before


def test_actual_parent_cascade_releases_each_stored_charge_once(capture_db):
    db=capture_db;before=_global(db)
    db.payload['evidence']['anchors']=[dict(epoch=1,probe_id=1,output_frame=256,utc_lower_ms=None,
        utc_upper_ms=None,monotonic_probe_span_ms=400,max_quantum_frames=128,quality='unknown')]
    db.record();parent=db.rows()[0]
    db.record(db.next())
    with db.connect() as c:
        account_charge=c.execute('select reserved_bytes from integration.playback_capture_budget where account_id=%s',
                                 (db.account,)).fetchone()['reserved_bytes']
        assert account_charge>256+192+128+128
        c.execute('delete from integration.playback_capture_session where id=%s',(parent['id'],))
    assert _global(db)==before
    with db.connect() as c:
        assert c.execute('select reserved_bytes from integration.playback_capture_budget where account_id=%s',
                         (db.account,)).fetchone()['reserved_bytes']==0
        assert c.execute('select count(*) as n from integration.playback_capture_checkpoint where session_id=%s',
                         (parent['id'],)).fetchone()['n']==0
        assert c.execute('select count(*) as n from integration.playback_capture_anchor where session_id=%s',
                         (parent['id'],)).fetchone()['n']==0


@pytest.mark.parametrize('ceiling',['ACCOUNT_BYTES','GLOBAL_BYTES'])
def test_quota_rejection_rolls_back_rows_and_all_charges(capture_db,monkeypatch,ceiling):
    db=capture_db;before=_global(db)
    monkeypatch.setattr(repository,ceiling,0)
    with pytest.raises(CaptureError,match='capture_quota'):db.record()
    assert not db.rows() and _global(db)==before
    with db.connect() as c:
        assert c.execute('select id from integration.playback_capture_budget where account_id=%s',(db.account,)).fetchone() is None


def test_library_cascade_releases_retained_anonymous_rows(capture_db):
    """A generated, uniquely owned library isolates this migration trigger test."""
    db=capture_db;before=_global(db);db.record();parent=db.rows()[0]
    library=None
    try:
        with db.connect() as c:
            library=c.execute("insert into library.libraries(owner_account_id,name) values(%s,%s) returning id",
                              (db.account,'Capture cascade '+db.token)).fetchone()['id']
            root=c.execute("insert into library.library_roots(library_id,root_path) values(%s,%s) returning id",
                           (library,'/synthetic/cascade-'+db.token)).fetchone()['id']
            album=c.execute("insert into library.local_albums(library_id,album_key,title) values(%s,%s,'Cascade') returning id",
                            (library,db.token)).fetchone()['id']
            track=c.execute("insert into library.local_tracks(library_id,album_id,track_key,title) values(%s,%s,%s,'Cascade') returning id",
                            (library,album,db.token)).fetchone()['id']
            file=c.execute("insert into library.local_track_files(track_id,library_root_id,private_path) values(%s,%s,%s) returning id",
                           (track,root,'/synthetic/cascade-'+db.token+'/track.flac')).fetchone()['id']
            # Migration fixtures relocate only this generated ledger to its own
            # generated catalog. The repository's canonical-selector contract
            # remains covered separately and is never patched or bypassed there.
            c.execute('''update integration.playback_capture_session set library_id=%s,
                original_track_id=%s,original_file_id=%s,original_root_id=%s,original_album_id=%s,
                live_track_id=%s,live_album_id=%s where id=%s''',
                (library,track,file,root,album,track,album,parent['id']))
            c.execute('delete from app.accounts where id=%s',(db.account,))
            c.execute('delete from library.libraries where id=%s',(library,))
        assert _global(db)==before
        with db.connect() as c:
            assert c.execute('select id from integration.playback_capture_session where id=%s',(parent['id'],)).fetchone() is None
    finally:
        if library is not None:
            with db.connect() as c:c.execute('delete from library.libraries where id=%s',(library,))


def test_account_deletion_waits_for_capture_and_preserves_global_charge(capture_db):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    db=capture_db;before=_global(db)
    inserted=Event();release=Event();deleting=Event()
    def after(sql,params):
        if sql.lower().startswith('insert into integration.playback_capture_checkpoint'):
            inserted.set()
            assert release.wait(5)
    def delete_owner():
        with db.connect() as c:
            deleting.set()
            c.execute('delete from app.accounts where id=%s',(db.account,))
    with ThreadPoolExecutor(max_workers=2) as pool:
        write=pool.submit(db.record,connect=db.connector(after=after))
        try:
            assert inserted.wait(5)
            deletion=pool.submit(delete_owner)
            assert deleting.wait(5)
        finally:
            release.set()
        assert write.result(timeout=5)['accepted_known_frames']==128
        deletion.result(timeout=5)
    with db.connect() as c:
        parent=c.execute('select * from integration.playback_capture_session where original_track_id=%s',(db.track,)).fetchone()
        assert parent is not None and parent['account_id'] is None
        charge=parent['reservation_bytes']
        charge+=c.execute('select coalesce(sum(reservation_bytes),0) as n from integration.playback_capture_checkpoint where session_id=%s',
                          (parent['id'],)).fetchone()['n']
        charge+=c.execute('''select coalesce(sum(r.reservation_bytes),0) as n from integration.playback_capture_run r
            join integration.playback_capture_checkpoint c on c.id=r.checkpoint_id where c.session_id=%s''',
            (parent['id'],)).fetchone()['n']
    assert _global(db)==before+charge
