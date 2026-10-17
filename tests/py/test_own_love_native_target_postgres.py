"""Real PostgreSQL own-love native authority, inventory and filesystem contracts.

Run with the normal isolated app/migrator URLs used by the existing Search SQL
suite. Its additive record builders and URL guards are reused unchanged. These
are service contracts, not login/browser E2E: contexts identify actual sessions
issued and resolved by PostgresAuthSessionService. Search's transaction/session
locks, live grants, witness SQL, native resolver and file checks run unchanged.
No authority/session helper or SQL result is replaced. Driver observations only
forward real operations. Each case removes its own durable records and files.
"""
from contextlib import contextmanager
from datetime import timedelta
import json
from pathlib import Path
import re

import pytest
from starlette.datastructures import QueryParams

from music_app.services.auth_sessions_postgres import PostgresAuthSessionService
from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from music_app.services.policy import PolicyContext, RequestOrigin
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_search_postgres import PostgresPrivateSearchService
from music_app.services.relation_projection_postgres import build_ready_relation_projection_metadata
from music_app.services.view_search import PrivateSearchError, normalize_private_search_request
from tests.py.test_global_private_search_postgres import SearchDatabase, connect, isolated_urls

BROWSE = 'library.browse.read'
MEDIA = 'library.media.read'
SECRET = 'synthetic-own-love-native-sql-key-32-bytes'
CONTEXT = 'a' * 64


class ObservedConnection:
    """Forward the genuine driver without substituting rows or authority."""
    def __init__(self, connection, trace):
        self.connection, self.trace = connection, trace

    def execute(self, query, params=None, *args, **kwargs):
        cursor = self.connection.execute(query, params, *args, **kwargs)
        self.trace.append((' '.join(str(query).lower().split()), params, cursor.rowcount))
        return cursor

    def __getattr__(self, name):
        return getattr(self.connection, name)


class NativeDatabase(SearchDatabase):
    files_ready = False

    def track(self, *args, **kwargs):
        identifier = super().track(*args, **kwargs)
        if self.files_ready:
            Path(self.tracks[identifier]['path']).write_bytes(b'own-love-native-test-file')
        return identifier

    def settings(self, library, paths):
        payload = {'version': 1, 'main_library_roots': [
            {'id': f'native-root-{index}', 'path': str(path), 'layout_mode': 'artist'}
            for index, path in enumerate(paths)],
            'hoarding_library_roots': [], 'new_arrivals_roots': [], 'move_policy': {}}
        with connect(self.setup) as c:
            c.execute('''insert into library.library_root_settings(library_id,layout_mode,root_categories,settings_payload)
                values(%s,'artist','{}'::jsonb,%s::jsonb) on conflict(library_id)
                do update set settings_payload=excluded.settings_payload''', (library, json.dumps(payload)))

    def activate(self, *, account=None, library=None):
        self.account = account or self.account
        self.library = library or self.library
        issued = self.browser_sessions[self.account]
        resolved = self.session_service.resolve_session(issued.raw_token)
        assert resolved is not None and resolved.account_id == self.account and resolved.session_id == issued.session_id
        self.live_actor = CurrentActor(state=ActorState.ACTIVE, account_id=self.account,
            session_id=resolved.session_id, authenticated_at=resolved.authenticated_at,
            current_library_id=self.library,
            library_relationships=(LibraryRelationship(self.library, 'member', False),),
            capability_grants=tuple(CapabilityGrant(action, 'library', self.library) for action in (BROWSE, MEDIA)))
        self.context = PolicyContext.build(actor=self.live_actor, action=BROWSE, library_id=self.library,
            deployment_mode='self_hosted', request_origin=RequestOrigin('network', 'synthetic:own-love-native'),
            client_surface_class='private_web')

    def native(self, identifier=None, *, kind='track', intent='metadata', query=':loved',
               resource_ref=None, constraints=None, **params):
        identifier = self.loved if identifier is None else identifier
        request = normalize_private_search_request(QueryParams(
            [('surface', 'albums'), ('q', query),
             *(([('artist', params.pop('artist'))] if 'artist' in params else [('all_artists', '1')])),
             *((key, item) for key, value in params.items()
               for item in (value if isinstance(value, list) else [value]))]))
        self.trace.clear()
        self.opened.clear()
        self.decisions.clear()
        return self.service.resolve_native_target(self.context, request=request, context_ref=CONTEXT,
            cursor_secret=SECRET, resource_ref=resource_ref or f'inventory-{kind}:{self.library}:{identifier}',
            intent=intent, constraints=constraints or self.constraints)

    def constraints(self, context):
        resource = context.resource
        pair = (resource.resource_kind, resource.resource_ref) if resource else None
        if pair is not None:
            self.decisions.append((context.action, *pair))
        return PolicyEvaluationConstraints(request_origin_allowed=pair not in self.denied
            and (context.action, *(pair or (None, None))) not in self.action_denied)

    @contextmanager
    def observed_connect(self, url):
        assert url == self.runtime
        with connect(url) as connection:
            self.opened.append(connection)
            yield ObservedConnection(connection, self.trace)


