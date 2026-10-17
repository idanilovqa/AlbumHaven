"""Deterministic boundaries, not statistical guesses or live random IO."""
from uuid import uuid4
import pytest
from music_app.services.listening_goal_bonus import BonusPool, choose_bonus, normalize_bonus_draw
from music_app.services.listening_goals_commands import GoalsError

TOP_A = '11111111-1111-4111-8111-111111111111'
TOP_B = '22222222-2222-4222-8222-222222222222'
ALBUM_A = '33333333-3333-4333-8333-333333333333'
ALBUM_B = '44444444-4444-4444-8444-444444444444'


@pytest.mark.parametrize('ticket,expected', [(0, TOP_A), (1, TOP_B), (2, TOP_B), (3, TOP_B)])
def test_top_first_normal_one_preferred_three_boundaries(ticket, expected):
    bounds = []
    def random(bound):
        bounds.append(bound)
        return ticket
    pools = (BonusPool(TOP_B, True, (ALBUM_B,)), BonusPool(TOP_A, False, (ALBUM_A, ALBUM_B)))
    selected = choose_bonus(pools, album_mode='next', randbelow=random)
    assert selected[0] == expected and bounds == [4]


def test_next_uses_server_order_and_random_uses_separate_album_draw():
    pool = BonusPool(TOP_A, False, (ALBUM_B, ALBUM_A))
    assert choose_bonus((pool,), album_mode='next', randbelow=lambda bound: 0) == (TOP_A, ALBUM_B)
    values, bounds = iter((0, 1)), []
    def random(bound):
        bounds.append(bound)
        return next(values)
    assert choose_bonus((pool,), album_mode='random', randbelow=random) == (TOP_A, ALBUM_A)
    assert bounds == [1, 2]


def test_shared_album_preserves_two_source_paths_but_returns_one_album():
    pools = (BonusPool(TOP_A, False, (ALBUM_A,)), BonusPool(TOP_B, True, (ALBUM_A,)))
    assert choose_bonus(pools, album_mode='next', randbelow=lambda bound: 3) == (TOP_B, ALBUM_A)


def test_empty_pools_do_not_draw_or_loop():
    def forbidden(bound):
        raise AssertionError('No randomness for exhausted pools')
    assert choose_bonus((), album_mode='random', randbelow=forbidden) is None
    assert choose_bonus((BonusPool(TOP_A, True, ()),), album_mode='next', randbelow=forbidden) is None


@pytest.mark.parametrize('value', [-1, 1, True, None, 0.5])
def test_invalid_entropy_is_rejected(value):
    with pytest.raises(GoalsError, match='invalid_random_source'):
        choose_bonus((BonusPool(TOP_A, False, (ALBUM_A,)),), album_mode='next', randbelow=lambda bound: value)


@pytest.mark.parametrize('pools', [[], (BonusPool(TOP_A, False, (ALBUM_A, ALBUM_A)),),
    (BonusPool(TOP_A, False, (ALBUM_A,)), BonusPool(TOP_A, True, (ALBUM_B,))),
    (BonusPool(TOP_A, 1, (ALBUM_A,)),)])
def test_malformed_server_pools_rejected(pools):
    with pytest.raises(GoalsError):
        choose_bonus(pools, album_mode='next', randbelow=lambda bound: 0)


def command_payload(**changes):
    return {'request_key': str(uuid4()), 'revision': '1', 'settings_revision': '2',
            'expected_cycle_id': None, 'timezone_name': 'UTC', **changes}


@pytest.mark.parametrize('changes', [{'catalog_ref': ALBUM_A}, {'top_ref': TOP_A}, {'random_seed': 4},
    {'library_id': 1}, {'account_id': 1}, {'period': 'month'}, {'revision': '0'},
    {'settings_revision': True}, {'timezone_name': 'Invalid/Zone'}])
def test_draw_command_accepts_no_client_selection_entropy_or_authority(changes):
    with pytest.raises(GoalsError, match='invalid_command'):
        normalize_bonus_draw(command_payload(**changes))
