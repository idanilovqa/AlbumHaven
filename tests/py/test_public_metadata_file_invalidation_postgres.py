"""Real successful-capture clock regressions for the additive 0135 replacement.

Requires the existing admitted disposable PostgreSQL fixture and its actual
restricted runtime login. Metadata only: no PNG, filesystem probe, route, fake
capture, SET ROLE, grants, disabled triggers or edits to the protected fixtures.
Every concurrency assertion observes a PostgreSQL blocker, not elapsed sleep.
The administrative reconstruction/TRUNCATE tests always roll back and must run
serially on the disposable database, never against a shared/live deployment.
"""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass
from hashlib import sha256
import json
from pathlib import Path
from threading import Event
from time import monotonic
from types import SimpleNamespace
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
import pytest

from music_app.services import album_top_publication_evidence as evidence
from music_app.services.owned_album_tops import AlbumTopError
from tests.e2e.support import isolatedPostgres
from tests.py.test_owned_album_tops_postgres import db, urls
from tests.py.postgres_runtime_role_contract import assert_runtime_role

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / 'migrations' / 'postgres'
BASE = '0110_owner_save_top_publication.sql'
MIGRATION = '0135_public_metadata_file_invalidation.sql'
BASE_SHA256 = 'b616aa97c884f7a65915c3314df4eec07ead36fb9a82d7e99be42c13023fbd47'
MIGRATION_SHA256 = '818a4734aa6717efd0ff1aae96e583b6b2f00a52424fcde94f8af38f0014adc5'
FUNCTION = 'library.invalidate_public_metadata_source()'
TABLES = ('libraries', 'library_roots', 'local_albums', 'local_artists',
          'local_tracks', 'local_track_files', 'catalog_album_links', 'album_metadata_sources')
OLD_QUERY = """      execute 'with changed as ('||rows_sql||') select array_agg(distinct t.library_id order by t.library_id) from changed join library.local_tracks t on t.id=(r->>''track_id'')::bigint' into ids;"""
NEW_QUERY = """      execute 'with changed as ('||rows_sql||'), targets as (
        select t.library_id from changed join library.local_tracks t on t.id=(r->>''track_id'')::bigint
        union all
        select r.library_id from changed c join library.library_roots r on r.id=(c.r->>''library_root_id'')::bigint
        union all
        select s.library_id from changed join library.album_metadata_sources s on s.ref=(r->>''metadata_source_ref'')::uuid
      ) select array_agg(distinct library_id order by library_id) from targets where library_id is not null' into ids;"""


def migration_text():
    data = (MIGRATIONS / MIGRATION).read_bytes()
    assert sha256(data).hexdigest() == MIGRATION_SHA256
    return data.decode('utf-8')


def predecessor_function():
    data = (MIGRATIONS / BASE).read_bytes()
    assert sha256(data).hexdigest() == BASE_SHA256
    source = data.decode('utf-8')
    start = source.index('create function ' + FUNCTION)
    stop = source.index('\ndo $$ declare source text; begin', start)
    return source[start:stop].replace('create function ', 'create or replace function ', 1)


def test_exact_replacement_changes_only_the_file_target_query():
    old = predecessor_function()
    new = migration_text()
    new = new[new.index('create or replace function ' + FUNCTION):].rstrip()
    assert old.count(OLD_QUERY) == new.count(NEW_QUERY) == 1
    assert new.replace(NEW_QUERY, OLD_QUERY) == old
    # CREATE OR REPLACE retains catalog ownership and existing ACLs. No grant,
    # table/trigger DDL, backfill, caller argument or new callable API is added.
    assert new.count('create or replace function ') == 1


@contextmanager
def runtime(case, *, lock_timeout='5s'):
    with psycopg.connect(case.db.app_url, row_factory=dict_row) as connection:
        assert_runtime_role(connection, case.db)
        connection.execute('select set_config(\'lock_timeout\',%s,true)', (lock_timeout,))
        connection.execute("set local statement_timeout='12s'")
        assert connection.execute('show transaction_isolation').fetchone()['transaction_isolation'] == 'read committed'
        yield connection


@contextmanager
def maintenance(case):
    with case.db.connect() as connection:
        isolatedPostgres._assert_connected_role(connection, isolatedPostgres.SETUP_ROLE)
        identity = connection.execute('''select current_user as name,session_user as login,
            rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
            from pg_roles where rolname=current_user''').fetchone()
        expected = isolatedPostgres._database_role(case.db.setup_url)
        assert identity == {'name': expected, 'login': expected, 'rolsuper': False,
                            'rolcreatedb': False, 'rolcreaterole': False,
                            'rolreplication': False, 'rolbypassrls': False}
        connection.execute("set local lock_timeout='5s'")
        connection.execute("set local statement_timeout='12s'")
        yield connection


def clocks(case, connection=None):
    if connection is None:
        with runtime(case) as connection:
            return clocks(case, connection)
    return {row['library_id']: row['generation'] for row in connection.execute(
        '''select library_id,generation from library.public_metadata_source_state
           where library_id=any(%s::bigint[]) order by library_id''', (case.libraries,)).fetchall()}


def assert_delta(case, before, affected, *, connection=None):
    after = clocks(case, connection)
    assert set(after) == set(before) == set(case.libraries)
    assert after == {library: generation + int(library in affected)
                     for library, generation in before.items()}
    return after


