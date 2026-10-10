"""Saved repeated occurrences copy through the real PostgreSQL service boundary.

Execution requires the root's isolated-database admission and migrated candidate.
"""
from dataclasses import replace
import json
from types import SimpleNamespace
from uuid import uuid4

import pytest
from psycopg.errors import CheckViolation, UniqueViolation
from psycopg.types.json import Jsonb

from music_app.services import playlist_activity_missing, playlist_local_matches
from music_app.services.current_actor import CapabilityGrant
from music_app.services.owned_playlists import (
    ACCESS, BROWSE, CREATE, ITEMS, MANAGE, PlaylistError, normalize_playlist_command,
)
from music_app.services.playlist_complete_sources import CompletePlaylistSources
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.test_activity_missing_postgres import activity_draft, inspect
from tests.py.test_activity_native_targets_postgres import native_activity
from tests.py.test_friend_home_activity import social_ledger
from tests.py.test_home_activity_postgres_integration import database_urls, mutable_ledger
from tests.py.test_playlist_extended_sources_postgres import create_command
from tests.py.test_playlist_local_matches_postgres import acceptance


@pytest.fixture
def repeated_playlist(activity_draft):
    state, context, service, origin, _, root, _ = activity_draft
    # Browse already supplies personal collection rights. Changing durable
    # grants here would invalidate activity_draft's sealed authority fingerprint.
    capture = inspect(activity_draft)
    saved = service.execute(context, create_command(capture))
    return SimpleNamespace(db=state['db'], state=state, context=context, service=service,
        saved=saved, capture=capture, origin=origin, root=root)


@pytest.fixture
def playlist_viewer(repeated_playlist):
    value = repeated_playlist
    with value.db.connect() as connection:
        account = value.db.account(connection)
        value.db.membership(connection, account, value.context.library_id)
        for action in (CREATE, MANAGE, ITEMS, ACCESS):
            connection.execute("""insert into app.capabilities
                (account_id,capability_key,scope_kind,scope_id) values(%s,%s,'library',%s)""",
                (account, action, value.context.library_id))
    with value.db.session(account, value.context.library_id) as actor:
        actor = replace(actor, capability_grants=(*actor.capability_grants,
            *(CapabilityGrant(action, 'library', value.context.library_id)
              for action in (CREATE, MANAGE, ITEMS, ACCESS))))
        yield replace(value.context, actor=actor)


def command(action, receipt, **fields):
    return normalize_playlist_command(action, {
        'revision': receipt['revision'], 'request_key': str(uuid4()), **fields,
    }, playlist_ref=receipt['playlist_id'])


def change(value, action, receipt, *, context=None, **fields):
    return value.service.execute(context or value.context, command(action, receipt, **fields))


def items(value, receipt):
    with value.db.connect() as connection:
        return connection.execute('''select * from app.playlist_items
            where playlist_ref=%s order by position''', (receipt['playlist_id'],)).fetchall()


def totals(value):
    with value.db.connect() as connection:
        return tuple(connection.execute(f'select count(*) as n from app.{table} where library_id=%s',
            (value.context.library_id,)).fetchone()['n']
            for table in ('playlists', 'playlist_operations', 'playlist_creation_sources'))


def assert_copy(value, source, copied, before, context):
    rows = items(value, copied)
    assert len(rows) == len(before)
    assert {row['ref'] for row in rows}.isdisjoint(row['ref'] for row in before)
    fields = ('position', 'library_id', 'original_local_track_id', 'local_track_id',
              'title', 'artist', 'album_title', 'original_album_id', 'duration_seconds')
    assert [tuple(row[key] for key in fields) for row in rows] == [
        tuple(row[key] for key in fields) for row in before]
    for row, original in zip(rows, before):
        assert row['library_id'] == context.library_id
        assert row['source_protocol'] == 'playlist_copy_v1'
        assert row['source_kind'] == 'playlist'
        assert row['source_ref'] is row['source_entry_ref'] is row['source_revision'] is None
        assert row['source_label'] is None
        assert row['source_lineage'] == {
            'playlist_ref': source['playlist_id'],
            'playlist_item_ref': str(original['ref']),
            'playlist_revision': source['revision'],
        }
    with value.db.connect() as connection:
        playlist = connection.execute('select * from app.playlists where ref=%s',
            (copied['playlist_id'],)).fetchone()
        assert playlist['owner_account_id'] == context.actor.account_id
        assert playlist['visibility'] == 'private'
        assert connection.execute('select count(*) as n from app.playlist_access_grants where playlist_ref=%s',
            (copied['playlist_id'],)).fetchone()['n'] == 0
    detail = value.service.read(context, playlist_ref=copied['playlist_id'])['playlist_detail']
    assert len(detail['track_rows']) == len(before)
    public = json.dumps(detail)
    for private in ('source_lineage', 'inventory_evidence', 'snapshot_ref', 'row_key',
                    value.capture['capture_ref'], value.origin['snapshot_ref'], str(value.root)):
        assert private not in public
    return rows


