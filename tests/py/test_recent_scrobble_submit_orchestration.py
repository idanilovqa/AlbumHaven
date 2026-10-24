"""UNRUN source tests: full submit and genuine owners, explicit SQL/policy doubles.

These are not PostgreSQL lock/commit proofs. No provider/network is used.
"""
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import threading
from types import SimpleNamespace

import pytest

from music_app.services import lastfm_sync_bridge as bridge
from music_app.services import listen_history_postgres as ledger
from music_app.services import recent_scrobble_retry as retry
from music_app.services import measured_listen_history as measured
from music_app.services.recent_scrobble_admission import _current_target
from music_app.services.private_library_authority import PrivateLibraryAuthorityError

NOW = datetime(2026, 10, 21, 12, tzinfo=timezone.utc)
START = NOW - timedelta(hours=1)
DEVICE = '00000000-0000-4000-8000-000000000001'
SESSION = '00000000-0000-4000-8000-000000000002'
CONTEXT = SimpleNamespace(actor=SimpleNamespace(account_id=7, session_id=11), library_id=9)


class Harness:
    """Keep target decoder, adapter CAS, session checker, bridge and guard real."""
    def __init__(self, monkeypatch):
        self.events, self.provider_calls = [], []
        self.now, self.expires = NOW, NOW + timedelta(minutes=5)
        self.session = object()
        self.claim_hook = self.read_hook = self.cas_hook = None
        self.provider_hook = None
        self.fail_write = None
        self.reject_receipt = None
        self.denied_resource = None
        self.deny_authority = False
        self.api_enabled = True
        self.guard_lock = threading.Lock()
        self.guard_local = threading.local()
        entry_id = hashlib.sha256(measured.measured_identity(7, 9, DEVICE, SESSION).encode()).hexdigest()
        self.row = {'id': 91, 'account_id': 7, 'library_id': 9, 'track_id': 44,
            'source_family': 'rendered_local_listen_session', 'measurement_version': 'rendered-pcm-v1',
            'device_id': DEVICE, 'session_id': SESSION,
            'source_entry_id': measured.measured_identity(7, 9, DEVICE, SESSION),
            'played_at': START, 'scrobble_status': 'pending', 'metadata': {'source_payload': {
                'id': entry_id, 'device_id': DEVICE, 'session_id': SESSION,
                'measurement_version': 'rendered-pcm-v1',
                'source_provenance': {'kind': 'local_playback', 'provider': 'album_haven'},
                'artist': 'Artist', 'title': 'Track', 'started_at': START.isoformat(),
                'started_at_unix': int(START.timestamp()), 'duration_seconds': 300,
                'total_listened_seconds': 200, 'max_contiguous_seconds': 200,
                'sequence': 1, 'finalized': True, 'measured_listened_seconds': 200,
                'max_measured_contiguous_seconds': 200,
                'scrobbled': False, 'scrobble_eligible': True, 'scrobble_retryable': True,
                'scrobble_submission_state': 'not_sent'}}}
        self.original = deepcopy(self.row)
        real_adapter = ledger.PostgresListenHistoryAdapter
        self.adapter = real_adapter({'ALBUM_HAVEN_APP_DATABASE_URL': 'synthetic-unused'},
            connect=lambda _url: self.Connection(self))
        monkeypatch.setattr(ledger, 'PostgresListenHistoryAdapter', lambda _config: self.adapter)
        monkeypatch.setattr(retry, 'PostgresListenHistoryAdapter', lambda _config: self.adapter)
        monkeypatch.setattr(ledger, '_jsonb', lambda value: value)
        monkeypatch.setattr(retry, 'RecentScrobbleAdmission', lambda *a, **k: SimpleNamespace(review=self.review))
        monkeypatch.setattr(retry, 'current_library_transaction', self.authority)
        monkeypatch.setattr(retry, 'require_private_action', self.policy)
        monkeypatch.setattr(retry, 'lastfm_api_enabled', lambda _config: self.api_enabled)
        monkeypatch.setattr(retry, 'get_saved_lastfm_session', self.saved_session)
        monkeypatch.setattr(retry, 'scrobble_track', self.provider)
        # The real guard is retained in both owners. Only its SQL transport is doubled.
        assert retry.measured_provider_guard is measured.measured_provider_guard
        assert bridge.measured_provider_guard is measured.measured_provider_guard

    @property
    def entry(self):
        return self.row['metadata']['source_payload']

    def review(self, context, **kwargs):
        self.events.append('resolver_enter')
        target = _current_target(self.original, context=context, row_id=91)
        self.events.append('resolver_exit')
        return target

    @contextmanager
    def authority(self, _url, context, **kwargs):
        self.events.append('authority_enter')
        if self.deny_authority:
            raise PrivateLibraryAuthorityError('synthetic revoked authority')
        try:
            yield self.Connection(self), context, self.now
        finally:
            self.events.append('authority_exit')

    def policy(self, context, action, *, resource=None, **kwargs):
        self.events.append('policy')
        if self.denied_resource == 'all' or resource is not None and resource.resource_kind == self.denied_resource:
            raise PrivateLibraryAuthorityError('synthetic changed policy')

    def saved_session(self, _config, *, account_id):
        assert account_id == 7
        return self.session

    def provider(self, _config, payload, *, session):
        assert session is self.session
        assert self.entry['scrobble_submission_state'] == 'attempting'
        assert getattr(self.guard_local, 'session_checked', False)
        self.events.append('provider')
        self.provider_calls.append(deepcopy(payload))
        if self.provider_hook:
            return self.provider_hook()
        return SimpleNamespace(succeeded=True, sent=True, message='')

    def submit(self):
        return retry.RecentScrobbleRetry({'ALBUM_HAVEN_APP_DATABASE_URL': 'synthetic-unused'},
            clock=lambda: self.now).submit(CONTEXT, origin={}, row_ref='opaque-test-boundary')

    class Connection:
        def __init__(self, owner):
            self.owner, self.pending, self.guard = owner, None, False

        def __enter__(self):
            return self

        def __exit__(self, typ, value, trace):
            h = self.owner
            if self.pending is not None and typ is None:
                h.row = self.pending
                state = h.entry['scrobble_submission_state']
                h.events.append('commit:' + state)
                if state == 'attempting' and h.claim_hook:
                    h.claim_hook()
            elif self.pending is not None:
                h.events.append('rollback')
            if self.guard:
                h.events.append('guard_exit')
                h.guard_local.held = False
                h.guard_lock.release()
            return False

        def execute(self, sql, params):
            h = self.owner
            if 'pg_advisory_xact_lock' in sql:
                assert not getattr(h.guard_local, 'held', False), 'nested provider guard'
                assert h.guard_lock.acquire(timeout=5), 'synthetic guard wait exceeded bound'
                h.guard_local.held = self.guard = True
                h.guard_local.session_checked = False
                h.events.append('guard_enter')
                return None
            if 'from app.account_sessions' in sql:
                assert params == (11, 7)
                h.events.append('session_check')
                h.guard_local.session_checked = True
                row = {'id': 11, 'account_id': 7, 'authenticated_at': NOW - timedelta(hours=1),
                    'idle_expires_at': h.expires, 'absolute_expires_at': h.expires, 'revoked_at': None}
                cursor = SimpleNamespace(fetchall=lambda: [row], closed=False)
                cursor.close = lambda: setattr(cursor, "closed", True)
                return cursor
            if sql.startswith('select h.*'):
                assert params == (91, 7, 9)
                h.events.append('fresh_read')
                if h.read_hook:
                    h.read_hook()
                return SimpleNamespace(fetchone=lambda: deepcopy(h.row))
            if sql.startswith('select * from integration.listen_history'):
                assert params == (91, 7, 9)
                h.events.append('receipt_lock')
                phase = 'outcome' if h.provider_calls else 'claim'
                if h.reject_receipt == phase:
                    return SimpleNamespace(fetchone=lambda: None)
                if h.cas_hook:
                    hook, h.cas_hook = h.cas_hook, None
                    hook()
                return SimpleNamespace(fetchone=lambda: deepcopy(h.row))
            if sql.startswith('update integration.listen_history'):
                metadata, status, row_id, account_id, library_id = params
                assert (row_id, account_id, library_id) == (91, 7, 9)
                self.pending = {**deepcopy(h.row), 'metadata': deepcopy(metadata), 'scrobble_status': status}
                if h.fail_write == metadata['source_payload']['scrobble_submission_state']:
                    raise RuntimeError('synthetic write failure')
                return None
            raise AssertionError(sql)


