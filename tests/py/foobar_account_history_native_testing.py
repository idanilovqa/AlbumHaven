"""AUTHORED ONLY. Actual owners over controlled SQL and physical path methods.

No authority, codec, root store, inventory reader or native resolver is replaced.
Known-query rows are not evidence of PostgreSQL locks, isolation or query plans.
"""
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
import json
from types import SimpleNamespace
import pytest

BOUNDARIES = []


@pytest.fixture(autouse=True)
def checked_native_driver():
    BOUNDARIES.clear()
    yield
    assert all(not db.driver_errors for db in BOUNDARIES), [db.driver_errors for db in BOUNDARIES]

from music_app.services import foobar_account_history_native as native
from music_app.services import private_library_authority as authority
from music_app.services import foobar_account_history_readiness as readiness
from music_app.services import foobar_enhanced_entry_readiness as enhanced_readiness
from music_app.services import foobar_account_match_readiness as match_readiness
from music_app.services import library_roots_postgres as root_store
from music_app.services import library_roots as roots
from music_app.services import playlist_creation_sources_postgres as inventory
from music_app.services.current_actor import CapabilityGrant, LibraryRelationship
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.foobar_account_history_values import SOURCE, OTHER_SOURCE, OBS, bound_row as tsv_bound_row, projection
from tests.py.foobar_account_matching_synthetic import context as account_context

def bound_row(value):
    return dict(tsv_bound_row(value), evidence_kind='tsv_snapshot',
                local_entry_count=None, local_vector_sha256=None)


URL = 'synthetic:no-network'
NOW = datetime(2026, 10, 23, tzinfo=timezone.utc)
DECISION = '33333333-3333-4333-8333-333333333333'
BROWSE, MEDIA = 'library.browse.read', 'library.media.read'
CONFIG = {'ALBUM_HAVEN_APP_DATABASE_URL': URL}


def context(account=1, session=3, library=7):
    original = account_context()
    return replace(original, action=BROWSE, target_account_id=account, library_id=library,
        actor=replace(original.actor, account_id=account, session_id=session,
            current_library_id=library, library_relationships=(LibraryRelationship(library, 'member', False),),
            capability_grants=tuple(CapabilityGrant(action, 'library', library) for action in (BROWSE, MEDIA))))


def read_constraints(target):
    if target.action.startswith('account.'):
        assert target.action == 'account.self.foobar.read'
        assert target.library_id is None and target.resource is None
        assert target.actor.current_library_id is None and not target.actor.library_relationships
        assert not target.actor.capability_grants and not target.actor.is_bootstrap_owner
    return PolicyEvaluationConstraints(request_origin_allowed=target.action != 'account.self.foobar.write')


def request(count=1):
    return native.FoobarHistoryNativeRequest(SOURCE, 1, tuple(
        native.FoobarHistoryObservation(OBS if i == 0 else '00000000-0000-4000-8000-%012x' % i, 1)
        for i in range(count)))


class Cursor:
    def __init__(self, db, sql, rows):
        self.db, self.sql, self.rows, self.closed = db, sql, rows, False

    def fetchmany(self, limit):
        assert not self.closed
        self.db.fetches.append((self.sql, 'many', limit))
        return deepcopy(self.rows[:limit])

    def fetchone(self):
        assert not self.closed
        self.db.fetches.append((self.sql, 'one', 1))
        return deepcopy(self.rows[0]) if self.rows else None

    def fetchall(self):
        assert not self.closed
        self.db.fetches.append((self.sql, 'all', len(self.rows)))
        return deepcopy(self.rows)

    def close(self):
        self.closed = True


