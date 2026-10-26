"""Authored-only harness for the REAL worker and durable repository composition.

At future execution this starts the production one-worker loop on synthetic
pool/driver results. No coordinator, protocol receipt, authority, preflight,
Prepare, Apply or reconciliation result is replaced. No execution was authorized
or performed while writing this packet. Native PostgreSQL behavior is not proved.
"""
from contextlib import contextmanager
from dataclasses import replace
import json
from threading import Event

from music_app.services import foobar_account_import_service as s
from music_app.services import foobar_account_job_worker as worker
from music_app.services import foobar_account_import_review as review
from music_app.services import foobar_account_retry_reconciliation as reconciliation
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.foobar_account_import_jobs_testing import (
    jobs, p, a, f, URL, JOB, SOURCE, GEN, CAPACITY, PAYLOAD,
    payload_rows, make_command, requested_context, start, status, prepare,
)
from tests.py.foobar_account_service_testing import handles
from tests.py.foobar_account_service_readiness_testing import install_catalog
from tests.py.foobar_account_route_testing import route, request
from tests.py.foobar_account_personal_testing import install


def command(db, payload, total_rows, *, library=None, job_ref=JOB):
    seed = make_command(db, payload=payload, library=library)
    result = jobs.FoobarJobCommand(seed.source_ref, job_ref, seed.upload_sha256,
        p.parser._VERSION, seed.mapping_name, library, seed.generation, total_rows)
    return result, seed.inventory_sha256


@contextmanager
def running(monkeypatch, *, db=None, release=None):
    """The real worker thread and startup gates, not OPEN scheduler emulation."""
    db = install(monkeypatch) if db is None else db
    catalog = install_catalog(monkeypatch)
    handle, = handles(monkeypatch, open=False)
    try:
        assert handle.start(2.0)
        assert handle.owner.thread.is_alive()
        yield db, handle, catalog
    finally:
        if release is not None:
            release.set()
        handle.close()
        assert handle.join(5.0), 'Actual worker did not settle and exit'
        assert not handle.owner.thread.is_alive()


UNREVIEWED_SHA256 = '0' * 64


def begin_review(handle, payload, *, ctx=None, library=None, source_ref=SOURCE,
                 job_ref=JOB, resume=False, conflict_after=0, previous_review_sha256=None, problem_after=0):
    request = review.FoobarReviewRequest(source_ref, job_ref, library, resume,
        conflict_after=conflict_after, previous_review_sha256=previous_review_sha256, problem_after=problem_after)
    ticket = handle.begin_review(context=ctx or requested_context(library),
        constraints=PolicyEvaluationConstraints(), request=request, length=len(payload))
    handle.append_prepare(ticket, payload)
    handle.finish_prepare(ticket)
    return ticket


def settled_review(handle, previous=None, *, timeout=5.0):
    owner = handle.owner
    with owner.condition:
        assert owner.condition.wait_for(lambda: owner.state is s._State.FAULTED or
            owner.current is None and owner.last_review is not previous, timeout=timeout)
        assert owner.state is s._State.OPEN
        assert type(owner.last_review) is review.FoobarReviewProgress
        assert owner.current is None
        return owner.last_review


def review_sha(progress):
    assert progress.phase == 'review_ready' and progress.result is not None
    result = progress.result
    return review.review_intent_sha256(result.command, result.inventory_sha256,
        result.resume, result.proposed.proposal_sha256)


def reviewed(handle, payload, *, ctx=None, library=None, source_ref=SOURCE,
             job_ref=JOB, resume=False, conflict_after=0, previous_review_sha256=None, problem_after=0):
    previous = handle.owner.last_review
    begin_review(handle, payload, ctx=ctx, library=library, source_ref=source_ref,
        job_ref=job_ref, resume=resume, conflict_after=conflict_after,
        previous_review_sha256=previous_review_sha256, problem_after=problem_after)
    # Whole-upload rollback review is real work: the unchanged 4 MiB proof
    # selects smaller windows. Measured 203-row review exceeds five seconds.
    # Keep small fixtures and checkpoint/release waits at their original limits.
    result = settled_review(handle, previous,
        timeout=30.0 if payload.count(b'\n') > 100 else 5.0)
    assert result.phase == 'review_ready', result
    return result


def submit(handle, cmd, inventory, payload, *, ctx=None, resume=False, review_sha256=None):
    # The new protocol prerequisite is a REAL completed review on the same
    # service, not a fabricated coordinator result or counts-derived seal.
    if review_sha256 is None:
        result = reviewed(handle, payload, ctx=ctx, library=cmd.original_matching_library_id,
            source_ref=cmd.source_ref, job_ref=cmd.job_ref, resume=resume)
        assert result.result.command == cmd and result.result.inventory_sha256 == inventory
        review_sha256 = review_sha(result)
    ticket = handle.begin_job(context=ctx or requested_context(cmd.original_matching_library_id),
        constraints=PolicyEvaluationConstraints(), command=cmd,
        inventory_sha256=inventory, review_sha256=review_sha256, length=len(payload), resume=resume)
    handle.append_prepare(ticket, payload)
    handle.finish_prepare(ticket)
    return ticket


