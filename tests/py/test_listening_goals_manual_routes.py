"""New mutation routes through real session/CSRF/SQL owners, without a library."""
from uuid import uuid4

import pytest

from tests.py.test_listening_goals_postgres import db, urls
from tests.py.test_listening_goals_routes import application, headers, request, ready


def payload(state, album, action, **changes):
    value = {'request_key':str(uuid4()), 'revision':state['revision'], 'period':'week',
             'expected_cycle_id':state['periods']['week']['cycle']['cycle_id'], 'catalog_ref':album}
    if action == 'completion':
        value['completed'] = True
    return {**value, **changes}


def test_no_library_http_complete_clear_remove_and_receipt_round_trip(db):
    app = application(db)
    auth = headers(app, db)
    added, _ = db.add()
    album = added['catalog_ref']
    state = ready(app, 'GET', '/account/goals', headers=auth)
    mark = payload(state, album, 'completion')
    completed = ready(app, 'POST', '/account/goals/completion', headers=auth, payload=mark)
    assert completed['changed'] and completed['catalog_ref'] == album
    state = ready(app, 'GET', '/account/goals', headers=auth)
    assert all(value['completed'] == 1 for value in state['periods'].values())
    assert ready(app, 'POST', '/account/goals/completion', headers=auth, payload=mark) == completed
    clear = payload(state, album, 'completion', completed=False)
    assert ready(app, 'POST', '/account/goals/completion', headers=auth, payload=clear)['changed']
    state = ready(app, 'GET', '/account/goals', headers=auth)
    assert state['periods']['week']['completed'] == 0 and state['periods']['year']['completed'] == 1
    remove = payload(state, album, 'remove')
    receipt = ready(app, 'POST', '/account/goals/remove', headers=auth, payload=remove)
    state = ready(app, 'GET', '/account/goals', headers=auth)
    assert state['periods']['week']['album_refs'] == []
    assert state['periods']['year']['album_refs'] == [album]
    assert ready(app, 'GET', '/account/goals/operations/'+remove['request_key'], headers=auth) == {
        'status':'committed','receipt':receipt}
    assert app.state.current_actor_resolver.resolve(db.session_tokens[db.owner.session_id]).current_library_id is None


@pytest.mark.parametrize('action', ['completion','remove'])
@pytest.mark.parametrize('failure', ['anonymous','csrf','origin','revoked','stale_context'])
def test_mutations_require_actual_session_csrf_and_optional_home_continuity(db, action, failure):
    app = application(db)
    auth = headers(app, db)
    added, _ = db.add()
    state = ready(app, 'GET', '/account/goals', headers=auth)
    value = payload(state, added['catalog_ref'], action)
    if failure == 'anonymous':
        auth = {}
    elif failure == 'csrf':
        auth.pop('x-album-haven-csrf')
    elif failure == 'origin':
        auth['origin'] = 'https://other.example.test'
    elif failure == 'revoked':
        with db.connect() as connection:
            connection.execute('update app.account_sessions set revoked_at=%s where id=%s',
                               (db.now,db.owner.session_id))
    else:
        auth['x-albumhaven-context'] = '0'*64
    before = db.snapshot()
    status, body, private = request(app,'POST','/account/goals/'+action,headers=auth,payload=value)
    assert status == (401 if failure in {'anonymous','revoked'} else 409 if failure == 'stale_context' else 403)
    assert private[b'cache-control'] == b'private, no-store'
    assert db.snapshot() == before


@pytest.mark.parametrize('action', ['completion','remove'])
@pytest.mark.parametrize('extra', [{'viewer_ref':'foreign'}, {'account_id':999}, {'library_id':999},
                                  {'occurred_at':'2026-01-01T00:00:00+00:00'}])
def test_http_cannot_choose_completion_viewer_owner_or_time(db, action, extra):
    app = application(db)
    auth = headers(app, db)
    added, _ = db.add()
    state = ready(app,'GET','/account/goals',headers=auth)
    before = db.snapshot()
    status,body,private = request(app,'POST','/account/goals/'+action,headers=auth,
        payload=payload(state,added['catalog_ref'],action,**extra))
    assert status == 400 and body == {'ok':False,'error':'invalid_command'}
    assert private[b'cache-control'] == b'private, no-store' and db.snapshot() == before
