"""Owned real PostgreSQL fixtures. Authoring does not authorize execution.

Uses the existing persistent-contract CI database, already migrated. No reset,
TRUNCATE, migration, grant, application bootstrap, provider or media execution.
"""
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
import re
import stat
from pathlib import Path
from threading import Event, Lock, Thread
from types import SimpleNamespace
import time
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
import pytest

from tests.e2e.support import isolatedPostgres
from music_app.services.album_preferences import parse_album_preference_command
from music_app.services.album_preferences_postgres import (
    PostgresAlbumPreferencesStore, load_album_preferences_on_connection,
)
from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from music_app.services.policy import PolicyContext, RequestOrigin
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_library_authority import current_library_transaction


class Connections:
    """Register every finite lease, including preflight and cleanup connections."""
    def __init__(self):
        self.lock = Lock()
        self.items = []
        self.pending = 0
        self.quarantined = False

    def __call__(self, url):
        with self.lock:
            assert not self.quarantined, 'Quarantined fixture cannot acquire connections'
            self.pending += 1
        con = None
        try:
            con = psycopg.connect(url, row_factory=dict_row, connect_timeout=5,
                options='-c statement_timeout=12000 -c lock_timeout=8000 -c idle_in_transaction_session_timeout=15000')
            with self.lock:
                if self.quarantined:
                    con.close()
                    raise RuntimeError('Fixture quarantined during connect')
                self.items.append(con)
            return con
        finally:
            with self.lock:
                self.pending -= 1

    def drained(self):
        with self.lock:
            return self.pending == 0 and all(con.closed for con in self.items)

    def quarantine(self):
        with self.lock:
            self.quarantined = True
        for con in tuple(self.items):
            if not con.closed:
                try:
                    con.cancel_safe(timeout=2)
                except Exception:
                    pass


def lane_context(environ):
    """Closed named admission modes; never infer a major from the server."""
    mode = environ.get('ALBUM_HAVEN_FAVORITES_TEST_MODE', '')
    if mode == '':
        return {'mode': 'persistent14', 'major': 14}
    assert mode in ('favorites_linux17', 'favorites_windows17'), 'Unknown favorites admission mode'
    required = {'GITHUB_ACTIONS': 'true', 'RUNNER_OS': 'Linux',
        'GITHUB_JOB': 'test_feature_batches_linux', 'FEATURE_BATCH': 'favorites_backend'}
    if mode == 'favorites_windows17':
        required = {'GITHUB_ACTIONS': 'true', 'RUNNER_OS': 'Windows', 'GITHUB_JOB': 'test_python'}
    for key, value in required.items():
        assert environ.get(key) == value, 'Wrong hosted favorites identity: '+key
    run, attempt = environ.get('GITHUB_RUN_ID', ''), environ.get('GITHUB_RUN_ATTEMPT', '')
    assert re.fullmatch(r'[1-9][0-9]*', run) and re.fullmatch(r'[1-9][0-9]*', attempt)
    suffix = ('tops_' if mode == 'favorites_linux17' else 'py_contract_')+run+'_'+attempt
    assert len(suffix) <= 35
    database = 'album_haven_ci_'+suffix
    setup_role, app_role = 'album_haven_migrator_'+suffix, 'album_haven_app_'+suffix
    assert max(map(len, (database, setup_role, app_role))) <= 63
    host = '@127.0.0.1:5432/' if mode == 'favorites_linux17' else '@127.0.0.1/'
    setup = 'postgresql://'+setup_role+host+database
    app = 'postgresql://'+app_role+host+database
    assert environ.get('DATABASE_MIGRATOR_URL') == setup
    assert environ.get('DATABASE_APP_URL') == app
    assert environ.get('ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL') == app
    assert 'PGPASSWORD' not in environ, 'PGPASSWORD override is forbidden'
    root = Path(environ.get('RUNNER_TEMP', ''))
    assert root.is_absolute() and root.is_dir() and root == root.resolve(), 'Canonical runner temp required'
    pgpass = root / (database+'.pgpass' if mode == 'favorites_linux17' else 'album-haven-python-combined.pgpass')
    assert environ.get('PGPASSFILE') == str(pgpass)
    if mode == 'favorites_windows17':
        assert environ.get('ALBUM_HAVEN_CI_DATABASE') == database
    return {'mode': mode, 'major': 17, 'database': database,
        'setup_role': setup_role, 'app_role': app_role, 'setup': setup, 'app': app,
        'pgpass': pgpass, 'suffix': suffix, 'root': root,
        'readonly_role': 'album_haven_readonly_'+suffix}


