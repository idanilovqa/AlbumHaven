"""Real PostgreSQL /view-data contracts for the own-subject token-only slice.

Normal hosted runner: .github/workflows/pr-gates.yml, test_python, pristine
persistent-contract DB exported as ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL
with DATABASE_MIGRATOR_URL. Missing prerequisites are setup errors, never RED.
The existing API router, middleware, policy evaluator and persistence owners run
normally. Only cookie-to-actor resolution is a fixture adapter; the supplied
actor corresponds to real durable accounts/sessions/memberships/grants, which
the read must revalidate. These are SQL/route contracts, not login or browser E2E.
No future source module is imported, no SQL result is replaced, and no existing
protected fixture is edited. Every case owns its records and removes them.
"""
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
import os
import re
from types import SimpleNamespace
from urllib.parse import urlparse
from uuid import uuid4

import pytest
from fastapi import FastAPI
from starlette.requests import Request

from music_app.routes import api_read_asgi_routes as routes
from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository
from music_app.services.persistence_selection import select_runtime_persistence_adapter
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_route_boundary import install_private_route_boundary
from music_app.services.private_ui_context import private_ui_context_ref

BROWSE = 'library.browse.read'
# Established synthetic request key from test_owned_album_top_route_boundary.py.
HMAC = {'hmac': {'secret': 'synthetic-top-route-and-context-key-32-bytes', 'key_version': 1}}
FORBIDDEN_KEYS = {'path', 'private_path', 'directory', 'album_key', 'track_key',
                  'cover_path', 'artwork_url', 'candidate_metadata', 'media_url',
                  'playback_url', 'source_path', 'file_entry', 'file_cache'}


@pytest.fixture(scope='module')
def isolated_urls():
    """Same safety guards as the existing intrinsic/playlist SQL contracts."""
    runtime = os.environ.get('ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL', '')
    setup = os.environ.get('DATABASE_MIGRATOR_URL', '')
    assert runtime and setup, 'Normal hosted isolated Postgres contract configuration is required'
    a, b = urlparse(runtime), urlparse(setup)
    for parsed in (a, b):
        assert parsed.scheme in {'postgres', 'postgresql'}
        assert parsed.hostname in {'127.0.0.1', 'localhost', '::1'}
        assert re.fullmatch(r'(?:album_haven_ci_|pytest_|album_haven_fake_e2e)[a-z0-9_]*', parsed.path.lstrip('/'))
        assert not parsed.query, 'Connection overrides are forbidden'
    assert (a.hostname, a.port, a.path) == (b.hostname, b.port, b.path)
    return runtime, setup


def connect(url):
    import psycopg
    from psycopg.rows import dict_row
    return psycopg.connect(url, row_factory=dict_row)


