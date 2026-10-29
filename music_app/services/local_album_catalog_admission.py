"""Transaction-local inventory-to-catalog binding shared by authorized owners.

Caller owns account/library transaction and feature authority. This helper owns
locked album evidence, album Browse authority, canonical linkage and no-name-dedupe.
"""
from uuid import uuid4
from music_app.services.owned_album_tops import AlbumTopError,BROWSE
from music_app.services.policy import ResourceScope
from music_app.services.private_library_authority import require_private_action


def admit_local_album(connection,live,album_id,*,constraints=None,validate_locked=None):
    if type(album_id) is not int or not 0<album_id<=9223372036854775807:
        raise AlbumTopError('invalid_command')
    resource=ResourceScope('album',str(album_id))
    require_private_action(live,BROWSE,resource=resource,constraints=constraints)
    row=connection.execute('''select a.title,a.release_year,ar.name as artist_display
        from library.local_albums a join library.local_artists ar on ar.id=a.artist_id and ar.library_id=a.library_id
        where a.id=%s and a.library_id=%s for update of a''',(album_id,live.library_id)).fetchone()
    if row is None:raise AlbumTopError('album_unavailable',404)
    if validate_locked is not None:validate_locked()
    require_private_action(live,BROWSE,resource=resource,constraints=constraints)
    linked=connection.execute('''select catalog_ref from library.catalog_album_links
        where library_id=%s and local_album_id=%s''',(live.library_id,album_id)).fetchone()
    if linked is not None:
        require_private_action(live,BROWSE,resource=resource,constraints=constraints)
        return str(linked['catalog_ref'])
    title,artist=row['title'],row['artist_display']
    if any(type(v) is not str or not v.strip() or len(v)>1000 for v in (title,artist)):
        raise AlbumTopError('album_metadata_unresolved',409)
    ref=str(uuid4());year=row['release_year']
    connection.execute('''insert into catalog.release_groups(ref,title,artist_display,release_year)
        values(%s,%s,%s,%s)''',(ref,title,artist,year if type(year) is int and 1<=year<=9999 else None))
    connection.execute('''insert into library.catalog_album_links(library_id,local_album_id,catalog_ref)
        values(%s,%s,%s)''',(live.library_id,album_id,ref))
    require_private_action(live,BROWSE,resource=resource,constraints=constraints)
    return ref
