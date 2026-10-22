"""Independently owned real-Postgres conversion captures and native Save receipts."""
from dataclasses import replace
from datetime import timedelta
import hashlib
from uuid import uuid4

import pytest

from test_owned_album_tops_postgres import db, urls
from music_app.services.owned_album_tops import AlbumTopError, normalize_top_command
from music_app.services.playlist_album_top_previews import PlaylistAlbumTopPreviews
from music_app.services import playlist_album_top_previews as preview_module
from music_app.services.policy_evaluator import PolicyEvaluationConstraints

CONTEXT = 'a' * 64


@pytest.fixture
def source(db):
    ref = str(uuid4())
    with db.connect() as con:
        con.execute("""insert into app.playlists(ref,owner_account_id,library_id,title)
            values(%s,%s,%s,'Conversion source')""", (ref, db.owner.account_id, db.library))
        artist = con.execute('select artist_id from library.local_albums where id=%s', (db.album_ids[0],)).fetchone()['artist_id']
        for position, album in enumerate([db.album_ids[1], db.album_ids[0], db.album_ids[1]], 1):
            track = con.execute("""insert into library.local_tracks
                (library_id,artist_id,album_id,track_key,title) values(%s,%s,%s,%s,'Source song') returning id""",
                (db.library, artist, album, uuid4().hex)).fetchone()['id']
            con.execute("""insert into app.playlist_items
                (ref,playlist_ref,library_id,position,original_local_track_id,local_track_id,title)
                values(%s,%s,%s,%s,%s,%s,'Source song')""", (uuid4(), ref, db.library, position, track, track))
    try:
        yield db, ref, PlaylistAlbumTopPreviews(db.service)
    finally:
        # The migration owner may retire uniquely owned test receipts; the
        # application role can delete only expired receipts.
        with db.connect() as con:
            con.execute('delete from app.playlist_album_top_previews where library_id=%s', (db.library,))
            con.execute('delete from app.playlists where ref=%s', (ref,))


def capture(source, key=None):
    db, ref, previews = source
    return previews.capture(db.context(), playlist_ref=ref,
        payload={'request_key': key or str(uuid4()), 'revision': '1'}, context_ref=CONTEXT)


def save(db, preview):
    return normalize_top_command('create', {'request_key': preview['preview_ref'],
        'playlist_preview_ref': preview['preview_ref'], 'title': 'Saved conversion', 'description': ''})


def test_preview_does_not_create_top_and_save_uses_immutable_first_appearance(source):
    db, ref, previews = source
    before = db.snapshot()
    preview = capture(source)
    assert db.snapshot() == before
    assert [item['album_ref'] for item in preview['albums']] == [db.album_refs[1], db.album_refs[0]]
    assert [item['reason'] for item in preview['report']] == ['included', 'included', 'duplicate']
    assert capture(source, preview['preview_ref']) == preview
    with db.connect() as con:
        con.execute('delete from app.playlist_items where playlist_ref=%s', (ref,))
        con.execute('update app.playlists set revision=revision+1 where ref=%s', (ref,))
    command = save(db, preview)
    receipt = db.service.execute(db.context(), command, context_ref=CONTEXT)
    after = db.snapshot()
    assert len(after['tops']) == 1 and len(after['items']) == 2
    assert [str(item['catalog_ref']) for item in sorted(after['items'], key=lambda item: item['original_position'])] == [db.album_refs[1], db.album_refs[0]]
    assert db.service.execute(db.context(), command, context_ref=CONTEXT) == receipt
    assert db.snapshot() == after
    with db.connect() as con:
        assert con.execute('select count(*) as n from app.playlist_items where playlist_ref=%s', (ref,)).fetchone()['n'] == 0
        created = con.execute('select created_at from app.playlist_album_top_previews where ref=%s', (preview['preview_ref'],)).fetchone()['created_at']
        assert all(item['created_at'] >= created for item in after['items'])
        stored = con.execute('select saved_top_ref,snapshot from app.playlist_album_top_previews where ref=%s', (preview['preview_ref'],)).fetchone()
        assert str(stored['saved_top_ref']) == receipt['top_ref']
        assert stored['snapshot']['report'] == preview['report']


def test_discard_is_idempotent_and_old_preview_cannot_be_reopened_or_saved(source):
    db, _, previews = source
    preview = capture(source)
    for _ in range(2):
        assert previews.discard(db.context(), preview_ref=preview['preview_ref'], context_ref=CONTEXT)['discarded'] is True
    with pytest.raises(AlbumTopError, match='preview_unavailable'):
        capture(source, preview['preview_ref'])
    with pytest.raises(AlbumTopError, match='preview_unavailable'):
        db.service.execute(db.context(), save(db, preview), context_ref=CONTEXT)
    assert db.snapshot()['tops'] == []


