"""Real PostgreSQL contract tests; source-only packet, not execution evidence.

Requires the separately provisioned, exclusive bootstrap test lane. Never applies
migrations, creates roles, resets databases, or manufactures ready evidence.
"""
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from time import monotonic, sleep
from threading import Event

from music_app.services import scan_cache_persistence as scan
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb
import pytest

from music_app.services import relation_projection_postgres as projection
from music_app.services.cache import serialize_relation_views
from tests.py.popularity_search_bootstrap_support import bootstrap_popularity_db, publish_stored


@pytest.fixture
def db(monkeypatch, tmp_path):
    with bootstrap_popularity_db(monkeypatch, tmp_path) as database:
        yield database


def metadata(con, db):
    return deepcopy(con.execute('select metadata from library.libraries where id=%s',
                                (db.library,)).fetchone()['metadata'])


def state(con, db):
    return (
        con.execute('select * from library.relation_alias_endpoint_publications where library_id=%s',
                    (db.library,)).fetchone(),
        con.execute('select * from library.relation_alias_endpoints where library_id=%s order by edge_id',
                    (db.library,)).fetchall(),
    )


def ready(con, db):
    return con.execute('select library.relation_alias_endpoints_ready(%s) as ready',
                       (db.library,)).fetchone()['ready']


def seed(con, db, aliases=None, groups=None):
    value = metadata(con, db)
    views = value['scan_cache']['relation_views']
    views['alias_to_canonical'] = {'Alias': 'Canon'} if aliases is None else aliases
    views['canonical_to_aliases'] = {'Canon': ['Alias']} if groups is None else groups
    publish_stored(con, db.library, value)
    return value


def payload(value):
    cache = value['scan_cache']
    return projection._endpoint_payload(cache['relation_views'], cache['relation_projection'],
                                        cache['relations_last_built'], stored=True)


def replace(con, body):
    return con.execute('select library.replace_relation_alias_endpoints(%s) as status',
                       (Jsonb(body),)).fetchone()['status']


@contextmanager
def rollback_case(con):
    # A real PostgreSQL savepoint, always rolled back even when assertions pass.
    with con.transaction(force_rollback=True):
        yield


def test_all_origins_unicode_empty_groups_and_exact_duplicate_arrays(db):
    with db.connect() as con:
        value = seed(con, db, {'Straße': 'CANON', ' STRASSE ': 'Canon'},
                     {'Canon': ['Straße', 'Straße', ' STRASSE '], 'CANON': [], '空': []})
        header, rows = state(con, db)
        assert ready(con, db)
        assert {r['origin'] for r in rows} == {'alias_to_canonical','canonical_to_aliases','canonical_group'}
        assert header['source_snapshot'] == {k: value['scan_cache']['relation_views'][k]
                                            for k in ('alias_to_canonical','canonical_to_aliases')}
        assert header['source_snapshot']['canonical_to_aliases']['Canon'].count('Straße') == 2
        assert sum(r['raw_alias'] == 'Straße' and r['origin'] == 'canonical_to_aliases' for r in rows) == 1
        assert {r['alias_key'] for r in rows if r['raw_alias'] in ('Straße', ' STRASSE ')} == {'strasse'}
        assert any(r['origin'] == 'canonical_group' and r['raw_alias'] == '空' for r in rows)
        assert [r['edge_id'] for r in rows] == list(range(len(rows)))
        assert header['manifest'] == [{k:r[k] for k in ('edge_id','origin','raw_alias','raw_canonical','alias_key','canonical_key')} for r in rows]
        seed(con, db, {}, {})
        header, rows = state(con, db)
        assert ready(con, db) and header['edge_count'] == 0 and rows == []


@pytest.mark.parametrize('members', [[' z ', 'Z', 'z', ' z '], (' z ', 'Z', 'z'), {' z ', 'Z', 'z'}])
def test_normal_serializer_and_stored_repair_agree(db, members):
    with db.connect() as con:
        value = metadata(con, db)
        views = value['scan_cache']['relation_views']
        views.update(alias_to_canonical={' z ': 'Canon'}, canonical_to_aliases={'Canon':members})
        serialized = serialize_relation_views(views)
        value['scan_cache']['relation_views'] = serialized
        con.execute('update library.libraries set metadata=%s where id=%s', (Jsonb(value), db.library))
        cache = value['scan_cache']
        assert projection.replace_relation_alias_endpoints_in_transaction(con, views,
            metadata=cache['relation_projection'], relations_last_built=cache['relations_last_built']) == 'ready'
        normal, _ = state(con, db)
        # Set iteration tie order is accepted only if the actual persisted maps agree.
        assert ready(con, db)
        publish_stored(con, db.library, value)
        repaired, _ = state(con, db)
        assert normal['source_snapshot'] == repaired['source_snapshot']
        assert normal['manifest'] == repaired['manifest']


@pytest.mark.parametrize('field,value', [
    ('edge_count',None), ('edge_count',True), ('edge_count','3'), ('edge_count',1.5),
    ('edge_count',-1), ('edge_count',100001), ('relations_last_built',None),
    ('relations_last_built',True), ('relations_last_built','NaN'),
    ('reason_code','unsupported_shape'), ('source_snapshot',None),
    ('source_snapshot',[]), ('manifest',None), ('manifest',{}), ('relation_metadata',None),
])
def test_invalid_ready_fields_invalidate_old_ready_atomically(db, field, value):
    with db.connect() as con:
        original = seed(con, db)
        before, _ = state(con, db)
        body = payload(original)
        body[field] = value
        assert replace(con, body) == 'unavailable'
        after, rows = state(con, db)
        assert after['publication_id'] != before['publication_id']
        assert after['status'] == 'unavailable' and rows == [] and not ready(con, db)
        assert after['reason_code'] in ('unsupported_shape','budget_exceeded')
        assert after['source_snapshot'] is None and after['relation_metadata'] is None
        assert after['relations_last_built'] is None and after['manifest'] == [] and after['edge_count'] == 0
        assert metadata(con, db) == original


