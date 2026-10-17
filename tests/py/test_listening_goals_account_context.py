"""Account entry continuity through real sessions, policy, CSRF and PostgreSQL.

Uses existing isolated SQL/provider fixtures. No source-module mock, successful
actor substitute, repository response replacement or alternate import harness.
Only provider facts, elapsed time and real-SQL observation/fault seams vary.
"""
from datetime import timedelta
from uuid import uuid4

import pytest
from starlette.requests import Request

from music_app.services.account_goals_context import account_goals_context_ref
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_ui_context import private_ui_context_ref
from tests.py.test_listening_goals_postgres import db, urls
from tests.py.test_listening_goals_routes import application, headers, request, ready, add_payload
from tests.py.test_listening_goals_ui_context import linked
from tests.py.test_listening_goals_remote_search_postgres import search_service


HEADER = 'x-albumhaven-account-context'
SCOPE = 'account-goals-v1'


def server_marker(app, database, actor=None):
    # Same authenticated-actor signer the dedicated page must use. Resolve the
    # actual persisted browser session, not the fixture's cached actor object.
    actor = actor or database.owner
    resolved = app.state.current_actor_resolver.resolve(database.session_tokens[actor.session_id])
    incoming = Request({'type': 'http', 'app': app})
    incoming.state.current_actor = resolved
    return account_goals_context_ref(incoming)


def account_headers(app, database, actor=None):
    return {**headers(app, database, actor), HEADER: server_marker(app, database, actor)}


def account_ready(app, method, path, *, auth, payload=None):
    status, body, private = request(app, method, path, headers=auth, payload=payload)
    assert status == 200, body
    assert private[b'cache-control'] == b'private, no-store'
    assert body['status'] == 'ready'
    assert body['context_ref'] == auth[HEADER]
    assert body['context_scope'] == SCOPE
    return body['data']


def assert_stale(result):
    status, body, private = result
    assert status == 409 and body == {'ok': False, 'error': 'stale_context'}
    assert private[b'cache-control'] == b'private, no-store'


def request_extra_headers(app, method, target, *, extra, **kwargs):
    # Preserve the existing actual ASGI driver, adding raw duplicate headers at
    # the HTTP-input boundary because its convenient mapping cannot encode them.
    async def with_extra(scope, receive, send):
        await app({**scope, 'headers': [*scope['headers'], *extra]}, receive, send)
    return request(with_extra, method, target, **kwargs)


def target(database, operation):
    if operation == 'read':
        return 'GET', '/account/goals', None
    if operation == 'history':
        return 'GET', '/account/goals/history?period=week', None
    if operation == 'operation':
        return 'GET', '/account/goals/operations/' + str(uuid4()), None
    if operation == 'search':
        return 'POST', '/account/goals/remote-search', {'title': 'Synthetic', 'artist': 'Artist'}
    if operation == 'evidence':
        return 'POST', '/account/goals/remote-evidence', {'release_group_id': database.group()}
    if operation == 'add':
        return 'POST', '/account/goals/add', add_payload(database.acquire())
    receipt, _ = database.add()
    state = database.service.read(database.context())
    payload = {'request_key': str(uuid4()), 'revision': state['revision'], 'period': 'week',
               'expected_cycle_id': state['periods']['week']['cycle']['cycle_id']}
    if operation == 'reset':
        payload['timezone_name'] = 'UTC'
    else:
        payload['catalog_ref'] = receipt['catalog_ref']
        if operation == 'completion':
            payload['completed'] = True
    return 'POST', '/account/goals/' + operation, payload


