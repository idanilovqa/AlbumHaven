"""AUTHORED ONLY: real account-page policy, auth, marker and template boundary.

The appearance I/O and template response are bounded synthetic presentation
seams. Current session/actor, require_action and allowed_actions_for_request are
not replaced by success stubs. Template-source assertions are not render proof.
"""
import inspect
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.responses import HTMLResponse
import music_app

from music_app.routes import foobar_account_ui_asgi as page
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.foobar_account_route_testing import request as authenticated_request


def page_request(monkeypatch, *, library=None, browse=True, during_appearance=None):
    req, auth, reads = authenticated_request(monkeypatch, b'')
    path = '/account/integrations/foobar'
    req.scope.update(method='GET', path=path, raw_path=path.encode())
    actual_execute = auth.execute
    def execute(sql, params=None):
        cursor = actual_execute(sql, params)
        if 'app.accounts.id as account_id' in sql:
            row, = cursor.rows
            row['current_library_id'] = library
            if library is None or not browse:
                row['library_relationships'] = []
                row['capability_grants'] = []
        return cursor
    monkeypatch.setattr(auth, 'execute', execute)
    authorization, projection, appearance_calls, renders = [], [], [], []
    actual_require, actual_allowed = page.require_action, page.allowed_actions_for_request
    def require(action, **kwargs):
        authorization.append((action, kwargs))
        return actual_require(action, **kwargs)
    def allowed(request, actions, **kwargs):
        projection.append((tuple(actions), kwargs))
        return actual_allowed(request, actions, **kwargs)
    async def appearance(request):
        appearance_calls.append(request.state.current_actor)
        if during_appearance is not None:
            during_appearance(auth, request)
        return {'synthetic_appearance': 'bounded'}
    def render(request, name, context):
        renders.append((request, name, context))
        return HTMLResponse('Synthetic template response boundary.')
    monkeypatch.setattr(page, 'require_action', require)
    monkeypatch.setattr(page, 'allowed_actions_for_request', allowed)
    monkeypatch.setattr(page, 'load_appearance_context', appearance)
    req.app.state.templates = SimpleNamespace(TemplateResponse=render)
    req.app.state.runtime_asset_version = 'synthetic-version'
    return req, auth, reads, authorization, projection, appearance_calls, renders


@pytest.mark.asyncio
async def test_actual_account_only_page_needs_no_library_or_shared_shell_permission(monkeypatch):
    req, auth, reads, checks, projections, appearances, renders = page_request(monkeypatch)
    response = await page.get_account_foobar(req)
    assert response.status_code == 200
    assert checks == [('account.self.foobar.write', {'refresh_actor': True})] * 2
    assert len(appearances) == len(renders) == 1 and reads[0] == 0
    assert req.state.current_actor.current_library_id is None
    assert projections == [(('accounts.read', 'account.self.foobar.write', 'library.browse.read'),
                            {'target_account_id': 1})]
    rendered_request, name, value = renders[0]
    assert rendered_request is req and name == 'account-foobar.html'
    assert value['account_foobar_allowed'] is True
    assert value['account_foobar_matching_library_id'] is None
    assert value['account_foobar_scope'] == 'account-foobar-v1'
    assert value['account_foobar_context'] == page.foobar_account_ui_context_ref(req)
    assert value['runtime_asset_version'] == 'synthetic-version'
    assert value['settings_section'] == 'foobar' and value['csrf_token']
    assert value['synthetic_appearance'] == 'bounded'
    assert response.headers['cache-control'] == 'private, no-store'
    assert response.headers['x-content-type-options'] == 'nosniff'
    assert all(action != 'app.shell.read' for action, kwargs in checks)


@pytest.mark.asyncio
@pytest.mark.parametrize('browse', [True, False])
async def test_page_matching_hint_uses_real_current_browse_policy(monkeypatch, browse):
    req, auth, reads, checks, projections, appearances, renders = page_request(monkeypatch,
        library=7, browse=browse)
    response = await page.get_account_foobar(req)
    assert response.status_code == 200
    value = renders[0][2]
    assert value['account_foobar_allowed'] is True
    assert value['account_foobar_matching_library_id'] == (7 if browse else None)
    assert value['account_allowed_actions'].allows('library.browse.read') is browse


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', ['revoked', 'inactive', 'constraint'])
@pytest.mark.parametrize('when', ['before_page', 'during_appearance'])
async def test_page_real_policy_denial_prevents_render_before_or_after_appearance(monkeypatch, failure, when):
    def deny(auth, req):
        if failure == 'revoked': auth.revoked = True
        elif failure == 'inactive': auth.active = False
        else:
            req.app.state.policy_constraint_resolver = lambda context: PolicyEvaluationConstraints(
                request_origin_allowed=False)
    req, auth, reads, checks, projections, appearances, renders = page_request(monkeypatch,
        during_appearance=deny if when == 'during_appearance' else None)
    if when == 'before_page': deny(auth, req)
    with pytest.raises(HTTPException) as caught:
        await page.get_account_foobar(req)
    assert caught.value.status_code in (401, 403)
    assert not renders and not projections and reads[0] == 0
    assert len(appearances) == (1 if when == 'during_appearance' else 0)
    assert len(checks) == (2 if when == 'during_appearance' else 1)


