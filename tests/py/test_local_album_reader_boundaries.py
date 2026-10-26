"""Pure reader/state boundaries, not executed SQL, authority or durability proof.

The model returns scoped rows for the genuine two reader queries. It deliberately
has no transaction, connection factory, successful authorization or persistence.
"""
from copy import deepcopy
from datetime import datetime, timezone
import json
from types import SimpleNamespace

import pytest

from music_app.services import local_album_full_state as full
from music_app.services import local_album_full_fold as fold
from music_app.services import local_album_track_metrics as detail

V = 'a' * 64
M = 'b' * 64
LIVE = SimpleNamespace(actor=SimpleNamespace(account_id=7, session_id=999), library_id=3)
HISTORY = dict(invalidation_revision=0, proof_revision=1, append_revision=1, raw_checkpoint_cut=9)


def selected(ids=(1,)):
    return SimpleNamespace(album_id=5, membership_revision=M,
        canonical_membership=json.dumps(dict(order_status='supported',
            members=[dict(track_id=str(i)) for i in ids])))


def work(ids=(1,), extent=480000):
    return full._new_pass(selected(ids), {(i, i + 10, 1): V for i in ids}, HISTORY,
        {(i + 10, V): extent for i in ids})


def row(i=1, *, track=1, owner=1, ordinal=0, start=0, frames=480000,
        checkpoint=9, album=5, login=10):
    return dict(id=i, owner_id=owner, parent_id=owner * 100 + track, binding_serial=track,
        generation=1, stream_id=track, epoch=1, continuity_serial=1,
        ordinal_start=ordinal, output_start=ordinal, source_base48=0,
        source_start48=start, frames=frames, track_id=track,
        observed_file=track + 10, observed_root=1, observed_coordinate_basis='decoded-output-zero',
        observed_version=V, observed_ref=str(owner) + ':' + str(track),
        observed_opened_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        selected_revision=M, has_loss=False,
        _checkpoint=checkpoint, _album=album, _login=login)


class Result:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows

    def fetchone(self):
        assert len(self.rows) <= 1
        return self.rows[0] if self.rows else None


class ReaderModel:
    """Known result seam; filters here are model behavior, NOT SQL validation."""
    def __init__(self, rows):
        self.rows = deepcopy(rows)
        self.pages = []
        self.owner_queries = []

    def execute(self, sql, params):
        if sql.startswith(full._RUN_SELECT):
            assert sql == full._RUN_SELECT + ' and r.owner_id=%s and r.ordinal_start>%s order by r.ordinal_start limit 257'
            cut, account, library, album, tracks, duplicate_cut, owner, after = params
            assert (account, library, cut) == (7, 3, duplicate_cut)
            rows = [r for r in self.rows if r['_checkpoint'] <= cut and r['_album'] == album
                and r['track_id'] in tracks and r['owner_id'] == owner and r['ordinal_start'] > after]
            rows.sort(key=lambda r: r['ordinal_start'])
            rows = rows[:257]
            self.pages.append((cut, owner, after, tuple(r['id'] for r in rows)))
            return Result([{k: v for k, v in r.items() if not k.startswith('_')} for r in rows])
        if sql.startswith('select o.id from integration.playback_capture_owner o'):
            account, library, after, album, cut = params
            assert (account, library) == (7, 3)
            self.owner_queries.append(params)
            owners = sorted({r['owner_id'] for r in self.rows
                if r['_album'] == album and r['_checkpoint'] <= cut and r['owner_id'] > after})
            return Result([dict(id=owners[0])] if owners else [])
        raise AssertionError('Unexpected query at reader-only seam')


def finish(db, current, scope=None):
    scope = scope or selected(tuple(current['track_ids']))
    for _ in range(100):
        if current['phase'] == 'complete':
            return current
        current = full._advance(db, LIVE, scope, current)
    raise AssertionError('Finite reader model did not complete')


@pytest.mark.parametrize('count', [256, 257])
def test_exact_page_and_lookahead_are_folded_once_across_both_passes(count):
    db = ReaderModel([row(i + 1, ordinal=i, start=i, frames=1) for i in range(count)])
    current = finish(db, work(extent=count))
    projected = full._projection(dict(state_revision=8), current, HISTORY, target=1)
    assert projected['full'] == projected['uninterrupted_full'] == 1
    assert projected['recorded_details']['recorded_frames'] == count
    assert current['geometry']['seen_runs'] == count
    assert len(db.pages) == (2 if count == 256 else 4)
    assert all(len(ids) <= 257 and cut == 9 for cut, _, _, ids in db.pages)
    if count == 257:
        assert [after for _, _, after, _ in db.pages] == [-1, 255, -1, 255]
        assert db.pages[0][3][-1] == db.pages[1][3][0] == 257


