"""Viewer commands preserve strict revision and original-request identity."""
from uuid import uuid4
import pytest
from music_app.services.owned_playlists import (
    BROWSE, CREATE, ACCESS, PlaylistError, normalize_playlist_command, command_actions,
)

@pytest.mark.parametrize('action,fields,actions', [
    ('request_edit', {}, (BROWSE,)),
    ('copy', {'title': 'My copy'}, (BROWSE, CREATE)),
    ('decide_edit_request', {'request_ref': str(uuid4()), 'decision': 'approve'}, (BROWSE, ACCESS)),
])
def test_viewer_actions_require_exact_revision_and_request(action, fields, actions):
    ref, key = str(uuid4()), str(uuid4())
    command = normalize_playlist_command(action, {'revision': '1', 'request_key': key, **fields}, playlist_ref=ref)
    assert command_actions(command) == actions
    assert command.playlist_ref == ref and command.request_key == key
    for bad in ({'revision': 1}, {'unexpected': True}, {'request_key': 'invalid'}):
        with pytest.raises(PlaylistError, match='invalid_command'):
            normalize_playlist_command(action, {'revision': '1', 'request_key': key, **fields, **bad}, playlist_ref=ref)

@pytest.mark.parametrize('decision', ['editor', 'delete', None, True])
def test_decision_is_explicit_allowlisted_choice(decision):
    with pytest.raises(PlaylistError, match='invalid_command'):
        normalize_playlist_command('decide_edit_request', {'revision': '1', 'request_key': str(uuid4()),
            'request_ref': str(uuid4()), 'decision': decision}, playlist_ref=str(uuid4()))