def test_wrong_context_and_revoked_source_fail_before_top_creation(source):
    db, ref, _ = source
    preview = capture(source)
    command = save(db, preview)
    with pytest.raises(AlbumTopError, match='preview_unavailable'):
        db.service.execute(db.context(), command, context_ref='b' * 64)
    with db.connect() as con:
        con.execute('update app.playlists set deleted_at=now() where ref=%s', (ref,))
    with pytest.raises(AlbumTopError, match='playlist_unavailable'):
        db.service.execute(db.context(), command, context_ref=CONTEXT)
    assert db.snapshot()['tops'] == []


def test_expired_preview_and_changed_session_cannot_create_top(source):
    db, _, _ = source
    preview = capture(source)
    command = save(db, preview)
    with db.connect() as con:
        session = con.execute("""insert into app.account_sessions(account_id,session_token_hash,
            created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at)
            values(%s,%s,now(),now(),now(),now()+interval '4 hours',now()+interval '1 day') returning id""",
            (db.owner.account_id, hashlib.sha256(uuid4().bytes).digest())).fetchone()['id']
        con.execute("update app.account_sessions set idle_expires_at=now()+interval '4 hours' where id=%s", (db.owner.session_id,))
    # Even the same actor cannot Save an uncommitted receipt from another session.
    with pytest.raises(AlbumTopError, match='preview_unavailable'):
        db.service.execute(db.context(replace(db.owner, session_id=session)), command, context_ref=CONTEXT)
    original = db.service._clock
    db.service._clock = lambda: original() + timedelta(minutes=61)
    with pytest.raises(AlbumTopError, match='preview_expired'):
        db.service.execute(db.context(), command, context_ref=CONTEXT)
    db.service._clock = original
    assert db.snapshot()['tops'] == []


@pytest.mark.parametrize('kind', ['track', 'album'])
def test_replayed_preview_reauthorizes_contributing_resources(source, kind):
    db, ref, previews = source
    preview = capture(source)
    def constraints(context):
        denied = context.resource is not None and context.resource.resource_kind == kind
        return PolicyEvaluationConstraints(deployment_allowed=not denied)
    with pytest.raises(AlbumTopError, match='forbidden'):
        previews.capture(db.context(), playlist_ref=ref,
            payload={'request_key': preview['preview_ref'], 'revision': '1'}, context_ref=CONTEXT,
            constraints=constraints)
    assert db.snapshot()['tops'] == []
    # Revocation fails closed without rewriting the immutable captured snapshot.
    with db.connect() as con:
        snapshot = con.execute('select snapshot from app.playlist_album_top_previews where ref=%s',
            (preview['preview_ref'],)).fetchone()['snapshot']
    assert snapshot['albums'] == preview['albums']


@pytest.mark.parametrize('operation,phase', [
    ('replay', 'source'), ('replay', 'catalog'),
    ('save', 'source'), ('save', 'catalog'), ('save', 'postwrite'),
])
def test_expiry_after_lock_or_write_wait_fails_closed(source, monkeypatch, operation, phase):
    from datetime import datetime
    db, ref, previews = source
    preview = capture(source)
    before = db.snapshot()
    with db.connect() as con:
        con.execute("update app.account_sessions set idle_expires_at=now()+interval '4 hours' where id=%s", (db.owner.session_id,))
    time = [db.service._clock()]
    deadline = datetime.fromisoformat(preview['expires_at'])
    monkeypatch.setattr(db.service, '_clock', lambda: time[0])
    if phase == 'source':
        original = preview_module._source
        def waited(*args, **kwargs):
            result = original(*args, **kwargs)
            time[0] = deadline
            return result
        monkeypatch.setattr(preview_module, '_source', waited)
    else:
        name = '_catalog' if phase == 'catalog' else '_insert_operation'
        original = getattr(db.service, name)
        def waited(*args, **kwargs):
            result = original(*args, **kwargs)
            time[0] = deadline
            return result
        monkeypatch.setattr(db.service, name, waited)
    with pytest.raises(AlbumTopError, match='preview_expired'):
        if operation == 'replay':
            previews.capture(db.context(), playlist_ref=ref,
                payload={'request_key': preview['preview_ref'], 'revision': '1'}, context_ref=CONTEXT)
        else:
            db.service.execute(db.context(), save(db, preview), context_ref=CONTEXT)
    assert db.snapshot() == before
    with db.connect() as con:
        assert con.execute('select saved_top_ref from app.playlist_album_top_previews where ref=%s',
            (preview['preview_ref'],)).fetchone()['saved_top_ref'] is None