def validate_file_metadata(info, *, symlink, linux_uid=None):
    """Pure facts contract; live admission obtains these facts itself."""
    assert stat.S_ISREG(info.st_mode) and not symlink
    assert not (getattr(info, 'st_file_attributes', 0) & 0x400), 'Reparse point forbidden'
    if linux_uid is not None:
        assert info.st_uid == linux_uid and stat.S_IMODE(info.st_mode) == 0o600
        assert info.st_nlink == 1, 'Private pgpass must not have hard links'


def plain_metadata(path, *, linux=False):
    info = path.lstat()
    validate_file_metadata(info, symlink=path.is_symlink(),
        linux_uid=os.getuid() if linux else None)


def expected_windows_state(context):
    return {'schemaVersion': 1, 'suffix': context['suffix'], 'database': context['database'],
        'roles': {'migrator': context['setup_role'], 'app': context['app_role'],
                  'readonly': context['readonly_role']},
        'pgpass': str(context['root']/('album-haven-postgres-'+context['suffix']+'.pgpass')),
        'host': '127.0.0.1', 'port': 5432}


def validate_windows_state(context, state):
    assert state == expected_windows_state(context), 'Unowned provisioner state'
    assert type(state['schemaVersion']) is int and type(state['port']) is int


def private_pgpass(context):
    # Credential files are metadata-only; only the non-secret provisioner JSON is read.
    plain_metadata(context['pgpass'], linux=context['mode']=='favorites_linux17')
    if context['mode'] == 'favorites_windows17':
        original = Path(expected_windows_state(context)['pgpass'])
        plain_metadata(original)
        state_path = context['root']/'album-haven-python-contract-postgres.state.json'
        plain_metadata(state_path)
        validate_windows_state(context, json.loads(state_path.read_text(encoding='utf-8-sig')))


def assert_lane_connection(context, row, version, role):
    assert int(version) // 10000 == context['major'], 'Exact named-lane major required'
    if context['mode'] in ('favorites_linux17', 'favorites_windows17'):
        assert row == {'database_name': context['database'], 'role_name': context[role+'_role']}


def database_urls():
    context = lane_context(os.environ)
    if context['mode'] in ('favorites_linux17', 'favorites_windows17'):
        private_pgpass(context)
    # Resolver is parsing/admission only; no destructive fixture is invoked.
    setup, app = isolatedPostgres.resolve_isolated_database_urls({
        isolatedPostgres.SETUP_DATABASE_ENV: os.environ.get('DATABASE_MIGRATOR_URL', ''),
        isolatedPostgres.RUNTIME_DATABASE_ENV: os.environ.get('ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL', ''),
    })
    return app, setup


def admit(registry, urls):
    app, setup = urls
    context = lane_context(os.environ)
    assert os.environ.get('PGPASSFILE') and Path(os.environ['PGPASSFILE']).is_file()
    if context['mode'] in ('favorites_linux17', 'favorites_windows17'):
        assert (app, setup) == (context['app'], context['setup'])
        private_pgpass(context)
    with registry(app) as con:
        isolatedPostgres._assert_connected_role(con, isolatedPostgres.RUNTIME_ROLE)
        identity = con.execute('select current_database() as database_name, current_user as role_name').fetchone()
        version = con.execute('show server_version_num').fetchone()['server_version_num']
        assert_lane_connection(context, identity, version, 'app')
        flags = con.execute("""select pg_has_role(current_user,'album_haven_app','USAGE') as app,
            not pg_has_role(current_user,'album_haven_migrator','MEMBER') as limited,
            not exists(select 1 from pg_roles where pg_has_role(current_user,oid,'MEMBER')
              and (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)) as safe""").fetchone()
        assert flags == {'app': True, 'limited': True, 'safe': True}
    with registry(setup) as con:
        isolatedPostgres._assert_connected_role(con, isolatedPostgres.SETUP_ROLE)
        identity = con.execute('select current_database() as database_name, current_user as role_name').fetchone()
        version = con.execute('show server_version_num').fetchone()['server_version_num']
        assert_lane_connection(context, identity, version, 'setup')
        if context['mode'] in ('favorites_linux17', 'favorites_windows17'):
            flags = con.execute("""select pg_has_role(current_user,'album_haven_migrator','USAGE') as migrator,
                not exists(select 1 from pg_roles where pg_has_role(current_user,oid,'MEMBER')
                  and (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)) as safe""").fetchone()
            assert flags == {'migrator': True, 'safe': True}
        migrations = Path(__file__).resolve().parents[2] / 'migrations' / 'postgres'
        expected = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in migrations.glob('*.sql')}
        assert '0141_album_favorites.sql' in expected
        actual = {r['migration_name']: r['checksum'] for r in con.execute(
            'select migration_name,checksum from ops.schema_migrations').fetchall()}
        assert actual == expected, 'Exact pre-migrated composed ledger is required'
    return app, setup


