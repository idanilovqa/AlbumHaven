"""Real Top queue SQL, caller authority, native inventory and filesystem contracts."""
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

import pytest

from music_app.services.owned_album_tops import AlbumTopError
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_native_targets import PrivateNativeTargets
from tests.py.album_top_native_queue_postgres_support import (
    MEDIA, db, urls, native_queue, emitted_source, capture, resolve, record_runtime,
)
from tests.py.postgres_runtime_role_contract import assert_runtime_role
from tests.py.test_owned_album_tops_postgres import assert_error
from tests.py.test_album_top_collaboration_postgres import member, write
from tests.py.test_album_top_native_targets_postgres import edition


@pytest.mark.parametrize('role', ['owner', 'viewer'])
def test_runtime_role_captures_complete_order_and_revalidates_exact_native_source_without_receipts(native_queue, role):
    case = native_queue
    current = case.db.owner
    receipt = case.receipt
    if role == 'viewer':
        current = member(case.db, grants=('capability.view', 'capability.play'))
        receipt, _ = write(case.db, 'grant_viewer', receipt, account_id=current.account_id, role='viewer')
    before = case.db.snapshot()
    with record_runtime(case.db) as (statements, opened):
        result = capture(case, actor=current, receipt=receipt)
        assert [row['catalog_ref'] for row in result['albums']] == list(reversed(case.db.album_refs[:2]))
        expected = [[case.tracks[5]], [case.tracks[index] for index in (2, 3, 1, 0, 4)]]
        assert result['unavailable_items'] == []
        assert set(result) == {'top_ref', 'revision', 'albums', 'unavailable_items'}
        assert result['top_ref'] == receipt['top_ref'] and result['revision'] == receipt['revision']
        for album, tracks in zip(result['albums'], expected):
            assert len(album['tracks']) == len(tracks)
            assert set(album) == {'item_ref', 'catalog_ref', 'inventory_album_ref', 'album_ref', 'tracks'}
            for entry, track in zip(album['tracks'], tracks):
                source = emitted_source(case, track, receipt)
                assert entry['source'] == source
                assert entry['queue_item_ref'] == f"{source['item_ref']}:{track['id']}"
                assert entry['native_target']['path'] == str(track['path'].resolve())
                assert entry['native_target']['track_ref'] == str(track['path'].resolve())
                assert entry['native_target']['inventory_track_ref'] == source['inventory_track_ref']
                resolved = resolve(case, source=source, actor=current, receipt=receipt)
                assert resolved == {'top_ref': receipt['top_ref'], 'source': source, 'native_target': entry['native_target']}
                assert Path(resolved['native_target']['path']).is_file()
        assert len(opened) >= 1 + len(case.tracks)
        assert not any(sql.split()[0] in {'insert', 'update', 'delete', 'merge'} for sql, _, _ in statements)
    assert case.db.snapshot() == before
    with case.db.service._connect(case.db.app_url) as connection:
        assert_runtime_role(connection, case.db)
        assert connection.execute("""select
            has_table_privilege(current_user,'catalog.release_groups','UPDATE') as catalog_update,
            has_table_privilege(current_user,'library.catalog_album_links','UPDATE') as links_update""").fetchone() == {
                'catalog_update': False, 'links_update': False}


@pytest.mark.parametrize('operation', ['capture', 'resolve'])
@pytest.mark.parametrize('scope', ['caller', 'library', 'deleted_top'])
def test_unrelated_account_foreign_library_and_deleted_top_are_unavailable(native_queue, operation, scope):
    case = native_queue
    current = member(case.db, grants=('capability.view', 'capability.play'))
    source = emitted_source(case)
    if scope == 'library':
        with case.db.connect() as connection:
            library = case.db.library_for(connection, case.db.owner)
        current = member(case.db, library=library, grants=('capability.view', 'capability.play'))
    elif scope == 'deleted_top':
        current = case.db.owner
        with case.db.connect() as connection:
            connection.execute('update app.album_lists set deleted_at=now() where ref=%s', (case.receipt['top_ref'],))
    before = case.db.snapshot()
    if operation == 'capture':
        assert_error(lambda: capture(case, actor=current), 'top_unavailable', 404)
    else:
        assert_error(lambda: resolve(case, source=source, actor=current),
                     'item_unavailable' if scope == 'library' else 'top_unavailable', 404)
    assert case.db.snapshot() == before and case.probes == []