def settled(handle, previous=None, *, timeout=5.0):
    owner = handle.owner
    with owner.condition:
        assert owner.condition.wait_for(lambda: owner.state is s._State.FAULTED or
            owner.current is None and owner.last_job is not previous, timeout=timeout)
        assert owner.state is s._State.OPEN
        assert type(owner.last_job) is worker.FoobarJobProgress
        assert owner.current is None
        return owner.last_job


def block_sql(monkeypatch, db, sql, *, after=False, release=None):
    entered = Event()
    release = Event() if release is None else release
    real = db.execute
    captured = []
    def execute(statement, params=None, **kwargs):
        if statement != sql or captured:
            return real(statement, params, **kwargs)
        captured.append((statement, params))
        value = real(statement, params, **kwargs) if after else None
        entered.set()
        assert release.wait(5.0), 'Synthetic driver checkpoint was not released'
        return value if after else real(statement, params, **kwargs)
    monkeypatch.setattr(db, 'execute', execute)
    return entered, release, captured


def start_body(cmd, inventory, review_sha256=UNREVIEWED_SHA256):
    return dict(version=route.JOB_PROTOCOL, inventory_sha256=inventory, review_sha256=review_sha256,
        **{field:getattr(cmd, field) for field in route._JOB_COMMAND_FIELDS})


def sign_ui_request(req, *, ctx=None):
    # Use the real production context function on a synthetic authenticated
    # identity only to construct the browser's prior server-issued marker.
    # Remove it afterwards: the route must resolve its own current actor.
    req.state.current_actor = (ctx or requested_context(None)).actor
    value = route.foobar_account_ui_context_ref(req)
    del req.state.current_actor
    req.scope['headers'][:] = [(key, item) for key, item in req.scope['headers']
        if key != b'x-albumhaven-foobar-context'] + [(b'x-albumhaven-foobar-context', value.encode())]
    return value


def job_request(monkeypatch, handle, kind, cmd, *, inventory=None, payload=None,
                review_sha256=UNREVIEWED_SHA256, **kwargs):
    body = (json.dumps(dict(version=route.JOB_PROTOCOL,
        source_ref=cmd.source_ref, job_ref=cmd.job_ref)).encode() if payload is None else payload)
    req, auth, reads = request(monkeypatch, body, handle=handle, **kwargs)
    path = '/integrations/foobar/account/job/' + kind
    req.scope.update(path=path, raw_path=path.encode())
    sign_ui_request(req)
    if payload is not None:
        req.scope['headers'][:] = [(key, value) for key, value in req.scope['headers']
            if key != b'content-type'] + [(b'content-type', b'text/tab-separated-values'),
            (b'x-album-haven-foobar-bytes', str(len(payload)).encode()),
            (b'x-albumhaven-foobar-command',
                json.dumps(start_body(cmd, inventory, review_sha256), separators=(',', ':')).encode())]
    return req, auth, reads


def assert_contiguous_windows(windows, total, *, start=0):
    """Independently prove exact-once coverage without assuming a batch size."""
    cursor = start
    covered = []
    for left, right in windows:
        assert left == cursor and 0 < right - left <= 100
        covered.extend(range(left, right))
        cursor = right
    assert cursor == total
    assert covered == list(range(start, total))
    assert len(covered) == len(set(covered))


def assert_confirmed_terminals(db, result, total):
    attempts = sorted((row for row in db.attempts.values() if row['state'] == 'confirmed'),
        key=lambda row: row['batch_no'])
    terminals = [tuple(json.loads(row['terminal_bytes'])) for row in attempts]
    assert_contiguous_windows([(t[14] - 1, t[15] - 1) for t in terminals], total)
    assert result.status.confirmed_counts == tuple(map(sum, zip(*(t[16:23] for t in terminals))))
    assert len(db.source_rows) == total
    assert len({row['prepare_key'] for row in attempts}) == len(attempts)
    assert len({row['apply_key'] for row in attempts}) == len(attempts)
    assert all(row['prepare_key'] != row['apply_key'] for row in attempts)
    assert all(row['prepare_key'] in db.keys and row['apply_key'] in db.keys for row in attempts)
    assert db.calls.count(p._INSERT_READY_SQL) == db.calls.count(f._COMMIT_SQL) == len(attempts)
    return terminals
