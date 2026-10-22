"""Real source-bounded Top cache joins using uniquely owned normal product rows."""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import uuid4

from psycopg.types.json import Jsonb
import pytest

from music_app.services import lastfm_track_popularity as provider
from music_app.services import library_popularity_refresh as refresh
from music_app.services.library_mix_inventory_postgres import inventory_revision, read_inventory
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.popularity_observations_postgres import put_observation
from music_app.services.popularity_snapshots import PopularityObservation
from tests.py.album_top_native_queue_postgres_support import (
    MEDIA, db, urls, native_queue, capture, resolve, record_runtime, seed_track,
)


OBSERVED = datetime(2001, 2, 3, 4, 5, 6, tzinfo=timezone.utc)


@pytest.fixture
def cached_queue(native_queue, monkeypatch):
    case = native_queue
    token = uuid4().hex
    sources = {}

    def no_provider(*args, **kwargs):
        pytest.fail('Top cache reads must not perform provider or refresh work')

    monkeypatch.setattr(provider, 'fetch_track_popularity', no_provider)
    monkeypatch.setattr(refresh, 'fetch_track_popularity', no_provider)
    monkeypatch.setattr(refresh, 'refresh_library_popularity', no_provider)
    try:
        # This extra playable row belongs to the current library, but not the Top.
        outside = seed_track(case.db, case.root, case.root_id, case.db.album_ids[2])
        all_tracks = [*case.tracks, outside]
        recordings = {track['id']: str(uuid4()) for track in all_tracks}
        with case.db.connect() as connection:
            for track in all_tracks:
                connection.execute('''update library.local_track_files set metadata=%s
                    where track_id=%s''', (Jsonb({'scan_cache': {'file_entry': {
                        'musicbrainz_recording_id': recordings[track['id']]}}}), track['id']))
            rows = read_inventory(connection, case.db.library,
                                  track_ids=[track['id'] for track in all_tracks])
            by_id = {row['original_local_track_id']: row for row in rows}
            for index, track in enumerate(all_tracks):
                identity = track['id']
                source = f'https://www.last.fm/music/TopTest-{token}/_/{identity}'
                sources[identity] = source
                count, state = ((42, 'resolved'), (0, 'resolved'), (None, 'missing'),
                                (500, 'ambiguous'), (800, 'resolved'), (900, 'resolved'),
                                (999999, 'resolved'))[index]
                status, _ = put_observation(connection, PopularityObservation(
                    'lastfm', 'overall_scrobbles', source, 'initial', OBSERVED, OBSERVED, count, state))
                assert status == 'accepted'
                if index == 5:
                    continue  # Global facts without a local recording mapping stay unknown.
                revision = str(uuid4())
                fingerprint = '0' * 64 if index == 4 else inventory_revision(by_id[identity])
                connection.execute('''insert into library.track_popularity_mapping_versions
                    (track_id,revision,inventory_revision,recording_mbid,source_entity_id,mapped_at)
                    values(%s,%s,%s,%s,%s,%s)''',
                    (identity, revision, fingerprint, recordings[identity], source, OBSERVED))
                connection.execute('''insert into library.track_popularity_mapping_slots
                    (track_id,current_revision,checked_inventory_revision,last_result,last_attempt_at)
                    values(%s,%s,%s,'ready',%s)''', (identity, revision, fingerprint, OBSERVED))
        yield SimpleNamespace(case=case, sources=sources, outside=outside)
    finally:
        # Only this test's globally keyed source facts need explicit teardown.
        # The existing native_queue/db fixture owns library, mappings and files.
        keys = list(sources.values())
        if keys:
            with case.db.connect() as connection:
                connection.execute('''update catalog.popularity_source_slots set current_revision=null
                    where provider='lastfm' and metric='overall_scrobbles' and source_entity_id=any(%s)''', (keys,))
                connection.execute('''delete from catalog.popularity_source_observations
                    where provider='lastfm' and metric='overall_scrobbles' and source_entity_id=any(%s)''', (keys,))
                connection.execute('''delete from catalog.popularity_source_slots
                    where provider='lastfm' and metric='overall_scrobbles' and source_entity_id=any(%s)''', (keys,))


