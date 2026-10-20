"""Action-time Top queue identity, ordering, bounds and fail-closed contracts."""
from contextlib import contextmanager
from copy import deepcopy

import pytest

from music_app.services import album_top_native_queue as queue
from music_app.services import album_top_queue_popularity as popularity
from music_app.services.owned_album_tops import AlbumTopError
from music_app.services.owned_album_tops_postgres import PostgresOwnedAlbumTopsService
from music_app.services.policy import ResourceScope
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_native_targets import NativeTargetError, allows
from tests.py.test_owned_album_tops import _context, ALBUM, BROWSE, ITEM, OTHER, TOP


CONTEXT = 'a' * 64
SECOND_ITEM = '11111111-1111-4111-8111-111111111111'
MEDIA = 'library.media.read'
SOURCE = {'revision': '3', 'item_ref': ITEM, 'catalog_ref': ALBUM,
    'inventory_album_ref': 'inventory-album:7:501',
    'inventory_track_ref': 'inventory-track:7:701', 'canonical_track_ref': 'canonical-701'}


def track(identity, *, album=501, disc=1, number=1, key=None):
    return {'id': identity, 'album_id': album,
        'track_key': f'canonical-{identity}' if key is None else key,
        'disc_number': disc, 'track_number': number}


def native_target(identity):
    return {'inventory_track_ref': f'inventory-track:7:{identity}',
            'track_ref': f'/synthetic/private/{identity}.flac',
            'path': f'/synthetic/private/{identity}.flac', 'title': f'Native {identity}'}


class Connection:
    def __init__(self):
        self.members = [{'ref': ITEM, 'catalog_ref': ALBUM}]
        self.mappings = {ALBUM: [[{'id': 501, 'album_key': 'native-album-501'}]]}
        self.tracks = [track(701)]
        self.locked = True
        self.calls = []

    def execute(self, sql, parameters):
        self.calls.append((' '.join(sql.split()), parameters))
        return self

    def fetchone(self):
        sql, params = self.calls[-1]
        if 'lock_top_native_catalog_binding' in sql:
            return {'locked': self.locked}
        if 'from app.album_list_items' in sql:
            return next((row for row in self.members if str(row['ref']) == params[1]), None)
        if 'from library.local_tracks' in sql:
            return next((row for row in self.tracks if row['album_id'] == params[1] and row['id'] == params[2]), None)
        raise AssertionError(sql)

    def fetchall(self):
        sql, params = self.calls[-1]
        if 'from app.album_list_items' in sql:
            return self.members
        if 'from library.catalog_album_links' in sql:
            mappings = self.mappings.get(params[1], [[]])
            return mappings.pop(0) if len(mappings) > 1 else mappings[0]
        if 'from library.local_tracks' in sql:
            return sorted((row for row in self.tracks if row['album_id'] in params[1]), key=lambda row: row['id'])[:params[2]]
        raise AssertionError(sql)


class Tops:
    _require = staticmethod(PostgresOwnedAlbumTopsService._require)

    def __init__(self):
        self._config = {}
        self.connection = Connection()
        self.live = _context(BROWSE, MEDIA)
        self.top = {'ref': TOP, 'library_id': 7, 'owner_account_id': 41,
                    'visibility': 'private', 'revision': 3, 'is_active': False}
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
    calls = []
    monkeypatch.setattr(queue.remote_membership, 'bindings', lambda connection, top: {})

    def inventory(connection, library_id, *, track_ids, lock):
        assert connection is tops.connection and library_id == tops.live.library_id
        assert lock is True and track_ids
        return [{'original_local_track_id': row['id'], 'original_album_id': row['album_id'],
            'inventory_evidence': [row['track_key']], 'availability': 'local',
            'recording_mbid': None, 'recording_state': 'unasserted',
            'recording_source': None, 'file_tags': []}
            for row in connection.tracks if row['id'] in track_ids]

    monkeypatch.setattr(popularity.inventory, 'read_inventory', inventory)

    def capture(self, connection, context, identities, *, constraints=None):
        calls.append(('capture', connection, context, list(identities), constraints))
        return {identity: native_target(identity) for identity in identities
            if all(allows(context, action, ResourceScope('track', str(identity)), constraints)
                   for action in (BROWSE, MEDIA))}

    def resolve(self, connection, context, identity, *, intent, constraints=None):
        calls.append(('resolve', connection, context, identity, constraints))
        assert intent == 'play'
        if not all(allows(context, action, ResourceScope('track', str(identity)), constraints)
                   for action in (BROWSE, MEDIA)):
            raise NativeTargetError('forbidden', 403)
        return native_target(identity)

    monkeypatch.setattr(queue.PrivateNativeTargets, 'resolve_play_queue', capture)
    monkeypatch.setattr(queue.PrivateNativeTargets, 'resolve', resolve)
    return tops, calls


