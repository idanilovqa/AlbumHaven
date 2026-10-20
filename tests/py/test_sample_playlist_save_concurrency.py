"""Save serializes on the real actor lock; PostgreSQL proves the wait."""
from concurrent.futures import ThreadPoolExecutor
from threading import Event, Lock

import pytest
from library_mix_postgres_support import mix_db, mix_urls
from music_app.services import private_library_authority as authority
from music_app.services.owned_playlists import PlaylistError
from test_sample_playlist_sources_live import manual_source
from test_sample_playlist_receipts_live import capture, destinations, no_provider
from test_sample_playlist_receipt_concurrency import assert_pg_wait
from test_sample_playlist_save import payload, save, ledger


@pytest.mark.parametrize('ending', ['commit', 'rollback', 'changed_command'])
def test_same_actor_save_waits_then_replays_or_retries_without_duplicates(mix_db, monkeypatch, ending):
    db = mix_db
    source = capture(db, manual_source(db, (0, 1, 3)))
    body = payload(source)
    before = destinations(db)
    inserted, waiting, release = Event(), Event(), Event()
    guard, pids, writes = Lock(), [], []
    real_lock, real_insert = authority.lock_admin_accounts, db.service._insert_items

    def lock(connection, actor, target):
        with guard:
            pids.append(connection.info.backend_pid)
            second = len(pids) == 2
        if second: waiting.set()
        return real_lock(connection, actor, target)

    def insert(connection, *args, **kwargs):
        result = real_insert(connection, *args, **kwargs)
        with guard:
            writes.append(connection.info.backend_pid)
            first = len(writes) == 1
        if first:
            inserted.set()
            assert release.wait(10), 'Controller must release first real transaction'
            if ending == 'rollback': raise RuntimeError('rollback actual insertion')
        return result

    monkeypatch.setattr(authority, 'lock_admin_accounts', lock)
    monkeypatch.setattr(db.service, '_insert_items', insert)
    pool = ThreadPoolExecutor(max_workers=2)
    try:
        first = pool.submit(save, db, body)
        assert inserted.wait(10)
        second = pool.submit(save, db, body | ({'title': 'Changed command'} if ending == 'changed_command' else {}))
        assert waiting.wait(10)
        assert len(pids) == 2 and pids[0] != pids[1]
        assert_pg_wait(db, pids[1], pids[0])
        assert not second.done()
        release.set()
        if ending == 'rollback':
            with pytest.raises(RuntimeError, match='rollback actual insertion'): first.result(timeout=10)
            result = second.result(timeout=10)
            assert len(writes) == 2
        else:
            result = first.result(timeout=10)
            if ending == 'changed_command':
                with pytest.raises(PlaylistError, match='idempotency_key_reused'): second.result(timeout=10)
            else: assert second.result(timeout=10) == result
            assert len(writes) == 1
        assert len(ledger(db, body['request_key'])) == 1
        after = destinations(db)
        assert after == before | {'playlists': before['playlists'] + 1,
                                   'playlist_items': before['playlist_items'] + len(source['entries']),
                                   'playlist_operations': before['playlist_operations'] + 1}
        assert result['request_key'] == body['request_key']
    finally:
        release.set()
        pool.shutdown(wait=True, cancel_futures=True)
