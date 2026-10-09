"""Saved header sort never mutates the authored Playlist order."""
import pytest
from tests.py.test_playlist_collaboration import context,P,K,BROWSE
from music_app.services.owned_playlists import SETTINGS,PlaylistError,normalize_playlist_command,command_actions,require_playlist_authority


@pytest.mark.parametrize("key",["love_tier","play_count","popularity_count","duration"])
@pytest.mark.parametrize("direction",["asc","desc"])
def test_saved_sort_accepts_only_exact_existing_metric_keys(key,direction):
    command=normalize_playlist_command("default_sort",{"sort":{"key":key,"direction":direction},"revision":"1","request_key":K},playlist_ref=P)
    assert command.data["sort"]=={"key":key,"direction":direction}
    assert command_actions(command)==(BROWSE,SETTINGS)


def test_null_sort_resets_without_a_fake_position_sort_key():
    command=normalize_playlist_command("default_sort",{"sort":None,"revision":"1","request_key":K},playlist_ref=P)
    assert command.data["sort"] is None


@pytest.mark.parametrize("sort",[{"key":"title","direction":"asc"},{"key":"duration_seconds","direction":"asc"},
    {"key":"duration","direction":"default"},{"key":"duration","direction":"asc","owner_account_id":44},
    {"key":"duration"},[],True,"duration"])
def test_sort_does_not_accept_aliases_or_incomplete_shapes(sort):
    with pytest.raises(PlaylistError,match="invalid_command"):
        normalize_playlist_command("default_sort",{"sort":sort,"revision":"1","request_key":K},playlist_ref=P)


def test_missing_sort_does_not_silently_reset():
    with pytest.raises(PlaylistError,match="invalid_command"):
        normalize_playlist_command("default_sort",{"revision":"1","request_key":K},playlist_ref=P)


def test_saved_sort_needs_independent_settings_and_editor_eligibility():
    ctx=context(grants=(BROWSE,SETTINGS))
    require_playlist_authority(ctx,required_actions=(BROWSE,SETTINGS),owner_account_id=77,editor_grant=True)
    with pytest.raises(PlaylistError,match="forbidden"):
        require_playlist_authority(ctx,required_actions=(BROWSE,SETTINGS),owner_account_id=77,visibility="server_shared")
    with pytest.raises(PlaylistError,match="forbidden"):
        require_playlist_authority(context(grants=(BROWSE,)),required_actions=(BROWSE,SETTINGS),owner_account_id=11)


def test_default_sort_route_replaces_reserved_method_and_uses_settings_action():
    from music_app.services.private_route_boundary import private_action_for_route
    from music_app.routes import owned_playlists_asgi,api_wave_b_asgi_routes
    assert private_action_for_route("POST","/playlists/{playlist_ref}/default-sort")==SETTINGS
    matches=[route for router in (owned_playlists_asgi.router,api_wave_b_asgi_routes.router)
             for route in router.routes if route.path=="/playlists/{playlist_ref}/default-sort" and "POST" in route.methods]
    assert len(matches)==1 and matches[0].endpoint is owned_playlists_asgi.playlist_default_sort