class FavoritesDatabase:
    def __init__(self, registry, urls):
        self.registry = registry
        self.app_url, self.setup_url = urls
        self.config = {'ALBUM_HAVEN_APP_DATABASE_URL': self.app_url}
        self.now = datetime.now(timezone.utc)
        self.clock_time = self.now
        self.token = 'favorites-' + uuid4().hex
        self.library = None
        self.accounts, self.albums = [], []
        self.preference_ids, self.snapshot_ids, self.event_ids = set(), set(), set()
        self.sessions = set()
        self.owner = self.peer = None
        self.workers = []

    def app_connect(self, url):
        assert url in (self.app_url, self.setup_url)
        return self.registry(url)

    def connect(self):
        return self.app_connect(self.setup_url)

    def account(self, con):
        name = self.token + '-' + str(len(self.accounts))
        account = con.execute("""insert into app.accounts(display_name,account_kind,username_display,
            username_normalized,contact_email,contact_email_normalized)
            values(%s,'managed_user',%s,%s,%s,%s) returning id""",
            (name, name, name, name+'@example.test', name+'@example.test')).fetchone()['id']
        self.accounts.append(account)
        session = con.execute("""insert into app.account_sessions(account_id,session_token_hash,
            created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at)
            values(%s,%s,%s,%s,%s,%s,%s) returning id""", (account,
            hashlib.sha256(uuid4().bytes).digest(), self.now, self.now, self.now,
            self.now+timedelta(hours=1), self.now+timedelta(days=1))).fetchone()['id']
        self.sessions.add(session)
        con.execute("insert into integration.lastfm_settings(account_id,timezone_name) values(%s,'UTC')", (account,))
        return CurrentActor(state=ActorState.ACTIVE, account_id=account, session_id=session, authenticated_at=self.now)

    def member(self, capability='capability.view'):
        with self.connect() as con:
            actor = self.account(con)
            con.execute("insert into library.library_memberships(account_id,library_id,membership_role) values(%s,%s,'member')",
                        (actor.account_id, self.library))
            for key in (capability, 'capability.social'):
                con.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,%s,'library',%s)",
                            (actor.account_id, key, self.library))
        return replace(actor, current_library_id=self.library,
            library_relationships=(LibraryRelationship(self.library, 'member', False),),
            capability_grants=tuple(CapabilityGrant(key, 'library', self.library) for key in (capability, 'capability.social')))

    def setup(self):
        with self.connect() as con:
            primary = self.account(con)
            self.library = con.execute('insert into library.libraries(owner_account_id,name) values(%s,%s) returning id',
                (primary.account_id, self.token)).fetchone()['id']
        self.owner, self.peer = self.member(), self.member()
        with self.connect() as con:
            low, high = sorted((self.owner.account_id, self.peer.account_id))
            con.execute("""insert into app.friend_connections(library_id,low_account_id,high_account_id,
                requester_account_id,state,origin) values(%s,%s,%s,%s,'accepted','request')""",
                (self.library, low, high, low))
        self.add_album('initial')

    def add_album(self, suffix):
        from music_app.services.library_inventory_postgres import local_inventory_identity_key
        key = self.token + ':' + suffix
        artist_name = 'Favorite Artist ' + key
        with self.connect() as con:
            artist = con.execute("insert into library.local_artists(library_id,artist_key,name) values(%s,%s,%s) returning id",
                                 (self.library, local_inventory_identity_key(artist_name), artist_name)).fetchone()['id']
            album = con.execute("insert into library.local_albums(library_id,artist_id,album_key,title) values(%s,%s,%s,%s) returning id",
                                (self.library, artist, key, 'Favorite Album '+suffix)).fetchone()['id']
            con.execute("""insert into library.local_album_featured_artists(library_id,album_id,artist_id,featured_kind,metadata)
                values(%s,%s,%s,'owner','{}'::jsonb)""",(self.library,album,artist))
            track = con.execute("""insert into library.local_tracks(library_id,artist_id,album_id,track_key,title,duration_seconds)
                values(%s,%s,%s,%s,'Favorite Track',60) returning id""", (self.library, artist, album, key+':track')).fetchone()['id']
            file = con.execute("""insert into library.local_track_files(track_id,private_path,metadata)
                values(%s,%s,%s) returning id""", (track, '/synthetic-favorites/'+key+'.flac',
                Jsonb({'library_root_category': 'main_library', 'scan_cache': {'stale': False, 'file_entry': {'path': '/synthetic-favorites/'+key+'.flac', 'title': 'Favorite Track', 'album': 'Favorite Album '+suffix, 'album_artist': artist_name, 'artist': artist_name, 'track_number': 1, 'disc_number': 1, 'duration_seconds': 60, 'library_root_category': 'main_library'}}}))).fetchone()['id']
        result = {'id': album, 'key': key, 'artist': artist, 'track': track, 'file': file}
        self.albums.append(result)
        return result

    def add_history(self, album, actor=None):
        assert album in self.albums
        actor = actor or self.peer
        with self.connect() as con:
            event = con.execute("""insert into integration.listen_history(account_id,library_id,track_id,track_key,
                played_at,source_family,source_entry_id,metadata)
                values(%s,%s,%s,%s,%s,'runtime_listen_history_adapter',%s,%s) returning id""",
                (actor.account_id,self.library,album['track'],album['key']+':track',self.now-timedelta(minutes=1),
                 uuid4().hex,Jsonb({'source_payload':{'title':'Favorite Track','album':'Favorite Album',
                     'artist':'Favorite Artist','path':'/synthetic-favorites/'+album['key']+'.flac',
                     'total_listened_seconds':30,'max_contiguous_seconds':30}}))).fetchone()['id']
        self.event_ids.add(event)
        return event

    def context(self, actor=None):
        return PolicyContext.build(actor=actor or self.owner, action='library.browse.read', library_id=self.library,
            deployment_mode='self_hosted', request_origin=RequestOrigin('network', 'synthetic:favorites'),
            client_surface_class='private_web')

    def ref(self, actor=None):
        with self.connect() as con:
            return str(con.execute('select account_ref from app.social_profiles where account_id=%s',
                ((actor or self.peer).account_id,)).fetchone()['account_ref'])

    def patch(self, album, patch, revision=0, *, actor=None, constraints=None, connect=None):
        command = parse_album_preference_command({'album_ref': f'inventory-album:{self.library}:{album["id"]}',
            'expected_revision': revision, 'patch': patch}, library_id=self.library)
        result = PostgresAlbumPreferencesStore(self.config, connect=connect or self.app_connect,
            clock=lambda: self.clock_time).patch_preference(command, context=self.context(actor), constraints=constraints)
        self.preference_ids.add(result['preference_id'])
        return result

    def read(self, album, actor=None):
        with current_library_transaction(self.app_url, self.context(actor), connect=self.app_connect,
                read_only=True, clock=lambda: self.clock_time) as (con, live, _):
            result = load_album_preferences_on_connection(con, account_id=live.actor.account_id,
                library_id=self.library, album_ids=[album['id']])
        return result.get(album['id'])

    def capture_owned_preferences(self, album, actor):
        assert album in self.albums
        allowed = {*self.accounts, getattr(self, 'baseline_account', None)}
        assert actor.account_id in allowed
        with self.connect() as con:
            rows = con.execute('select id from app.album_ratings where account_id=%s and library_id=%s and album_key=%s',
                (actor.account_id, self.library, album['key'])).fetchall()
        assert len(rows) <= 1
        self.preference_ids.update(row['id'] for row in rows)

    def revoke_fixture_view_authority(self, actor=None):
        """Revoke both known case-owned grants that independently imply View."""
        actor = actor or self.owner
        assert actor.account_id in self.accounts, 'Only case-owned accounts may be changed'
        expected = {'capability.view', 'capability.social'}
        with self.connect() as con:
            rows = con.execute("""select capability_key,scope_kind,scope_id from app.capabilities
                where account_id=%s and revoked_at is null for update""",
                (actor.account_id,)).fetchall()
            assert len(rows) == 2 and {row['capability_key'] for row in rows} == expected
            assert all(row['scope_kind'] == 'library' and row['scope_id'] == self.library for row in rows)
            revoked = con.execute("""update app.capabilities set revoked_at=clock_timestamp()
                where account_id=%s and scope_kind='library' and scope_id=%s
                  and revoked_at is null and capability_key=any(%s)
                returning capability_key""",
                (actor.account_id, self.library, sorted(expected))).fetchall()
            assert len(revoked) == 2 and {row['capability_key'] for row in revoked} == expected

    def rows(self):
        with self.connect() as con:
            return [r['data'] for r in con.execute('select to_jsonb(p) as data from app.album_ratings p where library_id=%s order by id',
                (self.library,)).fetchall()]

    def epochs(self, actor=None):
        with self.connect() as con:
            return con.execute('select revision,love_revision,album_taste_revision from app.activity_source_revisions where library_id=%s and account_id=%s',
                (self.library, (actor or self.owner).account_id)).fetchone()

    def seed(self, album, *, actor=None, rating=None, favorite=None):
        with self.connect() as con:
            row = con.execute("""insert into app.album_ratings(account_id,library_id,album_key,rating,favorite,provenance,metadata)
                values(%s,%s,%s,%s,%s,'file_tag_scan',%s) returning id""", ((actor or self.owner).account_id,
                self.library, album['key'], rating, favorite, Jsonb({'retained': ['nested', 7]}))).fetchone()
        self.preference_ids.add(row['id'])
        return row['id']

    def cleanup(self):
        if self.registry.quarantined or not self.registry.drained() or any(w.thread.is_alive() for w in self.workers):
            self.registry.quarantine()
            raise RuntimeError('Unproved drain: fixture quarantined, cleanup prohibited')
        if self.library is None:
            assert not self.accounts, 'Partial setup is quarantined for inspection'
            return
        with self.connect() as con:
            assert con.execute('select name from library.libraries where id=%s', (self.library,)).fetchone()['name'] == self.token
            for table, expected in (('local_albums', {a['id'] for a in self.albums}),
                                    ('local_tracks', {a['track'] for a in self.albums}),
                                    ('local_artists', {a['artist'] for a in self.albums})):
                ids = {r['id'] for r in con.execute('select id from library.'+table+' where library_id=%s', (self.library,)).fetchall()}
                assert ids <= expected, 'Unknown inventory prohibits cleanup'
            ids = {r['id'] for r in con.execute('select id from app.album_ratings where library_id=%s', (self.library,)).fetchall()}
            assert ids <= self.preference_ids, 'Unknown preference prohibits cleanup'
            files = {r['id'] for r in con.execute('select f.id from library.local_track_files f join library.local_tracks t on t.id=f.track_id where t.library_id=%s',(self.library,)).fetchall()}
            assert files <= {a['file'] for a in self.albums}, 'Unknown file prohibits cleanup'
            for table, expected, predicate, params in (
                    ('app.activity_snapshots', self.snapshot_ids, 'library_id=%s', (self.library,)),
                    ('integration.listen_history', self.event_ids, 'library_id=%s', (self.library,)),
                    ('app.account_sessions', self.sessions, 'account_id=any(%s)', (self.accounts,))):
                actual={r['id'] for r in con.execute('select id from '+table+' where '+predicate,params).fetchall()}
                assert actual<=expected, ('Unknown dependent row prohibits cleanup', table, len(actual-expected))
            featured=con.execute('select library_id,album_id,artist_id,featured_kind from library.local_album_featured_artists where library_id=%s',(self.library,)).fetchall()
            assert all((row['library_id'],row['album_id'],row['artist_id'],row['featured_kind']) in
                {(self.library,a['id'],a['artist'],'owner') for a in self.albums} for row in featured)
            # Each parent is newly created by this fixture. No shared baseline
            # account, library, metadata, epoch or clock is adopted or reset.
            con.execute('delete from library.libraries where id=%s and name=%s', (self.library, self.token))
            for account in self.accounts:
                con.execute('delete from app.accounts where id=%s and username_normalized like %s', (account, self.token+'-%'))


