from __future__ import annotations

import pytest


def test_allowed_actions_projects_only_allow_results_from_policy_decisions():
    from music_app.services.allowed_actions import AllowedActions, PolicyDecision

    decisions = (
        PolicyDecision("library.stream_private", True, "explicit_grant"),
        PolicyDecision("fs.write_tags", False, "missing_grant"),
        PolicyDecision("system.admin", True, "bootstrap_owner"),
    )

    actions = AllowedActions.from_decisions(decisions)

    assert actions.keys == ("library.stream_private", "system.admin")
    assert actions.allows("system.admin") is True
    assert actions.allows("fs.write_tags") is False
    assert actions.as_payload() == {
        "library.stream_private": True,
        "system.admin": True,
    }


def test_allowed_actions_rejects_duplicate_or_nondecision_authority():
    from music_app.services.allowed_actions import AllowedActions, PolicyDecision

    with pytest.raises(ValueError, match="Allowed actions"):
        AllowedActions.from_decisions(
            (
                PolicyDecision("system.admin", True, "bootstrap_owner"),
                PolicyDecision("system.admin", False, "denied"),
            )
        )
    with pytest.raises(ValueError, match="Allowed actions"):
        AllowedActions.from_decisions(("system.admin",))


@pytest.mark.parametrize(
    "args",
    [
        ("admin", True, "bootstrap_owner"),
        ("system admin", True, "bootstrap_owner"),
        ("system.admin", 1, "bootstrap_owner"),
        ("system.admin", True, "line\nbreak"),
    ],
)
def test_policy_decision_is_strict_and_safe(args):
    from music_app.services.allowed_actions import PolicyDecision

    with pytest.raises(ValueError, match="Policy decision"):
        PolicyDecision(*args)


def test_denial_reason_is_not_exposed_by_allowed_action_payload():
    from music_app.services.allowed_actions import AllowedActions, PolicyDecision

    actions = AllowedActions.from_decisions(
        (PolicyDecision("fs.write_cover", False, "private-operator-reason"),)
    )

    assert actions.as_payload() == {}
    assert "private-operator-reason" not in repr(actions)
