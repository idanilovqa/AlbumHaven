"""C1 adapter gates, pure cache extraction, and controlled real SQL races.

Observers execute unchanged product SQL against real isolated PostgreSQL.
No mocked connection, ranking, authority or test-only product route is used.
"""
from copy import deepcopy
from dataclasses import asdict
from datetime import timedelta, timezone
from threading import Event

import pytest
from psycopg.types.json import Jsonb

from music_app.services import private_popularity_search_inventory as inventory
from music_app.services import library_mix_inventory_postgres as mix
from music_app.services.private_library_authority import current_library_transaction
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.popularity_search_postgres_support import (
    mix_urls, popular_db, read, native, request, error, set_genre, deny_resource,
    observed_connection, Workers, observe_blocker,
)


def capture(db, *, constraints=None, connect=None, query=':popular'):
    with current_library_transaction(db.app_url, db.context(), connect=connect or db.app_connect,
            clock=lambda: db.clock_time, read_only=True, constraints=constraints) as (con, live, _):
        return inventory.capture(con, live, request(query=query), constraints=constraints)


def test_admission_precedes_every_metadata_facet_and_metric_query(popular_db):
    db = popular_db
    decisions, observations = [], []
    def constraints(ctx):
        if ctx.resource is not None:
            decisions.append((ctx.resource.resource_kind, int(ctx.resource.resource_ref)))
        return PolicyEvaluationConstraints()
    def before(con, sql, params):
        if 'facet_inventory as materialized' in sql:
            assert {('track', track) for track in db.tracks} <= set(decisions)
            assert {('album', album) for album in db.albums} <= set(decisions)
            assert len({identity for kind, identity in decisions if kind == 'artist'}) == 2
            observations.append('cache' if 'cache_facts as materialized' in sql else 'facet')
            assert params['admitted_ids'] == sorted(db.tracks)
    result = capture(db, constraints=constraints, connect=observed_connection(before=before))
    assert observations == ['facet', 'cache']
    assert set(result.matched_rows) == set(db.tracks)
    assert len(result.facet_frame['rows']) == 6


@pytest.mark.parametrize('kind', ['album', 'artist'])
def test_denied_parent_or_artist_never_enters_metadata_frame(popular_db, kind):
    db = popular_db
    with db.connect() as con:
        coordinates = con.execute('select album_id,artist_id from library.local_tracks where id=%s', (db.tracks[0],)).fetchone()
    denied = coordinates[kind + '_id']
    result = capture(db, constraints=deny_resource(kind, denied))
    assert not set(db.tracks[:3]) & set(result.matched_rows)
    assert not set(db.tracks[:3]) & {row['identity']['original_local_track_id'] for row in result.facet_frame['rows']}
    assert result.decision_map[(kind, denied)] is False
    assert result.diagnostics == ()


def test_genre_facet_changes_without_changing_mapping_inventory_identity(popular_db):
    db = popular_db
    before = capture(db)
    with db.connect() as con:
        old = mix.read_inventory(con, db.library)
        old_revisions = {row['original_local_track_id']: mix.inventory_revision(row) for row in old}
        set_genre(con, db.tracks[0], 'progressive rock')
        new = mix.read_inventory(con, db.library)
        assert {row['original_local_track_id']: mix.inventory_revision(row) for row in new} == old_revisions
    after = capture(db)
    assert before.facet_frame_text != after.facet_frame_text
    assert [track.track_id for track in before.tracks] == [track.track_id for track in after.tracks]
    assert before.snapshots == after.snapshots
    assert set(capture(db, query=':popular genre:"progressive rock"').matched_rows) == {db.tracks[0]}


