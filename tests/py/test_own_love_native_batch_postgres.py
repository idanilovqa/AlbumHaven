"""Real-session PostgreSQL own-love batch and native-owner equivalence contracts.

Uses the accepted isolated-URL guards and durable native fixture unchanged.
Sessions are issued/resolved by PostgresAuthSessionService; live authority,
ordered row locks, witnesses, preferences and native filesystem checks run.
No runtime-auth replacement, SQL result double or native resolver substitute
provides acceptance. Driver observations only forward real SQL operations.
These service contracts are separate from browser/login E2E and audio output.
"""
from datetime import timedelta
import json
from pathlib import Path
import re

import pytest
from starlette.datastructures import QueryParams

from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_native_targets import NativeTargetError
from music_app.services.relation_projection_postgres import build_ready_relation_projection_metadata
from music_app.services.view_search import PrivateSearchError, normalize_private_search_request
from tests.py.test_own_love_native_target_postgres import (
    BROWSE, MEDIA, SECRET, CONTEXT, connect, isolated_urls, native_db,
)


def ref(db, identifier, *, library=None):
    return f'inventory-track:{db.library if library is None else library}:{identifier}'


def batch(db, identifiers=None, *, resource_refs=None, intent='metadata', query=':loved',
          constraints=None, **params):
    ids = [db.loved] if identifiers is None else identifiers
    request = normalize_private_search_request(QueryParams([
        ('surface', 'albums'), ('q', query), ('search_presentation', 'tracks'),
        *(([('artist', params.pop('artist'))] if 'artist' in params else [('all_artists', '1')])),
        *((key, item) for key, value in params.items()
          for item in (value if isinstance(value, list) else [value])),
    ]))
    db.trace.clear()
    db.opened.clear()
    db.decisions.clear()
    return db.service.resolve_native_targets(db.context, request=request, context_ref=CONTEXT,
        cursor_secret=SECRET, resource_refs=[ref(db, identity) for identity in ids] if resource_refs is None else resource_refs,
        intent=intent, constraints=db.constraints if constraints is None else constraints)


def results(response):
    assert set(response) == {'status', 'contract_version', 'context_ref', 'data'}
    assert response['status'] == 'ready' and response['contract_version'] == 'own-love-native-batch-v1'
    assert response['context_ref'] == CONTEXT and set(response['data']) == {'intent', 'results'}
    return response['data']['results']


def unavailable(item, resource_ref):
    assert item == {'resource_ref': resource_ref, 'status': 'unavailable'}


def ready(item, resource_ref):
    assert set(item) == {'resource_ref', 'status', 'native_target'}
    assert item['resource_ref'] == resource_ref and item['status'] == 'ready'
    assert item['native_target']['inventory_track_ref'] == resource_ref
    return item['native_target']


def fail(db, code='private_search_forbidden', status=403, **options):
    with pytest.raises(PrivateSearchError) as raised:
        batch(db, **options)
    assert (raised.value.code, raised.value.status_code) == (code, status)
    assert all(connection.closed for connection in db.opened)


@pytest.mark.parametrize('intent', ['metadata', 'play'])
def test_one_hundred_witnesses_use_one_native_inventory_batch_and_preserve_request_order(native_db, intent):
    db = native_db
    artist = db.artist('Batch Artist')
    albums = [db.album(artist, f'Batch Album {index}') for index in range(2)]
    ids = [db.track(albums[index % 2], f'Batch Track {index}') for index in range(100)]
    ordered = list(reversed(ids))
    response = batch(db, ordered, intent=intent)
    rows = results(response)
    assert len(rows) == 100 and [item['resource_ref'] for item in rows] == [ref(db, identity) for identity in ordered]
    for item, identity in zip(rows, ordered):
        target = ready(item, ref(db, identity))
        if intent == 'metadata':
            assert target['canonical_track_ref'] == db.tracks[identity]['key']
            assert target['track_preference']['love_tier'] == 'loved'
        else:
            assert target['path'] == str(Path(db.tracks[identity]['path']).resolve())
    witness = [(sql, params, count) for sql, params, count in db.trace
        if 'select * from witnesses where track_id=any(%(native_track_ids)s::bigint[])' in sql]
    assert len(witness) == 1 and witness[0][2] == 100
    assert witness[0][1]['native_track_ids'] == sorted(ids)
    inventory = [(sql, params, count) for sql, params, count in db.trace if 't.id as original_local_track_id' in sql]
    assert len(inventory) == 1 and inventory[0][1] == (db.library, sorted(ids)) and inventory[0][2] == 100
    files = [(sql, params) for sql, params, _ in db.trace
        if sql.startswith('select f.track_id,f.private_path,r.root_path')]
    assert len(files) == (1 if intent == 'play' else 0)
    if files:
        assert files[0][1] == (sorted(ids), db.library)
    assert len(db.opened) == 1 and db.opened[0].closed
    assert not any(re.match(r'(insert|update|delete|merge)\b', sql) for sql, _, _ in db.trace)