@pytest.fixture
def harness(monkeypatch):
    return Harness(monkeypatch)


def test_full_submit_orders_resolver_exit_guard_authority_committed_claim_final_gate_provider_outcome(harness):
    h = harness
    result = h.submit()
    assert result == {'attempted': True, 'state': 'accepted', 'result': 'attempted'}
    ordered = ['resolver_exit', 'guard_enter', 'authority_enter', 'fresh_read',
        'commit:attempting', 'session_check', 'provider', 'commit:accepted', 'authority_exit', 'guard_exit']
    cursor = 0
    for event in ordered:
        cursor = h.events.index(event, cursor) + 1
    assert len(h.provider_calls) == 1
    assert h.provider_calls[0]['timestamp'] == int(START.timestamp())
    assert h.entry['scrobble_retry_count'] == 1


def test_session_expiring_during_claim_wait_records_known_no_send_and_spent_claim(harness):
    h = harness
    h.claim_hook = lambda: setattr(h, 'now', h.expires)
    result = h.submit()
    assert not result['attempted'] and not h.provider_calls
    assert h.entry['scrobble_submission_state'] == 'not_sent'
    assert h.entry['scrobble_retry_count'] == 1
    assert h.entry['last_scrobble_attempt_at'] == NOW.isoformat()
    assert h.events.index('commit:attempting') < h.events.index('commit:not_sent')