class NativeBoundary:
    autocommit = False
    closed = False
    info = SimpleNamespace(transaction_status=2)

    def __init__(self):
        self.calls, self.fetches, self.cursors, self.frames, self.physical = [], [], [], [], []
        self.driver_errors = []
        self.checkouts = self.commits = self.exits = 0
        self.account, self.library, self.session = 1, 7, 3
        self.active = self.member = self.session_live = self.online = True
        self.grants = (BROWSE, MEDIA)
        self.sources = {(1, SOURCE): 1}
        self.projections = {OBS: bound_row(projection(play_count=2))}
        self.binding = dict(binding_decision=DECISION, binding_version=1, binding_track_id=21,
            saved_decision=DECISION, saved_version=1, saved_action='match', saved_track_id=21,
            head_decision=DECISION, head_version=1, head_action='match', head_track_id=21)
        self.bindings = {OBS: self.binding}
        self.overrides, self.after = {}, None
        self.fail_sql, self.lose_ack = None, False
        self.host_library = 99
        self.settings = dict(version=1, main_library_roots=[{'id': 'host', 'path': '/native'}],
            hoarding_library_roots=[], new_arrivals_roots=[], move_policy={})
        self.file = dict(private_path='/native/song.flac', root_path='/native')
        self.local = True
        self.inventory = dict(original_local_track_id=21, title='Synthetic', artist='Artist',
            album_title='Album', original_album_id=41, duration_seconds=12,
            release_year=None, disc_number=None, track_number=None, inventory_evidence=[])

    @contextmanager
    def pool(self, url):
        assert url == URL and self.checkouts == self.exits
        self.checkouts += 1
        try:
            yield self
            if self.lose_ack:
                raise OSError('synthetic uncertain exit acknowledgement')
            self.commits += 1
        finally:
            self.exits += 1

    def execute(self, sql, params=None, **kwargs):
        self.calls.append(sql)
        if hasattr(self, "service_owner"):
            assert not self.service_owner.condition._is_owned()
        if sql == self.fail_sql:
            raise OSError('synthetic driver failure')
        try:
            rows = self.rows(sql, params, kwargs)
        except AssertionError as error:
            self.driver_errors.append(str(error))
            raise
        if sql in self.overrides:
            rows = deepcopy(self.overrides[sql])
        if self.after:
            self.after(self, sql)
        value = Cursor(self, sql, rows)
        self.cursors.append(value)
        return value

    def rows(self, sql, params, kwargs):
        if sql in ('set transaction isolation level read committed',
                "set local lock_timeout = '250ms'", "set local statement_timeout = '1000ms'",
                "select pg_advisory_xact_lock(hashtext('album-haven:local-inventory-publication'))"):
            assert params is None and not kwargs
            return []
        if sql == 'select id from app.accounts where id=any(%s) order by id for share':
            assert params == ([self.account],) and not kwargs
            return [{'id': self.account}]
        if sql == 'select id,is_active,disabled_at from app.accounts where id=%s':
            assert params == (self.account,) and not kwargs
            return [dict(id=self.account, is_active=self.active, disabled_at=None)]
        if 'from app.account_sessions' in sql:
            assert params == (self.session, self.account) and not kwargs
            return [dict(id=self.session, account_id=self.account, authenticated_at=NOW,
                idle_expires_at=NOW+timedelta(days=1), absolute_expires_at=NOW+timedelta(days=1),
                revoked_at=None if self.session_live else NOW)]
        if sql == "select account_id from app.bootstrap_owners where account_id=%s and owner_key='local-bootstrap-owner' for share":
            assert params == (self.account,) and not kwargs
            return []
        if 'from library.library_memberships m join library.libraries l' in sql:
            assert params == (self.account, self.account, self.library) and not kwargs
            return [dict(membership_role='member', is_primary_owner=False)] if self.member else []
        if 'from app.capabilities' in sql:
            assert params == (self.account,) and not kwargs
            return [dict(capability_key=key, scope_kind='library', scope_id=self.library) for key in self.grants]
        if sql == enhanced_readiness._SQL:
            assert params is None and not kwargs
            return [dict(entries_ready=True, entries_writer_ready=True)]
        if sql == readiness._SCHEMA_SQL:
            assert params is None and not kwargs
            return [dict(history_ready=True, history_writer_ready=False)]
        if sql == match_readiness._SCHEMA_SQL:
            assert params is None and not kwargs
            return [dict(structural_ready=True)]
        if sql in (native._LOCK_SOURCE, native._PROJECTION, native._BINDING):
            assert kwargs == {'binary': True} and len(params) == 1 and type(params[0]) is bytes
            assert len(params[0]) <= native.MAX_FRAME_BYTES
            frame = json.loads(params[0]); self.frames.append((sql, frame))
            account, source, library, observation = frame
            assert account == self.account and library == self.library
            if (account, source) not in self.sources:
                return []
            if sql == native._LOCK_SOURCE:
                return [dict(revision=self.sources[(account, source)])]
            value = (self.projections if sql == native._PROJECTION else self.bindings).get(observation)
            return [] if value is None else [deepcopy(value)]
        assert not kwargs
        if sql in (native._NATIVE_TRACK_LOCK, native._NATIVE_PARENT_LOCK,
                native._NATIVE_ARTIST_LOCK, native._NATIVE_TRACK_SIZE):
            assert params == (self.library, 21)
            if sql == native._NATIVE_TRACK_SIZE:
                return [dict(track_key=8, title=9, album_title=5, artist=6)]
            return [{'id': 21 if sql == native._NATIVE_TRACK_LOCK else 41}]
        if sql in (native._NATIVE_FILES_LOCK, native._NATIVE_ROOTS_LOCK, native._NATIVE_FILES_SIZE):
            assert params == (21,)
            if sql == native._NATIVE_FILES_SIZE:
                return [dict(id=31, private_path=len(self.file['private_path'].encode()),
                    content_signature=8, root_path=len(self.file['root_path'].encode()),
                    root_metadata=2, file_metadata=2)]
            return [{'id': 31}]
        if sql == native._ROOT_SELECTOR_LOCK:
            assert params == ()
            return [dict(library_id=self.host_library)]
        if sql == native._ROOT_SETTINGS_ADMISSION:
            assert params == (self.host_library,)
            return [dict(library_id=self.host_library, payload_bytes=len(json.dumps(self.settings).encode()),
                main_count=len(self.settings['main_library_roots']),
                hoard_count=len(self.settings['hoarding_library_roots']),
                arrivals_count=len(self.settings['new_arrivals_roots']))]
        if sql == native._ROOT_PATH_ADMISSION:
            assert params == (self.host_library,)
            return [dict(path_bytes=len(entry['path'].encode())) for key in
                ('main_library_roots', 'hoarding_library_roots', 'new_arrivals_roots') for entry in self.settings[key]]
        if sql == root_store._load_library_root_settings_sql():
            assert params is None
            return [dict(settings_payload=deepcopy(self.settings))]
        if sql == inventory._INVENTORY + ' where t.library_id=%s and t.id=any(%s::bigint[]) order by t.id':
            assert params == (self.library, [21])
            return [dict(self.inventory, availability='local' if self.local else 'unresolved')]
        native_locks = {
            'select id from library.local_tracks where library_id=%s and id=any(%s::bigint[]) order by id for update': (self.library, [21]),
            'select id from library.local_albums where library_id=%s and id in (select album_id from library.local_tracks where library_id=%s and id=any(%s::bigint[])) order by id for share': (self.library, self.library, [21]),
            'select id from library.local_artists where library_id=%s and id in (select artist_id from library.local_tracks where library_id=%s and id=any(%s::bigint[])) order by id for share': (self.library, self.library, [21]),
            'select id from library.local_track_files where track_id=any(%s::bigint[]) order by id for share': ([21],),
            'select id from library.library_roots where library_id=%s and id in (select library_root_id from library.local_track_files where track_id=any(%s::bigint[])) order by id for share': (self.library, [21]),
        }
        if sql in native_locks:
            assert params == native_locks[sql]
            return [{'id': 21}]
        if sql == '''select f.private_path,r.root_path from library.local_track_files f
            join library.library_roots r on r.id=f.library_root_id
            where f.track_id=%s and r.library_id=%s and r.is_active is true
              and f.scan_cache_stale is false order by f.id''':
            assert params == (21, self.library)
            return [dict(self.file)]
        if sql.startswith('select f.track_id,f.private_path,f.scan_cache_stale,'):
            assert params == (self.library, [21])
            # Offline/unresolved never becomes a private target. No guessed path.
            return [dict(track_id=21, scan_cache_stale=False, root_active=False)]
        raise AssertionError('Unmodeled native SQL: ' + sql)