@pytest.mark.parametrize('operation', ['capture', 'resolve'])
@pytest.mark.parametrize('revocation', ['session', 'session_expiry', 'capabilities', 'membership', 'viewer_grant'])
def test_stale_viewer_snapshot_never_survives_live_authority_revocation(native_queue, operation, revocation):
    case = native_queue
    viewer = member(case.db, grants=('capability.view', 'capability.play'))
    receipt, _ = write(case.db, 'grant_viewer', case.receipt, account_id=viewer.account_id, role='viewer')
    source = emitted_source(case, receipt=receipt)
    assert resolve(case, source=source, actor=viewer, receipt=receipt)['native_target']
    case.probes.clear()
    with case.db.connect() as connection:
        if revocation == 'session':
            connection.execute('update app.account_sessions set revoked_at=now() where id=%s', (viewer.session_id,))
        elif revocation == 'session_expiry':
            connection.execute("update app.account_sessions set idle_expires_at=now()-interval '1 second' where id=%s", (viewer.session_id,))
        elif revocation == 'capabilities':
            connection.execute('update app.capabilities set revoked_at=now() where account_id=%s', (viewer.account_id,))
        elif revocation == 'membership':
            connection.execute('delete from library.library_memberships where account_id=%s and library_id=%s',
                               (viewer.account_id, case.db.library))
        else:
            connection.execute('delete from app.album_list_access_grants where ref=%s', (receipt['grant_ref'],))
    callback = (lambda: capture(case, actor=viewer, receipt=receipt)) if operation == 'capture' else (
        lambda: resolve(case, source=source, actor=viewer, receipt=receipt))
    assert_error(callback, 'top_unavailable' if revocation == 'viewer_grant' else 'forbidden',
                 404 if revocation == 'viewer_grant' else 403)
    assert case.probes == []


@pytest.mark.parametrize('action', ['library.browse.read', MEDIA])
@pytest.mark.parametrize('kind', ['album', 'track'])
def test_actual_viewer_resource_denials_skip_or_reject_without_file_or_title_leak(native_queue, action, kind):
    case = native_queue
    viewer = member(case.db, grants=('capability.view', 'capability.play'))
    receipt, _ = write(case.db, 'grant_viewer', case.receipt, account_id=viewer.account_id, role='viewer')
    track = case.tracks[0]
    source = emitted_source(case, track, receipt)
    seen = []

    def constraints(context):
        resource = context.resource
        seen.append(context)
        blocked = context.actor.account_id == viewer.account_id and context.action == action and resource is not None and (
            resource.resource_kind == kind and resource.resource_ref == str(track['album_id'] if kind == 'album' else track['id']))
        return PolicyEvaluationConstraints(request_origin_allowed=not blocked)

    # The owner can still resolve the same tuple; the viewer cannot borrow it.
    assert resolve(case, source=source, receipt=receipt, constraints=constraints)['native_target']
    case.probes.clear()
    result = capture(case, actor=viewer, receipt=receipt, constraints=constraints)
    assert source['inventory_track_ref'] not in repr(result)
    assert str(track['path']) not in repr(result) and track['title'] not in repr(result)
    assert str(track['path']) not in case.probes
    if kind == 'album':
        assert source['inventory_album_ref'] not in repr(result)
    assert {'item_ref': source['item_ref'], 'reason': 'unavailable' if kind == 'album' else 'tracks_unavailable'} in result['unavailable_items']
    assert_error(lambda: resolve(case, source=source, actor=viewer, receipt=receipt, constraints=constraints), 'forbidden', 403)
    assert any(ctx.actor.account_id == viewer.account_id and ctx.action == action for ctx in seen)