def invoke(tops, operation='capture', **changes):
    options = {'top_ref': TOP, 'payload': {'revision': '3'} if operation == 'capture' else dict(SOURCE),
               'context_ref': CONTEXT, **changes}
    return getattr(queue.AlbumTopNativeQueue(tops), operation)(_context(BROWSE), **options)


def denied(tops, code, status, operation='capture', **changes):
    with pytest.raises(AlbumTopError) as caught:
        invoke(tops, operation, **changes)
    assert (caught.value.code, caught.value.status_code) == (code, status)
    assert '/synthetic/private/' not in str(caught.value)
    assert 'Native 701' not in str(caught.value)
    assert 'native-album-501' not in str(caught.value)


def test_capture_preserves_curator_album_blocks_and_disc_track_id_order(owner):
    tops, calls = owner
    con = tops.connection
    # Curator order deliberately differs from catalog and inventory lock order.
    con.members = [{'ref': SECOND_ITEM, 'catalog_ref': OTHER}, {'ref': ITEM, 'catalog_ref': ALBUM}]
    con.mappings[OTHER] = [[{'id': 502, 'album_key': 'native-album-502'}]]
    con.tracks = [track(701, disc=2), track(702, number=2), track(703, number=1),
                  track(704, number=1), track(705, disc=None, number=1),
                  track(706, disc=1, number=0), track(707, album=502)]
    constraints = PolicyEvaluationConstraints()
    result = invoke(tops, constraints=constraints)
    assert set(result) == {'top_ref', 'revision', 'albums', 'unavailable_items'}
    assert result['top_ref'] == TOP and result['revision'] == '3'
    assert result['unavailable_items'] == []
    assert [row['item_ref'] for row in result['albums']] == [SECOND_ITEM, ITEM]
    assert [[int(track['source']['inventory_track_ref'].split(':')[-1]) for track in row['tracks']]
            for row in result['albums']] == [[707], [703, 704, 702, 706, 701, 705]]
    for album in result['albums']:
        assert set(album) == {'item_ref', 'catalog_ref', 'inventory_album_ref', 'album_ref', 'tracks'}
        for entry in album['tracks']:
            identity = int(entry['source']['inventory_track_ref'].split(':')[-1])
            assert entry == {'queue_item_ref': f"{album['item_ref']}:{identity}",
                'source': {'revision': '3', 'item_ref': album['item_ref'], 'catalog_ref': album['catalog_ref'],
                    'inventory_album_ref': album['inventory_album_ref'],
                    'inventory_track_ref': f'inventory-track:7:{identity}',
                    'canonical_track_ref': f'canonical-{identity}'}, 'native_target': native_target(identity),
                'popularity': None}
    locks = [params for sql, params in con.calls if 'lock_top_native_catalog_binding' in sql]
    assert locks == [(TOP, ITEM, 7, 3, ALBUM), (TOP, SECOND_ITEM, 7, 3, OTHER)]
    candidates = [(sql, params) for sql, params in con.calls if 'from library.local_tracks' in sql]
    assert len(candidates) == 1
    assert candidates[0][1] == (7, [501, 502], queue.MAX_QUEUE_TRACKS + 1)
    assert 'order by id limit %s for update' in candidates[0][0]
    assert calls == [('capture', con, tops.live, list(range(701, 708)), constraints)]
    assert tops.finished and tops.top['is_active'] is False


def test_maximum_positive_disc_and_track_numbers_still_precede_unknowns(owner):
    tops, _ = owner
    tops.connection.tracks = [
        track(701, disc=None, number=1),
        track(702, disc=0, number=1),
        track(703, disc=2147483647, number=None),
        track(704, disc=2147483647, number=0),
        track(705, disc=2147483647, number=2147483647),
        track(706, disc=2147483647, number=1),
    ]
    captured = invoke(tops)['albums'][0]['tracks']
    assert [row['source']['inventory_track_ref'] for row in captured] == [
        f'inventory-track:7:{identity}' for identity in (706, 705, 703, 704, 701, 702)]


