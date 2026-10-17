"""Dedicated Goals HTML entry through real SQL/session/policy/template owners.

Uses the established HTML ASGI request driver only; none of its actor/password
success stubs are installed. Appearance and layout use their real PostgreSQL
repositories with transparent SQL observation, and Goals uses its real owner.
"""
import json
import re
from datetime import timedelta

import pytest

from music_app.routes.account_asgi import router as account_router
from music_app.services.appearance_preferences_postgres import PostgresAppearancePreferencesRepository
from music_app.services.client_layout_preferences import PostgresClientLayoutPreferences
from music_app.services.auth_session_csrf import issue_session_csrf, matches_session_csrf
from tests.py.test_account_asgi import _request as html_request
from tests.py.test_listening_goals_postgres import db, urls
from tests.py.test_listening_goals_routes import application, headers, request
from tests.py.test_listening_goals_ui_context import linked
from tests.py.test_listening_goals_account_context import HEADER, server_marker, assert_stale


PATH = '/account/goals/view'


def page_application(database, *, after_presentation=None, after_goals=None):
    app = application(database)
    app.include_router(account_router)
    app.state.runtime_asset_version = 'account-goals-authentic-test'
    presentation = []
    def observed(sql, params):
        presentation.append((sql, params))
        if after_presentation is not None:
            after_presentation(sql, params)
    app.state.appearance_preferences_repository = PostgresAppearancePreferencesRepository(
        app.state.config, connect=database.connector(after=observed))
    app.state.client_layout_preferences_repository = PostgresClientLayoutPreferences(
        app.state.config, connect=database.connector(after=observed))
    if after_goals is not None:
        app.state.listening_goals_service = database.service_for(after=after_goals)
    return app, presentation


def get_page(app, database, actor=None):
    actor = actor or database.owner
    return html_request(app, 'GET', PATH, session=database.session_tokens[actor.session_id])


def page_marker(body):
    markers = re.findall(r'data-account-goals-context="([0-9a-f]{64})"', body)
    assert len(markers) == 1
    return markers[0]


def script_json(body, identity):
    found = re.findall(r'<script[^>]*id="' + identity + r'"[^>]*>(.*?)</script>', body, re.S)
    assert len(found) == 1
    return json.loads(found[0])


def assert_private_page(status, response_headers, body):
    assert status == 200, body
    assert response_headers['cache-control'] == 'private, no-store'
    assert response_headers['content-type'].startswith('text/html')
    assert 'id="account-home"' in body
    assert '/static/css/account-home.css?v=account-goals-authentic-test' in body
    assert '/static/js/home-friends/account-entry.mjs?v=account-goals-authentic-test' in body
    assert '/static/js/runtime/private-ui-transport.js?v=account-goals-authentic-test' in body
    assert '/static/js/runtime/session-csrf-fetch.js?v=account-goals-authentic-test' in body
    assert 'id="app-form-modal"' in body
    assert body.count('id="app-form-modal"') == 1
    assert 'id="app-shell"' not in body
    assert '/bootstrap-data' not in body and '/track?' not in body
    for asset in ('/static/app.js', '/static/js/runtime-bundle.js',
                  '/static/js/app.js', '/static/js/player.js', '/static/js/audio-player.js',
                  '/static/js/runtime/app-shell.js', '/static/js/home-friends/entry.mjs'):
        assert asset not in body


