"""Existing Last.fm credential rows remain account-owned for request access."""
from music_app.services.lastfm_postgres import LastfmPostgresAdapter
from tests.py.test_settings_measured_listen_ledger import ledger


def test_scoped_credential_roundtrip_does_not_read_or_overwrite_another_account(ledger):
    adapter = LastfmPostgresAdapter(ledger["config"])
    own, other = ledger["own"]["account_id"], ledger["other"]["account_id"]
    settings = {"username": "own-test-user", "session_key": "owned-fixture-token", "connected_at": "2026-09-09T12:00:00+00:00", "user_timezone": "UTC"}
    adapter.save_settings(settings, account_id=own)
    assert adapter.load_settings(account_id=own) == settings
    assert adapter.load_settings(account_id=other) == {}
    adapter.save_settings({"user_timezone": "UTC"}, account_id=other)
    assert adapter.load_settings(account_id=own) == settings
    adapter.save_settings({"user_timezone": "UTC"}, account_id=own)
    assert not adapter.load_settings(account_id=own).get("session_key")
