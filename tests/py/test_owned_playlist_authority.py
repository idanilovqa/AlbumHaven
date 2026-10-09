"""Policy/ownership intersection, independently authored with synthetic actors.

These pure tests prove decision behavior only. Final locked-session revalidation
and revocation serialization are separate real-Postgres evidence gates.
"""
from dataclasses import replace
from datetime import datetime, timezone

import pytest

from music_app.services import owned_playlists as playlists
from music_app.services.current_actor import (
    ActorState, CapabilityGrant, CurrentActor, LibraryRelationship,
)
from music_app.services.policy import PolicyContext, RequestOrigin, ResourceScope
from music_app.services.policy_evaluator import PolicyEvaluationConstraints, PolicyEvaluator


ACCOUNT = 41
SESSION = 8
LIBRARY = 73
OTHER_ACCOUNT = 42
OTHER_LIBRARY = 74
BROWSE = "library.browse.read"
CREATE = "library.playlists.create"
MANAGE = "library.playlists.manage"
ITEMS = "library.playlists.items.manage"
ALL_ACTIONS = (BROWSE, CREATE, MANAGE, ITEMS)
NOW = datetime(2026, 10, 8, 22, 0, tzinfo=timezone.utc)
PLAYLIST = "20000000-0000-4000-8000-000000000001"


def actor(*, grants=ALL_ACTIONS, bootstrap=False, role="member", **overrides):
    value = CurrentActor(
        state=ActorState.ACTIVE, account_id=ACCOUNT, session_id=SESSION,
        username_display="Synthetic member", display_name="Synthetic member",
        authenticated_at=NOW, current_library_id=LIBRARY,
        is_bootstrap_owner=bootstrap,
        library_relationships=(LibraryRelationship(LIBRARY, role, False),),
        capability_grants=tuple(CapabilityGrant(action, "library", LIBRARY) for action in grants),
    )
    return replace(value, **overrides)


def context(value=None, **overrides):
    values = dict(
        actor=actor() if value is None else value,
        action=MANAGE, resource=ResourceScope("playlist", PLAYLIST),
        library_id=LIBRARY, deployment_mode="self_hosted",
        request_origin=RequestOrigin("network", "hmac:test:synthetic-origin"),
        client_surface_class="private_web",
    )
    values.update(overrides)
    return PolicyContext.build(**values)


def require(value=None, *, actions=(BROWSE, MANAGE), owner=ACCOUNT, constraints=None):
    return playlists.require_owned_playlist_authority(
        context() if value is None else value, required_actions=actions,
        owner_account_id=owner, constraints=constraints,
    )


def forbidden(value, *, actions=(BROWSE, MANAGE), owner=ACCOUNT, constraints=None):
    with pytest.raises(playlists.PlaylistError) as error:
        require(value, actions=actions, owner=owner, constraints=constraints)
    assert (error.value.code, error.value.status_code) == ("forbidden", 403)


@pytest.mark.parametrize("required_actions", [
    (BROWSE,), (BROWSE, CREATE), (BROWSE, MANAGE), (BROWSE, ITEMS),
    (BROWSE, MANAGE, ITEMS),
])
def test_member_with_exact_grants_can_act_only_on_owned_playlist(required_actions):
    assert require(actions=required_actions) is None


def test_create_has_no_existing_owner_but_still_requires_current_membership_and_grants():
    assert require(context(action=CREATE, resource=None), actions=(BROWSE, CREATE), owner=None) is None


@pytest.mark.parametrize("bootstrap,grants", [
    (False, ALL_ACTIONS),
    (False, (*ALL_ACTIONS, "capability.admin")),
    (True, ()),
])
def test_even_bootstrap_or_admin_cannot_read_or_change_another_accounts_playlist(bootstrap, grants):
    forbidden(context(actor(bootstrap=bootstrap, grants=grants)), owner=OTHER_ACCOUNT)


@pytest.mark.parametrize("bootstrap", [False, True])
@pytest.mark.parametrize("relationships", [(), (LibraryRelationship(OTHER_LIBRARY, "owner", True),)])
def test_bootstrap_and_role_labels_never_bypass_actual_current_library_membership(bootstrap, relationships):
    forbidden(context(actor(bootstrap=bootstrap, library_relationships=relationships)))


@pytest.mark.parametrize("current_library_id", [None, OTHER_LIBRARY, 0, True])
def test_request_library_must_equal_trusted_current_library(current_library_id):
    forbidden(context(actor(current_library_id=current_library_id)))


@pytest.mark.parametrize("state", [ActorState.ANONYMOUS, ActorState.INACTIVE])
def test_inactive_or_anonymous_actor_cannot_use_retained_grants(state):
    forbidden(context(actor(state=state)))


@pytest.mark.parametrize("field,value", [
    ("account_id", None), ("account_id", 0), ("account_id", True),
    ("session_id", None), ("session_id", 0), ("session_id", True),
])
def test_active_label_without_valid_account_and_session_fails_closed(field, value):
    forbidden(context(actor(**{field: value})))


