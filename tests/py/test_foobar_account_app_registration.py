"""AUTHORED ONLY. App source registration and dormant lifecycle checks; no boot."""
import ast
import inspect
from types import SimpleNamespace

import pytest
import music_app
from music_app.services import private_route_boundary as perimeter
from music_app.routes import foobar_account_import_asgi as route
from tests.py.foobar_account_service_testing import s,CONFIG,handles


@pytest.mark.asyncio
@pytest.mark.parametrize('enabled',[None,False,1,'true'])
async def test_real_app_startup_default_does_not_create_worker(monkeypatch,enabled):
    monkeypatch.setattr(s,'_PROCESS_OWNER',None)
    app=SimpleNamespace(state=SimpleNamespace(foobar_account_import_service=None))
    await music_app._start_foobar_account_import(app,
        dict(CONFIG,ALBUM_HAVEN_FOOBAR_ACCOUNT_IMPORT_ENABLED=enabled))
    assert app.state.foobar_account_import_service is None and s._PROCESS_OWNER is None


@pytest.mark.asyncio
async def test_real_app_stop_detaches_owned_handle_without_replacing_shared_owner(monkeypatch):
    first,second=handles(monkeypatch,2,open=False)
    app=SimpleNamespace(state=SimpleNamespace(foobar_account_import_service=first))
    async def inline_thread(function,*args):
        return function(*args)
    monkeypatch.setattr(music_app.asyncio,'to_thread',inline_thread)
    await music_app._stop_foobar_account_import(app)
    assert first.closed and not second.closed
    assert app.state.foobar_account_import_service is first
    assert s._PROCESS_OWNER is second.owner


def test_router_and_private_perimeter_have_all_exact_post_paths():
    paths={f'/integrations/foobar/account/{kind}' for kind in
           ('temporary-source/status','source','prepare','apply','status','match-preview','match-apply','job/start','job/resume','job/status','job/cancel',
            'job/list','enhanced/review','ui/source','review/start','review/status','review/cancel','review/personal-changes','history/sources','history/list','history/enhanced')}
    native_paths={"/integrations/foobar/account/maintenance",
                  "/integrations/foobar/account/history/native/evidence",
                  "/integrations/foobar/account/history/native/eligibility",
                  "/integrations/foobar/account/history/native/play"}
    assert {entry.path for entry in route.router.routes}==paths | native_paths
    assert perimeter._FOOBAR_NATIVE_PATHS==frozenset(native_paths)
    assert perimeter._FOOBAR_ERROR_PATHS==frozenset(paths | native_paths)
    for entry in route.router.routes:
        assert entry.methods=={'POST'}
        assert perimeter.csrf_mode_for_route('POST', entry.path) == 'session_header'
        assert not perimeter._is_public('POST', entry.path)
        assert not perimeter._is_public('GET', entry.path)
        assert perimeter._PRIVATE_ROUTE_ACTIONS[('POST',entry.path)]==(
            'library.browse.read' if '/history/native/' in entry.path else
            'account.self.foobar.read' if '/history/' in entry.path else 'account.self.foobar.write')
    assert perimeter._FOOBAR_ACCOUNT_PATHS==frozenset(paths)


def test_actual_app_registration_source_keeps_start_and_drain_hooks():
    source=inspect.getsource(music_app)
    ast.parse(source)  # Authored inspection, never performed during authoring.
    assert 'app.include_router(foobar_account_import_router)' in source
    assert 'app.state.foobar_account_import_service = None' in source
    assert 'await _start_foobar_account_import(_app,runtime.config)' in source
    assert '("Foobar account import", lambda: _stop_foobar_account_import(_app))' in source
    start=inspect.getsource(music_app._start_foobar_account_import)
    assert start.index('foobar_account_import_service=handle')<start.index('handle.start')
    stop=inspect.getsource(music_app._stop_foobar_account_import)
    assert stop.index('handle.close()')<stop.index('handle.join')
    assert 'raise RuntimeError' in stop
    assert 'close_pool' not in start+stop and 'create_foobar_import_service' not in stop


def test_all_four_job_paths_are_private_session_csrf_actions():
    for kind in ('start','resume','status','cancel'):
        path = '/integrations/foobar/account/job/' + kind
        assert perimeter.private_action_for_route('POST', path) == 'account.self.foobar.write'
        assert perimeter.csrf_mode_for_route('POST', path) == 'session_header'
        assert not perimeter._is_public('POST', path)
        assert not perimeter._is_public('GET', path)


def test_all_review_and_ui_source_paths_are_private_session_csrf_actions():
    for suffix in ('ui/source', 'review/start', 'review/status', 'review/cancel', 'review/personal-changes'):
        path = '/integrations/foobar/account/' + suffix
        assert perimeter.private_action_for_route('POST', path) == 'account.self.foobar.write'
        assert perimeter.csrf_mode_for_route('POST', path) == 'session_header'
        assert not perimeter._is_public('POST', path)
        assert not perimeter._is_public('GET', path)
