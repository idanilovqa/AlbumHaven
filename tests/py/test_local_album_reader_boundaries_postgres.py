"""Actual SQL reader boundaries on separately admitted owned synthetic fixtures.

No SQL, permission, readiness or state-transition success stubs. Decoder pipe
bytes are synthetic; this does not establish rendered client/audio end to end.
"""
from copy import copy, deepcopy
from dataclasses import replace
from datetime import timedelta
import hashlib
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest

from music_app.services import local_album_full_state as full
from music_app.services import playback_decoder_observation as observations
from music_app.services.local_album_listening import read_local_album_metrics
from music_app.services.playback_capture import canonical_json, capture_scope
from music_app.services.playback_pcm import PcmDecoderProcess, PcmOpenCommand
from tests.py.test_playback_capture_postgres import capture_db, urls
from tests.py.test_playback_capture_v2_writer_postgres import _run, _write
from tests.py.test_playback_edition_selection_postgres import selected_data, connector
from tests.py.test_playback_capture_source import _Process, _consume


def inventory_ready(db):
    with db.connect() as connection:
        connection.execute('update library.local_tracks set disc_number=1,track_number=1 where id=%s', (db.track,))
        connection.execute('update library.local_track_files set file_size_bytes=1024,modified_at=%s where id=%s',
            (db.now, db.file))


async def source(db, extent, *, owner=None, binding=1):
    admitted = observations.prepare_decoder_admission(db.app_url, db.context, db.path, db.path, db.guard,
        clock=lambda: db.now, connect=connector(db))
    assert admitted is not None
    command = PcmOpenCommand(generation=7, stream_id=binding, role='current', path=Path(db.path),
        start_frame=0, sample_rate=48000, provisional_duration_seconds=999)
    decoder = PcmDecoderProcess(command, _Process(bytes(extent * 8)))
    try:
        assert observations.record_decoder_open(db.app_url, db.context, admitted, command, decoder.metadata,
            clock=lambda: db.now, connect=connector(db), enabled=lambda: True)
        eof = await _consume(decoder, extent)
        assert observations.record_decoder_eof(db.app_url, db.context, admitted, command, eof,
            clock=lambda: db.now, connect=connector(db), enabled=lambda: True)
        data = selected_data(db)
        data['capture_uuid'] = str(uuid4())
        if owner is not None:
            data['evidence']['owner_uuid'] = owner
        return SimpleNamespace(decoder=decoder, data=data, next_sequence=1, binding=binding)
    except BaseException:
        await decoder.cancel()
        raise


def append(db, captured, coordinates):
    """Use genuine bounded writer commands, not direct projection inserts."""
    for offset in range(0, len(coordinates), 64):
        data = deepcopy(captured.data)
        data['sequence'] = captured.next_sequence
        data['evidence']['runs'] = [_run(ordinal, captured.binding, source_start48=start,
            frames=frames, output_start=ordinal, generation=7, stream_id=captured.binding,
            source_observation_ref=captured.decoder.metadata.capture_source_id)
            for ordinal, start, frames in coordinates[offset:offset + 64]]
        assert len(canonical_json(data).encode()) <= 32768
        # Advance a valid synthetic fixture clock instead of disabling rate limits.
        db.now += timedelta(seconds=1)
        _write(db, data, connect=connector(db))
        captured.next_sequence += 1


def read(db):
    return read_local_album_metrics(db.app_url, db.context, db.token,
        clock=lambda: db.now, connect=connector(db))


def stored(db):
    with db.connect() as connection:
        return connection.execute('''select state_revision,state,reservation_bytes
            from integration.playback_album_metrics_state
            where account_id=%s and original_library_id=%s and original_album_id=%s''',
            (db.account, db.library, db.album)).fetchone()


def advance(db, revision):
    db.now += timedelta(seconds=2)
    return full.advance_local_album_full(db.app_url, db.context, db.token, revision,
        clock=lambda: db.now, connect=connector(db), enabled=lambda: True)


def finish_pass(db):
    for _ in range(80):
        saved = stored(db)
        if saved is not None and saved['state']['phase'] == 'complete':
            return saved
        advance(db, saved['state_revision'] if saved else 0)
    raise AssertionError('Finite owned history did not finish its bounded pass')


def raw_summary(db):
    with db.connect() as connection:
        return connection.execute('''select count(*) as runs,coalesce(sum(r.frames),0) as frames,
            min(r.id) as first_id,max(r.id) as last_id,max(cp.id) as checkpoint
            from integration.playback_capture_session p
            join integration.playback_capture_checkpoint cp on cp.session_id=p.id
            join integration.playback_capture_run r on r.checkpoint_id=cp.id
            where p.account_id=%s and p.original_album_id=%s''', (db.account, db.album)).fetchone()