@pytest.mark.parametrize('field,value', [
    ('edge_id',None), ('edge_id',True), ('edge_id','0'), ('edge_id',0.5),
    ('edge_id',-1), ('edge_id',1), ('origin','unknown'), ('raw_alias',False),
    ('raw_canonical',None), ('alias_key',''), ('canonical_key',42),
    ('raw_alias','x'*4097), ('alias_key','x'*1025), ('extra','field'),
])
def test_strict_manifest_fields_and_budgets(db, field, value):
    with db.connect() as con:
        body = payload(seed(con, db))
        body['manifest'][0][field] = value
        assert replace(con, body) == 'unavailable'
        assert not ready(con, db) and state(con, db)[1] == []


@pytest.mark.parametrize('change', ['missing','extra','bad_uuid','bad_version','bad_status','null_status'])
def test_invalid_envelope_raises_and_preserves_publication(db, change):
    with db.connect() as con:
        body = payload(seed(con, db)); before = state(con, db)
        if change == 'missing': del body['manifest']
        elif change == 'extra': body['library_id'] = db.library
        elif change == 'bad_uuid': body['publication_id'] = 'invalid'
        elif change == 'bad_version': body['endpoint_builder_version'] = 'old'
        elif change == 'null_status': body['status'] = None
        else: body['status'] = 'other'
        with pytest.raises(psycopg.Error):
            with con.transaction(): replace(con, body)
        assert state(con, db) == before and ready(con, db)


@pytest.mark.parametrize('aliases,groups,reason', [
    ({'Alias': 3}, {}, 'unsupported_shape'), ({}, {'Canon':'Alias'}, 'unsupported_shape'),
    ({}, {'Canon':[False]}, 'unsupported_shape'), ({'\0':'Canon'}, {}, 'unsupported_shape'),
    ({'\ud800':'Canon'}, {}, 'unsupported_shape'), ({' ': 'Canon'}, {}, 'unsupported_shape'),
    ({'Straße':'One','STRASSE':'Two'}, {}, 'unsupported_membership'),
    ({'One':'Two'}, {'One':[]}, 'unsupported_membership'),
    ({'x'*4097:'Canon'}, {}, 'budget_exceeded'),
])
def test_python_expected_validation_is_unavailable_not_legacy_failure(db, aliases, groups, reason):
    with db.connect() as con:
        value = seed(con, db); before = metadata(con, db)
        cache = value['scan_cache']; views = deepcopy(cache['relation_views'])
        views.update(alias_to_canonical=aliases, canonical_to_aliases=groups)
        assert projection.replace_relation_alias_endpoints_in_transaction(con, views,
            metadata=cache['relation_projection'], relations_last_built=cache['relations_last_built']) == 'unavailable'
        header, rows = state(con, db)
        assert header['reason_code'] == reason and rows == [] and not ready(con, db)
        assert metadata(con, db) == before


@pytest.mark.parametrize('change', ['array_order','duplicate','empty_group','status','fingerprint','extra_metadata',
                                    'timestamp','missing_structure','missing_row','row_key'])
def test_ready_requires_complete_current_source_metadata_and_rows(db, change):
    with db.connect() as con:
        value = seed(con, db, {'Alias':'Canon','Other':'Canon'}, {'Canon':['Alias','Other','Alias']})
        with rollback_case(con):
            cache = value['scan_cache']
            if change == 'array_order': cache['relation_views']['canonical_to_aliases']['Canon'].reverse(); cache['relation_views']['canonical_to_aliases']['Canon'] = ['Other','Alias','Alias']
            elif change == 'duplicate': cache['relation_views']['canonical_to_aliases']['Canon'].pop()
            elif change == 'empty_group': cache['relation_views']['canonical_to_aliases']['Empty'] = []
            elif change == 'status': cache['relation_projection']['status'] = 'failed'
            elif change == 'fingerprint': cache['relation_projection']['built_from_fingerprint'] = '0'*64
            elif change == 'extra_metadata': cache['relation_projection']['extra_evidence'] = True
            elif change == 'timestamp': cache['relations_last_built'] += 1
            elif change == 'missing_structure': del cache['relation_views']['artists_sidebar']
            elif change == 'missing_row': con.execute('delete from library.relation_alias_endpoints where library_id=%s and edge_id=0', (db.library,))
            elif change == 'row_key': con.execute("update library.relation_alias_endpoints set alias_key='different' where library_id=%s and edge_id=0", (db.library,))
            con.execute('update library.libraries set metadata=%s where id=%s', (Jsonb(value), db.library))
            assert not ready(con, db)
        assert ready(con, db)


@pytest.mark.parametrize('assignment,parameters', [
    ('status=NULL', ()), ('status=%s', ('bogus',)), ('reason_code=%s', ('unsupported_shape',)),
    ('relations_last_built=%s', (float('nan'),)), ('relations_last_built=%s', (float('inf'),)),
    ('manifest=NULL', ()), ('edge_count=NULL', ()), ('source_snapshot=NULL', ()),
])
def test_header_constraints_reject_sql_null_and_nonfinite_ready_evidence(db, assignment, parameters):
    with db.connect() as con:
        seed(con, db); before = state(con, db)
        with pytest.raises(psycopg.IntegrityError):
            with con.transaction():
                con.execute('update library.relation_alias_endpoint_publications set ' + assignment +
                            ' where library_id=%s', (*parameters, db.library))
        assert state(con, db) == before and ready(con, db)


