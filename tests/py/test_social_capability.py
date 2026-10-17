"""Social remains separate from playback, mutation, and custom assignment scope."""
from dataclasses import replace

import pytest

from music_app.services.capabilities import ROLE_PRESETS
from music_app.services.capability_assignments import build_assignment,read_assignment
from music_app.services.current_actor import CapabilityGrant
from tests.py.test_capability_presets import actor_for,allowed


@pytest.mark.parametrize('role',list(ROLE_PRESETS))
def test_new_standard_presets_enable_social(role):
    assert 'capability.social' in build_assignment([role],[]).effective_keys


def test_custom_and_no_access_assignments_stay_unchanged():
    assert build_assignment([],['capability.view']).effective_keys==('capability.view',)
    assert build_assignment([],[],allow_empty=True).effective_keys==()
    previous={'version':1,'role_keys':['listener'],'capability_keys':[]}
    read=read_assignment(previous,['capability.view','capability.play'])
    assert read.role_keys==() and 'capability.social' not in read.effective_keys


def test_social_does_not_grant_playback_editing_or_other_account_writes():
    actor=replace(actor_for('viewer'),capability_grants=(CapabilityGrant('capability.social','library',23),))
    for action in ('library.social.read','library.social.manage','library.social.history.read','library.social.taste.read'):
        assert allowed(actor,action)
        assert not allowed(actor,action,library_id=24)
    for action in ('library.media.read','library.track_preferences.manage','accounts.manage','library.files.edit_tags'):
        assert not allowed(actor,action)


def test_social_cursor_is_encrypted_and_bound_to_session_query_and_library():
    from music_app.services.social_cursors import encode_social_cursor,decode_social_cursor
    secret='a-secure-synthetic-cursor-key-for-tests'
    scope=[1,2,3,'discover:hidden%']
    token=encode_social_cursor(123456789,secret=secret,scope=scope)
    assert '123456789' not in token
    assert decode_social_cursor(token,secret=secret,scope=scope)==123456789
    for wrong in ([2,2,3,scope[-1]],[1,3,3,scope[-1]],[1,2,4,scope[-1]],[1,2,3,'discover:other']):
        with pytest.raises(ValueError):
            decode_social_cursor(token,secret=secret,scope=wrong)
    with pytest.raises(ValueError):
        decode_social_cursor(token[:-3]+'bad',secret=secret,scope=scope)