class SearchDatabase:
    def __init__(self, urls):
        self.runtime, self.setup = urls
        self.token = uuid4().hex
        self.accounts, self.libraries, self.sessions, self.roots = [], [], {}, {}
        self.root_paths = {}
        self.denied = set()
        self.decisions = []
        self.sql = []
        self.tracks = {}
        self.albums = {}
        self.artist_names = {}

    def initialize(self):
        now = datetime.now(timezone.utc)
        with connect(self.runtime) as c:
            assert c.execute('select current_user as role').fetchone()['role'] == 'album_haven_app'
            for name in ('app.account_sessions', 'app.track_preferences', 'library.local_tracks', 'library.local_track_files'):
                assert c.execute('select to_regclass(%s) as name', (name,)).fetchone()['name'], name
        with connect(self.setup) as c:
            for index in range(2):
                name = 'global-search-' + self.token + str(index)
                account = c.execute('''insert into app.accounts(display_name,account_kind,
                    username_display,username_normalized,contact_email,contact_email_normalized)
                    values(%s,'managed_user',%s,%s,%s,%s) returning id''',
                    (name, name, name, name+'@example.test', name+'@example.test')).fetchone()['id']
                self.accounts.append(account)
                self.sessions[account] = c.execute('''insert into app.account_sessions(account_id,session_token_hash,
                    created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at)
                    values(%s,%s,%s,%s,%s,%s,%s) returning id''',
                    (account, sha256(uuid4().bytes).digest(), now, now, now,
                     now+timedelta(hours=12), now+timedelta(days=1))).fetchone()['id']
            for index in range(2):
                library = c.execute('insert into library.libraries(owner_account_id,name) values(%s,%s) returning id',
                    (self.accounts[index], 'Global Search '+self.token+str(index))).fetchone()['id']
                self.libraries.append(library)
                self.roots[library] = c.execute('insert into library.library_roots(library_id,root_path) values(%s,%s) returning id',
                    (library, '/synthetic-global-search/'+self.token+'/'+str(index))).fetchone()['id']
                self.root_paths[self.roots[library]] = '/synthetic-global-search/'+self.token+'/'+str(index)
                for account in self.accounts:
                    c.execute("insert into library.library_memberships(account_id,library_id,membership_role) values(%s,%s,'member')", (account, library))
                    c.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,%s,'library',%s)", (account, BROWSE, library))
        self.account, self.library = self.accounts[0], self.libraries[0]
        self.now = now
        artist = self.artist('Middle Artist')
        main = self.album(artist, 'Mixed Album', year=2000)
        self.main_album = main
        self.loved = self.track(main, 'Loved Track', tier='loved', number=2)
        self.obsessed = self.track(main, 'Obsessed Track', tier='obsessed', number=1)
        self.off = self.track(main, 'Explicit Off', tier='off', number=3)
        self.absent = self.track(main, 'Absent Preference', tier=None, number=4)
        other = self.album(artist, 'Unrelated Album', year=2001)
        self.track(other, 'Other Account Only', tier=None)
        self.preference(self.loved, 'off', account=self.accounts[1])
        self.preference(self.off, 'loved', account=self.accounts[1])
        outside_artist = self.artist('Other Library Artist', library=self.libraries[1])
        outside = self.album(outside_artist, 'Other Library Album', library=self.libraries[1])
        self.outside = self.track(outside, 'Other Library Loved', tier='loved')

    def artist(self, name, *, library=None):
        library = library or self.library
        with connect(self.setup) as c:
            identifier = c.execute('insert into library.local_artists(library_id,artist_key,name) values(%s,%s,%s) returning id',
                (library, 'artist:'+uuid4().hex, name)).fetchone()['id']
        self.artist_names[identifier] = name
        return identifier

    def album(self, artist, name, *, library=None, year=2000, edition='', key=None):
        library = library or self.library
        key = key or 'album:'+uuid4().hex
        with connect(self.setup) as c:
            identifier = c.execute('''insert into library.local_albums(library_id,artist_id,album_key,title,release_year,metadata)
                values(%s,%s,%s,%s,%s,%s::jsonb) returning id''',
                (library, artist, key, name, year, json.dumps({'edition': edition}))).fetchone()['id']
        self.albums[identifier] = {'library': library, 'artist': artist, 'name': name, 'year': year, 'key': key, 'edition': edition}
        return identifier

    def track(self, album, title, *, tier='loved', number=1, disc=1, key=None, root=None):
        parent = self.albums[album]
        library = parent['library']
        key = key or 'track:'+uuid4().hex
        selected_root = root or self.roots[library]
        path = self.root_paths[selected_root]+'/'+uuid4().hex+'.flac'
        with connect(self.setup) as c:
            identifier = c.execute('''insert into library.local_tracks(library_id,artist_id,album_id,track_key,title,
                disc_number,track_number,duration_seconds) values(%s,%s,%s,%s,%s,%s,%s,181) returning id''',
                (library, parent['artist'], album, key, title, disc, number)).fetchone()['id']
            c.execute('''insert into library.local_track_files(track_id,library_root_id,private_path,content_signature)
                values(%s,%s,%s,'synthetic-global-search')''', (identifier, selected_root, path))
        self.tracks[identifier] = {'library': library, 'album': album, 'title': title, 'key': key, 'path': path}
        if tier is not None:
            self.preference(identifier, tier)
        return identifier

    def preference(self, track, tier, *, account=None, key=None, target=None):
        value = self.tracks[track]
        with connect(self.setup) as c:
            c.execute('''insert into app.track_preferences(account_id,library_id,track_id,track_key,love_tier)
                values(%s,%s,%s,%s,%s) on conflict(account_id,library_id,track_key) do update set love_tier=excluded.love_tier''',
                (account or self.accounts[0], value['library'], target if target is not None else track, key or value['key'], tier))

    def actor(self):
        return CurrentActor(state=ActorState.ACTIVE, account_id=self.account,
            session_id=self.sessions[self.account], authenticated_at=self.now, current_library_id=self.library,
            library_relationships=(LibraryRelationship(self.library, 'member', False),),
            capability_grants=(CapabilityGrant(BROWSE, 'library', self.library),))

    def constraints(self, context):
        resource = context.resource
        if resource is not None:
            pair = (resource.resource_kind, resource.resource_ref)
            self.decisions.append((context.action, *pair))
        else:
            pair = None
        return PolicyEvaluationConstraints(request_origin_allowed=pair not in self.denied)

    def context_ref(self):
        request = Request({'type': 'http', 'method': 'GET', 'path': '/view-data', 'app': self.app,
            'state': {'current_actor': self.actor()}, 'headers': [], 'query_string': b''})
        return private_ui_context_ref(request)

    def read(self, query=':loved', *, expected=200, code=None, context=None, **params):
        from tests.py.asgi_testing import run_asgi_request
        self.decisions.clear()
        self.sql.clear()
        status, headers, body = run_asgi_request(self.app, 'GET', '/view-data',
            query={'surface': 'albums', 'q': query, **params},
            headers={'cookie': '__Host-album_haven_session='+'s'*43,
                     'x-albumhaven-context': context if context is not None else self.context_ref()})
        payload = json.loads(body)
        assert status == expected, (status, payload)
        assert {'private', 'no-store'} <= {part.strip().lower() for part in headers['cache-control'].split(',')}
        assert_private_payload(payload, self)
        if expected != 200:
            assert payload['error_code'] == code
            assert not {'tracks', 'artist_groups', 'sidebar'} & payload.keys()
            return payload
        assert payload['status'] == 'ready'
        assert payload['private_search'] is True
        assert payload['contract_version'] == 'own-love-v1'
        assert payload['context_ref'] == self.context_ref()
        assert payload['query'] == query
        shared = {'status', 'private_search', 'contract_version', 'context_ref', 'query', 'criteria', 'presentation', 'tracks', 'page'}
        expected_fields = ({'album_ref'} if payload['presentation'] == 'album_detail' else
                           {'selected_artist', 'selection_state', 'artist_groups', 'sidebar'})
        assert set(payload) == shared | expected_fields
        assert set(payload['criteria']) == {'subject', 'predicate_domain', 'love', 'name_scopes'}
        assert not any(re.match(r'\s*(insert|update|delete|merge)\b', sql, re.IGNORECASE)
                       for sql, _count in self.sql), 'Search must not persist selection sources or mutate inventory'
        assert payload['criteria']['subject'] == 'self'
        assert payload['criteria']['predicate_domain'] == 'tracks'
        assert payload['criteria']['name_scopes'] == ['artists', 'albums', 'tracks']
        assert payload['page']['limit'] == int(params.get('search_page_size', 50))
        rows = result_rows(payload)
        assert payload['page']['returned_count'] == len(rows)
        assert len(rows) <= payload['page']['limit'] <= 100
        assert type(payload['page']['has_more']) is bool
        assert bool(payload['page']['next_cursor']) is payload['page']['has_more']
        assert set(payload['page']) == {'limit', 'returned_count', 'has_more', 'next_cursor'}
        if payload['presentation'] != 'album_detail':
            assert payload['selection_state'] in {'selected', 'all_artists', 'pending_page', 'empty'}
            sidebar = payload['sidebar']
            if sidebar is not None:
                assert set(sidebar) == {'artists', 'returned_count', 'has_more', 'next_cursor'}
                assert sidebar['returned_count'] == len(sidebar['artists']) <= 50
                assert bool(sidebar['next_cursor']) is sidebar['has_more']
                for artist in sidebar['artists']:
                    assert set(artist) == {'artist', 'artist_display'}
        else:
            assert 'artist_groups' not in payload and 'sidebar' not in payload
        return payload

    def close(self):
        with connect(self.setup) as c:
            for library in self.libraries:
                c.execute('delete from library.libraries where id=%s', (library,))
            for account in self.accounts:
                c.execute('delete from app.accounts where id=%s', (account,))


