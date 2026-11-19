"""The scoped Integrations response retains actual scrobbled and queued counts."""
from datetime import datetime, timedelta, timezone

import pytest

from tests.py.test_settings_measured_listen_ledger import ledger, measured, append
from music_app.services import listen_history as history
from music_app.routes import api_wave_b_asgi_routes as routes


def seed_status_rows(ledger):
    owner = ledger['own']
    sent = append(ledger, measured(owner, finalized=True, scrobble_eligible=True))
    history.update_listen_history_entry(ledger['config'], sent['id'], {
        'scrobbled': True, 'scrobble_retryable': False, 'scrobble_submission_state': 'accepted',
    }, account_id=owner['account_id'], library_id=owner['library_id'])
    append(ledger, measured(owner, finalized=True, scrobble_eligible=True, scrobble_retryable=True))
    append(ledger, measured(owner, finalized=True, scrobble_eligible=False))
    uncertain = append(ledger, measured(owner, finalized=True, scrobble_eligible=True))
    history.update_listen_history_entry(ledger['config'], uncertain['id'], {
        'scrobble_retryable': False, 'scrobble_submission_state': 'uncertain',
    }, account_id=owner['account_id'], library_id=owner['library_id'])
    append(ledger, measured(ledger['other'], finalized=True, scrobble_eligible=True), ledger['other'])


def test_status_counts_use_the_actual_actor_library_rows(ledger):
    seed_status_rows(ledger)
    counts = history.build_listen_history_status_counts(ledger['config'],
        account_id=ledger['own']['account_id'], library_id=ledger['own']['library_id'])
    assert counts == {'listen_history_count': 1, 'pending_scrobble_count': 1}


def test_authenticated_integrations_projection_retains_real_counts(ledger, monkeypatch):
    seed_status_rows(ledger)
    monkeypatch.setattr(routes, 'build_lastfm_status', lambda config, *, account_id: {
        'key': 'lastfm', 'connected': True, 'username': 'owned-account'})
    payload = routes._build_integrations_payload(ledger['config'],
        account_id=ledger['own']['account_id'], library_id=ledger['own']['library_id'])
    integration = next(item for item in payload['integrations'] if item['key'] == 'lastfm')
    assert integration['listen_history_count'] == 1
    assert integration['pending_scrobble_count'] == 1
    assert integration['playback_statistics']['local_playcount'] == 4


def test_scoped_counts_preserve_typed_status_when_payload_omits_legacy_flag(ledger):
    from music_app.services.listen_history_postgres import PostgresListenHistoryAdapter
    owner = ledger['own']
    item = append(ledger, measured(owner, finalized=True, scrobble_eligible=True))
    adapter = PostgresListenHistoryAdapter(ledger['config'])
    with adapter.connect() as connection:
        connection.execute("""update integration.listen_history
            set scrobble_status='scrobbled',
                metadata=jsonb_set(metadata, '{source_payload}', (metadata->'source_payload') - 'scrobbled')
            where account_id=%s and library_id=%s and metadata->'source_payload'->>'id'=%s""",
            (owner['account_id'], owner['library_id'], item['id']))
    assert history.build_listen_history_status_counts(ledger['config'], account_id=owner['account_id'],
        library_id=owner['library_id']) == {'listen_history_count': 1, 'pending_scrobble_count': 0}


def test_exhausted_receipt_is_not_pending(ledger):
    owner = ledger['own']
    item = append(ledger, measured(owner, finalized=True, scrobble_eligible=True))
    history.update_listen_history_entry(ledger['config'], item['id'], {
        'scrobble_retryable': True, 'scrobble_retry_exhausted': True,
    }, account_id=owner['account_id'], library_id=owner['library_id'])

    counts = history.build_listen_history_status_counts(
        ledger['config'], account_id=owner['account_id'], library_id=owner['library_id'],
    )
    pending = history.load_pending_scrobble_entries(ledger['config'], limit=100)

    assert counts['pending_scrobble_count'] == 0
    assert item['id'] not in {entry.entry['id'] for entry in pending}


