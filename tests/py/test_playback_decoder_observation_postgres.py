"""UNRUN actual decoder -> writer -> socket EOF persistence -> stored reader.

Requires separately provisioned S2 admitted-open schema including observation relation.
Successor corrects the unrun S1 shared-library deletion hazard; never deletes the canonical library.
Synthetic subprocess/pipe and socket boundaries only; no migrations or ffmpeg.
"""
from copy import deepcopy
from pathlib import Path
from dataclasses import replace
from uuid import uuid4
import asyncio
import pytest
from music_app.services import playback_decoder_observation as observations
from music_app.services.playback_pcm import PcmDecoderProcess,PcmOpenCommand
from music_app.routes import playback_stream_asgi as routes
from tests.py.test_playback_capture_postgres import capture_db,urls
from tests.py.test_playback_capture_v2_writer_postgres import _data,_write,_global
from tests.py.test_playback_capture_source import _Process,_consume
from tests.py.test_playback_cleanup import _Socket,_connection


def admission(db):
    with db.connect() as c:
        c.execute('update library.local_track_files set file_size_bytes=1024,modified_at=%s where id=%s',(db.now,db.file))
    value=observations.prepare_decoder_admission(db.app_url,db.context,db.path,db.path,db.guard,clock=lambda:db.now)
    assert value is not None,'Observation schema/runtime privileges must be provisioned separately'
    return value


def producer(db,frames=4):
    command=PcmOpenCommand(generation=7,stream_id=11,role='current',path=Path(db.path),start_frame=0,
        sample_rate=48000,provisional_duration_seconds=999)
    return PcmDecoderProcess(command,_Process(bytes(frames*8)))


def read(db):return observations.read_decoder_observed_runs(db.app_url,db.context,clock=lambda:db.now)


def record_open(db,opened,decoder):
    assert observations.record_decoder_open(db.app_url,db.context,opened,decoder.command,decoder.metadata,
        clock=lambda:db.now,enabled=lambda:True)



@pytest.mark.asyncio
async def test_actual_late_eof_joins_immutable_stored_run_without_crediting_unplayed_frames(capture_db):
    db=capture_db;opened=admission(db);decoder=producer(db);socket=_Socket()
    socket.app.state.config={'ALBUM_HAVEN_POSITION_CAPTURE_ENABLED':True}
    registry,socket,connection,stream=await _connection(decoder,socket)
    stream.capture_admission=(db.app_url,db.context,None,opened)
    try:
        record_open(db,opened,decoder)
        data=_data(db);data['evidence']['runs'][0].update(generation=7,stream_id=11);data['evidence']['runs'][0]['source_observation_ref']=decoder.metadata.capture_source_id
        _write(db,data)
        with db.connect() as c:
            original=c.execute('select evidence,digest from integration.playback_capture_checkpoint where session_id=%s',(db.rows()[0]['id'],)).fetchone()
        before=read(db);assert before['runs'][0]['extent_status']=='unknown'
        metadata=await _consume(decoder,4)
        assert await connection._send_stream_eos(stream,metadata)
        after=read(db);run=after['runs'][0]
        assert run['extent_status']=='observed_extent' and run['extent_frames48']==4 and run['frames']==2
        assert after['proof_revision']>before['proof_revision']
        with db.connect() as c:
            assert c.execute('select evidence,digest from integration.playback_capture_checkpoint where session_id=%s',(db.rows()[0]['id'],)).fetchone()==original
        assert socket.events[0]['type']=='eos' and registry.active_decoder_count==0
    finally:
        await connection.cleanup();await decoder.cancel()


@pytest.mark.asyncio
@pytest.mark.parametrize('change',['file_metadata','file_mapping','scope','extent','generation'])
async def test_source_changes_or_mismatched_lineage_cannot_qualify_claim(capture_db,change):
    db=capture_db;opened=admission(db);decoder=producer(db)
    try:
        record_open(db,opened,decoder)
        data=_data(db);data['evidence']['runs'][0].update(generation=7,stream_id=11);data['evidence']['runs'][0]['source_observation_ref']=decoder.metadata.capture_source_id
        _write(db,data);metadata=await _consume(decoder,4)
        if change=='file_metadata':
            with db.connect() as c:c.execute('update library.local_track_files set file_size_bytes=2048 where id=%s',(db.file,))
        elif change=='file_mapping':opened=replace(opened,file_id=opened.file_id+1)
        elif change=='scope':opened=replace(opened,auth_session_guard='different-session-scope')
        elif change=='extent':metadata=replace(metadata,capture_extent_frames48=None)
        else:metadata=replace(metadata,generation=metadata.generation+1)
        if change=='scope':
            with pytest.raises(observations.CaptureError,match='capture_conflict'):
                observations.record_decoder_eof(db.app_url,db.context,opened,decoder.command,metadata,
                    clock=lambda:db.now,enabled=lambda:True)
        else:
            assert observations.record_decoder_eof(db.app_url,db.context,opened,decoder.command,metadata,
                clock=lambda:db.now,enabled=lambda:True) is False
        assert read(db)['runs'][0]['extent_status']=='unknown'
    finally:await decoder.cancel()