@pytest.mark.parametrize('assignment,parameters', [
    ('edge_id=%s', (-1,)), ('edge_id=%s', (100000,)), ('origin=%s', ('unknown',)),
    ('raw_alias=NULL', ()), ('alias_key=%s', ('',)), ('canonical_key=%s', ('x'*1025,)),
    ('publication_id=%s', (uuid4(),)),
])
def test_row_checks_and_composite_foreign_key(db, assignment, parameters):
    with db.connect() as con:
        seed(con, db); before = state(con, db)
        with pytest.raises(psycopg.IntegrityError):
            with con.transaction():
                con.execute('update library.relation_alias_endpoints set ' + assignment +
                            ' where library_id=%s and edge_id=0', (*parameters, db.library))
        assert state(con, db) == before


@pytest.mark.parametrize('table', ['library.relation_alias_endpoint_publications','library.relation_alias_endpoints'])
@pytest.mark.parametrize('verb', ['INSERT','UPDATE','DELETE','TRUNCATE'])
def test_actual_app_role_direct_dml_denied(db, table, verb):
    with db.app_connect(db.app_url) as con:
        role = con.execute('select current_user as role').fetchone()['role']
        assert role != 'album_haven_migrator'
        assert not con.execute('select has_table_privilege(current_user,%s,%s) as granted',
                               (table, verb)).fetchone()['granted']
        statements = {'INSERT': 'insert into '+table+' select * from '+table+' where false',
                      'UPDATE': 'update '+table+' set library_id=library_id where false',
                      'DELETE': 'delete from '+table+' where false',
                      'TRUNCATE': 'truncate '+table}
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with con.transaction(): con.execute(statements[verb])
        assert ready(con, db)
        # EXECUTE is the actual supported write path for this nonmigrator role.
        assert replace(con, payload(db.baseline)) == 'ready'


def test_function_security_and_effective_readonly_grants(db):
    with db.connect() as con:
        info = con.execute("""select p.prosecdef,p.proconfig,
            not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
                       where a.grantee=0 and a.privilege_type='EXECUTE') as no_public
            from pg_proc p where p.oid='library.replace_relation_alias_endpoints(jsonb)'::regprocedure""").fetchone()
        assert info == {'prosecdef':True, 'proconfig':['search_path=pg_catalog'], 'no_public':True}
        assert not con.execute("select has_function_privilege('album_haven_readonly', 'library.replace_relation_alias_endpoints(jsonb)', 'EXECUTE') as granted").fetchone()['granted']
        for table in ('library.relation_alias_endpoint_publications','library.relation_alias_endpoints'):
            assert con.execute("select has_table_privilege('album_haven_readonly',%s,'SELECT') as granted", (table,)).fetchone()['granted']
            for privilege in ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'):
                assert not con.execute("select has_table_privilege('album_haven_readonly',%s,%s) as granted", (table,privilege)).fetchone()['granted']


@pytest.mark.parametrize('target_case', ['missing','duplicate_target_rejected'])
def test_writer_rejects_unsupported_bootstrap_target_without_touching_owner(db, target_case):
    # Root-approved test-source exception: only this exclusive disposable lane,
    # rollback-only setup transaction, no concurrency and no bootstrap-owner edit.
    with db.connect() as con:
        baseline_identity = con.execute('select * from app.bootstrap_owners order by owner_key').fetchall()
        baseline_libraries = con.execute('select * from library.libraries order by id').fetchall()
        before = state(con, db)
        assert len(baseline_libraries) == 1 and baseline_libraries[0]['id'] == db.library
        assert baseline_libraries[0]['owner_account_id'] == db.bootstrap_owner
        with rollback_case(con):
            if target_case == 'missing':
                con.execute("update library.libraries set name='Endpoint target test' where id=%s", (db.library,))
                assert not ready(con, db)
                with pytest.raises(psycopg.Error, match='unsupported endpoint publication target'):
                    with con.transaction(): replace(con, payload(db.baseline))
            else:
                # 0001 libraries_owner_name_kind_idx makes an ambiguous same-owner
                # target impossible without forbidden schema mutation. Test that
                # actual boundary; do not drop its unique index to fake ambiguity.
                with pytest.raises(psycopg.errors.UniqueViolation):
                    with con.transaction():
                        con.execute("""insert into library.libraries(owner_account_id,name,library_kind,metadata)
                            values(%s,'Local Library','local','{}'::jsonb)""", (db.bootstrap_owner,))
                assert ready(con, db)
            assert state(con, db) == before
        assert con.execute('select * from app.bootstrap_owners order by owner_key').fetchall() == baseline_identity
        assert con.execute('select * from library.libraries order by id').fetchall() == baseline_libraries
        assert state(con, db) == before and ready(con, db)
        assert not con.execute('select library.relation_alias_endpoints_ready(%s) as ready', (-1,)).fetchone()['ready']


def test_normal_shared_publisher_preserves_count_and_expected_unavailable_contract(db):
    with db.connect() as con:
        with rollback_case(con):
            value = metadata(con, db); cache = value['scan_cache']; views = cache['relation_views']
            views.update(alias_to_canonical={'Alias':'Canon'}, canonical_to_aliases={'Canon':['Alias']})
            con.execute('update library.libraries set metadata=%s where id=%s', (Jsonb(value),db.library))
            count = projection.replace_artist_search_projection_in_transaction(con, views,
                metadata=cache['relation_projection'], relations_last_built=cache['relations_last_built'])
            assert count == 2 and ready(con, db)
            previous = state(con, db)[0]['publication_id']
            # Legacy rows support this shape; endpoint membership correctly rejects it.
            views.update(alias_to_canonical={'Alias':'One','ALIAS':'Two'}, canonical_to_aliases={})
            count = projection.replace_artist_search_projection_in_transaction(con, views,
                metadata=cache['relation_projection'], relations_last_built=cache['relations_last_built'])
            assert count == 1
            header, rows = state(con, db)
            assert header['publication_id'] != previous
            assert header['status'] == 'unavailable' and header['reason_code'] == 'unsupported_membership'
            assert rows == [] and metadata(con, db)['scan_cache']['relation_projection']['status'] == 'ready'


