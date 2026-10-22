"""Playlist conversion availability uses existing source and destination policy."""
from dataclasses import replace

import pytest

from test_owned_album_tops import _context, BROWSE, CREATE
from music_app.services.owned_playlists_postgres import PostgresOwnedPlaylistsService
from music_app.services.policy_evaluator import PolicyEvaluationConstraints


def card(context, *, count=1, owner=41, visibility='private', constraints=None):
    row = {'ref': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'owner_account_id': owner,
        'title': 'Source', 'description': '', 'revision': 1, 'item_count': count,
        'visibility': visibility, 'editor_grant': False}
    return PostgresOwnedPlaylistsService._card(context, row, constraints)


@pytest.mark.parametrize('count,expected', [(0, False), (1, True), (5000, True), (5001, False)])
def test_only_populated_bounded_persisted_sources_offer_conversion(count, expected):
    result = card(_context(BROWSE, CREATE), count=count)
    assert result['allowed_actions']['can_create_album_top'] is expected
    assert result['allowed_actions']['can_create_sample'] is False


@pytest.mark.parametrize('actions', [(), (BROWSE,), (CREATE,), (BROWSE, 'library.playlists.create')])
def test_playlist_creation_or_partial_authority_cannot_authorize_top_creation(actions):
    assert card(_context(*actions))['allowed_actions']['can_create_album_top'] is False


def test_other_owner_requires_readable_source_but_never_supplies_target_authority():
    permitted = _context(BROWSE, CREATE)
    assert card(permitted, owner=99)['allowed_actions']['can_create_album_top'] is False
    assert card(permitted, owner=99, visibility='server_shared')['allowed_actions']['can_create_album_top'] is True
    assert card(_context(BROWSE), owner=99, visibility='server_shared')['allowed_actions']['can_create_album_top'] is False


@pytest.mark.parametrize('denied', ['source', 'destination'])
def test_callable_constraints_are_evaluated_for_source_and_destination_separately(denied):
    seen = []
    def constraints(context):
        seen.append((context.action, context.resource.resource_kind if context.resource else None))
        reject = (denied == 'source' and context.resource is not None and context.resource.resource_kind == 'playlist'
            or denied == 'destination' and context.action == CREATE)
        return PolicyEvaluationConstraints(deployment_allowed=not reject)
    assert card(_context(BROWSE, CREATE), constraints=constraints)['allowed_actions']['can_create_album_top'] is False
    assert (BROWSE, 'playlist') in seen
    if denied == 'destination':
        assert (CREATE, None) in seen


def test_target_projection_cannot_use_a_foreign_actor_or_library_scope():
    context = _context(BROWSE, CREATE)
    assert card(replace(context, target_account_id=99))['allowed_actions']['can_create_album_top'] is False
    assert card(replace(context, library_id=8))['allowed_actions']['can_create_album_top'] is False