def test_real_capture_annotates_all_occurrences_from_one_scoped_read_without_writes(cached_queue):
    case = cached_queue.case
    before = case.db.snapshot()
    with record_runtime(case.db) as (statements, opened):
        captured = capture(case)
    assert len(opened) == 1
    facts = [(sql, params) for sql, params, _ in statements
             if sql.startswith('with inventory as (') and 'catalog.popularity_source_observations' in sql]
    assert len(facts) == 1
    assert facts[0][1] == (case.db.library, sorted(track['id'] for track in case.tracks))
    assert 'where t.library_id=%s and t.id=any(%s::bigint[])' in facts[0][0]
    assert not any(sql.split()[0] in {'insert', 'update', 'delete', 'merge'} for sql, _, _ in statements)
    assert [[entry['source']['canonical_track_ref'] for entry in album['tracks']]
            for album in captured['albums']] == [
        [case.tracks[5]['key']], [case.tracks[index]['key'] for index in (2, 3, 1, 0, 4)]]
    assert [[entry['popularity'] for entry in album['tracks']] for album in captured['albums']] == [
        [None], [None, None,
            {'provider': 'lastfm', 'metric': 'overall_scrobbles', 'count': 0, 'observed_at': OBSERVED.isoformat()},
            {'provider': 'lastfm', 'metric': 'overall_scrobbles', 'count': 42, 'observed_at': OBSERVED.isoformat()}, None]]
    assert captured['unavailable_items'] == [] and case.db.snapshot() == before
    assert cached_queue.outside['key'] not in repr(captured)


def test_denied_playable_track_is_excluded_before_real_popularity_join(cached_queue):
    case = cached_queue.case
    denied_id = case.tracks[0]['id']

    def constraints(context):
        resource = context.resource
        blocked = context.action == MEDIA and resource is not None and (
            resource.resource_kind == 'track' and resource.resource_ref == str(denied_id))
        return PolicyEvaluationConstraints(request_origin_allowed=not blocked)

    with record_runtime(case.db) as (statements, _):
        captured = capture(case, constraints=constraints)
    facts = [params for sql, params, _ in statements
             if sql.startswith('with inventory as (') and 'catalog.popularity_source_observations' in sql]
    assert facts == [(case.db.library, sorted(track['id'] for track in case.tracks if track['id'] != denied_id))]
    assert f'inventory-track:{case.db.library}:{denied_id}' not in repr(captured)
    assert str(case.tracks[0]['path']) not in repr(captured)
    assert sum(len(album['tracks']) for album in captured['albums']) == len(case.tracks) - 1


def test_later_cache_observation_changes_only_future_capture_and_not_fresh_resolve(cached_queue):
    case = cached_queue.case
    captured = capture(case)
    entry = captured['albums'][1]['tracks'][3]
    assert entry['source']['canonical_track_ref'] == case.tracks[0]['key']
    original = dict(entry['popularity'])
    later = OBSERVED + timedelta(days=1)
    with case.db.connect() as connection:
        status, _ = put_observation(connection, PopularityObservation(
            'lastfm', 'overall_scrobbles', cached_queue.sources[case.tracks[0]['id']],
            'next', later, later, 2, 'resolved'))
        assert status == 'accepted'
    with record_runtime(case.db) as (statements, _):
        resolved = resolve(case, source=entry['source'])
    assert resolved == {'top_ref': case.receipt['top_ref'], 'source': entry['source'],
                        'native_target': entry['native_target']}
    assert not any('catalog.popularity_source_observations' in sql for sql, _, _ in statements)
    assert entry['popularity'] == original
    current = capture(case)['albums'][1]['tracks'][3]
    assert current['source'] == entry['source']
    assert current['popularity'] == {'provider': 'lastfm', 'metric': 'overall_scrobbles',
                                    'count': 2, 'observed_at': later.isoformat()}
