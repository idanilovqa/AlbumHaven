"""Optional retained occurrence identity; never media or canonical-song authority."""
from music_app.services.owned_playlists import PlaylistError


def installed(connection):
    """Absent proposal is supported; an incompatible installed column is not."""
    row = connection.execute("""select a.atttypid='uuid'::regtype as uuid_type,
        a.attnotnull,a.atthasdef,a.attgenerated,a.attidentity
        from pg_catalog.pg_attribute a
        where a.attrelid=to_regclass('app.playlist_items')
          and a.attname='metadata_occurrence_ref' and not a.attisdropped""").fetchone()
    if row is None:
        return False
    # A default could assign one origin to unrelated rows from ordinary owners.
    if (row['uuid_type'] is not True or row['attnotnull'] is not False
            or row['atthasdef'] is not False
            or row['attgenerated'] != '' or row['attidentity'] != ''):
        raise PlaylistError('playlist_schema_unavailable', 503)
    return True


def origin(row):
    # Derive only from the current verified row, never private/deleted ancestors.
    return str(row.get('metadata_occurrence_ref') or row['ref'])
