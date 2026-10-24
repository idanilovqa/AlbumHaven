"""AUTHORED ONLY. Actual private action route, native owner and one-worker loop."""
from dataclasses import replace
import json

import pytest

from tests.py.foobar_account_personal_testing import (
    install, seed, matched_payload, personal_snapshot, p, changes,
)
from tests.py.foobar_account_review_testing import (
    running, reviewed, review_sha, requested_context, review_request, decoded,
    sign_ui_request, route, request, SOURCE, JOB, PAYLOAD, settled_review,
)


def personal_request(monkeypatch, handle, progress, *, choices=None, mutate=None,
                     raw=None, ctx=None, **kwargs):
    body = dict(version=route.REVIEW_PROTOCOL, source_ref=SOURCE,
        job_ref=progress.request.job_ref, review_sha256=review_sha(progress),
        choices=[[1, 'rating']] if choices is None else choices)
    if mutate is not None:
        mutate(body)
    payload = json.dumps(body, separators=(',', ':')).encode() if raw is None else raw
    req, auth, reads = request(monkeypatch, payload, handle=handle, **kwargs)
    path = '/integrations/foobar/account/review/personal-changes'
    req.scope.update(path=path, raw_path=path.encode())
    sign_ui_request(req, ctx=ctx)
    return req, auth, reads


@pytest.mark.asyncio
async def test_actual_route_applies_only_explicit_current_page_fields_then_requires_new_review(monkeypatch):
    db = install(monkeypatch)
    seed(db)
    with running(monkeypatch, db=db) as (db, handle, catalog):
        progress = reviewed(handle, PAYLOAD, library=7)
        req, auth, reads = personal_request(monkeypatch, handle, progress)
        response = await route.foobar_account_review_personal_changes(req)
        value = decoded(response)
        assert response.status_code == 200 and reads[0] == 2
        assert value['protocol'] == 'foobar_account_review_v4' and value['operation'] == 'personal-changes'
        assert value['result'] == dict(phase='personal_changes_applied',
            changed_fields=[dict(row=1, field='rating', existing=2, proposed=4)], import_started=False)
        assert db.tastes[21]['rating'] == 4 and db.tastes[21]['love_tier'] == 'off'
        assert handle.owner.last_review is None and len(db.personal_frames) == 1
        assert not db.job_rows and not db.attempts and not db.receipts and not db.source_rows
        encoded = json.dumps(value)
        for secret in ('expected_state', 'fence_sha256', 'metadata', 'source_identity_sha256',
                       'observation_ref', 'association_seal', 'track_id', '/synthetic'):
            assert secret not in encoded
        req, auth, reads = personal_request(monkeypatch, handle, progress)
        response = await route.foobar_account_review_personal_changes(req)
        assert response.status_code == 409 and decoded(response)['error'] == 'stale_import'
        assert len(db.personal_frames) == 1 and not db.job_rows


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', ['csrf', 'foreign_origin', 'revoked', 'inactive',
    'missing_context', 'duplicate_context', 'old_session', 'foreign_account'])
async def test_personal_action_current_auth_and_context_are_checked_before_body_or_consumption(monkeypatch, failure):
    db = install(monkeypatch)
    seed(db)
    with running(monkeypatch, db=db) as (db, handle, catalog):
        progress = reviewed(handle, PAYLOAD, library=7)
        req, auth, reads = personal_request(monkeypatch, handle, progress,
            csrf=failure != 'csrf', origin='https://foreign.invalid' if failure == 'foreign_origin'
                else 'https://synthetic.invalid')
        if failure == 'revoked': auth.revoked = True
        elif failure == 'inactive': auth.active = False
        elif failure == 'missing_context':
            req.scope['headers'][:] = [(k, v) for k, v in req.scope['headers'] if k != b'x-albumhaven-foobar-context']
        elif failure == 'duplicate_context':
            req.scope['headers'].append((b'x-albumhaven-foobar-context', b'0' * 64))
        elif failure == 'old_session': auth.session_id = 4
        elif failure == 'foreign_account':
            ctx = requested_context(7)
            sign_ui_request(req, ctx=replace(ctx, actor=replace(ctx.actor, account_id=2, session_id=5),
                target_account_id=2))
        before, next_ticket = personal_snapshot(db), handle.owner.next_ticket
        response = await route.foobar_account_review_personal_changes(req)
        assert response.status_code in (400, 401, 403, 409)
        assert reads[0] == 0 and 'result' not in decoded(response)
        assert personal_snapshot(db) == before and handle.owner.next_ticket == next_ticket
        assert handle.owner.last_review is progress and not db.personal_frames