def fail(db, code='private_search_forbidden', status=403, **kwargs):
    with pytest.raises(PrivateSearchError) as raised:
        db.native(**kwargs)
    assert (raised.value.code, raised.value.status_code) == (code, status)
    assert all(connection.closed for connection in db.opened), 'Failed authorization retained its connection/locks'


@pytest.fixture
def native_db(isolated_urls, tmp_path):
    db = NativeDatabase(isolated_urls)
    db.action_denied, db.trace, db.opened = set(), [], []
    try:
        db.initialize()
        for library in db.libraries:
            root = tmp_path / str(library)
            root.mkdir()
            db.root_paths[db.roots[library]] = str(root)
            with connect(db.setup) as c:
                c.execute('update library.library_roots set root_path=%s where id=%s', (str(root), db.roots[library]))
                for identifier, value in db.tracks.items():
                    if value['library'] == library:
                        path = root / f'{identifier}.flac'
                        path.write_bytes(b'own-love-native-test-file')
                        c.execute('update library.local_track_files set private_path=%s where track_id=%s', (str(path), identifier))
                        value['path'] = str(path)
                for account in db.accounts:
                    c.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,%s,'library',%s)",
                        (account, MEDIA, library))
            db.settings(library, [root])
        db.files_ready = True
        db.config = {'ALBUM_HAVEN_APP_DATABASE_URL': db.runtime,
            'ALBUM_HAVEN_DEPLOYMENT_MODE': 'self_hosted',
            'session': {'idle_seconds': 3600, 'absolute_seconds': 7200}}
        db.session_service = PostgresAuthSessionService(db.config, connect=connect, clock=lambda: db.now)
        db.browser_sessions = {account: db.session_service.issue_session(account) for account in db.accounts}
        db.sessions.update({account: issued.session_id for account, issued in db.browser_sessions.items()})
        db.activate()
        db.service = PostgresPrivateSearchService(db.config, connect=db.observed_connect, clock=lambda: db.now)
        yield db
    finally:
        db.close()
        with connect(db.setup) as c:
            assert c.execute('select count(*) as n from app.accounts where id=any(%s)', (db.accounts,)).fetchone()['n'] == 0
            assert c.execute('select count(*) as n from library.libraries where id=any(%s)', (db.libraries,)).fetchone()['n'] == 0
            assert c.execute('select count(*) as n from app.account_sessions where account_id=any(%s)', (db.accounts,)).fetchone()['n'] == 0