def install(monkeypatch):
    db = NativeBoundary()
    BOUNDARIES.append(db)
    class FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz=None): return NOW
    monkeypatch.setattr(authority, 'pooled_connection', db.pool)
    monkeypatch.setattr(authority, 'datetime', FrozenDateTime)
    monkeypatch.setattr(native, 'datetime', FrozenDateTime)
    # Only physical path operations: real confinement, store normalization and
    # global-versus-selected-root resolver logic remain intact.
    def resolve(path, strict=False):
        db.physical.append(('resolve', str(path)))
        return path
    def exists(path):
        db.physical.append(('exists', str(path)))
        return db.online
    monkeypatch.setattr(Path, 'resolve', resolve)
    monkeypatch.setattr(Path, 'exists', exists)
    monkeypatch.setattr(Path, 'is_file', lambda path: db.online and str(path).endswith('.flac'))
    def forbidden(*args, **kwargs):
        raise AssertionError('No ambient cache/root connection is authorized')
    monkeypatch.setattr(root_store, '_connect', forbidden)
    monkeypatch.setattr(roots, 'load_library_root_settings', forbidden)
    return db


def invoke(db, *, play=False, req=None, ctx=None, constraints=read_constraints, config=None):
    action = native.resolve_foobar_history_play if play else native.read_foobar_history_eligibility
    return action(URL, context() if ctx is None else ctx, request() if req is None else req,
        config=CONFIG if config is None else config, constraints=constraints)