def test_resolve_uses_exact_emitted_source_and_fresh_native_owner_each_time(owner):
    tops, calls = owner
    captured = invoke(tops)['albums'][0]['tracks'][0]['source']
    assert captured == SOURCE
    for _ in range(2):
        assert invoke(tops, 'resolve', payload=captured) == {
            'top_ref': TOP, 'source': SOURCE, 'native_target': native_target(701)}
    assert [entry[0] for entry in calls] == ['capture', 'resolve', 'resolve']
    assert all(entry[1:3] == (tops.connection, tops.live) for entry in calls)
    assert tops.entered == 3


@pytest.mark.parametrize('operation', ['capture', 'resolve'])
@pytest.mark.parametrize('field,value', [('top_ref', ''), ('top_ref', TOP.upper()),
    ('context_ref', ''), ('context_ref', 'a' * 63), ('context_ref', 'A' * 64)])
def test_malformed_scope_is_rejected_before_transaction(owner, operation, field, value):
    tops, calls = owner
    denied(tops, 'invalid_command', 422, operation, **{field: value})
    assert tops.entered == 0 and tops.connection.calls == [] and calls == []


@pytest.mark.parametrize('operation', ['capture', 'resolve'])
@pytest.mark.parametrize('value', [None, [], {}, {'revision': '3', 'native_target': {'path': '/untrusted'}},
    {'revision': 3}, {'revision': '0'}, {'revision': '03'}, {'revision': '3\n'},
    {'revision': '9223372036854775808'}])
def test_command_shape_and_revision_are_exact(owner, operation, value):
    tops, calls = owner
    payload = ({**SOURCE, **value} if operation == 'resolve' and isinstance(value, dict)
               and set(value) == {'revision'} else value)
    denied(tops, 'invalid_command', 422, operation, payload=payload)
    assert tops.entered == 0 and calls == []


@pytest.mark.parametrize('field,value', [('item_ref', None), ('item_ref', ITEM.upper()),
    ('catalog_ref', 'not-a-uuid'), ('canonical_track_ref', None), ('canonical_track_ref', ''),
    ('canonical_track_ref', 701), ('inventory_album_ref', 'inventory-track:7:501'),
    ('inventory_album_ref', 'inventory-album:07:501'), ('inventory_album_ref', 'inventory-album:7:0'),
    ('inventory_album_ref', 'inventory-album:7:0501'), ('inventory_album_ref', 'inventory-album:7:٥٠١'),
    ('inventory_album_ref', 'inventory-album:7:501\n'),
    ('inventory_album_ref', 'inventory-album:9223372036854775808:501'),
    ('inventory_track_ref', 'inventory-track:7:9223372036854775808'),
    ('inventory_track_ref', 'inventory-track:8:701'), ('inventory_track_ref', 'inventory-album:7:701')])
def test_resolve_rejects_malformed_tuple_before_transaction(owner, field, value):
    tops, calls = owner
    denied(tops, 'invalid_command', 422, 'resolve', payload={**SOURCE, field: value})
    assert tops.entered == 0 and calls == []


@pytest.mark.parametrize('field', list(SOURCE))
def test_resolve_requires_every_exact_source_field(owner, field):
    tops, calls = owner
    payload = {key: value for key, value in SOURCE.items() if key != field}
    denied(tops, 'invalid_command', 422, 'resolve', payload=payload)
    assert tops.entered == 0 and calls == []


@pytest.mark.parametrize('operation', ['capture', 'resolve'])
def test_absent_context_and_stale_revision_cannot_resolve(owner, operation):
    tops, calls = owner
    denied(tops, 'remote_membership_unavailable', 409, operation, context_ref=None)
    assert tops.entered == 0
    payload = {'revision': '2'} if operation == 'capture' else {**SOURCE, 'revision': '2'}
    denied(tops, 'revision_conflict', 409, operation, payload=payload)
    assert calls == []


