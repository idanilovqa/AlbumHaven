"""Pure bounded preferences; source references never become admission proof."""
from uuid import uuid4
import pytest
from music_app.services.listening_goals_commands import GoalsError
from music_app.services.listening_goal_bonus_settings import (
    normalize_bonus_settings, default_bonus_settings, project_bonus_settings,
    PREFERRED_TOP_WEIGHT, NORMAL_TOP_WEIGHT, SELECTION_ALGORITHM,
)


def payload(**changes):
    return {'request_key': str(uuid4()), 'settings_revision': '1',
            **default_bonus_settings(), **changes}


def test_defaults_detachment_and_versioned_weight():
    first = project_bonus_settings(None)
    assert first['settings_revision'] == '1' and first['enabled'] is False
    assert first['source_mode'] == 'all_active' and first['unfinished_policy'] == 'carry'
    assert (NORMAL_TOP_WEIGHT, PREFERRED_TOP_WEIGHT, SELECTION_ALGORITHM) == (1, 3, 'active-top-weighted-v1')
    first['selected_top_refs'].append(str(uuid4()))
    assert project_bonus_settings(None)['selected_top_refs'] == []


def test_source_sets_are_canonical_detached_and_order_independent():
    a, b = str(uuid4()), str(uuid4())
    original = payload(source_mode='selected', selected_top_refs=[b, a], preferred_top_refs=[a])
    command = normalize_bonus_settings(original)
    digest = command.digest
    assert normalize_bonus_settings({**original, 'selected_top_refs': [a, b]}).digest == digest
    original['selected_top_refs'].clear()
    returned = command.values()
    returned['preferred_top_refs'].clear()
    assert command.digest == digest and command.preferred_top_refs == (a,)


@pytest.mark.parametrize('changes', [
    {'enabled': 1}, {'settings_revision': '0'}, {'settings_revision': 1},
    {'settings_revision': '9223372036854775808'}, {'source_mode': 'all'},
    {'album_mode': 'chronological'}, {'unfinished_policy': 'delete'},
    {'selected_top_refs': None}, {'preferred_top_refs': 'anything'},
    {'selected_top_refs': [str(uuid4())]},
    {'source_mode': 'selected', 'preferred_top_refs': [str(uuid4())]},
    {'source_mode': 'selected', 'selected_top_refs': ['local:123']},
    {'source_mode': 'selected', 'selected_top_refs': ['00000000-0000-0000-0000-000000000000']},
    {'source_mode': 'selected', 'selected_top_refs': [str(uuid4()) for _ in range(101)]},
    {'account_id': 3}, {'library_id': 3}, {'preferred_weight': 100}, {'evidence_ref': str(uuid4())},
])
def test_invalid_shapes_and_authority_inputs_rejected(changes):
    with pytest.raises(GoalsError, match='invalid_command'):
        normalize_bonus_settings(payload(**changes))


def test_duplicate_sources_and_missing_fields_rejected():
    ref = str(uuid4())
    with pytest.raises(GoalsError):
        normalize_bonus_settings(payload(source_mode='selected', selected_top_refs=[ref, ref]))
    value = payload()
    value.pop('enabled')
    with pytest.raises(GoalsError):
        normalize_bonus_settings(value)


def test_empty_custom_selection_is_valid_and_does_not_fall_back_to_all():
    command = normalize_bonus_settings(payload(enabled=True, source_mode='selected'))
    assert command.selected_top_refs == () and command.source_mode == 'selected'
