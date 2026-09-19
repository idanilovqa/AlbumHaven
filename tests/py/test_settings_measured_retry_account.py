import pytest
"""Measured retries select each persisted account credential and retain receipts."""
from music_app.services import lastfm_retry, lastfm_sync_bridge as bridge, listen_history as history
from music_app.services.lastfm_postgres import LastfmPostgresAdapter
from music_app.services.playback_session_payloads import normalize_playback_track_payload
from tests.py.test_settings_measured_listen_ledger import ledger, measured


@pytest.mark.parametrize('source_change', ['renamed', 'deleted'])
def test_changed_pending_source_does_not_block_later_valid_listen(ledger, monkeypatch, source_change):
    config = {**ledger['config'], 'LASTFM_API_ENABLED': True}
    own = ledger['own']
    with ledger['connect']() as connection:
        next_track = connection.execute(
            "insert into library.local_tracks(library_id,track_key,title,duration_seconds) values(%s,%s,'Later valid listen',120) returning id",
            (own['library_id'], 'later-' + str(own['track_id'])),
        ).fetchone()['id']
        next_path = own['path'] + '.later'
        connection.execute('insert into library.local_track_files(track_id,private_path) values(%s,%s)', (next_track, next_path))
    valid_owner = {**own, 'track_id': next_track, 'path': next_path}

    def queue(owner, **changes):
        payload = measured(owner, finalized=True, library_track_id=str(owner['track_id']), **changes)
        result, status = bridge.record_playback_session_complete(
            config, payload, account_id=owner['account_id'], library_id=owner['library_id'],
            lastfm_session=None, user_timezone='UTC',
            normalize_playback_track_payload=normalize_playback_track_payload,
            is_meaningful_listen_session=history.is_meaningful_listen_session,
            append_listen_history_entry=history.append_listen_history_entry,
            update_listen_history_entry=history.update_listen_history_entry,
            scrobble_track=lambda *args, **kwargs: pytest.fail('Disconnected listen must not submit'),
            log_lastfm_scrobble_event=lambda *args, **kwargs: None,
        )
        assert status == 200
        return result['entry']['id']

    old_id = queue(own, title='Earlier changed source', started_at='2026-09-08T12:00:00+00:00', started_at_unix=1788868800)
    valid_id = queue(valid_owner, title='Later valid listen')
    with ledger['connect']() as connection:
        if source_change == 'renamed':
            connection.execute('update library.local_track_files set private_path=%s where track_id=%s', (own['path'] + '.renamed', own['track_id']))
        else:
            connection.execute('delete from library.local_tracks where id=%s', (own['track_id'],))
        before = connection.execute(
            "select * from integration.listen_history where account_id=%s and library_id=%s and metadata->'source_payload'->>'id'=%s",
            (own['account_id'], own['library_id'], old_id),
        ).fetchone()
    assert before is not None
    # Handling a trusted persisted retry must not authorize a fresh stale path.
    with pytest.raises(ValueError):
        history.append_listen_history_entry(config, measured(own), account_id=own['account_id'], library_id=own['library_id'])

    LastfmPostgresAdapter(config).save_settings(
        {'username': 'changed-source-owner', 'session_key': 'owned-fixture'}, account_id=own['account_id'],
    )
    submissions = []
    monkeypatch.setattr(lastfm_retry, 'scrobble_track', lambda config, payload, *, session: submissions.append(payload['track']))
    monkeypatch.setattr(lastfm_retry, 'log_app_event', lambda *args, **kwargs: None)
    monkeypatch.setattr(lastfm_retry, 'record_retry_summary', lambda *args, **kwargs: None)
    lastfm_retry.retry_pending_lastfm_scrobbles(config, account_id=own['account_id'], reauthenticated=True)
    lastfm_retry.retry_pending_lastfm_scrobbles(config, account_id=own['account_id'])

    assert submissions.count('Later valid listen') == 1
    with ledger['connect']() as connection:
        rows = connection.execute('select * from integration.listen_history where account_id=%s and library_id=%s', (own['account_id'], own['library_id'])).fetchall()
    by_id = {row['metadata']['source_payload']['id']: row for row in rows}
    assert set(by_id) == {old_id, valid_id}
    assert by_id[valid_id]['scrobble_status'] == 'scrobbled'
    for field in ('id', 'track_id', 'device_id', 'session_id', 'played_at', 'measured_listened_seconds', 'max_measured_contiguous_seconds', 'last_sequence', 'finalized'):
        assert by_id[old_id][field] == before[field]


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