def test_no_library_search_evidence_add_read_history_and_receipt_use_same_account_marker(db):
    ref = db.group()
    service, calls = search_service(db, ref)
    app = application(db)
    app.state.listening_goals_service = service
    auth = account_headers(app, db)
    resolved = app.state.current_actor_resolver.resolve(db.session_tokens[db.owner.session_id])
    assert resolved.current_library_id is None and resolved.library_relationships == ()
    assert resolved.capability_grants == ()
    empty = account_ready(app, 'GET', '/account/goals', auth=auth)
    assert empty['goal_ref'] is None and empty['allowed_actions']['can_add'] is True
    found = account_ready(app, 'POST', '/account/goals/remote-search', auth=auth,
        payload={'title': 'Synthetic', 'artist': 'Artist'})
    assert len(calls) == 1 and found['candidates'][0]['release_group_id'] == ref
    db.payloads[ref]['title'] = 'Verified after explicit selection'
    evidence = account_ready(app, 'POST', '/account/goals/remote-evidence', auth=auth,
        payload={'release_group_id': ref})
    assert evidence['album']['title'] == 'Verified after explicit selection'
    command = add_payload(evidence)
    added = account_ready(app, 'POST', '/account/goals/add', auth=auth, payload=command)
    assert added['changed'] is True
    state = account_ready(app, 'GET', '/account/goals', auth=auth)
    assert state['goal_ref'] == added['goal_ref']
    reset = {'request_key': str(uuid4()), 'revision': state['revision'], 'period': 'week',
        'timezone_name': 'UTC', 'expected_cycle_id': state['periods']['week']['cycle']['cycle_id']}
    account_ready(app, 'POST', '/account/goals/reset', auth=auth, payload=reset)
    history = account_ready(app, 'GET', '/account/goals/history?period=week', auth=auth)
    assert history['cycles'][0]['cycle_id'] == reset['expected_cycle_id']
    operation = account_ready(app, 'GET', '/account/goals/operations/' + command['request_key'], auth=auth)
    assert operation == {'status': 'committed', 'receipt': added}
    with db.connect() as connection:
        assert connection.execute('select count(*) as n from library.library_memberships where account_id=%s',
            (db.owner.account_id,)).fetchone()['n'] == 0
        assert connection.execute('select count(*) as n from library.catalog_album_links where catalog_ref=%s',
            (added['catalog_ref'],)).fetchone()['n'] == 0


@pytest.mark.parametrize('operation', ['read', 'history', 'operation', 'search', 'evidence',
    'add', 'reset', 'completion', 'remove'])
def test_every_account_entry_endpoint_checks_continuity_before_goals_sql_or_provider(db, operation):
    app = application(db)
    auth = account_headers(app, db)
    method, path, payload = target(db, operation)
    observed = []
    service, search_calls = search_service(db, db.group(), before=lambda sql, params: observed.append(sql))
    app.state.listening_goals_service = service
    before, provider_calls = db.snapshot(), list(db.provider_calls)
    assert_stale(request(app, method, path, headers={**auth, HEADER: '0' * 64}, payload=payload))
    assert observed == [] and search_calls == [] and db.provider_calls == provider_calls
    assert db.snapshot() == before


@pytest.mark.parametrize('method,path,payload', [
    ('GET', '/account/goals', None),
    ('POST', '/account/goals/remote-search', {'title': 'Album', 'artist': ''}),
])
@pytest.mark.parametrize('bad', ['', '0' * 64, 'a' * 63, 'a' * 65, 'é' * 64, 'a' * 64 + ',' + 'b' * 64])
def test_present_empty_malformed_or_forged_account_marker_never_falls_back(db, method, path, payload, bad):
    app = application(db)
    service, calls = search_service(db, db.group())
    app.state.listening_goals_service = service
    before = db.snapshot()
    assert_stale(request(app, method, path, headers={**headers(app, db), HEADER: bad}, payload=payload))
    assert calls == [] and db.provider_calls == [] and db.snapshot() == before


@pytest.mark.parametrize('method,path,payload', [
    ('GET', '/account/goals', None),
    ('POST', '/account/goals/remote-search', {'title': 'Album', 'artist': ''}),
])
@pytest.mark.parametrize('extra_header', ['same_account', 'empty_account', 'home', 'empty_home'])
def test_duplicate_or_simultaneous_modes_fail_closed_at_real_http_boundary(db, method, path, payload, extra_header):
    app = application(db)
    auth = account_headers(app, db)
    if extra_header == 'same_account':
        extra = [(HEADER.encode(), auth[HEADER].encode())]
    elif extra_header == 'empty_account':
        extra = [(HEADER.encode(), b'')]
    else:
        extra = [(b'x-albumhaven-context', b'' if extra_header == 'empty_home' else auth[HEADER].encode())]
    before = db.snapshot()
    assert_stale(request_extra_headers(app, method, path, headers=auth, payload=payload, extra=extra))
    assert db.provider_calls == [] and db.snapshot() == before