def capture(case, edition=None, connection=None):
    edition = edition or case.a
    if connection is None:
        # The context manager commits and releases SHARE before a later writer.
        with runtime(case) as connection:
            return capture(case, edition, connection)
    top = connection.execute('select ref,revision from app.album_lists where ref=%s',
                             (edition.top_ref,)).fetchone()
    assert top is not None
    return evidence.capture(connection, edition.context, top=top, items=[edition.selection])


def successful_baseline(case, edition=None):
    value = capture(case, edition)
    assert len(value['items']) == 1
    assert len(value['items'][0]['metadata']['tracks']) == 2
    assert value['generation'] > 0 and len(value['evidence_revision']) == 64
    return value


def assert_changed_or_rejected(case, baseline, edition=None, connection=None):
    try:
        current = capture(case, edition, connection)
    except AlbumTopError as error:
        assert (error.code, error.status_code) == ('evidence_unavailable', 409)
    else:
        assert current['generation'] > baseline['generation']
        assert current['evidence_revision'] != baseline['evidence_revision']


def insert_file(connection, *, track, root, path, source):
    return connection.execute('''insert into library.local_track_files
        (track_id,library_root_id,private_path,content_signature,metadata_source_ref,metadata)
        values(%s,%s,%s,'metadata-clock-test',%s,'{}') returning id''',
        (track, root, path, source)).fetchone()['id']


def seed_edition(case, library, album, album_ref, context, prefix):
    with maintenance(case) as connection:
        artist = connection.execute('select artist_id from library.local_albums where id=%s',
                                    (album,)).fetchone()['artist_id']
        root_path = f'/metadata-clock/{case.db.token}/{prefix}'
        root = connection.execute('''insert into library.library_roots(library_id,root_path,metadata)
            values(%s,%s,'{}') returning id''', (library, root_path)).fetchone()['id']
        container = root_path + '/selected'
        source = str(uuid4())
        connection.execute('''insert into library.album_metadata_sources
            (ref,library_id,local_album_id,library_root_id,container_identity,path_flavor,
             capture_builder_version,state,title,artist,year,title_origin,artist_origin)
            values(%s,%s,%s,%s,%s,'posix',1,'active','Clock album','Clock artist',2000,
                   'tag_metadata','tag_metadata')''', (source, library, album, root, container))
        tracks, files = [], []
        for position in (1, 2):
            track = connection.execute('''insert into library.local_tracks
                (library_id,artist_id,album_id,track_key,title,disc_number,track_number,
                 duration_seconds,title_origin,artist_origin)
                values(%s,%s,%s,%s,%s,1,%s,180,'tag_metadata','tag_metadata') returning id''',
                (library, artist, album, f'{case.db.token}:{prefix}:{position}',
                 f'Track {position}', position)).fetchone()['id']
            tracks.append(track)
            files.append(insert_file(connection, track=track, root=root,
                                     path=f'{container}/{position}.flac', source=source))
    top = case.db.service.execute(context, case.db.create_command(refs=[album_ref]))
    item = case.db.service.read(context, top_ref=top['top_ref'])['items'][0]
    return SimpleNamespace(library=library, album=album, album_ref=album_ref, artist=artist,
        root=root, root_path=root_path, container=container, source=source, tracks=tracks,
        files=files, context=context, top_ref=top['top_ref'], selection={
            'item_ref': item['ref'], 'album_ref': album_ref,
            'selected_local_album_id': album, 'selected_source_ref': source})


@pytest.fixture
def case(db):
    case = SimpleNamespace(db=db)
    with maintenance(case) as connection:
        other_library = db.library_for(connection, db.owner)
        other_actor = db.member(connection, db.owner, other_library)
        empty_library = db.library_for(connection, db.owner)
        artist = connection.execute('''insert into library.local_artists(library_id,artist_key,name)
            values(%s,%s,'Clock other artist') returning id''',
            (other_library, db.token + ':other')).fetchone()['id']
        album = connection.execute('''insert into library.local_albums
            (library_id,artist_id,album_key,title,release_year,metadata)
            values(%s,%s,%s,'Clock other album',2000,'{}') returning id''',
            (other_library, artist, db.token + ':other')).fetchone()['id']
    other_context = db.context(other_actor)
    album_ref = db.service.admit_inventory_album(other_context, album_id=album)['album_ref']
    db.album_refs.append(album_ref)
    case.a = seed_edition(case, db.library, db.album_ids[0], db.album_refs[0], db.context(), 'a')
    case.b = seed_edition(case, other_library, album, album_ref, other_context, 'b')
    case.c = empty_library
    case.libraries = [case.a.library, case.b.library, case.c]
    assert case.a.library < case.b.library < case.c
    with runtime(case) as connection:
        expected = migration_text().split('as $$', 1)[1].rsplit('$$;', 1)[0]
        actual = connection.execute('select prosrc from pg_proc where oid=%s::regprocedure',
                                    (FUNCTION,)).fetchone()['prosrc']
        assert actual == expected, 'Apply the exact approved 0135 before this module'
        assert all(value > 0 for value in clocks(case, connection).values())
    yield case


@pytest.mark.parametrize('entry', ['association', 'physical_null_source', 'physical_foreign_source'])
def test_foreign_track_insert_invalidates_each_independent_candidate_owner(case, entry):
    baseline = successful_baseline(case)
    before = clocks(case)
    a, b = case.a, case.b
    with runtime(case) as connection:
        insert_file(connection, track=b.tracks[0],
                    root=b.root if entry == 'association' else a.root,
                    path=(b.container if entry == 'association' else a.container) + '/foreign.flac',
                    source=a.source if entry == 'association' else
                           (b.source if entry == 'physical_foreign_source' else None))
    assert_delta(case, before, {a.library, b.library})
    assert_changed_or_rejected(case, baseline)


