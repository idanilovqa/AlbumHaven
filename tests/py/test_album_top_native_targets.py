"""Saved Top Details resolution fails closed at its action-time ownership seam."""
from contextlib import contextmanager

import pytest

from music_app.services import album_top_native_targets as targets
from music_app.services.owned_album_tops import AlbumTopError
from music_app.services.owned_album_tops_postgres import PostgresOwnedAlbumTopsService
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_native_targets import NativeTargetError
from tests.py.test_owned_album_tops import _context, ALBUM, BROWSE, ITEM, TOP


CONTEXT = 'a' * 64
HINT = 'inventory-album:7:501'
NATIVE = 'synthetic-native-album-key'


class Connection:
    def __init__(self):
        self.member = {'catalog_ref': ALBUM}
        self.locked = True
        self.mappings = [[{'id': 501, 'album_key': NATIVE}]]
        self.calls = []

    def execute(self, sql, parameters):
        self.calls.append((sql, parameters))
        return self

    def fetchone(self):
        if 'lock_top_native_catalog_binding' in self.calls[-1][0]:
            return {'locked': self.locked}
        return self.member

    def fetchall(self):
        return self.mappings.pop(0) if len(self.mappings) > 1 else self.mappings[0]


class Tops:
    _require = staticmethod(PostgresOwnedAlbumTopsService._require)

    def __init__(self):
        self._config = {}
        self.connection = Connection()
        self.live = _context(BROWSE)
        self.top = {'ref': TOP, 'library_id': 7, 'owner_account_id': 41,
                    'visibility': 'private', 'revision': 3}
        self.entered = 0
        self.finished = False
        self.exit_error = None

    @contextmanager
    def _authorized(self, context, constraints):
        self.entered += 1
        yield self.connection, self.live, None
        if self.exit_error is not None:
            raise self.exit_error
        self.finished = True

    def _top(self, connection, context, ref):
        assert connection is self.connection and context is self.live and ref == TOP
        return self.top


@pytest.fixture
def owner(monkeypatch):
    tops = Tops()
    native_calls = []
    monkeypatch.setattr(targets.remote_membership, 'bindings', lambda connection, top: {})

    def native(self, connection, context, album_id, *, constraints=None):
        native_calls.append((connection, context, album_id, constraints))
        return {'album_ref': NATIVE, 'allowed_actions': {
            'can_view_details': True, 'can_play_album': True},
            'path': '/synthetic/private/media', 'unrelated': 'must not escape'}

    monkeypatch.setattr(targets.PrivateNativeTargets, 'resolve_album', native)
    return tops, native_calls


def resolve(tops, **changes):
    options = {'top_ref': TOP, 'item_ref': ITEM, 'revision': '3',
               'inventory_album_ref': HINT, 'context_ref': CONTEXT, **changes}
    return targets.AlbumTopNativeTargets(tops).resolve(_context(BROWSE), **options)


def assert_denied(tops, code, status, **changes):
    with pytest.raises(AlbumTopError) as caught:
        resolve(tops, **changes)
    assert (caught.value.code, caught.value.status_code) == (code, status)
    assert NATIVE not in str(caught.value)
    assert '/synthetic/private/media' not in str(caught.value)


def test_native_target_uses_live_transaction_and_suppresses_playback_and_extra_fields(owner):
    tops, calls = owner
    constraints = PolicyEvaluationConstraints()
    result = resolve(tops, constraints=constraints)
    assert result == {'top_ref': TOP, 'revision': '3', 'item_ref': ITEM,
        'catalog_ref': ALBUM, 'inventory_album_ref': HINT,
        'native_target': {'album_ref': NATIVE,
            'allowed_actions': {'can_view_details': True, 'can_play_album': False}}}
    assert calls == [(tops.connection, tops.live, 501, constraints)]
    assert tops.finished


@pytest.mark.parametrize('field,value', [
    ('top_ref', ''), ('top_ref', TOP.upper()), ('item_ref', None), ('item_ref', 'not-a-uuid'),
    ('revision', 3), ('revision', '0'), ('revision', '03'), ('revision', '3\n'),
    ('revision', '9223372036854775808'), ('inventory_album_ref', None),
    ('inventory_album_ref', 'inventory-album:0:501'), ('inventory_album_ref', 'inventory-album:07:501'),
    ('inventory_album_ref', 'inventory-album:7:0'), ('inventory_album_ref', 'inventory-album:7:0501'),
    ('inventory_album_ref', 'inventory-album:7:-1'), ('inventory_album_ref', 'inventory-album:7:٥٠١'),
    ('inventory_album_ref', 'inventory-album:7:501\n'),
    ('inventory_album_ref', 'inventory-album:9223372036854775808:501'),
    ('inventory_album_ref', 'inventory-album:7:9223372036854775808'),
    ('context_ref', ''), ('context_ref', 'a' * 63), ('context_ref', 'A' * 64),
])
def test_malformed_identity_is_rejected_before_authorized_transaction(owner, field, value):
    tops, calls = owner
    assert_denied(tops, 'invalid_command', 422, **{field: value})
    assert tops.entered == 0 and tops.connection.calls == [] and calls == []


