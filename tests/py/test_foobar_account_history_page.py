"""AUTHORED ONLY. Actual account page policy/context; template-source contract.

Appearance I/O and template output use the existing presentation seam, not a
permission stub. Source assertions do not claim browser/bundle/render proof.
"""
import inspect
from pathlib import Path
import pytest
import music_app
from fastapi import HTTPException
from tests.py.test_foobar_account_ui_page import page_request, page
from tests.py.foobar_account_history_testing import read_only
from music_app.services import private_route_boundary as perimeter
from music_app.routes import web_asgi, account_asgi


def history_page_request(monkeypatch, **kwargs):
    values = page_request(monkeypatch, **kwargs)
    req = values[0]
    path = '/account/foobar-history'
    req.scope.update(path=path, raw_path=path.encode())
    req.app.state.policy_constraint_resolver = read_only
    return values


@pytest.mark.asyncio
async def test_authorized_history_page_requires_read_only_and_no_library_shell(monkeypatch):
    req, auth, reads, checks, projections, appearances, renders = history_page_request(monkeypatch)
    response = await page.get_account_foobar_history(req)
    assert response.status_code == 200 and reads[0] == 0
    assert checks == [('account.self.foobar.read', {'refresh_actor': True})] * 2
    assert len(renders) == len(appearances) == 1
    assert req.state.current_actor.current_library_id is None
    rendered, name, values = renders[0]
    assert rendered is req and name == 'account-foobar-history.html'
    assert values['account_foobar_history_allowed'] is True
    assert values['account_allowed_actions'].allows('account.self.foobar.read')
    assert not values['account_allowed_actions'].allows('account.self.foobar.write')
    assert values['account_foobar_context'] == page.foobar_account_ui_context_ref(req)
    assert values['account_foobar_scope'] == 'account-foobar-v1'
    assert values['csrf_token'] and values['settings_section'] == 'foobar-history'
    assert response.headers['cache-control'] == 'private, no-store'
    assert response.headers['x-content-type-options'] == 'nosniff'
    assert not any(action in ('app.shell.read', 'library.browse.read', 'account.self.foobar.write') for action, unused in checks)
    assert perimeter.private_action_for_route('GET', '/account/foobar-history') == 'account.self.foobar.read'
    assert perimeter.private_action_for_route('GET', '/account/integrations/foobar') == 'account.self.foobar.write'


@pytest.mark.asyncio
@pytest.mark.parametrize('during', [False, True])
async def test_read_revocation_before_or_after_appearance_prevents_history_render(monkeypatch, during):
    def revoke(auth, req): auth.revoked = True
    req, auth, reads, checks, projections, appearances, renders = history_page_request(monkeypatch,
        during_appearance=revoke if during else None)
    if not during: auth.revoked = True
    with pytest.raises(HTTPException): await page.get_account_foobar_history(req)
    assert not renders and not projections and reads[0] == 0
    assert len(appearances) == int(during)


@pytest.mark.asyncio
async def test_page_marker_comes_from_post_appearance_current_session(monkeypatch):
    old = []
    def switch(auth, req):
        old.append(page.foobar_account_ui_context_ref(req)); auth.session_id = 4
    req, auth, reads, checks, projections, appearances, renders = history_page_request(monkeypatch,
        during_appearance=switch)
    response = await page.get_account_foobar_history(req)
    assert response.status_code == 200 and renders[0][2]['account_foobar_context'] != old[0]
    assert renders[0][2]['account_foobar_context'] == page.foobar_account_ui_context_ref(req)


def test_authorized_navigation_home_marker_and_standalone_page_are_independent_of_lastfm():
    root = Path(music_app.__file__).resolve().parent
    template = (root / 'templates/account-foobar-history.html').read_text()
    navigation = (root / 'templates/partials/admin-settings-nav.html').read_text()
    home = (root / 'templates/index.html').read_text()
    assert [(entry.path, entry.methods) for entry in page.router.routes] == [
        ('/account/integrations/foobar', {'GET'}), ('/account/foobar-history', {'GET'})]
    assert "navigation_actions.allows('account.self.foobar.read')" in navigation
    assert "'/account/foobar-history'" in navigation and 'data-account-foobar-history-link' in navigation
    for attribute in ('data-account-foobar-context', 'data-account-foobar-scope', 'data-account-foobar-history-allowed'):
        assert attribute in template and attribute in home
    assert '/static/js/foobar-history/account-entry.mjs?v={{ runtime_asset_version }}' in template
    assert '/static/css/foobar-history.css?v={{ runtime_asset_version }}' in template
    assert 'data-settings-document-navigation="true"' in template
    assert 'Foobar evidence remains separate from Last.fm and measured in-app listening.' in template
    for forbidden in ('runtime-bundle.js', '/static/js/app.js', 'data-native-library-id=',
        'data-private-ui-context=', 'media-bootstrap', '/api/lastfm', 'data-lastfm-', 'lastfm_user'):
        assert forbidden not in template.lower()
    # This is a source-level integration guard, not a claim of Home rendering.
    web_source = inspect.getsource(web_asgi)
    assert 'account_foobar_history_allowed' in web_source and 'account.self.foobar.read' in web_source
    assert 'account.self.foobar.read' in inspect.getsource(account_asgi)
