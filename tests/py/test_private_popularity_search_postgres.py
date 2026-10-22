"""C1 real PostgreSQL authority, ranking, continuation and native publication.

Authored only. Runtime requires the repository's separately migrated, guarded
isolated PostgreSQL database and its ordinary minimum-privilege runtime role.
No provider work, playback, app bootstrap or production configuration import.
"""
from dataclasses import replace
from datetime import timedelta
from copy import deepcopy

import pytest
from psycopg.types.json import Jsonb

from music_app.services import private_popularity_search_postgres as search
from music_app.services import private_popularity_search_inventory as inventory
from music_app.services.private_native_targets import PrivateNativeTargets
from music_app.services.private_popularity_search_cursor import PopularitySearchCodec
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.popularity_search_postgres_support import (
    mix_urls, popular_db, read, native, owner, request, error, assert_wire,
    assert_native, SECRET, CONTEXT, set_genre, deny_resource, grant_media,
    observed_connection, Workers, observe_blocker,
)


def test_whole_library_real_ranker_and_canonical_track_artist_cap_before_page(popular_db, monkeypatch):
    db = popular_db
    calls = []
    real = search.select_local_popular_tracks
    def observe(*args, **kwargs):
        calls.append(kwargs.copy())
        return real(*args, **kwargs)
    monkeypatch.setattr(search, 'select_local_popular_tracks', observe)
    first = read(db, query=':popular per_artist:2', limit=3)
    assert_wire(first)
    assert [t['popularity']['count'] for t in first['tracks']] == [300, 200, 90]
    assert first['page']['total_matches'] == 4
    second = read(db, query=':popular per_artist:2', limit=3, cursor=first['page']['next_cursor'])
    assert_wire(second, offset=3)
    assert [t['popularity']['count'] for t in second['tracks']] == [80]
    assert calls and all(c['max_per_artist'] == 2 and c['max_per_group'] is None
                         and c['offset'] == 0 and c['limit'] == 6 for c in calls)
    assert second['page']['next_cursor'] is None


def test_same_named_artists_keep_independent_track_artist_quotas(popular_db):
    db = popular_db
    with db.connect() as con:
        con.execute("update library.local_artists set name='Collision' where library_id=%s", (db.library,))
        db.rebind_mappings(con, db.tracks)
    result = read(db, query=':popular artist:Collision per_artist:1')
    assert [r['popularity']['count'] for r in result['tracks']] == [300, 90]
    assert result['page']['total_matches'] == 2


@pytest.mark.parametrize('change', ['session', 'expired', 'membership', 'account', 'browse'])
def test_current_authority_loss_has_no_publication(popular_db, change):
    db = popular_db
    initial = read(db, limit=2)
    with db.connect() as con:
        if change == 'session':
            con.execute('update app.account_sessions set revoked_at=clock_timestamp() where id=%s', (db.owner.session_id,))
        elif change == 'expired':
            con.execute('update app.account_sessions set idle_expires_at=created_at where id=%s', (db.owner.session_id,))
        elif change == 'membership':
            con.execute('delete from library.library_memberships where account_id=%s and library_id=%s', (db.owner.account_id, db.library))
        elif change == 'account':
            con.execute('update app.accounts set is_active=false,disabled_at=clock_timestamp() where id=%s', (db.owner.account_id,))
        else:
            con.execute("update app.capabilities set revoked_at=clock_timestamp() where account_id=%s and capability_key='library.browse.read'", (db.owner.account_id,))
    error(403, lambda: read(db))
    error(403, lambda: native(db, initial))


def test_another_session_and_library_context_cannot_reuse_page(popular_db):
    db = popular_db
    initial = read(db, limit=2)
    with db.connect() as con:
        other = db.member(con)
    error(409, lambda: read(db, actor=other, limit=2, cursor=initial['page']['next_cursor']))
    error(409, lambda: read(db, context_ref='f' * 64, limit=2, cursor=initial['page']['next_cursor']))
    foreign = replace(db.context(), library_id=db.library + 1)
    error(403, lambda: owner(db).read(foreign, request=request(limit=2), context_ref=CONTEXT, cursor_secret=SECRET))


