"""Browse authority owns personal features without granting library administration."""
from dataclasses import replace

import pytest

from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from music_app.services.policy import PolicyContext, RequestOrigin, ResourceScope
from music_app.services.policy_evaluator import PolicyEvaluator, PolicyEvaluationConstraints
from music_app.services.owned_playlists import require_playlist_authority, PlaylistError

BROWSE = 'library.browse.read'
PERSONAL = (
    'library.playlists.create', 'library.playlists.manage', 'library.playlists.items.manage',
    'library.playlists.cover.manage', 'library.playlists.settings.manage', 'library.playlists.access.manage',
    'library.album_tops.create', 'library.album_tops.manage', 'library.album_tops.items.manage',
    'library.album_tops.settings.manage', 'library.album_tops.access.manage', 'library.album_tops.progress.manage',
    'library.social.read', 'library.social.manage', 'library.social.history.read', 'library.social.taste.read',
    'library.track_preferences.manage',
)
DANGEROUS = (
    'library.media.read', 'library.files.edit_tags', 'library.files.move', 'library.files.repair',
    'library.inventory.manage', 'library.covers.write', 'library.covers.upload', 'library.covers.delete',
    'library.settings.manage', 'accounts.manage', 'accounts.capabilities.manage', 'system.admin',
    'integration.lastfm.scrobble', 'library.loops.media.read',
)


def context(key='capability.view', action=BROWSE):
    return PolicyContext.build(
        actor=CurrentActor(state=ActorState.ACTIVE, account_id=41, session_id=81, current_library_id=73,
            library_relationships=(LibraryRelationship(73, 'member', False),),
            capability_grants=(CapabilityGrant(key, 'library', 73),)),
        action=action, library_id=73, deployment_mode='self_hosted',
        request_origin=RequestOrigin('network', 'hmac:intrinsic-personal-test'),
        client_surface_class='private_web',
    )


@pytest.mark.parametrize('key', ['capability.view', BROWSE])
@pytest.mark.parametrize('action', PERSONAL)
def test_browse_only_member_has_existing_personal_action(key, action):
    assert PolicyEvaluator().evaluate(context(key, action)).decision.allowed


@pytest.mark.parametrize('key', ['capability.view', BROWSE])
@pytest.mark.parametrize('action', DANGEROUS)
def test_personal_authority_never_implies_media_files_or_admin(key, action):
    assert not PolicyEvaluator().evaluate(context(key, action)).decision.allowed


@pytest.mark.parametrize('key', ['capability.view', BROWSE])
@pytest.mark.parametrize('action', PERSONAL)
@pytest.mark.parametrize('constraint', ['deployment_allowed', 'client_surface_allowed', 'request_origin_allowed'])
def test_personal_aliases_keep_all_policy_ceilings(key, action, constraint):
    assert not PolicyEvaluator().evaluate(context(key, action),
        constraints=PolicyEvaluationConstraints(**{constraint: False})).decision.allowed


@pytest.mark.parametrize('action', PERSONAL)
@pytest.mark.parametrize('scope,scope_id', [('library', 74), ('account', 41)])
def test_browse_grant_cannot_cross_scope(action, scope, scope_id):
    value = context(action=action)
    value = replace(value, actor=replace(value.actor,
        capability_grants=(CapabilityGrant('capability.view', scope, scope_id),)))
    assert not PolicyEvaluator().evaluate(value).decision.allowed


@pytest.mark.parametrize('key', ['capability.view', BROWSE])
@pytest.mark.parametrize('action', ['library.playlists.manage', 'library.playlists.items.manage',
    'library.playlists.settings.manage', 'library.playlists.access.manage'])
def test_browse_only_member_can_manage_owned_playlist(key, action):
    value = replace(context(key, action), resource=ResourceScope('playlist', '20000000-0000-4000-8000-000000000001'))
    require_playlist_authority(value, required_actions=(BROWSE, action), owner_account_id=41)


@pytest.mark.parametrize('key', ['capability.view', BROWSE])
@pytest.mark.parametrize('action', ['library.playlists.manage', 'library.playlists.items.manage', 'library.playlists.settings.manage'])
def test_shared_playlist_editor_still_needs_object_grant(key, action):
    value = context(key, action)
    require_playlist_authority(value, required_actions=(BROWSE, action), owner_account_id=42, editor_grant=True)
    for visibility in ('private', 'server_shared'):
        with pytest.raises(PlaylistError):
            require_playlist_authority(value, required_actions=(BROWSE, action), owner_account_id=42, visibility=visibility)


def test_playlist_editor_cannot_change_owner_acl():
    with pytest.raises(PlaylistError):
        require_playlist_authority(context(action='library.playlists.access.manage'),
            required_actions=(BROWSE, 'library.playlists.access.manage'), owner_account_id=42, editor_grant=True)


@pytest.mark.parametrize('change', [
    {'session_id': None}, {'account_id': None}, {'current_library_id': 74},
    {'library_relationships': ()}, {'state': ActorState.ANONYMOUS}, {'state': ActorState.INACTIVE},
    {'capability_grants': ()},
])
def test_personal_playlist_authority_keeps_actor_session_membership_and_revocation(change):
    value = context(action='library.playlists.create')
    with pytest.raises(PlaylistError):
        require_playlist_authority(replace(value, actor=replace(value.actor, **change)),
            required_actions=(BROWSE, 'library.playlists.create'), owner_account_id=None)


def test_intrinsic_personal_access_does_not_add_a_coarse_capability_key():
    from music_app.services.capabilities import CAPABILITY_KEYS
    assert CAPABILITY_KEYS == frozenset('capability.' + name for name in (
        'view', 'social', 'play', 'edit', 'change_covers', 'delete', 'admin',
        'create_loop', 'practice', 'repair', 'move'))
