"""Real Postgres Activity Missing contracts on uniquely owned generated fixtures.

Execution requires the root's isolated-database admission and frozen candidate.
"""
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
import json
from uuid import uuid4
import pytest
from psycopg.types.json import Jsonb
from music_app.services import playlist_activity_missing as missing
from music_app.services import playlist_local_matches as matches
from music_app.services.owned_playlists import PlaylistError
from music_app.services.owned_playlists_postgres import PostgresOwnedPlaylistsService
from tests.py.test_activity_native_targets_postgres import native_activity, capture
from tests.py.test_friend_home_activity import social_ledger
from tests.py.test_home_activity_postgres_integration import database_urls, mutable_ledger, NOW
from tests.py.test_playlist_extended_sources_postgres import create_command
from tests.py.test_playlist_local_matches_postgres import add_candidate, acceptance


@pytest.fixture
def activity_draft(native_activity):
    state, ctx, _, _ = native_activity
    db = state['db']
    tracks = [row['id'] for row in state['data']['tracks']]
    with db.connect() as con:
        original = con.execute('select private_path from library.local_track_files where track_id=%s', (tracks[0],)).fetchone()
        root = Path(original['private_path']).parent
        # Give this matching scenario a distinct title before the receipt exists;
        # other generated tracks remain present and keep their original metadata.
        con.execute('update library.local_tracks set title=%s where id=%s',
            ('Distinct missing melody', tracks[0]))
        # Two distinct listen occurrences of the same confirmed missing track.
        con.execute('update integration.listen_history set track_id=%s,track_key=%s where id=any(%s)',
            (tracks[0], state['data']['tracks'][0]['key'], state['peer_events']))
        con.execute('update library.local_track_files set metadata=%s where track_id=%s',
            (Jsonb({'scan_cache': {'stale': True, 'stale_marked_at': NOW.isoformat()}}), tracks[0]))
    Path(original['private_path']).unlink()
    adapter = SimpleNamespace(connect=db.connect, tracks=tracks, library=ctx.library_id)
    candidates = [add_candidate(adapter, root, title='Distinct missing melody (Remastered 2020)'),
                  add_candidate(adapter, root, title='Distinct missing melody feat. Guest')]
    service = PostgresOwnedPlaylistsService(db.config)
    origin, rows = capture(native_activity, 'listens')
    try:
        yield state, ctx, service, origin, rows, root, candidates
    finally:
        with db.connect() as con:
            con.execute('delete from app.playlist_operations where library_id=%s', (ctx.library_id,))
            con.execute('delete from app.playlists where library_id=%s', (ctx.library_id,))


def inspect(value, refs=None):
    _, ctx, service, origin, _, _, _ = value
    return missing.inspect(service, ctx, origin, refs)['data']


def reload(value, data, **changes):
    _, ctx, service, _, _, _, _ = value
    return missing.read_capture(service, changes.get('context', ctx),
        changes.get('ref', data['source']['ref']), changes.get('revision', data['source']['revision']))['data']


def count(value, table):
    state, ctx, *_ = value
    assert table in {'playlists', 'playlist_creation_sources', 'playlist_local_match_receipts'}
    with state['db'].connect() as con:
        if table == 'playlist_local_match_receipts':
            return con.execute('select count(*) as n from app.playlist_local_match_receipts r join app.playlist_creation_sources s on s.ref=r.source_ref where s.library_id=%s', (ctx.library_id,)).fetchone()['n']
        return con.execute(f'select count(*) as n from app.{table} where library_id=%s', (ctx.library_id,)).fetchone()['n']


def test_probe_is_read_only_and_capture_keeps_repeated_source_order(activity_draft):
    _, ctx, service, origin, rows, _, _ = activity_draft
    result = missing.inspect(service, ctx, origin, probe=True)['data']
    assert result['can_inspect_missing'] and result['missing_count'] == 2
    assert count(activity_draft, 'playlist_creation_sources') == 0
    data = inspect(activity_draft, [row['id'] for row in reversed(rows)])
    assert [entry['source_row_ref'] for entry in data['entries']] == [row['id'] for row in rows]
    assert len({entry['entry_ref'] for entry in data['entries']}) == 2
    assert len({entry['selection_ref'] for entry in data['entries']}) == 2
    assert len({entry['inventory_track_ref'] for entry in data['entries']}) == 1
    assert all(entry['availability'] == 'missing' for entry in data['entries'])
    assert count(activity_draft, 'playlists') == count(activity_draft, 'playlist_local_match_receipts') == 0
    assert not any(key in json.dumps(data) for key in ('private_path', 'source_lineage', 'inventory_evidence', str(activity_draft[5])))