def test_copy_preserves_repeated_occurrences_without_activity_proof(repeated_playlist, playlist_viewer):
    value = repeated_playlist
    source = change(value, 'visibility', value.saved, visibility='server_shared')
    before, counts = items(value, source), totals(value)
    assert len(before) == 2 and len({row['original_local_track_id'] for row in before}) == 1
    assert len({row['source_entry_ref'] for row in before}) == 2
    request = command('copy', source)
    copied = value.service.execute(playlist_viewer, request)
    assert copied['added_count'] == 2
    assert_copy(value, source, copied, before, playlist_viewer)
    assert value.service.execute(playlist_viewer, request) == copied
    assert value.service.read_operation(playlist_viewer, request.request_key)['receipt'] == copied
    assert totals(value) == (counts[0] + 1, counts[1] + 1, counts[2])
    assert items(value, source) == before
    with pytest.raises(PlaylistError, match='playlist_unavailable'):
        value.service.read(value.context, playlist_ref=copied['playlist_id'])
    with pytest.raises(PlaylistError, match='idempotency_key_reused'):
        value.service.execute(playlist_viewer,
            command('copy', source, request_key=request.request_key, title='Changed retry'))


def test_copy_of_copy_has_fresh_identity_and_only_immediate_playlist_lineage(repeated_playlist, playlist_viewer):
    value = repeated_playlist
    source = change(value, 'visibility', value.saved, visibility='server_shared')
    first = change(value, 'copy', source, context=playlist_viewer)
    before = items(value, first)
    second = change(value, 'copy', first, context=playlist_viewer)
    after = assert_copy(value, first, second, before, playlist_viewer)
    assert {row['ref'] for row in after}.isdisjoint(row['ref'] for row in items(value, source))
    change(value, 'reorder', second, context=playlist_viewer,
        item_order=[str(row['ref']) for row in reversed(after)])
    assert items(value, first) == before


def test_copy_keeps_each_occurrences_current_accepted_same_library_link(repeated_playlist):
    value = repeated_playlist
    data = playlist_activity_missing.inspect(value.service, value.context, value.origin)['data']
    request = {'source': data['source'], 'entry_ref': data['entries'][0]['entry_ref']}
    reviewed = playlist_local_matches.review(value.service, value.context, request)['data']
    playlist_local_matches.accept(value.service, value.context, acceptance(request, reviewed))
    source = value.service.execute(value.context, create_command(data))
    before = items(value, source)
    assert len({row['original_local_track_id'] for row in before}) == 1
    assert len({row['local_track_id'] for row in before}) == 2
    copied = change(value, 'copy', source)
    assert_copy(value, source, copied, before, value.context)


@pytest.mark.parametrize('mutation', ['save', 'reorder', 'remove', 'private', 'delete'])
def test_committed_copy_is_independent_of_later_source_changes(repeated_playlist, playlist_viewer, mutation):
    value = repeated_playlist
    source = change(value, 'visibility', value.saved, visibility='server_shared')
    request = command('copy', source)
    copied = value.service.execute(playlist_viewer, request)
    before = items(value, copied)
    source_rows = items(value, source)
    fields = {'save': {'title': 'Renamed source'},
        'reorder': {'item_order': [str(row['ref']) for row in reversed(source_rows)]},
        'remove': {'item_refs': [str(source_rows[0]['ref'])]},
        'private': {'visibility': 'private'}, 'delete': {}}[mutation]
    latest = change(value, 'visibility' if mutation == 'private' else mutation, source, **fields)
    counts = totals(value)
    assert value.service.execute(playlist_viewer, request) == copied
    assert value.service.read_operation(playlist_viewer, request.request_key)['receipt'] == copied
    assert items(value, copied) == before and totals(value) == counts
    with pytest.raises(PlaylistError, match='playlist_unavailable' if mutation in {'private', 'delete'} else 'revision_conflict'):
        change(value, 'copy', source, context=playlist_viewer)
    if mutation in {'save', 'reorder', 'remove'}:
        fresh = change(value, 'copy', latest, context=playlist_viewer)
        assert_copy(value, latest, fresh, items(value, latest), playlist_viewer)
    else:
        with pytest.raises(PlaylistError, match='playlist_unavailable'):
            change(value, 'copy', latest, context=playlist_viewer)
        assert totals(value) == counts


def test_copy_needs_no_revoked_activity_relationship_or_expired_capture(repeated_playlist, playlist_viewer):
    value = repeated_playlist
    source = change(value, 'visibility', value.saved, visibility='server_shared')
    with value.db.connect() as connection:
        connection.execute("""update app.friend_connections set state='removed',revision=revision+1
            where library_id=%s and low_account_id=%s and high_account_id=%s""", value.state['pair'])
        connection.execute('delete from app.playlist_creation_sources where ref=%s',
            (value.capture['capture_ref'],))
    copied = change(value, 'copy', source, context=playlist_viewer)
    assert_copy(value, source, copied, items(value, source), playlist_viewer)


