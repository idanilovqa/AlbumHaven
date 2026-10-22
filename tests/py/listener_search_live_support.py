"""LS-B1 source-only acceptance support; execution needs separate admission.

All authority, receipt, preference and inventory owners remain real. The only
instrumentation below observes actual connections or narrows the real policy.
Every mutable row belongs to the imported function-scoped ledger fixture.
"""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import replace
import os
from pathlib import Path
from threading import Event, Lock
import time

import psycopg
from psycopg.rows import dict_row
import pytest
from starlette.datastructures import QueryParams

from music_app.services.private_listener_search_postgres import PostgresListenerSearch
from music_app.services.private_search_contract import normalize_private_search_request, PrivateSearchError
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.e2e.support import isolatedPostgres
from tests.py.test_home_activity_postgres_integration import NOW, mutable_ledger, expire_session_with_database_clock
from tests.py.test_friend_home_activity import social_ledger
from tests.py.test_activity_native_targets_postgres import native_activity
from tests.py.test_listener_search_postgres_integration import context_for, profile, add_history_rows

CONTEXT_REF = 'a' * 64
SECRET = 'listener-live-source-only-contract-secret-20261018'


@pytest.fixture(scope='module')
def database_urls():
    setup, app = isolatedPostgres.resolve_isolated_database_urls({
        isolatedPostgres.SETUP_DATABASE_ENV: os.environ.get('DATABASE_MIGRATOR_URL', ''),
        isolatedPostgres.RUNTIME_DATABASE_ENV: os.environ.get('ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL', ''),
    })
    assert os.environ.get('PGPASSFILE') and Path(os.environ['PGPASSFILE']).is_file()
    with psycopg.connect(app, row_factory=dict_row) as con:
        isolatedPostgres._assert_connected_role(con, isolatedPostgres.RUNTIME_ROLE)
        row = con.execute("""select not exists(select 1 from pg_roles
            where pg_has_role(current_user,oid,'MEMBER') and
            (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)) as safe,
            not pg_has_role(current_user,'album_haven_migrator','MEMBER') as not_migrator""").fetchone()
        assert row == {'safe': True, 'not_migrator': True}
        assert con.execute("""select count(*) as n from information_schema.columns where
            table_schema='app' and table_name='activity_source_revisions' and column_name='love_revision'""").fetchone()['n'] == 1
    with psycopg.connect(setup, row_factory=dict_row) as con:
        isolatedPostgres._assert_connected_role(con, isolatedPostgres.SETUP_ROLE)
    isolatedPostgres.assert_runtime_grants(app)
    return app, setup


def runtime_connect(url):
    return psycopg.connect(url, row_factory=dict_row)


def request(state, *, subject=None, suffix='', query=None, cursor=None, limit=100):
    subject = state['actor'].account_id if subject is None else subject
    query = '@' + profile(state['db'], subject)['username_normalized'] + suffix if query is None else query
    pairs = [('q', query), ('search_page_size', str(limit))]
    if cursor is not None:
        pairs.append(('search_cursor', cursor))
    return normalize_private_search_request(QueryParams(pairs))


def service(state, *, connect=None):
    return PostgresListenerSearch(state['db'].config, connect=connect, clock=lambda: NOW)


def read(state, *, constraints=None, connect=None, context=None, context_ref=CONTEXT_REF, **kwargs):
    return service(state, connect=connect).read_live(context or context_for(state['actor']),
        request=request(state, **kwargs), context_ref=context_ref, cursor_secret=SECRET, constraints=constraints)


def native(state, result, *, operation='bindings', selected=None, intent='metadata',
           target_kind=None, constraints=None, context=None, connect=None):
    owner = service(state, connect=connect)
    refs = [r['id'] for r in result['tracks']] if selected is None else selected
    args = dict(result_token=result['native']['result_token'], context_ref=CONTEXT_REF,
                cursor_secret=SECRET, constraints=constraints)
    ctx = context or context_for(state['actor'])
    if operation == 'bindings':
        return owner.project_live_bindings(ctx, row_refs=refs, **args)
    if operation == 'single':
        return owner.resolve_live_target(ctx, row_ref=refs[0], intent=intent, target_kind=target_kind, **args)
    return owner.resolve_live_targets(ctx, row_refs=refs, intent=intent, **args)