@pytest.mark.asyncio
async def test_page_signs_refreshed_post_appearance_session_not_old_actor(monkeypatch):
    previous = []
    def switch(auth, req):
        previous.append(page.foobar_account_ui_context_ref(req))
        auth.session_id = 4
    req, auth, reads, checks, projections, appearances, renders = page_request(monkeypatch,
        during_appearance=switch)
    response = await page.get_account_foobar(req)
    assert response.status_code == 200 and len(checks) == 2
    assert appearances[0].session_id == 3 and req.state.current_actor.session_id == 4
    assert renders[0][2]['account_foobar_context'] == page.foobar_account_ui_context_ref(req)
    assert renders[0][2]['account_foobar_context'] != previous[0]


@pytest.mark.asyncio
async def test_page_malformed_signer_is_generic_private_failure_without_render(monkeypatch):
    def invalidate_marker_version(auth, req):
        # Keep genuine origin signing valid: that owner canonicalizes True to
        # int 1. The genuine Foobar marker deliberately rejects bool versions.
        # Neither the policy nor the marker helper/result is replaced.
        configuration = req.app.state.auth_policy_config
        req.app.state.auth_policy_config = dict(configuration,
            hmac=dict(configuration['hmac'], key_version=True))
    req, auth, reads, checks, projections, appearances, renders = page_request(monkeypatch,
        during_appearance=invalidate_marker_version)
    response = await page.get_account_foobar(req)
    assert response.status_code == 503 and not renders and not projections
    assert checks == [('account.self.foobar.write', {'refresh_actor': True})] * 2
    assert response.body == b'Foobar settings are temporarily unavailable.'
    assert req.app.state.auth_policy_config['hmac']['secret'].encode() not in response.body
    assert response.headers['cache-control'] == 'private, no-store'
    assert response.headers['x-content-type-options'] == 'nosniff'


@pytest.mark.asyncio
async def test_page_invalid_origin_signing_fails_closed_before_marker_or_render(monkeypatch):
    req, auth, reads, checks, projections, appearances, renders = page_request(monkeypatch)
    req.app.state.auth_policy_config = {'hmac': {'secret': 'do-not-disclose', 'key_version': 1}}
    # This earlier failure belongs to genuine policy_asgi._request_origin,
    # not the later page-local FoobarAccountUIContextError response branch.
    with pytest.raises(RuntimeError):
        await page.get_account_foobar(req)
    assert checks == [('account.self.foobar.write', {'refresh_actor': True})]
    assert not appearances and not projections and not renders and reads[0] == 0


def test_account_page_and_navigation_template_contracts_do_not_boot_shared_shell():
    root = Path(music_app.__file__).resolve().parent
    template = (root / 'templates/account-foobar.html').read_text()
    navigation = (root / 'templates/partials/admin-settings-nav.html').read_text()
    shell = (root / 'templates/index.html').read_text()
    source = inspect.getsource(page)
    registration = inspect.getsource(music_app)
    assert [(entry.path, entry.methods) for entry in page.router.routes] == [
        ('/account/integrations/foobar', {'GET'}), ('/account/foobar-history', {'GET'})]
    assert 'app.include_router(foobar_account_ui_router)' in registration
    assert 'app.shell.read' not in source and 'bootstrap_owner' not in source
    assert 'data-settings-document-navigation="true"' in template
    for attribute in ('data-account-foobar-context', 'data-account-foobar-scope',
                      'data-account-foobar-matching-library-id', 'data-account-foobar-allowed'):
        assert attribute in template
    for asset in ('/static/js/button-component.js?v={{ runtime_asset_version }}',
                  '/static/js/runtime/compact-data-table.js?v={{ runtime_asset_version }}',
                  '/static/js/runtime/session-csrf-fetch.js?v={{ runtime_asset_version }}',
                  '/static/js/foobar-import/account-entry.mjs?v={{ runtime_asset_version }}'):
        assert asset in template
    for forbidden in ('/static/js/app.js', 'runtime-bundle.js', 'private-transport',
                      'data-private-ui-context=', 'data-native-library-id=', 'media-bootstrap'):
        assert forbidden not in template
    assert '/static/css/foobar-import.css?v={{ runtime_asset_version }}' in template
    assert '/static/css/foobar-import.css?v={{ runtime_asset_version }}' in shell
    assert "navigation_actions.allows('accounts.read')" in navigation
    assert "navigation_actions.allows('account.self.foobar.write')" in navigation
    assert "'/account/integrations/foobar'" in navigation