@pytest.mark.parametrize('intent', ['metadata', 'play'])
def test_singleton_search_batch_equals_the_existing_single_target(native_db, intent):
    db = native_db
    expected = db.native(intent=intent)['data']['native_target']
    assert ready(results(batch(db, intent=intent))[0], ref(db, db.loved)) == expected


@pytest.mark.parametrize('query,identifier,allowed', [
    (':loved', 'loved', True), ('love:loved', 'obsessed', True),
    (':obsessed', 'loved', False), ('love:obsessed', 'obsessed', True),
    ('-:loved', 'off', True), ('-love:loved', 'absent', True),
    (':loved -:obsessed', 'obsessed', False), (':loved :obsessed', 'obsessed', True),
])
def test_batch_reproves_exact_frozen_own_love_grammar(native_db, query, identifier, allowed):
    db = native_db
    identity = getattr(db, identifier)
    item = results(batch(db, [identity], query=query))[0]
    (ready if allowed else unavailable)(item, ref(db, identity))


def test_unknown_foreign_and_nonmatching_items_are_indistinguishable_and_non_projecting(native_db):
    db = native_db
    refs = [ref(db, db.outside, library=db.libraries[1]), ref(db, 9223372036854775807),
        ref(db, db.loved), ref(db, db.outside), ref(db, db.off)]
    rows = results(batch(db, resource_refs=refs))
    assert len(rows) == len(refs)
    for index in (0, 1, 3, 4):
        unavailable(rows[index], refs[index])
    ready(rows[2], refs[2])
    all_denied = results(batch(db, resource_refs=[refs[0], refs[1], refs[4]]))
    assert len(all_denied) == 3
    for item, resource_ref in zip(all_denied, [refs[0], refs[1], refs[4]]):
        unavailable(item, resource_ref)
    assert len(db.opened) == 1 and db.opened[0].closed


@pytest.mark.parametrize('kind', ['track', 'album', 'artist'])
@pytest.mark.parametrize('intent', ['metadata', 'play'])
def test_per_item_browse_requires_actual_track_parent_and_source_artist(native_db, kind, intent):
    db = native_db
    artist = db.artist('Independent Batch Artist')
    album = db.album(artist, 'Independent Batch Album')
    peer = db.track(album, 'Independent Batch Track')
    denied_id = {'track': db.loved, 'album': db.main_album, 'artist': db.albums[db.main_album]['artist']}[kind]
    db.action_denied.add((BROWSE, kind, str(denied_id)))
    rows = results(batch(db, [peer, db.loved], intent=intent))
    ready(rows[0], ref(db, peer))
    unavailable(rows[1], ref(db, db.loved))


def test_media_denial_is_per_item_and_does_not_hide_current_metadata(native_db):
    db = native_db
    db.action_denied.add((MEDIA, 'track', str(db.loved)))
    rows = results(batch(db, [db.loved, db.obsessed]))
    target = ready(rows[0], ref(db, db.loved))
    assert target['allowed_actions'] == {'can_read': True, 'can_play': False}
    assert target['playback_state'] == {'can_start_here': False}
    assert target == db.native()['data']['native_target']
    rows = results(batch(db, [db.loved, db.obsessed], intent='play'))
    unavailable(rows[0], ref(db, db.loved))
    ready(rows[1], ref(db, db.obsessed))
    with connect(db.setup) as c:
        c.execute('update app.capabilities set revoked_at=now() where account_id=%s and capability_key=%s', (db.account, MEDIA))
    for item, identity in zip(results(batch(db, [db.loved, db.obsessed], intent='play')), [db.loved, db.obsessed]):
        unavailable(item, ref(db, identity))
    assert ready(results(batch(db))[0], ref(db, db.loved))['track_preference']['love_tier'] == 'loved'


