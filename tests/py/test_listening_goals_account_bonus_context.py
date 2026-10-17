"""Account continuity on the actual durable bonus-settings GET/save routes."""
from datetime import timedelta

import pytest

from tests.py.test_listening_goal_bonus_settings import payload
from tests.py.test_listening_goal_bonus_settings_postgres import bonus_db, db, urls, rows
from tests.py.test_listening_goals_routes import application, headers, request
from tests.py.test_listening_goals_account_context import (
    HEADER, account_headers, account_ready, assert_stale, request_extra_headers,
)


PATH = '/account/goals/bonus-settings'


def test_account_marker_round_trips_bonus_settings_and_actual_same_session_receipt(bonus_db):
    db = bonus_db
    app = application(db)
    auth = account_headers(app, db)
    initial = account_ready(app, 'GET', PATH, auth=auth)
    assert initial['settings_revision'] == '1' and initial['enabled'] is False
    assert rows(db) == []
    before = account_ready(app, 'GET', '/account/goals', auth=auth)
    command = payload(enabled=True)
    receipt = account_ready(app, 'POST', PATH, auth=auth, payload=command)
    assert receipt['changed'] is True and receipt['settings']['settings_revision'] == '2'
    assert account_ready(app, 'POST', PATH, auth=auth, payload=command) == receipt
    assert account_ready(app, 'GET', PATH, auth=auth) == receipt['settings']
    operation = account_ready(app, 'GET', '/account/goals/operations/' + command['request_key'], auth=auth)
    assert operation == {'status': 'committed', 'receipt': receipt}
    assert account_ready(app, 'GET', '/account/goals', auth=auth) == before
    assert len(rows(db)) == 1 and db.provider_calls == []


@pytest.mark.parametrize('method', ['GET', 'POST'])
@pytest.mark.parametrize('failure', ['empty', 'forged', 'duplicate', 'home', 'session', 'account'])
def test_bonus_marker_failures_precede_real_repository_access(bonus_db, method, failure):
    db = bonus_db
    app = application(db)
    auth = account_headers(app, db)
    extra = []
    if failure == 'empty':
        auth[HEADER] = ''
    elif failure == 'forged':
        auth[HEADER] = '0' * 64
    elif failure == 'duplicate':
        extra = [(HEADER.encode(), auth[HEADER].encode())]
    elif failure == 'home':
        extra = [(b'x-albumhaven-context', auth[HEADER].encode())]
    else:
        actor = db.renewed_actor() if failure == 'session' else db.other_actor()
        auth = {**headers(app, db, actor), HEADER: auth[HEADER]}
    observed = []
    app.state.listening_goals_service = db.service_for(before=lambda sql, params: observed.append(sql))
    before, saved = db.snapshot(), rows(db)
    result = request_extra_headers(app, method, PATH, headers=auth, extra=extra,
        payload=payload(enabled=True) if method == 'POST' else None)
    assert_stale(result)
    assert observed == [] and rows(db) == saved and db.snapshot() == before
    assert db.provider_calls == []


@pytest.mark.parametrize('method', ['GET', 'POST'])
def test_headerless_bonus_api_remains_account_authorized_and_without_account_scope(bonus_db, method):
    db = bonus_db
    app = application(db)
    status, body, private = request(app, method, PATH, headers=headers(app, db),
        payload=payload(enabled=True) if method == 'POST' else None)
    assert status == 200 and body['status'] == 'ready'
    assert 'context_scope' not in body and 'context_ref' not in body
    assert private[b'cache-control'] == b'private, no-store'


@pytest.mark.parametrize('failure', ['csrf', 'origin', 'revoked'])
def test_correct_bonus_marker_cannot_replace_csrf_origin_or_live_session(bonus_db, failure):
    db = bonus_db
    app = application(db)
    auth = account_headers(app, db)
    if failure == 'csrf':
        auth.pop('x-album-haven-csrf')
    elif failure == 'origin':
        auth['origin'] = 'https://other.example.test'
    else:
        with db.connect() as connection:
            connection.execute('update app.account_sessions set revoked_at=%s where id=%s',
                (db.now, db.owner.session_id))
    before = db.snapshot()
    status, body, private = request(app, 'POST', PATH, headers=auth, payload=payload(enabled=True))
    assert status == (401 if failure == 'revoked' else 403)
    assert private[b'cache-control'] == b'private, no-store'
    assert 'context_ref' not in body and 'context_scope' not in body
    assert rows(db) == [] and db.snapshot() == before


@pytest.mark.parametrize('method', ['GET', 'POST'])
def test_bonus_final_live_session_check_still_discards_or_rolls_back_matching_marker(bonus_db, method):
    db = bonus_db
    app = application(db)
    auth = account_headers(app, db)
    checks, settings_writes = [], []
    def after(sql, params):
        if sql.startswith('insert into app.listening_goal_bonus_settings'):
            settings_writes.append(True)
        if 'from app.account_sessions' in sql and 'for update' in sql:
            checks.append(True)
            if len(checks) == 2:
                db.now += timedelta(days=2)
    app.state.listening_goals_service = db.service_for(after=after)
    before = db.snapshot()
    status, body, private = request(app, method, PATH, headers=auth,
        payload=payload(enabled=True) if method == 'POST' else None)
    assert status == 403 and body == {'ok': False, 'error': 'forbidden'}
    assert private[b'cache-control'] == b'private, no-store'
    assert len(checks) == 2 and settings_writes == ([True] if method == 'POST' else [])
    assert rows(db) == [] and db.snapshot() == before
