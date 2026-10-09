"""Real PostgreSQL request, owner-decision and private-copy isolation."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from uuid import uuid4

import pytest

from tests.py.test_owned_playlist_postgres_integration import db, urls
from tests.py.test_playlist_collaboration_postgres import sharing, member, write
from music_app.services.owned_playlists import BROWSE, CREATE, PlaylistError

SECRET = 'playlist-request-tests-' + 'x' * 32


def shared(db):
    original, _ = db.create()
    return write(db, 'visibility', original, visibility='server_shared')[0]


def test_request_is_deduplicated_private_and_never_grants(sharing):
    db = sharing
    original, viewer, other = shared(db), member(db), member(db)
    request, command = write(db, 'request_edit', original, actor=viewer)
    repeat, _ = write(db, 'request_edit', original, actor=viewer)
    assert request['request_ref'] == repeat['request_ref']
    assert request['request_created'] and not repeat['request_created']
    assert db.service.execute(db.context(viewer), command) == request
    detail = db.service.read(db.context(viewer), playlist_ref=original['playlist_id'])['playlist_detail']
    assert not detail['allowed_actions']['can_edit']
    assert detail['allowed_actions']['can_view_sharing'] and detail['allowed_actions']['can_request_edit']
    view = db.service.read_sharing(db.context(viewer), original['playlist_id'])
    assert view['request_status'] == 'pending' and view['pending_requests'] == []
    assert db.service.read_sharing(db.context(other), original['playlist_id'])['request_status'] == 'none'
    owner = db.service.read_edit_requests(db.context(), cursor_secret=SECRET)
    assert len(owner['requests']) == 1 and owner['requests'][0]['request_ref'] == request['request_ref']
    assert db.service.read_edit_requests(db.context(other), cursor_secret=SECRET)['requests'] == []


@pytest.mark.parametrize('decision', ['approve', 'decline'])
def test_only_owner_explicit_decision_resolves_request(sharing, decision):
    db = sharing
    original, viewer, other = shared(db), member(db), member(db)
    request, _ = write(db, 'request_edit', original, actor=viewer)
    for actor in (viewer, other):
        with pytest.raises(PlaylistError, match='forbidden'):
            write(db, 'decide_edit_request', original, actor=actor, request_ref=request['request_ref'], decision=decision)
    result, command = write(db, 'decide_edit_request', original, request_ref=request['request_ref'], decision=decision)
    assert result['request_status'] == ('approved' if decision == 'approve' else 'declined')
    assert db.service.execute(db.context(), command) == result
    assert db.service.read_edit_requests(db.context(), cursor_secret=SECRET)['requests'] == []
    assert db.service.read(db.context(viewer), playlist_ref=original['playlist_id'])['playlist_detail']['allowed_actions']['can_edit'] == (decision == 'approve')


@pytest.mark.parametrize('change', ['private', 'deleted', 'membership', 'disabled', 'browse'])
def test_request_source_revocation_removes_notifications_and_blocks_approval(sharing, change):
    db = sharing
    original, viewer = shared(db), member(db)
    request, _ = write(db, 'request_edit', original, actor=viewer)
    latest = original
    if change == 'private':
        latest, _ = write(db, 'visibility', original, visibility='private')
    elif change == 'deleted':
        latest, _ = write(db, 'delete', original)
    else:
        with db.connect() as con:
            if change == 'membership':
                con.execute('delete from library.library_memberships where library_id=%s and account_id=%s', (db.library, viewer.account_id))
            elif change == 'disabled':
                con.execute('update app.accounts set is_active=false,disabled_at=now() where id=%s', (viewer.account_id,))
            else:
                con.execute('update app.capabilities set revoked_at=now() where account_id=%s and capability_key=%s', (viewer.account_id, BROWSE))
    assert db.service.read_edit_requests(db.context(), cursor_secret=SECRET)['requests'] == []
    with pytest.raises(PlaylistError):
        write(db, 'decide_edit_request', latest, request_ref=request['request_ref'], decision='approve')
    if change == 'private':
        reshared, _ = write(db, 'visibility', latest, visibility='server_shared')
        assert db.service.read_sharing(db.context(viewer), original['playlist_id'])['request_status'] == 'none'
        with pytest.raises(PlaylistError, match='request_unavailable'):
            write(db, 'decide_edit_request', reshared, request_ref=request['request_ref'], decision='approve')


@pytest.mark.parametrize('private_lineage', [
    {'private_subject': 'owner-listens'},
    {'queue': 'queue_occurrences_v1', 'occurrences': [
        {'kind': 'activity', 'track_ref': 'opaque-track',
         'origin': {'subject_ref': 'private-owner', 'snapshot': 'private-snapshot'},
         'row_ref': 'private-listen', 'activity_lineage': {'listen_id': 'private-listen'}},
        {'kind': 'playlist', 'playlist_ref': 'private-source', 'revision': '7', 'item_ref': 'private-item'},
    ]},
])
def test_copy_is_private_ordered_new_identity_and_replay_safe(sharing, private_lineage):
    db = sharing
    original, viewer = shared(db), member(db)
    with db.connect() as con:
        from psycopg.types.json import Jsonb
        con.execute('update app.playlist_items set source_lineage=%s where playlist_ref=%s',
                    (Jsonb(private_lineage), original['playlist_id']))
        before = con.execute('select * from app.playlist_items where playlist_ref=%s order by position', (original['playlist_id'],)).fetchall()
    copied, command = write(db, 'copy', original, actor=viewer)
    assert copied['playlist_id'] != original['playlist_id'] and copied['source_playlist_id'] == original['playlist_id']
    assert db.service.execute(db.context(viewer), command) == copied
    assert db.service.read_operation(db.context(viewer), command.request_key)['receipt'] == copied
    with db.connect() as con:
        result = con.execute('select * from app.playlists where ref=%s', (copied['playlist_id'],)).fetchone()
        rows = con.execute('select * from app.playlist_items where playlist_ref=%s order by position', (copied['playlist_id'],)).fetchall()
        assert result['owner_account_id'] == viewer.account_id and result['visibility'] == 'private'
        assert [r['title'] for r in rows] == [r['title'] for r in before]
        assert {r['ref'] for r in rows}.isdisjoint({r['ref'] for r in before})
        assert all(r['source_lineage'] == {'playlist_ref': original['playlist_id'], 'playlist_item_ref': str(before[i]['ref']), 'playlist_revision': original['revision']} and r['source_ref'] is None for i,r in enumerate(rows))
        assert con.execute('select count(*) as n from app.playlist_access_grants where playlist_ref=%s', (copied['playlist_id'],)).fetchone()['n'] == 0
        assert con.execute('select * from app.playlist_items where playlist_ref=%s order by position', (original['playlist_id'],)).fetchall() == before
    assert db.service.read(db.context(viewer), playlist_ref=copied['playlist_id'])['playlist_detail']['allowed_actions']['can_edit']
    with pytest.raises(PlaylistError, match='playlist_unavailable'):
        db.service.read(db.context(), playlist_ref=copied['playlist_id'])


def test_copy_requires_create_and_current_source_revision(sharing):
    db = sharing
    original, viewer = shared(db), member(db)
    updated, _ = write(db, 'save', original, title='Updated')
    for action in ('copy', 'request_edit'):
        with pytest.raises(PlaylistError, match='revision_conflict'):
            write(db, action, original, actor=viewer)
    with db.connect() as con:
        con.execute('update app.capabilities set revoked_at=now() where account_id=%s and capability_key=%s', (viewer.account_id, CREATE))
    with pytest.raises(PlaylistError, match='forbidden'):
        write(db, 'copy', updated, actor=viewer)


def test_concurrent_identical_copy_and_request_keys_do_not_duplicate(sharing):
    db = sharing
    original, viewer = shared(db), member(db)
    for action in ('request_edit', 'copy'):
        key = str(uuid4())
        def execute():
            return write(db, action, original, actor=viewer, key=key)[0]
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: execute(), range(2)))
        assert results[0] == results[1]
    with db.connect() as con:
        assert con.execute('select count(*) as n from app.playlist_edit_requests where library_id=%s', (db.library,)).fetchone()['n'] == 1
        assert con.execute('select count(*) as n from app.playlists where owner_account_id=%s and library_id=%s', (viewer.account_id, db.library)).fetchone()['n'] == 1


def test_notification_cursors_are_owner_bound(sharing):
    db = sharing
    original, viewers = shared(db), [member(db), member(db)]
    for viewer in viewers:
        write(db, 'request_edit', original, actor=viewer)
    page = db.service.read_edit_requests(db.context(), cursor_secret=SECRET, limit=1)
    assert len(page['requests']) == 1 and page['next_cursor']
    second = db.service.read_edit_requests(db.context(), cursor_secret=SECRET, cursor=page['next_cursor'], limit=1)
    assert len(second['requests']) == 1 and second['next_cursor'] is None
    with pytest.raises(PlaylistError, match='invalid_cursor'):
        db.service.read_edit_requests(db.context(viewers[0]), cursor_secret=SECRET, cursor=page['next_cursor'])
