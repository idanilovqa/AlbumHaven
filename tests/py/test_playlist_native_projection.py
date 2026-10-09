"""Native targets are separately authorized eligibility, never media URLs."""
from tests.py.test_playlist_collaboration import context,BROWSE,P
from music_app.services.owned_playlists_postgres import PostgresOwnedPlaylistsService
from music_app.services.policy_evaluator import PolicyEvaluationConstraints


def row():
    return {"ref":P,"position":1,"title":"Original","artist":"Artist","album_title":"Album",
            "disc_number":1,"track_number":1,"duration_seconds":100,"release_year":2000,
            "local_track_id":66,"source_ref":None}


def test_browse_only_shared_reader_has_album_details_without_playback():
    projected=PostgresOwnedPlaylistsService._track_row(context(grants=(BROWSE,)),row(),
        {"availability":"local","original_album_id":77})
    assert projected["allowed_actions"]=={"can_read":True,"can_play":False,"can_view_details":True}
    assert projected["album_ref"]=="inventory-album:33:77"
    assert "path" not in projected and "track_ref" not in projected


def test_explicit_media_grant_is_required_and_narrowed_per_track():
    ctx=context(grants=(BROWSE,"library.media.read"))
    current={"availability":"local","original_album_id":77}
    assert PostgresOwnedPlaylistsService._track_row(ctx,row(),current)["allowed_actions"]["can_play"] is True
    def denied(context):
        return PolicyEvaluationConstraints(deployment_allowed=context.action!="library.media.read")
    assert PostgresOwnedPlaylistsService._track_row(ctx,row(),current,constraints=denied)["allowed_actions"]["can_play"] is False


def test_album_constraint_hides_target_without_destroying_saved_originals():
    def denied(context):
        return PolicyEvaluationConstraints(request_origin_allowed=context.resource.resource_kind!="album")
    projected=PostgresOwnedPlaylistsService._track_row(context(),row(),{"availability":"local","original_album_id":77},constraints=denied)
    assert projected["album_title"]=="Album"
    assert projected["album_ref"] is None and projected["allowed_actions"]["can_view_details"] is False


def test_unresolved_current_and_orphaned_rows_do_not_gain_playback():
    ctx=context(grants=(BROWSE,"library.media.read"))
    for current in (None,{"availability":"unresolved","original_album_id":None}):
        projected=PostgresOwnedPlaylistsService._track_row(ctx,row(),current)
        assert projected["allowed_actions"]["can_play"] is False
        assert projected["allowed_actions"]["can_view_details"] is False