def assert_private_payload(payload, db):
    def walk(value):
        if isinstance(value, dict):
            assert not FORBIDDEN_KEYS & value.keys(), value.keys()
            for nested in value.values():
                walk(nested)
        elif isinstance(value, list):
            for nested in value:
                walk(nested)
        elif isinstance(value, str):
            assert '/synthetic-global-search/' not in value
            assert 'file://' not in value
    walk(payload)
    text = json.dumps(payload)
    for track in db.tracks.values():
        assert track['path'] not in text
    for album in db.albums.values():
        assert album['key'] not in text


def result_rows(payload):
    if payload['presentation'] in {'tracks', 'album_detail'}:
        return payload['tracks']
    return [album for group in payload['artist_groups'] for album in group['albums']]


def track_refs(db, ids):
    return [f"inventory-track:{db.tracks[value]['library']}:{value}" for value in ids]


def album_ref(db, album):
    return f"inventory-album:{db.albums[album]['library']}:{album}"


def assert_tracks(db, payload, ids):
    assert payload['presentation'] == 'tracks'
    assert payload['artist_groups'] == []
    assert [row['inventory_track_ref'] for row in payload['tracks']] == track_refs(db, ids)
    for row, identifier in zip(payload['tracks'], ids):
        value = db.tracks[identifier]
        parent = db.albums[value['album']]
        assert set(row) == {'inventory_track_ref', 'canonical_track_ref', 'title', 'artist', 'album',
                            'duration_seconds', 'disc_number', 'track_number', 'parent_album', 'allowed_actions'}
        assert row['title'] == value['title']
        assert row['album'] == parent['name']
        assert row['artist'] == db.artist_names[parent['artist']]
        assert row['allowed_actions'] == {'can_read': True, 'can_select': True}
        assert row['canonical_track_ref'] in (None, value['key'])
        assert row['parent_album'] == {'album_ref': album_ref(db, value['album']), 'name': parent['name'],
            'year': parent['year'], 'allowed_actions': {'can_read': True, 'can_view_details': True}}
        for key in ('duration_seconds', 'disc_number', 'track_number'):
            assert row[key] is None or type(row[key]) is int