def test_absent_server_context_is_rejected_before_authorized_transaction(owner):
    tops, calls = owner
    assert_denied(tops, 'remote_membership_unavailable', 409, context_ref=None)
    assert tops.entered == 0 and calls == []


@pytest.mark.parametrize('mismatch', ['library', 'revision', 'member', 'remote'])
def test_unproven_top_member_never_reaches_native_resolver(owner, monkeypatch, mismatch):
    tops, calls = owner
    changes = {}
    code, status = 'item_unavailable', 404
    if mismatch == 'library':
        changes['inventory_album_ref'] = 'inventory-album:8:501'
    elif mismatch == 'revision':
        changes['revision'] = '2'
        code, status = 'revision_conflict', 409
    elif mismatch == 'member':
        tops.connection.member = None
    else:
        monkeypatch.setattr(targets.remote_membership, 'bindings', lambda connection, top: {ITEM: {}})
    assert_denied(tops, code, status, **changes)
    assert calls == []


@pytest.mark.parametrize('rows', [[], [{'id': 502, 'album_key': NATIVE}],
    [{'id': 501, 'album_key': None}], [{'id': 501, 'album_key': ''}],
    [{'id': 501, 'album_key': NATIVE}, {'id': 502, 'album_key': 'other-edition'}]])
def test_missing_moved_unbound_or_ambiguous_mapping_never_reaches_native_resolver(owner, rows):
    tops, calls = owner
    tops.connection.mappings = [rows]
    assert_denied(tops, 'native_binding_changed', 409)
    assert calls == []


@pytest.mark.parametrize('empty_key', [None, ''])
def test_unbound_edition_does_not_make_the_only_native_mapping_ambiguous(owner, empty_key):
    tops, _ = owner
    tops.connection.mappings = [[{'id': 501, 'album_key': NATIVE}, {'id': 502, 'album_key': empty_key}]]
    assert resolve(tops)['native_target']['album_ref'] == NATIVE


def test_final_mapping_check_cannot_release_an_already_resolved_native_target(owner):
    tops, calls = owner
    tops.connection.mappings.append([{'id': 502, 'album_key': 'moved-edition'}])
    assert_denied(tops, 'native_binding_changed', 409)
    assert len(calls) == 1 and not tops.finished


@pytest.mark.parametrize('resource_kind', ['album_top', 'album'])
def test_policy_changed_during_native_resolution_is_checked_again(owner, monkeypatch, resource_kind):
    tops, _ = owner
    resolved = False

    def native(*args, **kwargs):
        nonlocal resolved
        resolved = True
        return {'album_ref': NATIVE}

    def constraints(context):
        denied = resolved and context.resource is not None and context.resource.resource_kind == resource_kind
        return PolicyEvaluationConstraints(deployment_allowed=not denied)

    monkeypatch.setattr(targets.PrivateNativeTargets, 'resolve_album', native)
    assert_denied(tops, 'forbidden', 403, constraints=constraints)
    assert resolved and not tops.finished


@pytest.mark.parametrize('code,status', [('forbidden', 403), ('item_unavailable', 404), ('invalid_command', 422)])
def test_native_resolver_failures_keep_the_existing_error_contract(owner, monkeypatch, code, status):
    tops, _ = owner

    def unavailable(*args, **kwargs):
        raise NativeTargetError(code, status)

    monkeypatch.setattr(targets.PrivateNativeTargets, 'resolve_album', unavailable)
    assert_denied(tops, code, status)


def test_transaction_exit_session_fence_discards_computed_native_target(owner):
    tops, calls = owner
    tops.exit_error = AlbumTopError('forbidden', 403)
    assert_denied(tops, 'forbidden', 403)
    assert len(calls) == 1 and not tops.finished


def test_failed_tuple_lock_never_reaches_inventory_or_native_resolver(owner):
    tops, calls = owner
    tops.connection.locked = False
    assert_denied(tops, 'native_binding_changed', 409)
    assert calls == []
    assert not any('from library.catalog_album_links' in sql for sql, _ in tops.connection.calls)