@pytest.mark.parametrize('resource', ['all', 'listen_history', 'track'])
def test_fresh_policy_not_snapshot_authorizes_submit(harness, resource):
    h = harness
    h.denied_resource = resource
    with pytest.raises(PrivateLibraryAuthorityError):
        h.submit()
    assert not h.provider_calls and 'receipt_lock' not in h.events


def test_fresh_revoked_authority_blocks_before_claim(harness):
    h = harness
    h.deny_authority = True
    with pytest.raises(PrivateLibraryAuthorityError):
        h.submit()
    assert not h.provider_calls and 'receipt_lock' not in h.events


@pytest.mark.parametrize('boundary', ['read', 'cas'])
@pytest.mark.parametrize('key,value', [('id', 92), ('account_id', 8), ('library_id', 10),
    ('source_family', 'foobar_import'), ('measurement_version', 'legacy'),
    ('device_id', '00000000-0000-4000-8000-000000000003'),
    ('session_id', '00000000-0000-4000-8000-000000000004'), ('track_id', 45),
    ('source_entry_id', 'changed'), ('played_at', START + timedelta(seconds=1))])
def test_identity_changes_at_fresh_read_or_locked_cas_never_send(harness, boundary, key, value):
    h = harness
    hook = lambda: h.row.update({key: value})
    setattr(h, boundary + '_hook', hook)
    try:
        h.submit()
    except retry.HomeActivityError:
        pass
    assert not h.provider_calls


@pytest.mark.parametrize('positive', ['column', 'raw', 'accepted', 'sent', 'uncertain', 'attempting'])
def test_delivery_arriving_at_cas_blocks_new_send(harness, positive):
    h = harness
    def change():
        if positive == 'column':
            h.row['scrobble_status'] = 'scrobbled'
        elif positive == 'raw':
            h.entry['scrobbled'] = True
        else:
            h.entry['scrobble_submission_state'] = positive
    h.cas_hook = change
    assert not h.submit()['attempted']
    assert not h.provider_calls


@pytest.mark.parametrize('boundary', ['attempting', 'accepted'])
def test_claim_or_outcome_write_failure_preserves_no_send_or_uncertain_fence(harness, boundary):
    h = harness
    h.fail_write = boundary
    with pytest.raises(RuntimeError, match='synthetic write failure'):
        h.submit()
    assert len(h.provider_calls) == (boundary == 'accepted')
    assert h.entry['scrobble_submission_state'] == ('not_sent' if boundary == 'attempting' else 'attempting')


@pytest.mark.parametrize('error', [TimeoutError('uncertain'), RuntimeError('uncertain'), KeyboardInterrupt()])
def test_provider_timeout_exception_or_cancel_leaves_attempting(harness, error):
    h = harness
    def fail():
        raise error
    h.provider_hook = fail
    with pytest.raises(type(error)):
        h.submit()
    assert h.entry['scrobble_submission_state'] == 'attempting'
    assert not h.submit()['attempted']
    assert len(h.provider_calls) == 1


@pytest.mark.parametrize('available', ['disabled', 'missing_session'])
def test_current_connection_required_before_claim(harness, available):
    h = harness
    if available == 'disabled':
        h.api_enabled = False
    else:
        h.session = None
    assert h.submit()['result'] == 'connection_unavailable'
    assert not h.provider_calls and 'receipt_lock' not in h.events


def test_two_targeted_calls_share_real_guard_owner_without_nested_guard(harness):
    h = harness
    results, errors = [], []
    def work():
        try:
            results.append(h.submit())
        except BaseException as exc:
            errors.append(exc)
    threads = [threading.Thread(target=work, daemon=True) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=5)
    assert not any(thread.is_alive() for thread in threads)
    assert not errors and len(results) == 2
    assert len(h.provider_calls) == 1
    assert sum(result['attempted'] for result in results) == 1


