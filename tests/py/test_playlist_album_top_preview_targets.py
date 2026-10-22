"""Real SQL checks for action-time unsaved canonical member resolution."""
from dataclasses import replace
from datetime import datetime, timedelta
import hashlib
from uuid import uuid4

import pytest

from test_owned_album_tops_postgres import db, urls
from test_playlist_album_top_previews_postgres import source, capture, save, CONTEXT
from music_app.services.owned_album_tops import AlbumTopError
from music_app.services.private_native_targets import PrivateNativeTargets
from music_app.services.policy_evaluator import PolicyEvaluationConstraints


def resolve(source, preview, **options):
    db, _, previews = source
    return previews.resolve_album(db.context(), preview_ref=preview['preview_ref'],
        album_ref=preview['albums'][0]['album_ref'], context_ref=CONTEXT, **options)


def test_repeated_nested_open_resolves_same_member_without_persisting_top(source):
    db, ref, _ = source
    preview = capture(source)
    before = db.snapshot()
    first = resolve(source, preview)
    assert resolve(source, preview) == first
    assert first['preview_ref'] == preview['preview_ref']
    assert first['album_ref'] == db.album_refs[1]
    assert first['source'] == {'playlist_ref': ref, 'revision': '1'}
    with db.connect() as con:
        key = con.execute('select album_key from library.local_albums where id=%s',
            (db.album_ids[1],)).fetchone()['album_key']
    assert first['native_target'] == {'album_ref': key,
        'allowed_actions': {'can_view_details': True, 'can_play_album': False}}
    assert db.snapshot() == before


@pytest.mark.parametrize('remap', ['album', 'track'])
def test_inventory_remap_without_playlist_revision_cannot_open_other_album(source, remap):
    db, ref, _ = source
    preview = capture(source)
    with db.connect() as con:
        if remap == 'album':
            con.execute('update library.local_tracks set album_id=%s where id=(select local_track_id '
                'from app.playlist_items where playlist_ref=%s and position=1)', (db.album_ids[0], ref))
        else:
            # The replacement has the same canonical album. Capture identity,
            # rather than similarity or the unchanged Playlist revision, wins.
            con.execute('update app.playlist_items set local_track_id=(select local_track_id '
                'from app.playlist_items where playlist_ref=%s and position=3) '
                'where playlist_ref=%s and position=1', (ref, ref))
        assert con.execute('select revision from app.playlists where ref=%s', (ref,)).fetchone()['revision'] == 1
    with pytest.raises(AlbumTopError, match='preview_member_changed'):
        resolve(source, preview)


def test_catalog_mapping_removed_without_playlist_revision_fails_closed(source):
    db, ref, _ = source
    preview = capture(source)
    with db.connect() as con:
        con.execute('delete from library.catalog_album_links where local_album_id=%s', (db.album_ids[1],))
        assert con.execute('select revision from app.playlists where ref=%s', (ref,)).fetchone()['revision'] == 1
    with pytest.raises(AlbumTopError, match='album_unavailable'):
        resolve(source, preview)


@pytest.mark.parametrize('kind', ['track', 'album', 'playlist'])
def test_member_resolution_rechecks_current_resource_authority(source, kind):
    preview = capture(source)
    def constraints(context):
        denied = context.resource is not None and context.resource.resource_kind == kind
        return PolicyEvaluationConstraints(deployment_allowed=not denied)
    with pytest.raises(AlbumTopError, match='forbidden'):
        resolve(source, preview, constraints=constraints)


@pytest.mark.parametrize('departure', ['revision', 'discard', 'save', 'delete'])
def test_departed_or_changed_preview_never_resolves_member(source, departure):
    db, ref, previews = source
    preview = capture(source)
    if departure == 'discard':
        previews.discard(db.context(), preview_ref=preview['preview_ref'], context_ref=CONTEXT)
    elif departure == 'save':
        db.service.execute(db.context(), save(db, preview), context_ref=CONTEXT)
    else:
        with db.connect() as con:
            con.execute('update app.playlists set ' + ('revision=revision+1' if departure == 'revision'
                else 'deleted_at=now()') + ' where ref=%s', (ref,))
    with pytest.raises(AlbumTopError):
        resolve(source, preview)


def test_foreign_member_context_and_session_are_rejected(source):
    db, _, previews = source
    preview = capture(source)
    for album, context in [(str(uuid4()), CONTEXT), (db.album_refs[1], 'b' * 64)]:
        with pytest.raises(AlbumTopError, match='preview_unavailable'):
            previews.resolve_album(db.context(), preview_ref=preview['preview_ref'],
                album_ref=album, context_ref=context)
    with db.connect() as con:
        session = con.execute("""insert into app.account_sessions(account_id,session_token_hash,
            created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at)
            values(%s,%s,now(),now(),now(),now()+interval '4 hours',now()+interval '1 day') returning id""",
            (db.owner.account_id, hashlib.sha256(uuid4().bytes).digest())).fetchone()['id']
    with pytest.raises(AlbumTopError, match='preview_unavailable'):
        previews.resolve_album(db.context(replace(db.owner, session_id=session)),
            preview_ref=preview['preview_ref'], album_ref=db.album_refs[1], context_ref=CONTEXT)


def test_expiry_during_native_target_lock_wait_releases_no_native_identity(source, monkeypatch):
    db, _, _ = source
    preview = capture(source)
    now = [db.service._clock()]
    with db.connect() as con:
        con.execute("update app.account_sessions set idle_expires_at=now()+interval '4 hours' where id=%s",
            (db.owner.session_id,))
    monkeypatch.setattr(db.service, '_clock', lambda: now[0])
    original = PrivateNativeTargets.resolve_album
    def waited(self, *args, **kwargs):
        target = original(self, *args, **kwargs)
        now[0] = datetime.fromisoformat(preview['expires_at']) + timedelta(microseconds=1)
        return target
    monkeypatch.setattr(PrivateNativeTargets, 'resolve_album', waited)
    with pytest.raises(AlbumTopError, match='preview_expired'):
        resolve(source, preview)
    assert db.snapshot()['tops'] == []