def test_scoped_counts_exclude_imported_source_family_rows(ledger):
    from music_app.services.listen_history_postgres import PostgresListenHistoryAdapter

    owner = ledger['own']
    accepted = append(ledger, measured(owner, finalized=True, scrobble_eligible=True))
    history.update_listen_history_entry(ledger['config'], accepted['id'], {
        'scrobbled': True,
        'scrobble_retryable': False,
        'scrobble_submission_state': 'accepted',
    }, account_id=owner['account_id'], library_id=owner['library_id'])
    append(ledger, measured(owner, finalized=True, scrobble_eligible=True))

    imported_accepted = append(ledger, measured(owner, finalized=True, scrobble_eligible=True))
    history.update_listen_history_entry(ledger['config'], imported_accepted['id'], {
        'scrobbled': True,
        'scrobble_retryable': False,
        'scrobble_submission_state': 'accepted',
    }, account_id=owner['account_id'], library_id=owner['library_id'])
    imported_pending = append(ledger, measured(owner, finalized=True, scrobble_eligible=True))
    adapter = PostgresListenHistoryAdapter(ledger['config'])
    with adapter.connect() as connection:
        connection.execute("""update integration.listen_history
            set source_family='lastfm_import'
            where account_id=%s and library_id=%s
              and metadata->'source_payload'->>'id' = any(%s)""",
            (owner['account_id'], owner['library_id'], [
                imported_accepted['id'], imported_pending['id'],
            ]))

    counts = history.build_listen_history_status_counts(
        ledger['config'], account_id=owner['account_id'], library_id=owner['library_id'],
    )
    pending_ids = {
        entry.entry['id'] for entry in history.load_pending_scrobble_entries(
            ledger['config'], limit=100,
        )
    }

    assert counts == {'listen_history_count': 1, 'pending_scrobble_count': 1}
    assert imported_pending['id'] not in pending_ids


def _minutes_ago(minutes):
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat()


@pytest.mark.parametrize(('state', 'updates', 'sendable'), [
    ('pending due', {'scrobble_retryable': True}, True),
    ('pending not yet due', {
        'scrobble_retryable': True, 'scrobble_submission_state': 'not_sent', 'scrobble_retry_count': 6,
        'last_scrobble_attempt_at': _minutes_ago(0)}, True),
    ('uncertain due for verification', {
        'scrobble_retryable': False, 'scrobble_submission_state': 'uncertain', 'scrobble_retry_count': 1,
        'last_scrobble_attempt_at': _minutes_ago(10)}, True),
    ('uncertain not yet due', {
        'scrobble_retryable': False, 'scrobble_submission_state': 'uncertain', 'scrobble_retry_count': 1,
        'last_scrobble_attempt_at': _minutes_ago(0)}, True),
    ('accepted', {
        'scrobbled': True, 'scrobble_retryable': False, 'scrobble_submission_state': 'accepted',
        'scrobble_retry_count': 1, 'last_scrobble_attempt_at': _minutes_ago(10)}, False),
    ('final ignored', {
        'scrobble_retryable': False, 'scrobble_submission_state': 'sent', 'scrobble_retry_count': 1,
        'scrobble_error': 'Timestamp too old', 'last_scrobble_attempt_at': _minutes_ago(10)}, False),
])
def test_has_sendable_scrobbles_wakes_the_worker_for_every_listen_still_waiting(ledger, state, updates, sendable):
    """The idle check answers whether a connected account has any listen to send or look up.
    Due times are the retry pass's to judge: a listen not yet due still wakes the worker, which
    then waits until it is due; only a settled listen leaves it idle."""
    from music_app.services.lastfm_postgres import LastfmPostgresAdapter
    from music_app.services.listen_history_postgres import PostgresListenHistoryAdapter
    owner = ledger['own']
    adapter = PostgresListenHistoryAdapter(ledger['config'])
    assert adapter.has_sendable_scrobbles() is False, 'the isolated database starts with nothing waiting'
    item = append(ledger, measured(owner, finalized=True, scrobble_eligible=True))
    history.update_listen_history_entry(ledger['config'], item['id'], updates,
        account_id=owner['account_id'], library_id=owner['library_id'])
    # A listen of an account without a connected Last.fm session never wakes the worker.
    assert adapter.has_sendable_scrobbles() is False

    LastfmPostgresAdapter(ledger['config']).save_settings(
        {'username': f"sendable-{owner['account_id']}", 'session_key': 'sendable-fixture'},
        account_id=owner['account_id'])

    assert adapter.has_sendable_scrobbles() is sendable, state
