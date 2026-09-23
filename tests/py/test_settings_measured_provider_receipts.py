"""Real scoped ledger receipts serialize duplicate provider submissions."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from threading import Event, Lock
from types import SimpleNamespace

import pytest
from tests.py.test_settings_measured_listen_ledger import ledger, measured, rows
from music_app.services import lastfm_sync_bridge as bridge, listen_history as history
from music_app.services.lastfm import LastfmSession


def payload(store, **changes):
    entry = measured(store['own'], finalized=True, **changes)
    entry['library_track_id'] = str(store['own']['track_id'])
    return entry


def complete(store, entry, provider, monkeypatch, *, scope=None):
    owner = scope or store['own']
    def forbidden(*args, **kwargs): pytest.fail('measured receipt touched legacy provider orchestration')
    monkeypatch.setattr(bridge, 'record_pending_scrobble', forbidden)
    monkeypatch.setattr(bridge, 'clear_pending_scrobble', forbidden)
    return bridge.record_playback_session_complete(store['config'], entry,
        account_id=owner['account_id'], library_id=owner['library_id'],
        lastfm_session=LastfmSession('owned-test', 'owned-test-session', ''), user_timezone='UTC',
        normalize_playback_track_payload=lambda value:value,
        is_meaningful_listen_session=history.is_meaningful_listen_session,
        append_listen_history_entry=history.append_listen_history_entry,
        update_listen_history_entry=history.update_listen_history_entry,
        scrobble_track=provider, log_lastfm_scrobble_event=lambda *args,**kwargs:None)


def test_concurrent_duplicate_completion_sends_once_and_reuses_scoped_receipt(ledger, monkeypatch):
    real_guard = getattr(bridge, 'measured_provider_guard', None)
    assert callable(real_guard), 'Provider receipt requires the real per-session database guard'
    started, second_attempt, release = Event(), Event(), Event()
    lock = Lock(); attempts = []; sends = []
    @contextmanager
    def observed_guard(*args, **kwargs):
        with lock:
            attempts.append(1)
            if len(attempts) == 2: second_attempt.set()
        with real_guard(*args, **kwargs): yield
    monkeypatch.setattr(bridge, 'measured_provider_guard', observed_guard)
    def provider(config, item, *, session):
        sends.append(session.username); started.set()
        assert release.wait(5), 'Test release guard expired'
        return None
    entry = payload(ledger)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(complete, ledger, dict(entry), provider, monkeypatch)
        assert started.wait(5), 'First request never reached provider'
        second = pool.submit(complete, ledger, dict(entry), provider, monkeypatch)
        try: assert second_attempt.wait(5), 'Duplicate did not enter the same provider guard'
        finally: release.set()
        results = [first.result(5), second.result(5)]
    assert sends == ['owned-test']
    assert all(code == 200 and body['scrobbled'] for body, code in results)
    assert len(rows(ledger)) == 1


def test_foreign_scope_cannot_send_or_record_receipt_for_owned_track(ledger, monkeypatch):
    calls = []
    def provider(*args, **kwargs): calls.append(1)
    with pytest.raises(ValueError): complete(ledger, payload(ledger), provider, monkeypatch, scope=ledger['other'])
    assert calls == [] and rows(ledger) == [] and rows(ledger, ledger['other']) == []


def test_immediate_scrobble_then_final_completion_preserves_server_receipt(ledger, monkeypatch):
    from music_app.routes import api_wave_b_asgi_routes as wave
    from music_app.services import current_actor_asgi
    owner = ledger['own']; entry = payload(ledger); entry['finalized'] = False
    actor = SimpleNamespace(account_id=owner['account_id'], is_authenticated=True, current_library_id=owner['library_id'],
                            library_relationships=(SimpleNamespace(library_id=owner['library_id']),))
    async def resolve(_request): return actor
    async def body(): return entry
    calls=[]
    def provider(config, item, *, session): calls.append(session.username); return None
    monkeypatch.setattr(current_actor_asgi, 'current_actor_from_request', resolve)
    monkeypatch.setattr(wave, 'current_actor_from_request', resolve, raising=False)
    monkeypatch.setattr(wave, '_app_config', lambda _request:ledger['config'])
    monkeypatch.setattr(wave, '_app_logger', lambda _request:SimpleNamespace(log=lambda *args:None))
    monkeypatch.setattr(wave, 'get_saved_lastfm_session', lambda config, *, account_id:LastfmSession('owned-test','owned-test-session',''), raising=False)
    monkeypatch.setattr(wave, 'get_lastfm_user_timezone', lambda *args,**kwargs:'UTC')
    monkeypatch.setattr(wave, 'scrobble_track', provider)
    monkeypatch.setattr(wave, '_log_lastfm_scrobble_event', lambda *args,**kwargs:None)
    request=SimpleNamespace(json=body,state=SimpleNamespace(current_actor=actor),app=SimpleNamespace(state=SimpleNamespace(config=ledger['config'])))
    response=asyncio.run(wave.playback_session_scrobble(request))
    assert response.status_code == 200
    before=rows(ledger);assert len(before)==1 and before[0]['finalized'] is False
    final={**entry,'sequence':2,'finalized':True,'scrobbled':False}
    result,code=complete(ledger,final,provider,monkeypatch)
    assert code==200 and result['scrobbled'] is True
    after=rows(ledger)
    assert len(after)==1 and after[0]['id']==before[0]['id'] and after[0]['finalized'] is True
    assert calls==['owned-test']


def test_sent_unconfirmed_receipt_survives_next_sequence_without_resubmission(ledger, monkeypatch):
    from music_app.services.lastfm import LastfmSubmissionOutcome
    calls=[]
    def provider(config, item, *, session):
        calls.append(1)
        return LastfmSubmissionOutcome(sent=True,accepted=0,outcome='unconfirmed',message='Provider outcome unconfirmed')
    first=payload(ledger);first['finalized']=False
    complete(ledger,first,provider,monkeypatch)
    final={**first,'sequence':2,'finalized':True}
    body,code=complete(ledger,final,provider,monkeypatch)
    assert code==200 and body['scrobbled'] is False
    assert calls==[1]
    assert rows(ledger)[0]['metadata']['source_payload']['scrobble_submission_state'] in ('sent','uncertain')


@pytest.mark.parametrize('code', [11, 16, 29, 9])
def test_explicit_provider_rejection_can_retry_without_duplicating_acceptance(ledger, monkeypatch, code):
    from music_app.services.lastfm import LastfmError
    calls = []
    def provider(*args, **kwargs):
        calls.append(True)
        if len(calls) == 1:
            raise LastfmError('Explicit provider rejection', code=code, retryable=code != 9,
                              reauthentication_required=code == 9, error_kind='provider_error')
    entry = payload(ledger)
    body, status = complete(ledger, entry, provider, monkeypatch)
    assert status == 200 and body['scrobbled'] is False
    receipt = rows(ledger)[0]['metadata']['source_payload']
    assert receipt['scrobble_submission_state'] == 'not_sent'
    assert receipt['scrobble_retryable'] is True
    assert len(history.load_pending_scrobble_entries(ledger['config'])) == 1
    body, status = complete(ledger, entry, provider, monkeypatch)
    assert status == 200 and body['scrobbled'] is True
    complete(ledger, entry, provider, monkeypatch)
    assert len(calls) == 2
    assert len(rows(ledger)) == 1


@pytest.mark.parametrize('kind', ['network_error', 'malformed_response', 'provider_error'])
def test_ambiguous_retryable_error_never_resubmits_without_provider_rejection(ledger, monkeypatch, kind):
    from music_app.services.lastfm import LastfmError
    calls = []
    def provider(*args, **kwargs):
        calls.append(True)
        raise LastfmError('No authoritative provider result', retryable=True, error_kind=kind)
    entry = payload(ledger)
    complete(ledger, entry, provider, monkeypatch)
    receipt = rows(ledger)[0]['metadata']['source_payload']
    assert receipt['scrobble_submission_state'] == 'uncertain'
    assert receipt['scrobble_retryable'] is False
    complete(ledger, entry, provider, monkeypatch)
    assert calls == [True]
    assert history.load_pending_scrobble_entries(ledger['config']) == []
