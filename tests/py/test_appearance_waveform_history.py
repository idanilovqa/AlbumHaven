"""Complete account-owned player-set history contracts for Appearance v009."""

import pytest

from tests.py.asgi_testing import decode_json
from tests.py.test_account_appearance_asgi import (
    AGGREGATE_APPEARANCE,
    CLASSIC_GREEN_PLAYER_STYLE,
    _app,
    _request,
)
from tests.py.test_appearance_preferences_postgres import Connection, _repository


def player_style(seed: int) -> dict[str, object]:
    """Return a complete, valid set whose colors remain easy to distinguish."""
    values = [f"#{seed + offset:06X}" for offset in range(7)]
    return {
        "surface": {
            "mode": "layered_gradient",
            "angle": seed % 361,
            "start": values[0],
            "end": values[1],
        },
        "controls": {"fill": values[2], "border": values[3]},
        "waveform": {"fill": values[4], "edge": values[5]},
        "handles": {"color": values[6]},
    }


def aggregate_write(*, applied_player_set=None) -> dict[str, object]:
    return {
        **{
            key: value for key, value in AGGREGATE_APPEARANCE.items()
            if key not in {"revision", "player_recent_sets"}
        },
        "applied_player_set": applied_player_set,
    }


def test_merge_player_recent_sets_is_newest_first_structural_mru_capped_at_five():
    from music_app.services.appearance_preferences_postgres import merge_player_recent_sets

    first, second, third, fourth, fifth, sixth = [player_style(seed) for seed in range(10, 70, 10)]
    current = [first, second, third, fourth, fifth]

    assert merge_player_recent_sets(current, third) == [third, first, second, fourth, fifth]
    assert merge_player_recent_sets(current, sixth) == [sixth, first, second, third, fourth]
    assert current == [first, second, third, fourth, fifth]


@pytest.mark.parametrize("current,candidate", [
    ("not-a-list", CLASSIC_GREEN_PLAYER_STYLE),
    ([CLASSIC_GREEN_PLAYER_STYLE] * 6, None),
    ([{**CLASSIC_GREEN_PLAYER_STYLE, "css": "filter:none"}], None),
    ([], {**CLASSIC_GREEN_PLAYER_STYLE, "handles": {}}),
])
def test_merge_player_recent_sets_rejects_unbounded_or_incomplete_values(current, candidate):
    from music_app.services.appearance_preferences_postgres import merge_player_recent_sets

    with pytest.raises(ValueError):
        merge_player_recent_sets(current, candidate)


def test_api_returns_authoritative_complete_sets_and_accepts_only_an_applied_set_event():
    app, repository, _resolver = _app()
    prior = player_style(20)
    repository.rows[41] = {**AGGREGATE_APPEARANCE, "player_recent_sets": [prior]}

    status, headers, body = _request(app)

    assert status == 200
    assert decode_json(body)["player_recent_sets"] == [prior]
    assert "no-store" in headers["cache-control"]

    captured = []
    saved = {
        **AGGREGATE_APPEARANCE,
        "revision": 8,
        "player_recent_sets": [CLASSIC_GREEN_PLAYER_STYLE, prior],
    }

    def save(*, account_id, preferences, expected_revision, client_profile):
        captured.append((account_id, client_profile, expected_revision, preferences))
        return saved

    repository.save_preferences = save
    submitted = {
        **aggregate_write(applied_player_set=CLASSIC_GREEN_PLAYER_STYLE),
        "expected_revision": 7,
    }

    status, _, body = _request(app, "PUT", submitted)

    assert status == 200
    assert decode_json(body) == saved
    assert captured == [(41, "desktop", 7, aggregate_write(
        applied_player_set=CLASSIC_GREEN_PLAYER_STYLE,
    ))]


def test_client_cannot_replace_authoritative_complete_set_history():
    app, repository, _resolver = _app()
    submitted = {
        **aggregate_write(),
        "expected_revision": 7,
        "player_recent_sets": [],
    }

    status, headers, body = _request(app, "PUT", submitted)

    assert status == 400
    assert decode_json(body) == {"error": "invalid_appearance"}
    assert "no-store" in headers["cache-control"]
    assert repository.writes == []


def test_repository_merges_one_complete_applied_set_inside_the_revision_checked_upsert():
    prior = player_style(20)
    row = {
        **AGGREGATE_APPEARANCE,
        "revision": 8,
        "player_recent_sets": [CLASSIC_GREEN_PLAYER_STYLE, prior],
    }
    connection = Connection(row)

    result = _repository(connection).save_preferences(
        account_id=41,
        client_profile="desktop",
        preferences=aggregate_write(applied_player_set=CLASSIC_GREEN_PLAYER_STYLE),
        expected_revision=7,
    )

    assert result == row
    assert len(connection.operations) == 1
    sql, params = connection.operations[0]
    assert "merge_player_recent_sets" in sql
    assert "player_recent_sets" in sql
    assert "revision" in sql
    assert 7 in params


def test_classic_green_is_a_complete_restorable_set_not_two_guessed_history_colors():
    assert CLASSIC_GREEN_PLAYER_STYLE["waveform"] == {
        "fill": "#387F68",
        "edge": "#AFD8C2",
    }
    assert CLASSIC_GREEN_PLAYER_STYLE["surface"] == {
        "mode": "layered_gradient",
        "angle": 135,
        "start": "#0A2F24",
        "end": "#0A1422",
    }
    assert set(CLASSIC_GREEN_PLAYER_STYLE) == {
        "surface", "controls", "waveform", "handles",
    }
