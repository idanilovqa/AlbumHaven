"""AUTHORED ONLY: real async handlers/auth/CSRF/service/worker/repository.

The request transport and database-driver result sets are synthetic. These
source tests make no claim about running an ASGI application or real database.
"""
import json
from threading import Event
from dataclasses import replace

import pytest

from tests.py.foobar_account_job_worker_testing import (
    running, command, settled, block_sql, install, jobs, s, p, f, payload_rows,
    job_request, requested_context, PolicyEvaluationConstraints, route, JOB, SOURCE,
    reviewed, review_sha, sign_ui_request, assert_confirmed_terminals,
)


def decoded(response):
    assert response.headers['cache-control'] == 'private, no-store'
    assert response.headers['x-content-type-options'] == 'nosniff'
    return json.loads(response.body)


@pytest.mark.asyncio
async def test_actual_start_status_cancel_resume_handlers_share_one_real_worker(monkeypatch):
    db = install(monkeypatch)
    release = Event()
    with running(monkeypatch, db=db, release=release) as (db, handle, catalog):
        payload = payload_rows(103)
        cmd, inventory = command(db, payload, 103)
        seal = review_sha(reviewed(handle, payload))
        entered, release, unused = block_sql(monkeypatch, db, f._COMMIT_SQL, after=True, release=release)
        req, auth, reads = job_request(monkeypatch, handle, 'start', cmd,
            inventory=inventory, payload=payload, review_sha256=seal)
        response = await route.foobar_account_job_start(req)
        accepted = decoded(response)
        assert response.status_code == 202 and accepted['operation'] == 'start'
        assert accepted['durable_start_confirmed'] is False
        assert accepted['phase'] == 'accepted_for_validation'
        assert 'confirmed_rows' not in accepted and 'confirmed_counts' not in accepted
        assert entered.wait(30.0)
        owner, operation = handle.owner, handle.owner.current
        assert not handle.available
        req, unused_auth, unused_reads = job_request(monkeypatch, handle, 'status', cmd)
        response = await route.foobar_account_job_status(req)
        current = decoded(response)['result']
        assert response.status_code == 200  # occupied job must not turn status into 503
        assert current['snapshot_kind'] == 'last_confirmed' and current['confirmed_rows'] == 0
        assert current['confirmed_counts'] == [0] * 7
        assert current['preflight']['checked_rows'] == 103
        assert current['preflight']['proposed_counts'] == [0, 103, 0, 0, 0, 0, 0]
        assert current['preflight']['advisory_not_reservation'] is True
        req, unused_auth, unused_reads = job_request(monkeypatch, handle, 'cancel', cmd)
        response = await route.foobar_account_job_cancel(req)
        cancelling = decoded(response)['result']
        assert response.status_code == 202 and cancelling['cancel_pending'] is True
        assert cancelling['confirmed_rows'] == 0  # in-flight commit is not yet asserted
        assert owner.current is operation and owner.next_ticket == 3
        release.set()
        cancelled = settled(handle, timeout=30.0)
        first_end = cancelled.proposed.window_seals[0][1]
        assert 0 < first_end <= 100
        assert cancelled.status.confirmed_through == first_end and cancelled.status.cancel_requested
        req, unused_auth, unused_reads = job_request(monkeypatch, handle, 'status', cmd)
        response = await route.foobar_account_job_status(req)
        durable = decoded(response)['result']
        assert response.status_code == 200 and durable['snapshot_kind'] == 'durable'
        assert durable['confirmed_rows'] == first_end and durable['remaining_rows'] == 103 - first_end
        assert durable['confirmed_counts'] == [0, first_end, 0, 0, 0, 0, 0]
        current = requested_context(None)
        current = replace(current, actor=replace(current.actor, session_id=4))
        seal = review_sha(reviewed(handle, payload, ctx=current, resume=True))
        req, auth, unused_reads = job_request(monkeypatch, handle, 'resume', cmd,
            inventory=inventory, payload=payload, review_sha256=seal)
        auth.session_id = 4
        sign_ui_request(req, ctx=current)
        response = await route.foobar_account_job_resume(req)
        assert response.status_code == 202 and decoded(response)['operation'] == 'resume'
        complete = settled(handle, cancelled, timeout=30.0)
        assert complete.phase == 'completed' and complete.status.confirmed_through == 103
        assert_confirmed_terminals(db, complete, 103)
        assert all(a['original_session_id'] == 4 for a in db.attempts.values() if a['batch_no'] > 1)
        assert handle.owner is owner and owner.thread.is_alive()


