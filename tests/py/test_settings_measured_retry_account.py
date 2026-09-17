import pytest
"""Measured retries select each persisted account credential and retain receipts."""
from music_app.services import lastfm_retry, lastfm_sync_bridge as bridge, listen_history as history
from music_app.services.lastfm_postgres import LastfmPostgresAdapter
from music_app.services.playback_session_payloads import normalize_playback_track_payload
from tests.py.test_settings_measured_listen_ledger import ledger, measured


def test_measured_retry_uses_each_persisted_account_credential_once(ledger, monkeypatch):
    config = {**ledger["config"], "LASTFM_API_ENABLED":True}
    for index, owner in enumerate((ledger["own"], ledger["other"])):
        payload = measured(owner, finalized=True, library_track_id=str(owner["track_id"]))
        bridge.record_playback_session_complete(config,payload,account_id=owner["account_id"],library_id=owner["library_id"],
            lastfm_session=None,user_timezone="UTC",normalize_playback_track_payload=normalize_playback_track_payload,
            is_meaningful_listen_session=history.is_meaningful_listen_session,
            append_listen_history_entry=history.append_listen_history_entry,update_listen_history_entry=history.update_listen_history_entry,
            scrobble_track=lambda *args,**kwargs:None,log_lastfm_scrobble_event=lambda *args,**kwargs:None)
        LastfmPostgresAdapter(config).save_settings({"username":f"owned-{index}","session_key":f"owned-fixture-{index}"},account_id=owner["account_id"])
    calls=[]
    monkeypatch.setattr(lastfm_retry,"scrobble_track",lambda config,payload,*,session:calls.append(session.username))
    monkeypatch.setattr(lastfm_retry,"record_retry_summary",lambda *args,**kwargs:None)
    lastfm_retry.retry_pending_lastfm_scrobbles(config)
    lastfm_retry.retry_pending_lastfm_scrobbles(config)
    assert sorted(calls)==["owned-0","owned-1"]


def test_measured_retry_does_not_resubmit_uncertain_receipt(ledger, monkeypatch):
    config = {**ledger["config"], "LASTFM_API_ENABLED": True}
    owner = ledger["own"]
    payload = measured(owner, finalized=True, library_track_id=str(owner["track_id"]))
    body, _status = bridge.record_playback_session_complete(
        config, payload, account_id=owner["account_id"], library_id=owner["library_id"],
        lastfm_session=None, user_timezone="UTC",
        normalize_playback_track_payload=normalize_playback_track_payload,
        is_meaningful_listen_session=history.is_meaningful_listen_session,
        append_listen_history_entry=history.append_listen_history_entry,
        update_listen_history_entry=history.update_listen_history_entry,
        scrobble_track=lambda *args, **kwargs: None,
        log_lastfm_scrobble_event=lambda *args, **kwargs: None,
    )
    history.update_listen_history_entry(
        config, body["entry"]["id"],
        {"scrobble_submission_state": "uncertain", "scrobble_retryable": True},
        account_id=owner["account_id"], library_id=owner["library_id"],
    )
    LastfmPostgresAdapter(config).save_settings(
        {"username": "owned", "session_key": "owned-fixture"}, account_id=owner["account_id"],
    )
    calls = []
    monkeypatch.setattr(lastfm_retry, "scrobble_track", lambda *args, **kwargs: calls.append(True))
    lastfm_retry.retry_pending_lastfm_scrobbles(config)
    assert calls == []