@pytest.mark.parametrize('intent', ['metadata', 'play', 'details'])
def test_exact_current_track_resolves_real_native_identity_in_one_authorized_connection(native_db, intent):
    db = native_db
    response = db.native(intent=intent)
    assert response['status'] == 'ready' and response['contract_version'] == 'own-love-native-v1'
    assert response['context_ref'] == CONTEXT and set(response) == {'status', 'contract_version', 'context_ref', 'data'}
    data = response['data']
    assert data['resource_ref'] == f'inventory-track:{db.library}:{db.loved}' and data['intent'] == intent
    target = data['native_target']
    if intent == 'play':
        assert target['path'] == target['track_ref'] == str(Path(db.tracks[db.loved]['path']).resolve())
        assert target['inventory_track_ref'] == data['resource_ref'] and Path(target['path']).is_file()
    elif intent == 'details':
        assert target['album_ref'] == db.albums[db.main_album]['key']
        assert data['parent_album_ref'] == f'inventory-album:{db.library}:{db.main_album}'
        assert target['allowed_actions'] == {'can_view_details': True, 'can_play_album': True}
    else:
        assert target['inventory_track_ref'] == data['resource_ref']
        assert target['track_ref'] == target['canonical_track_ref'] == db.tracks[db.loved]['key']
        assert target['track_preference']['love_tier'] == 'loved'
        assert target['track_preference']['allowed_actions'] == {
            'client_surface_class': 'private_web', 'can_rate': False, 'can_set_love_tier': False}
    assert len(db.opened) == 1 and db.opened[0].closed
    assert not any(re.match(r'(insert|update|delete|merge)\b', sql) for sql, _, _ in db.trace)
    assert not {'origin', 'subject_taste', 'grant'} & data.keys()
    if intent != 'play':
        assert db.tracks[db.loved]['path'] not in json.dumps(response)


@pytest.mark.parametrize('query,identifier,allowed', [
    (':loved', 'loved', True), ('love:loved', 'obsessed', True),
    (':obsessed', 'loved', False), ('love:obsessed', 'obsessed', True),
    ('-:loved', 'off', True), ('-love:loved', 'absent', True),
    (':loved -:obsessed', 'obsessed', False), (':loved :obsessed', 'obsessed', True),
])
def test_native_reproof_uses_the_frozen_own_love_grammar(native_db, query, identifier, allowed):
    db = native_db
    if allowed:
        assert db.native(getattr(db, identifier), query=query)['status'] == 'ready'
    else:
        fail(db, identifier=getattr(db, identifier), query=query)


@pytest.mark.parametrize('change', ['love', 'delete_track', 'delete_album', 'stale_file', 'inactive_root'])
def test_retained_inventory_candidate_is_reproved_after_durable_change(native_db, change):
    db = native_db
    db.native(intent='play')
    with connect(db.setup) as c:
        if change == 'love':
            c.execute("update app.track_preferences set love_tier='off' where account_id=%s and track_id=%s", (db.account, db.loved))
        elif change == 'delete_track':
            c.execute('delete from library.local_tracks where id=%s', (db.loved,))
        elif change == 'delete_album':
            c.execute('delete from library.local_albums where id=%s', (db.main_album,))
        elif change == 'stale_file':
            c.execute("update library.local_track_files set metadata=jsonb_set(metadata,'{scan_cache}','{\"stale\":true}'::jsonb) where track_id=%s", (db.loved,))
        else:
            c.execute('update library.library_roots set is_active=false where id=%s', (db.roots[db.library],))
    fail(db, intent='play')


@pytest.mark.parametrize('kind', ['track', 'album', 'artist'])
def test_exact_track_parent_and_source_artist_browse_are_independent(native_db, kind):
    db = native_db
    identifier = {'track': db.loved, 'album': db.main_album, 'artist': db.albums[db.main_album]['artist']}[kind]
    db.action_denied.add((BROWSE, kind, str(identifier)))
    for intent in ('metadata', 'play', 'details'):
        fail(db, intent=intent)


def test_media_denial_keeps_metadata_and_canonical_details_but_never_play(native_db):
    db = native_db
    with connect(db.setup) as c:
        c.execute('update app.capabilities set revoked_at=now() where account_id=%s and capability_key=%s', (db.account, MEDIA))
    metadata = db.native()['data']['native_target']
    assert metadata['allowed_actions'] == {'can_read': True, 'can_play': False}
    assert metadata['playback_state'] == {'can_start_here': False}
    assert db.native(intent='details')['data']['native_target']['allowed_actions']['can_play_album'] is False
    fail(db, code='forbidden', status=403, intent='play')


