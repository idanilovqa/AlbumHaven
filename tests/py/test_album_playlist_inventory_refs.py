"""Native Album selection identities require explicit same-library provenance."""
from copy import deepcopy

import pytest

from music_app.services import album_details


def payload():
    return {"key":"real-album","name":"Album","album_artist":"Artist","tracks":[
        {"track_id":11,"path":"/synthetic/one.flac","title":"One","duration_seconds":10},
        {"track_id":12,"path":"/synthetic/two.flac","title":"Two","duration_seconds":20}]}


def render(monkeypatch, data, **scope):
    monkeypatch.setattr(album_details,"build_track_preference_overlay_lookup",lambda *a,**k:{})
    monkeypatch.setattr(album_details,"_safe_scrobble_count_lookup",lambda *a,**k:{})
    return album_details._attach_album_detail_track_rows(data, config={},
        **{"account_id":7,"library_id":9,"inventory_library_id":9,**scope})


def test_private_album_rows_and_native_tracks_share_proven_inventory_refs(monkeypatch):
    data=payload(); before=deepcopy(data)
    result=render(monkeypatch,data)
    assert data==before
    refs=["inventory-track:9:11","inventory-track:9:12"]
    assert [row["inventory_track_ref"] for row in result["tracks"]]==refs
    assert [row["inventory_track_ref"] for row in result["track_rows"]]==refs
    assert [row["inventory_track_ref"] for row in result["gallery_list_block"]["track_rows"]]==refs


@pytest.mark.parametrize("scope",[
    {"public_safe":True},{"inventory_library_id":None},{"inventory_library_id":10},
    {"account_id":None},{"library_id":None},{"account_id":True},{"inventory_library_id":True}])
def test_public_unscoped_or_foreign_inventory_cannot_mint_playlist_refs(monkeypatch,scope):
    result=render(monkeypatch,payload(),**scope)
    assert all(row.get("inventory_track_ref") is None for row in result["track_rows"])


@pytest.mark.parametrize("identity",[None,True,0,-1,"11"])
def test_unknown_inventory_id_never_uses_path_or_title_alias(monkeypatch,identity):
    data=payload(); data["tracks"][0]["track_id"]=identity
    result=render(monkeypatch,data)
    assert result["track_rows"][0]["inventory_track_ref"] is None


def test_conflicting_numeric_ids_for_same_native_path_are_not_selection_authority(monkeypatch):
    data=payload(); data["tracks"][1]["path"]=data["tracks"][0]["path"]
    result=render(monkeypatch,data)
    assert all(row["inventory_track_ref"] is None for row in result["track_rows"])
