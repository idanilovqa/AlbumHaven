"""Cache-only Top annotations through capture and the real evidence normalizer."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from music_app.services import album_top_queue_popularity as popularity
from music_app.services import lastfm_track_popularity as provider
from music_app.services import library_popularity_refresh as refresh
from tests.py.test_album_top_native_queue import (
    ALBUM, BROWSE, ITEM, MEDIA, OTHER, SECOND_ITEM, SOURCE, TOP,
    PolicyEvaluationConstraints, denied, invoke, native_target, owner, queue, track,
)


OBSERVED = datetime(2001, 2, 3, 4, 5, 6, tzinfo=timezone.utc)
RECORDING = 'abcdef01-2345-4678-9abc-def012345678'
ARTIST = 'cccccccc-2345-4678-9abc-def012345678'


def cached_row(identity=701, *, album=501, key=None, count=42, **changes):
    row = {
        'original_local_track_id': identity, 'original_album_id': album,
        'inventory_evidence': [key or f'canonical-{identity}', 'private-file-evidence'],
        'availability': 'local', 'title': 'Synthetic song', 'artist': 'Synthetic artist',
        'recording_mbid': RECORDING, 'recording_state': 'asserted', 'recording_source': 'file',
        'artist_mbid': ARTIST, 'artist_state': 'asserted', 'artist_source': 'file',
        'album_artist_mbid': ARTIST, 'album_artist_state': 'asserted',
        'album_artist_source': 'file', 'is_compilation': False, 'file_tags': [],
        'mapping_revision': '11111111-1111-4111-8111-111111111111',
        'mapped_recording_mbid': RECORDING, 'mapped_artist_mbid': ARTIST,
        'source_entity_id': 'https://www.last.fm/music/Synthetic/_/Song',
        'source_revision': 'synthetic-source-revision', 'observed_at': OBSERVED,
        'imported_at': OBSERVED + timedelta(seconds=1), 'count': count,
        'attribution_state': 'resolved', 'checked_inventory_revision': None,
        'last_result': 'ready',
        'local_play_count': 999999999, 'userplaycount': 888888888, 'listeners': 777777777,
    }
    row['mapped_inventory_revision'] = popularity.inventory.inventory_revision(row)
    row.update(changes)
    return row


@pytest.fixture
def cache(owner, monkeypatch):
    tops, _ = owner
    state = SimpleNamespace(rows=[cached_row()], reads=[], normalized=[], after_read=None)
    original = popularity.inventory.normalize_cached_inventory_row

    def read(connection, library_id, *, track_ids=None, lock=False):
        state.reads.append((connection, library_id, track_ids, lock))
        assert connection is tops.connection and library_id == tops.live.library_id
        assert not tops.finished and track_ids and lock is True
        if state.after_read is not None:
            state.after_read()
        return state.rows

    def normalize(row):
        state.normalized.append(row['original_local_track_id'])
        return original(row)

    def no_provider(*args, **kwargs):
        pytest.fail('Top capture must not fetch provider data or refresh the library')

    monkeypatch.setattr(popularity.inventory, 'read_inventory', read)
    monkeypatch.setattr(popularity.inventory, 'normalize_cached_inventory_row', normalize)
    monkeypatch.setattr(provider, 'fetch_track_popularity', no_provider)
    monkeypatch.setattr(refresh, 'fetch_track_popularity', no_provider)
    monkeypatch.setattr(refresh, 'refresh_library_popularity', no_provider)
    return state


@pytest.mark.parametrize('count', [0, 42, 9007199254740991])
def test_capture_emits_only_validated_global_scalar_and_keeps_old_observations(owner, cache, count):
    tops, _ = owner
    cache.rows = [cached_row(count=count)]
    before = deepcopy(cache.rows)
    captured = invoke(tops)['albums'][0]['tracks'][0]
    expected = {'provider': 'lastfm', 'metric': 'overall_scrobbles',
                'count': count, 'observed_at': OBSERVED.isoformat()}
    assert captured == {'queue_item_ref': f'{ITEM}:701', 'source': SOURCE,
                        'native_target': native_target(701), 'popularity': expected}
    assert cache.reads == [(tops.connection, 7, [701], True)]
    assert cache.normalized == [701] and cache.rows == before
    cache.rows[0].update(count=999, source_entity_id='private-changed-source')
    assert captured['popularity'] == expected


@pytest.mark.parametrize('changes', [
    {'recording_mbid': None}, {'recording_state': 'ambiguous'},
    {'mapping_revision': None}, {'mapped_inventory_revision': '0' * 64},
    {'mapped_recording_mbid': 'bbbbbbbb-2345-4678-9abc-def012345678'},
    {'source_revision': None}, {'count': None, 'attribution_state': 'missing'},
    {'count': 999, 'attribution_state': 'ambiguous'},
])
def test_unknown_or_unproven_popularity_preserves_playable_occurrence(owner, cache, changes):
    tops, _ = owner
    cache.rows = [cached_row(**changes)]
    result = invoke(tops)
    assert result['unavailable_items'] == []
    assert result['albums'][0]['tracks'] == [{
        'queue_item_ref': f'{ITEM}:701', 'source': SOURCE,
        'native_target': native_target(701), 'popularity': None}]
    assert cache.normalized == [701]


@pytest.mark.parametrize('changes', [
    {'count': -1}, {'count': True}, {'count': 1.5}, {'count': '42'},
    {'count': 9007199254740992}, {'count': None},
    {'attribution_state': 'missing'}, {'attribution_state': 'invented'},
    {'observed_at': OBSERVED.replace(tzinfo=None)},
    {'imported_at': OBSERVED.replace(tzinfo=None)},
    {'imported_at': OBSERVED - timedelta(seconds=1)}, {'source_revision': ''},
])
def test_malformed_cached_facts_fail_instead_of_becoming_unknown(owner, cache, changes):
    tops, _ = owner
    cache.rows = [cached_row(**changes)]
    with pytest.raises(ValueError):
        invoke(tops)
    assert cache.normalized == [701] and not tops.finished


def test_one_source_bounded_read_follows_playable_admission_and_never_reads_denied_rows(owner, cache):
    tops, _ = owner
    tops.connection.tracks = [track(701), track(702), track(703, key=''), track(704)]
    cache.rows = [cached_row(701), cached_row(704, count=0)]

    def constraints(context):
        resource = context.resource
        blocked = resource is not None and resource.resource_kind == 'track' and resource.resource_ref == '702'
        return PolicyEvaluationConstraints(request_origin_allowed=not blocked)

    result = invoke(tops, constraints=constraints)
    assert cache.reads == [(tops.connection, 7, [701, 704], True)]
    assert cache.normalized == [701, 704]
    assert [row['source']['inventory_track_ref'] for row in result['albums'][0]['tracks']] == [
        'inventory-track:7:701', 'inventory-track:7:704']
    assert result['unavailable_items'] == [{'item_ref': ITEM, 'reason': 'tracks_unavailable'}]


@pytest.mark.parametrize('kind', ['album', 'track'])
@pytest.mark.parametrize('action', [BROWSE, MEDIA])
def test_no_cache_read_or_normalization_when_authority_admits_no_targets(owner, cache, kind, action):
    tops, _ = owner

    def constraints(context):
        resource = context.resource
        blocked = context.action == action and resource is not None and resource.resource_kind == kind
        return PolicyEvaluationConstraints(request_origin_allowed=not blocked)

    result = invoke(tops, constraints=constraints)
    assert result['albums'] == []
    assert cache.reads == [] and cache.normalized == []


def test_empty_source_never_becomes_an_all_library_inventory_read(owner, cache):
    tops, _ = owner
    tops.connection.members = []
    assert invoke(tops) == {'top_ref': TOP, 'revision': '3', 'albums': [], 'unavailable_items': []}
    assert cache.reads == [] and cache.normalized == []


@pytest.mark.parametrize('change', ['missing', 'duplicate', 'unexpected', 'track', 'album', 'key'])
def test_inventory_row_drift_aborts_capture_with_binding_conflict(owner, cache, change):
    tops, _ = owner
    if change == 'missing':
        cache.rows = []
    elif change == 'duplicate':
        cache.rows.append(deepcopy(cache.rows[0]))
    elif change == 'unexpected':
        cache.rows.append(cached_row(702))
    elif change == 'track':
        cache.rows[0]['original_local_track_id'] = 702
    elif change == 'album':
        cache.rows[0]['original_album_id'] = 502
    else:
        cache.rows[0]['inventory_evidence'][0] = 'changed-canonical-key'
    denied(tops, 'native_binding_changed', 409)
    assert cache.reads == [(tops.connection, 7, [701], True)] and not tops.finished
    assert cache.normalized == []


def test_shared_recordings_and_shared_inventory_retain_every_album_occurrence(owner, cache):
    tops, _ = owner
    tops.connection.members.append({'ref': SECOND_ITEM, 'catalog_ref': OTHER})
    tops.connection.mappings[OTHER] = deepcopy(tops.connection.mappings[ALBUM])
    tops.connection.tracks = [track(701, number=3), track(702, number=1), track(703, number=2)]
    cache.rows = [cached_row(701, count=900), cached_row(702, count=900),
                  cached_row(703, count=0, source_entity_id='https://www.last.fm/music/Synthetic/_/Other')]
    captured = invoke(tops)
    assert [album['item_ref'] for album in captured['albums']] == [ITEM, SECOND_ITEM]
    assert [[entry['queue_item_ref'] for entry in album['tracks']] for album in captured['albums']] == [
        [f'{ITEM}:702', f'{ITEM}:703', f'{ITEM}:701'],
        [f'{SECOND_ITEM}:702', f'{SECOND_ITEM}:703', f'{SECOND_ITEM}:701']]
    assert [[entry['popularity']['count'] for entry in album['tracks']] for album in captured['albums']] == [
        [900, 0, 900], [900, 0, 900]]
    assert cache.reads == [(tops.connection, 7, [701, 702, 703], True)]
    assert cache.normalized == [701, 702, 703] and captured['unavailable_items'] == []


@pytest.mark.parametrize('kind', ['album_top', 'album', 'track'])
def test_authority_revoked_during_inventory_read_discards_annotation_and_target(owner, cache, kind):
    tops, _ = owner

    def constraints(context):
        resource = context.resource
        blocked = bool(cache.reads) and resource is not None and resource.resource_kind == kind
        return PolicyEvaluationConstraints(deployment_allowed=not blocked)

    denied(tops, 'forbidden', 403, constraints=constraints)
    assert cache.reads and not tops.finished


def test_edition_change_during_popularity_read_fails_final_binding_fence(owner, cache):
    tops, _ = owner

    def remap():
        tops.connection.mappings[ALBUM] = [[{'id': 502, 'album_key': 'changed-edition'}]]

    cache.after_read = remap
    denied(tops, 'native_binding_changed', 409)
    assert cache.reads and not tops.finished


def test_transaction_authority_failure_discards_computed_popularity(owner, cache):
    tops, _ = owner
    tops.exit_error = queue.AlbumTopError('forbidden', 403)
    denied(tops, 'forbidden', 403)
    assert cache.normalized == [701] and not tops.finished


def test_offset_source_timestamps_are_emitted_as_utc(owner, cache):
    tops, _ = owner
    offset = timezone(timedelta(hours=3))
    cache.rows = [cached_row(observed_at=OBSERVED.astimezone(offset),
                            imported_at=(OBSERVED + timedelta(seconds=1)).astimezone(offset))]
    assert invoke(tops)['albums'][0]['tracks'][0]['popularity']['observed_at'] == OBSERVED.isoformat()


def test_resolve_remains_exact_source_authorized_and_does_not_reread_popularity(owner, cache):
    tops, calls = owner
    entry = invoke(tops)['albums'][0]['tracks'][0]
    assert entry['source'] == SOURCE
    cache.rows = [cached_row(count=-1)]
    assert invoke(tops, 'resolve', payload=entry['source']) == {
        'top_ref': TOP, 'source': SOURCE, 'native_target': native_target(701)}
    assert len(cache.reads) == 1 and cache.normalized == [701]
    assert [call[0] for call in calls] == ['capture', 'resolve']
    denied(tops, 'invalid_command', 422, 'resolve', payload={**SOURCE, 'popularity': entry['popularity']})
    assert [call[0] for call in calls] == ['capture', 'resolve']
