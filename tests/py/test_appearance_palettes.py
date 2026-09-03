"""Approved v006 palette and grouped player preference contracts."""

import pytest

from tests.py.asgi_testing import decode_json
from tests.py.test_account_appearance_asgi import _actor, _app, _request
from tests.py.test_appearance_preferences_postgres import Connection, _repository


PALETTES = ("steelblue", "navy", "powderblue", "graphite", "slate", "midnight", "black", "blackgray", "paper", "silver", "coollight")
DEFAULTS = {
    "main_surface_color": None, "panel_background_color": None,
    "palette_id": None, "panel_index": 0, "player_override": None,
}
PLAYER = {"background": "#142E22", "fill": "#8BBFA0", "edge": "#D5EFDE"}


def preference(**changes):
    return {**DEFAULTS, "palette_id": "steelblue", **changes}


@pytest.mark.parametrize("palette_id", PALETTES)
@pytest.mark.parametrize("panel_index", [0, 1, 2])
def test_full_preference_accepts_each_approved_palette_and_only_its_companion_index(palette_id, panel_index):
    from music_app.services.appearance_preferences_postgres import normalize_appearance_preferences

    payload = preference(palette_id=palette_id, panel_index=panel_index)
    assert normalize_appearance_preferences(payload) == payload


def test_player_override_normalizes_as_one_complete_rgb_group():
    from music_app.services.appearance_preferences_postgres import normalize_appearance_preferences

    payload = preference(player_override={key: color.lower() for key, color in PLAYER.items()})
    assert normalize_appearance_preferences(payload) == preference(player_override=PLAYER)


@pytest.mark.parametrize("changes", [
    {"palette_id": "unknown"}, {"palette_id": "Steel Blue"}, {"palette_id": True},
    {"panel_index": -1}, {"panel_index": 3}, {"panel_index": True}, {"panel_index": "1"},
    {"panel_index": 1.0}, {"palette_id": None, "panel_index": 1},
    {"main_surface_color": "#123456"}, {"panel_background_color": "#123456"},
    {"player_override": {}}, {"player_override": {"background": "#123456"}},
    {"player_override": {**PLAYER, "text": "#FFFFFF"}},
    *[{"player_override": {**PLAYER, "fill": color}} for color in (None, "#FFF", "#123456\n", True, "red")],
])
def test_invalid_full_preference_rejects_conflicting_palette_partial_group_or_invalid_rgb(changes):
    from music_app.services.appearance_preferences_postgres import normalize_appearance_preferences

    with pytest.raises(ValueError):
        normalize_appearance_preferences(preference(**changes))


@pytest.mark.parametrize("missing", ["palette_id", "panel_index", "player_override"])
def test_extended_fields_are_an_atomic_schema_not_an_ambiguous_partial_update(missing):
    from music_app.services.appearance_preferences_postgres import normalize_appearance_preferences

    payload = preference()
    del payload[missing]
    with pytest.raises(ValueError):
        normalize_appearance_preferences(payload)


def test_legacy_pair_expands_without_losing_colors_or_assigning_a_player_override():
    from music_app.services.appearance_preferences_postgres import (
        expand_appearance_preferences, normalize_appearance_preferences,
    )

    legacy = {"main_surface_color": "#12abcd", "panel_background_color": None}
    assert normalize_appearance_preferences(legacy) == {**legacy, "main_surface_color": "#12ABCD"}
    assert expand_appearance_preferences(legacy) == {**DEFAULTS, "main_surface_color": "#12ABCD"}


def test_api_saves_palette_panel_and_player_together_for_only_the_current_account():
    app, repository, resolver = _app()
    payload = preference(panel_index=2, player_override=PLAYER)

    status, _headers, body = _request(app, "PUT", payload)

    assert status == 200
    assert decode_json(body) == payload
    resolver.actor = _actor(52)
    other = decode_json(_request(app)[2])
    assert {key: other[key] for key in DEFAULTS} == DEFAULTS
    assert repository.rows == {41: payload}
    resolver.actor = _actor(41)
    restored = decode_json(_request(app)[2])
    assert {key: restored[key] for key in DEFAULTS} == payload


def test_invalid_player_field_cannot_partially_apply_a_valid_palette_change():
    app, repository, _resolver = _app()
    previous = preference(player_override=PLAYER)
    repository.rows[41] = previous

    status, _headers, body = _request(app, "PUT", preference(
        palette_id="powderblue", player_override={**PLAYER, "edge": "invalid"},
    ))

    assert status == 400
    assert decode_json(body) == {"error": "invalid_appearance"}
    assert repository.writes == []
    assert repository.rows[41] == previous


def test_repository_maps_migrated_legacy_row_into_canonical_defaults_without_mutating_it():
    row = {
        "main_surface_color": "#123456", "panel_background_color": None,
        "palette_id": None, "panel_index": 0,
        "player_background_color": None, "player_waveform_fill_color": None, "player_waveform_edge_color": None,
    }
    connection = Connection(row)
    assert _repository(connection).load_preferences(account_id=41) == {**DEFAULTS, "main_surface_color": "#123456"}
    assert len(connection.operations) == 1
    assert connection.operations[0][0].startswith("select")


def test_repository_persists_full_player_group_and_palette_in_one_account_owned_statement():
    payload = preference(panel_index=2, player_override=PLAYER)
    row = {
        **{key: value for key, value in payload.items() if key != "player_override"},
        "player_background_color": PLAYER["background"],
        "player_waveform_fill_color": PLAYER["fill"],
        "player_waveform_edge_color": PLAYER["edge"],
    }
    connection = Connection(row)

    assert _repository(connection).save_preferences(account_id=52, preferences=payload) == payload
    assert len(connection.operations) == 1
    sql, params = connection.operations[0]
    assert "on conflict (account_id)" in sql
    assert tuple(params) == (52, None, None, "steelblue", 2, PLAYER["background"], PLAYER["fill"], PLAYER["edge"])
    assert connection.closed


def test_legacy_write_clears_palette_but_preserves_the_saved_player_override():
    row = {
        "main_surface_color": "#123456", "panel_background_color": None,
        "palette_id": None, "panel_index": 0,
        "player_background_color": PLAYER["background"],
        "player_waveform_fill_color": PLAYER["fill"],
        "player_waveform_edge_color": PLAYER["edge"],
    }
    connection = Connection(row)

    result = _repository(connection).save_preferences(
        account_id=41, preferences={"main_surface_color": "#123456", "panel_background_color": None},
    )

    assert result == {**DEFAULTS, "main_surface_color": "#123456", "player_override": PLAYER}
    update = connection.operations[0][0].split("do update", 1)[1].split("returning", 1)[0]
    for column in ("player_background_color", "player_waveform_fill_color", "player_waveform_edge_color"):
        assert column not in update
    assert "palette_id" in update
    assert "panel_index" in update