def test_album_details_media_denial_on_a_nonmatching_track_is_not_bypassed(native_db):
    db = native_db
    db.action_denied.add((MEDIA, 'track', str(db.off)))
    target = db.native(db.main_album, kind='album', intent='details')['data']['native_target']
    assert target['album_ref'] == db.albums[db.main_album]['key']
    assert target['allowed_actions'] == {'can_view_details': True, 'can_play_album': False}
    assert db.native(intent='play')['status'] == 'ready'


def test_unhealthy_inventory_root_keeps_browse_independent_of_native_play(native_db):
    db = native_db
    with connect(db.setup) as c:
        c.execute("update library.library_roots set metadata=metadata||'{\"root_id\":\"native-health\"}'::jsonb where id=%s",
            (db.roots[db.library],))
        c.execute("update library.libraries set metadata=metadata||'{\"library_watch_health\":{\"native-health\":{\"offline\":true}}}'::jsonb where id=%s",
            (db.library,))
    target = db.native()['data']['native_target']
    assert target['availability'] == 'unresolved' and target['allowed_actions']['can_play'] is False
    fail(db, code='item_unavailable', status=404, intent='play')


def test_other_account_love_and_foreign_library_candidates_cannot_substitute(native_db):
    db = native_db
    fail(db, identifier=db.off)
    fail(db, resource_ref=f'inventory-track:{db.libraries[1]}:{db.outside}')
    fail(db, resource_ref=f'inventory-track:{db.library}:{db.outside}')
    db.activate(account=db.accounts[1])
    fail(db, identifier=db.loved)
    assert db.native(db.off)['data']['native_target']['track_preference']['love_tier'] == 'loved'
    db.activate(account=db.accounts[0], library=db.libraries[1])
    assert db.native(db.outside, intent='play')['data']['native_target']['path'] == db.tracks[db.outside]['path']


@pytest.mark.parametrize('ambiguity', ['two_preferences', 'wrong_track', 'path_collision'])
def test_conflicted_canonical_identity_never_resolves_native_target(native_db, ambiguity):
    db = native_db
    candidate = db.track(db.main_album, 'Conflicted Native', tier=None)
    value = db.tracks[candidate]
    if ambiguity == 'two_preferences':
        db.preference(candidate, 'loved')
        db.preference(candidate, 'off', key=value['path'])
    elif ambiguity == 'wrong_track':
        db.preference(candidate, 'loved', target=db.loved)
    else:
        db.track(db.main_album, 'Path-key Collision', key=value['path'])
        db.preference(candidate, 'loved')
    for query in (':loved', '-:obsessed'):
        fail(db, identifier=candidate, query=query)


def test_actual_path_alias_preference_resolves_to_current_canonical_identity(native_db):
    db = native_db
    candidate = db.track(db.main_album, 'Alias Preference', tier=None)
    db.preference(candidate, 'loved', key=db.tracks[candidate]['path'])
    target = db.native(candidate)['data']['native_target']
    assert target['inventory_track_ref'] == f'inventory-track:{db.library}:{candidate}'
    assert target['canonical_track_ref'] == db.tracks[candidate]['key']