def test_multiple_eligible_genres_keep_file_provenance_and_identity_conflicts(popular_db):
    db = popular_db
    track = db.tracks[0]
    with db.connect() as con:
        row = con.execute('select * from library.local_track_files where track_id=%s', (track,)).fetchone()
        metadata = deepcopy(row['metadata'])
        metadata['scan_cache']['file_entry']['genre'] = 'progressive rock'
        extra = con.execute("""insert into library.local_track_files(track_id,library_root_id,
            private_path,content_signature,metadata) values(%s,%s,%s,'copy',%s) returning id""",
            (track, db.root_id, row['private_path'] + '.copy', Jsonb(metadata))).fetchone()['id']
        db.rebind_mappings(con, [track])
    captured = capture(db, query=':popular genre:"progressive rock"')
    assert set(captured.matched_rows) == {track}
    frame = next(r for r in captured.facet_frame['rows'] if r['identity']['original_local_track_id'] == track)
    assert {r['value'] for r in frame['genres']} == {'jazz','progressive rock'}
    assert len({r['file_id'] for r in frame['genres']}) == 2
    with db.connect() as con:
        # A file can be ineligible for genre yet still participate in the
        # established active/nonstale identity conflict evidence.
        metadata['scan_cache']['file_entry']['exception_type'] = 'Interview'
        metadata['scan_cache']['file_entry']['musicbrainz_recording_id'] = db.recordings[db.tracks[1]]
        con.execute('update library.local_track_files set metadata=%s where id=%s', (Jsonb(metadata), extra))
    result = capture(db, query=':popular genre:jazz')
    assert any(identity == track and reason == 'ambiguous_attribution' for identity, reason in result.diagnostics)
    assert all(item.track_id != track for item in result.tracks)


def test_malformed_observation_fails_instead_of_becoming_zero(popular_db):
    db = popular_db
    with db.connect() as con:
        row = dict(mix.read_inventory(con, db.library)[0])
    for invalid in (True, -1, 9007199254740992, float('nan')):
        bad = dict(row, count=invalid)
        with pytest.raises((ValueError, TypeError)):
            mix.normalize_cached_inventory_row(bad)
    naive = dict(row, observed_at=row['observed_at'].replace(tzinfo=None))
    with pytest.raises(ValueError): mix.normalize_cached_inventory_row(naive)


def test_pure_extraction_matches_real_mix_read_snapshot_and_preserves_grouping(popular_db):
    db = popular_db
    with current_library_transaction(db.app_url, db.context(), connect=db.app_connect,
            clock=lambda: db.clock_time, read_only=True) as (con, live, _):
        rows = mix.read_inventory(con, db.library)
        normalized = [mix.normalize_cached_inventory_row(row) for row in rows]
        snapshot = mix.read_snapshot(con, live, is_readable=lambda _: True)
    assert [candidate.track for candidate in snapshot.candidates] == [item[0] for item in normalized]
    assert snapshot.snapshots == {item[0].track_id: item[1] for item in normalized if item[1] is not None}
    assert snapshot.diagnostics == ()
    assert [candidate.album_ref for candidate in snapshot.candidates] == [
        f'inventory-album:{db.library}:{db.albums[index // 3]}' for index in range(6)]
    # Preserve the pre-existing Mix per-album grouping, not Search quotas.
    result = db.capture(auto=False)
    assert [row['popularity_count'] for row in result['entries']] == [300, 200, 90, 80]


@pytest.mark.parametrize('variation', ['unavailable','no_mapping','stale','provider','no_observation','utc'])
def test_pure_extraction_original_diagnostic_and_observation_contract(popular_db, variation):
    db = popular_db
    with db.connect() as con: row = dict(mix.read_inventory(con, db.library)[0])
    if variation == 'unavailable':
        row['availability'] = 'unresolved'
        assert mix.normalize_cached_inventory_row(row) == (None,None,None)
    elif variation in {'no_mapping','stale','provider'}:
        row['mapping_revision'] = None
        if variation == 'stale': row['checked_inventory_revision'] = 'stale'
        if variation == 'provider': row['last_result'] = 'provider_unavailable'
        expected = 'provider_unavailable' if variation == 'provider' else 'missing_provider_mapping'
        assert mix.normalize_cached_inventory_row(row) == (None,None,expected)
    elif variation == 'no_observation':
        row['source_revision'] = None
        track, snapshot, reason = mix.normalize_cached_inventory_row(row)
        assert track is not None and snapshot is reason is None
    else:
        row['observed_at'] = row['observed_at'].astimezone(timezone(timedelta(hours=5)))
        track, snapshot, reason = mix.normalize_cached_inventory_row(row)
        assert snapshot.observation.observed_at.utcoffset() == timedelta(0)
        assert reason is None


