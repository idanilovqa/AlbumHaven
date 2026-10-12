"""Personal Top rights intersect, rather than replace, per-object ACLs."""
from dataclasses import replace

import pytest

from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from music_app.services.policy import PolicyContext, RequestOrigin, ResourceScope
from music_app.services.owned_album_tops import require_top_authority, AlbumTopError

BROWSE = 'library.browse.read'


def context(key, action):
    return PolicyContext.build(
        actor=CurrentActor(state=ActorState.ACTIVE, account_id=41, session_id=81, current_library_id=73,
            library_relationships=(LibraryRelationship(73, 'member', False),),
            capability_grants=(CapabilityGrant(key, 'library', 73),)),
        action=action, library_id=73, deployment_mode='self_hosted',
        resource=ResourceScope('album_top', '20000000-0000-4000-8000-000000000001'),
        request_origin=RequestOrigin('network', 'hmac:intrinsic-top-test'), client_surface_class='private_web')


@pytest.mark.parametrize('key', ['capability.view', BROWSE])
@pytest.mark.parametrize('suffix', ['manage', 'items.manage', 'settings.manage', 'access.manage', 'progress.manage'])
def test_browse_only_top_owner_has_personal_actions(key, suffix):
    action = 'library.album_tops.' + suffix
    require_top_authority(context(key, action), required_actions=(BROWSE, action), owner_account_id=41)


@pytest.mark.parametrize('key', ['capability.view', BROWSE])
@pytest.mark.parametrize('suffix', ['manage', 'items.manage', 'settings.manage', 'access.manage'])
def test_named_top_viewer_cannot_mutate_shared_content_or_acl(key, suffix):
    action = 'library.album_tops.' + suffix
    with pytest.raises(AlbumTopError):
        require_top_authority(context(key, action), required_actions=(BROWSE, action),
            owner_account_id=42, viewer_grant=True)


@pytest.mark.parametrize('key', ['capability.view', BROWSE])
def test_named_top_viewer_can_update_only_own_progress(key):
    action = 'library.album_tops.progress.manage'
    value = context(key, action)
    require_top_authority(value, required_actions=(BROWSE, action), owner_account_id=42, viewer_grant=True)
    with pytest.raises(AlbumTopError):
        require_top_authority(replace(value, target_account_id=42), required_actions=(BROWSE, action),
            owner_account_id=42, viewer_grant=True)
    with pytest.raises(AlbumTopError):
        require_top_authority(value, required_actions=(BROWSE, action), owner_account_id=42)


@pytest.mark.parametrize('key', ['capability.view', BROWSE])
def test_named_top_editor_can_edit_but_cannot_grant_access(key):
    action = 'library.album_tops.items.manage'
    require_top_authority(context(key, action), required_actions=(BROWSE, action), owner_account_id=42, editor_grant=True)
    action = 'library.album_tops.access.manage'
    with pytest.raises(AlbumTopError):
        require_top_authority(context(key, action), required_actions=(BROWSE, action), owner_account_id=42, editor_grant=True)