@pytest.mark.parametrize('denial', ['create', 'browse', 'membership', 'session', 'track'])
def test_copy_rechecks_current_authority_without_partial_destination(repeated_playlist, playlist_viewer, denial):
    value = repeated_playlist
    source = change(value, 'visibility', value.saved, visibility='server_shared')
    if denial not in {'create', 'track'}:
        with value.db.connect() as connection:
            if denial == 'browse':
                connection.execute('update app.capabilities set revoked_at=now() where account_id=%s and capability_key=%s',
                    (playlist_viewer.actor.account_id, BROWSE))
            elif denial == 'membership':
                connection.execute('delete from library.library_memberships where account_id=%s and library_id=%s',
                    (playlist_viewer.actor.account_id, playlist_viewer.library_id))
            else:
                connection.execute('update app.account_sessions set revoked_at=now() where id=%s',
                    (playlist_viewer.actor.session_id,))
    def constraints(context):
        denied = context.action == CREATE if denial == 'create' else (
            context.resource is not None and context.resource.resource_kind == 'track')
        return PolicyEvaluationConstraints(request_origin_allowed=not denied)
    counts = totals(value)
    with pytest.raises(PlaylistError):
        value.service.execute(playlist_viewer, command('copy', source),
            constraints=constraints if denial in {'create', 'track'} else None)
    assert totals(value) == counts


@pytest.mark.parametrize('column,replacement', [
    ('source_ref', str(uuid4())), ('source_entry_ref', str(uuid4())),
    ('source_revision', str(uuid4())), ('source_label', 'Private Activity label'),
    ('source_kind', 'activity'),
])
def test_copy_protocol_cannot_retain_private_capture_proof(repeated_playlist, column, replacement):
    value = repeated_playlist
    copied = change(value, 'copy', value.saved)
    with pytest.raises(CheckViolation):
        with value.db.connect() as connection:
            connection.execute(f'update app.playlist_items set {column}=%s where playlist_ref=%s',
                (replacement, copied['playlist_id']))


@pytest.mark.parametrize('lineage', [None, {},
    {'playlist_ref': 'invalid', 'playlist_item_ref': str(uuid4()), 'playlist_revision': '1'},
    {'playlist_ref': str(uuid4()), 'playlist_item_ref': str(uuid4()), 'playlist_revision': '1',
     'snapshot_ref': 'private-activity-proof'}])
def test_copy_protocol_requires_exact_safe_playlist_lineage(repeated_playlist, lineage):
    value = repeated_playlist
    copied = change(value, 'copy', value.saved)
    with pytest.raises(CheckViolation):
        with value.db.connect() as connection:
            connection.execute('update app.playlist_items set source_lineage=%s where playlist_ref=%s',
                (Jsonb(lineage) if lineage is not None else None, copied['playlist_id']))


def test_same_saved_source_occurrence_cannot_be_duplicated_in_one_copy(repeated_playlist):
    value = repeated_playlist
    copied = change(value, 'copy', value.saved)
    first, second = items(value, copied)
    with pytest.raises(UniqueViolation):
        with value.db.connect() as connection:
            connection.execute('update app.playlist_items set source_lineage=%s where ref=%s',
                (Jsonb(first['source_lineage']), second['ref']))


@pytest.mark.parametrize('protocol', [None, 'library_selection_v1', 'complete_inventory_selection_v1'])
def test_ordinary_saved_tracks_keep_original_identity_uniqueness(repeated_playlist, protocol):
    value = repeated_playlist
    track = value.state['data']['tracks'][1]['id']
    data = CompletePlaylistSources(playlists=value.service).from_inventory(value.context,
        [f'inventory-track:{value.context.library_id}:{track}'])['data']
    ordinary = value.service.execute(value.context, create_command(data))
    with value.db.connect() as connection:
        connection.execute('update app.playlist_items set source_protocol=%s where playlist_ref=%s',
            (protocol, ordinary['playlist_id']))
    with pytest.raises(UniqueViolation):
        with value.db.connect() as connection:
            connection.execute('''insert into app.playlist_items
                (ref,playlist_ref,library_id,position,original_local_track_id,local_track_id,source_kind,source_protocol)
                select %s,playlist_ref,library_id,position+1,original_local_track_id,local_track_id,source_kind,source_protocol
                from app.playlist_items where playlist_ref=%s''', (str(uuid4()), ordinary['playlist_id']))


def test_copy_protocol_is_saved_item_only_not_a_capture_or_create_protocol(repeated_playlist):
    value = repeated_playlist
    with pytest.raises(PlaylistError, match='invalid_command'):
        create_command({**value.capture, 'mode': 'ordinary', 'source_protocol': 'playlist_copy_v1',
            'source': {'kind': 'playlist', 'ref': value.saved['playlist_id'], 'revision': '1'}})
    with pytest.raises(CheckViolation):
        with value.db.connect() as connection:
            connection.execute("""update app.playlist_creation_sources
                set protocol='playlist_copy_v1',source_kind='playlist' where ref=%s""",
                (value.capture['capture_ref'],))
