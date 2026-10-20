"""A later projection owner cannot leave either prior launch family actionable."""
from copy import deepcopy
from dataclasses import replace
import pytest
from music_app.routes import api_read_asgi_routes as routes
from tests.py.test_artist_loved_browse_projection import mounted, io, receipt, GROUP_FIELDS
from tests.py.test_artist_listen_launch_finalizer import listen_mount, transactions, cleared


@pytest.mark.parametrize('boundary', ['top_exit', 'later_preferences', 'later_anonymous'])
def test_final_response_reconciles_both_launch_families_after_context_changes(listen_mount, io, monkeypatch, boundary):
    state = listen_mount
    state.receipts = iter([receipt(state.payload['artist_groups'][0]),
                           receipt(state.payload['artist_page'], 'page')])
    before = deepcopy(state.payload)
    observed = transactions(monkeypatch, state, failure='context' if boundary == 'top_exit' else None)
    preference_calls = []
    if boundary != 'top_exit':
        preference_owner = routes._project_own_album_preferences
        def preferences(request, payload):
            result = preference_owner(request, payload)
            # Both real optional owners have already admitted their exact roots.
            assert payload['artist_loved_context_ref'] is not None
            assert payload['artist_listen_through_context_ref'] is not None
            preference_calls.append(True)
            actor = request.state.current_actor
            request.state.current_actor = None if boundary == 'later_anonymous' else replace(actor, session_id=actor.session_id + 1)
            return result
        monkeypatch.setattr(routes, '_project_own_album_preferences', preferences)
    status, headers, body = state.harness.request('GET', '/view-data')
    assert status == 200 and headers['cache-control'] == 'private, no-store'
    assert len(observed) == 1
    assert preference_calls == ([] if boundary == 'top_exit' else [True])
    cleared(body)
    assert body['artist_loved_context_ref'] is None
    for field in GROUP_FIELDS:
        assert all(group['artist_loved_launch'] is None for group in body[field])
    assert body['artist_page']['artist_loved_launches'] == {'artist': None, 'family': None}
    assert state.payload == before