def assert_sql_bound(db, maximum=101):
    # These observations come from the real driver's completed statements, not
    # a fake cursor. They bound materialized rowsets, not PostgreSQL plan scans.
    queries = [(sql, count) for sql, count in db.sql
               if any(table in sql.lower() for table in ('library.local_tracks', 'app.track_preferences'))]
    assert queries, 'The request must execute live SQL inventory/preference reads'
    assert all(count <= maximum for _, count in queries if count >= 0), queries
    examined = {ref for action, kind, ref in db.decisions if action == BROWSE and kind == 'track'}
    assert len(examined) <= 100, 'Authorization must not hide an unbounded candidate refill loop'


@pytest.fixture
def db(isolated_urls, monkeypatch):
    f = SearchDatabase(isolated_urls)
    try:
        f.initialize()
        # Existing real SQL repository configuration convention, with the
        # established route fixture's deployment/HMAC fields. No config module
        # replacement, persistence flag invention, or credential construction.
        config = {'ALBUM_HAVEN_APP_DATABASE_URL': f.runtime, 'ALBUM_HAVEN_DEPLOYMENT_MODE': 'self_hosted'}
        assert select_runtime_persistence_adapter('library_browse', config).effective_backend == routes.PERSISTENCE_BACKEND_POSTGRES, (
            'The normal hosted configuration must select real Postgres before product assertions')
        f.app = FastAPI()
        f.app.state.config = config
        f.app.state.auth_policy_config = HMAC
        f.app.state.library_state = {'albums': [], 'scan_in_progress': False}
        f.app.state.policy_constraint_resolver = f.constraints
        f.app.state.current_actor_resolver = SimpleNamespace(resolve=lambda _token: f.actor())
        f.app.include_router(routes.router)
        install_private_route_boundary(f.app)

        def forbidden_fallback(*_args, **_kwargs):
            pytest.fail('Personal Search entered an ordinary/file-backed/unbounded fallback')

        for name in ('build_view_payload', '_hydrate_cached_library_for_asgi', 'build_album_detail_payload'):
            monkeypatch.setattr(routes, name, forbidden_fallback)
        for name in ('build_search_payload', 'build_selected_artist_payload', 'build_album_detail_payload'):
            monkeypatch.setattr(PostgresLibraryBrowseRepository, name, forbidden_fallback)

        import psycopg
        original_execute = psycopg.Connection.execute

        def observed_execute(connection, query, params=None, *args, **kwargs):
            cursor = original_execute(connection, query, params, *args, **kwargs)
            f.sql.append((str(query), cursor.rowcount))
            return cursor

        monkeypatch.setattr(psycopg.Connection, 'execute', observed_execute)
        yield f
    finally:
        f.close()


@pytest.mark.parametrize('query,include,ids', [
    (':loved', ['loved'], ('loved', 'obsessed')),
    ('love:loved', ['loved'], ('loved', 'obsessed')),
    (':obsessed', ['obsessed'], ('obsessed',)),
    ('love:obsessed', ['obsessed'], ('obsessed',)),
])
@pytest.mark.parametrize('presentation', ['albums', 'tracks'])
def test_four_forms_execute_real_scoped_sql_and_exact_safe_dto(db, query, include, ids, presentation):
    payload = db.read(query, search_presentation=presentation)
    assert payload['criteria']['love'] == {'include': include, 'exclude': []}
    assert payload['selected_artist'] == 'Middle Artist'
    assert payload['selection_state'] == 'selected'
    assert payload['sidebar']['artists'] == [{'artist': 'Middle Artist', 'artist_display': 'Middle Artist'}]
    assert payload['page']['has_more'] is False
    if presentation == 'tracks':
        assert_tracks(db, payload, [getattr(db, name) for name in ids])
    else:
        assert payload['tracks'] == []
        assert payload['artist_groups'] == [{'artist': 'Middle Artist', 'artist_display': 'Middle Artist', 'albums': [{
            'album_ref': album_ref(db, db.main_album), 'name': 'Mixed Album', 'year': 2000, 'edition': '',
            'allowed_actions': {'can_read': True, 'can_view_details': True}, 'matches_search': True}]}]
    assert_sql_bound(db)
    with connect(db.setup) as c:
        grants = c.execute('select capability_key from app.capabilities where account_id=%s and revoked_at is null', (db.account,)).fetchall()
    assert {row['capability_key'] for row in grants} == {BROWSE}, 'Fixture must not accidentally grant playback/manage'


def test_default_presentation_is_albums_and_raw_200_codepoint_query_is_preserved(db):
    query = ' '*194 + ':loved'
    assert len(query) == 200
    payload = db.read(query)
    assert payload['presentation'] == 'albums'
    assert payload['page']['returned_count'] == 1


