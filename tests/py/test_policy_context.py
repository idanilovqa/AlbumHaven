from __future__ import annotations

from datetime import datetime, timezone

import pytest

from music_app.services.current_actor import ActorState, CurrentActor


def _actor():
    return CurrentActor(
        state=ActorState.ACTIVE,
        account_id=41,
        session_id=8,
        username_display="Rendref",
        display_name="Rendref",
        authenticated_at=datetime(2026, 8, 31, tzinfo=timezone.utc),
        is_bootstrap_owner=True,
    )


def test_policy_context_carries_actor_action_scopes_and_request_constraints():
    from music_app.services.policy import PolicyContext, RequestOrigin, ResourceScope

    context = PolicyContext.build(
        actor=_actor(),
        action="library.stream_private",
        resource=ResourceScope("album", "album:73:901"),
        target_account_id=52,
        library_id=73,
        deployment_mode="self_hosted",
        request_origin=RequestOrigin("network", "hmac:v7:abc"),
        client_surface_class="private_web",
    )

    assert context.actor.account_id == 41
    assert context.action == "library.stream_private"
    assert context.resource == ResourceScope("album", "album:73:901")
    assert context.target_account_id == 52
    assert context.library_id == 73
    assert context.deployment_mode == "self_hosted"
    assert context.request_origin.origin_type == "network"
    assert context.client_surface_class == "private_web"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("action", "system admin"),
        ("action", "admin"),
        ("deployment_mode", ""),
        ("deployment_mode", "hosted/public"),
        ("client_surface_class", "browser_claimed_admin"),
        ("target_account_id", 0),
        ("library_id", True),
    ],
)
def test_policy_context_rejects_malformed_or_unrecognized_authority_inputs(
    field, value
):
    from music_app.services.policy import PolicyContext, RequestOrigin

    values = {
        "actor": _actor(),
        "action": "system.admin",
        "deployment_mode": "self_hosted",
        "request_origin": RequestOrigin("network", "hmac:v7:abc"),
        "client_surface_class": "private_web",
    }
    values[field] = value

    with pytest.raises(ValueError, match="Policy context"):
        PolicyContext.build(**values)


@pytest.mark.parametrize(
    "args",
    [
        ("raw/path", "album:1"),
        ("album", "C:\\private\\music.flac"),
        ("album", "line\nbreak"),
        ("", "album:1"),
    ],
)
def test_resource_scope_requires_safe_stable_non_path_reference(args):
    from music_app.services.policy import ResourceScope

    with pytest.raises(ValueError, match="Policy resource"):
        ResourceScope(*args)


def test_request_origin_repr_redacts_privacy_minimized_key():
    from music_app.services.policy import RequestOrigin

    origin = RequestOrigin("network", "hmac:v7:private-origin-key")

    assert "private-origin-key" not in repr(origin)
    assert "redacted" in repr(origin).casefold()