@pytest.mark.parametrize('kind', ['track', 'album', 'artist'])
def test_denied_coordinates_contribute_neither_labels_counts_nor_diagnostics(popular_db, kind):
    db = popular_db
    with db.connect() as con:
        row = con.execute('select album_id,artist_id from library.local_tracks where id=%s', (db.tracks[0],)).fetchone()
    identifier = db.tracks[0] if kind == 'track' else row[kind + '_id']
    result = read(db, constraints=deny_resource(kind, identifier))
    assert_wire(result)
    omitted = 1 if kind == 'track' else 3
    assert result['popularity']['matched_local_rows'] == 6 - omitted
    assert result['page']['total_matches'] == 6 - omitted
    assert 'Mix Track 0' not in repr(result)
    assert sum(result['popularity']['excluded_local_rows'].values()) == 0


@pytest.mark.parametrize('change', ['missing', 'stale', 'inactive', 'missing_root'])
def test_real_local_availability_excludes_ineligible_files(popular_db, change):
    db = popular_db
    with db.connect() as con:
        if change == 'missing':
            con.execute('delete from library.local_track_files where track_id=%s', (db.tracks[0],))
        elif change == 'stale':
            con.execute("update library.local_track_files set metadata=jsonb_set(metadata, '{scan_cache,stale}', 'true'::jsonb) where track_id=%s", (db.tracks[0],))
        elif change == 'inactive':
            con.execute('update library.library_roots set is_active=false where id=%s', (db.root_id,))
        else:
            # Null root is a real unavailable root coordinate; foreign-library
            # root coverage is independently exercised in the inventory owner.
            con.execute('update library.local_track_files set library_root_id=null where track_id=%s', (db.tracks[0],))
    result = read(db)
    assert result['page']['total_matches'] == (0 if change == 'inactive' else 5)
    assert 'Mix Track 0' not in repr(result)


@pytest.mark.parametrize('state', ['zero', 'missing', 'ambiguous'])
def test_known_zero_is_ranked_and_missing_or_ambiguous_is_unavailable(popular_db, state):
    db = popular_db
    with db.connect() as con:
        if state == 'missing':
            con.execute('update catalog.popularity_source_slots set current_revision=null where source_entity_id=%s', (db.source_ids[db.tracks[0]],))
        else:
            db.observe(con, db.tracks[0], 0 if state == 'zero' else None,
                       state='resolved' if state == 'zero' else 'ambiguous')
    result = read(db)
    assert_wire(result)
    assert result['page']['total_matches'] == (6 if state == 'zero' else 5)
    if state == 'zero':
        assert result['tracks'][-1]['title'] == 'Mix Track 0'
        assert result['tracks'][-1]['popularity']['count'] == 0
    else:
        key = 'missing_global_metric' if state == 'missing' else 'ambiguous_attribution'
        assert result['popularity']['excluded_local_rows'][key] == 1


def test_absent_cache_is_ready_empty_and_freshness_is_null(popular_db):
    db = popular_db
    with db.connect() as con:
        con.execute('update catalog.popularity_source_slots set current_revision=null where source_entity_id=any(%s)', (list(db.source_ids.values()),))
    result = read(db)
    assert_wire(result)
    assert result['tracks'] == [] and result['page']['total_matches'] == 0
    assert result['popularity']['excluded_local_rows']['missing_global_metric'] == 6
    assert result['popularity']['oldest_observed_at'] is result['popularity']['newest_observed_at'] is None
    error(403, lambda: native(db, result, refs=['popular_' + '0' * 64]))


@pytest.mark.parametrize('change', ['count', 'mapping', 'genre', 'category', 'file', 'alias'])
def test_complete_evidence_change_restarts_page_and_action(popular_db, change):
    db = popular_db
    initial = read(db, limit=2)
    with db.connect() as con:
        if change == 'count': db.observe(con, db.tracks[-1], 999)
        elif change == 'mapping': db.rebind_mappings(con, [db.tracks[-1]])
        elif change == 'genre': set_genre(con, db.tracks[-1], 'progressive rock')
        elif change == 'category':
            con.execute("update library.local_albums set metadata=jsonb_set(metadata,'{library_root_category}','\"Hoard\"') where id=%s", (db.albums[-1],))
        elif change == 'file':
            con.execute("update library.local_track_files set content_signature='new' where track_id=%s", (db.tracks[-1],))
        else:
            con.execute("update library.local_artists set name=name || ' Changed' where library_id=%s", (db.library,))
    error(409, lambda: read(db, limit=2, cursor=initial['page']['next_cursor']))
    error(409, lambda: native(db, initial))
    refreshed = read(db)
    assert_wire(refreshed)


