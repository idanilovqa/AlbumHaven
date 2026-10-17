"""Inspect Missing preserves saved occurrences without reviving Activity proof.

Execution requires the root's isolated-database admission and migrated candidate.
"""
import json

import pytest
from psycopg.errors import CheckViolation, UniqueViolation

from music_app.services import playlist_missing_sources as missing
from music_app.services.owned_playlists import CREATE, PlaylistError
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.test_playlist_copy_occurrences import (
    activity_draft, native_activity, social_ledger, database_urls, mutable_ledger,
    repeated_playlist, playlist_viewer, change, items, totals,
)
from tests.py.test_playlist_extended_sources_postgres import create_command


def inspect_saved(value, source, *, context=None):
    return missing.inspect(value.service, context or value.context,
        source['playlist_id'], source['revision'])['data']


def reload_saved(value, data, *, context=None, constraints=None):
    return missing.read_capture(value.service, context or value.context,
        data['source']['ref'], data['source']['revision'], data['capture_ref'],
        constraints=constraints)['data']


@pytest.mark.parametrize('copy_first', [False, True])
def test_inspect_binds_distinct_evidence_to_saved_item_order(repeated_playlist, copy_first):
    value = repeated_playlist
    source = change(value, 'copy', value.saved) if copy_first else value.saved
    before, counts = items(value, source), totals(value)
    data = inspect_saved(value, source)
    assert data['source_protocol'] == 'missing_playlist_selection_v1'
    assert data['source'] == {'kind': 'playlist', 'ref': source['playlist_id'],
        'revision': source['revision']}
    assert len(data['entries']) == 2
    assert len({row['entry_ref'] for row in data['entries']}) == 2
    assert len({row['selection_ref'] for row in data['entries']}) == 2
    assert len({row['inventory_track_ref'] for row in data['entries']}) == 1
    assert [row['source_row_ref'] for row in data['entries']] == [str(row['ref']) for row in before]
    assert all(row['availability'] == 'missing' for row in data['entries'])
    assert reload_saved(value, data)['entries'] == data['entries']
    assert totals(value) == (counts[0], counts[1], counts[2] + 1)
    assert items(value, source) == before
    with value.db.connect() as connection:
        capture = connection.execute('select * from app.playlist_creation_sources where ref=%s',
            (data['capture_ref'],)).fetchone()
        rows = connection.execute('select * from app.playlist_creation_entries where source_ref=%s',
            (data['capture_ref'],)).fetchall()
    assert capture['origin_descriptor'] == {'playlist_ref': source['playlist_id'],
        'playlist_revision': source['revision'],
        'entry_order': [row['entry_ref'] for row in data['entries']]}
    assert len({row['evidence_digest'] for row in rows}) == 2
    by_ref = {str(row['ref']): row for row in rows}
    for entry, original in zip(data['entries'], before):
        stored = by_ref[entry['entry_ref']]
        assert stored['source_row_ref'] == str(original['ref'])
        assert stored['source_lineage'] == {'playlist_ref': source['playlist_id'],
            'playlist_item_ref': str(original['ref']), 'playlist_revision': source['revision']}
    public = json.dumps(data)
    for private in ('source_lineage', 'inventory_evidence', 'evidence_digest', 'snapshot_ref', 'row_key',
                    value.capture['capture_ref'], value.origin['snapshot_ref'], str(value.root)):
        assert private not in public


@pytest.mark.parametrize('selection', ['all', 'reversed', 'one'])
def test_saving_inspected_occurrences_preserves_explicit_selection_and_retry(repeated_playlist, selection):
    value = repeated_playlist
    before = items(value, value.saved)
    data = inspect_saved(value, value.saved)
    entries = data['entries']
    if selection == 'reversed':
        entries = list(reversed(entries))
    elif selection == 'one':
        entries = entries[1:]
    request = create_command({**data, 'entries': entries})
    counts = totals(value)
    saved = value.service.execute(value.context, request)
    rows = items(value, saved)
    assert len(rows) == len(entries)
    assert len({row['original_local_track_id'] for row in rows}) == 1
    assert [str(row['source_entry_ref']) for row in rows] == [row['entry_ref'] for row in entries]
    assert [row['source_lineage']['playlist_item_ref'] for row in rows] == [
        row['source_row_ref'] for row in entries]
    assert all(row['source_protocol'] == 'missing_playlist_selection_v1' for row in rows)
    assert {row['ref'] for row in rows}.isdisjoint(row['ref'] for row in before)
    assert value.service.execute(value.context, request) == saved
    assert value.service.read_operation(value.context, request.request_key)['receipt'] == saved
    assert totals(value) == (counts[0] + 1, counts[1] + 1, counts[2])
    inspected_again = inspect_saved(value, saved)
    assert [row['source_row_ref'] for row in inspected_again['entries']] == [str(row['ref']) for row in rows]
    assert items(value, value.saved) == before