@pytest.mark.parametrize('change', [
    'track', 'root', 'source', 'track_root', 'track_source', 'root_source',
    'all', 'null_root', 'null_source', 'null_root_source', 'path_out',
])
def test_old_new_file_dependencies_route_every_owner_without_third_library_bump(case, change):
    baseline = successful_baseline(case)
    before = clocks(case)
    a, b = case.a, case.b
    selected = set(change.split('_'))
    if change == 'all':
        selected = {'track', 'root', 'source', 'path'}
    nulls = change.startswith('null_')
    values = {'track_id': b.tracks[0] if 'track' in selected else a.tracks[0],
              'library_root_id': (None if nulls else b.root) if 'root' in selected else a.root,
              'metadata_source_ref': (None if nulls else b.source) if 'source' in selected else a.source,
              'private_path': b.container + '/moved.flac' if change == 'all' else
                              a.root_path + '/outside/1.flac' if change == 'path_out' else
                              a.container + '/1.flac'}
    with runtime(case) as connection:
        connection.execute('''update library.local_track_files set track_id=%s,library_root_id=%s,
            metadata_source_ref=%s,private_path=%s where id=%s''',
            (*values.values(), a.files[0]))
    affected = {a.library} if nulls or change == 'path_out' else {a.library, b.library}
    assert_delta(case, before, affected)
    assert_changed_or_rejected(case, baseline)


@pytest.mark.parametrize('direction', ['into', 'out_of'])
def test_path_only_crosses_selected_physical_container_with_unchanged_root(case, direction):
    a, b = case.a, case.b
    if direction == 'into':
        with runtime(case) as connection:
            foreign = insert_file(connection, track=b.tracks[0], root=a.root,
                                  path=a.root_path + '/outside/foreign.flac', source=None)
        file_id, path = foreign, a.container + '/foreign.flac'
    else:
        file_id, path = a.files[0], a.root_path + '/outside/1.flac'
    baseline = successful_baseline(case)
    before = clocks(case)
    with runtime(case) as connection:
        old = connection.execute('select library_root_id from library.local_track_files where id=%s',
                                 (file_id,)).fetchone()
        connection.execute('update library.local_track_files set private_path=%s where id=%s',
                           (path, file_id))
        assert connection.execute('select library_root_id from library.local_track_files where id=%s',
                                  (file_id,)).fetchone() == old
    assert_delta(case, before, {a.library, b.library} if direction == 'into' else {a.library})
    assert_changed_or_rejected(case, baseline)


def test_old_root_owner_is_retained_for_unselected_foreign_file_move(case):
    a, b = case.a, case.b
    with runtime(case) as connection:
        file_id = insert_file(connection, track=b.tracks[0], root=a.root,
                              path=a.root_path + '/outside/foreign.flac', source=None)
    baseline = successful_baseline(case)
    before = clocks(case)
    with runtime(case) as connection:
        connection.execute('update library.local_track_files set library_root_id=%s where id=%s',
                           (b.root, file_id))
    # Its current track and NEW root both identify B. Only OLD root supplies A.
    assert_delta(case, before, {a.library, b.library})
    assert_changed_or_rejected(case, baseline)


@pytest.mark.parametrize('parent', ['file', 'track', 'source', 'root', 'artist', 'album'])
def test_real_deletes_and_fk_actions_invalidate_successful_capture(case, parent):
    baseline = successful_baseline(case)
    before = clocks(case)
    a = case.a
    table, identity, key = {
        'file': ('local_track_files', a.files[0], 'id'),
        'track': ('local_tracks', a.tracks[0], 'id'),
        'source': ('album_metadata_sources', a.source, 'ref'),
        'root': ('library_roots', a.root, 'id'),
        'artist': ('local_artists', a.artist, 'id'),
        'album': ('local_albums', a.album, 'id'),
    }[parent]
    # 0110 grants source DELETE; base inventory parent/file DELETE is trusted
    # fixture maintenance. Never broaden runtime grants for a test mutation.
    connector = runtime if parent == 'source' else maintenance
    with runtime(case) as connection:
        allowed = connection.execute('select has_table_privilege(current_user,%s,\'DELETE\') as ok',
                                     ('library.' + table,)).fetchone()['ok']
        assert allowed is (parent == 'source')
    with connector(case) as connection:
        assert connection.execute('select has_table_privilege(current_user,%s,\'DELETE\') as ok',
                                  ('library.' + table,)).fetchone()['ok']
        connection.execute(f'delete from library.{table} where {key}=%s', (identity,))
        files = connection.execute('''select id,library_root_id,metadata_source_ref
            from library.local_track_files where id=any(%s::bigint[]) order by id''', (a.files,)).fetchall()
        if parent in ('file', 'track'):
            assert [row['id'] for row in files] == [a.files[1]]
        elif parent in ('source', 'root', 'album'):
            assert len(files) == 2 and all(row['metadata_source_ref'] is None for row in files)
        if parent == 'root':
            assert all(row['library_root_id'] is None for row in files)
            assert connection.execute('select 1 from library.album_metadata_sources where ref=%s',
                                      (a.source,)).fetchone() is None
        if parent == 'artist':
            assert all(row['artist_id'] is None for row in connection.execute(
                'select artist_id from library.local_tracks where id=any(%s::bigint[])',
                (a.tracks,)).fetchall())
    assert_delta(case, before, {a.library})
    assert_changed_or_rejected(case, baseline)