def test_selected_artist_is_reproved_through_the_persisted_native_alias_owner(native_db):
    db = native_db
    canonical, alias = 'Canonical Artist', 'Raw Alias'
    artist = db.artist(alias)
    album = db.album(artist, 'Aliased Album')
    track = db.track(album, 'Aliased Track')
    views = {'alias_to_canonical': {alias: canonical}, 'canonical_to_aliases': {canonical: [alias]},
        'artists': [], 'artists_sidebar': [], 'family_to_artists': {}, 'folder_related': {}, 'sidebar_families': []}
    readiness = build_ready_relation_projection_metadata(db.token, reason='native_contract_fixture', duration_ms=0)
    with connect(db.setup) as c:
        c.execute("update library.libraries set metadata=jsonb_set(metadata,'{scan_cache}',%s::jsonb) where id=%s",
            (json.dumps({'relation_views': views, 'relation_projection': readiness}), db.library))
    assert db.native(track, artist=alias)['status'] == 'ready'
    assert db.native(track, artist=canonical)['status'] == 'ready'
    fail(db, identifier=track, artist='Middle Artist')
    db.action_denied.add((BROWSE, 'artist', str(artist)))
    fail(db, identifier=track, artist=canonical)
    db.action_denied.clear()
    with connect(db.setup) as c:
        c.execute("update library.libraries set metadata=jsonb_set(metadata,'{scan_cache,relation_projection,status}','\"stale\"'::jsonb) where id=%s", (db.library,))
    fail(db, code='private_search_unavailable', status=503, identifier=track, artist=canonical)


def test_category_visibility_and_exact_parent_are_current(native_db):
    db = native_db
    new_album = db.album(db.albums[db.main_album]['artist'], 'Moved Album')
    with connect(db.setup) as c:
        c.execute('update library.local_tracks set album_id=%s where id=%s', (new_album, db.loved))
        c.execute("update library.local_albums set metadata=jsonb_set(metadata,'{root_provenance}',%s::jsonb) where id=%s",
            (json.dumps({'primary_category': 'hoard', 'categories': ['hoard']}), new_album))
    fail(db, intent='details', category=['main_library'])
    result = db.native(intent='details', category=['main_library', 'hoard', 'main_library'])['data']
    assert result['parent_album_ref'] == f'inventory-album:{db.library}:{new_album}'
    assert result['native_target']['album_ref'] == db.albums[new_album]['key']
    fail(db, intent='details', gallery_scope='new_arrivals')


def test_album_reproof_is_bounded_and_never_false_matches_an_unexamined_late_witness(native_db):
    db = native_db
    artist = db.artist('Bounded Native Artist')
    album = db.album(artist, 'Bounded Native Album')
    denied = [db.track(album, f'Denied {index}') for index in range(100)]
    late = db.track(album, 'Late Readable')
    db.denied.update(('track', str(identifier)) for identifier in denied)
    fail(db, code='search_native_target_retry_required', status=409, identifier=album, kind='album', intent='details')
    witnesses = [(sql, count) for sql, _, count in db.trace if 'select * from witnesses' in sql]
    assert len(witnesses) == 101 and all(count == 1 for _, count in witnesses)
    examined = {ref for action, kind, ref in db.decisions if action == BROWSE and kind == 'track'}
    assert examined == {str(identifier) for identifier in denied} and str(late) not in examined
    db.denied.remove(('track', str(denied[0])))
    assert db.native(album, kind='album', intent='details')['data']['native_target']['album_ref'] == db.albums[album]['key']


@pytest.mark.parametrize('failure', ['missing', 'directory', 'outside_configured', 'outside_inventory_root', 'missing_settings', 'wrong_library_settings'])
def test_play_requires_both_current_configured_roots_and_exact_inventory_file(native_db, tmp_path, failure):
    db = native_db
    path = Path(db.tracks[db.loved]['path'])
    other = tmp_path / 'other-root'
    other.mkdir()
    if failure in {'missing', 'directory'}:
        path.unlink()
        if failure == 'directory':
            path.mkdir()
    elif failure == 'outside_configured':
        db.settings(db.library, [other])
    elif failure == 'outside_inventory_root':
        with connect(db.setup) as c:
            c.execute('update library.library_roots set root_path=%s where id=%s', (str(other), db.roots[db.library]))
    else:
        with connect(db.setup) as c:
            c.execute('delete from library.library_root_settings where library_id=%s', (db.library,))
        if failure == 'wrong_library_settings':
            db.settings(db.libraries[1], [path.parent])
    db.config['_library_root_paths_snapshot'] = (path.parent,)
    fail(db, code='item_unavailable', status=404, intent='play')
    assert db.native()['status'] == 'ready' and db.native(intent='details')['status'] == 'ready'