@pytest.mark.parametrize('replacement', ['session', 'account'])
@pytest.mark.parametrize('operation', ['read', 'search', 'evidence', 'add'])
def test_cross_tab_cookie_replacement_cannot_reuse_or_adopt_old_marker(db, replacement, operation):
    app = application(db)
    old = account_headers(app, db)
    method, path, payload = target(db, operation)
    actor = db.renewed_actor() if replacement == 'session' else db.other_actor()
    fresh = account_headers(app, db, actor)
    assert fresh[HEADER] != old[HEADER]
    observed = []
    service, calls = search_service(db, db.group(), before=lambda sql, params: observed.append(sql))
    app.state.listening_goals_service = service
    before, provider_calls = db.snapshot(), list(db.provider_calls)
    # Fresh cookie and fresh CSRF prove that the old page marker, not CSRF, is
    # the rejecting fence. The error never returns a replacement marker/data.
    assert_stale(request(app, method, path, headers={**fresh, HEADER: old[HEADER]}, payload=payload))
    assert observed == [] and calls == [] and db.provider_calls == provider_calls
    assert db.snapshot() == before


def test_library_viewer_can_manage_only_own_goals_without_new_capabilities(linked):
    db = linked.database
    with db.connect() as connection:
        connection.execute("update library.library_memberships set membership_role='viewer' where account_id=%s and library_id=%s",
            (db.owner.account_id, linked.library_id))
    app = application(db)
    auth = account_headers(app, db)
    resolved = app.state.current_actor_resolver.resolve(db.session_tokens[db.owner.session_id])
    assert resolved.current_library_id == linked.library_id
    assert resolved.capability_grants == ()
    assert resolved.library_relationships[0].membership_role == 'viewer'
    state = account_ready(app, 'GET', '/account/goals', auth=auth)
    assert state['allowed_actions']['can_add'] is True
    evidence = account_ready(app, 'POST', '/account/goals/remote-evidence', auth=auth,
        payload={'release_group_id': db.group()})
    added = account_ready(app, 'POST', '/account/goals/add', auth=auth, payload=add_payload(evidence))
    foreign = db.other_actor()
    other_auth = account_headers(app, db, foreign)
    assert account_ready(app, 'GET', '/account/goals', auth=other_auth)['goal_ref'] is None
    assert account_ready(app, 'GET', '/account/goals', auth=auth)['goal_ref'] == added['goal_ref']


def test_account_marker_survives_current_library_loss_while_home_fence_remains_unchanged(linked):
    db = linked.database
    app = application(db)
    auth = account_headers(app, db)
    plain = headers(app, db)
    status, home, _ = request(app, 'GET', '/account/goals', headers=plain)
    assert status == 200 and 'context_scope' not in home
    incoming = Request({'type': 'http', 'app': app})
    incoming.state.current_actor = app.state.current_actor_resolver.resolve(db.session_tokens[db.owner.session_id])
    assert home['context_ref'] == private_ui_context_ref(incoming)
    assert home['context_ref'] != auth[HEADER]
    evidence = ready(app, 'POST', '/account/goals/remote-evidence',
        headers={**plain, 'x-albumhaven-context': home['context_ref']}, payload={'release_group_id': db.group()})
    added = account_ready(app, 'POST', '/account/goals/add', auth=auth, payload=add_payload(evidence))
    current = account_ready(app, 'GET', '/account/goals', auth=auth)
    with db.connect() as connection:
        connection.execute('delete from library.library_memberships where account_id=%s and library_id=%s',
            (db.owner.account_id, linked.library_id))
    assert server_marker(app, db) == auth[HEADER]
    assert account_ready(app, 'GET', '/account/goals', auth=auth) == current
    assert current['goal_ref'] == added['goal_ref']
    assert_stale(request(app, 'POST', '/account/goals/remote-evidence',
        headers={**plain, 'x-albumhaven-context': home['context_ref']}, payload={'release_group_id': db.group()}))
    status, legacy, _ = request(app, 'GET', '/account/goals', headers=plain)
    assert status == 200 and 'context_ref' not in legacy and 'context_scope' not in legacy
    assert legacy['data'] == current