@pytest.mark.parametrize('operation', ['bindings', 'single', 'batch'])
def test_whole_command_membership_before_any_native_resolution(popular_db, monkeypatch, operation):
    db = popular_db
    initial = read(db, limit=2)
    second = read(db, limit=2, cursor=initial['page']['next_cursor'])
    calls = []
    real = PrivateNativeTargets.resolve
    def observed(*args, **kwargs):
        calls.append(True)
        return real(*args, **kwargs)
    monkeypatch.setattr(PrivateNativeTargets, 'resolve', observed)
    for invalid in ['popular_' + '0' * 64, second['tracks'][0]['id']]:
        refs = [invalid] if operation == 'single' else [initial['tracks'][0]['id'], invalid]
        error(403, lambda: native(db, initial, operation=operation, refs=refs))
        assert calls == []


@pytest.mark.parametrize('operation', ['bindings', 'single', 'batch'])
def test_native_exact_schema_order_echo_and_no_synthetic_origin(popular_db, operation):
    db = popular_db
    initial = read(db)
    refs = [row['id'] for row in reversed(initial['tracks'])]
    result = native(db, initial, operation=operation, refs=refs)
    assert_native(result, initial, operation, refs[:1] if operation == 'single' else refs)
    assert 'subject_taste' not in repr(result) and 'activity_' not in repr(result)


@pytest.mark.parametrize('intent', ['metadata', 'play', 'details'])
def test_native_intent_permissions_and_all_null_unavailable(popular_db, intent):
    db = popular_db
    initial = read(db)
    constraints = lambda ctx: PolicyEvaluationConstraints(request_origin_allowed=ctx.action != 'library.media.read')
    result = native(db, initial, operation='single', intent=intent, constraints=constraints)
    assert_native(result, initial, 'single', [initial['tracks'][0]['id']])
    item = result['data']
    if intent == 'play':
        assert item['status'] == 'unavailable' and item['native_target'] is None
    elif intent == 'metadata':
        assert item['native_target']['allowed_actions']['can_play'] is False
        assert item['native_target']['playback_state']['can_start_here'] is False


def test_initial_continuation_publication_keep_original_token_family(popular_db):
    db = popular_db
    initial = read(db, limit=2)
    codec = PopularitySearchCodec(SECRET)
    issued = int(db.clock_time.timestamp())
    first = codec.decode(initial['native']['result_token'], 'publication', issued)
    db.clock_time += timedelta(seconds=1799)
    second = read(db, limit=2, cursor=initial['page']['next_cursor'])
    for token, kind in [(second['native']['result_token'], 'publication'), (second['page']['next_cursor'], 'page')]:
        payload = codec.decode(token, kind, int(db.clock_time.timestamp()))
        assert (payload['issued_at'], payload['expires_at']) == (first['issued_at'], first['expires_at'])
    db.clock_time += timedelta(seconds=1)
    error(409, lambda: native(db, second))
    error(409, lambda: read(db, limit=2, cursor=second['page']['next_cursor']))


@pytest.mark.parametrize('operation', ['read', 'single', 'batch', 'bindings'])
def test_final_expiry_discards_all_rows_and_native_targets(popular_db, monkeypatch, operation):
    db = popular_db
    initial = read(db)
    if operation == 'read':
        real = search.select_local_popular_tracks
        def delayed(*args, **kwargs):
            result = real(*args, **kwargs)
            db.clock_time += timedelta(seconds=1800)
            return result
        monkeypatch.setattr(search, 'select_local_popular_tracks', delayed)
        error(409, lambda: read(db))
    else:
        real = PrivateNativeTargets.resolve
        def delayed(*args, **kwargs):
            result = real(*args, **kwargs)
            db.clock_time += timedelta(seconds=1800)
            return result
        monkeypatch.setattr(PrivateNativeTargets, 'resolve', delayed)
        error(409, lambda: native(db, initial, operation=operation))


@pytest.mark.parametrize('previously_allowed', [True, False])
def test_final_policy_rechecks_denied_as_well_as_admitted_resources(popular_db, monkeypatch, previously_allowed):
    db = popular_db
    changed = [False]
    track = db.tracks[-1]
    def constraints(ctx):
        targeted = ctx.resource is not None and ctx.resource.resource_kind == 'track' and ctx.resource.resource_ref == str(track)
        allowed = (not previously_allowed if changed[0] else previously_allowed) if targeted else True
        return PolicyEvaluationConstraints(request_origin_allowed=allowed)
    real = search.select_local_popular_tracks
    def rank(*args, **kwargs):
        value = real(*args, **kwargs)
        changed[0] = True
        return value
    monkeypatch.setattr(search, 'select_local_popular_tracks', rank)
    error(409, lambda: read(db, constraints=constraints))