@pytest.mark.parametrize('query,include,exclude,ids', [
    (':loved :obsessed', ['loved', 'obsessed'], [], ('loved', 'obsessed')),
    ('love:loved :loved love:obsessed', ['loved', 'obsessed'], [], ('loved', 'obsessed')),
    ('-:loved', [], ['loved'], ('off', 'absent')),
    ('-love:loved', [], ['loved'], ('off', 'absent')),
    ('-:obsessed', [], ['obsessed'], ('loved', 'off', 'absent')),
    ('-love:obsessed', [], ['obsessed'], ('loved', 'off', 'absent')),
    (':loved -:obsessed', ['loved'], ['obsessed'], ('loved',)),
    (':obsessed -love:loved', ['obsessed'], ['loved'], ()),
])
def test_or_dedup_negation_known_absence_and_correlated_album_membership(db, query, include, exclude, ids):
    # Explicit artist keeps another known-Off album out of this test's oracle.
    # Restrict its only track via the ordinary resource policy, not fake SQL.
    unrelated = [identifier for identifier, value in db.tracks.items()
                 if value['library'] == db.library and value['album'] != db.main_album]
    db.denied.update(('track', str(identifier)) for identifier in unrelated)
    payload = db.read(query, all_artists='1', search_presentation='tracks')
    assert payload['criteria']['love'] == {'include': include, 'exclude': exclude}
    assert_tracks(db, payload, [getattr(db, name) for name in ids])
    assert payload['page']['has_more'] is False
    albums = db.read(query, all_artists='1')
    assert [row['album_ref'] for row in result_rows(albums)] == ([album_ref(db, db.main_album)] if ids else [])


@pytest.mark.parametrize('ambiguity', ['alias_target', 'multiple_preferences', 'wrong_track_id'])
@pytest.mark.parametrize('query', [':loved', '-:obsessed'])
def test_conflicted_identity_is_unknown_and_fails_closed_even_under_negation(db, ambiguity, query):
    unknown = db.track(db.main_album, 'Unknown Witness', tier=None)
    value = db.tracks[unknown]
    if ambiguity == 'alias_target':
        other = db.track(db.main_album, 'Alias Collision', tier='loved', key=value['path'])
        db.preference(unknown, 'loved')
        excluded = {unknown, other}
    elif ambiguity == 'multiple_preferences':
        db.preference(unknown, 'loved')
        db.preference(unknown, 'off', key=value['path'])
        excluded = {unknown}
    else:
        db.preference(unknown, 'loved', target=db.loved)
        excluded = {unknown}
    payload = db.read(query, all_artists='1', search_presentation='tracks')
    refs = {row['inventory_track_ref'] for row in payload['tracks']}
    assert not refs.intersection(track_refs(db, excluded))
    assert track_refs(db, [db.loved])[0] in refs
    assert all(db.tracks[item]['title'] not in json.dumps(payload) for item in excluded)


def test_account_and_library_taste_are_separate_without_bootstrap_owner_fallback(db):
    assert_tracks(db, db.read(search_presentation='tracks'), [db.loved, db.obsessed])
    old_context = db.context_ref()
    db.account = db.accounts[1]
    assert_tracks(db, db.read(search_presentation='tracks'), [db.off])
    db.read(context=old_context, expected=409, code='stale_context')
    db.account = db.accounts[0]
    db.library = db.libraries[1]
    assert_tracks(db, db.read(search_presentation='tracks'), [db.outside])
    db.read(context=old_context, expected=409, code='stale_context')


@pytest.mark.parametrize('change', ['membership', 'grant', 'account', 'session'])
def test_durable_revocation_overrides_stale_authenticated_request_actor(db, change):
    db.read(search_presentation='tracks')
    with connect(db.setup) as c:
        if change == 'membership':
            c.execute('delete from library.library_memberships where account_id=%s and library_id=%s', (db.account, db.library))
        elif change == 'grant':
            c.execute('update app.capabilities set revoked_at=now() where account_id=%s', (db.account,))
        elif change == 'account':
            c.execute('update app.accounts set is_active=false where id=%s', (db.account,))
        else:
            c.execute('update app.account_sessions set revoked_at=now() where id=%s', (db.sessions[db.account],))
    db.read(expected=403, code='private_search_forbidden')


@pytest.mark.parametrize('change', ['track_policy', 'album_policy', 'stale_file', 'inactive_root'])
def test_unreadable_witness_or_containing_inventory_never_qualifies_album_or_sidebar(db, change):
    if change == 'track_policy':
        db.denied.update({('track', str(db.loved)), ('track', str(db.obsessed))})
    elif change == 'album_policy':
        db.denied.add(('album', str(db.main_album)))
    else:
        with connect(db.setup) as c:
            if change == 'stale_file':
                c.execute('update library.local_track_files set scan_cache_stale=true where track_id=any(%s)', ([db.loved, db.obsessed],))
            else:
                c.execute('update library.library_roots set is_active=false where id=%s', (db.roots[db.library],))
    for presentation in ('albums', 'tracks'):
        payload = db.read(search_presentation=presentation)
        assert result_rows(payload) == []
        assert payload['selection_state'] == 'empty'
        assert payload['selected_artist'] is None
        assert payload['sidebar']['artists'] == []
        assert payload['page']['has_more'] is False