def test_unexpected_database_error_rolls_back_legacy_and_endpoint_transaction(db):
    holder = db.connect()
    try:
        original = state(holder, db)
        old_metadata = metadata(holder, db)
        old_search = legacy_search(holder)
        holder.execute('lock table library.relation_alias_endpoint_publications in access exclusive mode')
        with db.app_connect(db.app_url) as con:
            cache = old_metadata['scan_cache']
            views = deepcopy(cache['relation_views'])
            views.update(alias_to_canonical={'Alias':'Canon'}, canonical_to_aliases={'Canon':['Alias']})
            con.execute("set local lock_timeout='250ms'")
            with pytest.raises(projection.AliasEndpointPublicationError) as error:
                with con.transaction():
                    # Actual shared helper replaces legacy rows first. Only the
                    # endpoint table is locked, so timeout is inside its endpoint
                    # call, not a role switch or a second standalone publication.
                    projection.replace_artist_search_projection_in_transaction(con, views,
                        metadata=cache['relation_projection'], relations_last_built=cache['relations_last_built'])
            assert str(error.value) == 'Alias endpoint database operation failed.'
            assert error.value.__cause__ is None
            assert legacy_search(con) == old_search
        holder.rollback()
        with db.connect() as con:
            assert state(con, db) == original and metadata(con, db) == old_metadata
            assert legacy_search(con) == old_search
    finally:
        try: holder.rollback()
        finally: holder.close()