def test_final_native_media_revoke_removes_play_target(popular_db, monkeypatch):
    db = popular_db
    grant_media(db)
    initial = read(db)
    revoked = [False]
    def constraints(ctx):
        return PolicyEvaluationConstraints(request_origin_allowed=not (revoked[0] and ctx.action == 'library.media.read'))
    real = PrivateNativeTargets.resolve
    def resolve(*args, **kwargs):
        value = real(*args, **kwargs)
        revoked[0] = True
        return value
    monkeypatch.setattr(PrivateNativeTargets, 'resolve', resolve)
    result = native(db, initial, operation='single', intent='play', constraints=constraints)
    assert result['data']['status'] == 'unavailable' and result['data']['native_target'] is None


def _append_mapping(connection, db, track, *, recording, source, artist):
    """New fixture-owned immutable mapping version using the real identity hash."""
    from uuid import uuid4
    from music_app.services.library_mix_inventory_postgres import read_inventory, inventory_revision
    row = read_inventory(connection, db.library, track_ids=[track])[0]
    revision = str(uuid4())
    fingerprint = inventory_revision(row)
    connection.execute("""insert into library.track_popularity_mapping_versions
        (track_id,revision,inventory_revision,recording_mbid,artist_mbid,source_entity_id,mapped_at)
        values(%s,%s,%s,%s,%s,%s,%s)""", (track,revision,fingerprint,recording,artist,source,db.now))
    connection.execute("""insert into library.track_popularity_mapping_slots
        (track_id,current_revision,checked_inventory_revision,last_result,last_attempt_at)
        values(%s,%s,%s,'ready',%s) on conflict(track_id) do update set
        current_revision=excluded.current_revision,checked_inventory_revision=excluded.checked_inventory_revision,
        last_result='ready',last_attempt_at=excluded.last_attempt_at""", (track,revision,fingerprint,db.now))


@pytest.mark.parametrize('provider_collision', [False, True])
def test_canonical_and_provider_copies_use_actual_representative_not_max_count(popular_db, provider_collision):
    db = popular_db
    with db.connect() as con:
        if provider_collision:
            # One provider identity with contradictory canonical recordings is
            # unavailable for both rows, rather than merged by display labels.
            _append_mapping(con, db, db.tracks[1], recording=db.recordings[db.tracks[1]],
                source=db.source_ids[db.tracks[0]], artist=db.artist_mbids[0])
        else:
            con.execute("""update library.local_track_files set metadata=jsonb_set(metadata,
                '{scan_cache,file_entry,musicbrainz_recording_id}',%s) where track_id=%s""",
                (Jsonb(db.recordings[db.tracks[0]]), db.tracks[1]))
            _append_mapping(con, db, db.tracks[1], recording=db.recordings[db.tracks[0]],
                source=db.source_ids[db.tracks[1]], artist=db.artist_mbids[0])
            db.observe(con, db.tracks[1], 999)
    result = read(db)
    if provider_collision:
        assert [r['popularity']['count'] for r in result['tracks']] == [100,90,80,70]
        assert result['popularity']['excluded_local_rows']['ambiguous_attribution'] == 2
    else:
        assert [r['popularity']['count'] for r in result['tracks']] == [300,100,90,80,70]
        assert result['tracks'][0]['title'] == 'Mix Track 0'
        assert result['popularity']['matched_local_rows'] == 6 and result['page']['total_matches'] == 5


def test_equal_count_ties_use_canonical_identity_then_original_local_id(popular_db):
    db = popular_db
    with db.connect() as con:
        for track in db.tracks: db.observe(con, track, 50)
    result = read(db)
    expected = sorted(db.tracks, key=lambda track: (db.recordings[track], track))
    assert [row['title'] for row in result['tracks']] == ['Mix Track ' + str(db.tracks.index(track)) for track in expected]


