"""Exact input/digest contracts for owner-scoped completion and removal."""
from uuid import uuid4

import pytest

from music_app.services.listening_goals_commands import GoalsError, normalize_goal_command


def payload(action='completion'):
    value = {'request_key': str(uuid4()), 'revision': '2', 'period': 'week',
             'expected_cycle_id': str(uuid4()), 'catalog_ref': str(uuid4())}
    if action == 'completion':
        value['completed'] = True
    return value


@pytest.mark.parametrize('action', ['completion', 'remove'])
def test_selection_commands_are_exact_detached_and_require_every_field(action):
    original = payload(action)
    command = normalize_goal_command(action, original)
    assert dict(command.data) == {key: value for key, value in original.items() if key != 'request_key'}
    assert normalize_goal_command(action, dict(reversed(list(original.items())))).digest == command.digest
    for field in original:
        with pytest.raises(GoalsError):
            normalize_goal_command(action, {key: value for key, value in original.items() if key != field})
    original['catalog_ref'] = str(uuid4())
    assert command.data['catalog_ref'] != original['catalog_ref']


@pytest.mark.parametrize('action', ['completion', 'remove'])
@pytest.mark.parametrize('field,value', [('account_id', 99), ('viewer_ref', '99'), ('session_id', 99),
    ('library_id', 99), ('occurred_at', '2026-10-15T00:00:00+00:00'),
    ('timezone_name', 'UTC'), ('manual_completed_at', None), ('assignment_id', 'caller'),
    ('title', 'caller'), ('evidence_ref', 'caller'), ('new_cycle_id', 'caller')])
def test_new_commands_reject_authority_time_and_unrelated_fields(action, field, value):
    with pytest.raises(GoalsError, match='invalid_command'):
        normalize_goal_command(action, {**payload(action), field: value})


@pytest.mark.parametrize('value', [None, 0, 1, 'true', 'false', [], {}])
def test_completion_is_strict_boolean(value):
    with pytest.raises(GoalsError, match='invalid_command'):
        normalize_goal_command('completion', {**payload(), 'completed': value})


@pytest.mark.parametrize('action', ['completion', 'remove'])
@pytest.mark.parametrize('field,value', [('catalog_ref', None), ('catalog_ref', 'not-a-uuid'),
    ('expected_cycle_id', False), ('expected_cycle_id', 'not-a-uuid'), ('revision', '02'),
    ('period', 'all')])
def test_selection_identity_revision_and_period_use_strict_existing_validation(action, field, value):
    with pytest.raises(GoalsError, match='invalid_command'):
        normalize_goal_command(action, {**payload(action), field: value})


@pytest.mark.parametrize('action', ['completion', 'remove'])
def test_every_selection_field_changes_command_digest(action):
    value = payload(action)
    command = normalize_goal_command(action, value)
    changes = {'request_key': str(uuid4()), 'revision': '3', 'period': 'month',
               'expected_cycle_id': None, 'catalog_ref': str(uuid4())}
    if action == 'completion':
        changes['completed'] = False
    for key, replacement in changes.items():
        assert normalize_goal_command(action, {**value, key: replacement}).digest != command.digest
