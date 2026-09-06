from __future__ import annotations


def test_lastfm_retry_module_retains_only_compatibility_count(monkeypatch):
    from music_app.services import lastfm_retry

    monkeypatch.setattr(
        lastfm_retry,
        "load_pending_scrobble_entries",
        lambda _config, *, limit: [{"id": "legacy"}] if limit == 1_000_000 else [],
    )

    assert lastfm_retry.pending_scrobble_count({}) == 1
    assert not hasattr(lastfm_retry, "retry_pending_lastfm_scrobbles")
    assert lastfm_retry.stop_lastfm_retry_worker() is False


def test_lastfm_retry_source_contains_no_daemon_thread_contract():
    import inspect
    from music_app.services import lastfm_retry

    source = inspect.getsource(lastfm_retry)
    assert "albumhaven-lastfm-retry" not in source
    assert "threading" not in source
    assert "def retry_pending_lastfm_scrobbles" not in source