def test_removed_empty_synthetic_library_leaves_account_marker_and_goals_intact(db):
    app = application(db)
    auth = account_headers(app, db)
    db.add()
    before = account_ready(app, 'GET', '/account/goals', auth=auth)
    with db.connect() as connection:
        library_id = connection.execute('insert into library.libraries(owner_account_id,name) values(%s,%s) returning id',
            (db.owner.account_id, 'Synthetic removable Goals library ' + db.token)).fetchone()['id']
        db.library_ids.append(library_id)
        connection.execute("insert into library.library_memberships(account_id,library_id,membership_role) values(%s,%s,'viewer')",
            (db.owner.account_id, library_id))
        assert connection.execute('select count(*) as n from library.local_albums where library_id=%s',
            (library_id,)).fetchone()['n'] == 0
    assert server_marker(app, db) == auth[HEADER]
    assert account_ready(app, 'GET', '/account/goals', auth=auth) == before
    with db.connect() as connection:
        connection.execute('delete from library.library_memberships where account_id=%s and library_id=%s',
            (db.owner.account_id, library_id))
        connection.execute('delete from library.libraries where id=%s', (library_id,))
    assert server_marker(app, db) == auth[HEADER]
    assert account_ready(app, 'GET', '/account/goals', auth=auth) == before


def test_account_marker_does_not_grant_library_shell_bootstrap_or_media(db):
    app = application(db)
    reached = []
    # Sentinel handlers only prove the actual private middleware denies entry;
    # no legacy shell, bootstrap or media implementation needs to be started.
    async def forbidden_handler():
        reached.append(True)
        pytest.fail('No-library account marker must never enter a library route')
    for path in ('/', '/bootstrap-data', '/track'):
        app.add_api_route(path, forbidden_handler, methods=['GET'])
    auth = account_headers(app, db)
    assert account_ready(app, 'GET', '/account/goals', auth=auth)['goal_ref'] is None
    for path in ('/', '/bootstrap-data', '/track'):
        status, body, _ = request(app, 'GET', path, headers=auth)
        assert status == 403 and body == {'detail': 'Action not permitted.'}
    assert reached == []


@pytest.mark.parametrize('failure', ['missing_csrf', 'cross_origin', 'anonymous', 'revoked', 'expired', 'disabled'])
def test_marker_never_bypasses_real_session_csrf_origin_or_account_state(db, failure):
    app = application(db)
    auth = account_headers(app, db)
    service, calls = search_service(db, db.group())
    app.state.listening_goals_service = service
    expected = 403
    if failure == 'missing_csrf':
        auth.pop('x-album-haven-csrf')
    elif failure == 'cross_origin':
        auth['origin'] = 'https://other.example.test'
    elif failure == 'anonymous':
        auth.pop('cookie')
        expected = 401
    else:
        expected = 401
        with db.connect() as connection:
            if failure == 'revoked':
                connection.execute('update app.account_sessions set revoked_at=%s where id=%s', (db.now, db.owner.session_id))
            elif failure == 'expired':
                connection.execute('update app.account_sessions set idle_expires_at=%s where id=%s', (db.now, db.owner.session_id))
            else:
                connection.execute('update app.accounts set is_active=false,disabled_at=%s where id=%s', (db.now, db.owner.account_id))
    before = db.snapshot()
    status, body, private = request(app, 'POST', '/account/goals/remote-search', headers=auth,
        payload={'title': 'Album', 'artist': ''})
    assert status == expected and 'context_ref' not in body and 'context_scope' not in body
    assert private[b'cache-control'] == b'private, no-store'
    assert calls == [] and db.provider_calls == [] and db.snapshot() == before
    if failure in {'anonymous', 'revoked', 'expired', 'disabled'}:
        status, body, private = request(app, 'GET', '/account/goals', headers=auth)
        assert status == 401 and body == {'detail': 'Authentication required.'}
        assert private[b'cache-control'] == b'private, no-store'


