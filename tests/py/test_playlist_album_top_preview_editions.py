"""Canonical preview membership is not a promise of a fixed local edition."""
from uuid import uuid4

import pytest

from test_owned_album_tops_postgres import db, urls
from test_playlist_album_top_previews_postgres import source, capture, CONTEXT
from music_app.services.owned_album_tops import AlbumTopError
from music_app.services.policy_evaluator import PolicyEvaluationConstraints


@pytest.mark.parametrize('deny_current_edition', [False, True])
def test_same_contributing_track_can_use_only_current_authorized_canonical_edition(source, deny_current_edition):
    db, ref, previews = source
    preview = capture(source)
    key = uuid4().hex
    with db.connect() as con:
        edition = con.execute("""insert into library.local_albums
            (library_id,artist_id,album_key,title,release_year)
            select library_id,artist_id,%s,'Another confirmed edition',2001
            from library.local_albums where id=%s returning id""", (key, db.album_ids[1])).fetchone()['id']
        con.execute('insert into library.catalog_album_links(library_id,local_album_id,catalog_ref) values(%s,%s,%s)',
            (db.library, edition, db.album_refs[1]))
        track = con.execute('select local_track_id from app.playlist_items where playlist_ref=%s and position=1',
            (ref,)).fetchone()['local_track_id']
        con.execute('update library.local_tracks set album_id=%s where id=%s', (edition, track))
        assert con.execute('select revision from app.playlists where ref=%s', (ref,)).fetchone()['revision'] == 1

    def constraints(context):
        resource = context.resource
        denied = deny_current_edition and resource is not None and resource.resource_kind == 'album' and resource.resource_ref == str(edition)
        return PolicyEvaluationConstraints(deployment_allowed=not denied)

    def resolve():
        return previews.resolve_album(db.context(), preview_ref=preview['preview_ref'],
            album_ref=db.album_refs[1], context_ref=CONTEXT, constraints=constraints)

    if deny_current_edition:
        # The still-readable old edition cannot authorize opening the new one.
        with pytest.raises(AlbumTopError, match='forbidden'):
            resolve()
    else:
        result = resolve()
        assert result['album_ref'] == db.album_refs[1]
        assert result['native_target']['album_ref'] == key
        assert result['native_target']['allowed_actions']['can_play_album'] is False
    with db.connect() as con:
        row = con.execute('select snapshot,source_track_ids from app.playlist_album_top_previews where ref=%s',
            (preview['preview_ref'],)).fetchone()
    assert row['snapshot']['albums'] == preview['albums']
    assert row['source_track_ids'][0] == track
    assert db.snapshot()['tops'] == []