@pytest.mark.parametrize('change', ['genre','category','exception','file','root','artist','insert','precision'])
def test_final_sql_two_gates_reject_changed_complete_frame_without_cache_rows(popular_db, change):
    """Capture params on a finished request, mutate, then execute REAL final SQL.

    This tests SQL dependency, separately from lock/interleaving tests below.
    It does not substitute a Python compare or fabricate a cursor result.
    """
    db = popular_db
    final = []
    def observe(con, sql, params):
        if 'cache_facts as materialized' in sql: final.append((sql, deepcopy(params)))
    read(db, query=':popular genre:jazz', connect=observed_connection(before=observe))
    assert len(final) == 1
    with db.connect() as con:
        if change == 'genre': set_genre(con, db.tracks[-1], 'progressive rock')
        elif change == 'category':
            con.execute("update library.local_albums set metadata=jsonb_set(metadata,'{library_root_category}','\"Hoard\"') where id=%s", (db.albums[-1],))
        elif change == 'exception':
            inserted_overrides = con.execute("""insert into library.exception_overrides(library_id,track_id,track_key,override_payload)
                select %s,track_id,private_path,'{"exception_type":"Interview"}'::jsonb
                from library.local_track_files where track_id=%s returning id""", (db.library, db.tracks[-1])).fetchall()
            db.owned_overrides.update(row['id'] for row in inserted_overrides)
        elif change == 'file':
            con.execute("update library.local_track_files set content_signature='changed' where track_id=%s", (db.tracks[-1],))
        elif change == 'root':
            con.execute('update library.library_roots set is_active=false where id=%s', (db.root_id,))
        elif change == 'artist':
            con.execute("update library.local_artists set name=name || ' Other' where library_id=%s", (db.library,))
        elif change == 'precision':
            con.execute("""update library.local_albums set metadata=jsonb_set(metadata,'{precision}',
                '0.12345678901234567890123456789'::jsonb) where id=%s""", (db.albums[-1],))
        else:
            inserted = con.execute("""insert into library.local_tracks(library_id,track_key,title)
                values(%s,%s,'Unbacked universe phantom') returning id""", (db.library, db.token + ':phantom')).fetchone()['id']
            db.owned_tracks.add(inserted)
    with current_library_transaction(db.app_url, db.context(), connect=db.app_connect,
            clock=lambda: db.clock_time, read_only=True) as (con, live, _):
        rows = con.execute(*final[0]).fetchall()
    assert rows and all(row['capture_ok'] is False for row in rows)
    assert all(row['original_local_track_id'] is None for row in rows)


@pytest.mark.parametrize('change', ['reparent','track_artist','album_artist','delete','insert'])
def test_universe_change_before_identity_locks_aborts_before_new_metadata(popular_db, change):
    db = popular_db
    fired, facet_queries = [], []
    def before(con, sql, params):
        if 'facet_inventory as materialized' in sql: facet_queries.append(sql)
        if fired or 'from library.local_tracks where library_id=%s and id=any' not in sql or 'for update' not in sql:
            return
        fired.append(True)
        with db.connect() as writer:
            if change == 'reparent':
                writer.execute('update library.local_tracks set album_id=%s where id=%s', (db.albums[1], db.tracks[0]))
            elif change == 'track_artist':
                writer.execute('update library.local_tracks set artist_id=(select artist_id from library.local_albums where id=%s) where id=%s', (db.albums[1], db.tracks[0]))
            elif change == 'album_artist':
                writer.execute('update library.local_albums set artist_id=(select artist_id from library.local_albums where id=%s) where id=%s', (db.albums[1], db.albums[0]))
            elif change == 'delete': writer.execute('delete from library.local_tracks where id=%s', (db.tracks[-1],))
            else:
                inserted = writer.execute('insert into library.local_tracks(library_id,track_key,title) values(%s,%s,%s) returning id', (db.library, db.token + ':insert', 'Later')).fetchone()['id']
                db.owned_tracks.add(inserted)
    with pytest.raises(inventory.CaptureChanged):
        capture(db, connect=observed_connection(before=before))
    assert fired
    # Insert cannot be found by the prefix; the first coordinate-gated facet
    # statement must stop all metadata through its false universe gate.
    assert len(facet_queries) == (1 if change == 'insert' else 0)