@pytest.mark.parametrize("membership_role", ["owner", "admin", "editor", "listener"])
def test_membership_role_name_does_not_expand_explicit_playlist_grants(membership_role):
    forbidden(context(actor(grants=(BROWSE,), role=membership_role)))


def test_capability_admin_does_not_imply_playlist_manage():
    forbidden(context(actor(grants=(BROWSE, "capability.admin"))))


@pytest.mark.parametrize("missing", [BROWSE, CREATE])
def test_create_requires_browse_and_create_independently(missing):
    grants = tuple(action for action in ALL_ACTIONS if action != missing)
    forbidden(context(actor(grants=grants), action=CREATE, resource=None),
              actions=(BROWSE, CREATE), owner=None)


@pytest.mark.parametrize("missing", [BROWSE, MANAGE, ITEMS])
def test_changed_metadata_and_order_need_intersection_of_all_required_grants(missing):
    grants = tuple(action for action in ALL_ACTIONS if action != missing)
    forbidden(context(actor(grants=grants)), actions=(BROWSE, MANAGE, ITEMS))


@pytest.mark.parametrize("required", [CREATE, MANAGE, ITEMS])
def test_fine_grants_from_another_library_do_not_authorize_current_library(required):
    grants = (
        CapabilityGrant(BROWSE, "library", LIBRARY),
        CapabilityGrant(required, "library", OTHER_LIBRARY),
    )
    value = actor(capability_grants=grants)
    forbidden(context(value, action=required), actions=(BROWSE, required))


def test_existing_global_grant_semantics_remain_authoritative():
    value = actor(capability_grants=(
        CapabilityGrant(BROWSE, "global", None), CapabilityGrant(MANAGE, "global", None),
    ))
    assert require(context(value)) is None


def test_existing_bootstrap_grant_semantics_apply_only_after_membership_and_owner_checks():
    assert require(context(actor(bootstrap=True, grants=()))) is None


@pytest.mark.parametrize("denied_constraint", ["deployment_allowed", "client_surface_allowed", "request_origin_allowed"])
@pytest.mark.parametrize("bootstrap", [False, True])
def test_original_narrowing_constraints_survive_owner_authority_checks(denied_constraint, bootstrap):
    constraints = PolicyEvaluationConstraints(**{denied_constraint: False})
    forbidden(context(actor(bootstrap=bootstrap)), constraints=constraints)


def test_missing_browse_is_not_masked_by_all_write_grants():
    forbidden(context(actor(grants=(CREATE, MANAGE, ITEMS))))


def test_policy_rechecks_every_action_without_rebuilding_a_broader_request_context(monkeypatch):
    captured = []
    original_evaluate = PolicyEvaluator.evaluate

    def record(self, requested, *, constraints=None):
        captured.append((requested, constraints))
        return original_evaluate(self, requested, constraints=constraints)

    monkeypatch.setattr(PolicyEvaluator, "evaluate", record)
    original = context(target_account_id=ACCOUNT)
    constraints = PolicyEvaluationConstraints()
    require(original, actions=(BROWSE, MANAGE, ITEMS), constraints=constraints)

    assert {requested.action for requested, _ in captured} == {BROWSE, MANAGE, ITEMS}
    assert len(captured) == 3
    for requested, observed_constraints in captured:
        assert requested.actor is original.actor
        assert requested.library_id == original.library_id
        assert requested.resource == original.resource
        assert requested.target_account_id == original.target_account_id
        assert requested.deployment_mode == original.deployment_mode
        assert requested.client_surface_class == original.client_surface_class
        assert requested.request_origin is original.request_origin
        assert observed_constraints is constraints


@pytest.mark.parametrize("requested_library", [None, OTHER_LIBRARY])
def test_context_cannot_omit_or_substitute_the_current_library(requested_library):
    forbidden(context(library_id=requested_library))


@pytest.mark.parametrize("actions", [(), ("system.admin",), (BROWSE, "library.playlists.access.manage"), (BROWSE, "library.media.read")])
def test_authority_cannot_be_bypassed_with_empty_or_unrelated_action_set(actions):
    forbidden(context(actor(bootstrap=True)), actions=actions)


@pytest.mark.parametrize("write_action", [MANAGE, ITEMS])
@pytest.mark.parametrize("owner", [None, 0, True, "41"])
def test_existing_playlist_mutation_needs_a_valid_fetched_owner(write_action, owner):
    forbidden(context(actor(bootstrap=True), action=write_action),
              actions=(BROWSE, write_action), owner=owner)


def test_browse_of_directory_or_creation_source_needs_no_collection_owner():
    assert require(context(action=BROWSE, resource=None), actions=(BROWSE,), owner=None) is None


@pytest.mark.parametrize("actions", [(CREATE,), (MANAGE,), (ITEMS,), (MANAGE, ITEMS)])
def test_every_playlist_action_set_includes_independent_browse_authority(actions):
    forbidden(context(actor(bootstrap=True)), actions=actions)


def test_concrete_playlist_read_cannot_omit_its_fetched_owner():
    forbidden(context(actor(bootstrap=True), action=BROWSE), actions=(BROWSE,), owner=None)
