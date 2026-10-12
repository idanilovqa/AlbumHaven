"""Complete explicit source order, replay and atomicity against real PostgreSQL."""
from uuid import uuid4

import pytest

from tests.py.test_owned_playlist_postgres_integration import db, urls
from music_app.services.owned_playlists import COMPLETE_INVENTORY_PROTOCOL, PlaylistError, normalize_playlist_command
from music_app.services.playlist_complete_sources import CompletePlaylistSources
from music_app.services.policy_evaluator import PolicyEvaluationConstraints


def capture(db,ids=None,**kwargs):
    service=CompletePlaylistSources(playlists=db.service)
    refs=[f"inventory-track:{db.library}:{identity}" for identity in (ids or db.tracks)]
    return service,service.from_inventory(db.context(),refs,**kwargs)["data"]


def command(data):
    return normalize_playlist_command("create",{"mode":"ordinary","source_protocol":data["source_protocol"],
        "source":data["source"],"title":"Selection","entry_refs":[row["entry_ref"] for row in data["entries"]],
        "request_key":str(uuid4())})


def test_complete_selected_source_preserves_order_on_reread_and_save(db):
    service,data=capture(db,list(reversed(db.tracks)))
    assert data["source_protocol"]==COMPLETE_INVENTORY_PROTOCOL and data["entries_complete"] is True
    assert [row["title"] for row in data["entries"]]==["Track 2","Track 1","Track 0"]
    fresh=service.read(db.context(),ref=data["source"]["ref"],revision=data["source"]["revision"])["data"]
    assert fresh["entries"]==data["entries"]
    receipt=db.service.execute(db.context(),command(data))
    saved=db.service.read(db.context(),playlist_ref=receipt["playlist_id"])["playlist_detail"]
    assert [row["title"] for row in saved["track_rows"]]==["Track 2","Track 1","Track 0"]


def test_complete_source_cannot_be_reinterpreted_as_paged_catalogue(db):
    _,data=capture(db)
    with pytest.raises(PlaylistError,match="source_changed"):
        db.service.read_source_page(db.context(),source_ref=data["source"]["ref"],source_revision=data["source"]["revision"])
    cmd=command(data);cmd.data["source_protocol"]="library_selection_v1"
    with pytest.raises(PlaylistError,match="source_changed"):
        db.service.execute(db.context(),cmd)
    assert db.count("playlists")==0


def test_changed_selected_fact_retires_complete_read_and_create(db):
    service,data=capture(db)
    with db.connect() as con:
        con.execute("update library.local_tracks set title='New title' where id=%s",(db.tracks[1],))
    with pytest.raises(PlaylistError,match="source_changed"):
        service.read(db.context(),ref=data["source"]["ref"],revision=data["source"]["revision"])
    with pytest.raises(PlaylistError,match="source_changed"):
        db.service.execute(db.context(),command(data))
    assert db.count("playlists")==db.count("playlist_operations")==0


def test_one_denied_track_prevents_all_source_capture(db):
    def constraints(ctx):
        denied=ctx.resource is not None and ctx.resource.resource_kind=="track" and ctx.resource.resource_ref==str(db.tracks[1])
        return PolicyEvaluationConstraints(request_origin_allowed=not denied)
    with pytest.raises(PlaylistError,match="source_unavailable"):
        capture(db,constraints=constraints)
    with db.connect() as con:
        assert con.execute("select count(*) as n from app.playlist_creation_sources where library_id=%s",(db.library,)).fetchone()["n"]==0


def test_unresolved_local_availability_is_retained_but_never_called_missing(db):
    with db.connect() as con:
        con.execute("update library.library_roots set is_active=false where library_id=%s",(db.library,))
    _,data=capture(db)
    assert all(row["availability"]=="unresolved" for row in data["entries"])
    receipt=db.service.execute(db.context(),command(data))
    detail=db.service.read(db.context(),playlist_ref=receipt["playlist_id"])["playlist_detail"]
    assert len(detail["track_rows"])==3 and all(row["availability"]=="unresolved" for row in detail["track_rows"])


def test_album_resource_denial_narrows_complete_and_paged_parent_projection(db):
    def constraints(ctx):
        denied=ctx.resource is not None and ctx.resource.resource_kind=="album"
        return PolicyEvaluationConstraints(request_origin_allowed=not denied)
    _,data=capture(db,constraints=constraints)
    assert all(row["parent_album"]["album_ref"] is None for row in data["entries"])
    source=db.service.begin_source(db.context(),constraints=constraints)["data"]["source"]
    page=db.service.read_source_page(db.context(),source_ref=source["ref"],source_revision=source["revision"],constraints=constraints)["data"]
    assert len(page["entries"])==3
    assert all(row["parent_album"]["allowed_actions"]["can_read"] is False for row in page["entries"])
