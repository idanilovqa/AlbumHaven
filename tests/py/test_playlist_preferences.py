"""Account-owned Playlist order memory, separate from collection metadata."""
import pytest
from music_app.services.playlist_preferences_postgres import normalize_preference_command, preference_projection

KEY="a0000000-0000-4000-8000-000000000001"


def test_playlist_memory_defaults_on_regular():
    assert preference_projection(None)=={"remember_order_mode":True,"last_order_mode":"regular", "effective_order_mode":"regular","revision":"1"}


def test_disabled_memory_uses_regular_without_erasing_prior_choice():
    assert preference_projection({"remember_order_mode":False,"last_order_mode":"shuffle","revision":8})=={
        "remember_order_mode":False,"last_order_mode":"shuffle","effective_order_mode":"regular","revision":"8"}


@pytest.mark.parametrize("value", [{"remember_order_mode":False},{"last_order_mode":"shuffle"},
                                   {"remember_order_mode":True,"last_order_mode":"regular"}])
def test_preference_command_is_strict_partial_and_idempotent(value):
    result=normalize_preference_command({"revision":"1","request_key":KEY,**value})
    assert result.data=={"revision":"1",**value}
    assert result.request_key==KEY
    assert result.digest==normalize_preference_command({"request_key":KEY,"revision":"1",**value}).digest


@pytest.mark.parametrize("data", [{},{"remember_order_mode":1},{"remember_order_mode":"false"},
    {"last_order_mode":"repeat_one"},{"last_order_mode":"repeat_all"},{"account_id":999},
    {"last_order_mode":"shuffle","playlist_id":KEY}])
def test_preference_command_rejects_repeat_identity_and_weak_booleans(data):
    from music_app.services.owned_playlists import PlaylistError
    with pytest.raises(PlaylistError,match="invalid_command"):
        normalize_preference_command({"revision":"1","request_key":KEY,**data})


def test_self_preference_authority_does_not_need_or_expand_library_grants():
    from dataclasses import replace
    from tests.py.test_playlist_collaboration import context
    from music_app.services.playlist_preferences_postgres import PostgresPlaylistPreferencesService, PREFERENCE_WRITE
    from music_app.services.policy_evaluator import PolicyEvaluationConstraints
    from music_app.services.owned_playlists import PlaylistError
    ctx=context(grants=())
    ctx=replace(ctx,library_id=None,actor=replace(ctx.actor,current_library_id=None,library_relationships=()))
    live=PostgresPlaylistPreferencesService._require(ctx,PREFERENCE_WRITE,None)
    assert live.target_account_id==ctx.actor.account_id
    assert live.library_id is None
    with pytest.raises(PlaylistError,match="forbidden"):
        PostgresPlaylistPreferencesService._require(ctx,PREFERENCE_WRITE,PolicyEvaluationConstraints(request_origin_allowed=False))


def test_preference_route_policy_is_self_only_and_requires_session_csrf():
    from music_app.services.private_route_boundary import _PRIVATE_ROUTE_ACTIONS,csrf_mode_for_route
    from music_app.services.playlist_preferences_postgres import PREFERENCE_READ,PREFERENCE_WRITE
    assert _PRIVATE_ROUTE_ACTIONS[("GET","/account/playlist-preferences")]==PREFERENCE_READ
    assert _PRIVATE_ROUTE_ACTIONS[("PUT","/account/playlist-preferences")]==PREFERENCE_WRITE
    assert _PRIVATE_ROUTE_ACTIONS[("GET","/account/playlist-preferences/operations/{request_key}")]==PREFERENCE_READ
    assert csrf_mode_for_route("PUT","/account/playlist-preferences")=="session_header"


def test_preference_write_transport_preserves_context_and_command_receipt(monkeypatch):
    import asyncio,json
    from tests.py.test_playlist_collaboration_routes import request
    from tests.py.test_playlist_collaboration import context
    from music_app.routes import owned_playlists_asgi as routes
    from music_app.services.playlist_preferences_postgres import PREFERENCE_WRITE
    calls=[]
    class Service:
        def execute(self,ctx,command,*,constraints):
            calls.append(command)
            return {"ok":True,"request_key":command.request_key,"preferences":{"revision":"2"}}
    svc=Service()
    monkeypatch.setattr(routes,"_context",lambda request,action:(context(),None) if action==PREFERENCE_WRITE else pytest.fail("Wrong action"))
    monkeypatch.setattr(routes,"_context_ref",lambda request:"a"*64)
    monkeypatch.setattr(routes,"PostgresPlaylistPreferencesService",lambda config:svc)
    req=request({"revision":"1","request_key":KEY,"last_order_mode":"shuffle"},svc)
    req.app.state.config={}
    response=asyncio.run(routes.update_playlist_preferences(req))
    assert response.status_code==200 and json.loads(response.body)["request_key"]==KEY
    assert calls[0].data=={"revision":"1","last_order_mode":"shuffle"}
    assert response.headers["cache-control"]=="private, no-store"
