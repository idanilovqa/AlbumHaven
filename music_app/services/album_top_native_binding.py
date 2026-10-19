"""Tuple-bounded catalog locking shared by Top Details and playback actions."""
from music_app.services.owned_album_tops import AlbumTopError


def lock_binding(connection, *, top_ref, item_ref, library_id, revision, catalog_ref):
    locked = connection.execute('''select app.lock_top_native_catalog_binding(%s,%s,%s,%s,%s)
        as locked''', (top_ref, item_ref, library_id, int(revision), catalog_ref)).fetchone()
    if locked is None or locked['locked'] is not True:
        raise AlbumTopError('native_binding_changed', 409)


def eligible_editions(connection, library_id, catalog_ref):
    # Lock unbound editions too: changing their key must not create ambiguity.
    rows = connection.execute('''select a.id,a.album_key
        from library.catalog_album_links l
        join library.local_albums a on a.id=l.local_album_id and a.library_id=l.library_id
        where l.library_id=%s and l.catalog_ref=%s
        order by a.id for share of a''', (library_id, catalog_ref)).fetchall()
    return [row for row in rows if row['album_key']]