@pytest.mark.asyncio
async def test_observation_replay_charges_once_and_deletion_invalidates_late_join(capture_db):
    db=capture_db;opened=admission(db);decoder=producer(db)
    try:
        record_open(db,opened,decoder)
        data=_data(db);data['evidence']['runs'][0].update(generation=7,stream_id=11);data['evidence']['runs'][0]['source_observation_ref']=decoder.metadata.capture_source_id
        _write(db,data);before=_global(db);metadata=await _consume(decoder,4)
        for _ in range(2):
            assert observations.record_decoder_eof(db.app_url,db.context,opened,decoder.command,metadata,
                clock=lambda:db.now,enabled=lambda:True)
        assert _global(db)==before  # EOF promotion/replay adds no second reservation.
        qualified=read(db)
        with db.connect() as c:c.execute('delete from integration.playback_decoder_observation where account_id=%s',(db.account,))
        assert _global(db)==before-observations.OBSERVATION_BYTES
        assert read(db)['runs'][0]['extent_status']=='unknown' and read(db)['proof_revision']>qualified['proof_revision']
    finally:await decoder.cancel()

def test_owned_synthetic_library_loss_preserves_account_observation_without_live_fk(capture_db):
    """Schema-only regression in a rolled-back transaction, not producer qualification.

    The borrowed canonical library is NEVER deleted. New library/account and all
    corresponding budget/fact rows are uniquely owned and always rolled back.
    """
    db=capture_db
    with db.connect() as c:
        try:
            name='observation-loss-'+uuid4().hex
            account=c.execute("""insert into app.accounts(display_name,account_kind,username_display,
                username_normalized,contact_email,contact_email_normalized)
                values(%s,'managed_user',%s,%s,%s,%s) returning id""",
                (name,name,name,name+'@example.test',name+'@example.test')).fetchone()['id']
            library=c.execute('insert into library.libraries(owner_account_id,name) values(%s,%s) returning id',
                (account,name)).fetchone()['id']
            from music_app.services.playback_capture_postgres import _budgets,_reserve
            from music_app.services.playback_capture_history_revision import _prepare_history_revision,_insert_reserved_history_revision
            budget,global_budget=_budgets(c,account,db.now)
            history,charge=_prepare_history_revision(c,budget)
            _reserve(c,budget,global_budget,observations.OBSERVATION_BYTES+charge)
            if history is None:_insert_reserved_history_revision(c,budget)
            ref=str(uuid4())
            c.execute("""insert into integration.playback_decoder_observation
                (account_id,observation_ref,auth_session_guard,original_library_id,original_track_id,
                original_file_id,original_root_id,generation,stream_id,source_base48,extent_frames48,
                inventory_source_revision,observed_at,reservation_bytes,account_budget_id)
                values(%s,%s,'synthetic-schema-only',%s,1,1,1,1,1,0,null,%s,%s,512,%s)""",
                (account,ref,library,'a'*64,db.now,budget['id']))
            assert library!=db.library
            c.execute('delete from library.libraries where id=%s',(library,))
            row=c.execute('select original_library_id from integration.playback_decoder_observation where account_id=%s',
                (account,)).fetchone()
            assert row['original_library_id']==library
            assert c.execute('select id from library.libraries where id=%s',(db.library,)).fetchone()
            c.execute('delete from app.accounts where id=%s',(account,))
            assert not c.execute('select 1 from integration.playback_decoder_observation where account_id=%s',(account,)).fetchone()
        finally:c.rollback()

@pytest.mark.asyncio
async def test_observation_quota_failure_rolls_back_fact_and_history_revision(capture_db,monkeypatch):
    db=capture_db;opened=admission(db);decoder=producer(db)
    try:
        _write(db,_data(db));metadata=decoder.metadata
        before=read(db)['proof_revision']
        from music_app.services import playback_capture_postgres as writer
        def deny(*a):raise observations.CaptureError('capture_quota',429)
        monkeypatch.setattr(writer,'_reserve',deny)
        with pytest.raises(observations.CaptureError):
            observations.record_decoder_open(db.app_url,db.context,opened,decoder.command,metadata,
                clock=lambda:db.now,enabled=lambda:True)
        assert read(db)['proof_revision']==before
        with db.connect() as c:
            assert not c.execute('select 1 from integration.playback_decoder_observation where account_id=%s',(db.account,)).fetchone()
    finally:await decoder.cancel()


@pytest.mark.asyncio
async def test_runtime_without_delete_admits_open_eof_read_but_cannot_delete(capture_db):
    import psycopg
    from psycopg.rows import dict_row
    db=capture_db
    def app(): return psycopg.connect(db.app_url,row_factory=dict_row)
    with app() as c:
        acl=c.execute("select has_table_privilege('integration.playback_decoder_observation','DELETE') as delete,pg_has_role(current_user,'album_haven_migrator','MEMBER') as migrator").fetchone()
        assert acl=={'delete':False,'migrator':False}
        assert observations.decoder_observation_ready(c)
        from music_app.services.playback_position_transport import require_position_storage
        require_position_storage(c)
        assert c.execute("select has_table_privilege('integration.playback_capture_owner','DELETE') as allowed").fetchone()['allowed'] is False
    opened=admission(db);decoder=producer(db)
    try:
        record_open(db,opened,decoder)
        data=_data(db);data['evidence']['runs'][0].update(generation=7,stream_id=11,source_observation_ref=decoder.metadata.capture_source_id)
        _write(db,data)
        metadata=await _consume(decoder,4)
        assert observations.record_decoder_eof(db.app_url,db.context,opened,decoder.command,metadata,
            clock=lambda:db.now,enabled=lambda:True)
        assert read(db)['runs'][0]['extent_status']=='observed_extent'
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with app() as c:
                c.execute('delete from integration.playback_decoder_observation where account_id=%s',(db.account,))
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with app() as c:
                c.execute('delete from integration.playback_capture_owner where account_id=%s',(db.account,))
        assert read(db)['runs'][0]['extent_status']=='observed_extent'
    finally: await decoder.cancel()