@pytest.mark.parametrize('change', [
    'track_move', 'track_title', 'track_position', 'track_duration', 'track_origin',
    'artist_name', 'source_header', 'source_state', 'source_container',
    'catalog_remove', 'root_active', 'root_path', 'file_stale', 'album_title',
])
def test_existing_dependency_paths_still_invalidate_or_reject(case, change):
    baseline = successful_baseline(case)
    before = clocks(case)
    a, b = case.a, case.b
    commands = {
        'track_move': ('update library.local_tracks set library_id=%s,album_id=%s,artist_id=%s where id=%s',
                       (b.library, b.album, b.artist, a.tracks[0])),
        'track_title': ('update library.local_tracks set title=%s where id=%s', ('Edited', a.tracks[0])),
        'track_position': ('update library.local_tracks set track_number=7 where id=%s', (a.tracks[0],)),
        'track_duration': ('update library.local_tracks set duration_seconds=181 where id=%s', (a.tracks[0],)),
        'track_origin': ("update library.local_tracks set title_origin='unknown' where id=%s", (a.tracks[0],)),
        'artist_name': ('update library.local_artists set name=%s where id=%s', ('Edited artist', a.artist)),
        'source_header': ('update library.album_metadata_sources set title=%s,year=2001 where ref=%s',
                          ('Edited album', a.source)),
        'source_state': ("update library.album_metadata_sources set state='invalid' where ref=%s", (a.source,)),
        'source_container': ('update library.album_metadata_sources set container_identity=%s where ref=%s',
                             (a.root_path + '/elsewhere', a.source)),
        'catalog_remove': ('delete from library.catalog_album_links where local_album_id=%s', (a.album,)),
        'root_active': ('update library.library_roots set is_active=false where id=%s', (a.root,)),
        'root_path': ('update library.library_roots set root_path=%s where id=%s',
                      (a.root_path + '/elsewhere', a.root)),
        'file_stale': ('''update library.local_track_files set metadata=
                         '{"scan_cache":{"stale":true}}'::jsonb where id=%s''', (a.files[0],)),
        'album_title': ('update library.local_albums set title=%s where id=%s', ('Edited album', a.album)),
    }
    connector = maintenance if change == 'catalog_remove' else runtime
    with connector(case) as connection:
        connection.execute(*commands[change])
    assert_delta(case, before, {a.library, b.library} if change == 'track_move' else {a.library})
    assert_changed_or_rejected(case, baseline)


def test_artist_library_move_is_a_real_forbidden_constraint_not_an_invented_mutation(case):
    baseline = successful_baseline(case)
    before = clocks(case)
    with pytest.raises(psycopg.errors.CheckViolation) as caught:
        with runtime(case) as connection:
            connection.execute('update library.local_artists set library_id=%s where id=%s',
                               (case.b.library, case.a.artist))
    assert caught.value.diag.constraint_name == 'local_artists_library_id_immutable'
    assert clocks(case) == before
    assert capture(case) == baseline


def test_multiple_statements_and_repeated_targets_advance_once_per_xid_then_again_after_commit(case):
    baseline = successful_baseline(case)
    before = clocks(case)
    a, b = case.a, case.b
    with runtime(case) as connection:
        first = insert_file(connection, track=b.tracks[0], root=a.root,
                            path=a.container + '/foreign-1.flac', source=a.source)
        insert_file(connection, track=b.tracks[1], root=a.root,
                    path=a.container + '/foreign-2.flac', source=a.source)
        connection.execute('update library.local_track_files set private_path=%s where id=%s',
                           (a.container + '/foreign-1-renamed.flac', first))
        assert_delta(case, before, {a.library, b.library}, connection=connection)
        xids = connection.execute('''select last_invalidation_xid=pg_current_xact_id() as current_xid
            from library.public_metadata_source_state where library_id=any(%s::bigint[])''',
            ([a.library, b.library],)).fetchall()
        assert len(xids) == 2 and all(row['current_xid'] for row in xids)
    after = assert_delta(case, before, {a.library, b.library})
    assert_changed_or_rejected(case, baseline)
    with runtime(case) as connection:
        connection.execute('update library.local_track_files set private_path=%s where id=%s',
                           (a.container + '/foreign-1-again.flac', first))
    assert_delta(case, after, {a.library, b.library})


def test_rollback_restores_source_rows_generation_and_last_invalidation_xid(case):
    baseline = successful_baseline(case)
    before = clocks(case)
    with maintenance(case) as connection:
        rows = connection.execute('select * from library.local_track_files where id=any(%s::bigint[]) order by id',
                                  (case.a.files,)).fetchall()
        state = connection.execute('select * from library.public_metadata_source_state where library_id=any(%s::bigint[]) order by library_id',
                                   (case.libraries,)).fetchall()
    with runtime(case) as connection:
        connection.execute('update library.local_track_files set metadata_source_ref=%s where id=%s',
                           (case.b.source, case.a.files[0]))
        assert_delta(case, before, {case.a.library, case.b.library}, connection=connection)
        connection.rollback()
    with maintenance(case) as connection:
        assert connection.execute('select * from library.local_track_files where id=any(%s::bigint[]) order by id',
                                  (case.a.files,)).fetchall() == rows
        assert connection.execute('select * from library.public_metadata_source_state where library_id=any(%s::bigint[]) order by library_id',
                                  (case.libraries,)).fetchall() == state
    assert capture(case) == baseline