def test_preview_capacity_is_bounded_at_64(source):
    db, _, _ = source
    for _ in range(64):
        capture(source)
    with pytest.raises(AlbumTopError, match='preview_limit'):
        capture(source)
    with db.connect() as con:
        assert con.execute('select count(*) as n from app.playlist_album_top_previews where library_id=%s',
            (db.library,)).fetchone()['n'] == 64


def test_cleanup_removes_expired_abandoned_receipts_but_keeps_saved_provenance(source):
    db, _, _ = source
    preview = capture(source)
    receipt = db.service.execute(db.context(), save(db, preview), context_ref=CONTEXT)
    with db.connect() as con:
        for _ in range(64):
            con.execute("""insert into app.playlist_album_top_previews
                (ref,actor_account_id,original_session_id,library_id,context_ref,playlist_ref,
                 playlist_revision,source_track_ids,snapshot,created_at,expires_at)
                select %s,actor_account_id,original_session_id,library_id,context_ref,playlist_ref,
                 playlist_revision,source_track_ids,snapshot,now()-interval '2 hours',now()-interval '1 hour'
                from app.playlist_album_top_previews where ref=%s""", (uuid4(), preview['preview_ref']))
    capture(source)
    with db.connect() as con:
        rows = con.execute('select saved_top_ref from app.playlist_album_top_previews where library_id=%s', (db.library,)).fetchall()
    assert len(rows) == 2
    assert sum(str(row['saved_top_ref']) == receipt['top_ref'] for row in rows) == 1


def test_application_role_cannot_rewrite_snapshot_or_early_delete(source):
    import psycopg
    db, _, _ = source
    preview = capture(source)
    with psycopg.connect(db.app_url) as con:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with con.transaction():
                con.execute("update app.playlist_album_top_previews set snapshot='{}'::jsonb where ref=%s", (preview['preview_ref'],))
        with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState):
            with con.transaction():
                con.execute('delete from app.playlist_album_top_previews where ref=%s', (preview['preview_ref'],))


def test_new_capture_lifetime_starts_after_source_wait(source, monkeypatch):
    from datetime import datetime
    db, _, _ = source
    time = [db.service._clock()]
    advanced = time[0] + timedelta(minutes=30)
    with db.connect() as con:
        con.execute("update app.account_sessions set idle_expires_at=now()+interval '4 hours' where id=%s", (db.owner.session_id,))
    monkeypatch.setattr(db.service, '_clock', lambda: time[0])
    original = preview_module._source
    def waited(*args, **kwargs):
        result = original(*args, **kwargs)
        time[0] = advanced
        return result
    monkeypatch.setattr(preview_module, '_source', waited)
    preview = capture(source)
    assert datetime.fromisoformat(preview['expires_at']) == advanced + timedelta(minutes=60)


@pytest.mark.parametrize('second_action', ['save', 'discard'])
def test_concurrent_same_preview_has_at_most_one_save(source, second_action):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    db, _, previews = source
    preview = capture(source)
    command = save(db, preview)
    barrier = Barrier(2)
    def act(action):
        barrier.wait(timeout=10)
        if action == 'discard':
            return previews.discard(db.context(), preview_ref=preview['preview_ref'], context_ref=CONTEXT)
        try:
            return db.service.execute(db.context(), command, context_ref=CONTEXT)
        except AlbumTopError as error:
            return {'error': error.code}
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(act, 'save')
        second = pool.submit(act, second_action)
        results = [first.result(timeout=30), second.result(timeout=30)]
    saved = [result for result in results if 'top_ref' in result]
    snapshot = db.snapshot()
    assert len(snapshot['tops']) == (1 if saved else 0)
    assert len(snapshot['items']) == (2 if saved else 0)
    if second_action == 'save':
        assert len(saved) == 2 and saved[0] == saved[1]
    elif not saved:
        assert results[0] == {'error': 'preview_unavailable'}
    if saved:
        assert db.service.execute(db.context(), command, context_ref=CONTEXT) == saved[0]


def test_landed_save_replay_does_not_require_live_preview_or_source(source, monkeypatch):
    db, ref, _ = source
    preview = capture(source)
    command = save(db, preview)
    receipt = db.service.execute(db.context(), command, context_ref=CONTEXT)
    with db.connect() as con:
        con.execute('update app.playlists set deleted_at=now() where ref=%s', (ref,))
        con.execute("update app.account_sessions set idle_expires_at=now()+interval '4 hours' where id=%s", (db.owner.session_id,))
    future = db.service._clock() + timedelta(minutes=61)
    monkeypatch.setattr(db.service, '_clock', lambda: future)
    assert db.service.execute(db.context(), command, context_ref=CONTEXT) == receipt
    assert len(db.snapshot()['tops']) == 1
