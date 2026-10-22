"""Exact saved Artist/Family intent, separate from mutable album membership."""


def normalize_artist_scope(value):
    from music_app.services.owned_album_tops import AlbumTopError

    if type(value) is not dict or set(value) != {'root_artist_id', 'mode'}:
        raise AlbumTopError('invalid_command')
    identity, mode = value['root_artist_id'], value['mode']
    if (type(identity) is not str or not identity.isascii() or not identity.isdecimal()
            or identity.startswith('0') or len(identity) > 19
            or not 0 < int(identity) < 2**63 or type(mode) is not str
            or mode not in {'artist', 'family'}):
        raise AlbumTopError('invalid_command')
    return {'root_artist_id': identity, 'mode': mode}


def artist_scope(top):
    """Absent ordinary scope does not add a DTO field or require new schema reads."""
    identity = top.get('listen_through_artist_id')
    mode = top.get('listen_through_scope_mode')
    if identity is None and mode is None:
        return None
    if type(identity) is not int:
        from music_app.services.owned_album_tops import AlbumTopError
        raise AlbumTopError('artist_scope_unavailable', 503)
    try:
        return normalize_artist_scope({'root_artist_id': str(identity), 'mode': mode})
    except Exception as error:
        from music_app.services.owned_album_tops import AlbumTopError
        if not isinstance(error, AlbumTopError):
            raise
        raise AlbumTopError('artist_scope_unavailable', 503) from None


def scope_projection(top):
    value = artist_scope(top)
    return {'artist_scope': value} if value is not None else {}
