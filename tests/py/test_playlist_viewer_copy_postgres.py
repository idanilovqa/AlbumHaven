"""Independent copy receipt identity and source-lifecycle regressions."""
from uuid import uuid4

import pytest

from tests.py.test_owned_playlist_postgres_integration import db, urls
from tests.py.test_playlist_collaboration_postgres import sharing, member, write
from tests.py.test_playlist_viewer_actions_postgres import shared
from music_app.services.owned_playlists import PlaylistError


def test_committed_copy_retry_survives_source_revocation_but_never_recopies(sharing):
    db = sharing
    original, viewer = shared(db), member(db)
    copied, command = write(db, 'copy', original, actor=viewer)
    write(db, 'visibility', original, visibility='private')
    assert db.service.execute(db.context(viewer), command) == copied
    assert db.service.read_operation(db.context(viewer), command.request_key)['receipt'] == copied
    with pytest.raises(PlaylistError, match='playlist_unavailable'):
        write(db, 'copy', original, actor=viewer)
    with db.connect() as con:
        assert con.execute('select count(*) as n from app.playlists where library_id=%s and owner_account_id=%s',
                           (db.library, viewer.account_id)).fetchone()['n'] == 1


def test_copy_receipt_key_binds_source_action_and_original_body(sharing):
    db = sharing
    original, other_source, viewer = shared(db), shared(db), member(db)
    copied, command = write(db, 'copy', original, actor=viewer, title='First copy')
    for action, source, fields in [
        ('copy', other_source, {'title': 'First copy'}),
        ('copy', original, {'title': 'Changed copy'}),
        ('request_edit', original, {}),
    ]:
        with pytest.raises(PlaylistError, match='idempotency_key_reused'):
            write(db, action, source, actor=viewer, key=command.request_key, **fields)
    assert db.service.execute(db.context(viewer), command) == copied
    with db.connect() as con:
        assert con.execute('select count(*) as n from app.playlists where library_id=%s and owner_account_id=%s',
                           (db.library, viewer.account_id)).fetchone()['n'] == 1


def test_identical_key_from_another_actor_is_independent_and_cannot_read_copy(sharing):
    db = sharing
    original, first, second, key = shared(db), member(db), member(db), str(uuid4())
    copy_a, _ = write(db, 'copy', original, actor=first, key=key)
    assert db.service.read_operation(db.context(second), key)['status'] == 'unknown'
    copy_b, _ = write(db, 'copy', original, actor=second, key=key)
    assert copy_a['playlist_id'] != copy_b['playlist_id']
    assert db.service.read_operation(db.context(first), key)['receipt'] == copy_a
    assert db.service.read_operation(db.context(second), key)['receipt'] == copy_b
    for actor, other in ((first, copy_b), (second, copy_a)):
        with pytest.raises(PlaylistError, match='playlist_unavailable'):
            db.service.read(db.context(actor), playlist_ref=other['playlist_id'])