@pytest.mark.parametrize('change', ['love', 'delete_track', 'delete_album', 'stale_file', 'inactive_root'])
def test_current_witness_loss_between_metadata_and_play_is_non_projecting(native_db, change):
    db = native_db
    ready(results(batch(db))[0], ref(db, db.loved))
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
    unavailable(results(batch(db, intent='play'))[0], ref(db, db.loved))


@pytest.mark.parametrize('ambiguity', ['two_preferences', 'wrong_track', 'path_collision'])
def test_current_canonical_conflict_withholds_only_the_conflicted_candidate(native_db, ambiguity):
    db = native_db
    candidate = db.track(db.main_album, 'Batch Conflicted Native', tier=None)
    if ambiguity == 'two_preferences':
        db.preference(candidate, 'loved')
        db.preference(candidate, 'off', key=db.tracks[candidate]['path'])
    elif ambiguity == 'wrong_track':
        db.preference(candidate, 'loved', target=db.loved)
    else:
        db.track(db.main_album, 'Batch Path Collision', key=db.tracks[candidate]['path'])
        db.preference(candidate, 'loved')
    for query in (':loved', '-:obsessed'):
        rows = results(batch(db, [candidate, db.loved], query=query))
        unavailable(rows[0], ref(db, candidate))
        ready(rows[1], ref(db, db.loved))


def test_current_parent_category_and_source_artist_replace_stale_candidate_facts(native_db):
    db = native_db
    artist = db.artist('Moved Batch Artist')
    album = db.album(artist, 'Moved Batch Album')
    with connect(db.setup) as c:
        c.execute('update library.local_tracks set album_id=%s where id=%s', (album, db.loved))
        c.execute("update library.local_albums set metadata=jsonb_set(metadata,'{root_provenance}',%s::jsonb) where id=%s",
            (json.dumps({'primary_category': 'hoard', 'categories': ['hoard']}), album))
    unavailable(results(batch(db, category=['main_library']))[0], ref(db, db.loved))
    target = ready(results(batch(db, category=['hoard']))[0], ref(db, db.loved))
    assert target['album_title'] == 'Moved Batch Album'
    unavailable(results(batch(db, gallery_scope='new_arrivals'))[0], ref(db, db.loved))
    unavailable(results(batch(db, artist='Middle Artist', category=['main_library', 'hoard']))[0], ref(db, db.loved))
    ready(results(batch(db, artist='Moved Batch Artist', category=['hoard']))[0], ref(db, db.loved))
    db.action_denied.add((BROWSE, 'artist', str(artist)))
    unavailable(results(batch(db, category=['hoard']))[0], ref(db, db.loved))


def test_selected_artist_alias_is_resolved_once_and_stale_projection_fails_whole_batch(native_db):
    db = native_db
    canonical, alias = 'Batch Canonical Artist', 'Batch Raw Alias'
    artist = db.artist(alias)
    album = db.album(artist, 'Batch Aliased Album')
    ids = [db.track(album, f'Batch Aliased Track {index}') for index in range(4)]
    views = {'alias_to_canonical': {alias: canonical}, 'canonical_to_aliases': {canonical: [alias]},
        'artists': [], 'artists_sidebar': [], 'family_to_artists': {}, 'folder_related': {}, 'sidebar_families': []}
    readiness = build_ready_relation_projection_metadata(db.token, reason='native_batch_fixture', duration_ms=0)
    with connect(db.setup) as c:
        c.execute("update library.libraries set metadata=jsonb_set(metadata,'{scan_cache}',%s::jsonb) where id=%s",
            (json.dumps({'relation_views': views, 'relation_projection': readiness}), db.library))
    for requested in (alias, canonical):
        rows = results(batch(db, ids, artist=requested))
        for item, identity in zip(rows, ids):
            ready(item, ref(db, identity))
        assert sum('select distinct artist_id, artist_name from witnesses' in sql for sql, _, _ in db.trace) == 1
    with connect(db.setup) as c:
        c.execute("update library.libraries set metadata=jsonb_set(metadata,'{scan_cache,relation_projection,status}','\"stale\"'::jsonb) where id=%s", (db.library,))
    fail(db, code='private_search_unavailable', status=503, identifiers=ids, artist=canonical)