def forbid_rebuild(monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail('Endpoint-only readiness must not rebuild or rewrite legacy projections')
    for name in ('load_relation_source_rows_sql','build_relation_views_from_postgres_rows',
                 'replace_artist_family_projection_in_transaction','replace_artist_search_projection_in_transaction',
                 '_persist_failed_projection_status'):
        monkeypatch.setattr(projection, name, forbidden)


def test_first_healthy_branch_repairs_missing_then_is_idempotent_without_rebuild(db, monkeypatch):
    with db.connect() as con:
        before = metadata(con, db)
        con.execute('delete from library.relation_alias_endpoint_publications where library_id=%s', (db.library,))
    forbid_rebuild(monkeypatch)
    result = projection.ensure_relation_projection_ready(db.config, connect=db.app_connect)
    assert result['ready'] and not result['startup_rebuilt'] and result['rebuild_reason'] == 'healthy'
    with db.connect() as con:
        assert ready(con, db); repaired = state(con, db)
        assert metadata(con, db) == before
    projection.ensure_relation_projection_ready(db.config, connect=db.app_connect)
    with db.connect() as con:
        assert state(con, db) == repaired and metadata(con, db) == before


@pytest.mark.parametrize('mode', ['shared_browse','transaction_readonly','readonly_role'])
def test_healthy_readonly_paths_do_not_initialize_or_rebuild(db, monkeypatch, mode):
    with db.connect() as con:
        before = metadata(con, db)
        con.execute('delete from library.relation_alias_endpoint_publications where library_id=%s', (db.library,))
    forbid_rebuild(monkeypatch)
    config = dict(db.config)
    if mode == 'shared_browse': config['SHARED_LIBRARY_BROWSE_ONLY'] = True
    def connector(url):
        con = db.app_connect(db.readonly_url if mode == 'readonly_role' else url)
        if mode == 'transaction_readonly': con.execute('set transaction read only')
        return con
    result = projection.ensure_relation_projection_ready(config, connect=connector)
    assert result['ready'] and not result['startup_rebuilt']
    with db.connect() as con:
        assert not ready(con, db) and state(con, db) == (None, [])
        assert metadata(con, db) == before


def test_second_healthy_under_advisory_branch_repairs_only_endpoints(db, monkeypatch):
    with db.connect() as con:
        healthy = metadata(con, db); stale = deepcopy(healthy)
        stale['scan_cache']['relation_projection']['status'] = 'stale'
        con.execute('update library.libraries set metadata=%s where id=%s', (Jsonb(stale),db.library))
        con.execute('delete from library.relation_alias_endpoint_publications where library_id=%s', (db.library,))
    calls = 0
    actual_publisher = projection.replace_artist_search_projection_in_transaction
    def connector(url):
        nonlocal calls
        calls += 1
        if calls == 2:
            # A real independent committed publisher wins after the first read.
            # This changes actual DB state, never fabricates a cursor/readiness result.
            with db.connect() as con:
                con.execute(projection.relation_projection_advisory_lock_sql())
                con.execute('update library.libraries set metadata=%s where id=%s', (Jsonb(healthy),db.library))
                cache = healthy['scan_cache']
                actual_publisher(con, cache['relation_views'], metadata=cache['relation_projection'],
                                 relations_last_built=cache['relations_last_built'])
                # Simulate a separately missing endpoint artifact, never a fake ready one.
                con.execute('delete from library.relation_alias_endpoint_publications where library_id=%s', (db.library,))
        return db.app_connect(url)
    def forbidden(*args, **kwargs): pytest.fail('Healthy-under-lock branch rewrote legacy publication')
    for name in ('replace_artist_family_projection_in_transaction','replace_artist_search_projection_in_transaction','_persist_failed_projection_status'):
        monkeypatch.setattr(projection, name, forbidden)
    result = projection.ensure_relation_projection_ready(db.config, connect=connector)
    assert calls >= 4 and result['ready'] and not result['startup_rebuilt']
    with db.connect() as con:
        assert ready(con, db) and metadata(con, db) == healthy


def wait_for_lock_wait(db, pid, blocker_pid):
    deadline = monotonic() + 5
    while monotonic() < deadline:
        with db.connect() as observer:
            # pg_stat_activity hides other-role wait details. Observe the exact
            # table lock and holder edge without expanding fixture privileges.
            row = observer.execute("""select exists (
                select 1 from pg_locks where pid=%s and locktype='relation'
                  and relation='library.relation_alias_endpoint_publications'::regclass
                  and not granted) as waiting, pg_blocking_pids(%s) as blockers""",
                (pid, pid)).fetchone()
        if row['waiting'] and blocker_pid in row['blockers']: return
        sleep(.02)
    pytest.fail('Writer did not reach its real PostgreSQL lock wait')


def test_cancelled_endpoint_writer_rolls_back_and_never_publishes_unavailable(db):
    # Register BOTH connections before starting any potentially blocking work.
    holder = db.connect(); writer = db.app_connect(db.app_url)
    pool = ThreadPoolExecutor(max_workers=1)
    future = None
    try:
        before = state(holder, db)
        body = metadata(holder, db)['scan_cache']
        old_search = holder.execute('select * from library.local_artist_search_projection order by library_id,normalized_artist_key').fetchall()
        holder.execute('lock table library.relation_alias_endpoint_publications in access exclusive mode')
        views = deepcopy(body['relation_views'])
        views.update(alias_to_canonical={'Alias':'Canon'},canonical_to_aliases={'Canon':['Alias']})
        pid = writer.info.backend_pid
        def work():
            with writer:
                return projection.replace_artist_search_projection_in_transaction(writer,
                    views, metadata=body['relation_projection'],
                    relations_last_built=body['relations_last_built'])
        future = pool.submit(work)
        wait_for_lock_wait(db, pid, holder.info.backend_pid)
        writer.cancel()
        with pytest.raises(InterruptedError, match='Alias endpoint operation cancelled'):
            future.result(timeout=5)
        holder.rollback()
        with db.connect() as con:
            assert state(con, db) == before and ready(con, db)
            assert con.execute('select * from library.local_artist_search_projection order by library_id,normalized_artist_key').fetchall() == old_search
    finally:
        # A timed-out Future is not a drained worker, even if its connection is
        # closed. Quarantine is sticky and blocks fixture cleanup/lane release.
        terminal = future is None
        try:
            try:
                if future is not None and not future.done(): writer.cancel()
            finally:
                try: holder.rollback()
                finally: holder.close()
            if future is not None:
                try: future.result(timeout=20)
                except (InterruptedError, psycopg.Error): pass
                terminal = future.done()
        except BaseException:
            db.quarantine('worker_drain_unproved')
            raise
        finally:
            if future is not None and not future.done():
                db.quarantine('worker_drain_unproved')
            try:
                if not terminal and not writer.closed: writer.cancel()
            finally:
                try:
                    writer.close()
                except BaseException:
                    db.quarantine('cleanup_unproved')
                    raise
                finally:
                    # Nonblocking executor teardown is NOT evidence of worker
                    # termination; only the terminal Future above establishes it.
                    pool.shutdown(wait=False, cancel_futures=True)


@pytest.mark.parametrize('change', ['source_extra','alias_scalar','canonical_scalar','canonical_null_member',
                                    'missing_origin','missing_group','duplicate_row','gap','membership'])
def test_sql_validator_rejects_incomplete_or_contradictory_exact_manifest(db, change):
    with db.connect() as con:
        body = payload(seed(con, db))
        if change == 'source_extra': body['source_snapshot']['extra'] = {}
        elif change == 'alias_scalar': body['source_snapshot']['alias_to_canonical']['Alias'] = 12
        elif change == 'canonical_scalar': body['source_snapshot']['canonical_to_aliases']['Canon'] = 'Alias'
        elif change == 'canonical_null_member': body['source_snapshot']['canonical_to_aliases']['Canon'] = [None]
        elif change in ('missing_origin','missing_group'):
            removed_origin = 'canonical_group' if change == 'missing_group' else 'alias_to_canonical'
            body['manifest'] = [row for row in body['manifest'] if row['origin'] != removed_origin]
            for index,row in enumerate(body['manifest']): row['edge_id'] = index
            body['edge_count'] = len(body['manifest'])
        elif change == 'duplicate_row':
            body['manifest'].append(deepcopy(body['manifest'][-1]))
            body['manifest'][-1]['edge_id'] = len(body['manifest'])-1
            body['edge_count'] += 1
        elif change == 'gap': body['manifest'][-1]['edge_id'] += 1
        else:
            # Same raw endpoint receives conflicting trusted keys across origins.
            body['manifest'][0]['alias_key'] = 'other'
        assert replace(con, body) == 'unavailable'
        header, rows = state(con, db)
        assert header['reason_code'] == ('unsupported_membership' if change == 'membership' else 'unsupported_shape')
        assert rows == [] and not ready(con, db)


@contextmanager
def initialized_legacy_projection(db, aliases, groups):
    # Only this test's dedicated metadata/projection is changed, then restored
    # through the actual normal writer, not a synthetic ready header.
    with db.connect() as con:
        original = metadata(con, db)
        changed = deepcopy(original); cache = changed['scan_cache']
        cache['relation_views'].update(alias_to_canonical=aliases, canonical_to_aliases=groups)
        con.execute('update library.libraries set metadata=%s where id=%s', (Jsonb(changed), db.library))
        projection.replace_artist_search_projection_in_transaction(con, cache['relation_views'],
            metadata=cache['relation_projection'], relations_last_built=cache['relations_last_built'])
    try:
        yield changed
    finally:
        with db.connect() as con:
            cache = original['scan_cache']
            con.execute('update library.libraries set metadata=%s where id=%s', (Jsonb(original), db.library))
            projection.replace_artist_search_projection_in_transaction(con, cache['relation_views'],
                metadata=cache['relation_projection'], relations_last_built=cache['relations_last_built'])


@pytest.mark.parametrize('reverse', [False, True])
@pytest.mark.parametrize('origin', ['aliases', 'groups'])
def test_case_colliding_legacy_alias_winner_survives_jsonb_order(db, reverse, origin):
    pairs = [('Alias', 'One'), ('ALIAS', 'Two')]
    if reverse:
        pairs.reverse()
    aliases, groups = dict(pairs), {}
    expected = [{'normalized_artist_key': 'alias', 'canonical_artist_name': 'Two'}]
    if origin == 'groups':
        pairs = [('Alpha', ['Shared']), ('ALPHA', ['Shared'])]
        if reverse:
            pairs.reverse()
        aliases, groups = {}, dict(pairs)
        expected = [{'normalized_artist_key': key, 'canonical_artist_name': 'ALPHA'}
                    for key in ('alpha', 'shared')]
    with initialized_legacy_projection(db, aliases, groups) as original:
        cache = original['scan_cache']
        assert projection._artist_search_projection_rows(cache['relation_views']) == expected
        with db.connect() as con:
            stored = metadata(con, db)['scan_cache']['relation_views']
            assert projection._artist_search_projection_rows(stored) == expected
        result = projection.ensure_relation_projection_ready(db.config, connect=db.app_connect)
        assert result['ready'] and not result['startup_rebuilt']
        with db.connect() as con:
            assert metadata(con, db) == original
            header, rows = state(con, db)
            if origin == 'aliases':
                assert header['reason_code'] == 'unsupported_membership' and rows == []
            else:
                assert header['status'] == 'ready' and ready(con, db)


@pytest.mark.parametrize('unsupported', [False, True])
def test_healthy_repairs_stale_or_expected_unsupported_without_global_failure(db, monkeypatch, unsupported):
    aliases = {'Alias':'One','ALIAS':'Two'} if unsupported else {'Alias':'Canon'}
    groups = {} if unsupported else {'Canon':['Alias']}
    with initialized_legacy_projection(db, aliases, groups) as original:
        with db.connect() as con:
            if unsupported:
                con.execute('delete from library.relation_alias_endpoint_publications where library_id=%s', (db.library,))
            else:
                con.execute("update library.relation_alias_endpoints set alias_key='stale' where library_id=%s and edge_id=0", (db.library,))
            assert not ready(con, db)
            legacy_before = con.execute('select * from library.local_artist_search_projection order by library_id,normalized_artist_key').fetchall()
        # Restrict sentinels to this inner context so real cleanup remains available.
        with monkeypatch.context() as patch:
            forbid_rebuild(patch)
            result = projection.ensure_relation_projection_ready(db.config, connect=db.app_connect)
        assert result['ready'] and not result['startup_rebuilt']
        with db.connect() as con:
            header, rows = state(con, db)
            assert metadata(con, db) == original
            assert con.execute('select * from library.local_artist_search_projection order by library_id,normalized_artist_key').fetchall() == legacy_before
            assert ready(con, db) is (not unsupported)
            if unsupported:
                assert header['reason_code'] == 'unsupported_membership' and rows == []
            else:
                assert header['status'] == 'ready'


def test_endpoint_only_repair_database_timeout_propagates_without_global_failure(db, monkeypatch):
    with db.connect() as con:
        before = metadata(con, db)
        con.execute('delete from library.relation_alias_endpoint_publications where library_id=%s', (db.library,))
    forbid_rebuild(monkeypatch)
    # Table wait happens inside endpoint readiness SQL, after actual healthy
    # legacy reads. All connections are registered before blocking execution.
    holder = db.connect()
    holder.execute('lock table library.relation_alias_endpoint_publications in access exclusive mode')
    opened = []
    def connector(url):
        con = db.app_connect(url)
        opened.append(con)
        con.execute("set local lock_timeout='250ms'")
        return con
    try:
        with pytest.raises(projection.AliasEndpointPublicationError, match='Alias endpoint database operation failed'):
            projection.ensure_relation_projection_ready(db.config, connect=connector)
    finally:
        for con in opened:
            if not con.closed: con.cancel(); con.rollback(); con.close()
        holder.rollback(); holder.close()
    with db.connect() as con:
        assert metadata(con, db) == before
        assert state(con, db) == (None, [])
        assert con.execute('select count(*) as n from library.local_artist_search_projection where library_id=%s', (db.library,)).fetchone()['n'] == 0


@pytest.mark.parametrize('field,value', [('reason_code',None),('reason_code','unknown'),
    ('manifest',[{}]),('edge_count',True),('source_snapshot',{}),('relation_metadata',{}),
    ('relations_last_built',0)])
def test_unavailable_envelope_must_be_sanitized_and_exact(db, field, value):
    with db.connect() as con:
        seed(con, db); before = state(con, db)
        body = projection._endpoint_payload(None, None, None)
        body[field] = value
        with pytest.raises(psycopg.Error, match='invalid endpoint unavailable envelope'):
            with con.transaction(): replace(con, body)
        assert state(con, db) == before and ready(con, db)


@pytest.mark.parametrize('members', [('Alias',), {'Alias'}, {'Alias':True}, 'Alias', None])
def test_stored_repair_requires_actual_json_array_not_general_iterable(db, members):
    with db.connect() as con:
        value = seed(con, db); cache = value['scan_cache']
        cache['relation_views']['canonical_to_aliases']['Canon'] = members
        assert projection.replace_relation_alias_endpoints_in_transaction(con, cache['relation_views'],
            metadata=cache['relation_projection'], relations_last_built=cache['relations_last_built'], stored=True) == 'unavailable'
        header, rows = state(con, db)
        assert header['reason_code'] == 'unsupported_shape' and rows == []


def legacy_search(con):
    return con.execute('select * from library.local_artist_search_projection order by library_id,normalized_artist_key').fetchall()


def legacy_state(con):
    return (legacy_search(con), con.execute(
        'select l.* from library.local_artist_family_links l order by to_jsonb(l)::text').fetchall())


def assert_endpoint_matches_committed_source(con, db):
    current = metadata(con, db)['scan_cache']
    header, rows = state(con, db)
    assert ready(con, db) and header['status'] == 'ready'
    assert header['source_snapshot'] == {key: current['relation_views'][key]
        for key in ('alias_to_canonical','canonical_to_aliases')}
    assert header['relation_metadata'] == current['relation_projection']
    assert header['relations_last_built'] == current['relations_last_built']
    assert header['manifest'] == [{key: row[key] for key in
        ('edge_id','origin','raw_alias','raw_canonical','alias_key','canonical_key')} for row in rows]
    assert header['edge_count'] == len(rows)
    return header


@contextmanager
def restore_normal_projections(db):
    with db.connect() as con:
        before = metadata(con, db)
        before_search = legacy_search(con)
    try:
        yield before
    finally:
        # Real normal publishers restore legacy + family + endpoint state.
        # All fixture catalog parents remain recorded by R6 ownership tracking.
        with db.connect() as con:
            cache = before['scan_cache']
            projection.replace_artist_family_projection_in_transaction(con, cache['relation_views'],
                relations_last_built=cache['relations_last_built'])
            projection.replace_artist_search_projection_in_transaction(con, cache['relation_views'],
                metadata=cache['relation_projection'], relations_last_built=cache['relations_last_built'])
            con.execute('update library.libraries set metadata=%s where id=%s', (Jsonb(before),db.library))
            assert metadata(con, db) == before and legacy_search(con) == before_search
            assert_endpoint_matches_committed_source(con, db)


def invoke_real_publisher(con, db, publisher):
    if publisher == 'structural':
        result = scan._commit_structural_relation_projection(con, db.config)
    else:
        cover_revision = scan._load_cover_mutation_revision(con)
        inventory_revision = scan._load_inventory_mutation_revision(con)
        @contextmanager
        def transaction_connection(url):
            assert url == db.app_url
            yield con
        adapter = scan.PostgresScanCacheAdapter(db.config, connect=transaction_connection)
        result = adapter.save_snapshot(db.root_path / 'unused.json', {}, db.token, 1.0,
            separate_release_keys=set(), rebuild_relation_projection=True,
            expected_cover_mutation_revision=cover_revision,
            expected_inventory_mutation_revision=inventory_revision)
    return result


@pytest.mark.parametrize('publisher', ['scan','structural'])
def test_real_scan_and_structural_publishers_bind_serialized_endpoints_atomically(db, publisher):
    # Exercise actual caller SQL, pure builder, serializer, family/search helper
    # and endpoint publication. A real savepoint owns all mutations; no product
    # function or cursor is replaced and no generated catalog parent escapes.
    with db.app_connect(db.app_url) as con:
        before = (metadata(con, db), state(con, db), legacy_state(con))
        with rollback_case(con):
            result = invoke_real_publisher(con, db, publisher)
            header = assert_endpoint_matches_committed_source(con, db)
            assert header['publication_id'] != before[1][0]['publication_id']
            assert serialize_relation_views(result['relation_views']) == metadata(con, db)['scan_cache']['relation_views']
            assert result['relations_last_built'] == header['relations_last_built']
            assert header['relation_metadata']['rebuild_reason'] == (
                'structural_tag_edit' if publisher == 'structural' else 'queued_cache_update')
        assert (metadata(con, db), state(con, db), legacy_state(con)) == before


def test_real_stale_startup_publishes_legacy_and_exact_endpoints(db):
    with restore_normal_projections(db) as original:
        with db.connect() as con:
            previous_id = state(con, db)[0]['publication_id']
            stale = deepcopy(original)
            stale['scan_cache']['relation_projection']['status'] = 'stale'
            con.execute('update library.libraries set metadata=%s where id=%s', (Jsonb(stale),db.library))
        result = projection.ensure_relation_projection_ready(db.config, connect=db.app_connect)
        assert result['ready'] and result['startup_rebuilt']
        with db.connect() as con:
            header = assert_endpoint_matches_committed_source(con, db)
            assert header['publication_id'] != previous_id
            assert header['relation_metadata']['status'] == 'ready'
            assert legacy_search(con)  # Six real fixture tracks feed the real builder.


def prepare_healthy_path(db, path):
    with db.connect() as con:
        healthy = metadata(con, db)
        before_search = legacy_state(con)
        con.execute('delete from library.relation_alias_endpoint_publications where library_id=%s', (db.library,))
        if path == 'second':
            stale = deepcopy(healthy)
            stale['scan_cache']['relation_projection']['status'] = 'stale'
            con.execute('update library.libraries set metadata=%s where id=%s', (Jsonb(stale),db.library))
    return healthy, before_search


def healthy_connector(db, path, healthy, *, mode='writable', opened=None, repair_opened=None):
    calls = []
    def connector(url):
        calls.append(url)
        if path == 'second' and len(calls) == 2:
            # Another committed metadata publication wins after the initial read.
            # Legacy rows were already the healthy baseline throughout. Source
            # loading and pure build still run normally before the advisory recheck.
            with db.connect() as publisher:
                publisher.execute(projection.relation_projection_advisory_lock_sql())
                publisher.execute('update library.libraries set metadata=%s where id=%s',
                                  (Jsonb(healthy),db.library))
        con = db.app_connect(db.readonly_url if mode == 'readonly_role' else url)
        if opened is not None: opened.append(con)
        if mode == 'transaction_readonly': con.execute('set transaction read only')
        if mode == 'timeout': con.execute("set local lock_timeout='250ms'")
        if repair_opened is not None and len(calls) == (2 if path == 'first' else 4):
            repair_opened.append(con)
        return con
    return connector, calls


def forbid_healthy_writes(patch, path):
    if path == 'first':
        forbid_rebuild(patch)
    else:
        def forbidden(*args, **kwargs):
            pytest.fail('Healthy-under-advisory repair must not write legacy/failure metadata')
        for name in ('replace_artist_family_projection_in_transaction',
                     'replace_artist_search_projection_in_transaction','_persist_failed_projection_status'):
            patch.setattr(projection, name, forbidden)


@pytest.mark.parametrize('path', ['first','second'])
@pytest.mark.parametrize('mode', ['readonly_role','transaction_readonly'])
def test_both_healthy_paths_leave_missing_endpoints_untouched_when_readonly(db, monkeypatch, path, mode):
    healthy, before_search = prepare_healthy_path(db, path)
    connector, calls = healthy_connector(db, path, healthy, mode=mode)
    with monkeypatch.context() as patch:
        forbid_healthy_writes(patch, path)
        result = projection.ensure_relation_projection_ready(db.config, connect=connector)
    assert len(calls) == (2 if path == 'first' else 4)
    assert result['ready'] and not result['startup_rebuilt']
    with db.connect() as con:
        assert metadata(con, db) == healthy and legacy_state(con) == before_search
        assert state(con, db) == (None, []) and not ready(con, db)


def test_shared_browse_stale_initial_path_cannot_reach_second_healthy_branch(db):
    healthy, before_search = prepare_healthy_path(db, 'second')
    config = dict(db.config, SHARED_LIBRARY_BROWSE_ONLY=True)
    connector, calls = healthy_connector(db, 'second', healthy)
    try:
        with pytest.raises(RuntimeError, match='Shared browsing cannot rebuild a stale relation projection'):
            projection.ensure_relation_projection_ready(config, connect=connector)
        assert len(calls) == 1
        with db.connect() as con:
            expected = deepcopy(healthy)
            expected['scan_cache']['relation_projection']['status'] = 'stale'
            assert metadata(con, db) == expected and legacy_state(con) == before_search
            assert state(con, db) == (None, [])
    finally:
        with db.connect() as con:
            con.execute('update library.libraries set metadata=%s where id=%s', (Jsonb(healthy),db.library))


@pytest.mark.parametrize('path', ['first','second'])
def test_both_healthy_path_database_errors_preserve_exact_legacy_state(db, monkeypatch, path):
    healthy, before_search = prepare_healthy_path(db, path)
    holder = db.connect()
    try:
        holder.execute('lock table library.relation_alias_endpoint_publications in access exclusive mode')
        connector, calls = healthy_connector(db, path, healthy, mode='timeout')
        with monkeypatch.context() as patch:
            forbid_healthy_writes(patch, path)
            with pytest.raises(projection.AliasEndpointPublicationError) as error:
                projection.ensure_relation_projection_ready(db.config, connect=connector)
        assert str(error.value) == 'Alias endpoint database operation failed.' and error.value.__cause__ is None
        assert len(calls) == (2 if path == 'first' else 4)
    finally:
        try: holder.rollback()
        finally: holder.close()
    with db.connect() as con:
        assert metadata(con, db) == healthy and legacy_state(con) == before_search
        assert state(con, db) == (None, []) and not ready(con, db)


@pytest.mark.parametrize('path', ['first','second'])
def test_both_healthy_path_callback_cancellation_preserves_exact_state(db, monkeypatch, path):
    healthy, before_search = prepare_healthy_path(db, path)
    holder = db.connect()
    opened, repair_connections = [], []
    cancel_requested = Event()
    connector, calls = healthy_connector(db, path, healthy, opened=opened, repair_opened=repair_connections)
    pool = ThreadPoolExecutor(max_workers=1)
    future = None
    terminal = False
    # Keep sentinels installed through drain, including failed observations.
    forbid_healthy_writes(monkeypatch, path)
    try:
        holder.execute('lock table library.relation_alias_endpoint_publications in access exclusive mode')
        future = pool.submit(projection.ensure_relation_projection_ready, db.config,
                             connect=connector, cancel_requested=cancel_requested)
        deadline = monotonic() + 5
        while not repair_connections and monotonic() < deadline:
            if future.done(): future.result()
            sleep(.02)
        assert len(repair_connections) == 1
        wait_for_lock_wait(db, repair_connections[0].info.backend_pid, holder.info.backend_pid)
        # Exercise the readiness API's actual cancellation watcher, rather
        # than manually cancelling the connection as the test stimulus.
        cancel_requested.set()
        with pytest.raises(InterruptedError, match='Relation projection readiness was cancelled'):
            future.result(timeout=5)
        terminal = future.done()
        assert terminal and len(calls) == (2 if path == 'first' else 4)
        holder.rollback()
        with db.connect() as con:
            assert metadata(con, db) == healthy and legacy_state(con) == before_search
            assert state(con, db) == (None, []) and not ready(con, db)
    finally:
        try:
            cancel_requested.set()
            try:
                for con in opened:
                    if not con.closed: con.cancel()
            finally:
                try: holder.rollback()
                finally: holder.close()
            if future is not None:
                try: future.result(timeout=20)
                except (InterruptedError, psycopg.Error): pass
                terminal = future.done()
            else:
                terminal = True
        except BaseException:
            db.quarantine('worker_drain_unproved')
            raise
        finally:
            if not terminal or (future is not None and not future.done()):
                db.quarantine('worker_drain_unproved')
            try:
                for con in opened:
                    if not con.closed: con.close()
            except BaseException:
                db.quarantine('cleanup_unproved')
                raise
            finally:
                pool.shutdown(wait=False, cancel_futures=True)


@pytest.mark.parametrize('publisher', ['scan','structural'])
def test_real_scan_and_structural_endpoint_errors_roll_back_caller_transaction(db, publisher):
    holder = db.connect()
    try:
        before = (metadata(holder, db), state(holder, db), legacy_state(holder))
        holder.execute('lock table library.relation_alias_endpoint_publications in access exclusive mode')
        with db.app_connect(db.app_url) as con:
            con.execute("set local lock_timeout='250ms'")
            with pytest.raises(projection.AliasEndpointPublicationError) as error:
                with rollback_case(con):
                    invoke_real_publisher(con, db, publisher)
            assert str(error.value) == 'Alias endpoint database operation failed.'
            assert error.value.__cause__ is None
            assert metadata(con, db) == before[0] and legacy_state(con) == before[2]
        holder.rollback()
        with db.connect() as con:
            assert (metadata(con, db), state(con, db), legacy_state(con)) == before
    finally:
        try: holder.rollback()
        finally: holder.close()