def test_unlocked_exception_delete_promotes_nonmatch_and_forces_fresh_initial_capture(popular_db):
    db = popular_db
    target = db.tracks[-1]
    with db.connect() as con:
        db.observe(con, target, 999)
        override = con.execute("""insert into library.exception_overrides(library_id,track_id,track_key,override_payload)
            select %s,track_id,private_path,'{"exception_type":"Interview"}'::jsonb
            from library.local_track_files where track_id=%s returning id""", (db.library,target)).fetchone()['id']
        db.owned_overrides.add(override)
    reads, final_params = [], []
    def after(con, sql, params):
        if 'case when g.ok then f.value end as facet_frame' in sql and not reads:
            reads.append(True)
            # Real separate writer; deleting an existing exception does not
            # acquire the inventory parent's FK key-share lock.
            with db.app_connect(db.app_url) as writer:
                writer.execute('delete from library.exception_overrides where id=%s', (override,))
        if 'cache_facts as materialized' in sql: final_params.append(deepcopy(params))
    result = read(db, query=':popular per_artist:1', connect=observed_connection(after=after))
    assert [row['popularity']['count'] for row in result['tracks']] == [999,300]
    assert len(final_params) == 2
    assert target not in final_params[0]['matched_ids'] and target in final_params[1]['matched_ids']


def test_tokened_unlocked_exception_change_never_recaptures(popular_db):
    db = popular_db
    first = read(db, limit=2)
    with db.connect() as con:
        override = con.execute("""insert into library.exception_overrides(library_id,track_id,track_key,override_payload)
            select %s,track_id,private_path,'{"exception_type":""}'::jsonb
            from library.local_track_files where track_id=%s returning id""", (db.library,db.tracks[-1])).fetchone()['id']
        db.owned_overrides.add(override)
    # Publish a family that contains the existing neutral override.
    first = read(db, limit=2)
    captures = []
    def after(con, sql, params):
        if 'case when g.ok then f.value end as facet_frame' in sql:
            captures.append(True)
            with db.app_connect(db.app_url) as writer:
                writer.execute("update library.exception_overrides set override_payload='{" + '"exception_type":"Interview"' + "}'::jsonb where id=%s", (override,))
    error(409, lambda: read(db, limit=2, cursor=first['page']['next_cursor'], connect=observed_connection(after=after)))
    assert len(captures) == 1


@pytest.mark.parametrize('change', ['genre','file','stale','root','insert_file'])
def test_inventory_lock_prefix_excludes_real_late_file_and_genre_writers(popular_db, change):
    db = popular_db
    with Workers() as work:
        reached, release, pause = work.barrier()
        reader_pid, writer_pid = [], []
        fired = []
        def after(con, sql, params):
            if 'case when g.ok then f.value end as facet_frame' in sql and not fired:
                fired.append(True); reader_pid.append(con.info.backend_pid); pause()
        reader = work.start(lambda: read(db, connect=observed_connection(after=after, registry=work.connections)))
        assert reached.wait(8)
        def mutate():
            with work.connections(db.app_url) as con:
                writer_pid.append(con.info.backend_pid)
                if change == 'genre': set_genre(con, db.tracks[-1], 'progressive rock')
                elif change == 'file': con.execute("update library.local_track_files set content_signature='late' where track_id=%s", (db.tracks[-1],))
                elif change == 'stale': con.execute("update library.local_track_files set metadata=jsonb_set(metadata, '{scan_cache,stale}', 'true'::jsonb) where track_id=%s", (db.tracks[-1],))
                elif change == 'root': con.execute('update library.library_roots set is_active=false where id=%s', (db.root_id,))
                else:
                    con.execute("""insert into library.local_track_files(track_id,library_root_id,private_path,content_signature,metadata)
                        select track_id,library_root_id,private_path || '.late','late',metadata from library.local_track_files
                        where track_id=%s""", (db.tracks[-1],))
        started = Event()
        def writer_job():
            started.set(); mutate()
        writer = work.start(writer_job)
        assert started.wait(8)
        # Wait for PID announcement without treating elapsed time as blocking.
        import time
        deadline = time.monotonic() + 8
        while not writer_pid and time.monotonic() < deadline: time.sleep(.01)
        assert writer_pid
        observe_blocker(db, writer_pid[0], reader_pid[0])
        release.set()
        old = reader.result(timeout=15)
        writer.result(timeout=15)
    assert all(con.closed for con in work.connections.items)
    assert old['page']['total_matches'] == 6
    error(409, lambda: native(db, old))


