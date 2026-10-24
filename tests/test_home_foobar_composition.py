"""Authored Home composition tests. Not executed in this source-only packet.

Run only after exact Home + accepted LastFM/erratum + this backend + matching
frontend overlay are materialized in an authorized isolated test environment.
No provider, database, credentials, live accounts or original fixtures required.
"""
import asyncio
from dataclasses import replace
from types import SimpleNamespace

import pytest


def test_account_history_and_import_do_not_require_library_administration():
    from music_app.services.current_actor import CurrentActor, ActorState
    from music_app.services.policy import PolicyContext, RequestOrigin
    from music_app.services.foobar_account_authority import require_account_foobar, require_account_foobar_read
    from music_app.services.policy_evaluator import PolicyEvaluator
    actor = CurrentActor(ActorState.ACTIVE, account_id=7, session_id=11)
    context = PolicyContext.build(actor=actor, action='account.self.foobar.read',
        target_account_id=7, deployment_mode='private',
        request_origin=RequestOrigin('session', 'synthetic-home-test'), client_surface_class='private_web')
    for require in (require_account_foobar, require_account_foobar_read):
        account = require(context)
        assert account.library_id is None
        assert not account.actor.capability_grants
        assert not account.actor.is_bootstrap_owner
    for action in ('library.browse.read', 'library.media.read', 'library.track_preferences.manage'):
        assert not PolicyEvaluator().evaluate(replace(context, action=action)).decision.allowed


def test_account_authority_rejects_other_account_and_disabled_session():
    from music_app.services.current_actor import CurrentActor, ActorState
    from music_app.services.policy import PolicyContext, RequestOrigin
    from music_app.services.foobar_account_authority import require_account_foobar_read
    from music_app.services.foobar_source_postgres import SourceStale
    context = PolicyContext.build(actor=CurrentActor(ActorState.ACTIVE, account_id=7, session_id=11),
        action='account.self.foobar.read', target_account_id=8, deployment_mode='private',
        request_origin=RequestOrigin('session', 'synthetic-home-test'), client_surface_class='private_web')
    with pytest.raises(SourceStale):
        require_account_foobar_read(context)
    with pytest.raises(SourceStale):
        require_account_foobar_read(replace(context, target_account_id=7,
            actor=replace(context.actor, state=ActorState.INACTIVE)))


@pytest.mark.parametrize('path,action', [
    ('/integrations/foobar/account/history/sources', 'account.self.foobar.read'),
    ('/integrations/foobar/account/history/list', 'account.self.foobar.read'),
    ('/integrations/foobar/account/history/enhanced', 'account.self.foobar.read'),
    ('/integrations/foobar/account/review/start', 'account.self.foobar.write'),
    ('/integrations/foobar/account/apply', 'account.self.foobar.write'),
    ('/integrations/foobar/account/history/native/play', 'library.browse.read'),
    ('/home/activity/lastfm/import', 'account.self.lastfm.history.write'),
    ('/home/activity/scrobbles/retry', 'integration.lastfm.scrobbles.submit'),
])
def test_composed_perimeter_keeps_independent_policy_and_csrf(path, action):
    from music_app.services.private_route_boundary import private_action_for_route, csrf_mode_for_route
    assert private_action_for_route('POST', path) == action
    assert csrf_mode_for_route('POST', path) == 'session_header'


def test_factory_default_off_and_single_owner_drains(monkeypatch):
    import music_app as factory
    from music_app.services import foobar_account_import_service as service
    events = []
    handle = SimpleNamespace(start=lambda timeout: events.append(('start', timeout)),
        close=lambda: events.append(('close',)), join=lambda timeout: events.append(('join', timeout)) or True)
    def create(config, *, database_url):
        events.append(('create', database_url))
        return handle
    monkeypatch.setattr(service, 'create_foobar_import_service', create)
    app = SimpleNamespace(state=SimpleNamespace(foobar_account_import_service=None))
    asyncio.run(factory._start_foobar_account_import(app, {}))
    assert events == []
    asyncio.run(factory._start_foobar_account_import(app, {
        'ALBUM_HAVEN_FOOBAR_ACCOUNT_IMPORT_ENABLED': True, 'ALBUM_HAVEN_APP_DATABASE_URL': 'synthetic-only'}))
    assert app.state.foobar_account_import_service is handle
    asyncio.run(factory._stop_foobar_account_import(app))
    assert events == [('create', 'synthetic-only'), ('start', 5.0), ('close',), ('join', 30.0)]


def test_partial_startup_keeps_original_owner_for_drain(monkeypatch):
    import music_app as factory
    from music_app.services import foobar_account_import_service as service
    events = []
    def fail(timeout):
        events.append('start')
        raise TimeoutError('synthetic')
    handle = SimpleNamespace(start=fail, close=lambda: events.append('close'), join=lambda timeout: False)
    monkeypatch.setattr(service, 'create_foobar_import_service', lambda *a, **k: handle)
    app = SimpleNamespace(state=SimpleNamespace(foobar_account_import_service=None))
    asyncio.run(factory._start_foobar_account_import(app, {'ALBUM_HAVEN_FOOBAR_ACCOUNT_IMPORT_ENABLED': True}))
    assert app.state.foobar_account_import_service is handle
    with pytest.raises(RuntimeError, match='draining'):
        asyncio.run(factory._stop_foobar_account_import(app))
    assert app.state.foobar_account_import_service is handle
    assert events == ['start', 'close', 'close']


def test_capability_projection_exposes_read_without_mutation():
    from music_app.services.capability_ui import build_capability_ui, UI_ACTIONS
    assert 'account.self.foobar.read' in UI_ACTIONS
    assert 'account.self.foobar.write' in UI_ACTIONS
    result = build_capability_ui({'account.self.foobar.read': True, 'account.self.foobar.write': False}, 'private_web')
    assert result['allowed_actions']['account.self.foobar.read'] is True
    assert result['allowed_actions']['account.self.foobar.write'] is False