@pytest.mark.asyncio
@pytest.mark.parametrize('bad', ['old_protocol', 'extra', 'proposal', 'empty', 'duplicate',
    'boolean_row', 'unknown_field', 'too_many', 'missing_digest', 'not_page'])
async def test_personal_json_cannot_supply_values_targets_or_partial_valid_selections(monkeypatch, bad):
    db = install(monkeypatch)
    seed(db)
    with running(monkeypatch, db=db) as (db, handle, catalog):
        progress = reviewed(handle, PAYLOAD, library=7)
        def mutate(body):
            if bad == 'old_protocol': body['version'] = 'foobar_account_review_v1'
            elif bad == 'extra': body['track_id'] = 21
            elif bad == 'proposal': body['choices'] = [[1, 'rating', 5]]
            elif bad == 'empty': body['choices'] = []
            elif bad == 'duplicate': body['choices'] *= 2
            elif bad == 'boolean_row': body['choices'] = [[True, 'rating']]
            elif bad == 'unknown_field': body['choices'] = [[1, 'clear']]
            elif bad == 'too_many': body['choices'] = [[row, 'rating'] for row in range(1, 34)]
            elif bad == 'missing_digest': body.pop('review_sha256')
            else: body['choices'] += [[2, 'favorite']]
        req, auth, reads = personal_request(monkeypatch, handle, progress, mutate=mutate)
        before = personal_snapshot(db)
        response = await route.foobar_account_review_personal_changes(req)
        assert response.status_code == 400 and decoded(response)['error'] == 'invalid_import_request'
        assert personal_snapshot(db) == before and not db.personal_frames and not db.job_rows


@pytest.mark.asyncio
async def test_native_commit_lost_ack_is_uncertain_not_success_and_same_review_is_never_redispatched(monkeypatch):
    db = install(monkeypatch)
    seed(db)
    with running(monkeypatch, db=db) as (db, handle, catalog):
        progress = reviewed(handle, PAYLOAD, library=7)
        db.lose_ack = True
        req, auth, reads = personal_request(monkeypatch, handle, progress)
        response = await route.foobar_account_review_personal_changes(req)
        assert response.status_code == 503 and decoded(response)['error'] == 'commit_uncertain'
        assert 'result' not in decoded(response) and handle.owner.last_review is None
        assert db.tastes[21]['rating'] == 4 and len(db.personal_frames) == 1
        req, auth, reads = personal_request(monkeypatch, handle, progress)
        response = await route.foobar_account_review_personal_changes(req)
        assert response.status_code == 409 and decoded(response)['error'] == 'stale_import'
        assert len(db.personal_frames) == 1 and not db.job_rows and not db.attempts


@pytest.mark.asyncio
async def test_session_change_while_reading_action_body_cannot_consume_the_review(monkeypatch):
    db = install(monkeypatch)
    seed(db)
    with running(monkeypatch, db=db) as (db, handle, catalog):
        progress = reviewed(handle, PAYLOAD, library=7)
        req, auth, reads = personal_request(monkeypatch, handle, progress)
        receive = req._receive
        async def changed_receive():
            auth.session_id = 4
            return await receive()
        req._receive = changed_receive
        response = await route.foobar_account_review_personal_changes(req)
        assert response.status_code == 409 and decoded(response)['error'] == 'stale_import'
        assert handle.owner.last_review is progress and not db.personal_frames