def test_stable_cut_excludes_late_append_then_rebuilds_without_summing_snapshots():
    db = ReaderModel([row()])
    current = full._advance(db, LIVE, selected(), work())
    db.rows.append(row(2, owner=2, checkpoint=10, login=20))
    current = finish(db, current)
    later = dict(HISTORY, append_revision=2, raw_checkpoint_cut=10)
    pending = full._projection(dict(state_revision=3), current, later, target=1)
    assert pending['full'] == 1 and pending['continuation'] is True
    assert pending['cutoff_checkpoint_id'] == pending['completed_cutoff_checkpoint_id'] == '9'
    assert all(cut == 9 for cut, _, _, _ in db.pages)
    rebuilt = full._new_pass(selected(), {(1, 11, 1): V}, later, {(11, V): 480000}, prior=current)
    result = finish(db, rebuilt)
    projected = full._projection(dict(state_revision=8), result, later, target=1)
    assert projected['full'] == 2 and projected['continuation'] is False
    assert projected['recorded_details']['recorded_frames'] == 960000
    assert projected['completed_cutoff_checkpoint_id'] == '10'


def test_old_login_owners_are_traversed_without_current_login_filter():
    db = ReaderModel([row(1, owner=2, login=10), row(2, owner=8, login=20)])
    current = finish(db, work())
    assert current['best_full'] == current['best_uninterrupted'] == 2
    assert {owner for _, owner, _, _ in db.pages} == {2, 8}
    assert LIVE.actor.session_id not in [r['_login'] for r in db.rows]
    # Structural statement only: lineage uses each persisted session's guard,
    # not the caller's current login. Real SQL joins need native verification.
    assert 'o.auth_session_guard=p.auth_session_guard' in full._RUN_SELECT
    assert 'owner.auth_session_guard=p.auth_session_guard' in full._RUN_SELECT


def test_interleaved_other_album_leaves_an_ordinal_gap_not_a_full_join():
    db = ReaderModel([row(1, track=1), row(2, track=3, ordinal=480000, album=6),
        row(3, track=2, ordinal=960000)])
    current = finish(db, work((1, 2)))
    assert current['best_full'] == current['best_uninterrupted'] == 0
    assert current['geometry']['seen_runs'] == 2
    assert all(2 not in ids for _, _, _, ids in db.pages)
    assert full._projection(dict(state_revision=4), current, HISTORY)['partial'] is None


@pytest.mark.parametrize('change', ['late_loss', 'deletion', 'source_change', 'extent_conflict', 'membership'])
def test_invalidation_or_lost_support_cannot_reuse_completed_full(change):
    completed = finish(ReaderModel([row()]), work())
    versions = {(1, 11, 1): V}
    extents = {(11, V): 480000}
    history = dict(HISTORY)
    scope = selected()
    if change in ('late_loss', 'deletion'):
        history['invalidation_revision'] += 1
    elif change == 'source_change':
        versions[(1, 11, 1)] = 'c' * 64
    elif change == 'extent_conflict':
        extents.clear()
    else:
        scope.membership_revision = 'd' * 64
    assert not full._compatible(completed, scope, versions, history, extents, best_only=True)
    rebuilt = full._new_pass(scope, versions, history, extents, prior=None)
    assert rebuilt['best_full'] == rebuilt['best_uninterrupted'] == 0
    assert rebuilt['completed_details'] is None


@pytest.mark.parametrize('change', ['proof', 'append', 'unused_file_added', 'unused_file_removed'])
def test_monotonic_new_facts_preserve_supported_full_as_incomplete_lower_bound(change):
    initial = work()
    if change == 'unused_file_removed':
        initial['versions'].append([1, 99, 1, 'c' * 64])
    completed = finish(ReaderModel([row()]), initial)
    versions = {(1, 11, 1): V}
    extents = {(11, V): 480000}
    history = dict(HISTORY)
    if change == 'proof':
        history['proof_revision'] += 1
    elif change == 'append':
        history.update(append_revision=2, raw_checkpoint_cut=10)
    elif change == 'unused_file_added':
        versions[(1, 99, 1)] = 'c' * 64
    assert full._compatible(completed, selected(), versions, history, extents, best_only=True)
    result = full._projection(dict(state_revision=4), completed, history,
        pending_facts=change.startswith('unused_file'), target=5)
    assert result['full'] == 1 and result['listened'] is True
    assert result['continuation'] is True and result['history_complete'] is False
    assert result['partial'] is None
    assert result['recorded_details']['partial_incomplete'] is True
    assert result['recorded_details']['history_complete'] is False