def test_no_library_page_renders_real_preferences_session_csrf_and_server_marker_without_goal_data(db):
    app, observed = page_application(db)
    receipt, _ = db.add(db.acquire(db.group(title='Private persisted Goal must not hydrate HTML')))
    before = db.snapshot()
    status, private, body = get_page(app, db)
    assert_private_page(status, private, body)
    assert page_marker(body) == server_marker(app, db)
    resolved = app.state.current_actor_resolver.resolve(db.session_tokens[db.owner.session_id])
    assert resolved.current_library_id is None and resolved.capability_grants == ()
    assert resolved.username_display in body
    assert db.session_tokens[db.owner.session_id] not in body
    assert receipt['catalog_ref'] not in body and receipt['goal_ref'] not in body
    assert 'Private persisted Goal must not hydrate HTML' not in body
    csrf = re.findall(r'name="csrf_token" value="([^"]+)"', body)
    assert len(csrf) == 1
    assert csrf[0] == issue_session_csrf(db.session_tokens[db.owner.session_id], app.state.auth_policy_config)
    assert matches_session_csrf(db.session_tokens[db.owner.session_id], csrf[0], app.state.auth_policy_config)
    assert '__Host-album_haven_csrf=' + csrf[0] in private['set-cookie']
    assert 'action="/logout"' in body
    appearance = script_json(body, 'appearance-bootstrap')
    layout = script_json(body, 'client-layout-preferences-bootstrap')
    assert appearance['load_error'] is False
    assert layout['load_failed'] is False and layout['account_id'] == db.owner.account_id
    appearance_reads = [params for sql, params in observed if 'from app.user_appearance_preferences' in sql]
    layout_reads = [params for sql, params in observed if 'from app.user_client_layout_preferences' in sql]
    assert appearance_reads == [(db.owner.account_id,)] and layout_reads == [(db.owner.account_id,)]
    assert not hasattr(app.state, 'profile_password_service')
    assert not hasattr(app.state, 'breached_password_checker')
    assert db.snapshot() == before


@pytest.mark.parametrize('removed', [False, True])
def test_actual_viewer_and_removed_current_library_keep_own_account_page(linked, removed):
    db = linked.database
    with db.connect() as connection:
        connection.execute("update library.library_memberships set membership_role='viewer' where account_id=%s and library_id=%s",
            (db.owner.account_id, linked.library_id))
    app, _ = page_application(db)
    initial = page_marker(get_page(app, db)[2])
    if removed:
        with db.connect() as connection:
            connection.execute('delete from library.library_memberships where account_id=%s and library_id=%s',
                (db.owner.account_id, linked.library_id))
    status, private, body = get_page(app, db)
    assert_private_page(status, private, body)
    assert page_marker(body) == initial == server_marker(app, db)
    actor = app.state.current_actor_resolver.resolve(db.session_tokens[db.owner.session_id])
    assert actor.current_library_id == (None if removed else linked.library_id)
    assert actor.capability_grants == ()
    if not removed:
        assert actor.library_relationships[0].membership_role == 'viewer'


@pytest.mark.parametrize('replacement', ['session', 'account'])
def test_page_and_api_bind_replacement_cookie_to_its_actual_account_and_session(db, replacement):
    app, observed = page_application(db)
    first_body = get_page(app, db)[2]
    first_marker = page_marker(first_body)
    actor = db.renewed_actor() if replacement == 'session' else db.other_actor()
    observed.clear()
    status, private, body = get_page(app, db, actor)
    assert_private_page(status, private, body)
    next_marker = page_marker(body)
    assert next_marker != first_marker and next_marker == server_marker(app, db, actor)
    assert script_json(body, 'client-layout-preferences-bootstrap')['account_id'] == actor.account_id
    assert all(params == (actor.account_id,) for sql, params in observed if 'from app.user_' in sql)
    auth = headers(app, db, actor)
    assert_stale(request(app, 'GET', '/account/goals', headers={**auth, HEADER: first_marker}))
    status, current, _ = request(app, 'GET', '/account/goals', headers={**auth, HEADER: next_marker})
    assert status == 200 and current['context_ref'] == next_marker
    assert current['context_scope'] == 'account-goals-v1'