def test_actual_settings_writer_and_native_follow_settings_before_inventory(popular_db):
    """Actual bootstrap selector, settings writer, native owner and SQL locks."""
    from music_app.services import library_roots_postgres as roots
    db = popular_db
    initial = read(db)
    with db.connect() as con:
        settings = con.execute('select settings_payload from library.library_root_settings where library_id=%s', (db.library,)).fetchone()['settings_payload']
    with Workers() as work:
        reached, release, pause = work.barrier()
        reader_pid, writer_pid, ordered = [], [], []
        paused = []
        def before(con, sql, params):
            lowered = sql.lower()
            if 'settings_payload from library.library_root_settings' in lowered:
                ordered.append('settings')
            if 'from library.local_tracks where library_id=%s and id=any' in lowered and 'for update' in lowered:
                assert ordered and ordered[0] == 'settings'
                ordered.append('inventory')
                if not paused:
                    paused.append(True); reader_pid.append(con.info.backend_pid); pause()
        reader = work.start(lambda: native(db, initial, connect=observed_connection(before=before, registry=work.connections)))
        assert reached.wait(8)
        def writer_before(con, sql, params):
            if 'insert into library.library_root_settings' in sql:
                writer_pid.append(con.info.backend_pid)
        writer = work.start(lambda: roots.PostgresLibraryRootSettingsStore(db.config,
            connect=observed_connection(before=writer_before, registry=work.connections)).save_settings(settings))
        import time
        deadline = time.monotonic() + 8
        while not writer_pid and time.monotonic() < deadline: time.sleep(.01)
        assert writer_pid
        observe_blocker(db, writer_pid[0], reader_pid[0])
        release.set()
        assert reader.result(timeout=15)['status'] == 'ready'
        assert writer.result(timeout=15)['version'] == 1
    assert all(con.closed for con in work.connections.items)
    assert ordered[:2] == ['settings','inventory']


def test_alias_projection_readiness_scoped_aliases_and_denied_names(popular_db):
    from music_app.services.library_inventory_postgres import local_inventory_identity_key
    db = popular_db
    with db.connect() as con:
        artists = con.execute(
            'select id,name from library.local_artists where library_id=%s and id=any(%s) order by id',
            (db.library, db.artists)).fetchall()
        assert {artist['id'] for artist in artists} == set(db.artists)
        # Endpoint binding uses the normal inventory identity, not fixture tokens.
        for artist in artists:
            con.execute('update library.local_artists set artist_key=%s where library_id=%s and id=%s',
                        (local_inventory_identity_key(artist['name']), db.library, artist['id']))
    with db.app_connect(db.app_url) as con:
        db.publish_aliases(con, {'Verified alias': artists[0]['name'], artists[1]['name']: artists[0]['name']})
    captured = capture(db, query=':popular artist:"Verified alias"')
    assert set(captured.matched_rows) == set(db.tracks)
    denied = capture(db, query=':popular artist:"Verified alias"', constraints=deny_resource('artist',artists[1]['id']))
    assert set(denied.matched_rows) == set(db.tracks[:3])
    assert artists[1]['name'] not in repr(denied.facet_frame)
    with db.connect() as con:
        con.execute("update library.libraries set metadata=jsonb_set(metadata,'{scan_cache,relation_projection,status}','\"stale\"') where id=%s", (db.library,))
    error(503,lambda:read(db,query=':popular artist:"Verified alias"'))


def test_foreign_library_root_never_supplies_genre_or_cache_admission(popular_db):
    db = popular_db
    foreign = None
    try:
        with db.connect() as con:
            foreign = con.execute('insert into library.libraries(owner_account_id,name) values(%s,%s) returning id',
                (db.accounts[0], 'Foreign ' + db.token)).fetchone()['id']
            root = con.execute('insert into library.library_roots(library_id,root_path) values(%s,%s) returning id',
                (foreign,str(db.root_path) + '-foreign')).fetchone()['id']
            con.execute('update library.local_track_files set library_root_id=%s where track_id=%s', (root,db.tracks[0]))
        value = capture(db)
        assert db.tracks[0] not in value.matched_rows
        assert all(identity != db.tracks[0] for identity,_ in value.diagnostics)
    finally:
        if foreign is not None:
            with db.connect() as con:
                con.execute('update library.local_track_files set library_root_id=%s where track_id=%s', (db.root_id,db.tracks[0]))
                con.execute('delete from library.libraries where id=%s', (foreign,))