@pytest.mark.parametrize('mapping', ['missing', 'moved', 'ambiguous', 'empty_key', 'foreign_only'])
def test_same_top_revision_cannot_resolve_changed_catalog_inventory_mapping(native_queue, mapping):
    case = native_queue
    source = emitted_source(case)
    if mapping == 'ambiguous':
        edition(case.db, catalog_ref=source['catalog_ref'])
    elif mapping == 'foreign_only':
        with case.db.connect() as connection:
            foreign = case.db.library_for(connection, case.db.owner)
        edition(case.db, library=foreign, catalog_ref=source['catalog_ref'])
    with case.db.connect() as connection:
        if mapping in {'missing', 'foreign_only'}:
            connection.execute('delete from library.catalog_album_links where local_album_id=%s', (case.tracks[0]['album_id'],))
        elif mapping == 'moved':
            connection.execute('update library.catalog_album_links set catalog_ref=%s where local_album_id=%s',
                               (case.db.album_refs[2], case.tracks[0]['album_id']))
        elif mapping == 'empty_key':
            connection.execute("update library.local_albums set album_key='' where id=%s", (case.tracks[0]['album_id'],))
        assert connection.execute('select revision from app.album_lists where ref=%s',
            (case.receipt['top_ref'],)).fetchone()['revision'] == int(case.receipt['revision'])
    assert_error(lambda: resolve(case, source=source), 'native_binding_changed', 409)
    assert case.probes == []
    result = capture(case)
    assert {'item_ref': source['item_ref'], 'reason': 'ambiguous_edition' if mapping == 'ambiguous' else 'unavailable'} in result['unavailable_items']
    assert source['inventory_album_ref'] not in repr(result)


@pytest.mark.parametrize('change', ['track_key', 'track_album', 'track_deleted', 'catalog_ref', 'member_removed', 'top_revision'])
def test_captured_tuple_never_silently_rebinds_to_changed_membership_or_track(native_queue, change):
    case = native_queue
    source = capture(case)['albums'][1]['tracks'][0]['source']
    identity = int(source['inventory_track_ref'].split(':')[-1])
    with case.db.connect() as connection:
        if change == 'track_key':
            connection.execute('update library.local_tracks set track_key=%s where id=%s', ('changed-' + uuid4().hex, identity))
        elif change == 'track_album':
            connection.execute('update library.local_tracks set album_id=%s where id=%s', (case.db.album_ids[2], identity))
        elif change == 'track_deleted':
            connection.execute('delete from library.local_tracks where id=%s', (identity,))
        elif change == 'catalog_ref':
            connection.execute('update app.album_list_items set catalog_ref=%s where ref=%s', (case.db.album_refs[2], source['item_ref']))
        elif change == 'member_removed':
            connection.execute('delete from app.album_list_items where ref=%s', (source['item_ref'],))
        else:
            connection.execute('update app.album_lists set revision=revision+1 where ref=%s', (case.receipt['top_ref'],))
    case.probes.clear()
    assert_error(lambda: resolve(case, source=source), 'revision_conflict' if change == 'top_revision' else 'item_unavailable',
                 409 if change == 'top_revision' else 404)
    assert case.probes == []


@pytest.mark.parametrize('change', ['no_file', 'missing_file', 'stale_file', 'inactive_root', 'unregistered_root',
                                   'out_of_root', 'directory', 'unknown_track'])
def test_unavailable_unknown_or_nonlocal_files_never_become_native_targets(native_queue, change, tmp_path):
    case = native_queue
    selected = case.tracks[0]
    source = emitted_source(case, selected)
    with case.db.connect() as connection:
        if change == 'no_file':
            connection.execute('delete from library.local_track_files where track_id=%s', (selected['id'],))
        elif change == 'missing_file':
            selected['path'].unlink()
        elif change == 'stale_file':
            connection.execute('''update library.local_track_files set metadata=
                metadata || '{"scan_cache":{"stale":true}}'::jsonb where track_id=%s''', (selected['id'],))
        elif change == 'inactive_root':
            connection.execute('update library.library_roots set is_active=false where id=%s', (case.root_id,))
        elif change == 'unregistered_root':
            connection.execute('update library.local_track_files set library_root_id=null where track_id=%s', (selected['id'],))
        elif change == 'out_of_root':
            outside = tmp_path / 'outside.flac'
            outside.write_bytes(b'synthetic-outside-file')
            connection.execute('update library.local_track_files set private_path=%s where track_id=%s', (str(outside), selected['id']))
        elif change == 'directory':
            selected['path'].unlink()
            selected['path'].mkdir()
        else:
            source['inventory_track_ref'] = f'inventory-track:{case.db.library}:9223372036854775807'
    before = case.db.snapshot()
    with pytest.raises(AlbumTopError) as caught:
        resolve(case, source=source)
    assert (caught.value.code, caught.value.status_code) == ('item_unavailable', 404)
    assert str(selected['path']) not in str(caught.value) and selected['title'] not in str(caught.value)
    if change != 'unknown_track':
        captured = capture(case)
        assert source['inventory_track_ref'] not in repr(captured)
        assert selected['title'] not in repr(captured) and str(selected['path']) not in repr(captured)
        assert {'item_ref': source['item_ref'], 'reason': 'tracks_unavailable'} in captured['unavailable_items']
    assert case.db.snapshot() == before