@pytest.mark.asyncio
async def test_actual_next_page_route_uses_same_original_file_and_reaches_all_conflicts(monkeypatch):
    db = install(monkeypatch)
    payload = matched_payload(db, 35)
    with running(monkeypatch, db=db) as (db, handle, catalog):
        cursor, digest, previous, all_rows = 0, None, None, []
        while cursor is not None:
            req, auth, reads = review_request(monkeypatch, handle, 'start', payload=payload,
                library=7, conflict_after=cursor, previous_review_sha256=digest)
            response = await route.foobar_account_review_start(req)
            assert response.status_code == 202
            progress = settled_review(handle, previous)
            assert progress.phase == 'review_ready'
            req, auth, reads = review_request(monkeypatch, handle, 'status')
            response = await route.foobar_account_review_status(req)
            wire = decoded(response)['result']['review']
            assert wire['conflict_count'] == 70 and wire['conflict_after'] == cursor
            assert len(wire['conflicts']) <= 32
            all_rows.extend((row['row'], row['field']) for row in wire['conflicts'])
            assert wire['conflict_remaining'] == 70 - len(all_rows)
            for item in wire['conflicts']:
                assert set(item) == {'row', 'field', 'existing', 'proposed', 'consequence', 'eligible', 'reason',
                    'source_artist', 'source_title', 'source_album'}
                assert item['source_artist'] == item['source_album'] == ''
                assert item['source_title'] == 'Synthetic %d' % (20 + item['row'])
            cursor, digest, previous = wire['conflict_next'], wire['review_sha256'], progress
        assert all_rows == [(row, field) for row in range(1, 36) for field in ('rating', 'favorite')]
        assert len(set(all_rows)) == 70 and not db.personal_frames


def test_maximum_width_32_choice_wire_fits_unchanged_2048_byte_command_limit():
    value = dict(version='foobar_account_review_v4', source_ref=SOURCE, job_ref=JOB,
        review_sha256='f' * 64, choices=[[row, field] for row in range(99985, 100001)
            for field in ('rating', 'favorite')])
    body = json.dumps(value, separators=(',', ':')).encode()
    assert len(value['choices']) == 32 and route.MAX_COMMAND_BYTES == 2048
    assert len(body) <= route.MAX_COMMAND_BYTES
    exact = body + b' ' * (route.MAX_COMMAND_BYTES - len(body))
    assert route._command_json(exact, kind='personal') == value
    with pytest.raises(route._Invalid):
        route._command_json(exact + b' ', kind='personal')


