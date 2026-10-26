"""Authored-only helpers for actual rollback review and confirmed worker handoff.

Only accepted synthetic SQL-result drivers, fixed authority time, request bytes
and driver checkpoints are used. No source owner or semantic result is replaced.
"""
from copy import deepcopy
from dataclasses import replace
import json

from tests.py.foobar_account_job_worker_testing import (
    running, command, submit, settled, block_sql, install, jobs, worker, review,
    s, p, a, f, reconciliation, requested_context, payload_rows, start, status,
    prepare, URL, JOB, SOURCE, PAYLOAD, PolicyEvaluationConstraints,
    begin_review, settled_review, reviewed, review_sha, sign_ui_request,
    job_request, request, route, UNREVIEWED_SHA256,
)
from tests.py.foobar_account_import_jobs_testing import snapshot, account_authority, authority

NEXT_JOB = '66666666-6666-4666-8666-666666666666'
BUSINESS_STATE = ('revision', 'source_rows', 'source_versions', 'tastes', 'history',
    'bindings', 'receipt', 'receipts', 'keys', 'key_scopes', 'key_times', 'history_projections')


def business_snapshot(db):
    return deepcopy(tuple(getattr(db, name) for name in BUSINESS_STATE))


def confirm(handle, progress, payload, *, ctx=None, seal=None):
    result = progress.result
    assert result is not None
    return submit(handle, result.command, result.inventory_sha256, payload,
        ctx=ctx, resume=result.resume, review_sha256=review_sha(progress) if seal is None else seal)


def review_request(monkeypatch, handle, kind, *, payload=None, library=None,
                   source_ref=SOURCE, job_ref=JOB, resume=False, ctx=None,
                   conflict_after=0, previous_review_sha256=None, problem_after=0, **kwargs):
    value = dict(version=route.REVIEW_PROTOCOL, source_ref=source_ref, job_ref=job_ref)
    if kind == 'start':
        value.update(matching_library_id=library, resume=resume, mapping_name=p.gate.MAPPING,
            conflict_after=conflict_after, previous_review_sha256=previous_review_sha256, problem_after=problem_after)
        assert payload is not None
        body = payload
    else:
        assert payload is None
        body = json.dumps(value).encode()
    req, auth, reads = request(monkeypatch, body, handle=handle, **kwargs)
    path = '/integrations/foobar/account/review/' + kind
    req.scope.update(path=path, raw_path=path.encode())
    if ctx is not None:
        assert ctx.actor.account_id == 1  # actual AuthDatabase row owner
        auth.session_id = ctx.actor.session_id
    sign_ui_request(req, ctx=ctx)
    if kind == 'start':
        req.scope['headers'] = [(key, item) for key, item in req.scope['headers']
            if key != b'content-type'] + [(b'content-type', b'text/tab-separated-values'),
            (b'x-album-haven-foobar-bytes', str(len(payload)).encode()),
            (b'x-albumhaven-foobar-command', json.dumps(value, separators=(',', ':')).encode())]
    return req, auth, reads


def decoded(response):
    assert response.headers['cache-control'] == 'private, no-store'
    assert response.headers['x-content-type-options'] == 'nosniff'
    return json.loads(response.body)