def test_exact_postgres_numeric_frame_roundtrip_does_not_false_restart(popular_db):
    db = popular_db
    with db.connect() as con:
        con.execute("""update library.local_albums set metadata=jsonb_set(metadata,'{precision}',
            '0.12345678901234567890123456789'::jsonb) where id=%s""", (db.albums[0],))
    first = read(db,limit=2)
    second = read(db,limit=2,cursor=first['page']['next_cursor'])
    assert second['page']['returned_count'] == 2
    captured = capture(db)
    assert '0.12345678901234567890123456789' in captured.facet_frame_text


@pytest.mark.parametrize('variant', ['NEBULA ORCHESTRA', '  Nebula\tOrchestra  ', 'STRASSE BAND'])
@pytest.mark.parametrize('denied', [False, True])
def test_alias_endpoints_use_exact_resource_identity_normalizer_before_labels(popular_db, variant, denied):
    """Dissimilar control labels isolate alias identity from fuzzy matching.

    Real endpoint publication is required before every admitted alias capture.
    """
    from music_app.services.library_inventory_postgres import local_inventory_identity_key
    from music_app.services.relation_projection_postgres import RELATION_PROJECTION_BUILDER_VERSION
    from music_app.services.view_search import artist_alias_matches_query, split_search_terms
    db = popular_db
    canonical = 'Copper Lantern Collective'
    display = 'Straße Band' if variant == 'STRASSE BAND' else 'Nebula Orchestra'
    terms = split_search_terms(canonical)
    # A matching-algorithm change cannot silently make this alias oracle vacuous.
    assert artist_alias_matches_query(canonical, [], terms)
    assert not artist_alias_matches_query(display, [], terms)
    with db.connect() as con:
        artists = con.execute('select id,name from library.local_artists where library_id=%s order by id', (db.library,)).fetchall()
        for artist, name in ((artists[0], canonical), (artists[1], display)):
            con.execute('update library.local_artists set name=%s,artist_key=%s where id=%s',
                (name,local_inventory_identity_key(name),artist['id']))
        db.rebind_mappings(con, db.tracks)
    with db.app_connect(db.app_url) as con:
        db.publish_aliases(con, {})
    query = ':popular artist:"' + canonical + '"'
    # Real SQL control: without the edge only the canonical artist qualifies.
    control = capture(db,query=query)
    assert set(control.matched_rows) == set(db.tracks[:3])
    with db.app_connect(db.app_url) as con:
        db.publish_aliases(con, {variant:canonical})
    constraints = deny_resource('artist',artists[1]['id']) if denied else None
    result = capture(db,query=query,constraints=constraints)
    if denied:
        assert set(result.matched_rows) == set(db.tracks[:3])
        assert variant not in repr(result.facet_frame)
        assert display not in repr(result.facet_frame)
        assert result.diagnostics == ()
    else:
        assert set(result.matched_rows) == set(db.tracks)


def test_nonmatching_genre_becomes_highest_quota_winner_final_sql_rejects_old_frame(popular_db):
    db = popular_db
    target = db.tracks[-1]
    with db.connect() as con:
        set_genre(con,target,'classical')
        db.observe(con,target,999)
    saved = []
    def observe(con,sql,params):
        if 'cache_facts as materialized' in sql: saved.append((sql,deepcopy(params)))
    before = read(db,query=':popular genre:jazz per_artist:1',connect=observed_connection(before=observe))
    assert [r['popularity']['count'] for r in before['tracks']] == [300,90]
    assert target not in saved[0][1]['matched_ids']
    with db.connect() as con: set_genre(con,target,'jazz')
    with current_library_transaction(db.app_url,db.context(),connect=db.app_connect,
            clock=lambda:db.clock_time,read_only=True) as (con,live,_):
        rows = con.execute(*saved[0]).fetchall()
    assert rows and all(r['capture_ok'] is False and r['original_local_track_id'] is None for r in rows)
    after = read(db,query=':popular genre:jazz per_artist:1')
    assert [r['popularity']['count'] for r in after['tracks']] == [999,300]
    error(409,lambda:native(db,before))