@pytest.mark.asyncio
async def test_real_visible_window_4096_then_4097_drops_only_oldest_run(capture_db):
    db = capture_db
    inventory_ready(db)
    captured = await source(db, 4098)
    try:
        # Unequal first run makes an accidental prefix/4097-row sum observable.
        append(db, captured, [(0, 0, 2)] + [(i + 1, i + 1, 1) for i in range(1, 4096)])
        original = raw_summary(db)
        assert original['runs'] == 4096 and original['frames'] == 4097
        at_cap = read(db)
        assert at_cap['window_truncated'] is False
        assert at_cap['metrics']['recorded_frames'] == 4097
        assert at_cap['cutoff_run_id'] == str(original['last_id'])
        assert at_cap['cutoff_checkpoint_id'] == str(original['checkpoint'])
        append(db, captured, [(4097, 4097, 1)])
        before_read = raw_summary(db)
        assert before_read['runs'] == 4097 and before_read['frames'] == 4098
        over_cap = read(db)
        assert over_cap['window_truncated'] is True
        assert over_cap['metrics']['recorded_frames'] == 4096
        assert over_cap['cutoff_run_id'] == str(before_read['last_id'])
        assert over_cap['cutoff_checkpoint_id'] == str(before_read['checkpoint'])
        assert over_cap['history_complete'] is False
        assert raw_summary(db) == before_read
        assert any('order by r.id desc limit 4097' in sql for sql in db.sql)
    finally:
        await captured.decoder.cancel()


@pytest.mark.asyncio
async def test_real_fixed_cut_pages_stale_retry_and_later_append_do_not_reuse_evidence(capture_db):
    db = capture_db
    inventory_ready(db)
    captured = await source(db, 258)
    try:
        append(db, captured, [(i, i, 1) for i in range(257)])
        old_cut = raw_summary(db)['checkpoint']
        advance(db, 0)
        first = stored(db)
        assert first['state_revision'] == 1
        assert first['state']['phase'] == 'anchors' and first['state']['ordinal'] == 255
        assert first['state']['cutoff'] == old_cut
        advance(db, 0)  # Actual stale request cannot replay the first page.
        assert stored(db) == first
        append(db, captured, [(257, 257, 1)])
        new_cut = raw_summary(db)['checkpoint']
        assert new_cut > old_cut
        old_complete = finish_pass(db)
        assert old_complete['state']['completed_cutoff'] == old_cut
        assert old_complete['state']['geometry']['seen_runs'] == 257
        old_projection = read(db)['full_progress']
        assert old_projection['full'] == 0 and old_projection['continuation'] is True
        assert old_projection['recorded_details']['recorded_frames'] == 257
        assert old_projection['partial'] is None
        advance(db, old_complete['state_revision'])
        new_complete = finish_pass(db)
        assert new_complete['state']['completed_cutoff'] == new_cut
        assert new_complete['state']['geometry']['seen_runs'] == 258
        current = read(db)['full_progress']
        assert current['full'] == current['uninterrupted_full'] == 1
        assert current['continuation'] is False
        assert current['recorded_details']['recorded_frames'] == 258
        assert current['partial'] is None and current['history_complete'] is False
        assert any('order by r.ordinal_start limit 257' in sql for sql in db.sql)
    finally:
        await captured.decoder.cancel()


@pytest.mark.asyncio
async def test_real_new_login_reads_old_owner_and_counts_distinct_sessions_once(capture_db):
    db = capture_db
    inventory_ready(db)
    old_source = await source(db, 2)
    new_source = None
    try:
        append(db, old_source, [(0, 0, 2)])
        old_session = db.session
        with db.connect() as connection:
            db.session = connection.execute('''insert into app.account_sessions(account_id,session_token_hash,
                created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at)
                values(%s,%s,%s,%s,%s,%s,%s) returning id''',
                (db.account, hashlib.sha256(uuid4().bytes).digest(), db.now, db.now, db.now,
                 db.now + timedelta(days=3), db.now + timedelta(days=3))).fetchone()['id']
            connection.execute('update app.account_sessions set revoked_at=%s where id=%s', (db.now, old_session))
        db.actor = replace(db.actor, session_id=db.session, authenticated_at=db.now)
        db.context = replace(db.context, actor=db.actor)
        db.guard = capture_scope(db.context, {'hmac': {'secret': 'synthetic-capture-policy-key-32-bytes', 'key_version': 1}})
        assert db.session != old_session
        assert read(db)['metrics']['recorded_frames'] == 2
        new_source = await source(db, 2)
        append(db, new_source, [(0, 0, 2)])
        finish_pass(db)
        result = read(db)
        assert result['metrics']['recorded_frames'] == 4
        assert result['full_progress']['full'] == result['full_progress']['uninterrupted_full'] == 2
        assert result['full_progress']['recorded_details']['recorded_frames'] == 4
        with db.connect() as connection:
            owners = connection.execute('''select count(*) as n,count(distinct auth_session_guard) as sessions
                from integration.playback_capture_owner where account_id=%s''', (db.account,)).fetchone()
        assert owners == {'n': 2, 'sessions': 2}
    finally:
        await old_source.decoder.cancel()
        if new_source is not None:
            await new_source.decoder.cancel()