@pytest.mark.parametrize('missing', ['selection', 'source', 'extent', 'loss'])
def test_missing_reader_support_does_not_erase_a_separate_whole_traversal(missing):
    db = ReaderModel([row(1, owner=1), row(2, owner=2)])
    if missing == 'selection':
        db.rows[0]['selected_revision'] = None
    elif missing == 'source':
        db.rows[0]['observed_version'] = None
    elif missing == 'loss':
        db.rows[0]['has_loss'] = True
    else:
        db.rows[0].update(observed_file=99, observed_version='c' * 64)
    current = work()
    if missing == 'extent':
        current['versions'].append([1, 99, 1, 'c' * 64])
    completed = finish(db, current)
    result = full._projection(dict(state_revision=5), completed, HISTORY, target=1)
    assert result['full'] == result['uninterrupted_full'] == 1
    assert result['partial'] is None and result['history_complete'] is False
    assert completed['geometry']['unsupported_runs'] == 1


def test_missing_member_is_not_removed_from_full_denominator():
    completed = finish(ReaderModel([row()]), work((1, 2)))
    result = full._projection(dict(state_revision=4), completed, HISTORY, target=1)
    assert result['full'] == 0 and result['listened'] == 'unknown'
    assert [r['track_id'] for r in result['recorded_details']['tracks']] == ['1', '2']
    assert result['recorded_details']['tracks'][1]['recorded_frames'] == 0
    assert result['recorded_details']['tracks'][1]['position_coverage'] is None


def test_fold_page_cap_plus_one_rejects_atomically():
    original = fold.new_geometry([1], {'1': dict(version=V, extent_frames48=257)})
    before = deepcopy(original)
    rows = [dict(row(i + 1, ordinal=i, start=i, frames=1), local_version=V, extent_frames48=257)
        for i in range(257)]
    with pytest.raises(ValueError, match='invalid_page'):
        fold.advance_geometry(original, rows)
    assert original == before
    accepted = fold.advance_geometry(original, rows[:256])
    assert accepted['seen_runs'] == 256


def test_geometry_group_exact_cap_then_one_prunes_only_new_partial():
    current = fold.new_geometry([1, 2], {str(i): dict(version=V, extent_frames48=480000) for i in (1, 2)})
    for i in range(1, fold.MAX_GROUPS + 1):
        r = dict(row(i, owner=i, start=i, frames=480000 - i), local_version=V, extent_frames48=480000)
        current = fold.advance_geometry(current, [r], owner_finished=True)
    assert len(current['groups']) == fold.MAX_GROUPS and current['pruned_segments'] == 0
    r = dict(row(129, owner=129, start=129, frames=480000 - 129), local_version=V, extent_frames48=480000)
    after = fold.advance_geometry(current, [r], owner_finished=True)
    assert after['groups'] == current['groups'] and after['pruned_segments'] == 1
    assert fold.geometry_lower_bound(after)['partial_incomplete'] is True


def test_counter_cap_is_exact_and_cap_plus_one_preserves_input():
    current = fold.new_geometry([1], {})
    current['seen_runs'] = fold.MAX_VALUE - 1
    unsupported = dict(row(), local_version=None, extent_frames48=None)
    at_cap = fold.advance_geometry(current, [unsupported])
    assert at_cap['seen_runs'] == fold.MAX_VALUE
    before = deepcopy(at_cap)
    with pytest.raises(fold.LocalFullCapacity, match='counter_capacity'):
        fold.advance_geometry(at_cap, [unsupported])
    assert at_cap == before


