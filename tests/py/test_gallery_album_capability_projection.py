from types import SimpleNamespace

import pytest

from music_app.routes import api_read_asgi_routes as reads
from music_app.services.allowed_actions import AllowedActions
from music_app.services.library_browse_postgres import _root_album_browse_album_payloads


@pytest.mark.parametrize("granted", [False, True])
@pytest.mark.parametrize("preview_only", [False, True])
def test_gallery_summary_projects_request_edit_permission(monkeypatch, granted, preview_only):
    action = "library.files.edit_tags"
    request = SimpleNamespace()
    monkeypatch.setattr(
        reads, "allowed_actions_for_request",
        lambda current_request, actions: AllowedActions((action,) if granted else ()),
    )
    albums = _root_album_browse_album_payloads([
        {"album_id": 1, "album_key": "Artist::Album", "album_title": "Album",
         "artist_name": "Artist", "track_count": 1},
    ], "Artist")
    assert len(albums) == 1
    albums[0]["preview_only"] = preview_only
    assert "suggested_edits" not in albums[0]
    payload = {"artist_groups": [{"artist": "Artist", "albums": albums}]}

    reads._project_missing_album_actions_for_request(request, payload)

    assert "allowed_actions" in albums[0]
    assert albums[0]["allowed_actions"].get(action, False) is granted
    assert "allowed_actions" not in payload["artist_groups"][0]