def test_fresh_resolution_uses_current_authorized_file_instead_of_replaying_capture_target(native_queue):
    case = native_queue
    captured = capture(case)['albums'][1]['tracks'][0]
    identity = int(captured['source']['inventory_track_ref'].split(':')[-1])
    replacement = case.root / 'replacement.flac'
    replacement.write_bytes(b'synthetic-replacement-file')
    with case.db.connect() as connection:
        connection.execute('update library.local_track_files set private_path=%s where track_id=%s', (str(replacement), identity))
    current = resolve(case, source=captured['source'])
    assert current['source'] == captured['source']
    assert current['native_target']['path'] == str(replacement.resolve())
    assert current['native_target']['path'] != captured['native_target']['path']


@pytest.mark.parametrize('operation', ['capture', 'resolve'])
def test_session_expiry_while_native_resolution_runs_discards_all_computed_paths(native_queue, monkeypatch, operation):
    case = native_queue
    source = emitted_source(case)
    now = [case.db.now]
    monkeypatch.setattr(case.db.service, '_clock', lambda: now[0])
    method = 'resolve_play_queue' if operation == 'capture' else 'resolve'
    original = getattr(PrivateNativeTargets, method)
    returned = []

    def after_native(self, *args, **kwargs):
        result = original(self, *args, **kwargs)
        returned.append(result)
        now[0] += timedelta(hours=2)
        return result

    monkeypatch.setattr(PrivateNativeTargets, method, after_native)
    before = case.db.snapshot()
    callback = (lambda: capture(case)) if operation == 'capture' else (lambda: resolve(case, source=source))
    assert_error(callback, 'forbidden', 403)
    assert returned and case.db.snapshot() == before


@pytest.mark.parametrize('operation', ['capture', 'resolve'])
@pytest.mark.parametrize('change', ['catalog_link', 'track_key', 'track_album', 'file', 'new_file', 'root'])
def test_reader_holds_mapping_track_and_native_file_locks_until_response(native_queue, monkeypatch, operation, change):
    import psycopg

    case = native_queue
    selected = case.tracks[0]
    source = emitted_source(case, selected)
    method = 'resolve_play_queue' if operation == 'capture' else 'resolve'
    original = getattr(PrivateNativeTargets, method)
    blocked = []

    def after_native(self, *args, **kwargs):
        result = original(self, *args, **kwargs)
        with pytest.raises(psycopg.errors.LockNotAvailable):
            with case.db.connect() as contender:
                contender.execute("set local lock_timeout='100ms'")
                if change == 'catalog_link':
                    contender.execute('delete from library.catalog_album_links where local_album_id=%s', (selected['album_id'],))
                elif change == 'track_key':
                    contender.execute('update library.local_tracks set track_key=%s where id=%s', ('changed-' + uuid4().hex, selected['id']))
                elif change == 'track_album':
                    contender.execute('update library.local_tracks set album_id=%s where id=%s', (case.db.album_ids[2], selected['id']))
                elif change == 'file':
                    contender.execute('update library.local_track_files set private_path=%s where track_id=%s',
                                      (str(case.root / 'changed.flac'), selected['id']))
                elif change == 'new_file':
                    contender.execute('insert into library.local_track_files(track_id,private_path) values(%s,%s)',
                                      (selected['id'], str(case.root / 'new.flac')))
                else:
                    contender.execute('update library.library_roots set is_active=false where id=%s', (case.root_id,))
        blocked.append(change)
        return result

    monkeypatch.setattr(PrivateNativeTargets, method, after_native)
    result = capture(case) if operation == 'capture' else resolve(case, source=source)
    assert result and blocked == [change]