@pytest.mark.parametrize('scope', ['track', 'album'])
def test_detail_endpoint_exact_cap_and_cap_plus_one_preserve_known_points(scope):
    tracks = list(range(1, 66)) if scope == 'album' else [1]
    current = detail.new_details(tracks)
    def point_run(track, start):
        return dict(row(track, track=track, frames=1, start=start), source_version=V,
            source_extent_frames48=100000)
    rows = ([point_run(1, i * 2) for i in range(64)] if scope == 'track' else
        [point_run(track, i * 2) for track in tracks[:63] for i in range(64)]
        + [point_run(64, i * 2) for i in range(63)] + [point_run(65, 0)])
    detail.anchor_details(current, rows)
    detail.advance_details(current, rows)
    points = sum(len(r['points']) for r in current['tracks'].values())
    assert points == (detail.MAX_ALBUM_POINTS if scope == 'album' else detail.MAX_TRACK_POINTS)
    assert not any(r['coverage_pruned'] for r in current['tracks'].values())
    target = 65 if scope == 'album' else 1
    extra = point_run(target, 1 if scope == 'album' else 127)
    detail.anchor_details(current, [extra])
    before = deepcopy(current['tracks'][str(target)]['points'])
    detail.advance_details(current, [extra])
    assert current['tracks'][str(target)]['points'] == before
    assert current['tracks'][str(target)]['coverage_pruned'] is True
    assert sum(len(r['points']) for r in current['tracks'].values()) == points


def test_fresh_stream_exact_cap_then_one_prunes_without_inventing_a_play():
    current = work()
    rows = [dict(row(i, owner=i, frames=1), source_version=V) for i in range(1, 129)]
    full._advance_fresh(current, rows)
    assert len(current['fresh_streams']) == full.MAX_FRESH_STREAMS
    assert current['fresh_pruned'] is False and current['fresh_after'] is None
    full._advance_fresh(current, [dict(row(129, owner=129, frames=1), source_version=V)])
    assert len(current['fresh_streams']) == full.MAX_FRESH_STREAMS
    assert current['fresh_pruned'] is True and current['fresh_after'] is None
    full._advance_fresh(current, [dict(row(130, owner=130, frames=480001), source_version=V)])
    assert current['fresh_after'] is not None


@pytest.mark.parametrize('count', [1024, 1025])
def test_inventory_file_cap_never_uses_a_truncated_version_prefix(count):
    from music_app.services.local_album_listening import _versions
    scope = selected()
    scope.track_ids = (1,)
    rows = [dict(file_id=i, track_id=1, root_id=1, private_path='/synthetic/' + str(i),
        file_size_bytes=1, modified_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        content_signature=None, root_path='/synthetic', root_identity='owned',
        stale_marked_at=None, unhealthy=False) for i in range(1, count + 1)]
    class Files:
        def execute(self, sql, params):
            assert 'order by f.id limit 1025 for share of f,r,health' in sql
            assert params == ([1], 3)
            return Result(deepcopy(rows))
    versions = _versions(Files(), LIVE, scope, [dict(id=1, disc_number=1, track_number=1)])
    assert len(versions) == (1024 if count == 1024 else 0)
    assert all(len(v) == 64 for v in versions.values())


def selection_context():
    from music_app.services.current_actor import CurrentActor, ActorState, LibraryRelationship, CapabilityGrant
    from music_app.services.policy import PolicyContext, RequestOrigin
    actor = CurrentActor(state=ActorState.ACTIVE, account_id=7, session_id=999,
        current_library_id=3, library_relationships=(LibraryRelationship(3, 'member', False),),
        capability_grants=tuple(CapabilityGrant(action, 'library', 3)
            for action in ('library.browse.read', 'library.media.read')))
    live = PolicyContext.build(actor=actor, action='library.media.read', library_id=3,
        deployment_mode='self_hosted', request_origin=RequestOrigin('network', 'synthetic:reader'),
        client_surface_class='private_web')
    return live


@pytest.mark.parametrize('count', [512, 513])
def test_complete_member_cap_does_not_trim_the_denominator(count):
    from music_app.services.playback_edition_selection import prepare_edition_selection
    live = selection_context()
    rows = [dict(id=i, album_id=5, track_key='track-' + str(i), disc_number=1, track_number=i)
        for i in range(1, count + 1)]
    result = prepare_edition_selection(live, dict(id=5, album_key='album'), rows)
    if count == 513:
        assert result is None
    else:
        assert len(result.track_ids) == 512
        assert len(json.loads(result.canonical_membership)['members']) == 512