@pytest.mark.asyncio
@pytest.mark.parametrize('kind', ['start', 'status', 'cancel', 'resume'])
@pytest.mark.parametrize('failure', ['missing_csrf', 'foreign_origin', 'revoked', 'inactive'])
async def test_job_handlers_keep_actual_auth_csrf_failure_before_body_and_slot(monkeypatch, kind, failure):
    with running(monkeypatch) as (db, handle, catalog):
        payload = payload_rows(1)
        cmd, inventory = command(db, payload, 1)
        kwargs = dict(inventory=inventory, payload=payload) if kind in ('start', 'resume') else {}
        req, auth, reads = job_request(monkeypatch, handle, kind, cmd,
            csrf=failure != 'missing_csrf', origin='https://other.invalid' if failure == 'foreign_origin'
                else 'https://synthetic.invalid', **kwargs)
        auth.revoked = failure == 'revoked'
        auth.active = failure != 'inactive'
        response = await route._run_job(req, kind)
        assert response.status_code in (401, 403)
        assert decoded(response)['error'] in ('authentication_required', 'forbidden')
        assert reads[0] == 0 and handle.owner.current is None and not db.job_rows


@pytest.mark.asyncio
async def test_start_does_not_wait_for_finish_and_duplicate_start_cannot_replace_busy_owner(monkeypatch):
    db = install(monkeypatch)
    release = Event()
    with running(monkeypatch, db=db, release=release) as (db, handle, catalog):
        payload = payload_rows(1)
        cmd, inventory = command(db, payload, 1)
        seal = review_sha(reviewed(handle, payload))
        entered, release, unused = block_sql(monkeypatch, db, p._INSERT_READY_SQL, release=release)
        req, unused_auth, unused_reads = job_request(monkeypatch, handle, 'start', cmd,
            inventory=inventory, payload=payload, review_sha256=seal)
        response = await route.foobar_account_job_start(req)
        assert response.status_code == 202 and decoded(response)['durable_start_confirmed'] is False
        assert entered.wait(3.0)
        operation = handle.owner.current
        req, unused_auth, reads = job_request(monkeypatch, handle, 'start', cmd,
            inventory=inventory, payload=payload)
        response = await route.foobar_account_job_start(req)
        assert response.status_code == 503 and reads[0] == 0
        assert handle.owner.current is operation and handle.owner.next_ticket == 3
        release.set()
        assert settled(handle).phase == 'completed'


@pytest.mark.asyncio
async def test_idle_status_uses_real_current_repository_not_retained_process_summary(monkeypatch):
    with running(monkeypatch) as (db, handle, catalog):
        payload = payload_rows(1)
        cmd, inventory = command(db, payload, 1)
        seal = review_sha(reviewed(handle, payload))
        req, unused_auth, unused_reads = job_request(monkeypatch, handle, 'start', cmd,
            inventory=inventory, payload=payload, review_sha256=seal)
        assert (await route.foobar_account_job_start(req)).status_code == 202
        previous = settled(handle)
        assert previous.phase == 'completed'
        db.accounts[1] = False  # native current-authority read, not request actor cache
        req, unused_auth, unused_reads = job_request(monkeypatch, handle, 'status', cmd)
        response = await route.foobar_account_job_status(req)
        result = decoded(response)
        assert response.status_code == 409 and result['error'] == 'stale_import'
        assert 'result' not in result
        assert handle.owner.last_job is previous