def seed_preference(state, track, *, account=None, love='loved', rating=None, key=None, library='current', track_id=None):
    with state['db'].connect() as con:
        return con.execute("""insert into app.track_preferences
            (account_id,library_id,track_key,track_id,love_tier,rating)
            values(%s,%s,%s,%s,%s,%s) returning id""",
            (state['actor'].account_id if account is None else account,
             state['data']['library'] if library == 'current' else library,
             track['key'] if key is None else key, track_id, love, rating)).fetchone()['id']


def revision(state, account=None):
    with state['db'].connect() as con:
        row = con.execute('select revision,love_revision from app.activity_source_revisions where library_id=%s and account_id=%s',
            (state['data']['library'], state['actor'].account_id if account is None else account)).fetchone()
    return row


def error(status, operation, code=None):
    with pytest.raises(PrivateSearchError) as caught:
        operation()
    assert caught.value.status_code == status
    if code is not None:
        assert caught.value.code == code
    assert 'synthetic-private' not in str(caught.value) and 'postgresql://' not in str(caught.value)
    return caught.value


def deny(action, *, track=None, target=None):
    def constraints(ctx):
        blocked = ctx.action == action
        if track is not None:
            blocked = blocked and ctx.resource is not None and ctx.resource.resource_kind == 'track' and ctx.resource.resource_ref == str(track)
        if target is not None:
            blocked = blocked and ctx.target_account_id == target
        return PolicyEvaluationConstraints(request_origin_allowed=not blocked)
    return constraints


class Connections:
    """Real runtime leases, retained references only for assertions/cancellation."""
    def __init__(self):
        self.items = []
        self.events = []
        self.lock = Lock()

    @contextmanager
    def __call__(self, url):
        con = runtime_connect(url)
        with self.lock:
            self.items.append(con)
            self.events.append(('open', con.info.backend_pid))
        pid = con.info.backend_pid
        try:
            with con:
                yield con
        finally:
            self.events.append(('close', pid))
            con.close()

    def cancel(self):
        for con in tuple(self.items):
            if not con.closed:
                con.cancel()


class Workers:
    """Owned threads always drained; barriers released and live SQL cancelled on failure."""
    def __init__(self):
        self.pool = ThreadPoolExecutor(max_workers=3)
        self.connections = Connections()
        self.releases = []

    def __enter__(self):
        return self

    def barrier(self):
        entered, release = Event(), Event()
        self.releases.append(release)
        def pause():
            entered.set()
            assert release.wait(15), 'Owner did not release barrier'
        return entered, release, pause

    def start(self, operation):
        return self.pool.submit(operation)

    def __exit__(self, kind, value, traceback):
        for release in self.releases:
            release.set()
        if kind is not None:
            self.connections.cancel()
        self.pool.shutdown(wait=True, cancel_futures=True)


def observe_blocker(db, blocked_pid, blocker_pid):
    """Poll a PostgreSQL lock fact; elapsed time is never proof of blocking."""
    deadline = time.monotonic() + 8
    with db.connect() as con:
        con.autocommit = True
        while time.monotonic() < deadline:
            row = con.execute('select pg_blocking_pids(%s) as blockers', (blocked_pid,)).fetchone()
            if blocker_pid in row['blockers']:
                return
            time.sleep(.01)
    pytest.fail('Expected PostgreSQL blocker edge was not observed')


def assert_wire(result):
    assert set(result) == {'status','private_search','contract_version','context_ref','query','criteria','presentation','listener','tracks','page','history','native'}
    assert result['status'] == 'ready' and result['private_search'] is True
    assert result['contract_version'] == 'listener-search-v1'
    assert set(result['listener']) == {'account_ref','username','display_name'}
    assert set(result['page']) == {'limit','returned_count','candidates_examined','has_more','next_cursor','total_matches'}
    assert set(result['history']) == {'expires_at','total_tracks','total_listens','period_label','range_label','coverage'}
    assert set(result['native']) == {'result_token'}
    assert len(result['tracks']) == result['page']['returned_count']
    assert 0 <= result['page']['candidates_examined'] <= 100
    assert (result['page']['next_cursor'] is not None) == result['page']['has_more']
    assert result['history']['coverage']['complete_for_requested_period'] is False
    assert 'complete historical coverage is not known' in result['history']['coverage']['label']
    for row in result['tracks']:
        assert set(row) == {'id','kind','title','artist','album_title','listen_count','last_listened_at','duration_seconds','source_label','source_readable','availability'}
        assert row['kind'] == 'track' and row['source_readable'] is True
    for forbidden in ('synthetic-private', 'private_path', 'canonical_resource', 'track_preference', 'subject_taste'):
        assert forbidden not in repr(result)
