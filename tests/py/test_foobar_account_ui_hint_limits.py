"""AUTHORED ONLY: exact JavaScript-safe optional hint, never import authority.

Adds to frozen semantic-review tests without changing them. Actual page and
shell projection functions plus current auth/policy/signers remain in use.
No Python import/parse/test, SQL, app boot, install or real account access ran.
"""
import pytest

from music_app.routes import foobar_account_ui_asgi as page
from music_app.routes import web_asgi as web
from tests.py.test_foobar_account_ui_page import page_request

MAX_JS_EXACT_INTEGER = 9_007_199_254_740_991
MAX_DATABASE_INTEGER = 9_223_372_036_854_775_807


@pytest.mark.asyncio
@pytest.mark.parametrize('library,expected_hint', [
    (None, None),
    (1, 1),
    (MAX_JS_EXACT_INTEGER, MAX_JS_EXACT_INTEGER),
    (MAX_JS_EXACT_INTEGER + 1, None),
    (MAX_DATABASE_INTEGER, None),
])
async def test_actual_page_and_shell_omit_unsafe_hint_without_disabling_account_import(
        monkeypatch, library, expected_hint):
    req, auth, reads, checks, projections, appearances, renders = page_request(monkeypatch,
        library=library)
    original_execute = auth.execute
    def scoped_driver_rows(sql, params=None):
        cursor = original_execute(sql, params)
        if library is not None and 'app.accounts.id as account_id' in sql:
            row, = cursor.rows
            # Genuine actor/policy owners receive exact bigint driver results;
            # do not patch allowlists or claim a caller-owned permission.
            for relationship in row['library_relationships']:
                relationship['library_id'] = library
            for grant in row['capability_grants']:
                grant['scope_id'] = library
        return cursor
    monkeypatch.setattr(auth, 'execute', scoped_driver_rows)
    response = await page.get_account_foobar(req)
    assert response.status_code == 200 and reads[0] == 0
    assert req.state.current_actor.current_library_id == library
    page_value = renders[-1][2]
    assert page_value['account_foobar_allowed'] is True
    assert page_value['account_foobar_matching_library_id'] == expected_hint
    assert page_value['account_foobar_context']
    assert page_value['account_foobar_scope'] == 'account-foobar-v1'
    if expected_hint is not None:
        assert type(page_value['account_foobar_matching_library_id']) is int
    # Only immutable static-asset metadata is substituted. The actual shell
    # projection still uses real policy, account continuity, private-library
    # continuity and session-CSRF helpers on the genuinely authenticated actor.
    monkeypatch.setattr(web, '_runtime_asset_version', lambda: 'synthetic-assets')
    shell_response = web._template_response(req, {})
    assert shell_response.status_code == 200 and renders[-1][1] == 'index.html'
    shell_value = renders[-1][2]
    assert shell_value['account_foobar_allowed'] is True
    assert shell_value['account_foobar_matching_library_id'] == expected_hint
    assert shell_value['account_foobar_context'] == page_value['account_foobar_context']
    assert shell_value['account_foobar_scope'] == 'account-foobar-v1'
    # Neither representation may round the actor ID or reinterpret it as a
    # smaller matching library. The account-owned marker remains usable.
    assert req.state.current_actor.current_library_id == library


@pytest.mark.asyncio
async def test_safe_integer_alone_cannot_supply_page_or_shell_matching_permission(monkeypatch):
    req, auth, reads, checks, projections, appearances, renders = page_request(monkeypatch,
        library=7, browse=False)
    assert (await page.get_account_foobar(req)).status_code == 200
    page_value = renders[-1][2]
    assert page_value['account_foobar_matching_library_id'] is None
    assert page_value['account_foobar_allowed'] is True and page_value['account_foobar_context']
    monkeypatch.setattr(web, '_runtime_asset_version', lambda: 'synthetic-assets')
    assert web._template_response(req, {}).status_code == 200
    shell_value = renders[-1][2]
    assert shell_value['account_foobar_matching_library_id'] is None
    assert shell_value['account_foobar_allowed'] is True
    assert shell_value['account_foobar_context'] == page_value['account_foobar_context']
