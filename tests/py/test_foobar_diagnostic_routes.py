"""AUTHORED ONLY. Actual HTTP handlers, one-worker review and cached intent."""
from dataclasses import replace
import json

import pytest

from tests.py.foobar_account_personal_testing import install, matched_payload, personal_snapshot, p
from tests.py.foobar_account_review_testing import (
    running, reviewed, review_sha, requested_context, review_request, decoded,
    route, settled_review, begin_review, PolicyEvaluationConstraints, SOURCE, JOB,
)
from tests.py.test_foobar_diagnostic_paging import diagnostic_payload, expected_diagnostics
from tests.py.test_foobar_personal_conflict_routes import personal_request


@pytest.mark.asyncio
async def test_real_start_status_pages_reach_every_instance_and_keep_original_intent(monkeypatch):
    db = install(monkeypatch)
    payload = diagnostic_payload(103)
    with running(monkeypatch, db=db) as (db, handle, catalog):
        cursor, digest, previous, command, all_items = 0, None, None, None, []
        before = personal_snapshot(db)
        while cursor is not None:
            req, auth, reads = review_request(monkeypatch, handle, 'start', payload=payload,
                library=7, problem_after=cursor, previous_review_sha256=digest)
            response = await route.foobar_account_review_start(req)
            assert response.status_code == 202 and reads[0] == 1
            progress = settled_review(handle, previous)
            assert progress.phase == 'review_ready'
            req, auth, reads = review_request(monkeypatch, handle, 'status')
            response = await route.foobar_account_review_status(req)
            value = decoded(response)
            assert value['protocol'] == 'foobar_account_review_v4'
            wire = value['result']['review']
            if command is None:
                command, digest = wire['command'], wire['review_sha256']
            assert wire['command'] == command and wire['review_sha256'] == digest
            assert wire['problem_count'] == 309 and wire['problem_after'] == cursor
            assert wire['conflict_after'] == 0 and wire['conflicts'] == []
            assert 1 <= len(wire['problem_items']) <= 32
            for item in wire['problem_items']:
                assert set(item) == {'cursor', 'row', 'code', 'field',
                    'source_artist', 'source_title', 'source_album'}
                assert (item['source_artist'], item['source_title'], item['source_album']) == (
                    'Source artist', 'Source title', 'Source album')
                all_items.append((item['cursor'], item['row'], item['code'], item['field']))
            assert wire['problem_remaining'] == 309 - len(all_items)
            for private in ('/unknown-', 'bad-count', '[unsupported]', 'track_id', 'expected_state'):
                assert private not in response.body.decode()
            cursor, previous = wire['problem_next'], progress
        assert all_items == expected_diagnostics(103)
        assert personal_snapshot(db) == before and not db.personal_frames and not db.job_rows


def test_interleaved_pages_advance_only_one_axis_without_resetting_other_axis(monkeypatch):
    db = install(monkeypatch)
    payload = matched_payload(db, 40)
    with running(monkeypatch, db=db) as (db, handle, catalog):
        first = reviewed(handle, payload, library=7)
        second = reviewed(handle, payload, library=7,
            problem_after=first.result.proposed.problem_next, previous_review_sha256=review_sha(first))
        third = reviewed(handle, payload, library=7,
            conflict_after=second.result.proposed.conflict_next,
            problem_after=second.request.problem_after, previous_review_sha256=review_sha(second))
        assert second.request.conflict_after == first.request.conflict_after == 0
        assert third.request.problem_after == second.request.problem_after
        assert [item.ordinal for item in third.result.proposed.conflicts] == [
            row for row in range(17, 33) for field in ('rating', 'favorite')]
        assert identities_without_labels(second.result.proposed.problem_items) == identities_without_labels(
            third.result.proposed.problem_items)
        assert review_sha(first) == review_sha(second) == review_sha(third)
        assert first.result.command == second.result.command == third.result.command
        assert not db.personal_frames and not db.job_rows


def identities_without_labels(items):
    return [(item.cursor, item.ordinal, item.code, item.field) for item in items]