def test_live_settings_changes_override_process_root_snapshot_and_never_connect_again(native_db, monkeypatch, tmp_path):
    db = native_db
    from music_app.services import library_roots
    from music_app.services import private_search_postgres as search
    probes = []
    original = library_roots.resolve_configured_media_path

    def resolve(config, raw_path, **kwargs):
        assert kwargs.get('configured_root_paths') is not None
        probes.append((raw_path, tuple(kwargs['configured_root_paths'])))
        return original(config, raw_path, **kwargs)

    def forbidden(*_args, **_kwargs):
        pytest.fail('Native Search consulted a bootstrap/process root loader or nested connection')

    monkeypatch.setattr(search, 'resolve_configured_media_path', resolve)
    monkeypatch.setattr(library_roots, 'load_library_root_settings', forbidden)
    monkeypatch.setattr(library_roots.PostgresLibraryRootSettingsStore, '_connect_to_database', forbidden)
    root = Path(db.tracks[db.loved]['path']).parent
    db.config['_library_root_paths_snapshot'] = (tmp_path / 'stale-root',)
    assert db.native(intent='play')['status'] == 'ready'
    assert probes == [(db.tracks[db.loved]['path'], (root,)), (db.tracks[db.loved]['path'], (root,))]
    new_root = tmp_path / 'new-configured-root'
    new_root.mkdir()
    db.settings(db.library, [new_root])
    fail(db, code='item_unavailable', status=404, intent='play')
    db.settings(db.library, [root])
    assert db.native(intent='play')['status'] == 'ready' and len(db.opened) == 1


def test_symlink_escape_is_not_native_media(native_db, tmp_path):
    db = native_db
    path = Path(db.tracks[db.loved]['path'])
    escaped = tmp_path / 'outside.flac'
    escaped.write_bytes(b'outside-native-root')
    path.unlink()
    try:
        path.symlink_to(escaped)
    except (OSError, NotImplementedError):
        pytest.skip('This test platform does not permit creating file symlinks')
    fail(db, code='item_unavailable', status=404, intent='play')


def test_malformed_current_settings_fail_explicitly_without_affecting_nonmedia_actions(native_db):
    db = native_db
    with connect(db.setup) as c:
        c.execute("update library.library_root_settings set settings_payload='{}'::jsonb where library_id=%s", (db.library,))
    fail(db, code='private_search_unavailable', status=503, intent='play')
    assert db.native()['status'] == 'ready'
    assert db.native(intent='details')['status'] == 'ready'


@pytest.mark.parametrize('change', ['membership', 'browse_grant', 'account', 'session', 'idle_expired', 'absolute_expired'])
def test_real_runtime_session_and_live_authority_override_stale_actor(native_db, change):
    db = native_db
    db.native(intent='play')
    with connect(db.setup) as c:
        if change == 'membership':
            c.execute('delete from library.library_memberships where account_id=%s and library_id=%s', (db.account, db.library))
        elif change == 'browse_grant':
            c.execute('update app.capabilities set revoked_at=now() where account_id=%s and capability_key=%s', (db.account, BROWSE))
        elif change == 'account':
            c.execute('update app.accounts set is_active=false where id=%s', (db.account,))
        elif change == 'session':
            c.execute('update app.account_sessions set revoked_at=now() where id=%s', (db.sessions[db.account],))
        elif change == 'idle_expired':
            c.execute('update app.account_sessions set idle_expires_at=%s where id=%s', (db.now+timedelta(seconds=30), db.sessions[db.account]))
        else:
            c.execute('update app.account_sessions set idle_expires_at=%s,absolute_expires_at=%s where id=%s',
                (db.now+timedelta(seconds=30), db.now+timedelta(seconds=60), db.sessions[db.account]))
    if change in {'idle_expired', 'absolute_expired'}:
        db.service._clock = lambda: db.now+timedelta(minutes=2)
    fail(db, intent='play')