def test_selected_artist_losing_its_last_love_witness_does_not_broaden_to_all_artists(native_db):
    db = native_db
    artist = db.artist('Last Batch Witness Artist')
    album = db.album(artist, 'Last Batch Witness Album')
    identity = db.track(album, 'Last Batch Witness Track')
    ready(results(batch(db, [identity], artist='Last Batch Witness Artist'))[0], ref(db, identity))
    with connect(db.setup) as c:
        c.execute("update app.track_preferences set love_tier='off' where account_id=%s and track_id=%s", (db.account, identity))
    rows = results(batch(db, [identity, db.loved], artist='Last Batch Witness Artist'))
    unavailable(rows[0], ref(db, identity))
    unavailable(rows[1], ref(db, db.loved))


def test_ambiguous_current_selected_artist_is_a_whole_failure(native_db):
    db = native_db
    other_artist = db.artist('Middle Artist')
    other_album = db.album(other_artist, 'Distinct Same-Name Artist Album')
    other_track = db.track(other_album, 'Distinct Same-Name Artist Track')
    fail(db, identifiers=[db.loved, other_track], artist='Middle Artist')


def test_own_actor_and_current_library_are_reproved_without_other_person_taste(native_db):
    db = native_db
    first = results(batch(db, [db.loved, db.off]))
    ready(first[0], ref(db, db.loved))
    unavailable(first[1], ref(db, db.off))
    db.activate(account=db.accounts[1])
    second = results(batch(db, [db.loved, db.off]))
    unavailable(second[0], ref(db, db.loved))
    assert ready(second[1], ref(db, db.off))['track_preference']['love_tier'] == 'loved'
    db.activate(account=db.accounts[0], library=db.libraries[1])
    assert ready(results(batch(db, [db.outside], intent='play'))[0], ref(db, db.outside))['path'] == db.tracks[db.outside]['path']


@pytest.mark.parametrize('failure', ['missing', 'directory', 'outside_configured', 'outside_inventory_root',
    'missing_settings', 'wrong_library_settings'])
def test_actual_bulk_play_rechecks_files_and_both_root_owners(native_db, tmp_path, failure):
    db = native_db
    path = Path(db.tracks[db.loved]['path'])
    other = tmp_path / 'batch-other-root'
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
    unavailable(results(batch(db, intent='play'))[0], ref(db, db.loved))
    ready(results(batch(db))[0], ref(db, db.loved))


def test_one_missing_file_does_not_hide_a_valid_peer(native_db):
    db = native_db
    Path(db.tracks[db.loved]['path']).unlink()
    rows = results(batch(db, [db.loved, db.obsessed], intent='play'))
    unavailable(rows[0], ref(db, db.loved))
    ready(rows[1], ref(db, db.obsessed))


def test_fresh_play_uses_changed_path_for_the_same_inventory_identity(native_db):
    db = native_db
    old = ready(results(batch(db, intent='play'))[0], ref(db, db.loved))['path']
    replacement = Path(old).with_name('replacement.flac')
    replacement.write_bytes(b'changed-native-file')
    with connect(db.setup) as c:
        c.execute('update library.local_track_files set private_path=%s where track_id=%s', (str(replacement), db.loved))
    target = ready(results(batch(db, intent='play'))[0], ref(db, db.loved))
    assert target['path'] == str(replacement.resolve()) and target['path'] != old


def test_root_changes_override_process_snapshot_without_a_fallback_connection(native_db, tmp_path, monkeypatch):
    db = native_db
    from music_app.services import library_roots

    def forbidden(*_args, **_kwargs):
        pytest.fail('Batch Search opened an independent settings connection or consulted bootstrap roots')

    # This is a failure tripwire, not a replacement authority or SQL result.
    # The actual media resolver must complete using explicit same-read roots.
    monkeypatch.setattr(library_roots, 'load_library_root_settings', forbidden)
    monkeypatch.setattr(library_roots.PostgresLibraryRootSettingsStore, '_connect_to_database', forbidden)
    original = Path(db.tracks[db.loved]['path']).parent
    replacement = tmp_path / 'batch-replacement-root'
    replacement.mkdir()
    db.config['_library_root_paths_snapshot'] = (replacement,)
    ready(results(batch(db, intent='play'))[0], ref(db, db.loved))
    db.settings(db.library, [replacement])
    unavailable(results(batch(db, intent='play'))[0], ref(db, db.loved))
    db.settings(db.library, [original])
    ready(results(batch(db, intent='play'))[0], ref(db, db.loved))
    assert len(db.opened) == 1 and db.opened[0].closed
    assert sum('settings_payload from library.library_root_settings' in sql for sql, _, _ in db.trace) == 1