@pytest.mark.parametrize('mismatch', ['library', 'member', 'catalog', 'track', 'track_key', 'remote'])
def test_unproven_source_never_reaches_native_owner(owner, monkeypatch, mismatch):
    tops, calls = owner
    payload = dict(SOURCE)
    if mismatch == 'library':
        payload.update(inventory_album_ref='inventory-album:8:501', inventory_track_ref='inventory-track:8:701')
    elif mismatch == 'member':
        tops.connection.members = []
    elif mismatch == 'catalog':
        payload['catalog_ref'] = OTHER
    elif mismatch == 'track':
        tops.connection.tracks[0]['album_id'] = 502
    elif mismatch == 'track_key':
        tops.connection.tracks[0]['track_key'] = 'changed-key'
    else:
        monkeypatch.setattr(queue.remote_membership, 'bindings', lambda *_: {ITEM: {}})
    denied(tops, 'item_unavailable', 404, 'resolve', payload=payload)
    assert calls == []


@pytest.mark.parametrize('editions', [[], [{'id': 502, 'album_key': 'changed'}],
    [{'id': 501, 'album_key': ''}], [{'id': 501, 'album_key': None}],
    [{'id': 501, 'album_key': 'native-album-501'}, {'id': 502, 'album_key': 'second'}]])
def test_resolve_rejects_missing_remapped_or_ambiguous_album(owner, editions):
    tops, calls = owner
    tops.connection.mappings[ALBUM] = [editions]
    denied(tops, 'native_binding_changed', 409, 'resolve')
    assert calls == []


@pytest.mark.parametrize('reason', ['remote_summary', 'unavailable', 'ambiguous_edition', 'tracks_unavailable'])
def test_unavailable_album_reports_only_membership_reference_and_reason(owner, monkeypatch, reason):
    tops, _ = owner
    if reason == 'remote_summary':
        monkeypatch.setattr(queue.remote_membership, 'bindings', lambda *_: {ITEM: {}})
    elif reason == 'unavailable':
        tops.connection.mappings[ALBUM] = [[]]
    elif reason == 'ambiguous_edition':
        tops.connection.mappings[ALBUM][0].append({'id': 502, 'album_key': 'private-other-key'})
    else:
        tops.connection.tracks = []
    result = invoke(tops)
    assert result == {'top_ref': TOP, 'revision': '3', 'albums': [],
                      'unavailable_items': [{'item_ref': ITEM, 'reason': reason}]}
    assert 'private-other-key' not in repr(result)


@pytest.mark.parametrize('action', [BROWSE, MEDIA])
@pytest.mark.parametrize('kind', ['album', 'track'])
def test_actual_caller_album_and_track_denials_skip_without_native_metadata(owner, action, kind):
    tops, calls = owner
    seen = []

    def constraints(context):
        seen.append(context)
        resource = context.resource
        denied = context.action == action and resource is not None and resource.resource_kind == kind
        return PolicyEvaluationConstraints(request_origin_allowed=not denied)

    result = invoke(tops, constraints=constraints)
    assert result['albums'] == []
    assert result['unavailable_items'] == [{'item_ref': ITEM,
        'reason': 'unavailable' if kind == 'album' else 'tracks_unavailable'}]
    assert '/synthetic/private/' not in repr(result) and 'Native 701' not in repr(result)
    assert all(context.actor is tops.live.actor for context in seen)
    if kind == 'album':
        assert not any(entry[3] for entry in calls)
    denied(tops, 'forbidden', 403, 'resolve', constraints=constraints)


def test_hidden_candidate_cannot_disclose_ambiguous_edition_state(owner):
    tops, _ = owner
    tops.connection.mappings[ALBUM][0].append({'id': 502, 'album_key': 'hidden-edition'})

    def constraints(context):
        resource = context.resource
        denied = context.action == BROWSE and resource is not None and resource.resource_kind == 'album' and resource.resource_ref == '502'
        return PolicyEvaluationConstraints(request_origin_allowed=not denied)

    assert invoke(tops, constraints=constraints)['unavailable_items'] == [{'item_ref': ITEM, 'reason': 'unavailable'}]


def test_capture_reports_partial_album_without_dropping_or_reordering_playable_tracks(owner):
    tops, _ = owner
    tops.connection.tracks = [track(701), track(702, number=2, key=''), track(703, number=3)]
    result = invoke(tops)
    assert [row['source']['canonical_track_ref'] for row in result['albums'][0]['tracks']] == ['canonical-701', 'canonical-703']
    assert result['unavailable_items'] == [{'item_ref': ITEM, 'reason': 'tracks_unavailable'}]


