"""UNRUN future real-PostgreSQL submit oracle using existing isolated fixture.

Requires separately admitted TCP-only contract DB migrated through 0156 and
the candidate sources. Does not migrate or create a database. Provider/session
availability are synthetic; no credential is read and no Last.fm call occurs.
"""
from dataclasses import replace
from datetime import timedelta
import hashlib
from types import SimpleNamespace
import uuid

import pytest

from music_app.services import recent_scrobble_retry as retry
from music_app.services import home_activity as activity
from music_app.services import listen_history_postgres as ledger
from music_app.services.current_actor import CapabilityGrant
from music_app.services.listen_history_postgres import PostgresListenHistoryAdapter
from music_app.services.measured_listen_history import measured_identity
from music_app.services.policy import PolicyContext, RequestOrigin
from tests.py.test_home_activity_postgres_integration import (
    NOW, database_urls, mutable_ledger, read, error_status,
)


@pytest.mark.parametrize('expire_after_claim', [False, True])
def test_real_submit_commits_before_provider_invalidates_snapshot_and_holds_authority(
        mutable_ledger, monkeypatch, expire_after_claim):
    import psycopg
    from psycopg.rows import dict_row
    from psycopg.types.json import Jsonb
    db, data, actor = (mutable_ledger[key] for key in ('db', 'data', 'actor'))
    def bounded_connect(url):
        assert url == db.app_url
        return psycopg.connect(url, row_factory=dict_row,
            options='-c lock_timeout=2000 -c statement_timeout=5000')
    # Keep real SQL and commit semantics while making an accidental lock cycle
    # a bounded test failure. Pool-capacity behavior remains a separate hold.
    monkeypatch.setattr(ledger, '_connect', bounded_connect)
    event_id = mutable_ledger['events'][0]
    device, playback = str(uuid.uuid4()), str(uuid.uuid4())
    identity = measured_identity(data['account'], data['library'], device, playback)
    entry_id = hashlib.sha256(identity.encode()).hexdigest()
    start = NOW - timedelta(hours=1)
    payload = {'id': entry_id, 'device_id': device, 'session_id': playback,
        'measurement_version': 'rendered-pcm-v1',
        'source_provenance': {'kind': 'local_playback', 'provider': 'album_haven'},
        'artist': 'Original artist', 'title': 'Original event title',
        'started_at': start.isoformat(), 'started_at_unix': int(start.timestamp()),
        'scrobbled': False, 'scrobble_eligible': True, 'scrobble_retryable': True,
        'scrobble_submission_state': 'not_sent', 'duration_seconds': 240,
        'total_listened_seconds': 180, 'max_contiguous_seconds': 180}
    with db.connect() as connection:
        connection.execute('''update integration.listen_history set
            device_id=%s,session_id=%s,source_entry_id=%s,played_at=%s,
            metadata=%s,scrobble_status='pending'
            where id=%s and account_id=%s and library_id=%s''',
            (device, playback, identity, start, Jsonb({'source_payload': payload}),
             event_id, data['account'], data['library']))
        connection.execute('''insert into app.capabilities(account_id,capability_key,scope_kind,scope_id)
            values(%s,'integration.lastfm.scrobbles.submit','library',%s)''',
            (data['account'], data['library']))
    actor = replace(actor, capability_grants=actor.capability_grants + (
        CapabilityGrant('integration.lastfm.scrobbles.submit', 'library', data['library']),))
    context = PolicyContext.build(actor=actor, action='integration.lastfm.scrobbles.submit',
        library_id=data['library'], deployment_mode='self_hosted',
        request_origin=RequestOrigin('internal', 'isolated_submit_test'), client_surface_class='private_web')
    monkeypatch.setattr(activity, '_recent_scrobble_connection_state', lambda _config, **scope: 'connected')
    snapshot = read(db, actor, kind='listens')['data']
    selected = next(row for row in snapshot['rows'] if row['title'] == 'Track 0000')
    origin = {'audience': 'own', 'subject_ref': None, 'kind': 'listens',
        'period': 'all', 'snapshot_ref': snapshot['snapshot_ref']}
    with db.connect() as connection:
        before = connection.execute('''select revision from app.activity_source_revisions
            where library_id=%s and account_id=%s''', (data['library'], data['account'])).fetchone()['revision']
    clock = [NOW]
    original_update = PostgresListenHistoryAdapter.update_scoped_entry
    def observe_committed_claim(self, **kwargs):
        result = original_update(self, **kwargs)
        if expire_after_claim and kwargs['updates'].get('scrobble_submission_state') == 'attempting':
            # Actual original method and connection commit have returned.
            clock[0] = NOW + timedelta(hours=13)
        return result
    monkeypatch.setattr(PostgresListenHistoryAdapter, 'update_scoped_entry', observe_committed_claim)
    monkeypatch.setattr(retry, 'lastfm_api_enabled', lambda _config: True)
    synthetic_session = object()
    def saved(_config, *, account_id):
        assert account_id == data['account']
        return synthetic_session
    monkeypatch.setattr(retry, 'get_saved_lastfm_session', saved)
    calls = []
    def provider(_config, supplied, *, session):
        assert not expire_after_claim and session is synthetic_session
        calls.append(supplied)
        assert supplied['timestamp'] == int(start.timestamp())
        # A different real connection sees the committed attempting receipt
        # and its real 0156 revision change before any provider response exists.
        with db.connect() as connection:
            receipt = connection.execute('select metadata from integration.listen_history where id=%s',
                (event_id,)).fetchone()['metadata']['source_payload']
            revision = connection.execute('''select revision from app.activity_source_revisions
                where library_id=%s and account_id=%s''', (data['library'], data['account'])).fetchone()['revision']
        assert receipt['scrobble_submission_state'] == 'attempting'
        assert receipt['scrobble_retry_count'] == 1 and revision > before
        for table, identity_value in [('app.accounts', data['account']), ('app.account_sessions', actor.session_id)]:
            with pytest.raises(psycopg.errors.LockNotAvailable):
                with db.connect() as connection:
                    connection.execute(f'select id from {table} where id=%s for update nowait', (identity_value,))
        return SimpleNamespace(succeeded=True, sent=True, message='')
    monkeypatch.setattr(retry, 'scrobble_track', provider)
    result = retry.RecentScrobbleRetry(db.config, connect=bounded_connect, clock=lambda: clock[0]).submit(
        context, origin=origin, row_ref=selected['id'])
    assert result['attempted'] is (not expire_after_claim)
    assert len(calls) == (not expire_after_claim)
    with db.connect() as connection:
        stored = connection.execute('select metadata from integration.listen_history where id=%s',
            (event_id,)).fetchone()['metadata']['source_payload']
    assert stored['scrobble_submission_state'] == ('not_sent' if expire_after_claim else 'accepted')
    assert stored['scrobble_retry_count'] == 1
    error_status(lambda: read(db, actor, kind='listens', snapshot_ref=snapshot['snapshot_ref']), 410)