@pytest.mark.parametrize('newer', ['reauth', 'permanent', 'accepted'])
def test_actual_outer_measured_retry_cannot_write_over_newer_generation(harness, newer):
    h = harness
    stale = deepcopy(h.entry)
    writes = []
    def measured_submit(_config, payload):
        # Another guarded owner finishes before the delayed OUTER coordinator.
        h.entry.update(scrobble_retry_count=2, last_scrobble_attempt_at=NOW.isoformat(),
            scrobble_retryable=False, scrobble_reauthentication_required=newer == 'reauth',
            scrobbled=newer == 'accepted',
            scrobble_submission_state='accepted' if newer == 'accepted' else 'not_sent')
        return SimpleNamespace(succeeded=False, sent=False, message='older failure',
            attempted=True, reauthentication_required=False)
    bridge.process_pending_scrobble_attempt({}, stale,
        update_listen_history_entry=lambda *args, **kwargs: writes.append((args, kwargs)),
        scrobble_track=measured_submit, log_lastfm_scrobble_event=lambda *a, **k: None,
        bypass_backoff=True)
    assert writes == []
    assert h.entry['scrobble_retry_count'] == 2
    assert h.entry['last_scrobble_attempt_at'] == NOW.isoformat()
    assert h.entry['scrobble_retryable'] is False
    assert h.entry['scrobble_reauthentication_required'] is (newer == 'reauth')
    assert h.entry['scrobbled'] is (newer == 'accepted')


def test_legacy_outer_retry_keeps_existing_receipt_owner(monkeypatch):
    writes = []
    entry = {'id': 'legacy', 'artist': 'Artist', 'title': 'Track', 'started_at_unix': 1,
        'scrobbled': False, 'scrobble_eligible': True, 'scrobble_retryable': True}
    # Failure bookkeeping is deliberately retained for legacy submissions.
    # Prevent legacy sync-state IO explicitly at that separate boundary.
    entry['scrobble_retry_count'] = 0
    monkeypatch.setattr(bridge, 'record_pending_scrobble', lambda *a, **k: None)
    monkeypatch.setattr(bridge, 'clear_pending_scrobble', lambda *a, **k: None)
    result = bridge.process_pending_scrobble_attempt({}, entry,
        update_listen_history_entry=lambda *args, **kwargs: writes.append((args, kwargs)),
        scrobble_track=lambda *a, **k: SimpleNamespace(succeeded=False, sent=False, message='no send'),
        log_lastfm_scrobble_event=lambda *a, **k: None)
    assert result['failed'] and writes


def complete_measured(h, *, succeeds=False, reauthenticated=False, bypass_backoff=False):
    """Actual first-completion owner; only caller IO/transport boundaries doubled."""
    payload = deepcopy(h.entry)
    def provider(_config, normalized, *, session):
        assert session is h.session
        assert h.entry['scrobble_submission_state'] == 'attempting'
        h.provider_calls.append(deepcopy(normalized))
        return SimpleNamespace(succeeded=succeeds, sent=succeeds, message='synthetic result')
    return bridge.record_playback_session_complete({}, payload,
        user_timezone='UTC', account_id=7, library_id=9, lastfm_session=h.session,
        reauthenticated=reauthenticated, bypass_backoff=bypass_backoff,
        normalize_playback_track_payload=bridge.build_pending_scrobble_payload,
        is_meaningful_listen_session=lambda _entry: True,
        append_listen_history_entry=lambda *a, **k: ledger._listen_history_item_from_row(h.row),
        update_listen_history_entry=lambda _config, entry_id, updates, **scope:
            h.adapter.update_scoped_entry(row_id=91, entry_id=entry_id, updates=updates, **scope),
        scrobble_track=provider, log_lastfm_scrobble_event=lambda *a, **k: None)


def test_actual_first_completion_and_outer_measured_retries_spend_once_and_exhaust_fifth(harness):
    h = harness
    body, status = complete_measured(h)
    assert status == 200 and body['scrobble_attempted']
    assert h.entry['scrobble_retry_count'] == 1
    def submit_measured(_config, _payload):
        body, _status = complete_measured(h, bypass_backoff=True)
        return SimpleNamespace(succeeded=body['scrobbled'],
            sent=body['entry']['scrobble_submission_state'] in ('sent', 'uncertain', 'accepted'),
            attempted=body['scrobble_attempted'], message=body['scrobble_error'],
            reauthentication_required=body['entry'].get('scrobble_reauthentication_required', False))
    outer_writes = []
    for count in range(2, 6):
        result = bridge.process_pending_scrobble_attempt({}, deepcopy(h.entry),
            update_listen_history_entry=lambda *a, **k: outer_writes.append((a, k)),
            scrobble_track=submit_measured, log_lastfm_scrobble_event=lambda *a, **k: None,
            bypass_backoff=True)
        assert result['attempted'] and h.entry['scrobble_retry_count'] == count
    assert h.entry['scrobble_retry_exhausted'] is True
    body, _status = complete_measured(h)
    assert not body['scrobble_attempted']
    assert len(h.provider_calls) == 5 and outer_writes == []