@pytest.mark.asyncio
async def test_job_json_shape_errors_do_not_allocate_or_cancel(monkeypatch):
    with running(monkeypatch) as (db, handle, catalog):
        payload = payload_rows(1)
        cmd, inventory = command(db, payload, 1)
        req, unused_auth, reads = job_request(monkeypatch, handle, 'start', cmd,
            inventory=inventory, payload=payload)
        req.scope['headers'].append((b'x-albumhaven-foobar-command', b'{}'))
        response = await route.foobar_account_job_start(req)
        assert response.status_code == 400 and reads[0] == 0
        assert handle.owner.current is None and not db.job_rows
        req, unused_auth, reads = job_request(monkeypatch, handle, 'status', cmd)
        req.scope['query_string'] = b'job_ref=ignored'
        response = await route.foobar_account_job_status(req)
        assert response.status_code == 400 and reads[0] == 0
        assert handle.owner.current is None


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', ['parser', 'readiness'])
async def test_settled_failure_diagnostic_is_separate_from_durable_status_and_has_no_counts(monkeypatch, failure):
    with running(monkeypatch) as (db, handle, catalog):
        payload = payload_rows(1) + (b'bad\textra\n' if failure == 'parser' else b'')
        cmd, inventory = command(db, payload, 1)
        if failure == 'readiness':
            catalog.job_rows = [{'structural_ready':False}]
        req, unused_auth, unused_reads = job_request(monkeypatch, handle, 'start', cmd,
            inventory=inventory, payload=payload)
        response = await route.foobar_account_job_start(req)
        assert response.status_code == 202
        previous = settled(handle)
        req, unused_auth, unused_reads = job_request(monkeypatch, handle, 'status', cmd)
        response = await route.foobar_account_job_status(req)
        value = decoded(response)
        assert response.status_code in (409, 503) and value['protocol'] == route.JOB_PROTOCOL
        assert 'result' not in value
        diagnostic = value['settled_diagnostic']
        assert diagnostic == dict(phase=previous.phase, error=previous.error,
            uncertain=previous.uncertain, snapshot_kind='settled_process_diagnostic', durable_proof=False)
        assert not {'confirmed_rows', 'confirmed_counts', 'command', 'preflight'} & set(diagnostic)
        assert not db.job_rows and handle.owner.last_job is previous


@pytest.mark.asyncio
async def test_auth_failure_never_discloses_settled_diagnostic(monkeypatch):
    with running(monkeypatch) as (db, handle, catalog):
        payload = payload_rows(1) + b'bad\textra\n'
        cmd, inventory = command(db, payload, 1)
        req, unused_auth, unused_reads = job_request(monkeypatch, handle, 'start', cmd,
            inventory=inventory, payload=payload)
        assert (await route.foobar_account_job_start(req)).status_code == 202
        settled(handle)
        req, unused_auth, reads = job_request(monkeypatch, handle, 'status', cmd, csrf=False)
        response = await route.foobar_account_job_status(req)
        value = decoded(response)
        assert response.status_code == 403 and value['protocol'] == route.JOB_PROTOCOL
        assert value['settled_diagnostic'] is None and reads[0] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize('mode', ['claimed', 'cancelled_claim', 'new_session_claim', 'ready'])
async def test_idle_pending_attempt_does_not_invent_confirmed_counts_or_certainty(monkeypatch, mode):
    from tests.py.foobar_account_import_jobs_testing import start, prepare, cancel
    db = install(monkeypatch)
    ctx, cmd, batch, upload = start(db)
    try:
        if mode == 'ready':
            prepare(ctx, batch, upload)
        elif mode == 'cancelled_claim':
            cancel(ctx, cmd)
    finally:
        upload.close()
    with running(monkeypatch, db=db) as (db, handle, catalog):
        req, auth, unused_reads = job_request(monkeypatch, handle, 'status', cmd)
        if mode == 'new_session_claim':
            auth.session_id = 4
            current = requested_context(None)
            sign_ui_request(req, ctx=replace(current, actor=replace(current.actor, session_id=4)))
        response = await route.foobar_account_job_status(req)
        wire = decoded(response)['result']
        assert response.status_code == 200 and wire['snapshot_kind'] == 'durable'
        assert wire['confirmed_rows'] == 0 and wire['confirmed_counts'] == [0] * 7
        assert wire['remaining_rows'] == cmd.total_rows
        assert wire['pending_attempt'] == dict(batch_no=1, attempt_no=1,
            state='ready' if mode == 'ready' else 'claimed')
        assert wire['uncertain'] is (mode != 'ready')
        assert not db.source_rows
        if mode == 'cancelled_claim':
            assert wire['cancel_requested'] and wire['disposition'] == 'cancelled'
        elif mode == 'new_session_claim':
            assert wire['disposition'] == 'needs_resume'