@pytest.mark.parametrize('failure', ['revoked', 'expired', 'disabled'])
def test_actual_authority_is_rechecked_after_real_appearance_and_layout_io(db, failure):
    stages, retired = [], []
    def after_presentation(sql, params):
        if 'from app.user_appearance_preferences' in sql:
            stages.append('appearance')
        if 'from app.user_client_layout_preferences' in sql:
            stages.append('layout')
            with db.connect() as connection:
                if failure == 'revoked':
                    connection.execute('update app.account_sessions set revoked_at=%s where id=%s',
                        (db.now, db.owner.session_id))
                elif failure == 'expired':
                    connection.execute('update app.account_sessions set idle_expires_at=%s where id=%s',
                        (db.now, db.owner.session_id))
                else:
                    connection.execute('update app.accounts set is_active=false,disabled_at=%s where id=%s',
                        (db.now, db.owner.account_id))
            retired.append(True)
    def after_goals(sql, params):
        if sql.startswith('select is_active,disabled_at from app.accounts'):
            stages.append('goals-account')
    app, _ = page_application(db, after_presentation=after_presentation, after_goals=after_goals)
    before = db.snapshot()
    status, private, body = get_page(app, db)
    assert status == 403 and private['cache-control'] == 'private, no-store'
    assert stages == ['appearance', 'layout', 'goals-account'] and retired == [True]
    assert body == 'Home is unavailable for this session.'
    assert 'data-account-goals-context' not in body and 'csrf_token' not in body
    assert db.snapshot() == before


def test_page_final_session_recheck_rejects_expiry_after_real_goals_read(db):
    checks, reads = [], []
    def after_goals(sql, params):
        if sql.startswith('select ref,revision from app.listening_goals'):
            reads.append(True)
        if 'from app.account_sessions' in sql and 'for update' in sql:
            checks.append(True)
            if len(checks) == 2:
                db.now += timedelta(days=2)
    app, _ = page_application(db, after_goals=after_goals)
    before = db.snapshot()
    status, private, body = get_page(app, db)
    assert status == 403 and private['cache-control'] == 'private, no-store'
    assert reads == [True] and len(checks) == 2
    assert 'data-account-goals-context' not in body and 'csrf_token' not in body
    assert db.snapshot() == before


def test_real_sql_failure_is_generic_private_and_never_embeds_marker(db):
    detail = 'synthetic-private-goals-database-detail'
    def after_goals(sql, params):
        if sql.startswith('select ref,revision from app.listening_goals'):
            raise RuntimeError(detail)
    app, _ = page_application(db, after_goals=after_goals)
    before = db.snapshot()
    status, private, body = get_page(app, db)
    assert status == 503 and private['cache-control'] == 'private, no-store'
    assert body == 'Home is temporarily unavailable. Please try again.'
    assert detail not in body and 'data-account-goals-context' not in body
    assert db.snapshot() == before


def test_successful_account_page_does_not_open_library_shell_bootstrap_or_media(db):
    app, _ = page_application(db)
    reached = []
    async def forbidden_handler():
        reached.append(True)
        pytest.fail('Account page must not unlock library handlers')
    for path in ('/', '/bootstrap-data', '/track'):
        app.add_api_route(path, forbidden_handler, methods=['GET'])
    status, private, body = get_page(app, db)
    assert_private_page(status, private, body)
    auth = {**headers(app, db), HEADER: page_marker(body)}
    for path in ('/', '/bootstrap-data', '/track'):
        status, value, _ = request(app, 'GET', path, headers=auth)
        assert status == 403 and value == {'detail': 'Action not permitted.'}
    assert reached == []


@pytest.mark.parametrize('failure', ['missing', 'revoked'])
def test_absent_or_retired_session_never_reaches_page_presentation_repositories(db, failure):
    app, observed = page_application(db)
    token = db.session_tokens[db.owner.session_id]
    if failure == 'missing':
        token = ''
    else:
        with db.connect() as connection:
            connection.execute('update app.account_sessions set revoked_at=%s where id=%s',
                (db.now, db.owner.session_id))
    status, private, body = html_request(app, 'GET', PATH, session=token)
    assert status == 401 and private['cache-control'] == 'private, no-store'
    assert json.loads(body) == {'detail': 'Authentication required.'}
    assert observed == [] and 'data-account-goals-context' not in body