def additional_track(db, *, album, number):
    view = copy(db)
    view.album = album
    view.payload = deepcopy(db.payload)
    view.payload['capture_uuid'] = str(uuid4())
    with db.connect() as connection:
        album_row = connection.execute('select album_key from library.local_albums where id=%s', (album,)).fetchone()
        view.token = album_row['album_key']
        view.track = connection.execute('''insert into library.local_tracks(library_id,album_id,track_key,title,
            disc_number,track_number) values(%s,%s,%s,'Owned boundary track',1,%s) returning id''',
            (db.library, album, uuid4().hex, number)).fetchone()['id']
        view.path = '/synthetic/capture-' + db.token + '/' + str(view.track) + '.flac'
        view.file = connection.execute('''insert into library.local_track_files(track_id,library_root_id,
            private_path,file_size_bytes,modified_at) values(%s,%s,%s,1024,%s) returning id''',
            (view.track, db.root, view.path, db.now)).fetchone()['id']
    return view


@pytest.mark.asyncio
async def test_real_interleaved_album_run_is_a_gap_not_false_uninterrupted_full(capture_db):
    db = capture_db
    inventory_ready(db)
    extra_album = None
    views = []
    sources = []
    try:
        with db.connect() as connection:
            extra_album = connection.execute('''insert into library.local_albums(library_id,album_key,title)
                values(%s,%s,'Owned intervening album') returning id''', (db.library, uuid4().hex)).fetchone()['id']
        last = additional_track(db, album=db.album, number=2)
        views.append(last)
        other = additional_track(db, album=extra_album, number=1)
        views.append(other)
        owner = str(uuid4())
        for ordinal, view, binding in ((0, db, 1), (2, other, 2), (4, last, 3)):
            view.now = db.now
            captured = await source(view, 2, owner=owner, binding=binding)
            sources.append(captured)
            append(view, captured, [(ordinal, 0, 2)])
            db.now = view.now
        finish_pass(db)
        result = read(db)
        assert result['metrics']['recorded_frames'] == 4
        assert result['full_progress']['full'] == result['full_progress']['uninterrupted_full'] == 0
        assert result['full_progress']['recorded_details']['recorded_frames'] == 4
        assert stored(db)['state']['geometry']['seen_runs'] == 2
        with db.connect() as connection:
            actual = connection.execute('''select r.ordinal_start,p.original_album_id
                from integration.playback_capture_run r
                join integration.playback_capture_checkpoint cp on cp.id=r.checkpoint_id
                join integration.playback_capture_session p on p.id=cp.session_id
                where p.account_id=%s order by r.ordinal_start''', (db.account,)).fetchall()
        assert [(r['ordinal_start'], r['original_album_id']) for r in actual] == [
            (0, db.album), (2, extra_album), (4, db.album)]
    finally:
        for captured in sources:
            await captured.decoder.cancel()
        with db.connect() as connection:
            for view in views:
                connection.execute('delete from library.local_tracks where id=%s', (view.track,))
            if extra_album is not None:
                connection.execute('delete from library.local_albums where id=%s', (extra_album,))


@pytest.mark.asyncio
@pytest.mark.parametrize('change', ['late_loss', 'observation_delete'])
async def test_real_late_invalidating_evidence_rebuilds_full_without_rewriting_runs(capture_db, change):
    db = capture_db
    inventory_ready(db)
    captured = await source(db, 2)
    try:
        append(db, captured, [(0, 0, 2)])
        complete = finish_pass(db)
        before = read(db)
        assert before['full_progress']['full'] == 1
        positive_before = raw_summary(db)
        if change == 'late_loss':
            data = deepcopy(captured.data)
            data['sequence'] = captured.next_sequence
            data['evidence'].update(runs=[], gaps=[dict(ordinal_start=0, ordinal_end=2,
                positive_frames=1, output_start=0, output_end=2, epoch=None, reasons=['queue_capacity'])])
            db.now += timedelta(seconds=1)
            _write(db, data, connect=connector(db))
            captured.next_sequence += 1
        else:
            with db.connect() as connection:
                connection.execute('''delete from integration.playback_decoder_observation
                    where account_id=%s and observation_ref=%s''',
                    (db.account, captured.decoder.metadata.capture_source_id))
        pending = read(db)
        assert pending['full_progress']['status'] == 'recalculating'
        assert 'full' not in pending['full_progress']
        if change == 'late_loss':
            assert int(pending['invalidation_revision']) > int(before['invalidation_revision'])
        else:
            # The observation-delete trigger advances proof, while the removed
            # supporting extent independently invalidates the saved Full basis.
            assert int(pending['proof_revision']) > int(before['proof_revision'])
            assert pending['invalidation_revision'] == before['invalidation_revision']
        assert raw_summary(db) == positive_before
        advance(db, complete['state_revision'])
        finish_pass(db)
        after = read(db)['full_progress']
        assert after['full'] == 0 and after['uninterrupted_full'] == 0
        assert after['partial'] is None and after['history_complete'] is False
        assert raw_summary(db) == positive_before
    finally:
        await captured.decoder.cancel()