def test_real_candidate_limit_rejects_whole_capture_before_native_file_queries(native_queue, monkeypatch):
    case = native_queue
    with case.db.connect() as connection:
        connection.execute('''insert into library.local_tracks(library_id,album_id,track_key,title,track_number)
            select %s,%s,%s || value::text,'Synthetic bounded candidate',value
            from generate_series(1,5001) value''', (case.db.library, case.db.album_ids[0], uuid4().hex + '-'))
    calls = []

    def unexpected_native(*args, **kwargs):
        calls.append(True)
        raise AssertionError('Overflow must fail before native resolution, never truncate')

    monkeypatch.setattr(PrivateNativeTargets, 'resolve_play_queue', unexpected_native)
    before = case.db.snapshot()
    with record_runtime(case.db) as (statements, _):
        assert_error(lambda: capture(case), 'queue_too_large', 422)
    candidates = [(sql, params, count) for sql, params, count in statements
                  if sql.startswith('select id,album_id,track_key,disc_number,track_number')]
    assert len(candidates) == 1 and candidates[0][2] == 5001
    assert candidates[0][1][-1] == 5001 and 'limit %s for update' in candidates[0][0]
    assert calls == [] and case.db.snapshot() == before


def test_postgres_maximum_disc_and_track_values_precede_unknown_numbers(native_queue):
    case = native_queue
    numbers = [(None, 1), (2147483647, None), (2147483647, 2147483647),
               (2147483647, 1), (0, 1)]
    with case.db.connect() as connection:
        for track, (disc, number) in zip(case.tracks[:5], numbers):
            connection.execute('update library.local_tracks set disc_number=%s,track_number=%s where id=%s',
                               (disc, number, track['id']))
    result = capture(case)
    assert [entry['source']['canonical_track_ref'] for entry in result['albums'][1]['tracks']] == [
        case.tracks[index]['key'] for index in (3, 2, 1, 0, 4)]
    assert result['unavailable_items'] == []


def test_current_curator_order_is_recaptured_and_old_revision_cannot_play(native_queue):
    case = native_queue
    old_source = capture(case)['albums'][0]['tracks'][0]['source']
    items = case.db.read(case.receipt)['items']
    reordered, _ = write(case.db, 'reorder', case.receipt, item_order=[row['ref'] for row in reversed(items)])
    assert_error(lambda: resolve(case, source=old_source, receipt=reordered), 'revision_conflict', 409)
    current = capture(case, receipt=reordered)
    assert [album['catalog_ref'] for album in current['albums']] == case.db.album_refs[:2]
    assert all(track['source']['revision'] == reordered['revision']
               for album in current['albums'] for track in album['tracks'])


def test_paused_top_still_plays_without_changing_activity_or_progress(native_queue):
    from tests.py.test_album_top_activity_postgres import activity_command, state_snapshot

    case = native_queue
    case.db.service.execute(case.db.context(), activity_command(case.receipt, False))
    assert case.db.read(case.receipt)['top_viewer_overlay']['activity']['active'] is False
    before = case.db.snapshot(), state_snapshot(case.db)
    source = capture(case)['albums'][0]['tracks'][0]['source']
    assert resolve(case, source=source)['native_target']['path']
    assert (case.db.snapshot(), state_snapshot(case.db)) == before


def test_browse_only_viewer_keeps_details_but_cannot_gain_playback_from_top_access(native_queue):
    from music_app.services.album_top_native_targets import AlbumTopNativeTargets

    case = native_queue
    viewer = member(case.db, grants=('capability.view',))
    receipt, _ = write(case.db, 'grant_viewer', case.receipt, account_id=viewer.account_id, role='viewer')
    source = emitted_source(case, receipt=receipt)
    before = case.db.snapshot()
    details = AlbumTopNativeTargets(case.db.service).resolve(case.db.context(viewer),
        top_ref=receipt['top_ref'], item_ref=source['item_ref'], revision=receipt['revision'],
        inventory_album_ref=source['inventory_album_ref'], context_ref='a' * 64)
    assert details['native_target']['allowed_actions'] == {'can_view_details': True, 'can_play_album': False}
    captured = capture(case, actor=viewer, receipt=receipt)
    assert captured['albums'] == []
    assert captured['unavailable_items'] == [
        {'item_ref': row['ref'], 'reason': 'unavailable'} for row in case.db.read(receipt)['items']]
    assert_error(lambda: resolve(case, source=source, actor=viewer, receipt=receipt), 'forbidden', 403)
    assert case.probes == [] and case.db.snapshot() == before
