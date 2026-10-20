"""Actual admission boundary for the captured Artist identity safety ceiling."""

from music_app.services.library_inventory_postgres import local_inventory_identity_key
from tests.py.test_album_top_remote_artist_scope_postgres import (
    artist_remote, mixed, retained, remote, db, urls, scoped_command)
from tests.py.test_album_top_remote_membership_postgres import record_owner_sql
from tests.py.test_owned_album_tops_postgres import assert_error


def expand_family(case, total):
    # seed_scope already supplies the root and one linked Family member. The
    # third seeded Artist is outside this Family and must not count toward it.
    names = ['Bound Artist ' + case.db.token + ' ' + str(index) for index in range(total - 2)]
    keys = [local_inventory_identity_key(name) for name in names]
    with case.db.connect() as connection:
        connection.execute('''insert into library.local_artists(library_id,artist_key,name)
            select %s, rows.artist_key, rows.name from unnest(%s::text[],%s::text[])
            as rows(artist_key,name)''', (case.db.library, keys, names))
        connection.execute('''insert into library.local_artist_family_links
            (library_id,artist_id,related_artist_id,relationship_weight,source_family,source_ref)
            select %s,%s,id,1,'folder_derived_runtime','relation_views.folder_related'
            from library.local_artists where library_id=%s and artist_key=any(%s)''',
            (case.db.library, case.db.scope_artists[0], case.db.library, keys))
        count = connection.execute('''select count(*) as count from library.local_artist_family_links
            where library_id=%s and artist_id=%s''',
            (case.db.library, case.db.scope_artists[0])).fetchone()['count']
    assert count + 1 == total


def test_exact_5000_artist_boundary_accepts_known_match_without_truncation(artist_remote):
    case = artist_remote
    expand_family(case, 5000)
    command, _ = scoped_command(case, mode='family')
    result = case.execute(command)
    assert len(case.read(result)['items']) == 1


def test_5001_artist_scope_fails_closed_before_mapping_or_final_artist_locks(artist_remote):
    case = artist_remote
    expand_family(case, 5001)
    command, _ = scoped_command(case, mode='family')
    before = case.snapshot()
    with record_owner_sql(case.db) as recorded:
        assert_error(lambda: case.execute(command), 'artist_scope_unavailable', 409)
    assert case.snapshot() == before
    assert not any('library.local_artists' in sql and 'for share' in sql
                   for _, sql, _ in recorded)
    assert not any('insert into catalog.' in sql or 'update catalog.' in sql
                   or 'retain_top_remote_acquisition' in sql
                   or 'insert into app.album_list_operations' in sql
                   for _, sql, _ in recorded)
