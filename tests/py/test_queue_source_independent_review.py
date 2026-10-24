"""Independent retained Queue source authority regressions."""
from types import SimpleNamespace
from uuid import uuid4
import pytest
from music_app.services import playlist_queue_sources as queue
from music_app.services.owned_playlists import PlaylistError, normalize_playlist_command


def test_empty_authored_create_still_checks_every_retained_source(monkeypatch):
    refs = [str(uuid4()), str(uuid4())]
    source = {'ref': str(uuid4()), 'origin_descriptor': {'queue': queue.QUEUE_VERSION,
        'playlist_refs': [], 'entry_order': refs}}
    rows = [{'ref': ref, 'original_local_track_id': identity, 'source_lineage': {
        'queue': queue.QUEUE_VERSION, 'occurrences': [{'kind': 'inventory', 'track_ref': f'inventory-track:7:{identity}'}]}}
        for ref, identity in zip(refs, (10, 20))]
    class Connection:
        def execute(self, sql, params):
            return SimpleNamespace(fetchall=lambda: [row for row in rows if row['ref'] in params[1]])
    calls = []
    monkeypatch.setattr(queue.sources, 'selected_entries', lambda *args, **kwargs: rows)
    def denied(owner, connection, context, occurrences, constraints):
        calls.append(occurrences)
        raise PlaylistError('source_unavailable', 403)
    monkeypatch.setattr(queue, '_resolve', denied)
    with pytest.raises(PlaylistError, match='source_unavailable'):
        queue.selected(SimpleNamespace(_config={}), Connection(), SimpleNamespace(library_id=7), source, [])
    assert [row['track_ref'] for row in calls[0]] == ['inventory-track:7:10', 'inventory-track:7:20']


def test_guard_order_changes_original_idempotency_digest():
    entries = [str(uuid4()), str(uuid4())]
    guard = {'source_protocol': 'complete_inventory_selection_v1', 'source': {
        'kind': 'library', 'ref': str(uuid4()), 'revision': str(uuid4())}, 'entry_refs': entries}
    body = {'revision': '1', 'request_key': str(uuid4()), 'track_refs': ['inventory-track:7:10', 'inventory-track:7:20'], 'source_guard': guard}
    target = str(uuid4())
    original = normalize_playlist_command('add', body, playlist_ref=target)
    changed = normalize_playlist_command('add', {**body, 'source_guard': {**guard, 'entry_refs': entries[::-1]}}, playlist_ref=target)
    assert original.digest != changed.digest


def test_source_destination_locks_are_one_sorted_deduplicated_set():
    refs = sorted(str(uuid4()) for _ in range(3))
    calls = []
    class Connection:
        def execute(self, sql, params):
            calls.append((sql, params))
            return SimpleNamespace(fetchall=lambda: [])
    queue.lock_playlists(Connection(), SimpleNamespace(library_id=7), [refs[2], refs[0], refs[2]], destination=refs[1])
    assert len(calls) == 1
    assert calls[0][1] == (7, refs)
    assert 'order by ref for update' in calls[0][0]