@pytest.mark.parametrize('change', ['no_op', 'empty_statement', 'irrelevant_file_metadata',
                                   'irrelevant_track_metadata', 'irrelevant_root_metadata'])
def test_unchanged_dependency_projection_keeps_the_clock_and_review(case, change):
    baseline = successful_baseline(case)
    before = clocks(case)
    a = case.a
    commands = {
        'no_op': ('update library.local_track_files set track_id=track_id,private_path=private_path where id=%s',
                  (a.files[0],)),
        'empty_statement': ('update library.local_track_files set private_path=private_path where id=-1', ()),
        'irrelevant_file_metadata': ('''update library.local_track_files set metadata=
            metadata || '{"unrelated_test_note":"changed"}'::jsonb where id=%s''', (a.files[0],)),
        'irrelevant_track_metadata': ('''update library.local_tracks set metadata=
            metadata || '{"unrelated_test_note":"changed"}'::jsonb where id=%s''', (a.tracks[0],)),
        'irrelevant_root_metadata': ('''update library.library_roots set metadata=
            metadata || '{"unrelated_test_note":"changed"}'::jsonb where id=%s''', (a.root,)),
    }
    with runtime(case) as connection:
        connection.execute(*commands[change])
    assert clocks(case) == before
    assert capture(case) == baseline


def function_catalog(connection):
    return connection.execute('''select p.oid,p.proowner,p.proacl,p.prosecdef,p.proconfig,
        p.prorettype,p.proargtypes,p.prolang,p.provolatile,p.proparallel,p.proleakproof,
        p.pronargs,p.prokind from pg_proc p where p.oid=%s::regprocedure''', (FUNCTION,)).fetchone()


def dependencies_catalog(connection):
    return connection.execute('''select p.oid,p.proowner,p.proacl,pg_get_functiondef(p.oid) as definition
        from pg_proc p where p.oid in (
            'library.public_metadata_dependency(text,jsonb)'::regprocedure,
            'library.lock_public_metadata_source(bigint)'::regprocedure,
            'library.public_metadata_container(text,text)'::regprocedure) order by p.oid''').fetchall()


def trigger_catalog(connection):
    return connection.execute('''select t.oid,t.tgrelid,t.tgname,t.tgenabled,t.tgfoid,
        t.tgoldtable,t.tgnewtable,pg_get_triggerdef(t.oid) as definition
        from pg_trigger t join pg_class c on c.oid=t.tgrelid
        join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='library' and c.relname=any(%s::text[])
          and t.tgname like 'metadata_source_%%' order by c.relname,t.tgname''', (list(TABLES),)).fetchall()


def source_rows(case, connection):
    result = {}
    for table in TABLES:
        if table == 'local_track_files':
            sql = '''select to_jsonb(f) as row from library.local_track_files f
                join library.local_tracks t on t.id=f.track_id
                where t.library_id=any(%s::bigint[]) order by f.id'''
        else:
            key = 'id' if table == 'libraries' else 'library_id'
            order = 'ref' if table == 'album_metadata_sources' else 'local_album_id' if table == 'catalog_album_links' else 'id'
            sql = f'select to_jsonb(t) as row from library.{table} t where {key}=any(%s::bigint[]) order by {order}'
        result[table] = connection.execute(sql, (case.libraries,)).fetchall()
    result['clocks'] = connection.execute('''select * from library.public_metadata_source_state
        where library_id=any(%s::bigint[]) order by library_id''', (case.libraries,)).fetchall()
    return result


def test_nonempty_replacement_preserves_every_row_clock_owner_acl_and_trigger(case):
    baseline = successful_baseline(case)
    with maintenance(case) as connection:
        original_rows = source_rows(case, connection)
        original_catalog = function_catalog(connection)
        original_dependencies = dependencies_catalog(connection)
        original_triggers = trigger_catalog(connection)
        assert len(original_triggers) == 4 * len(TABLES)
        assert original_catalog['prosecdef'] is True
        assert original_catalog['proconfig'] == ['search_path=pg_catalog']
        assert len(original_rows['album_metadata_sources']) == 2
        assert len(original_rows['local_track_files']) == 4
        assert all(row['generation'] > 0 for row in original_rows['clocks'])
        # C has an existing nonzero clock but no metadata inventory rows.
        assert all(row['row'].get('library_id') != case.c for row in original_rows['album_metadata_sources'])
        try:
            # Local transaction-only reconstruction of the exact historical
            # body. Do not edit the ledger, grants, fixture or historic file.
            connection.execute(predecessor_function())
            assert function_catalog(connection) == original_catalog
            assert source_rows(case, connection) == original_rows
            connection.execute(migration_text())
            assert function_catalog(connection) == original_catalog
            assert dependencies_catalog(connection) == original_dependencies
            assert trigger_catalog(connection) == original_triggers
            assert source_rows(case, connection) == original_rows
            before = clocks(case, connection)
            insert_file(connection, track=case.b.tracks[0], root=case.a.root,
                        path=case.a.container + '/after-upgrade.flac', source=None)
            assert_delta(case, before, {case.a.library, case.b.library}, connection=connection)
            assert_changed_or_rejected(case, baseline, connection=connection)
        finally:
            # Even a failed assertion cannot leave predecessor DDL or test rows.
            connection.rollback()
    with maintenance(case) as connection:
        assert source_rows(case, connection) == original_rows
        assert function_catalog(connection) == original_catalog
        assert dependencies_catalog(connection) == original_dependencies
        assert trigger_catalog(connection) == original_triggers
    assert capture(case) == baseline