def test_targeted_first_completion_and_outer_retry_share_one_guard_and_receipt(harness):
    h = harness
    results, errors = [], []
    def first():
        results.append(complete_measured(h, succeeds=True))
    def outer():
        def submit_measured(_config, _payload):
            body, _status = complete_measured(h, succeeds=True)
            return SimpleNamespace(succeeded=body['scrobbled'], sent=body['scrobbled'],
                attempted=body['scrobble_attempted'], message=body['scrobble_error'])
        results.append(bridge.process_pending_scrobble_attempt({}, deepcopy(h.original['metadata']['source_payload']),
            update_listen_history_entry=lambda *a, **k: pytest.fail('outer measured write'),
            scrobble_track=submit_measured, log_lastfm_scrobble_event=lambda *a, **k: None,
            bypass_backoff=True))
    def run(fn):
        try:
            fn()
        except BaseException as exc:
            errors.append(exc)
    workers = [lambda: results.append(h.submit()), first, outer]
    threads = [threading.Thread(target=run, args=(fn,), daemon=True) for fn in workers]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=5)
    assert not any(thread.is_alive() for thread in threads)
    assert not errors and len(results) == 3
    assert len(h.provider_calls) == 1 and h.entry['scrobble_retry_count'] == 1


def test_outcome_cas_rejection_is_not_reported_as_durable_acceptance(harness):
    h = harness
    def provider():
        h.row['track_id'] = 45
        return SimpleNamespace(succeeded=True, sent=True, message='')
    h.provider_hook = provider
    result = h.submit()
    assert result['attempted'] is True and result['state'] == 'delivery_unconfirmed'
    assert h.entry['scrobble_submission_state'] == 'attempting'


def test_postclaim_changed_resource_policy_records_safe_no_send(harness):
    h = harness
    h.claim_hook = lambda: setattr(h, 'denied_resource', 'track')
    result = h.submit()
    assert not result['attempted'] and not h.provider_calls
    assert h.entry['scrobble_submission_state'] == 'not_sent'
    assert h.entry['scrobble_retry_count'] == 1


@pytest.mark.parametrize('phase', ['claim', 'outcome'])
def test_full_submit_refused_receipt_write_never_implies_durable_acceptance(harness, phase):
    h = harness
    h.reject_receipt = phase
    result = h.submit()
    assert result['state'] != 'accepted'
    assert len(h.provider_calls) == (phase == 'outcome')
    assert h.entry['scrobble_submission_state'] == ('not_sent' if phase == 'claim' else 'attempting')


def test_actual_first_owner_does_not_report_durable_acceptance_after_refused_outcome(harness):
    h = harness
    h.reject_receipt = 'outcome'
    body, _status = complete_measured(h, succeeds=True)
    assert body['scrobble_attempted'] and body['scrobbled'] is False
    assert body['entry']['scrobble_submission_state'] == 'attempting'


def test_guarded_current_reauth_requires_existing_explicit_reauthenticated_owner(harness):
    h = harness
    h.entry.update(scrobble_retry_count=1, last_scrobble_attempt_at=START.isoformat(),
        scrobble_reauthentication_required=True)
    body, _status = complete_measured(h)
    assert not body['scrobble_attempted'] and not h.provider_calls
    body, _status = complete_measured(h, succeeds=True, reauthenticated=True)
    assert body['scrobbled'] and len(h.provider_calls) == 1
    assert h.entry['scrobble_retry_count'] == 2
    assert h.entry['scrobble_reauthentication_required'] is False


def test_guarded_current_backoff_cannot_be_replaced_by_stale_outer_time(harness):
    h = harness
    h.entry.update(scrobble_retry_count=1,
        last_scrobble_attempt_at=datetime.now(timezone.utc).isoformat())
    body, _status = complete_measured(h)
    assert not body['scrobble_attempted'] and not h.provider_calls
    body, _status = complete_measured(h, bypass_backoff=True)
    assert body['scrobble_attempted'] and len(h.provider_calls) == 1
    assert h.entry['scrobble_retry_count'] == 2
