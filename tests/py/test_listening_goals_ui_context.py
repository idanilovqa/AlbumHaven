"""Real session resolver, PostgreSQL Goals and optional Home continuity envelope.

Uses the existing isolated SQL fixture. Only tracked synthetic memberships and,
when absent, a synthetic bootstrap anchor/library are added. No actor success
stub, response substitution or provider network is used.
"""
from types import SimpleNamespace
from uuid import uuid4

import pytest
from starlette.requests import Request

from music_app.services.private_ui_context import private_ui_context_ref
from tests.py.test_listening_goals_postgres import db, urls
from tests.py.test_listening_goals_routes import application, headers, request, ready, add_payload


@pytest.fixture
def linked(db):
    with db.connect() as connection:
        owner = connection.execute("select account_id from app.bootstrap_owners where owner_key='local-bootstrap-owner'").fetchone()
        if owner is None:
            anchor = db.actor(connection)
            connection.execute("insert into app.bootstrap_owners(account_id,owner_key) values(%s,'local-bootstrap-owner')", (anchor.account_id,))
            anchor_id = anchor.account_id
        else:
            anchor_id = owner['account_id']
        library = connection.execute("""select id from library.libraries where owner_account_id=%s
            and library_kind='local' order by id limit 1""", (anchor_id,)).fetchone()
        if library is None:
            library = connection.execute("""insert into library.libraries(owner_account_id,name)
                values(%s,%s) returning id""", (anchor_id, 'Synthetic Goals UI ' + db.token)).fetchone()
            db.library_ids.append(library['id'])
        library_id = library['id']
        connection.execute("""insert into library.library_memberships(account_id,library_id,membership_role)
            values(%s,%s,'member')""", (db.owner.account_id, library_id))
    # Existing db.close only deletes its tracked synthetic accounts/libraries.
    # The synthetic bootstrap row cascades with its tracked synthetic anchor;
    # preexisting bootstrap/library rows are never changed or deleted.
    return SimpleNamespace(database=db, library_id=library_id)


def response(app, path='/account/goals', *, auth):
    status, body, response_headers = request(app, 'GET', path, headers=auth)
    assert status == 200 and body['status'] == 'ready'
    assert response_headers[b'cache-control'] == b'private, no-store'
    return body


def test_real_library_present_response_uses_existing_server_signer_not_client_header(linked):
    db = linked.database
    app = application(db)
    auth = headers(app, db)
    auth['x-albumhaven-context'] = '0' * 64
    body = response(app, auth=auth)
    actor = app.state.current_actor_resolver.resolve(db.session_tokens[db.owner.session_id])
    assert actor.account_id == db.owner.account_id and actor.current_library_id == linked.library_id
    incoming = Request({'type': 'http', 'app': app})
    incoming.state.current_actor = actor
    assert body['context_ref'] == private_ui_context_ref(incoming)
    assert body['context_ref'] != auth['x-albumhaven-context']
    assert body['data']['goal_ref'] is None


def test_library_context_is_optional_and_does_not_own_durable_goals(linked):
    db = linked.database
    app = application(db)
    auth = headers(app, db)
    evidence = ready(app, 'POST', '/account/goals/remote-evidence', headers=auth,
                     payload={'release_group_id': db.group()})
    command = add_payload(evidence)
    own = ready(app, 'POST', '/account/goals/add', headers=auth, payload=command)
    original = response(app, auth=auth)
    with db.connect() as connection:
        connection.execute('delete from library.library_memberships where account_id=%s and library_id=%s',
                           (db.owner.account_id, linked.library_id))
    absent = response(app, auth=auth)
    assert 'context_ref' not in absent and absent['data'] == original['data']
    assert absent['data']['goal_ref'] == own['goal_ref']
    # A stale UI cannot submit after library disappearance; headerless account API
    # remains authorized and the same-session receipt remains available.
    before = db.snapshot()
    status, body, private = request(app, 'POST', '/account/goals/add',
        headers={**auth, 'x-albumhaven-context': original['context_ref']}, payload=command)
    assert status == 409 and body['error'] == 'stale_context'
    assert private[b'cache-control'] == b'private, no-store' and db.snapshot() == before
    assert ready(app, 'POST', '/account/goals/add', headers=auth, payload=command) == own
    with db.connect() as connection:
        connection.execute("""insert into library.library_memberships(account_id,library_id,membership_role)
            values(%s,%s,'member')""", (db.owner.account_id, linked.library_id))
    restored = response(app, auth=auth)
    assert restored == original


def test_context_changes_with_actual_account_and_session_while_data_remains_account_owned(linked):
    db = linked.database
    app = application(db)
    own_auth = headers(app, db)
    first = response(app, auth=own_auth)
    renewed = db.renewed_actor()
    renewed_auth = headers(app, db, renewed)
    second = response(app, auth=renewed_auth)
    assert second['data'] == first['data'] and second['context_ref'] != first['context_ref']
    foreign = db.other_actor()
    with db.connect() as connection:
        connection.execute("""insert into library.library_memberships(account_id,library_id,membership_role)
            values(%s,%s,'member')""", (foreign.account_id, linked.library_id))
    third = response(app, auth=headers(app, db, foreign))
    assert len({first['context_ref'], second['context_ref'], third['context_ref']}) == 3
    before = db.snapshot()
    calls = list(db.provider_calls)
    status, body, _ = request(app, 'POST', '/account/goals/remote-evidence',
        headers={**renewed_auth, 'x-albumhaven-context': first['context_ref']},
        payload={'release_group_id': db.group()})
    assert status == 409 and body['error'] == 'stale_context'
    assert db.snapshot() == before and db.provider_calls == calls


@pytest.mark.parametrize('bad', ['', '0' * 64, 'x' * 63, 'x' * 65, 'a' * 64 + ',' + 'b' * 64])
def test_supplied_stale_context_rejects_reset_before_repository_and_receipt(linked, bad):
    db = linked.database
    app = application(db)
    auth = headers(app, db)
    db.add()
    current = response(app, auth=auth)
    state = current['data']
    payload = {'request_key': str(uuid4()), 'revision': state['revision'], 'period': 'week',
               'timezone_name': 'UTC', 'expected_cycle_id': state['periods']['week']['cycle']['cycle_id']}
    before = db.snapshot()
    status, body, private = request(app, 'POST', '/account/goals/reset',
        headers={**auth, 'x-albumhaven-context': bad}, payload=payload)
    assert status == 409 and body['error'] == 'stale_context'
    assert private[b'cache-control'] == b'private, no-store' and db.snapshot() == before
    reset = ready(app, 'POST', '/account/goals/reset',
        headers={**auth, 'x-albumhaven-context': current['context_ref']}, payload=payload)
    assert reset['changed'] is True


def test_no_library_api_never_requires_or_echoes_ui_context(db):
    app = application(db)
    auth = headers(app, db)
    assert 'context_ref' not in response(app, auth={**auth, 'x-albumhaven-context': 'a' * 64})
    evidence = ready(app, 'POST', '/account/goals/remote-evidence', headers=auth,
                     payload={'release_group_id': db.group()})
    receipt = ready(app, 'POST', '/account/goals/add', headers=auth, payload=add_payload(evidence))
    state = response(app, auth=auth)
    assert 'context_ref' not in state and state['data']['goal_ref'] == receipt['goal_ref']