def test_ambiguous_suggestions_need_occurrence_specific_acceptance_and_survive_reload(activity_draft):
    _, ctx, service, _, _, _, _ = activity_draft
    data = inspect(activity_draft)
    request = {'source': data['source'], 'entry_ref': data['entries'][0]['entry_ref']}
    reviewed = matches.review(service, ctx, request)['data']
    assert len(reviewed['candidates']) == 2
    assert all(row['availability'] == 'missing' for row in reload(activity_draft, data)['entries'])
    accepted = matches.accept(service, ctx, acceptance(request, reviewed))['data']['entry']
    retained = reload(activity_draft, data)
    assert retained['entries'][0] == accepted
    assert retained['entries'][1] == data['entries'][1]
    assert count(activity_draft, 'playlist_creation_sources') == 1
    assert count(activity_draft, 'playlists') == 0
    # Save only the retained accepted occurrence: removal stays an authored choice.
    selection = {**retained, 'entries': retained['entries'][:1]}
    command = create_command(selection)
    receipt = service.execute(ctx, command)
    assert service.execute(ctx, command) == receipt
    detail = service.read(ctx, playlist_ref=receipt['playlist_id'])['playlist_detail']['track_rows']
    assert len(detail) == 1 and detail[0]['source_kind'] == 'activity'
    assert count(activity_draft, 'playlists') == 1


@pytest.mark.parametrize('change', ['relationship', 'restore_relationship', 'session', 'present', 'offline', 'expired'])
def test_reload_and_save_revalidate_authority_and_current_missing_evidence(activity_draft, change):
    state, ctx, service, _, _, root, _ = activity_draft
    data = inspect(activity_draft)
    if change == 'present':
        (root / '0.flac').write_bytes(b'restored original')
    elif change == 'offline':
        root.rename(root.with_name('disconnected-library'))
    else:
        with state['db'].connect() as con:
            if change in {'relationship', 'restore_relationship'}:
                con.execute("update app.friend_connections set state='removed',revision=revision+1 where library_id=%s and low_account_id=%s and high_account_id=%s", state['pair'])
            elif change == 'session':
                con.execute('update app.account_sessions set revoked_at=now() where id=%s', (ctx.actor.session_id,))
            else:
                con.execute("update app.playlist_creation_sources set expires_at=now()-interval '1 second' where ref=%s", (data['capture_ref'],))
        if change == 'restore_relationship':
            with state['db'].connect() as con:
                con.execute("update app.friend_connections set state='accepted',revision=revision+1 where library_id=%s and low_account_id=%s and high_account_id=%s", state['pair'])
    with pytest.raises(PlaylistError):
        reload(activity_draft, data)
    with pytest.raises(PlaylistError):
        service.execute(ctx, create_command(data))
    assert count(activity_draft, 'playlists') == 0


def test_receipts_cannot_be_spliced_or_swapped_between_captures(activity_draft):
    _, ctx, service, _, _, _, _ = activity_draft
    first, second = inspect(activity_draft), inspect(activity_draft)
    for changed in ({'ref': second['source']['ref']}, {'revision': str(uuid4())}):
        with pytest.raises(PlaylistError):
            reload(activity_draft, first, **changed)
    payload = {'source': second['source'], 'entry_ref': first['entries'][0]['entry_ref']}
    with pytest.raises(PlaylistError):
        matches.review(service, ctx, payload)
    with pytest.raises(PlaylistError):
        service.execute(ctx, create_command({**first, 'source': second['source']}))
    assert count(activity_draft, 'playlists') == 0


def test_accepted_candidate_requires_fresh_file_proof_on_save(activity_draft):
    _, ctx, service, _, _, _, candidates = activity_draft
    data = inspect(activity_draft)
    request = {'source': data['source'], 'entry_ref': data['entries'][0]['entry_ref']}
    reviewed = matches.review(service, ctx, request)['data']
    chosen = int(reviewed['candidates'][0]['inventory_track_ref'].split(':')[-1])
    matches.accept(service, ctx, acceptance(request, reviewed))
    dict(candidates)[chosen].unlink()
    with pytest.raises(PlaylistError):
        service.execute(ctx, create_command(data))
    assert count(activity_draft, 'playlists') == 0


