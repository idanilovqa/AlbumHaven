"""Viewer-level personal collection rights retain separate media and file gates."""
from dataclasses import replace

import pytest

from music_app.services.capabilities import PERSONAL_COLLECTION_ACTIONS, capability_keys_for_roles
from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from music_app.services.policy import PolicyContext, RequestOrigin
from music_app.services.policy_evaluator import PolicyEvaluator


COLLECTION_ACTIONS = (
    "library.playlists.create", "library.playlists.manage", "library.playlists.items.manage",
    "library.playlists.cover.manage", "library.playlists.settings.manage", "library.playlists.access.manage",
    "library.album_tops.create", "library.album_tops.manage", "library.album_tops.items.manage",
    "library.album_tops.settings.manage", "library.album_tops.access.manage", "library.album_tops.progress.manage",
)


def context(grants, action, **changes):
    actor = CurrentActor(state=ActorState.ACTIVE, account_id=41, session_id=8, current_library_id=73,
        library_relationships=(LibraryRelationship(73, "member", False),),
        capability_grants=tuple(CapabilityGrant(key, "library", 73) for key in grants))
    return replace(PolicyContext.build(actor=actor, action=action, library_id=73, target_account_id=41,
        deployment_mode="self_hosted", request_origin=RequestOrigin("network", "personal-policy-test"),
        client_surface_class="private_web"), **changes)


def test_personal_collection_action_set_is_explicit_and_bounded():
    assert PERSONAL_COLLECTION_ACTIONS == frozenset(COLLECTION_ACTIONS)


@pytest.mark.parametrize("action", COLLECTION_ACTIONS)
@pytest.mark.parametrize("grants", [("capability.view",), ("library.browse.read",),
                                    capability_keys_for_roles(("viewer",)), capability_keys_for_roles(("listener",))])
def test_authenticated_viewers_and_listeners_can_use_personal_collection_actions(action, grants):
    assert PolicyEvaluator().evaluate(context(grants, action)).decision.allowed


@pytest.mark.parametrize("action", ["library.media.read", "library.files.edit_tags", "library.files.move",
    "library.inventory.manage", "library.covers.write", "accounts.manage", "system.admin"])
@pytest.mark.parametrize("grants", [("capability.view",), ("library.browse.read",), capability_keys_for_roles(("viewer",))])
def test_view_does_not_acquire_playback_file_mutation_or_administration(action, grants):
    assert not PolicyEvaluator().evaluate(context(grants, action)).decision.allowed


def test_listener_keeps_playback_but_does_not_gain_file_or_admin_authority():
    grants = capability_keys_for_roles(("listener",))
    assert PolicyEvaluator().evaluate(context(grants, "library.media.read")).decision.allowed
    for action in ("library.files.edit_tags", "library.inventory.manage", "accounts.manage"):
        assert not PolicyEvaluator().evaluate(context(grants, action)).decision.allowed


@pytest.mark.parametrize("action", (*COLLECTION_ACTIONS, "library.media.read"))
@pytest.mark.parametrize("state", [ActorState.ANONYMOUS, ActorState.INACTIVE])
def test_guests_and_inactive_accounts_cannot_use_retained_collection_or_media_grants(action, state):
    current = context(("capability.view", "capability.play"), action)
    current = replace(current, actor=replace(current.actor, state=state))
    assert not PolicyEvaluator().evaluate(current).decision.allowed


@pytest.mark.parametrize("action", COLLECTION_ACTIONS)
def test_personal_collection_grants_do_not_cross_library_scope(action):
    assert not PolicyEvaluator().evaluate(context(("capability.view",), action, library_id=74)).decision.allowed
    assert not PolicyEvaluator().evaluate(context((), action)).decision.allowed