@pytest.fixture
def favorites_db(monkeypatch):
    registry = Connections()
    urls = database_urls()
    ownership = isolatedPostgres.IsolatedDatabaseOwnershipLock(database_url=urls[1])
    ownership.acquire()
    db = FavoritesDatabase(registry, urls)
    complete = False
    try:
        admit(registry, urls)
        from music_app.services import lastfm_postgres
        monkeypatch.setattr(lastfm_postgres, '_connect', db.app_connect)
        db.setup()
        complete = True
        yield db
    finally:
        try:
            if not complete:
                registry.quarantine()
                raise RuntimeError('Partial setup quarantined; no automatic adoption or cleanup')
            db.cleanup()
        except BaseException:
            registry.quarantine()
            raise
        else:
            ownership.release()


class Observe:
    """Transparent SQL observation, never substitutes policy or query results."""
    def __init__(self, con, before=None, after=None):
        self.con, self.before, self.after = con, before, after
    def __getattr__(self, key):
        return getattr(self.con, key)
    def execute(self, sql, params=None, **kwargs):
        if self.before:
            self.before(str(sql).lower(), params, self.con)
        result = self.con.execute(sql, params, **kwargs)
        if self.after:
            self.after(str(sql).lower(), params, self.con)
        return result


def observed(db, *, before=None, after=None):
    @contextmanager
    def connect(url):
        with db.app_connect(url) as con:
            yield Observe(con, before, after)
    return connect