@pytest.mark.parametrize('change', ['both', 'same', 'skip', 'reset_other', 'old_protocol', 'bad_type'])
@pytest.mark.asyncio
async def test_continuation_rejects_forged_two_axis_or_malformed_wire_without_consumption(monkeypatch, change):
    from tests.py.test_foobar_account_review_routes import command_header
    db = install(monkeypatch)
    payload = matched_payload(db, 40)
    with running(monkeypatch, db=db) as (db, handle, catalog):
        first = reviewed(handle, payload, library=7)
        current = reviewed(handle, payload, library=7,
            problem_after=first.result.proposed.problem_next, previous_review_sha256=review_sha(first))
        options = dict(conflict_after=current.request.conflict_after,
            problem_after=current.result.proposed.problem_next)
        if change == 'both': options['conflict_after'] = current.result.proposed.conflict_next
        elif change == 'same': options['problem_after'] = current.request.problem_after
        elif change == 'skip': options['problem_after'] += 1
        elif change == 'reset_other':
            options.update(conflict_after=current.result.proposed.conflict_next, problem_after=0)
        elif change == 'bad_type': options['problem_after'] = True
        req, auth, reads = review_request(monkeypatch, handle, 'start', payload=payload,
            library=7, previous_review_sha256=review_sha(current), **options)
        if change == 'old_protocol': command_header(req, lambda body: body.update(version='foobar_account_review_v2'))
        before, ticket = personal_snapshot(db), handle.owner.next_ticket
        response = await route.foobar_account_review_start(req)
        assert response.status_code in (400, 409)
        assert handle.owner.last_review is current and handle.owner.next_ticket == ticket
        assert personal_snapshot(db) == before and not db.personal_frames


@pytest.mark.parametrize('change', ['payload', 'native'])
def test_actual_changed_semantics_while_paging_requires_fresh_review_and_removes_action_authority(monkeypatch, change):
    from tests.py.test_foobar_personal_action_owner import begin_action
    db = install(monkeypatch)
    payload = matched_payload(db, 40)
    with running(monkeypatch, db=db) as (db, handle, catalog):
        first = reviewed(handle, payload, library=7)
        if change == 'payload': payload = payload.replace(b'Synthetic 21', b'Changed title', 1)
        else:
            db.tastes[21]['rating'] = 3
            db.project_native(21)
        begin_review(handle, payload, library=7, problem_after=first.result.proposed.problem_next,
            previous_review_sha256=review_sha(first))
        final = settled_review(handle, first)
        assert final.phase == 'needs_review' and final.error == 'stale_import'
        assert final.result is None
        with pytest.raises(p.SourceStale):
            begin_action(handle, first)
        assert not db.personal_frames and not db.job_rows


@pytest.mark.asyncio
async def test_cancelled_problem_page_cannot_be_continued_or_used_for_manual_action(monkeypatch):
    db = install(monkeypatch)
    payload = matched_payload(db, 40)
    with running(monkeypatch, db=db) as (db, handle, catalog):
        first = reviewed(handle, payload, library=7)
        cancelled = handle.current_review_progress(context=requested_context(7),
            constraints=PolicyEvaluationConstraints(), source_ref=SOURCE, job_ref=JOB, cancel=True)
        assert cancelled.phase == 'cancelled_review' and cancelled.result is None
        with pytest.raises(p.SourceStale):
            begin_review(handle, payload, library=7, problem_after=first.result.proposed.problem_next,
                previous_review_sha256=review_sha(first))
        req, auth, reads = personal_request(monkeypatch, handle, first)
        response = await route.foobar_account_review_personal_changes(req)
        assert response.status_code == 409 and not db.personal_frames


@pytest.mark.parametrize('bad', ['cursor_order', 'cursor_row', 'after', 'next', 'count',
    'remaining', 'too_many', 'code', 'field', 'label'])
def test_public_diagnostic_projection_fails_closed_for_inconsistent_typed_report(monkeypatch, bad):
    db = install(monkeypatch)
    with running(monkeypatch, db=db) as (db, handle, catalog):
        progress = reviewed(handle, diagnostic_payload(20), library=7)
        report = progress.result.proposed
        items = list(report.problem_items)
        if bad == 'cursor_order': items[1] = replace(items[1], cursor=items[0].cursor)
        elif bad == 'cursor_row': items[0] = replace(items[0], cursor=64)
        elif bad == 'too_many': items.append(items[-1])
        elif bad == 'code': items[0] = replace(items[0], code='raw-secret')
        elif bad == 'field': items[0] = replace(items[0], field='raw-secret')
        elif bad == 'label': items[0] = replace(items[0], source_title='x' * 97)
        changes = dict(problem_items=tuple(items))
        if bad == 'after': changes['problem_after'] = 1
        elif bad == 'next': changes['problem_next'] = report.problem_next + 1
        elif bad == 'count': changes['problem_count'] = report.problem_count - 1
        elif bad == 'remaining': changes['problem_remaining'] = -1
        altered = replace(progress, result=replace(progress.result, proposed=replace(report, **changes)))
        with pytest.raises(p.SourceUnavailable):
            route._review_wire(altered)
        assert handle.owner.last_review is progress and not db.personal_frames