@pytest.mark.parametrize('extra', [0, 1])
def test_selection_scalar_utf8_byte_cap_is_exact(extra):
    from music_app.services import playback_edition_selection as edition
    rows = [dict(id=i, album_id=5, track_key='a' * 1024, disc_number=1, track_number=i)
        for i in range(1, 193)]
    rows[-1]['track_key'] = 'a' * (1023 + extra)
    assert 1 + sum(len(r['track_key'].encode()) for r in rows) == edition.MAX_SCALAR_BYTES + extra
    result = edition.prepare_edition_selection(selection_context(), dict(id=5, album_key='a'), rows)
    assert (result is None) is bool(extra)


@pytest.mark.parametrize('extra', [0, 1])
def test_selection_serialized_body_cap_is_exact_not_a_scalar_byte_proxy(extra):
    from music_app.services import playback_edition_selection as edition
    rows = [dict(id=i, album_id=5, track_key='\x01' * 40, disc_number=1, track_number=i)
        for i in range(1, 513)]
    live = selection_context()
    base = edition.prepare_edition_selection(live, dict(id=5, album_key='a'), rows)
    assert base is not None
    gap = edition.MAX_BODY_BYTES + extra - len(base.canonical_membership.encode())
    assert gap > 0
    for r in rows:
        addition = min(gap, 1024 - len(r['track_key']))
        r['track_key'] += 'a' * addition
        gap -= addition
    assert gap == 0
    assert 1 + sum(len(r['track_key'].encode()) for r in rows) <= edition.MAX_SCALAR_BYTES
    document = json.loads(base.canonical_membership)
    for member, r in zip(document['members'], rows):
        member['track_key'] = r['track_key']
    from music_app.services.playback_capture import canonical_json
    assert len(canonical_json(document).encode()) == edition.MAX_BODY_BYTES + extra
    result = edition.prepare_edition_selection(live, dict(id=5, album_key='a'), rows)
    assert (result is None) is bool(extra)
    if result is not None:
        assert len(result.canonical_membership.encode()) == edition.MAX_BODY_BYTES


def optional_detail_bytes(value):
    return len(json.dumps({key: value.get(key) for key in ('details', 'completed_details')}).encode())


def detail_budget_state(target):
    # Only normal detail fields: no padding keys or enlarged product limits.
    current = work(tuple(range(1, 513)), extent=detail.MAX_VALUE)
    current.update(phase='complete', best_full=5, best_uninterrupted=3)
    rows = [dict(row(i * 100 + j, track=i, start=detail.MAX_VALUE - 2 * j - 2, frames=1),
        source_version=V, source_extent_frames48=detail.MAX_VALUE)
        for i in range(1, 513) for j in range(8)]
    detail.anchor_details(current['details'], rows)
    # Find a bounded prefix by actual folding, without thousands of repeated
    # large snapshot copies. Serialized point additions grow monotonically.
    template = deepcopy(current['details'])
    def candidate(count):
        current['details'] = deepcopy(template)
        detail.advance_details(current['details'], rows[:count])
        current['completed_details'] = deepcopy(current['details'])
        return optional_detail_bytes(current)
    low, high = 0, len(rows)
    assert candidate(low) <= target < candidate(high)
    while low + 1 < high:
        middle = (low + high) // 2
        if candidate(middle) <= target:
            low = middle
        else:
            high = middle
    candidate(low)
    assert optional_detail_bytes(current) <= target
    # Recorded time may include decoder-local repeats without new positions.
    # Adjust its numeric magnitude (within MAX_VALUE), never add padding data.
    for snapshot in (current['details'], current['completed_details']):
        for track in snapshot['tracks'].values():
            gap = target - optional_detail_bytes(current)
            if not gap:
                return current
            digits = len(str(track['frames']))
            addition = min(gap, 16 - digits)
            track['frames'] = 10 ** (digits + addition - 1)
    assert optional_detail_bytes(current) == target
    return current


@pytest.mark.parametrize('extra', [0, 1])
def test_optional_detail_exact_byte_cap_drops_only_optional_state(extra):
    current = detail_budget_state(512 * 1024 + extra)
    before = deepcopy(current)
    assert optional_detail_bytes(current) == 512 * 1024 + extra
    full._bound_optional_details(current)
    assert current['best_full'] == 5 and current['best_uninterrupted'] == 3
    if not extra:
        assert current == before
    else:
        assert current['details'] is None and current['details_pruned'] is True
        assert current['completed_details'] == before['completed_details']
        assert optional_detail_bytes(current) <= 512 * 1024