@pytest.mark.parametrize('operation', ['search', 'evidence'])
def test_session_revocation_during_provider_io_discards_account_response(db, operation):
    app = application(db)
    auth = account_headers(app, db)
    group = db.group()
    revoked = []
    def revoke():
        with db.connect() as connection:
            connection.execute("set local lock_timeout='5s'")
            connection.execute('update app.account_sessions set revoked_at=%s where id=%s', (db.now, db.owner.session_id))
        revoked.append(True)
    if operation == 'search':
        service, calls = search_service(db, group, after_lookup=revoke)
        path, payload = '/account/goals/remote-search', {'title': 'Album', 'artist': ''}
    else:
        def provider(ref, **options):
            revoke()
            return db.provider(ref, **options)
        service = db.service_for(provider=provider)
        path, payload = '/account/goals/remote-evidence', {'release_group_id': group}
    app.state.listening_goals_service = service
    before = db.snapshot()
    status, body, private = request(app, 'POST', path, headers=auth, payload=payload)
    assert status == 403 and body == {'ok': False, 'error': 'forbidden'}
    assert private[b'cache-control'] == b'private, no-store'
    assert revoked == [True] and db.snapshot() == before
    if operation == 'search':
        assert len(calls) == 1
    else:
        assert len(db.provider_calls) == 1


@pytest.mark.parametrize('operation', ['read', 'add'])
def test_final_session_expiry_discards_read_or_rolls_back_add_even_with_matching_marker(db, operation):
    app = application(db)
    auth = account_headers(app, db)
    method, path, payload = target(db, operation)
    checks, writes = [], []
    def after(sql, params):
        if sql.startswith('insert into app.listening_goal_operations'):
            writes.append(True)
        if 'from app.account_sessions' in sql and 'for update' in sql:
            checks.append(True)
            if len(checks) == 2:
                db.now += timedelta(days=2)
    app.state.listening_goals_service = db.service_for(after=after)
    before = db.snapshot()
    status, body, private = request(app, method, path, headers=auth, payload=payload)
    assert status == 403 and body == {'ok': False, 'error': 'forbidden'}
    assert private[b'cache-control'] == b'private, no-store'
    assert len(checks) == 2 and writes == ([True] if operation == 'add' else [])
    assert db.snapshot() == before


@pytest.mark.parametrize('failure', ['signing', 'repository', 'constraints'])
def test_account_mode_errors_remain_generic_private_and_never_offer_replacement_marker(db, failure):
    app = application(db)
    auth = account_headers(app, db)
    private_detail = 'synthetic-private-location-that-must-not-escape'
    if failure == 'signing':
        # The private policy also uses the signing key. Preserve its valid
        # configuration and corrupt only the key version: origin derivation
        # accepts this value while the dedicated signer explicitly rejects it.
        app.state.auth_policy_config['hmac']['key_version'] = 0
    elif failure == 'constraints':
        app.state.policy_constraint_resolver = lambda context: PolicyEvaluationConstraints(deployment_allowed=False)
    else:
        def fail_after_sql(sql, params):
            if sql.startswith('select ref,revision from app.listening_goals'):
                raise RuntimeError(private_detail)
        app.state.listening_goals_service = db.service_for(after=fail_after_sql)
    before = db.snapshot()
    status, body, private = request(app, 'GET', '/account/goals', headers=auth)
    assert status == (403 if failure == 'constraints' else 503)
    if failure == 'signing':
        assert body == {'ok': False, 'error': 'account_goals_context_unavailable'}
    elif failure == 'repository':
        assert body == {'ok': False, 'error': 'goals_unavailable'}
    assert private[b'cache-control'] == b'private, no-store'
    assert 'context_ref' not in body and 'context_scope' not in body
    assert private_detail not in str(body) and auth[HEADER] not in str(body)
    assert db.snapshot() == before


def test_account_and_home_markers_are_not_interchangeable_on_real_routes(linked):
    db = linked.database
    app = application(db)
    auth = account_headers(app, db)
    status, home, _ = request(app, 'GET', '/account/goals', headers=headers(app, db))
    assert status == 200 and home['context_ref'] != auth[HEADER]
    before = db.snapshot()
    assert_stale(request(app, 'GET', '/account/goals', headers={**auth, HEADER: home['context_ref']}))
    assert_stale(request(app, 'POST', '/account/goals/remote-evidence',
        headers={**headers(app, db), 'x-albumhaven-context': auth[HEADER]},
        payload={'release_group_id': db.group()}))
    assert db.provider_calls == [] and db.snapshot() == before