def test_actual_runtime_clock_privileges_and_trusted_trigger_posture(case):
    with runtime(case) as connection:
        role = assert_runtime_role(connection, case.db)
        assert connection.execute('select current_user as name,session_user as login').fetchone() == {
            'name': role, 'login': role}
        assert connection.execute('show session_replication_role').fetchone()['session_replication_role'] == 'origin'
        assert connection.execute("select has_table_privilege(current_user,'library.public_metadata_source_state','SELECT') as ok").fetchone()['ok']
        for privilege in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES'):
            assert connection.execute('select has_table_privilege(current_user,%s,%s) as ok',
                ('library.public_metadata_source_state', privilege)).fetchone()['ok'] is False
        for schema in ('library', 'app', 'catalog'):
            assert connection.execute('select has_schema_privilege(current_user,%s,\'CREATE\') as ok',
                                      (schema,)).fetchone()['ok'] is False
        for function in ('library.public_metadata_dependency(text,jsonb)', FUNCTION):
            assert connection.execute('select has_function_privilege(current_user,%s,\'EXECUTE\') as ok',
                                      (function,)).fetchone()['ok'] is False
        assert connection.execute("select has_function_privilege(current_user,'library.lock_public_metadata_source(bigint)','EXECUTE') as ok").fetchone()['ok']
        assert evidence.source_barrier(connection, case.a.library) > 0
        catalog = function_catalog(connection)
        assert catalog['prosecdef'] and catalog['proconfig'] == ['search_path=pg_catalog']
        assert connection.execute("select pg_has_role(current_user,%s,'USAGE') as owner_member",
                                  (catalog['proowner'],)).fetchone()['owner_member'] is False
        owners = connection.execute('''select c.relname,pg_has_role(current_user,c.relowner,'USAGE') as owns,
            has_table_privilege(current_user,c.oid,'TRIGGER') as trigger_privilege
            from pg_class c join pg_namespace n on n.oid=c.relnamespace
            where n.nspname='library' and c.relname=any(%s::text[])''',
            (list(TABLES) + ['public_metadata_source_state'],)).fetchall()
        assert len(owners) == len(TABLES) + 1
        assert all(not row['owns'] and not row['trigger_privilege'] for row in owners)
        triggers = trigger_catalog(connection)
        assert len(triggers) == 32 and all(row['tgenabled'] == 'O' for row in triggers)
        # Effective privileges of the existing readonly role, no fabricated
        # readonly login or SET ROLE. Its clock access remains completely absent.
        assert connection.execute("select 1 from pg_roles where rolname='album_haven_readonly'").fetchone()
        for privilege in ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'):
            assert connection.execute('select has_table_privilege(%s,%s,%s) as ok',
                ('album_haven_readonly', 'library.public_metadata_source_state', privilege)).fetchone()['ok'] is False
        for function in ('library.public_metadata_dependency(text,jsonb)', FUNCTION,
                         'library.lock_public_metadata_source(bigint)'):
            assert connection.execute('select has_function_privilege(%s,%s,\'EXECUTE\') as ok',
                ('album_haven_readonly', function)).fetchone()['ok'] is False


@pytest.mark.parametrize('operation', ['insert', 'update', 'delete', 'truncate', 'dependency', 'invalidator'])
def test_actual_runtime_direct_clock_and_private_helper_calls_are_denied(case, operation):
    baseline = successful_baseline(case)
    before = clocks(case)
    statements = {
        'insert': ('insert into library.public_metadata_source_state(library_id,generation) values(%s,1)', (case.c,)),
        'update': ('update library.public_metadata_source_state set generation=generation+1 where library_id=%s', (case.a.library,)),
        'delete': ('delete from library.public_metadata_source_state where library_id=%s', (case.a.library,)),
        'truncate': ('truncate library.public_metadata_source_state', ()),
        'dependency': ("select library.public_metadata_dependency('local_tracks','{}'::jsonb)", ()),
        'invalidator': ('select library.invalidate_public_metadata_source()', ()),
    }
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with runtime(case) as connection:
            connection.execute(*statements[operation])
    assert clocks(case) == before
    assert capture(case) == baseline


@pytest.mark.parametrize('table', ['local_track_files', 'library_roots'])
def test_legitimate_admin_truncate_cascade_keeps_surviving_library_clock_semantics(case, table):
    baseline = successful_baseline(case)
    with maintenance(case) as connection:
        initial = source_rows(case, connection)
        all_before = {row['library_id']: row['generation'] for row in connection.execute(
            'select library_id,generation from library.public_metadata_source_state').fetchall()}
        assert connection.execute('select has_table_privilege(current_user,%s,\'TRUNCATE\') as ok',
                                  ('library.' + table,)).fetchone()['ok']
        try:
            connection.execute(f'truncate library.{table} cascade')
            all_after = {row['library_id']: row['generation'] for row in connection.execute(
                'select library_id,generation from library.public_metadata_source_state').fetchall()}
            assert all_after == {library: value + 1 for library, value in all_before.items()}
            assert_changed_or_rejected(case, baseline, connection=connection)
        finally:
            connection.rollback()
    with maintenance(case) as connection:
        assert source_rows(case, connection) == initial
    assert capture(case) == baseline


@dataclass
class Mutation:
    started: Event
    pid: int | None = None