def all_pages(db, *, query=':loved', **params):
    rows, seen = [], set()
    while True:
        payload = db.read(query, **params)
        rows.extend(result_rows(payload))
        cursor = payload['page']['next_cursor']
        if cursor is None:
            return rows
        assert cursor not in seen, 'Continuation did not advance'
        seen.add(cursor)
        # Finite fixture ceiling is a test dead-loop guard, not a server budget.
        assert len(seen) <= len(db.tracks)+len(db.albums)+1
        params = {**params, 'search_cursor': cursor, 'omit_sidebar': '1'}


@pytest.mark.parametrize('limit', [1, 50, 100])
def test_result_pages_use_pinned_sql_album_tuple_then_track_identity(db, limit):
    for name in ('a', 'Z', 'É', 'aa'):
        artist = db.artist(name)
        for year, title, edition in ((None, 'Same', ''), (2000, 'Same', 'Deluxe'), (2000, 'Same', 'Standard'), (1990, 'Zed', '')):
            album = db.album(artist, title, year=year, edition=edition)
            # Reverse track-number order must not substitute detail ordering.
            db.track(album, 'Z track', number=9)
            db.track(album, 'A track', number=1)
    with connect(db.setup) as c:
        expected = c.execute('''select t.id, a.id as album_id from library.local_tracks t
            join library.local_albums a on a.id=t.album_id join library.local_artists ar on ar.id=a.artist_id
            join app.track_preferences p on p.track_id=t.id and p.account_id=%s and p.library_id=t.library_id
            where t.library_id=%s and p.love_tier in ('loved','obsessed')
            order by ar.name, a.release_year nulls last, a.title, a.album_key, a.id, t.id''',
            (db.account, db.library)).fetchall()
    tracks = all_pages(db, search_presentation='tracks', all_artists='1', search_page_size=str(limit))
    assert [row['inventory_track_ref'] for row in tracks] == track_refs(db, [row['id'] for row in expected])
    albums = all_pages(db, all_artists='1', search_page_size=str(limit))
    expected_albums = list(dict.fromkeys(row['album_id'] for row in expected))
    assert [row['album_ref'] for row in albums] == [album_ref(db, value) for value in expected_albums]


def test_selected_artist_survives_omitted_artist_result_cursor_and_new_earlier_artist(db):
    first = db.read(search_presentation='tracks', search_page_size='1')
    assert first['selected_artist'] == 'Middle Artist'
    earlier = db.artist('AAA Earlier Artist')
    db.track(db.album(earlier, 'Earlier Album'), 'Earlier Loved')
    second = db.read(search_presentation='tracks', search_page_size='1', search_cursor=first['page']['next_cursor'], omit_sidebar='1')
    assert second['selected_artist'] == 'Middle Artist'
    assert_tracks(db, second, [db.obsessed])
    db.read(search_presentation='tracks', search_page_size='1', search_cursor=first['page']['next_cursor'],
            artist='AAA Earlier Artist', expected=409, code='stale_context')


@pytest.mark.parametrize('change', ['query', 'presentation', 'account', 'library', 'category', 'all_artists'])
def test_cursor_scope_is_not_reusable_for_changed_criteria_or_authority(db, change):
    first = db.read(search_presentation='tracks', search_page_size='1', all_artists='1')
    params = {'search_presentation': 'tracks', 'search_page_size': '1', 'all_artists': '1', 'search_cursor': first['page']['next_cursor']}
    query = ':loved'
    if change == 'query':
        query = ':obsessed'
    elif change == 'presentation':
        params['search_presentation'] = 'albums'
    elif change == 'account':
        db.account = db.accounts[1]
    elif change == 'library':
        db.library = db.libraries[1]
    elif change == 'category':
        params['category'] = ['new_arrivals']
    else:
        params.pop('all_artists')
    db.read(query, expected=409, code='stale_context', **params)


@pytest.mark.parametrize('change', ['delete', 'reorder', 'deny'])
def test_cursor_anchor_disappearance_or_changed_native_order_requires_explicit_restart(db, change):
    first = db.read(search_presentation='tracks', search_page_size='1', all_artists='1')
    assert_tracks(db, first, [db.loved])
    if change == 'deny':
        db.denied.add(('track', str(db.loved)))
    else:
        with connect(db.setup) as c:
            if change == 'delete':
                c.execute('delete from library.local_tracks where id=%s', (db.loved,))
            else:
                c.execute('update library.local_albums set release_year=1980 where id=%s', (db.main_album,))
    db.read(search_presentation='tracks', search_page_size='1', all_artists='1',
            search_cursor=first['page']['next_cursor'], expected=409, code='search_cursor_restart_required')


