"""Failed-edit notices use the independent log-read projection, not edit authority."""

import pytest

from music_app.services.capability_ui import UI_ACTIONS, build_capability_ui
from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from music_app.services.policy import PolicyContext, RequestOrigin
from music_app.services.policy_evaluator import PolicyEvaluator


@pytest.mark.parametrize("repair", [False, True])
def test_edit_plus_admin_failure_action_requires_independent_log_read(repair):
    keys = ["capability.edit", "capability.admin"] + (["capability.repair"] if repair else [])
    actor = CurrentActor(
        state=ActorState.ACTIVE, account_id=7, session_id=11, current_library_id=23,
        library_relationships=(LibraryRelationship(23, "member", False),),
        capability_grants=tuple(CapabilityGrant(key, "library", 23) for key in keys),
    )
    evaluator = PolicyEvaluator()
    allowed = {}
    for action in UI_ACTIONS:
        decision = evaluator.evaluate(PolicyContext.build(
            actor=actor, action=action, library_id=23, target_account_id=7,
            deployment_mode="self_hosted", request_origin=RequestOrigin("network", "test"),
            client_surface_class="private_web",
        )).decision
        if decision.allowed:
            allowed[action] = True
    value = build_capability_ui(allowed, "private_web")
    assert allowed["library.files.edit_tags"] is True
    assert allowed.get("library.logs.read", False) is repair
    assert ("[data-open-log-history-alert]" in value["denied_selectors"]) is not repair
    assert ("log-history" in value["available_tabs"]) is repair
    assert "[data-dismiss-repair-alert]" not in value["denied_selectors"]
