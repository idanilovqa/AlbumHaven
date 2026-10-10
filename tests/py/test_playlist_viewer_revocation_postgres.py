"""An old pending request never regains authority after account/grant restoration."""
import pytest

from tests.py.test_owned_playlist_postgres_integration import db, urls
from tests.py.test_playlist_collaboration_postgres import sharing, member, write
from tests.py.test_playlist_viewer_actions_postgres import shared, SECRET
from music_app.services.owned_playlists import BROWSE, PlaylistError


@pytest.mark.parametrize('change', ['disabled', 'browse_revoke', 'browse_delete', 'view_revoke', 'view_delete'])
@pytest.mark.parametrize('observe_revocation', [False, True])
def test_restoring_requester_authority_does_not_resurrect_old_pending_request(sharing, change, observe_revocation):
    db = sharing
    original, viewer = shared(db), member(db)
    capability = 'capability.view' if change.startswith('view_') else BROWSE
    if capability != BROWSE:
        with db.connect() as con:
            con.execute('update app.capabilities set capability_key=%s where account_id=%s and capability_key=%s', (capability, viewer.account_id, BROWSE))
    requested, _ = write(db, 'request_edit', original, actor=viewer)
    with db.connect() as con:
        if change == 'disabled':
            con.execute('update app.accounts set is_active=false, disabled_at=now() where id=%s', (viewer.account_id,))
        elif change.endswith('_revoke'):
            con.execute('update app.capabilities set revoked_at=now() where account_id=%s and capability_key=%s', (viewer.account_id, capability))
        else:
            con.execute('delete from app.capabilities where account_id=%s and capability_key=%s', (viewer.account_id, capability))
    if observe_revocation:
        assert db.service.read_edit_requests(db.context(), cursor_secret=SECRET)['requests'] == []
    with db.connect() as con:
        if change == 'disabled':
            con.execute('update app.accounts set is_active=true, disabled_at=null where id=%s', (viewer.account_id,))
        elif change.endswith('_revoke'):
            con.execute('update app.capabilities set revoked_at=null where account_id=%s and capability_key=%s', (viewer.account_id, capability))
        else:
            con.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,%s,'library',%s)",
                        (viewer.account_id, capability, db.library))
    assert db.service.read_edit_requests(db.context(), cursor_secret=SECRET)['requests'] == []
    with pytest.raises(PlaylistError, match='request_unavailable'):
        write(db, 'decide_edit_request', original, request_ref=requested['request_ref'], decision='approve')
    fresh, _ = write(db, 'request_edit', original, actor=viewer)
    assert fresh['request_ref'] != requested['request_ref']
    assert fresh['request_created'] is True


def test_owner_pending_read_and_requester_retry_do_not_invert_account_parent_locks(sharing, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from music_app.services import playlist_viewer_actions as viewers

    db = sharing
    original, viewer = shared(db), member(db)
    requested, _ = write(db, 'request_edit', original, actor=viewer)
    reader_at_requester, writer_at_parent, release_reader = Event(), Event(), Event()
    project_requester, load_playlist = viewers.requester_context, db.service._playlist

    def requester_checkpoint(connection, ctx, account_id, **kwargs):
        if account_id == viewer.account_id:
            reader_at_requester.set()
            assert release_reader.wait(5), 'Reader checkpoint was not released'
        return project_requester(connection, ctx, account_id, **kwargs)

    def parent_checkpoint(connection, ctx, playlist_ref, **kwargs):
        if ctx.actor.account_id == viewer.account_id and kwargs.get('write'):
            # execute() has already acquired the viewer's account row lock.
            writer_at_parent.set()
        return load_playlist(connection, ctx, playlist_ref, **kwargs)

    monkeypatch.setattr(viewers, 'requester_context', requester_checkpoint)
    monkeypatch.setattr(db.service, '_playlist', parent_checkpoint)
    with ThreadPoolExecutor(max_workers=2) as pool:
        reading = pool.submit(db.service.read_edit_requests, db.context(), cursor_secret=SECRET)
        try:
            assert reader_at_requester.wait(5), 'Owner read did not reach requester projection'
            writing = pool.submit(write, db, 'request_edit', original, actor=viewer)
            assert writer_at_parent.wait(5), 'Viewer retry did not reach parent lock'
        finally:
            release_reader.set()
        feed = reading.result(timeout=10)
        repeat, _ = writing.result(timeout=10)
    assert feed['requests'][0]['request_ref'] == requested['request_ref']
    assert repeat['request_ref'] == requested['request_ref']
    assert repeat['request_created'] is False