@pytest.mark.parametrize('size', [5000, 5001])
def test_distinct_track_candidate_bound_is_exact_and_never_truncates(owner, size):
    tops, calls = owner
    tops.connection.tracks = [track(10000 + index, number=index + 1) for index in range(size)]
    if size == 5001:
        denied(tops, 'queue_too_large', 422)
        assert calls == []
    else:
        assert len(invoke(tops)['albums'][0]['tracks']) == 5000


def test_occurrence_bound_includes_shared_inventory_across_canonical_members(owner):
    tops, calls = owner
    tops.connection.members.append({'ref': SECOND_ITEM, 'catalog_ref': OTHER})
    tops.connection.mappings[OTHER] = deepcopy(tops.connection.mappings[ALBUM])
    tops.connection.tracks = [track(10000 + index) for index in range(2501)]
    denied(tops, 'queue_too_large', 422)
    assert calls == []


@pytest.mark.parametrize('operation', ['capture', 'resolve'])
def test_tuple_lock_failure_prevents_inventory_and_native_calls(owner, operation):
    tops, calls = owner
    tops.connection.locked = False
    denied(tops, 'native_binding_changed', 409, operation)
    assert calls == []
    assert not any('from library.' in sql for sql, _ in tops.connection.calls)


@pytest.mark.parametrize('operation', ['capture', 'resolve'])
def test_final_mapping_and_transaction_fences_discard_computed_private_targets(owner, operation):
    tops, calls = owner
    tops.connection.mappings[ALBUM].append([{'id': 502, 'album_key': 'changed'}])
    denied(tops, 'native_binding_changed', 409, operation)
    assert len(calls) == 1 and not tops.finished
    tops.connection.mappings[ALBUM] = [[{'id': 501, 'album_key': 'native-album-501'}]]
    tops.exit_error = AlbumTopError('forbidden', 403)
    denied(tops, 'forbidden', 403, operation)
    assert len(calls) == 2 and not tops.finished


@pytest.mark.parametrize('operation', ['capture', 'resolve'])
@pytest.mark.parametrize('kind', ['album_top', 'album', 'track'])
def test_final_resource_policy_recheck_discards_already_resolved_target(owner, monkeypatch, operation, kind):
    tops, _ = owner
    original = (queue.PrivateNativeTargets.resolve_play_queue if operation == 'capture' else queue.PrivateNativeTargets.resolve)
    resolved = False

    def after_native(*args, **kwargs):
        nonlocal resolved
        result = original(*args, **kwargs)
        resolved = True
        return result

    def constraints(context):
        denied = resolved and context.resource is not None and context.resource.resource_kind == kind
        return PolicyEvaluationConstraints(deployment_allowed=not denied)

    monkeypatch.setattr(queue.PrivateNativeTargets, 'resolve_play_queue' if operation == 'capture' else 'resolve', after_native)
    denied(tops, 'forbidden', 403, operation, constraints=constraints)
    assert resolved and not tops.finished


@pytest.mark.parametrize('code,status', [('forbidden', 403), ('item_unavailable', 404), ('invalid_command', 422)])
def test_single_resolve_preserves_native_error_contract_without_target(owner, monkeypatch, code, status):
    tops, _ = owner

    def fail(*args, **kwargs):
        raise NativeTargetError(code, status)

    monkeypatch.setattr(queue.PrivateNativeTargets, 'resolve', fail)
    denied(tops, code, status, 'resolve')


@pytest.mark.parametrize('operation', ['capture', 'resolve'])
def test_top_browse_is_fenced_after_final_album_and_track_policy_work(owner, monkeypatch, operation):
    tops, _ = owner
    method = 'resolve_play_queue' if operation == 'capture' else 'resolve'
    original = getattr(queue.PrivateNativeTargets, method)
    resolved = False
    deny_top = False

    def after_native(*args, **kwargs):
        nonlocal resolved
        result = original(*args, **kwargs)
        resolved = True
        return result

    def constraints(context):
        nonlocal deny_top
        resource = context.resource
        if resolved and resource is not None and resource.resource_kind in {'album', 'track'}:
            deny_top = True
        blocked = deny_top and resource is not None and resource.resource_kind == 'album_top'
        return PolicyEvaluationConstraints(request_origin_allowed=not blocked)

    monkeypatch.setattr(queue.PrivateNativeTargets, method, after_native)
    denied(tops, 'forbidden', 403, operation, constraints=constraints)
    assert resolved and deny_top and not tops.finished