@pytest.mark.parametrize('availability', ['unknown', 'present', 'offline'])
def test_nonmissing_activity_never_creates_a_missing_capture(activity_draft, availability):
    state, ctx, service, _, _, root, _ = activity_draft
    if availability == 'present':
        (root / '0.flac').write_bytes(b'restored original')
    elif availability == 'offline':
        root.rename(root.with_name('disconnected-library'))
    else:
        with state['db'].connect() as con:
            con.execute("update integration.listen_history set track_id=null,track_key='unknown:'||id::text where id=any(%s)", (state['peer_events'],))
    origin, _ = capture((state, ctx, None, None), 'listens')
    probe = missing.inspect(service, ctx, origin, probe=True)['data']
    assert probe['can_inspect_missing'] is False and probe['missing_count'] == 0
    with pytest.raises(PlaylistError, match='no_confirmed_missing_tracks'):
        missing.inspect(service, ctx, origin)
    assert count(activity_draft, 'playlist_creation_sources') == 0


def test_capture_is_bound_to_current_actor_session(activity_draft):
    state, ctx, service, _, _, _, _ = activity_draft
    data = inspect(activity_draft)
    with state['db'].session(ctx.actor.account_id, ctx.library_id) as other:
        changed = replace(ctx, actor=replace(ctx.actor, session_id=other.session_id))
        with pytest.raises(PlaylistError, match='source_unavailable'):
            reload(activity_draft, data, context=changed)
        with pytest.raises(PlaylistError, match='source_unavailable'):
            service.execute(changed, create_command(data))
    assert count(activity_draft, 'playlists') == 0


def test_save_preserves_all_repeated_missing_occurrences(activity_draft):
    state, ctx, service, _, rows, _, _ = activity_draft
    data = inspect(activity_draft)
    command = create_command(data)
    saved = service.execute(ctx, command)
    assert service.execute(ctx, command) == saved
    with state['db'].connect() as con:
        persisted = con.execute('select original_local_track_id,source_entry_ref,source_lineage from app.playlist_items where playlist_ref=%s order by position', (saved['playlist_id'],)).fetchall()
    assert len(persisted) == 2
    assert len({row['original_local_track_id'] for row in persisted}) == 1
    assert [str(row['source_entry_ref']) for row in persisted] == [row['entry_ref'] for row in data['entries']]
    assert len({row['source_lineage']['row_key'] for row in persisted}) == 2
    assert count(activity_draft, 'playlists') == 1


def one_saved(value):
    state, ctx, service, *_ = value
    data = inspect(value)
    saved = service.execute(ctx, create_command({**data, 'entries': data['entries'][:1]}))
    return state, ctx, saved['playlist_id']


def copy_saved_occurrence(connection, playlist):
    connection.execute('''insert into app.playlist_items
        (ref,playlist_ref,library_id,position,original_local_track_id,local_track_id,
         source_kind,source_protocol,source_ref,source_entry_ref,source_revision)
        select %s,playlist_ref,library_id,2,original_local_track_id,local_track_id,
               source_kind,source_protocol,source_ref,source_entry_ref,source_revision
        from app.playlist_items where playlist_ref=%s order by position limit 1''',
        (str(uuid4()), playlist))


@pytest.mark.parametrize('protocol', [None, 'library_selection_v1'])
def test_non_activity_missing_saved_items_keep_original_identity_uniqueness(activity_draft, protocol):
    from psycopg.errors import UniqueViolation
    state, _, playlist = one_saved(activity_draft)
    with state['db'].connect() as con:
        # The NULL case represents legacy provenance, deliberately not backfilled.
        con.execute("update app.playlist_items set source_protocol=%s,source_kind='library' where playlist_ref=%s", (protocol, playlist))
    with pytest.raises(UniqueViolation):
        with state['db'].connect() as con:
            copy_saved_occurrence(con, playlist)


@pytest.mark.parametrize('column,value', [('source_kind', 'library'), ('source_ref', None),
    ('source_entry_ref', None), ('source_revision', None), ('source_protocol', 'invented_protocol')])
def test_missing_occurrence_requires_valid_durable_source_provenance(activity_draft, column, value):
    from psycopg.errors import CheckViolation
    state, _, playlist = one_saved(activity_draft)
    assert column in {'source_kind', 'source_ref', 'source_entry_ref', 'source_revision', 'source_protocol'}
    with pytest.raises(CheckViolation):
        with state['db'].connect() as con:
            con.execute(f'update app.playlist_items set {column}=%s where playlist_ref=%s', (value, playlist))


def test_same_missing_source_entry_cannot_be_saved_twice_in_one_playlist(activity_draft):
    from psycopg.errors import UniqueViolation
    state, _, playlist = one_saved(activity_draft)
    with pytest.raises(UniqueViolation):
        with state['db'].connect() as con:
            copy_saved_occurrence(con, playlist)
