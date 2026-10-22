"""Shared member projection retains each collection's existing policy context."""
from types import SimpleNamespace

import pytest

from music_app.services import album_top_viewer_actions as tops, playlist_viewer_actions as playlists
from music_app.services.current_actor import ActorState
from music_app.services.owned_album_tops import AlbumTopError
from music_app.services.owned_playlists import PlaylistError
from tests.py.test_owned_album_tops import _context, BROWSE


class Connection:
    def __init__(self, row):
        self.row = row
        self.calls = []

    def execute(self, sql, params):
        self.calls.append((sql, params))
        return SimpleNamespace(fetchone=lambda: self.row, fetchall=lambda: [
            {"capability_key": "capability.view", "scope_kind": "library", "scope_id": 7},
        ])


@pytest.mark.parametrize("locked", [False, True])
def test_shared_projection_keeps_playlist_target_semantics_and_top_self_target_rebinding(locked):
    original = _context(BROWSE)
    row = {"is_active": True, "disabled_at": None, "membership_role": "member",
           "is_primary_owner": False, "is_bootstrap_owner": False}
    connections = [Connection(row), Connection(row)]
    playlist = playlists.requester_context(connections[0], original, 73, lock=locked)
    top = tops.member_context(connections[1], original, 73, lock=locked)
    assert playlist.target_account_id == original.target_account_id == 41
    assert top.target_account_id == 73
    assert playlist.actor == top.actor
    assert top.actor.account_id == 73 and top.actor.state == ActorState.ACTIVE
    assert top.actor.session_id == original.actor.session_id
    assert top.library_id == original.library_id == top.actor.current_library_id == 7
    assert [grant.capability_key for grant in top.actor.capability_grants] == ["capability.view"]
    assert original.actor.account_id == 41
    assert connections[0].calls == connections[1].calls
    assert all(("for share" in sql) is locked for sql, _ in connections[0].calls)


@pytest.mark.parametrize("row", [None,
    {"is_active": False, "disabled_at": None}, {"is_active": True, "disabled_at": "disabled"},
])
def test_unavailable_member_preserves_collection_specific_error_and_stops_before_grants(row):
    for project, error, message in ((playlists.requester_context, PlaylistError, "request_unavailable"),
                                   (tops.member_context, AlbumTopError, "grant_target_unavailable")):
        connection = Connection(row)
        with pytest.raises(error, match=message):
            project(connection, _context(BROWSE), 73)
        assert len(connection.calls) == 1
