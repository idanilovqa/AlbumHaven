"""The scoped Integrations response retains actual scrobbled and queued counts."""
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
    with adapter._connect_to_database() as connection:
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
    with adapter._connect_to_database() as connection:
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
