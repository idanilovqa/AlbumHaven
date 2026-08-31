from datetime import datetime, timezone

import pytest

from music_app.services.current_actor import (
    ActorState,
    CapabilityGrant,
    CurrentActor,
    LibraryRelationship,
)
from music_app.services.policy import PolicyContext, RequestOrigin
from music_app.services.policy_evaluator import (
    PolicyEvaluationConstraints,
    PolicyEvaluator,
)


def _actor(*, bootstrap=False, grants=(), state=ActorState.ACTIVE):
    return CurrentActor(
        state=state,
        account_id=7 if state is not ActorState.ANONYMOUS else None,
        session_id=11 if state is not ActorState.ANONYMOUS else None,
        username_display="Rendref" if state is not ActorState.ANONYMOUS else None,
        authenticated_at=datetime(2026, 8, 31, tzinfo=timezone.utc)
        if state is not ActorState.ANONYMOUS
        else None,
        is_bootstrap_owner=bootstrap,
        library_relationships=(LibraryRelationship(23, "member", bootstrap),)
        if state is ActorState.ACTIVE
        else (),
        capability_grants=tuple(grants),
    )


def _context(actor, action="library.read", *, library_id=23):
    return PolicyContext.build(
        actor=actor,
        action=action,
        library_id=library_id,
        deployment_mode="self_hosted",
        request_origin=RequestOrigin("network", "privacy-key"),
        client_surface_class="private_web",
    )


@pytest.mark.parametrize(
    ("actor", "reason"),
    [
        (CurrentActor.anonymous(), "authentication_required"),
        (_actor(state=ActorState.INACTIVE), "actor_inactive"),
    ],
)
def test_anonymous_and_inactive_actors_fail_closed(actor, reason):
    result = PolicyEvaluator().evaluate(_context(actor))

    assert result.decision.allowed is False
    assert result.decision.reason_code == reason
    assert result.audit.actor_class == actor.state.value


def test_bootstrap_owner_receives_explicit_allow_and_audit_reason():
    result = PolicyEvaluator().evaluate(_context(_actor(bootstrap=True), "system.admin"))

    assert result.decision.allowed is True
    assert result.decision.reason_code == "bootstrap_owner"
    assert result.audit.reason_code == "bootstrap_owner"
    assert result.audit.bootstrap_owner is True


def test_system_admin_is_never_available_as_an_ordinary_grant():
    actor = _actor(grants=(CapabilityGrant("system.admin", "global", None),))

    result = PolicyEvaluator().evaluate(_context(actor, "system.admin"))

    assert result.decision.allowed is False
    assert result.decision.reason_code == "bootstrap_only"


@pytest.mark.parametrize(
    ("grant", "library_id", "allowed"),
    [
        (CapabilityGrant("library.read", "global", None), 99, True),
        (CapabilityGrant("library.read", "library", 23), 23, True),
        (CapabilityGrant("library.read", "library", 24), 23, False),
        (CapabilityGrant("library.write", "library", 23), 23, False),
    ],
)
def test_explicit_grants_require_matching_action_and_scope(grant, library_id, allowed):
    result = PolicyEvaluator().evaluate(
        _context(_actor(grants=(grant,)), library_id=library_id)
    )

    assert result.decision.allowed is allowed


@pytest.mark.parametrize(
    ("field", "reason"),
    [
        ("deployment_allowed", "deployment_denied"),
        ("client_surface_allowed", "client_surface_denied"),
        ("request_origin_allowed", "request_origin_denied"),
    ],
)
def test_constraints_can_only_narrow_existing_authority(field, reason):
    constraints = PolicyEvaluationConstraints(**{field: False})
    actor = _actor(grants=(CapabilityGrant("library.read", "global", None),))

    result = PolicyEvaluator().evaluate(_context(actor), constraints=constraints)

    assert result.decision.allowed is False
    assert result.decision.reason_code == reason


def test_constraints_never_create_authority_and_audit_redacts_origin_key():
    result = PolicyEvaluator().evaluate(
        _context(_actor()), constraints=PolicyEvaluationConstraints()
    )

    assert result.decision.allowed is False
    assert result.decision.reason_code == "capability_required"
    assert result.audit.client_surface_class == "private_web"
    assert result.audit.request_origin_type == "network"
    assert "privacy-key" not in repr(result.audit)
    assert "privacy-key" not in repr(result)


@pytest.mark.parametrize(
    "kwargs",
    [
        {"deployment_allowed": 1},
        {"client_surface_allowed": None},
        {"request_origin_allowed": "yes"},
    ],
)
def test_constraint_contract_rejects_non_boolean_values(kwargs):
    with pytest.raises(ValueError, match="constraints"):
        PolicyEvaluationConstraints(**kwargs)
