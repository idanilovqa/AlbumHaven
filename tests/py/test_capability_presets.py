"""Additive role/device policy coverage; existing functional journeys are unchanged."""

from types import SimpleNamespace

import pytest

from music_app.services.capabilities import CAPABILITY_KEYS, capability_keys_for_roles
from music_app.services.client_surfaces import client_surface_from_request
from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from music_app.services.policy import PolicyContext, RequestOrigin
from music_app.services.policy_evaluator import PolicyEvaluator


def actor_for(*roles, bootstrap=False, library_id=23):
    return CurrentActor(
        state=ActorState.ACTIVE, account_id=7, session_id=11,
        username_display="Rendref" if bootstrap else "test-member",
        is_bootstrap_owner=bootstrap, current_library_id=library_id,
        library_relationships=(LibraryRelationship(library_id, "member", bootstrap),),
        capability_grants=tuple(
            CapabilityGrant(key, "library", library_id)
            for key in capability_keys_for_roles(roles)
        ),
    )


def allowed(actor, action, surface="private_web", library_id=23):
    context = PolicyContext.build(
        actor=actor, action=action, library_id=library_id,
        deployment_mode="self_hosted", request_origin=RequestOrigin("network", "test"),
        client_surface_class=surface,
    )
    return PolicyEvaluator().evaluate(context).decision.allowed


@pytest.mark.parametrize("role,action,expected", [
    ("viewer", "app.shell.read", True),
    ("viewer", "library.artwork.read", True),
    ("viewer", "library.virtual_discography.create", True),
    ("viewer", "library.media.read", False),
    ("listener", "library.media.read", True),
    ("listener", "library.problems.read", False),
    ("listener", "library.loops.read", False),
    ("listener", "library.rules.read", False),
    ("musician", "library.loops.create", True),
    ("musician", "library.loops.media.read", True),
    ("musician", "library.files.edit_tags", False),
    ("owner", "library.files.move", True),
    ("owner", "library.files.edit_tags", False),
    ("owner", "library.files.repair", True),
    ("owner", "accounts.create", False),
    ("admin", "accounts.create", True),
    ("admin", "library.files.edit_tags", False),
])
def test_presets_on_web(role, action, expected):
    assert allowed(actor_for(role), action) is expected


@pytest.mark.parametrize("surface", ["mobile", "tv"])
@pytest.mark.parametrize("action", [
    "library.files.edit_tags", "library.inventory.manage", "library.covers.delete",
    "library.loops.create", "library.loops.delete", "library.loops.reorder",
])
@pytest.mark.parametrize("bootstrap", [False, True])
def test_mobile_and_tv_ceilings_apply_to_all_owners(surface, action, bootstrap):
    assert not allowed(actor_for("owner", "admin", bootstrap=bootstrap), action, surface)


@pytest.mark.parametrize("action", [
    "system.admin", "accounts.read", "accounts.manage", "library.loops.read", "library.loops.media.read",
    "library.loops.preview", "library.covers.upload", "library.covers.link",
])
def test_tv_additional_restrictions(action):
    assert not allowed(actor_for("owner", "admin", bootstrap=True), action, "tv")


def test_practice_does_not_grant_creation_or_mutation():
    actor = CurrentActor(
        state=ActorState.ACTIVE, account_id=7, session_id=11,
        capability_grants=(CapabilityGrant("capability.practice", "library", 23),),
    )
    assert allowed(actor, "library.loops.media.read", "mobile")
    assert not allowed(actor, "library.loops.create")
    assert not allowed(actor, "library.loops.delete")


def test_rendref_retains_all_desktop_web_capabilities():
    actor = actor_for("owner", "admin", bootstrap=True)
    for key in CAPABILITY_KEYS:
        assert allowed(actor, key)
    assert allowed(actor, "library.files.edit_tags")
    assert allowed(actor, "system.admin")


def test_owner_plus_admin_may_edit_web_but_owner_alone_only_native_desktop():
    assert allowed(actor_for("owner", "admin"), "library.files.edit_tags")
    assert allowed(actor_for("owner"), "library.files.edit_tags", "desktop")
    assert not allowed(actor_for("owner"), "library.files.edit_tags")


def test_scope_is_preserved_and_role_does_not_grant_unreviewed_future_actions():
    actor = actor_for("owner", "admin")
    assert not allowed(actor, "library.files.move", library_id=24)
    assert not allowed(actor, "accounts.read", library_id=24)
    assert not allowed(actor, "library.future_feature.write")
    assert not allowed(actor, "system.admin")


def test_legacy_grants_keep_artwork_but_browse_never_grants_audio():
    actor = CurrentActor(
        state=ActorState.ACTIVE,
        capability_grants=(CapabilityGrant("library.browse.read", "library", 23),),
    )
    assert allowed(actor, "library.artwork.read")
    assert not allowed(actor, "library.media.read")


@pytest.mark.parametrize("roles", [[], ["unknown"], ["owner", None], "owner", None, 7])
def test_invalid_role_presets_fail_closed(roles):
    with pytest.raises(ValueError):
        capability_keys_for_roles(roles)


@pytest.mark.parametrize("headers,expected", [
    ({}, "private_web"),
    ({"x-album-haven-client-surface": "desktop"}, "private_web"),
    ({"x-album-haven-client-surface": "node"}, "private_web"),
    ({"user-agent": "Mozilla/5.0 (iPhone)"}, "mobile"),
    ({"user-agent": "Mozilla/5.0 (Linux; Android 14)"}, "mobile"),
    ({"user-agent": "Mozilla/5.0 (SMART-TV; Linux; Tizen)"}, "tv"),
    ({"sec-ch-ua-mobile": "?1"}, "mobile"),
    ({"x-album-haven-client-surface": "tv"}, "tv"),
])
def test_untrusted_hints_only_narrow_web_authority(headers, expected):
    assert client_surface_from_request(SimpleNamespace(headers=headers, scope={})) == expected


def test_native_context_is_server_owned_and_can_be_narrowed():
    request = SimpleNamespace(
        headers={}, scope={"album_haven.authenticated_client_surface": "desktop"}
    )
    assert client_surface_from_request(request) == "desktop"
    request.headers["x-album-haven-client-surface"] = "tv"
    assert client_surface_from_request(request) == "tv"