def test_symlink_escape_cannot_become_a_batch_play_path(native_db, tmp_path):
    db = native_db
    path = Path(db.tracks[db.loved]['path'])
    escaped = tmp_path / 'outside-batch.flac'
    escaped.write_bytes(b'outside-batch-root')
    path.unlink()
    try:
        path.symlink_to(escaped)
    except (OSError, NotImplementedError):
        pytest.skip('This platform does not permit file symlinks')
    unavailable(results(batch(db, intent='play'))[0], ref(db, db.loved))


def test_malformed_settings_and_missing_infrastructure_are_whole_failures(native_db):
    db = native_db
    with connect(db.setup) as c:
        c.execute("update library.library_root_settings set settings_payload='{}'::jsonb where library_id=%s", (db.library,))
    fail(db, code='private_search_unavailable', status=503, intent='play')
    ready(results(batch(db))[0], ref(db, db.loved))
    db.service._url = ''
    fail(db, code='private_search_unavailable', status=503)


@pytest.mark.parametrize('change', ['membership', 'browse_grant', 'account', 'disabled_account',
    'library_deleted', 'session', 'idle_expired', 'absolute_expired'])
def test_live_authority_and_real_sessions_override_the_stale_actor(native_db, change):
    db = native_db
    batch(db, intent='play')
    with connect(db.setup) as c:
        if change == 'membership':
            c.execute('delete from library.library_memberships where account_id=%s and library_id=%s', (db.account, db.library))
        elif change == 'browse_grant':
            c.execute('update app.capabilities set revoked_at=now() where account_id=%s and capability_key=%s', (db.account, BROWSE))
        elif change == 'account':
            c.execute('update app.accounts set is_active=false where id=%s', (db.account,))
        elif change == 'disabled_account':
            c.execute('update app.accounts set disabled_at=now() where id=%s', (db.account,))
        elif change == 'library_deleted':
            c.execute('delete from library.libraries where id=%s', (db.library,))
        elif change == 'session':
            c.execute('update app.account_sessions set revoked_at=now() where id=%s', (db.sessions[db.account],))
        elif change == 'idle_expired':
            c.execute('update app.account_sessions set idle_expires_at=%s where id=%s', (db.now + timedelta(seconds=30), db.sessions[db.account]))
        else:
            c.execute('update app.account_sessions set idle_expires_at=%s,absolute_expires_at=%s where id=%s',
                (db.now + timedelta(seconds=30), db.now + timedelta(seconds=60), db.sessions[db.account]))
    if change in {'idle_expired', 'absolute_expired'}:
        db.service._clock = lambda: db.now + timedelta(minutes=2)
    fail(db, intent='play')


def test_real_final_session_check_discards_a_fully_resolved_batch(native_db):
    db = native_db
    checks = []

    def clock():
        checks.append(True)
        return db.now if len(checks) == 1 else db.now + timedelta(hours=3)

    db.service._clock = clock
    fail(db, identifiers=[db.loved, db.obsessed], intent='play')
    assert len(checks) == 2
    assert sum('from app.account_sessions' in sql and 'for update' in sql for sql, _, _ in db.trace) == 2
    assert any('t.id as original_local_track_id' in sql for sql, _, _ in db.trace)


def test_final_browse_recheck_discards_an_already_resolved_batch(native_db):
    db = native_db
    checks = []

    def constraints(context):
        if context.action == BROWSE and context.resource is None:
            checks.append(True)
        return PolicyEvaluationConstraints(request_origin_allowed=len(checks) < 3)

    fail(db, intent='play', constraints=constraints)
    assert len(checks) == 3