def run_mutation(case, state, sql, params, *, timeout='5s'):
    with runtime(case, lock_timeout=timeout) as connection:
        state.pid = connection.execute('select pg_backend_pid() as pid').fetchone()['pid']
        state.started.set()
        connection.execute(sql, params)
    return True  # Only after the actual transaction committed.


def observed_blocker(case, future, state, blocker_pid, *, seconds=3):
    assert state.started.wait(3), 'Writer never reached its real database connection'
    deadline = monotonic() + seconds
    with maintenance(case) as observer:
        while monotonic() < deadline:
            row = observer.execute('''select pg_blocking_pids(%s) as blockers,
                exists(select 1 from pg_locks where pid=%s and not granted) as waiting''',
                (state.pid, state.pid)).fetchone()
            if blocker_pid in row['blockers'] and row['waiting']:
                assert not future.done()
                return row
            if future.done():
                # Surface its real error (or premature success), never use time
                # elapsed as evidence that it was blocked.
                future.result()
                pytest.fail('Mutation completed before the SHARE barrier was released')
            Event().wait(0.01)  # Scheduling only; pg_locks is the assertion.
    pytest.fail('Did not observe the expected PostgreSQL blocker within the bound')


@pytest.mark.parametrize('release', ['commit', 'rollback', 'writer_timeout'])
def test_share_barrier_blocks_foreign_file_commit_and_failed_writer_rolls_back(case, release):
    baseline = successful_baseline(case)
    before = clocks(case)
    a, b = case.a, case.b
    sql = '''insert into library.local_track_files
        (track_id,library_root_id,private_path,content_signature,metadata_source_ref,metadata)
        values(%s,%s,%s,'blocked-metadata-clock',%s,'{}')'''
    params = (b.tracks[0], a.root, a.container + '/blocked.flac', None)
    state = Mutation(Event())
    with ThreadPoolExecutor(max_workers=1) as pool:
        with runtime(case) as holder:
            assert evidence.source_barrier(holder, a.library) == baseline['generation']
            holder_pid = holder.execute('select pg_backend_pid() as pid').fetchone()['pid']
            future = pool.submit(run_mutation, case, state, sql, params)
            try:
                observed_blocker(case, future, state, holder_pid)
                assert clocks(case) == before  # No partially committed clock/source.
                if release == 'writer_timeout':
                    with pytest.raises(psycopg.errors.LockNotAvailable):
                        future.result(timeout=9)
                elif release == 'commit':
                    holder.commit()
                else:
                    holder.rollback()
            finally:
                holder.rollback()
            if release != 'writer_timeout':
                assert future.result(timeout=9)
    if release == 'writer_timeout':
        assert clocks(case) == before
        assert capture(case) == baseline
        with runtime(case) as connection:
            assert connection.execute('select 1 from library.local_track_files where private_path=%s',
                                      (params[2],)).fetchone() is None
    else:
        assert_delta(case, before, {a.library, b.library})
        # This is the real clock prerequisite to B's stale-review rejection.
        # Token/error behavior belongs to B, not a counterfeit helper here.
        with runtime(case) as fresh:
            assert evidence.source_barrier(fresh, a.library) != baseline['generation']
        assert_changed_or_rejected(case, baseline)


@pytest.mark.parametrize('direction', ['a_to_b', 'b_to_a'])
def test_reverse_old_new_targets_take_lower_clock_before_higher_and_timeout_atomically(case, direction):
    baseline_a = successful_baseline(case)
    baseline_b = successful_baseline(case, case.b)
    before = clocks(case)
    low, high = case.a, case.b
    source, target = (low, high) if direction == 'a_to_b' else (high, low)
    state = Mutation(Event())
    sql = 'update library.local_track_files set metadata_source_ref=%s where id=%s'
    with ThreadPoolExecutor(max_workers=1) as pool:
        with runtime(case) as holder:
            # Holding only the higher metadata row permits a direct observation
            # that the writer has first acquired the lower row in both orders.
            evidence.source_barrier(holder, high.library)
            holder_pid = holder.execute('select pg_backend_pid() as pid').fetchone()['pid']
            future = pool.submit(run_mutation, case, state, sql, (target.source, source.files[0]))
            try:
                observed_blocker(case, future, state, holder_pid)
                with maintenance(case) as observer:
                    with pytest.raises(psycopg.errors.LockNotAvailable):
                        with observer.transaction():
                            observer.execute('''select 1 from library.public_metadata_source_state
                                where library_id=%s for update nowait''', (low.library,))
                with pytest.raises(psycopg.errors.LockNotAvailable):
                    future.result(timeout=9)
            finally:
                holder.rollback()
    assert clocks(case) == before
    assert capture(case) == baseline_a
    assert capture(case, case.b) == baseline_b
    # A clean later transaction must still complete after the bounded failure.
    with runtime(case) as connection:
        connection.execute(sql, (target.source, source.files[0]))
    assert_delta(case, before, {low.library, high.library})
    assert_changed_or_rejected(case, baseline_a)
    assert_changed_or_rejected(case, baseline_b, case.b)


def test_mutation_in_outside_probe_gap_is_seen_by_the_fresh_shared_source_barrier(case):
    baseline = successful_baseline(case)
    with runtime(case) as first_phase:
        original_generation = evidence.source_barrier(first_phase, case.a.library)
    # The first phase is closed, as it must be before S's filesystem probe.
    # No filesystem or PNG surrogate runs here: only the clock gap is tested.
    with runtime(case) as writer:
        insert_file(writer, track=case.b.tracks[0], root=case.b.root,
                    path=case.b.container + '/gap.flac', source=case.a.source)
    with runtime(case) as second_phase:
        assert evidence.source_barrier(second_phase, case.a.library) == original_generation + 1
        assert_changed_or_rejected(case, baseline, connection=second_phase)