@pytest.mark.parametrize('count', [101, 5001])
def test_page_size_and_playlist_limit_never_truncate_complete_candidate_universe(popular_db, count):
    db = popular_db
    from uuid import uuid4
    with db.connect() as con:
        seed = con.execute('select artist_id,album_id from library.local_tracks where id=%s', (db.tracks[0],)).fetchone()
        inserted = con.execute("""insert into library.local_tracks(library_id,artist_id,album_id,track_key,title)
            select %s,%s,%s,%s || ':' || n::text,'Extra ' || n::text from generate_series(1,%s) n returning id""",
            (db.library,seed['artist_id'],seed['album_id'],db.token + ':large',count)).fetchall()
        db.owned_tracks.update(row['id'] for row in inserted)
        for row in inserted:
            con.execute("""insert into library.local_track_files(track_id,library_root_id,private_path,content_signature,metadata)
                select %s,library_root_id,private_path || '.' || %s::text,content_signature,metadata
                from library.local_track_files where track_id=%s""", (row['id'],row['id'],db.tracks[0]))
        last = inserted[-1]['id']
        recording = str(uuid4())
        con.execute("""update library.local_track_files set metadata=jsonb_set(metadata,
            '{scan_cache,file_entry,musicbrainz_recording_id}',%s) where track_id=%s""", (Jsonb(recording),last))
        db.source_ids[last] = 'fixture:' + db.token + ':last'
        _append_mapping(con, db, last, recording=recording, source=db.source_ids[last], artist=db.artist_mbids[0])
        db.observe(con, last, 9999)
    result = read(db, limit=1)
    assert result['tracks'][0]['title'] == 'Extra ' + str(count)
    assert result['popularity']['matched_local_rows'] == count + 6
    assert result['popularity']['excluded_local_rows']['missing_provider_mapping'] == count - 1
    assert result['page']['total_matches'] == 7


def test_hostile_unicode_labels_are_bounded_only_at_wire_projection(popular_db):
    db = popular_db
    hostile = '<script>😀&"' * 150
    with db.connect() as con:
        con.execute('update library.local_tracks set title=%s where id=%s', (hostile,db.tracks[0]))
        db.rebind_mappings(con,[db.tracks[0]])
    result = read(db)
    assert_wire(result)
    assert result['tracks'][0]['title'] == hostile[:1024]


def test_final_session_expiry_during_native_resolution_discards_resolved_target(popular_db, monkeypatch):
    db = popular_db
    initial = read(db)
    with db.connect() as con:
        con.execute('update app.account_sessions set idle_expires_at=%s where id=%s', (db.clock_time + timedelta(seconds=1),db.owner.session_id))
    real = PrivateNativeTargets.resolve
    def delayed(*args, **kwargs):
        target = real(*args, **kwargs)
        db.clock_time += timedelta(seconds=2)
        return target
    monkeypatch.setattr(PrivateNativeTargets,'resolve',delayed)
    error(403,lambda:native(db,initial,operation='single'))


def test_reads_and_native_actions_never_call_provider_enqueue_jobs_or_write_cache(popular_db, monkeypatch):
    from music_app.services import library_popularity_refresh as refresh
    from music_app.services import lastfm_track_popularity as provider
    db = popular_db
    calls = []
    def forbidden(*args, **kwargs):
        calls.append(True)
        raise AssertionError('Search performed provider or refresh work')
    monkeypatch.setattr(refresh,'refresh_library_popularity',forbidden)
    monkeypatch.setattr(refresh,'fetch_track_popularity',forbidden)
    monkeypatch.setattr(provider,'fetch_track_popularity',forbidden)
    def state():
        with db.connect() as con:
            return {
                'jobs':con.execute('select * from library.popularity_refresh_jobs where library_id=%s order by library_id',(db.library,)).fetchall(),
                'mapping':con.execute('select * from library.track_popularity_mapping_slots where track_id=any(%s) order by track_id',(db.tracks,)).fetchall(),
                'sources':con.execute('select * from catalog.popularity_source_slots where source_entity_id=any(%s) order by source_entity_id',(list(db.source_ids.values()),)).fetchall(),
            }
    before = state()
    sql_calls = []
    def observe(con, sql, params):
        sql_calls.append(sql)
        lowered = sql.lower()
        assert not any(word in lowered for word in ('insert into ', 'update catalog.', 'update library.', 'delete from '))
        if 'catalog.popularity_source_slots' in lowered or 'library.popularity_refresh_jobs' in lowered:
            assert 'for update' not in lowered
    connect = observed_connection(before=observe)
    result = read(db,limit=2,connect=connect)
    read(db,limit=2,cursor=result['page']['next_cursor'],connect=connect)
    for operation in ('bindings','single','batch'):
        native(db,result,operation=operation,connect=connect)
    assert state() == before and calls == [] and sql_calls