def test_ordered_candidate_parent_native_locks_and_settings_share_one_authority_connection(native_db):
    db = native_db
    artist = db.artist('Batch Lock Artist')
    album = db.album(artist, 'Batch Lock Album')
    peer = db.track(album, 'Batch Lock Track')
    ids = sorted([db.loved, peer])
    batch(db, list(reversed(ids)), intent='play')
    queries = [sql for sql, _, _ in db.trace]
    assert queries[0] == 'set transaction isolation level read committed'

    def position(fragment, lock):
        return next(index for index, sql in enumerate(queries) if fragment in sql and lock in sql)

    account = position('from app.accounts where id=any', 'order by id for share')
    session = position('from app.account_sessions', 'for update')
    library = position('from library.library_memberships', 'for share of m,l')
    settings = position('from library.library_root_settings', 'for share')
    track = position('select id,album_id from library.local_tracks', 'order by id for update')
    parent = position('select id from library.local_albums', 'order by id for share')
    native_artist = position('select id from library.local_artists', 'for share')
    files = position('select id from library.local_track_files', 'for share')
    root = position('select id from library.library_roots', 'for share')
    assert account < session < library < settings < track < parent < native_artist < files < root
    assert db.trace[track][1] == (db.library, ids)
    assert db.trace[parent][1] == (db.library, sorted([db.main_album, album]))
    assert db.trace[settings][1] == (db.library,)
    assert queries[-1].startswith('select id, account_id, authenticated_at')
    assert len(db.opened) == 1 and db.opened[0].closed
    with connect(db.runtime) as c:
        c.execute("set local lock_timeout='1s'")
        c.execute('select id from app.accounts where id=%s for update nowait', (db.account,))
        c.execute('select id from app.account_sessions where id=%s for update nowait', (db.sessions[db.account],))
        c.execute('select id from library.libraries where id=%s for update nowait', (db.library,))
        c.execute('select library_id from library.library_root_settings where library_id=%s for update nowait', (db.library,))
        c.execute('select id from library.local_tracks where id=any(%s::bigint[]) order by id for update nowait', (ids,))
        c.execute('select id from library.local_albums where id=any(%s::bigint[]) order by id for update nowait', (sorted([db.main_album, album]),))
        c.execute('select id from library.library_roots where id=%s for update nowait', (db.roots[db.library],))


@pytest.mark.parametrize('variant', ['normal', 'nullable_artist', 'alias_preference', 'no_preference',
    'canonical_conflict', 'media_denied', 'preference_editable', 'unresolved', 'missing'])
def test_native_metadata_batch_is_exactly_singleton_equivalent_on_the_real_owner(native_db, variant):
    db = native_db
    identity = db.loved
    if variant == 'alias_preference':
        identity = db.track(db.main_album, 'Batch Alias Preference', tier=None)
        db.preference(identity, 'loved', key=db.tracks[identity]['path'])
    elif variant == 'no_preference':
        identity = db.absent
    elif variant == 'canonical_conflict':
        db.preference(identity, 'off', key=db.tracks[identity]['path'])
    elif variant == 'media_denied':
        db.action_denied.add((MEDIA, 'track', str(identity)))
    else:
        with connect(db.setup) as c:
            if variant == 'nullable_artist':
                c.execute('update library.local_tracks set artist_id=null where id=%s', (identity,))
            elif variant == 'preference_editable':
                c.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,'library.track_preferences.manage','library',%s)", (db.account, db.library))
            elif variant in {'unresolved', 'missing'}:
                metadata = {'scan_cache': {'stale': True, 'stale_marked_at': db.now.isoformat()}}
                c.execute('update library.local_track_files set metadata=%s::jsonb where track_id=%s', (json.dumps(metadata), identity))
                if variant == 'missing':
                    Path(db.tracks[identity]['path']).unlink()
                    c.execute("update library.library_roots set metadata=metadata||'{\"root_id\":\"batch-missing-root\"}'::jsonb where id=%s", (db.roots[db.library],))
    with db.service._authorized(db.context, db.constraints) as (connection, live, _):
        owner = db.service._native_targets(connection, live, intent='metadata')
        expected = owner.resolve(connection, live, identity, intent='metadata', constraints=db.constraints)
        actual = owner.resolve_metadata_batch(connection, live, [identity], constraints=db.constraints)
        assert actual == {identity: expected}
        assert actual[identity]['inventory_track_ref'] == ref(db, identity)
        if variant == 'nullable_artist':
            assert expected['artist'] is None
        if variant in {'canonical_conflict', 'unresolved', 'missing'}:
            assert expected['track_ref'] is expected['canonical_track_ref'] is expected['track_preference'] is None
        if variant == 'media_denied':
            assert expected['allowed_actions']['can_play'] is expected['playback_state']['can_start_here'] is False
        if variant == 'preference_editable':
            assert expected['track_preference']['allowed_actions'] == {
                'client_surface_class': 'private_web', 'can_rate': True, 'can_set_love_tier': True}
        if variant == 'alias_preference':
            assert expected['canonical_track_ref'] == db.tracks[identity]['key']
            assert expected['track_preference']['love_tier'] == 'loved'
        if variant == 'no_preference':
            assert expected['canonical_track_ref'] == db.tracks[identity]['key']
            assert expected['track_preference']['love_tier'] == 'off'
        if variant in {'unresolved', 'missing'}:
            assert expected['availability'] == variant