@pytest.mark.parametrize("fails", [False, True])
def test_measured_retry_records_actual_provider_outcome_with_row_scope(ledger, monkeypatch, fails):
    from music_app.services.lastfm import LastfmError
    config = {**ledger["config"], "LASTFM_API_ENABLED": True}
    owner = ledger["own"]
    bridge.record_playback_session_complete(
        config, measured(owner, finalized=True, library_track_id=str(owner["track_id"])),
        account_id=owner["account_id"], library_id=owner["library_id"],
        lastfm_session=None, user_timezone="UTC",
        normalize_playback_track_payload=normalize_playback_track_payload,
        is_meaningful_listen_session=history.is_meaningful_listen_session,
        append_listen_history_entry=history.append_listen_history_entry,
        update_listen_history_entry=history.update_listen_history_entry,
        scrobble_track=lambda *args, **kwargs: None,
        log_lastfm_scrobble_event=lambda *args, **kwargs: None,
    )
    LastfmPostgresAdapter(config).save_settings(
        {"username": "owned", "session_key": "owned-fixture"}, account_id=owner["account_id"],
    )
    def provider(*args, **kwargs):
        if fails:
            raise LastfmError("Provider unavailable")
    events = []
    monkeypatch.setattr(lastfm_retry, "scrobble_track", provider)
    monkeypatch.setattr(lastfm_retry, "log_app_event", lambda *args, **kwargs: events.append(kwargs))
    lastfm_retry.retry_pending_lastfm_scrobbles(config)
    assert len(events) == 1
    scope = events[0]["history_scope"]
    assert (scope.account_id, scope.library_id, scope.origin_kind) == (
        owner["account_id"], owner["library_id"], "retry")
    assert events[0]["level"] == ("warning" if fails else "info")


@pytest.mark.parametrize('account_scoped', [False, True])
def test_retry_limit_applies_after_connected_account_selection(ledger, monkeypatch, account_scoped):
    config = {**ledger['config'], 'LASTFM_API_ENABLED': True}
    own, other = ledger['own'], ledger['other']
    def pending(owner, **changes):
        body, status = bridge.record_playback_session_complete(
            config, measured(owner, finalized=True, library_track_id=str(owner['track_id']), **changes),
            account_id=owner['account_id'], library_id=owner['library_id'],
            lastfm_session=None, user_timezone='UTC',
            normalize_playback_track_payload=normalize_playback_track_payload,
            is_meaningful_listen_session=history.is_meaningful_listen_session,
            append_listen_history_entry=history.append_listen_history_entry,
            update_listen_history_entry=history.update_listen_history_entry,
            scrobble_track=lambda *args, **kwargs: pytest.fail('Disconnected seed cannot submit'),
            log_lastfm_scrobble_event=lambda *args, **kwargs: None)
        assert status == 200 and body['scrobbled'] is False
        return body['entry']['id']
    predecessor_ids = {pending(other, started_at='2026-09-08T12:00:00+00:00', started_at_unix=1788868800)
                       for _ in range(101)}
    target_id = pending(own)
    LastfmPostgresAdapter(config).save_settings({'username': 'target-account', 'session_key': 'target-fixture'}, account_id=own['account_id'])
    if account_scoped:
        LastfmPostgresAdapter(config).save_settings({'username': 'other-account', 'session_key': 'other-fixture'}, account_id=other['account_id'])
    # Generic inventory must retain disconnected rows; dispatch alone filters them.
    inventory = history.load_pending_scrobble_entries(config, limit=1000)
    assert predecessor_ids | {target_id} <= {item.entry['id'] for item in inventory}
    calls = []
    monkeypatch.setattr(lastfm_retry, 'scrobble_track', lambda config, item, *, session: calls.append(session.username))
    monkeypatch.setattr(lastfm_retry, 'record_retry_summary', lambda *args, **kwargs: None)
    monkeypatch.setattr(lastfm_retry, 'log_app_event', lambda *args, **kwargs: None)
    kwargs = {'account_id': own['account_id'], 'reauthenticated': True} if account_scoped else {}
    summary = lastfm_retry.retry_pending_lastfm_scrobbles(config, **kwargs)
    assert calls == ['target-account']
    assert summary['attempted'] == summary['succeeded'] == 1
    remaining = history.load_pending_scrobble_entries(config, limit=1000)
    remaining_ids = {item.entry['id'] for item in remaining}
    assert target_id not in remaining_ids
    assert predecessor_ids <= remaining_ids
