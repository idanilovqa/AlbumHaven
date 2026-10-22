"""One existing fixed provider identity mapper, without account/source authority.

The caller has already validated stored provider facts in its current authority
transaction. This helper neither fetches MusicBrainz nor reads Goals. Its exact
savepoint/unique-race protocol is shared by the existing Goals and Top owners.
"""
from uuid import uuid4


class RemoteCatalogIdentityConflict(RuntimeError):
    pass


def map_release_group_catalog(connection, evidence):
    identity = ('musicbrainz', 'release-group', evidence['external_id'])
    query = '''select catalog_ref from catalog.release_group_provider_identities
        where provider=%s and entity_kind=%s and external_id=%s'''
    row = connection.execute(query, identity).fetchone()
    if row:
        return str(row['catalog_ref'])
    candidate = str(uuid4())
    # A losing cross-account race rolls back only its candidate catalog record;
    # it must not strand a UUID or retry either owner's whole command.
    try:
        with connection.transaction():
            connection.execute('''insert into catalog.release_groups(ref,title,artist_display,release_year)
                values(%s,%s,%s,%s)''', (candidate, evidence['title'], evidence['artist_display'],
                    int(evidence['first_release_date'][:4]) if evidence['first_release_date'] else None))
            connection.execute('''insert into catalog.release_group_provider_identities
                (provider,entity_kind,external_id,catalog_ref) values(%s,%s,%s,%s)''', (*identity, candidate))
        return candidate
    except Exception as error:
        if getattr(error, 'sqlstate', None) != '23505':
            raise
        row = connection.execute(query, identity).fetchone()
        if row is None:
            raise RemoteCatalogIdentityConflict('identity_conflict') from None
        return str(row['catalog_ref'])
