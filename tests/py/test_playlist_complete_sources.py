"""Strict complete-source protocol contracts; no database needed."""
from uuid import uuid4

import pytest

from music_app.services.owned_playlists import COMPLETE_INVENTORY_PROTOCOL, PlaylistError, normalize_playlist_command
from music_app.services.playlist_complete_sources import inventory_selection_refs


def test_inventory_selection_preserves_explicit_authored_order():
    assert inventory_selection_refs(["inventory-track:7:11","inventory-track:7:9"],7)==[11,9]


@pytest.mark.parametrize("refs",[None,[],"inventory-track:7:9",["/private/path"],["title"],
    ["inventory-track:7:0"],["inventory-track:7:09"],[True]])
def test_selection_requires_bounded_strict_inventory_identity(refs):
    with pytest.raises(PlaylistError):inventory_selection_refs(refs,7)


def test_foreign_inventory_and_duplicate_occurrence_reject_whole_selection():
    with pytest.raises(PlaylistError,match="source_unavailable"):
        inventory_selection_refs(["inventory-track:7:11","inventory-track:8:9"],7)
    with pytest.raises(PlaylistError,match="duplicate_identity"):
        inventory_selection_refs(["inventory-track:7:11"]*2,7)


def test_complete_protocol_is_explicit_and_cannot_change_source_kind():
    source={"kind":"library","ref":str(uuid4()),"revision":str(uuid4())}
    body={"mode":"ordinary","source_protocol":COMPLETE_INVENTORY_PROTOCOL,"source":source,
          "title":"Selected","entry_refs":[],"request_key":str(uuid4())}
    result=normalize_playlist_command("create",body)
    assert result.data["source_protocol"]==COMPLETE_INVENTORY_PROTOCOL
    source["kind"]="activity"
    with pytest.raises(PlaylistError):normalize_playlist_command("create",body)


def test_denied_parent_projection_does_not_expose_album_identity_or_grant():
    from music_app.services.playlist_creation_sources_postgres import project_entry
    row={"ref":str(uuid4()),"selection_ref":str(uuid4()),"original_local_track_id":11,
         "original_album_id":27,"title":"Track","album_title":"Original album","release_year":2001}
    result=project_entry({"library_id":7},row,album_readable=lambda _id:False)
    assert result["parent_album"]["album_ref"] is None
    assert result["parent_album"]["allowed_actions"]["can_read"] is False
    assert result["parent_album"]["title"] is None
    assert result["album_title"]=="Original album"