def test_expiry_during_resolution_is_caught_by_the_real_final_session_check(native_db):
    db = native_db
    calls = []

    def clock():
        calls.append(True)
        return db.now if len(calls) == 1 else db.now + timedelta(hours=3)

    db.service._clock = clock
    fail(db, intent='play')
    assert len(calls) == 2
    assert sum('from app.account_sessions' in sql and 'for update' in sql for sql, _, _ in db.trace) == 2
    assert any('settings_payload from library.library_root_settings' in sql for sql, _, _ in db.trace)


def test_final_browse_recheck_can_retire_an_already_resolved_target(native_db):
    db = native_db
    checks = []

    def constraints(context):
        if context.action == BROWSE and context.resource is None:
            checks.append(True)
        return PolicyEvaluationConstraints(request_origin_allowed=len(checks) < 3)

    fail(db, intent='play', constraints=constraints)
    assert len(checks) == 3


def test_account_session_library_settings_and_inventory_locks_follow_owner_order(native_db):
    db = native_db
    db.native(intent='play')
    queries = [sql for sql, _, _ in db.trace]
    assert queries[0] == 'set transaction isolation level read committed'

    def position(fragment, lock):
        return next(index for index, sql in enumerate(queries) if fragment in sql and lock in sql)

    account = position('from app.accounts where id=any', 'order by id for share')
    session = position('from app.account_sessions', 'for update')
    library = position('from library.library_memberships', 'for share of m,l')
    settings = position('from library.library_root_settings', 'for share')
    track = position('select id,album_id from library.local_tracks', 'for update')
    album = position('select id from library.local_albums', 'for share')
    artist = position('select id from library.local_artists', 'for share')
    files = position('select id from library.local_track_files', 'for share')
    root = position('select id from library.library_roots', 'for share')
    assert account < session < library < settings < track < album < artist < files < root
    assert queries[-1].startswith('select id, account_id, authenticated_at')
    assert db.trace[account][1] == ([db.account],)
    assert db.trace[settings][1] == (db.library,)
    assert len(db.opened) == 1 and db.opened[0].closed
    # A separate real connection can take every lock once the call completes.
    with connect(db.runtime) as c:
        c.execute("set local lock_timeout='1s'")
        c.execute('select id from app.accounts where id=%s for update nowait', (db.account,))
        c.execute('select id from app.account_sessions where id=%s for update nowait', (db.sessions[db.account],))
        c.execute('select id from library.libraries where id=%s for update nowait', (db.library,))
        c.execute('select library_id from library.library_root_settings where library_id=%s for update nowait', (db.library,))
        c.execute('select id from library.local_tracks where id=%s for update nowait', (db.loved,))
        c.execute('select id from library.library_roots where id=%s for update nowait', (db.roots[db.library],))


def test_native_play_preserves_nullable_track_artist_from_the_actual_inventory_owner(native_db):
    db = native_db
    with connect(db.setup) as c:
        c.execute('update library.local_tracks set artist_id=null where id=%s', (db.loved,))
    target = db.native(intent='play')['data']['native_target']
    assert target['artist'] is None
    assert target['path'] == db.tracks[db.loved]['path']


def test_native_resolution_does_not_put_paths_or_grants_into_the_raw_search_reader(native_db):
    db = native_db
    request = normalize_private_search_request(QueryParams({'surface': 'albums', 'q': ':loved',
        'all_artists': '1', 'search_presentation': 'tracks'}))

    def read():
        return db.service.read(db.context, request=request, context_ref=CONTEXT,
            cursor_secret=SECRET, constraints=db.constraints)

    before = read()
    for intent in ('metadata', 'play', 'details'):
        db.native(intent=intent)
    after = read()
    assert after == before
    assert after['contract_version'] == 'own-love-v1'
    for row in after['tracks']:
        assert row['canonical_track_ref'] is None
        assert row['allowed_actions'] == {'can_read': True, 'can_select': True}
        assert not {'path', 'native_target', 'playback_state', 'origin'} & row.keys()
    assert all(value['path'] not in json.dumps(after) for value in db.tracks.values())