def test_large_valid_combined_review_wire_fits_65536_and_ordinary_limit_remains_12288(monkeypatch):
    db = install(monkeypatch)
    payload = matched_payload(db, 32)
    with running(monkeypatch, db=db) as (db, handle, catalog):
        genuine = reviewed(handle, payload, library=7)
        report = genuine.result.proposed
        # Projection-only width case: genuine objects are widened within exact
        # public bounds, never offered as authority to an action or preflight.
        longest_code = max(p._REVIEW_PROBLEM_CODES, key=len)
        longest_field = max(p.parser.FIELD_NAMES, key=len)
        conflicts = tuple(replace(item, ordinal=99985 + index // 2, cursor=2 * (99985 + index // 2) + index % 2,
            eligible=False, ineligible_reason='provenance_requires_review',
            source_artist='\u00e9' * 24, source_title='\u00e9' * 48, source_album='\u00e9' * 24)
            for index, item in enumerate(report.conflicts))
        diagnostics = tuple(p.FoobarDiagnosticProblem((99969 + index // 2) * 32 + index % 2,
            99969 + index // 2, 'unsupported_history_field' if index % 2 == 0 else longest_code,
            longest_field if index % 2 == 0 else None, "\u00e9" * 24, "\u00e9" * 48, "\u00e9" * 24)
            for index in range(32))
        report = replace(report, total_rows=100000, checked_rows=100000, start_offset=0,
            planned_batches=1000, proposed_counts=(0, 100000, 0, 0, 0, 0, 16),
            review_counts=(100000, 0, 99984, 99984, 16, 0),
            review_problems=tuple((1 + index // 2, 'unsupported_history_field' if index % 2 == 0 else longest_code,
                longest_field if index % 2 == 0 else None) for index in range(32)),
            review_truncated=True, conflicts=conflicts, conflict_count=32,
            conflict_after=0, conflict_next=None, conflict_remaining=0,
            problem_items=diagnostics, problem_count=200000, problem_after=3198977,
            problem_next=3199489, problem_remaining=32)
        command = replace(genuine.result.command, total_rows=100000,
            original_matching_library_id=9223372036854775807, original_generation=2147483647)
        progress = replace(genuine, request=replace(genuine.request, conflict_after=0,
            problem_after=3198977), result=replace(genuine.result, command=command, proposed=report))
        value = dict(protocol=route.REVIEW_PROTOCOL, operation='status', result=route._review_wire(progress))
        response = route._ui_response(value, 'f' * 64)
        assert route.MAX_RESPONSE_BYTES == 12288 and route.MAX_REVIEW_RESPONSE_BYTES == 65536
        assert len(response.body) == 51821
        assert 32768 < len(response.body) <= 65536
        assert len(decoded(response)['result']['review']['conflicts']) == 32
        # Verify the immutable output bound itself, not a raised test capacity.
        overhead = len(json.dumps({'x': ''}, separators=(',', ':')).encode())
        assert len(route._response({'x': 'x' * (12288 - overhead)}).body) == 12288
        with pytest.raises(p.SourceUnavailable):
            route._response({'x': 'x' * (12289 - overhead)})
        assert len(route._response({'x': 'x' * (65536 - overhead)},
            maximum=route.MAX_REVIEW_RESPONSE_BYTES).body) == 65536
        with pytest.raises(p.SourceUnavailable):
            route._response({'x': 'x' * (65537 - overhead)}, maximum=route.MAX_REVIEW_RESPONSE_BYTES)
        ordinary = dict(protocol=route.JOB_PROTOCOL, operation='status', padding='x' * 12288)
        with pytest.raises(p.SourceUnavailable):
            route._ui_response(ordinary, 'f' * 64)


@pytest.mark.asyncio
async def test_genuine_source_identity_labels_are_literal_bounded_and_not_private_paths(monkeypatch):
    db = install(monkeypatch)
    seed(db)
    db.files[21] = '/private-only-path-not-a-song.flac'
    title = '<img src=x onerror=alert(1)>'
    artist, album = 'Source artist', 'Source album'
    payload = ('path\tartist\ttitle\talbum\trating\tfavorite\n'
        + db.files[21] + '\t' + artist + '\t' + title + '\t' + album + '\t4\t1\n').encode()
    with running(monkeypatch, db=db) as (db, handle, catalog):
        progress = reviewed(handle, payload, library=7)
        req, auth, reads = review_request(monkeypatch, handle, 'status')
        response = await route.foobar_account_review_status(req)
        wire = decoded(response)['result']['review']
        assert response.status_code == 200 and len(wire['conflicts']) == 2
        assert [(item['source_artist'], item['source_title'], item['source_album'])
            for item in wire['conflicts']] == [(artist, title, album)] * 2
        assert b'/private-only-path-not-a-song.flac' not in response.body
        assert b'expected_state' not in response.body and b'fence_sha256' not in response.body
        # HTML remains inert source text at this boundary. Browser rendering
        # must separately use textContent; this is not browser/XSS execution.
        assert wire['conflicts'][0]['source_title'] == title
        assert not db.personal_frames and not db.job_rows


@pytest.mark.parametrize('maximum', [48, 96])
@pytest.mark.parametrize('value', ['x' * 97, '\u00e9' * 49, '\x00', '\x1f', '\x7f',
    '\u0085', '\u202e', '\u2066', '\u2028', '\u2029', '\ud800', False, None])
def test_label_public_projection_rejects_oversized_or_hostile_control_values(maximum, value):
    with pytest.raises(p.SourceUnavailable):
        route._source_label_wire(value, maximum)
