"""The existing Appearance route derives loop-style authority from policy."""

import pytest

from music_app.services.appearance_preferences_postgres import AppearanceLoopStyleForbidden
from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from tests.py.asgi_testing import decode_json
from tests.py.test_account_appearance_asgi import AGGREGATE_APPEARANCE, _app, _request
from tests.py.test_settings_loop_style_preferences import aggregate_write


@pytest.mark.parametrize("granted,member,expected", [(True, True, True), (False, True, False), (True, False, False)])
def test_route_passes_effective_capability_to_atomic_repository(granted, member, expected):
    actor = CurrentActor(
        state=ActorState.ACTIVE, account_id=41, session_id=11, current_library_id=17,
        library_relationships=(LibraryRelationship(17, "member", False),) if member else (),
        capability_grants=(CapabilityGrant("library.loops.create", "library", 17),) if granted else (),
    )
    app, repository, _ = _app(actor=actor)
    captured = []

    def save_preferences(*, account_id, preferences, expected_revision, client_profile,
                         allow_loop_control_style=False):
        captured.append((account_id, client_profile, expected_revision, allow_loop_control_style))
        return {**AGGREGATE_APPEARANCE, "revision": 8, "loop_control_style": "companion"}

    repository.save_preferences = save_preferences
    status, _, _ = _request(app, "PUT", {**aggregate_write(loop_control_style="companion"), "expected_revision": 7})
    assert status == 200
    assert captured == [(41, "desktop", 7, expected)]


def test_atomic_denial_has_explicit_403_without_private_repository_error_details():
    app, repository, _ = _app()

    def denied(**kwargs):
        raise AppearanceLoopStyleForbidden("private implementation diagnostic")

    repository.save_preferences = denied
    status, _, body = _request(app, "PUT", {**aggregate_write(loop_control_style="companion"), "expected_revision": 7})
    assert status == 403
    assert decode_json(body)["error"] == "loop_style_forbidden"
    assert "private implementation" not in body.decode()


def test_style_cannot_bypass_revision_contract_through_legacy_write():
    app, repository, _ = _app()
    status, _, _ = _request(app, "PUT", {
        "main_surface_color": None, "panel_background_color": None,
        "loop_control_style": "companion",
    })
    assert status == 400
    assert repository.writes == []