@pytest.mark.parametrize('facet', ['watch_health','category','exception','missing_genre'])
def test_real_eligible_facets_use_gallery_exception_root_and_missing_genre_owners(popular_db, facet):
    db = popular_db
    with db.connect() as con:
        if facet == 'watch_health':
            con.execute("update library.libraries set metadata=jsonb_set(metadata,'{library_watch_health}',%s) where id=%s",
                (Jsonb({db.token:{'status':'unavailable'}}),db.library))
        elif facet == 'category':
            con.execute("update library.local_albums set metadata=jsonb_set(metadata,'{root_provenance}',%s) where id=%s",
                (Jsonb({'primary_category':'hoard','categories':['hoard']}),db.albums[1]))
        elif facet == 'exception':
            inserted_overrides = con.execute("""insert into library.exception_overrides(library_id,track_id,track_key,override_payload)
                select %s,track_id,private_path,'{"exception_type":"Interview"}'::jsonb
                from library.local_track_files where track_id=%s returning id""", (db.library,db.tracks[0])).fetchall()
            db.owned_overrides.update(row['id'] for row in inserted_overrides)
        else:
            con.execute("update library.local_track_files set metadata=metadata #- '{scan_cache,file_entry,genre}' where track_id=%s", (db.tracks[0],))
    if facet == 'missing_genre':
        positive = read(db,query=':popular genre:jazz')
        negative = read(db,query=':popular -genre:classical')
        assert positive['popularity']['matched_local_rows'] == 5
        assert negative['popularity']['matched_local_rows'] == 6
        assert negative['popularity']['missing_genre_local_rows'] == 1
    else:
        result = read(db,categories=('main_library',))
        assert result['popularity']['matched_local_rows'] == {'watch_health':0,'category':3,'exception':5}[facet]
        assert result['page']['total_matches'] == result['popularity']['matched_local_rows']


@pytest.mark.parametrize('compilation', [False, True])
def test_mix_primary_album_artist_and_search_canonical_track_artist_stay_separate(popular_db, compilation):
    db = popular_db
    with db.connect() as con:
        # Put both artist identities in one Album while preserving validated
        # track-artist MBIDs. Album artist cannot become the Search cap key.
        con.execute('update library.local_tracks set album_id=%s where id=any(%s)', (db.albums[0],db.tracks[3:]))
        con.execute("update library.local_albums set metadata=jsonb_set(metadata,'{is_compilation}',%s) where id=%s", (Jsonb(compilation),db.albums[0]))
        db.rebind_mappings(con,db.tracks)
    result = read(db,query=':popular per_artist:1')
    assert [row['popularity']['count'] for row in result['tracks']] == [300,90]
    with current_library_transaction(db.app_url,db.context(),connect=db.app_connect,
            clock=lambda:db.clock_time,read_only=True) as (con,live,_):
        original = mix.read_snapshot(con,live,is_readable=lambda _:True)
        rows = mix.read_inventory(con,db.library)
        assert [candidate.track for candidate in original.candidates] == [mix.normalize_cached_inventory_row(row)[0] for row in rows]
    expected = [f'musicbrainz-artist:{db.artist_mbids[i // 3]}' for i in range(6)] if compilation else [None] * 6
    # Mixed Album-credit tags remain ambiguous for Mix's primary-group owner;
    # compilation deliberately uses each provider-validated track artist.
    assert [candidate.primary_artist_ref for candidate in original.candidates] == expected


def test_observation_change_after_final_statement_is_later_snapshot_and_next_token_restarts(popular_db):
    db = popular_db
    completed = []
    def after(con,sql,params):
        if 'cache_facts as materialized' in sql and not completed:
            completed.append(True)
            with db.app_connect(db.app_url) as writer:
                writer.execute("set local lock_timeout='2s'")
                # Real observation owner, no provider HTTP. A successful commit
                # proves Search holds no source-slot lock across publication.
                db.observe(writer,db.tracks[-1],999)
    result = read(db,limit=2,connect=observed_connection(after=after))
    assert [r['popularity']['count'] for r in result['tracks']] == [300,200]
    assert result['page']['total_matches'] == 6
    error(409,lambda:read(db,limit=2,cursor=result['page']['next_cursor']))
    error(409,lambda:native(db,result))
    assert read(db)['tracks'][0]['popularity']['count'] == 999