class Workers:
    def __init__(self, db):
        self.db, self.releases = db, []
    def __enter__(self):
        return self
    def barrier(self):
        reached, release = Event(), Event()
        self.releases.append(release)
        def pause():
            reached.set()
            assert release.wait(8), 'Owned barrier timed out'
        return SimpleNamespace(reached=reached, release=release, pause=pause)
    def start(self, call):
        worker = SimpleNamespace(result=[], errors=[], done=Event())
        def run():
            try:
                worker.result.append(call())
            except BaseException as error:
                worker.errors.append(error)
            finally:
                worker.done.set()
        worker.thread = Thread(target=run, daemon=True)
        self.db.workers.append(worker)
        worker.thread.start()
        return worker
    def finish(self, worker):
        worker.thread.join(15)
        assert not worker.thread.is_alive() and worker.done.is_set(), 'Owned worker did not finish'
        return worker
    def __exit__(self, kind, value, traceback):
        for event in self.releases:
            event.set()
        for worker in self.db.workers:
            worker.thread.join(15)
        if any(w.thread.is_alive() for w in self.db.workers):
            self.db.registry.quarantine()
            for worker in self.db.workers:
                worker.thread.join(3)
            pytest.exit('Unproved worker drain; fixture quarantined without cleanup', returncode=2)


