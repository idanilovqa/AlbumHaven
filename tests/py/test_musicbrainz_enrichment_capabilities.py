from __future__ import annotations

from dataclasses import replace

import pytest

from music_app.services.capabilities import capability_keys_for_roles
from music_app.services.current_actor import (
    ActorState,
    CapabilityGrant,
    CurrentActor,
    LibraryRelationship,
)
from music_app.services.policy import PolicyContext, RequestOrigin
from music_app.services.policy_evaluator import PolicyEvaluator


MUSICBRAINZ_ACTIONS = (
    "library.problems.read",
    "catalogue.enrichment.request",
    "library.metadata_matches.review",
)
MUSICBRAINZ_MUTATIONS = (
    "catalogue.enrichment.request",
    "library.metadata_matches.review",
)


def actor_for(role, *, library_id=23):
    is_owner = role == "owner"
    return CurrentActor(
        state=ActorState.ACTIVE,
        account_id=7,
        session_id=11,
        current_library_id=library_id,
        library_relationships=(
            LibraryRelationship(
                library_id,
                "owner" if is_owner else "administrator" if role == "admin" else "member",
                is_owner,
            ),
        ),
        capability_grants=tuple(
            CapabilityGrant(key, "library", library_id)
            for key in capability_keys_for_roles([role])
        ),
    )


def allowed(actor, action, *, library_id=23):
    context = PolicyContext.build(
        actor=actor,
        action=action,
        library_id=library_id,
        deployment_mode="self_hosted",
        request_origin=RequestOrigin("network", "test"),
        client_surface_class="private_web",
    )
    return PolicyEvaluator().evaluate(context).decision.allowed


@pytest.mark.parametrize("action", MUSICBRAINZ_ACTIONS)
def test_library_owner_preset_receives_exact_musicbrainz_management_authority(action):
    assert allowed(actor_for("owner"), action)


@pytest.mark.parametrize("role", ["admin", "viewer", "listener", "musician"])
@pytest.mark.parametrize("action", MUSICBRAINZ_ACTIONS)
def test_every_non_owner_preset_receives_no_musicbrainz_management_authority(
    role,
    action,
):
    assert not allowed(actor_for(role), action)


def test_generic_repair_grant_keeps_ordinary_problem_read_without_musicbrainz_mutation():
    actor = replace(
        actor_for("viewer"),
        capability_grants=(CapabilityGrant("capability.repair", "library", 23),),
    )

    assert allowed(actor, "library.problems.read")
    assert not allowed(actor, "catalogue.enrichment.request")
    assert not allowed(actor, "library.metadata_matches.review")


@pytest.mark.parametrize("action", MUSICBRAINZ_MUTATIONS)
def test_direct_musicbrainz_grants_cannot_bypass_library_ownership(action):
    non_owner = replace(
        actor_for("viewer"),
        capability_grants=(CapabilityGrant(action, "library", 23),),
    )
    owner = replace(
        actor_for("owner"),
        capability_grants=(CapabilityGrant(action, "library", 23),),
    )

    assert not allowed(non_owner, action, library_id=23)
    assert allowed(owner, action, library_id=23)
    assert not allowed(owner, action, library_id=24)


def test_musicbrainz_mutations_do_not_broaden_existing_file_repair_authority():
    owner = actor_for("owner")
    admin = actor_for("admin")

    assert allowed(owner, "library.files.repair")
    assert not allowed(admin, "library.files.repair")
    assert "catalogue.enrichment.request" not in capability_keys_for_roles(
        ["listener"]
    )
    assert "library.metadata_matches.review" not in capability_keys_for_roles(
        ["listener"]
    )
    assert set(MUSICBRAINZ_ACTIONS).isdisjoint(capability_keys_for_roles(["admin"]))


@pytest.mark.parametrize("role", ["owner", "admin", "viewer", "listener", "musician"])
def test_connected_roles_keep_ordinary_catalog_visibility_for_accepted_metadata(role):
    actor = actor_for(role)

    assert allowed(actor, "library.browse.read")
