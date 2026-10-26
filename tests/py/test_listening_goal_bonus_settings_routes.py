"""Real private middleware/session/CSRF and preferences repository routes."""
from uuid import uuid4
import pytest
from tests.py.test_listening_goal_bonus_settings import payload
from tests.py.test_listening_goal_bonus_settings_postgres import bonus_db, db, urls
from tests.py.test_listening_goals_routes import application, headers, request, ready

PATH = '/account/goals/bonus-settings'


def test_http_preferences_round_trip_receipt_and_unchanged_goals(bonus_db):
    db = bonus_db
    app = application(db)
    auth = headers(app, db)
    before = ready(app, 'GET', '/account/goals', headers=auth)
    initial = ready(app, 'GET', PATH, headers=auth)
    assert initial['source_mode'] == 'all_active' and initial['enabled'] is False
    command = payload(enabled=True)
    receipt = ready(app, 'POST', PATH, headers=auth, payload=command)
    assert receipt['settings']['settings_revision'] == '2'
    assert ready(app, 'POST', PATH, headers=auth, payload=command) == receipt
    assert ready(app, 'GET', PATH, headers=auth) == receipt['settings']
    assert ready(app, 'GET', '/account/goals', headers=auth) == before
    assert db.provider_calls == []


@pytest.mark.parametrize('failure', ['anonymous', 'csrf', 'origin', 'context'])
def test_private_fences_and_no_store_prevent_settings_write(bonus_db, failure):
    db = bonus_db
    app = application(db)
    auth = headers(app, db)
    if failure == 'anonymous':
        auth = {}
    elif failure == 'csrf':
        auth.pop('x-album-haven-csrf')
    elif failure == 'origin':
        auth['origin'] = 'https://other.example.test'
    else:
        auth['x-albumhaven-context'] = '0'*64
    before = db.snapshot()
    status, body, response_headers = request(app, 'POST', PATH, headers=auth, payload=payload(enabled=True))
    assert status == (401 if failure == 'anonymous' else 409 if failure == 'context' else 403)
    assert response_headers[b'cache-control'] == b'private, no-store'
    assert db.snapshot() == before and db.service.read_bonus_settings(db.context())['settings_revision'] == '1'


@pytest.mark.parametrize('field,value', [('account_id', 123), ('library_id', 123),
    pytest.param('catalog_ref', str(uuid4()), id='catalog-ref'), ('preferred_top_weight', 20), ('enabled', 1)])
def test_settings_route_rejects_authority_fields_and_invalid_types(bonus_db, field, value):
    db = bonus_db
    app = application(db)
    status, body, response_headers = request(app, 'POST', PATH, headers=headers(app, db),
                                            payload=payload(**{field: value}))
    assert status == 400 and body == {'ok': False, 'error': 'invalid_command'}
    assert response_headers[b'cache-control'] == b'private, no-store'


@pytest.mark.parametrize('query', ['?account_id=1', '?source_mode=selected&source_mode=all_active'])
def test_settings_read_rejects_unknown_and_duplicate_query_parameters(bonus_db, query):
    db = bonus_db
    app = application(db)
    status, body, response_headers = request(app, 'GET', PATH+query, headers=headers(app, db))
    assert status == 400 and body == {'ok': False, 'error': 'invalid_query'}
    assert response_headers[b'cache-control'] == b'private, no-store'