def test_initial_capture_retry_is_bounded_and_cancellation_propagates(popular_db, monkeypatch):
    import asyncio
    db = popular_db
    real = inventory.capture
    calls = []
    def changed(*args, **kwargs):
        # Real authority and transaction are entered; only controlled capture
        # cancellation seam is injected. Concurrency gates have separate tests.
        calls.append(True)
        raise inventory.CaptureChanged()
    monkeypatch.setattr(inventory,'capture',changed)
    error(409,lambda:read(db))
    assert len(calls) == 2
    def cancelled(*args,**kwargs): raise asyncio.CancelledError()
    monkeypatch.setattr(inventory,'capture',cancelled)
    with pytest.raises(asyncio.CancelledError): read(db)
    monkeypatch.setattr(inventory,'capture',real)
    assert read(db)['page']['total_matches'] == 6


@pytest.mark.parametrize('malformation', ['extra_key','bool_duration','numeric_permission','bad_reference','preference_bool_rating'])
def test_native_owner_malformed_schema_never_leaks_partial_target(popular_db, monkeypatch, malformation):
    db = popular_db
    initial = read(db)
    real = PrivateNativeTargets.resolve
    def malformed(*args, **kwargs):
        result = deepcopy(real(*args, **kwargs))
        if malformation == 'extra_key': result['private_debug'] = 'must-not-leak'
        elif malformation == 'bool_duration': result['duration_seconds'] = True
        elif malformation == 'numeric_permission': result['allowed_actions']['can_play'] = 1
        elif malformation == 'bad_reference': result['inventory_track_ref'] = 'inventory-track:999:999'
        else:
            result['track_preference'] = {'rating':True,'love_tier':'off',
                'allowed_actions':{'client_surface_class':'private_web','can_rate':False,'can_set_love_tier':False}}
        return result
    monkeypatch.setattr(PrivateNativeTargets,'resolve',malformed)
    error(503,lambda:native(db,initial,operation='single'))


def test_final_album_media_revoke_downgrades_details_playability(popular_db,monkeypatch):
    db = popular_db
    grant_media(db)
    initial = read(db)
    revoked = [False]
    def constraints(ctx):
        return PolicyEvaluationConstraints(request_origin_allowed=not (revoked[0] and ctx.action == 'library.media.read'))
    real = PrivateNativeTargets.resolve_album
    def resolve(*args,**kwargs):
        value = real(*args,**kwargs)
        revoked[0] = True
        return value
    monkeypatch.setattr(PrivateNativeTargets,'resolve_album',resolve)
    result = native(db,initial,operation='single',intent='details',constraints=constraints)
    assert result['data']['native_target']['allowed_actions'] == {'can_view_details':True,'can_play_album':False}


def test_owned_popularity_cleanup_preserves_canonical_social_rows(monkeypatch, tmp_path):
    from tests.py.popularity_search_bootstrap_support import (
        bootstrap_popularity_db, bootstrap_social_baseline,
    )
    # Exercise the real owned fixture, its ordinary runtime reads and cleanup.
    # Additional test accounts create their own profiles; only their recorded
    # parents may be removed. The canonical profile and policy remain exact.
    with bootstrap_popularity_db(monkeypatch, tmp_path) as db:
        baseline = db.social_baseline
        with db.app_connect(db.app_url) as con:
            assert bootstrap_social_baseline(con, db.library, baseline) == baseline
        with db.connect() as con:
            assert con.execute('select count(*) as n from app.social_profiles').fetchone()['n'] > 1
        real_cleanup = db.cleanup
        cleanups = []
        def checked_cleanup():
            assert not cleanups, 'The context finalizer must invoke cleanup once'
            real_cleanup()
            # The context releases its ownership lease only after this wrapper
            # returns, so committed singleton reads cannot race the next fixture.
            with db.connect() as con:
                assert bootstrap_social_baseline(con, db.library, baseline) == baseline
                assert con.execute('select count(*) as n from app.social_profiles').fetchone()['n'] == 1
                assert con.execute('select count(*) as n from app.friend_policies').fetchone()['n'] == 1
            cleanups.append(True)
        monkeypatch.setattr(db, 'cleanup', checked_cleanup)
    assert cleanups == [True]