@pytest.mark.parametrize('mutation', [
    'revision', 'remove', 'private', 'delete', 'create', 'session',
    'present', 'offline', 'expired', 'track',
])
def test_retained_inspect_and_save_recheck_source_and_current_authority(repeated_playlist, playlist_viewer, mutation):
    value = repeated_playlist
    source = change(value, 'visibility', value.saved, visibility='server_shared')
    data = inspect_saved(value, source, context=playlist_viewer)
    if mutation == 'revision':
        change(value, 'save', source, title='Changed saved source')
    elif mutation == 'remove':
        change(value, 'remove', source, item_refs=[str(items(value, source)[0]['ref'])])
    elif mutation == 'private':
        change(value, 'visibility', source, visibility='private')
    elif mutation == 'delete':
        change(value, 'delete', source)
    elif mutation == 'present':
        (value.root / '0.flac').write_bytes(b'restored synthetic original')
    elif mutation == 'offline':
        value.root.rename(value.root.with_name('offline-inspect-library'))
    elif mutation not in {'create', 'track'}:
        with value.db.connect() as connection:
            if mutation == 'session':
                connection.execute('update app.account_sessions set revoked_at=now() where id=%s',
                    (playlist_viewer.actor.session_id,))
            else:
                connection.execute("update app.playlist_creation_sources set expires_at=now()-interval '1 second' where ref=%s",
                    (data['capture_ref'],))
    def deny_action(context):
        denied = context.action == CREATE if mutation == 'create' else (
            context.resource is not None and context.resource.resource_kind == 'track')
        return PolicyEvaluationConstraints(request_origin_allowed=not denied)
    constraints = deny_action if mutation in {'create', 'track'} else None
    counts = totals(value)
    with pytest.raises(PlaylistError):
        reload_saved(value, data, context=playlist_viewer, constraints=constraints)
    with pytest.raises(PlaylistError):
        value.service.execute(playlist_viewer, create_command(data), constraints=constraints)
    assert totals(value) == counts


def test_inspect_saved_occurrences_does_not_require_original_activity_receipt(repeated_playlist):
    value = repeated_playlist
    with value.db.connect() as connection:
        connection.execute("""update app.friend_connections set state='removed',revision=revision+1
            where library_id=%s and low_account_id=%s and high_account_id=%s""", value.state['pair'])
        connection.execute('delete from app.playlist_creation_sources where ref=%s',
            (value.capture['capture_ref'],))
    data = inspect_saved(value, value.saved)
    assert len(data['entries']) == 2
    saved = value.service.execute(value.context, create_command(data))
    assert len(items(value, saved)) == 2


@pytest.mark.parametrize('column', ['source_ref', 'source_entry_ref', 'source_revision'])
def test_saved_inspect_occurrence_requires_capture_identity(repeated_playlist, column):
    value = repeated_playlist
    saved = value.service.execute(value.context, create_command(inspect_saved(value, value.saved)))
    with pytest.raises(CheckViolation):
        with value.db.connect() as connection:
            connection.execute(f'update app.playlist_items set {column}=null where playlist_ref=%s',
                (saved['playlist_id'],))


def test_same_inspected_source_entry_cannot_be_saved_twice(repeated_playlist):
    value = repeated_playlist
    saved = value.service.execute(value.context, create_command(inspect_saved(value, value.saved)))
    first, second = items(value, saved)
    with pytest.raises(UniqueViolation):
        with value.db.connect() as connection:
            connection.execute('update app.playlist_items set source_entry_ref=%s where ref=%s',
                (first['source_entry_ref'], second['ref']))