def test_native_batch_omits_missing_and_browse_denied_rows_without_changing_singleton_failures(native_db):
    db = native_db
    missing = 9223372036854775807
    db.action_denied.add((BROWSE, 'track', str(db.loved)))
    with db.service._authorized(db.context, db.constraints) as (connection, live, _):
        owner = db.service._native_targets(connection, live, intent='metadata')
        actual = owner.resolve_metadata_batch(connection, live, [db.loved, missing, db.obsessed], constraints=db.constraints)
        assert set(actual) == {db.obsessed}
        for identity, code in [(db.loved, 'forbidden'), (missing, 'item_unavailable')]:
            with pytest.raises(NativeTargetError) as raised:
                owner.resolve(connection, live, identity, intent='metadata', constraints=db.constraints)
            assert raised.value.code == code


def test_existing_bulk_play_and_singleton_details_are_unchanged_by_metadata_companion(native_db):
    db = native_db
    with db.service._authorized(db.context, db.constraints) as (connection, live, _):
        owner = db.service._native_targets(connection, live, intent='play')
        ids = [db.obsessed, db.loved]
        before = owner.resolve_play_queue(connection, live, ids, constraints=db.constraints)
        details = owner.resolve(connection, live, db.loved, intent='details', constraints=db.constraints)
        metadata = owner.resolve_metadata_batch(connection, live, ids, constraints=db.constraints)
        assert len(metadata) == 2
        assert owner.resolve_play_queue(connection, live, ids, constraints=db.constraints) == before
        for identity in ids:
            assert owner.resolve(connection, live, identity, intent='play', constraints=db.constraints) == before[identity]
        assert owner.resolve(connection, live, db.loved, intent='details', constraints=db.constraints) == details


@pytest.mark.parametrize('intent', ['metadata', 'play'])
def test_search_batch_preserves_nullable_artist_from_the_actual_native_owner(native_db, intent):
    db = native_db
    with connect(db.setup) as c:
        c.execute('update library.local_tracks set artist_id=null where id=%s', (db.loved,))
    expected = db.native(intent=intent)['data']['native_target']
    target = ready(results(batch(db, intent=intent))[0], ref(db, db.loved))
    assert target == expected and target['artist'] is None


def test_batch_actions_do_not_put_paths_or_native_grants_into_search_read_dtos(native_db):
    db = native_db
    request = normalize_private_search_request(QueryParams({'surface': 'albums', 'q': ':loved',
        'all_artists': '1', 'search_presentation': 'tracks'}))

    def read():
        return db.service.read(db.context, request=request, context_ref=CONTEXT, cursor_secret=SECRET, constraints=db.constraints)

    before = read()
    batch(db, [db.loved, db.obsessed], intent='metadata')
    batch(db, [db.loved, db.obsessed], intent='play')
    after = read()
    assert before == after and after['contract_version'] == 'own-love-v1'
    for row in after['tracks']:
        assert row['canonical_track_ref'] is None
        assert row['allowed_actions'] == {'can_read': True, 'can_select': True}
        assert not {'path', 'native_target', 'playback_state', 'origin', 'grant'} & row.keys()
    assert all(track['path'] not in json.dumps(after) for track in db.tracks.values())