@pytest.mark.asyncio
@pytest.mark.parametrize('suffix,protocol', [
    ('review/start', 'foobar_account_review_v4'),
    ('review/status', 'foobar_account_review_v4'),
    ('review/cancel', 'foobar_account_review_v4'),
    ('review/personal-changes', 'foobar_account_review_v4'),
    ('job/status', 'foobar_account_job_v3'),
    ('status', 'foobar_account_import_v4')])
async def test_actual_private_perimeter_failure_emits_current_protocol_without_route_execution(monkeypatch, suffix, protocol):
    from types import SimpleNamespace
    from starlette.requests import Request
    from music_app.services import private_route_boundary as perimeter
    captured = {}
    class RegistrationOnly:
        state = SimpleNamespace()
        routes = []
        def get(self, path):
            return lambda function: function
        def middleware(self, kind):
            assert kind == 'http'
            def register(function):
                captured['middleware'] = function
                return function
            return register
    app = RegistrationOnly()
    perimeter.install_private_route_boundary(app)  # Register only; no app boot.
    async def failed_actor(request):
        raise RuntimeError('private synthetic failure must not cross boundary')
    async def never_route(request):
        pytest.fail('The route must not execute after actor failure')
    monkeypatch.setattr(perimeter, 'current_actor_from_request', failed_actor)
    path = '/integrations/foobar/account/' + suffix
    request = Request(dict(type='http', method='POST', scheme='https', path=path,
        raw_path=path.encode(), query_string=b'', headers=[],
        server=('synthetic.invalid', 443), client=('127.0.0.1', 1), app=app))
    response = await captured['middleware'](request, never_route)
    assert response.status_code == 503
    assert decoded(response) == {'protocol': protocol, 'error': 'unavailable'}
    assert b'private synthetic failure' not in response.body


@pytest.mark.asyncio
@pytest.mark.parametrize('suffix', ['start', 'status', 'cancel', 'personal-changes'])
@pytest.mark.parametrize('failure', ['revoked', 'inactive', 'csrf', 'foreign_origin', 'missing_context'])
async def test_actual_perimeter_and_route_early_errors_keep_review_v3(monkeypatch, suffix, failure):
    from music_app.services import private_route_boundary as perimeter
    from tests.py.foobar_account_route_testing import request as real_auth_request
    captured, routed = {}, []
    req, auth, reads = real_auth_request(monkeypatch, b'{}', csrf=failure != 'csrf',
        origin='https://foreign.invalid' if failure == 'foreign_origin' else 'https://synthetic.invalid')
    if failure == 'revoked': auth.revoked = True
    if failure == 'inactive': auth.active = False
    app = req.app
    app.routes = []
    app.get = lambda path: lambda function: function
    def middleware(kind):
        assert kind == 'http'
        def register(function):
            captured['middleware'] = function
            return function
        return register
    app.middleware = middleware
    perimeter.install_private_route_boundary(app)
    path = '/integrations/foobar/account/review/' + suffix
    req.scope.update(path=path, raw_path=path.encode())
    handler = {'start': route.foobar_account_review_start, 'status': route.foobar_account_review_status,
        'cancel': route.foobar_account_review_cancel,
        'personal-changes': route.foobar_account_review_personal_changes}[suffix]
    async def actual_route(request):
        routed.append(True)
        return await handler(request)
    response = await captured['middleware'](req, actual_route)
    value = decoded(response)
    assert value['protocol'] == 'foobar_account_review_v4'
    assert response.status_code in (400, 401, 403, 409)
    assert 'result' not in value and reads[0] == 0
    # Genuine auth/session/CSRF owners use the accepted synthetic database;
    # only missing context reaches the actual route, before service/body access.
    assert routed == ([True] if failure == 'missing_context' else [])
    assert app.state.foobar_account_import_service is None
    assert perimeter.private_action_for_route('POST', path) == 'account.self.foobar.write'
    assert perimeter.csrf_mode_for_route('POST', path) == 'session_header'
