"""Playlist collaboration policy/command contracts; synthetic actors only."""
from dataclasses import replace
from datetime import datetime, timezone

import pytest

from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from music_app.services.owned_playlists import (
    ACCESS, BROWSE, ITEMS, MANAGE, PlaylistError, command_actions,
    normalize_playlist_command, require_playlist_authority,
)
from music_app.services.owned_playlists_postgres import PostgresOwnedPlaylistsService
from music_app.services.policy import PolicyContext, RequestOrigin, ResourceScope
from music_app.services.policy_evaluator import PolicyEvaluationConstraints

P = "10000000-0000-4000-8000-000000000001"
K = "20000000-0000-4000-8000-000000000001"
G = "30000000-0000-4000-8000-000000000001"


def context(*, account=11, grants=(BROWSE, MANAGE, ITEMS, ACCESS), bootstrap=False):
    actor = CurrentActor(state=ActorState.ACTIVE, account_id=account, session_id=22,
        username_display="Synthetic member", authenticated_at=datetime(2026, 10, 8, tzinfo=timezone.utc),
        current_library_id=33, is_bootstrap_owner=bootstrap,
        library_relationships=(LibraryRelationship(33, "member", False),),
        capability_grants=tuple(CapabilityGrant(key, "library", 33) for key in grants))
    return PolicyContext.build(actor=actor, action=BROWSE, library_id=33,
        resource=ResourceScope("playlist", P), deployment_mode="self_hosted",
        request_origin=RequestOrigin("network", "synthetic"), client_surface_class="private_web")


def command(action, **payload):
    return normalize_playlist_command(action, {"revision":"4", "request_key":K, **payload}, playlist_ref=P)


@pytest.mark.parametrize("action,data,expected", [
    ("visibility", {"visibility":"server_shared"}, (BROWSE, ACCESS)),
    ("grant_editor", {"account_id":44,"role":"editor"}, (BROWSE, ACCESS)),
    ("revoke_editor", {"grant_ref":G}, (BROWSE, ACCESS)),
    ("delete", {}, (BROWSE, MANAGE)),
])
def test_new_commands_use_existing_capabilities(action, data, expected):
    parsed = command(action, **data)
    assert command_actions(parsed) == expected
    assert parsed.digest == command(action, **data).digest


@pytest.mark.parametrize("action,data", [
    ("visibility", {"visibility":"public"}),
    ("grant_editor", {"account_id":True,"role":"editor"}),
    ("grant_editor", {"account_id":"44","role":"editor"}),
    ("grant_editor", {"account_id":44,"role":"owner"}),
    ("grant_editor", {"account_id":44,"role":"editor","library_id":33}),
    ("revoke_editor", {"grant_ref":"44"}),
    ("delete", {"owner_account_id":11}),
])
def test_invalid_access_commands_cannot_widen_scope(action, data):
    with pytest.raises(PlaylistError, match="invalid_command"):
        command(action, **data)


@pytest.mark.parametrize("actions", [(BROWSE,), (BROWSE, MANAGE), (BROWSE, ITEMS)])
def test_explicit_editor_has_only_requested_capability(actions):
    require_playlist_authority(context(), required_actions=actions,
        owner_account_id=55, editor_grant=True)


@pytest.mark.parametrize("actions,kwargs", [
    ((BROWSE, ACCESS), {"editor_grant":True}),
    ((BROWSE, MANAGE), {"editor_grant":True,"owner_only":True}),
    ((BROWSE, ITEMS), {"visibility":"server_shared"}),
    ((BROWSE,), {}),
])
def test_editor_and_shared_visibility_never_confer_owner_rights(actions, kwargs):
    with pytest.raises(PlaylistError, match="forbidden"):
        require_playlist_authority(context(bootstrap=True), required_actions=actions,
            owner_account_id=55, **kwargs)


def test_shared_reader_still_needs_browse_membership_and_constraints():
    require_playlist_authority(context(grants=(BROWSE,)), required_actions=(BROWSE,),
        owner_account_id=55, visibility="server_shared")
    for ctx, constraints in ((context(grants=()), None),
            (replace(context(), actor=replace(context().actor, library_relationships=())), None),
            (context(), PolicyEvaluationConstraints(deployment_allowed=False))):
        with pytest.raises(PlaylistError, match="forbidden"):
            require_playlist_authority(ctx, required_actions=(BROWSE,), owner_account_id=55,
                visibility="server_shared", constraints=constraints)


def test_editor_does_not_replace_live_library_capabilities():
    with pytest.raises(PlaylistError, match="forbidden"):
        require_playlist_authority(context(grants=(BROWSE,)), required_actions=(BROWSE, MANAGE),
            owner_account_id=55, editor_grant=True)


@pytest.mark.parametrize("account,editor,visibility,edit,access", [
    (11, False, "private", True, True),
    (44, True, "private", True, False),
    (44, False, "server_shared", False, False),
])
def test_cards_do_not_grant_playback_and_project_exact_ownership(account, editor, visibility, edit, access):
    row = {"ref":P,"owner_account_id":11,"library_id":33,"revision":4,"title":"Synthetic",
           "description":"","item_count":0,"visibility":visibility,"editor_grant":editor,"deleted_at":None}
    card = PostgresOwnedPlaylistsService._card(context(account=account), row, None)
    assert card["visibility"] == visibility
    actions = card["allowed_actions"]
    assert actions["can_edit"] is edit
    assert actions["can_share"] is access
    assert actions["can_delete"] is access
    assert actions["can_play"] is False