def test_repeated_categories_are_deduplicated_without_dropping_a_visibility_category(db):
    artist = db.albums[db.main_album]['artist']
    hoard = db.album(artist, 'Hoard Album')
    hidden = db.album(artist, 'New Arrivals Album')
    hoard_track = db.track(hoard, 'Hoard Loved')
    hidden_track = db.track(hidden, 'New Arrivals Loved')
    with connect(db.setup) as c:
        for album, category in ((hoard, 'hoard'), (hidden, 'new_arrivals')):
            c.execute("update library.local_albums set metadata=jsonb_set(metadata,'{root_provenance}',%s::jsonb) where id=%s",
                (json.dumps({'primary_category': category, 'categories': [category]}), album))
    params = {'search_presentation': 'tracks', 'all_artists': '1', 'category': ['main_library', 'hoard', 'main_library']}
    rows = all_pages(db, **params)
    refs = {row['inventory_track_ref'] for row in rows}
    assert refs == set(track_refs(db, [db.loved, db.obsessed, hoard_track]))
    assert track_refs(db, [hidden_track])[0] not in refs
    first = db.read(search_page_size='1', **params)
    # Same normalized categories preserve scope; dropping hoard must not.
    db.read(search_page_size='1', search_cursor=first['page']['next_cursor'],
        **{**params, 'category': ['main_library', 'hoard']})
    db.read(search_page_size='1', search_cursor=first['page']['next_cursor'],
        expected=409, code='stale_context', **{**params, 'category': ['main_library']})


def test_bounded_album_witness_continuation_does_not_drop_later_readable_track(db):
    artist = db.artist('AAA Pending Artist')
    album = db.album(artist, 'Huge Album')
    denied = [db.track(album, 'Denied Witness '+str(index)) for index in range(100)]
    admitted = db.track(album, 'Late Readable Witness')
    db.denied.update(('track', str(value)) for value in denied)
    params = {'all_artists': '1', 'omit_sidebar': '1', 'search_page_size': '100'}
    first = db.read(**params)
    assert first['sidebar'] is None
    assert first['page']['returned_count'] == 0
    assert first['page']['has_more'] is True
    assert_sql_bound(db)
    assert {ref for action, kind, ref in db.decisions if action == BROWSE and kind == 'track'} == {str(value) for value in denied}
    remaining = all_pages(db, search_cursor=first['page']['next_cursor'], **params)
    refs = [row['album_ref'] for row in remaining]
    assert refs.count(album_ref(db, album)) == 1
    assert len(refs) == len(set(refs))
    assert album_ref(db, db.main_album) in refs
    # Tracks output independently contains only readable witnesses.
    tracks = all_pages(db, search_presentation='tracks', **params)
    assert set(row['inventory_track_ref'] for row in tracks) == set(track_refs(db, [admitted, db.loved, db.obsessed]))
    assert all(db.tracks[value]['title'] not in json.dumps(tracks) for value in denied)


def test_pending_first_artist_continuation_can_select_then_never_replace_it(db):
    artist = db.artist('AAA Pending Artist')
    album = db.album(artist, 'Huge Artist Album')
    denied = [db.track(album, 'Denied Artist Witness '+str(index)) for index in range(100)]
    db.track(album, 'Late Artist Witness')
    db.denied.update(('track', str(value)) for value in denied)
    # More than 50 following Artists establishes separate sidebar continuation.
    for index in range(52):
        later = db.artist('ZZ Later '+str(index).zfill(3))
        db.track(db.album(later, 'Later Album'), 'Later Witness')
    first = db.read()
    assert first['selection_state'] == 'pending_page'
    assert first['selected_artist'] is None
    assert result_rows(first) == []
    assert first['sidebar']['has_more'] is True
    assert_sql_bound(db)
    second = db.read(search_sidebar_cursor=first['sidebar']['next_cursor'])
    assert second['selection_state'] == 'selected'
    assert second['selected_artist'] == 'AAA Pending Artist'
    assert [row['album_ref'] for row in result_rows(second)] == [album_ref(db, album)]
    assert second['sidebar']['has_more'] is True
    third = db.read(search_sidebar_cursor=second['sidebar']['next_cursor'])
    assert third['selected_artist'] == 'AAA Pending Artist'
    assert [row['album_ref'] for row in result_rows(third)] == [album_ref(db, album)]
    for payload in (first, second, third):
        text = json.dumps(payload)
        assert all(db.tracks[value]['title'] not in text for value in denied)


