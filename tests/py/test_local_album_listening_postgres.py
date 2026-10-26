"""UNRUN actual producer/open/writer/EOF/metrics reader composition.

Requires separately provisioned S2 schema/indexes and runtime privileges. Real
policy/current-library transaction, selection persistence, budgets and queries;
only the decoder subprocess/pipe is synthetic. Never deletes shared libraries.
"""
from dataclasses import replace
from uuid import uuid4
import pytest
from music_app.services import playback_decoder_observation as observations
from music_app.services.local_album_listening import read_local_album_metrics
from tests.py.test_playback_capture_postgres import capture_db,urls
from tests.py.test_playback_edition_selection_postgres import selected_data,connector
from tests.py.test_playback_capture_v2_writer_postgres import _write
from tests.py.test_playback_decoder_observation_postgres import admission,producer,record_open,read
from tests.py.test_playback_capture_source import _consume


def metrics(db):
    return read_local_album_metrics(db.app_url,db.context,db.token,clock=lambda:db.now,connect=connector(db))


def claim(db,decoder):
    data=selected_data(db)
    data['evidence']['runs'][0].update(generation=7,stream_id=11,
        source_observation_ref=decoder.metadata.capture_source_id)
    data['evidence'].update(terminal=True,terminal_reason='ended')
    return data


@pytest.mark.asyncio
async def test_ended_partial_borrows_later_compatible_server_extent_without_rewriting_raw_json(capture_db):
    db=capture_db;opened=admission(db);partial=producer(db);donor=producer(db)
    try:
        record_open(db,opened,partial);data=claim(db,partial);_write(db,data)
        before=metrics(db);assert before['metrics']['tracks'][0]['covered_frames'] is None
        assert read(db)['runs'][0]['extent_status']=='unknown'
        with db.connect() as c:
            saved=c.execute('select evidence,digest from integration.playback_capture_checkpoint where session_id=%s',
                (db.rows()[0]['id'],)).fetchone()
        await partial.cancel()  # Admitted source survives a partial stop, no fake EOF.
        record_open(db,opened,donor);eof=await _consume(donor,4)
        assert observations.record_decoder_eof(db.app_url,db.context,opened,donor.command,eof,
            clock=lambda:db.now,enabled=lambda:True)
        after=metrics(db);track=after['metrics']['tracks'][0]
        assert track['recorded_frames']==2 and track['covered_frames']==2 and track['extent_frames48']==4
        assert after['history_complete'] is False and after['metrics']['full'] is None
        assert int(after['proof_revision'])>int(before['proof_revision'])
        # Exact-stream old reader remains unknown; only current-version metrics
        # borrows another stream's length, never its played frames or UUID identity.
        assert read(db)['runs'][0]['extent_status']=='unknown'
        with db.connect() as c:
            assert c.execute('select evidence,digest from integration.playback_capture_checkpoint where session_id=%s',
                (db.rows()[0]['id'],)).fetchone()==saved
        assert any('for share of h,b' in q for q in db.sql)
        assert any('limit 4097' in q for q in db.sql)
        assert not any('/synthetic/' in str(v) for v in after.values())
    finally:await partial.cancel();await donor.cancel()


@pytest.mark.asyncio
async def test_conflicting_compatible_donor_lengths_leave_coverage_unknown(capture_db):
    db=capture_db;opened=admission(db);first=producer(db,4);second=producer(db,5)
    try:
        record_open(db,opened,first);_write(db,claim(db,first))
        for decoder,frames in ((first,4),(second,5)):
            record_open(db,opened,decoder)
            eof=await _consume(decoder,frames)
            assert observations.record_decoder_eof(db.app_url,db.context,opened,decoder.command,eof,
                clock=lambda:db.now,enabled=lambda:True)
        result=metrics(db)
        assert result['metrics']['recorded_frames']==2
        assert result['metrics']['tracks'][0]['covered_frames'] is None
    finally:await first.cancel();await second.cancel()


@pytest.mark.asyncio
@pytest.mark.parametrize('change',['file_version','stale','inactive_root','membership'])
async def test_current_inventory_changes_invalidate_coverage_but_not_recorded_time(capture_db,change):
    db=capture_db;opened=admission(db);decoder=producer(db)
    try:
        record_open(db,opened,decoder);_write(db,claim(db,decoder));eof=await _consume(decoder,4)
        assert observations.record_decoder_eof(db.app_url,db.context,opened,decoder.command,eof,
            clock=lambda:db.now,enabled=lambda:True)
        assert metrics(db)['metrics']['tracks'][0]['covered_frames']==2
        with db.connect() as c:
            if change=='file_version':c.execute('update library.local_track_files set file_size_bytes=2048 where id=%s',(db.file,))
            elif change=='stale':c.execute("update library.local_track_files set metadata=jsonb_set(metadata,'{scan_cache}',jsonb_build_object('stale',true)) where id=%s",(db.file,))
            elif change=='inactive_root':c.execute('update library.library_roots set is_active=false where id=%s',(db.root,))
            else:c.execute('update library.local_tracks set track_number=4 where id=%s',(db.track,))
        result=metrics(db)['metrics']
        assert result['recorded_frames']==2 and result['tracks'][0]['covered_frames'] is None
    finally:await decoder.cancel()


@pytest.mark.asyncio
async def test_missing_track_is_not_removed_from_selected_denominator(capture_db):
    db=capture_db;missing=None;decoder=None
    try:
        with db.connect() as c:
            missing=c.execute("""insert into library.local_tracks(library_id,album_id,track_key,title,disc_number,track_number)
                values(%s,%s,%s,'Missing file',2,4) returning id""",(db.library,db.album,uuid4().hex)).fetchone()['id']
        opened=admission(db);decoder=producer(db);record_open(db,opened,decoder);_write(db,claim(db,decoder))
        eof=await _consume(decoder,4)
        assert observations.record_decoder_eof(db.app_url,db.context,opened,decoder.command,eof,clock=lambda:db.now,enabled=lambda:True)
        result=metrics(db)['metrics'];assert len(result['tracks'])==2
        absent=next(t for t in result['tracks'] if t['track_id']==str(missing))
        assert absent['recorded_frames']==0 and absent['covered_frames'] is None
        assert result['full'] is None
    finally:
        if decoder is not None:await decoder.cancel()
        if missing is not None:
            with db.connect() as c:c.execute('delete from library.local_tracks where id=%s',(missing,))

@pytest.mark.asyncio
async def test_unselected_run_never_infers_complete_album_from_track_membership(capture_db):
    from tests.py.test_playback_capture_v2_writer_postgres import _data
    db=capture_db;opened=admission(db);decoder=producer(db)
    try:
        record_open(db,opened,decoder)
        data=_data(db);data['evidence']['runs'][0].update(generation=7,stream_id=11,
            source_observation_ref=decoder.metadata.capture_source_id)
        _write(db,data);eof=await _consume(decoder,4)
        assert observations.record_decoder_eof(db.app_url,db.context,opened,decoder.command,eof,
            clock=lambda:db.now,enabled=lambda:True)
        result=metrics(db)['metrics']
        assert result['recorded_frames']==2 and result['tracks'][0]['covered_frames'] is None
        assert result['full'] is None
    finally:await decoder.cancel()