def test_independent_target_query_uses_only_three_pk_owner_relations(case, record_property):
    # The same query structure as the dynamic statement, with two actual file
    # OLD/NEW-shaped rows. Explain the true SQL; do not demand index scans on a
    # tiny fixture, where the planner can legitimately choose sequential scans.
    old = {'track_id': case.a.tracks[0], 'library_root_id': case.a.root,
           'metadata_source_ref': case.a.source}
    new = {'track_id': case.b.tracks[0], 'library_root_id': case.a.root,
           'metadata_source_ref': case.b.source}
    query = '''with changed as (select value as r from jsonb_array_elements(%s::jsonb)),
        targets as (
          select t.library_id from changed join library.local_tracks t on t.id=(r->>'track_id')::bigint
          union all
          select r.library_id from changed c join library.library_roots r on r.id=(c.r->>'library_root_id')::bigint
          union all
          select s.library_id from changed join library.album_metadata_sources s on s.ref=(r->>'metadata_source_ref')::uuid
        ) select array_agg(distinct library_id order by library_id) as ids,
                 count(*) as contributions from targets where library_id is not null'''
    with runtime(case) as connection:
        row = connection.execute(query, (Jsonb([old, new]),)).fetchone()
        assert row == {'ids': [case.a.library, case.b.library], 'contributions': 6}
        plan = connection.execute('explain (analyze,buffers,format json) ' + query,
                                  (Jsonb([old, new]),)).fetchone()['QUERY PLAN'][0]
        # A missing track lookup cannot hide the still-existing root/source.
        missing = {'track_id': -1, 'library_root_id': case.a.root, 'metadata_source_ref': case.b.source}
        assert connection.execute(query, (Jsonb([missing]),)).fetchone() == {
            'ids': [case.a.library, case.b.library], 'contributions': 2}
    relations = set()
    def walk(node):
        if 'Relation Name' in node:
            relations.add(node['Relation Name'])
        for child in node.get('Plans', []):
            walk(child)
    walk(plan['Plan'])
    assert relations == {'local_tracks', 'library_roots', 'album_metadata_sources'}
    record_property('metadata_target_explain_json', json.dumps(plan, sort_keys=True))


def test_foreign_track_delete_cascade_keeps_surviving_old_root_owner(case):
    a, b = case.a, case.b
    with runtime(case) as connection:
        file_id = insert_file(connection, track=b.tracks[0], root=a.root,
                              path=a.root_path + '/outside/cascade.flac', source=None)
    baseline = successful_baseline(case)
    before = clocks(case)
    with maintenance(case) as connection:
        connection.execute('delete from library.local_tracks where id=%s', (b.tracks[0],))
        assert connection.execute('select 1 from library.local_track_files where id=%s',
                                  (file_id,)).fetchone() is None
    # The file's track is already gone during its cascaded AFTER DELETE;
    # independently resolving the surviving OLD root must still reach A.
    assert_delta(case, before, {a.library, b.library})
    assert_changed_or_rejected(case, baseline)


def test_foreign_root_delete_set_null_keeps_surviving_source_owner(case):
    a, b = case.a, case.b
    alternate_source = str(uuid4())
    with runtime(case) as connection:
        connection.execute('''insert into library.album_metadata_sources
            (ref,library_id,local_album_id,library_root_id,container_identity,path_flavor,
             capture_builder_version,state,title,artist,year,title_origin,artist_origin)
            values(%s,%s,%s,%s,%s,'posix',1,'active','Alternate','Artist',2000,
                   'tag_metadata','tag_metadata')''',
            (alternate_source, a.library, a.album, a.root, a.root_path + '/unselected'))
        file_id = insert_file(connection, track=b.tracks[0], root=b.root,
                              path=b.container + '/foreign-root-delete.flac', source=alternate_source)
    baseline = successful_baseline(case)
    before = clocks(case)
    with maintenance(case) as connection:
        connection.execute('delete from library.library_roots where id=%s', (b.root,))
        row = connection.execute('select library_root_id,metadata_source_ref from library.local_track_files where id=%s',
                                 (file_id,)).fetchone()
        assert row['library_root_id'] is None and str(row['metadata_source_ref']) == alternate_source
    # Track belongs to B; deleted root B cannot resolve. Only surviving source
    # A supplies A. This unrelated A source does not spoil baseline A capture.
    assert_delta(case, before, {a.library, b.library})
    assert_changed_or_rejected(case, baseline)


def test_distinct_track_root_source_owners_are_all_included(case):
    a, b = case.a, case.b
    with maintenance(case) as connection:
        root_c = connection.execute('''insert into library.library_roots(library_id,root_path,metadata)
            values(%s,%s,'{}') returning id''',
            (case.c, f'/metadata-clock/{case.db.token}/c')).fetchone()['id']
        untouched = case.db.library_for(connection, case.db.owner)
    case.libraries.append(untouched)
    baseline = successful_baseline(case)
    before = clocks(case)
    with runtime(case) as connection:
        insert_file(connection, track=b.tracks[0], root=root_c,
                    path=f'/metadata-clock/{case.db.token}/c/foreign.flac', source=a.source)
    assert_delta(case, before, {a.library, b.library, case.c})
    assert_changed_or_rejected(case, baseline)