def test_sidebar_native_sql_order_and_fifty_candidate_bound(db):
    for index in range(56):
        artist = db.artist(('a' if index % 2 else 'Z')+str(index).zfill(3))
        db.track(db.album(artist, 'Sidebar Album'), 'Sidebar Witness')
    with connect(db.setup) as c:
        expected = [row['name'] for row in c.execute('''select ar.name from library.local_artists ar
            where ar.library_id=%s order by ar.name, ar.id''', (db.library,)).fetchall()]
    first = db.read()
    assert first['selected_artist'] == expected[0]
    assert first['sidebar']['returned_count'] <= 50
    assert first['sidebar']['has_more'] is True
    names = [row['artist'] for row in first['sidebar']['artists']]
    cursor = first['sidebar']['next_cursor']
    seen = set()
    while cursor:
        assert cursor not in seen
        seen.add(cursor)
        assert len(seen) <= len(expected)
        page = db.read(search_sidebar_cursor=cursor)
        assert page['selected_artist'] == expected[0]
        names.extend(row['artist'] for row in page['sidebar']['artists'])
        cursor = page['sidebar']['next_cursor']
    assert names == expected


@pytest.mark.parametrize('query', [':loved', '-:loved', '-:obsessed'])
def test_bounded_detail_pages_keep_native_order_and_exact_known_unknown_match_state(db, query):
    unknown = db.track(db.main_album, 'Unknown Detail', tier='loved', number=None, disc=None)
    db.preference(unknown, 'off', key=db.tracks[unknown]['path'])
    # One hundred additional records force continuation beyond the hard cap.
    extra = [db.track(db.main_album, 'Detail '+str(index).zfill(3),
                      tier='loved' if index % 2 else None, number=index+10, disc=2)
             for index in range(100)]
    with connect(db.setup) as c:
        ordered = [row['id'] for row in c.execute('''select id from library.local_tracks where album_id=%s
            order by disc_number nulls last, track_number nulls last, title, id''', (db.main_album,)).fetchall()]
    params = {'search_detail_album_ref': album_ref(db, db.main_album), 'search_page_size': '100'}
    first = db.read(query, **params)
    assert first['presentation'] == 'album_detail'
    assert first['album_ref'] == album_ref(db, db.main_album)
    assert first['page']['returned_count'] == 100
    assert first['page']['has_more'] is True
    assert_sql_bound(db)
    second = db.read(query, search_cursor=first['page']['next_cursor'], **params)
    assert second['page']['returned_count'] == 5
    assert second['page']['has_more'] is False
    rows = first['tracks'] + second['tracks']
    assert [row['inventory_track_ref'] for row in rows] == track_refs(db, ordered)
    positive = {db.loved, db.obsessed, *(value for index, value in enumerate(extra) if index % 2)}
    for row, identifier in zip(rows, ordered):
        assert row['allowed_actions'] == {'can_read': True, 'can_select': True}
        if identifier == unknown:
            assert row['matches_search'] is False
            assert row['match_state'] == 'unavailable'
        else:
            expected = identifier in positive if query == ':loved' else identifier not in positive if query == '-:loved' else identifier != db.obsessed
            assert row['matches_search'] is expected
            assert row['match_state'] == 'known'
        assert set(row) == {'inventory_track_ref', 'canonical_track_ref', 'title', 'artist', 'album',
                            'duration_seconds', 'disc_number', 'track_number', 'parent_album', 'allowed_actions',
                            'matches_search', 'match_state'}


def test_detail_context_album_scope_and_cursor_kind_are_not_interchangeable(db):
    detail = db.read(search_detail_album_ref=album_ref(db, db.main_album), search_page_size='1')
    db.read(search_presentation='tracks', search_page_size='1', search_cursor=detail['page']['next_cursor'],
            expected=409, code='stale_context')
    other_album = db.tracks[db.outside]['album']
    db.read(search_detail_album_ref=album_ref(db, other_album), expected=403, code='private_search_forbidden')
    db.denied.add(('album', str(db.main_album)))
    db.read(search_detail_album_ref=album_ref(db, db.main_album), search_page_size='1',
            search_cursor=detail['page']['next_cursor'], expected=403, code='private_search_forbidden')


@pytest.mark.parametrize('state', ['absent', 'nonmatching', 'denied', 'ambiguous'])
def test_explicit_artist_never_silently_selects_a_different_matching_artist(db, state):
    if state == 'absent':
        selection = 'Absent Artist'
    elif state == 'nonmatching':
        selection = 'Off Artist'
        artist = db.artist(selection)
        db.track(db.album(artist, 'Off Album'), 'Off Witness', tier='off')
    elif state == 'denied':
        selection = 'Middle Artist'
        db.denied.add(('album', str(db.main_album)))
    else:
        selection = 'Duplicate Artist'
        for _ in range(2):
            artist = db.artist(selection)
            db.track(db.album(artist, 'Duplicate Album'), 'Duplicate Witness')
    db.read(artist=selection, expected=409, code='search_selection_unavailable')