def await_blocker(db, waiter, blocker):
    deadline = time.monotonic()+5
    with db.connect() as con:
        while time.monotonic() < deadline:
            if blocker in con.execute('select pg_blocking_pids(%s) as pids', (waiter,)).fetchone()['pids']:
                return
            time.sleep(.01)
    pytest.fail('Expected real PostgreSQL blocker edge was not observed')


def deny(action, kind=None, identity=None):
    def constraint(ctx):
        blocked = ctx.action == action
        if kind is not None:
            blocked = blocked and ctx.resource is not None and ctx.resource.resource_kind == kind
        if identity is not None:
            blocked = blocked and ctx.resource is not None and ctx.resource.resource_ref == str(identity)
        return PolicyEvaluationConstraints(request_origin_allowed=not blocked)
    return constraint


def require_finite_friend_policy(connection, library_id):
    rows=connection.execute('select isfinite(updated_at) as finite from app.friend_policies where library_id=%s',
        (library_id,)).fetchall()
    assert len(rows)==1 and rows[0]['finite'] is True, 'Canonical friend policy timestamp must be finite'


class BootstrapFavoritesDatabase(FavoritesDatabase):
    """Exclusive supported initializer baseline; never seeds or adopts its rows.

    Baseline account/library JSON and metadata stay unchanged. Only this test's
    new IDs are deleted. Counter rows are never deleted/restored: inventory 0,
    bootstrap album-taste and test-account retained epochs may rise monotonically.
    """
    def setup(self):
        from psycopg import sql
        with self.connect() as con:
            baseline = con.execute("""select b.account_id,l.id as library_id,
                to_jsonb(a) as account_json,to_jsonb(l) as library_json
                from app.bootstrap_owners b join app.accounts a on a.id=b.account_id
                join library.libraries l on l.owner_account_id=b.account_id
                where b.owner_key='local-bootstrap-owner' and l.name='Local Library' and l.library_kind='local'""").fetchall()
            assert len(baseline)==1, 'Supported pre-provisioned bootstrap baseline required; fixture cannot seed'
            self.baseline=baseline[0]
            self.library=self.baseline['library_id']
            self.baseline_account=self.baseline['account_id']
            profiles=con.execute('select to_jsonb(p) as data from app.social_profiles p').fetchall()
            policies=con.execute('select to_jsonb(p) as data from app.friend_policies p').fetchall()
            assert len(profiles)==len(policies)==1, 'Canonical trigger-created social baseline required'
            self.baseline_social_profile=profiles[0]['data']
            self.baseline_friend_policy=policies[0]['data']
            assert set(self.baseline_social_profile)=={'account_id','account_ref'}
            assert self.baseline_social_profile['account_id']==self.baseline_account
            assert str(UUID(self.baseline_social_profile['account_ref']))==self.baseline_social_profile['account_ref']
            assert set(self.baseline_friend_policy)=={'library_id','auto_friend','updated_by_account_id','updated_at'}
            assert self.baseline_friend_policy['library_id']==self.library
            assert self.baseline_friend_policy['auto_friend'] is False
            assert self.baseline_friend_policy['updated_by_account_id'] is None
            assert self.baseline_friend_policy['updated_at'] is not None
            require_finite_friend_policy(con,self.library)
            self.baseline_memberships=[r['data'] for r in con.execute('select to_jsonb(m) as data from library.library_memberships m').fetchall()]
            assert len(self.baseline_memberships)<=1
            if self.baseline_memberships:
                original=self.baseline_memberships[0]
                assert (original['account_id'],original['library_id'],original['membership_role'])==(self.baseline_account,self.library,'owner')
            self.bootstrap_membership_new=None
            expected={('app','accounts'):1,('app','bootstrap_owners'):1,('library','libraries'):1,
                ('app','social_profiles'):1,('app','friend_policies'):1,
                ('library','relation_alias_endpoint_publications'):0,('library','gallery_projection_state'):1,
                ('library','public_metadata_source_state'):1,('catalog','popularity_api_refresh_state'):1,
                ('library','library_memberships'):len(self.baseline_memberships)}
            tables=con.execute("""select n.nspname,c.relname from pg_class c
                join pg_namespace n on n.oid=c.relnamespace
                where n.nspname=any(%s) and c.relkind in ('r','p')""",
                (['app','integration','library','ops','catalog'],)).fetchall()
            for table in tables:
                ident=(table['nspname'],table['relname'])
                if ident in isolatedPostgres._MIGRATION_OWNED_TABLES or ident==('app','activity_source_revisions'):
                    continue
                count=con.execute(sql.SQL('select count(*) as n from {}.{}').format(
                    sql.Identifier(ident[0]),sql.Identifier(ident[1]))).fetchone()['n']
                assert count==expected.get(ident,0), 'Unknown mutable baseline prohibits test writes'
            epochs=con.execute('select library_id,account_id,revision,love_revision,album_taste_revision from app.activity_source_revisions').fetchall()
            for row in epochs:
                assert row['library_id']==self.library
                if row['account_id'] not in (0,self.baseline_account):
                    assert con.execute('select id from app.accounts where id=%s',(row['account_id'],)).fetchone() is None
                assert all(row[key]>=0 for key in ('revision','love_revision','album_taste_revision'))
            self.baseline_epochs={(r['library_id'],r['account_id']):r for r in epochs}
            self.baseline_clocks={}
            for name in ('gallery_projection_state','public_metadata_source_state'):
                rows=con.execute('select library_id,generation from library.'+name).fetchall()
                assert len(rows)==1 and rows[0]['library_id']==self.library
                self.baseline_clocks[name]=rows[0]['generation']
            self.refresh_baseline=con.execute('select to_jsonb(s) as data from catalog.popularity_api_refresh_state s').fetchall()
            # The real shared authority requires membership even for bootstrap.
            # Root approved exactly this absent-tuple INSERT; never UPSERT or
            # change/adopt a baseline membership. Its full row is cleanup proof.
            if not self.baseline_memberships:
                self.bootstrap_membership_new=con.execute("""insert into library.library_memberships(account_id,library_id,membership_role)
                    values(%s,%s,'owner') returning to_jsonb(library_memberships) as data""",(self.baseline_account,self.library)).fetchone()['data']
            # Current 0114 replaces 0090: bootstrap membership synthesizes no grant.
            assert con.execute('select id from app.capabilities where account_id=%s',
                (self.baseline_account,)).fetchall()==[]
        self.owner,self.peer=self.member(),self.member()
        with self.connect() as con:
            low,high=sorted((self.owner.account_id,self.peer.account_id))
            con.execute("""insert into app.friend_connections(library_id,low_account_id,high_account_id,
                requester_account_id,state,origin) values(%s,%s,%s,%s,'accepted','request')""",(self.library,low,high,low))
            session=con.execute("""insert into app.account_sessions(account_id,session_token_hash,
                created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at)
                values(%s,%s,%s,%s,%s,%s,%s) returning id""",(self.baseline_account,
                hashlib.sha256(uuid4().bytes).digest(),self.now,self.now,self.now,
                self.now+timedelta(hours=1),self.now+timedelta(days=1))).fetchone()['id']
            self.sessions.add(session)
        self.bootstrap_owner=CurrentActor(state=ActorState.ACTIVE,account_id=self.baseline_account,
            session_id=session,is_bootstrap_owner=True,current_library_id=self.library,
            authenticated_at=self.now,library_relationships=(LibraryRelationship(self.library,'owner',True),))
        self.add_album('initial')

    def cleanup(self):
        if self.registry.quarantined or not self.registry.drained() or any(w.thread.is_alive() for w in self.workers):
            self.registry.quarantine()
            raise RuntimeError('Bootstrap fixture drain unproved; cleanup prohibited')
        with self.connect() as con:
            current=con.execute("""select b.account_id,l.id as library_id,to_jsonb(a) as account_json,to_jsonb(l) as library_json
                from app.bootstrap_owners b join app.accounts a on a.id=b.account_id join library.libraries l on l.owner_account_id=b.account_id
                where b.owner_key='local-bootstrap-owner' and l.name='Local Library' and l.library_kind='local'""").fetchall()
            assert current==[self.baseline], 'Baseline identity/account/library/metadata drift; quarantine'
            self.assert_social_baseline(con)
            assert {r['id'] for r in con.execute('select id from app.accounts where id<>%s',(self.baseline_account,)).fetchall()}==set(self.accounts)
            assert {r['id'] for r in con.execute('select id from library.libraries').fetchall()}=={self.library}
            current_baseline=[r['data'] for r in con.execute('select to_jsonb(m) as data from library.library_memberships m where account_id=%s',(self.baseline_account,)).fetchall()]
            expected_baseline=self.baseline_memberships or [self.bootstrap_membership_new]
            assert current_baseline==expected_baseline, 'Bootstrap membership drift prohibits cleanup'
            expected_tables={
                'library.local_artists':{a['artist'] for a in self.albums},
                'library.local_albums':{a['id'] for a in self.albums},
                'library.local_tracks':{a['track'] for a in self.albums},
                'library.local_track_files':{a['file'] for a in self.albums},
                'app.album_ratings':self.preference_ids,
                'app.account_sessions':self.sessions,
                'app.activity_snapshots':self.snapshot_ids,
                'integration.listen_history':self.event_ids,
            }
            for table,expected in expected_tables.items():
                actual={r['id'] for r in con.execute('select id from '+table).fetchall()}
                assert actual<=expected, ('Unknown dependent row prohibits cleanup', table, len(actual-expected))
            featured=con.execute('select library_id,album_id,artist_id,featured_kind from library.local_album_featured_artists').fetchall()
            assert all((row['library_id'],row['album_id'],row['artist_id'],row['featured_kind']) in
                {(self.library,a['id'],a['artist'],'owner') for a in self.albums} for row in featured)
            assert con.execute('select to_jsonb(s) as data from catalog.popularity_api_refresh_state s').fetchall()==self.refresh_baseline
            # Guard every retained epoch, including retired test accounts. Never
            # remove/restore an epoch merely to obtain an empty baseline.
            epochs={(r['library_id'],r['account_id']):r for r in con.execute(
                'select library_id,account_id,revision,love_revision,album_taste_revision from app.activity_source_revisions').fetchall()}
            for key,old in self.baseline_epochs.items():
                assert key in epochs and all(epochs[key][field]>=old[field] for field in ('revision','love_revision','album_taste_revision'))
            for key in epochs.keys()-self.baseline_epochs.keys():
                assert key[0]==self.library and key[1] in {0,self.baseline_account,*self.accounts}
            for name,generation in self.baseline_clocks.items():
                assert con.execute('select generation from library.'+name+' where library_id=%s',(self.library,)).fetchone()['generation']>=generation
            con.execute('delete from app.activity_snapshots where id=any(%s)',(list(self.snapshot_ids),))
            con.execute('delete from integration.listen_history where id=any(%s)',(list(self.event_ids),))
            con.execute('delete from app.account_sessions where id=any(%s)',(list(self.sessions),))
            con.execute('delete from app.album_ratings where id=any(%s)',(list(self.preference_ids),))
            con.execute('delete from library.local_tracks where id=any(%s)',([a['track'] for a in self.albums],))
            con.execute('delete from library.local_albums where id=any(%s)',([a['id'] for a in self.albums],))
            con.execute('delete from library.local_artists where id=any(%s)',([a['artist'] for a in self.albums],))
            for account in self.accounts:
                con.execute('delete from app.accounts where id=%s and username_normalized like %s',(account,self.token+'-%'))
            if self.bootstrap_membership_new is not None:
                removed=con.execute('delete from library.library_memberships m where account_id=%s and library_id=%s and to_jsonb(m)=%s returning to_jsonb(m) as data',
                    (self.baseline_account,self.library,Jsonb(self.bootstrap_membership_new))).fetchall()
                assert removed==[{'data':self.bootstrap_membership_new}]
            remaining=[r['data'] for r in con.execute('select to_jsonb(m) as data from library.library_memberships m').fetchall()]
            assert remaining==self.baseline_memberships
            self.assert_social_baseline(con)


    def assert_social_baseline(self, con):
        require_finite_friend_policy(con,self.library)
        assert con.execute('select to_jsonb(p) as data from app.social_profiles p where account_id=%s',
            (self.baseline_account,)).fetchall()==[{'data':self.baseline_social_profile}], 'Canonical social profile drift; quarantine'
        assert con.execute('select to_jsonb(p) as data from app.friend_policies p where library_id=%s',
            (self.library,)).fetchall()==[{'data':self.baseline_friend_policy}], 'Canonical friend policy drift; quarantine'
        assert con.execute('select id from app.capabilities where account_id=%s',
            (self.baseline_account,)).fetchall()==[], 'Unexpected baseline grant; never adopt or delete'


@pytest.fixture
def favorites_bootstrap_db(monkeypatch):
    registry=Connections()
    urls=database_urls()
    ownership=isolatedPostgres.IsolatedDatabaseOwnershipLock(database_url=urls[1])
    ownership.acquire()
    db=BootstrapFavoritesDatabase(registry,urls)
    complete=False
    try:
        admit(registry, urls)
        from music_app.services import lastfm_postgres
        monkeypatch.setattr(lastfm_postgres, '_connect', db.app_connect)
        db.setup();complete=True
        yield db
    finally:
        try:
            if not complete:
                registry.quarantine()
                raise RuntimeError('Bootstrap prerequisite/setup failed; quarantine without mutation cleanup')
            db.cleanup()
        except BaseException:
            registry.quarantine()
            raise
        else:
            ownership.release()
