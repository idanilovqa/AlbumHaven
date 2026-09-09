"""Validation and SQL ownership contracts for per-account appearance preferences."""

import re

import pytest

from tests.py.test_account_appearance_asgi import (
    AGGREGATE_APPEARANCE,
    CLASSIC_GREEN_PLAYER_STYLE,
    INTERACTION_OVERRIDES,
    ITEM_OUTLINE,
    SELECTION_ACCENT,
)


DEFAULTS = {"main_surface_color": None, "panel_background_color": None}
EXTENDED_DEFAULTS = {
    "palette_id": None,
    "panel_index": 0,
    "player_override": None,
    "waveform_recent_colors": [],
    "compact_player_style": "docked",
    "album_details_layout": "classic_bar",
    "album_playing_row_animation": "enabled",
    "alert_family": "ember",
}
AGGREGATE_DEFAULTS = {
    "revision": 0,
    "interaction_overrides": {
        "item_hover": None,
        "item_selected": None,
        "button_hover_background": None,
        "button_pressed": None,
        "item_outline": {"source": "automatic", "color": None},
    },
    "selection_accent": {"enabled": True, "color": "#34CA78"},
    "player_style_override": None,
    "player_recent_sets": [],
}


class Connection:
    def __init__(self, row=None):
        self.row = row
        self.operations = []
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.closed = True
        return False

    def execute(self, sql, params=()):
        self.operations.append((" ".join(sql.lower().split()), params))
        return self

    def fetchone(self):
        return self.row


def _repository(connection):
    from music_app.services.appearance_preferences_postgres import PostgresAppearancePreferencesRepository

    return PostgresAppearancePreferencesRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"},
        connect=lambda _url: connection,
    )


@pytest.mark.parametrize("colors", [
    (None, None), ("#000000", "#FFFFFF"), ("#ff00aB", "#01CdEf"), (None, "#AB1234"),
])
def test_normalizer_preserves_all_rgb_values_and_explicit_defaults(colors):
    from music_app.services.appearance_preferences_postgres import normalize_appearance_preferences

    payload = dict(zip(DEFAULTS, colors))

    assert normalize_appearance_preferences(payload) == {
        key: value.upper() if value else None for key, value in payload.items()
    }


@pytest.mark.parametrize("payload", [
    None, [], "#FFFFFF", {}, {"main_surface_color": None}, {**DEFAULTS, "account_id": 2},
    *[{**DEFAULTS, "main_surface_color": value} for value in (
        "", " #123456", "#123456\n", "#123", "#12345678", "rgb(1,2,3)", "#ZZ1122", True, 123456,
    )],
])
def test_normalizer_rejects_incomplete_unknown_or_non_rgb_inputs(payload):
    from music_app.services.appearance_preferences_postgres import normalize_appearance_preferences

    with pytest.raises(ValueError):
        normalize_appearance_preferences(payload)


@pytest.mark.parametrize("account_id", [None, True, 0, -1, "41"])
@pytest.mark.parametrize("method", ["load_preferences", "save_preferences"])
def test_repository_rejects_invalid_owner_before_opening_database(account_id, method):
    from music_app.services.appearance_preferences_postgres import PostgresAppearancePreferencesRepository

    connections = []
    repository = PostgresAppearancePreferencesRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"},
        connect=lambda _url: connections.append(True),
    )
    kwargs = {"account_id": account_id}
    if method == "save_preferences":
        kwargs["preferences"] = DEFAULTS

    with pytest.raises(ValueError):
        getattr(repository, method)(**kwargs)

    assert connections == []


def test_repository_rejects_invalid_pair_before_database_access():
    from music_app.services.appearance_preferences_postgres import PostgresAppearancePreferencesRepository

    connections = []
    repository = PostgresAppearancePreferencesRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"},
        connect=lambda _url: connections.append(True),
    )

    with pytest.raises(ValueError):
        repository.save_preferences(account_id=41, preferences={**DEFAULTS, "panel_background_color": "#ABC"})

    assert connections == []


@pytest.mark.parametrize("row", [None, {"main_surface_color": "#010203", "panel_background_color": None}])
def test_repository_loads_only_the_requested_account_and_defaults_when_no_row_exists(row):
    connection = Connection(row)

    result = _repository(connection).load_preferences(account_id=41)

    expected = {**(row or DEFAULTS), **EXTENDED_DEFAULTS}
    if row is None:
        expected.update(AGGREGATE_DEFAULTS)
    assert result == expected
    assert len(connection.operations) == 1
    sql, params = connection.operations[0]
    assert "where account_id = %s" in sql or "where account_id=%s" in sql
    assert tuple(params) == (41, "desktop")
    assert connection.closed


def test_repository_saves_both_normalized_colors_in_one_account_owned_upsert():
    expected = {"main_surface_color": "#12ABCD", "panel_background_color": "#FE019A"}
    connection = Connection(expected)

    result = _repository(connection).save_preferences(
        account_id=52,
        preferences={"main_surface_color": "#12abcd", "panel_background_color": "#fe019a"},
    )

    assert result == {**expected, **EXTENDED_DEFAULTS}
    assert len(connection.operations) == 1
    sql, params = connection.operations[0]
    assert "insert into app.user_appearance_preferences" in sql
    assert "on conflict (account_id, client_profile)" in sql
    assert "revision" in sql
    assert "revision = saved.revision + 1" in sql
    assert tuple(params) == (52, "desktop", "#12ABCD", "#FE019A")
    assert connection.closed


def test_repository_reset_writes_null_overrides_for_only_the_requested_account():
    connection = Connection(DEFAULTS)

    assert _repository(connection).save_preferences(account_id=41, preferences=DEFAULTS) == {**DEFAULTS, **EXTENDED_DEFAULTS}

    assert len(connection.operations) == 1
    assert tuple(connection.operations[0][1]) == (41, "desktop", None, None)


def test_legacy_palette_write_advances_the_aggregate_revision():
    connection = Connection({**AGGREGATE_APPEARANCE, "revision": 8})
    preferences = {
        **DEFAULTS,
        "palette_id": "steelblue",
        "panel_index": 0,
        "player_override": None,
    }

    _repository(connection).save_preferences(account_id=41, preferences=preferences)

    sql, _params = connection.operations[0]
    assert "revision" in sql
    assert "revision = saved.revision + 1" in sql


def aggregate_write(**changes):
    writable = {
        key: value for key, value in AGGREGATE_APPEARANCE.items()
        if key not in {"revision", "player_recent_sets"}
    }
    return {**writable, "applied_player_set": None, **changes}


def test_normalizer_accepts_only_the_complete_closed_aggregate_snapshot():
    from music_app.services.appearance_preferences_postgres import normalize_appearance_preferences

    payload = aggregate_write(applied_player_set=CLASSIC_GREEN_PLAYER_STYLE)

    assert normalize_appearance_preferences(payload) == payload


@pytest.mark.parametrize("source", ["automatic", "theme", "player"])
def test_normalizer_accepts_linked_outline_sources(source):
    from music_app.services.appearance_preferences_postgres import normalize_appearance_preferences

    payload = aggregate_write(interaction_overrides={
        **INTERACTION_OVERRIDES,
        "item_outline": {**ITEM_OUTLINE, "source": source},
    })

    assert normalize_appearance_preferences(payload) == payload


def test_normalizer_accepts_and_uppercases_custom_outline():
    from music_app.services.appearance_preferences_postgres import normalize_appearance_preferences

    payload = aggregate_write(interaction_overrides={
        **INTERACTION_OVERRIDES,
        "item_outline": {"source": "custom", "color": "#86b7ef"},
    })

    assert normalize_appearance_preferences(payload)["interaction_overrides"]["item_outline"] == {
        "source": "custom",
        "color": "#86B7EF",
    }


@pytest.mark.parametrize("item_outline", [
    None,
    {},
    {"source": "automatic"},
    {"color": None},
    {"source": "automatic", "color": None, "css": "outline:lime"},
    {"source": "unknown", "color": None},
    {"source": "theme", "color": "#86B7EF"},
    {"source": "player", "color": "#86B7EF"},
    {"source": "automatic", "color": "#86B7EF"},
    {"source": "custom", "color": None},
    {"source": "custom", "color": "#FFF"},
    {"source": "custom", "color": "blue"},
])
def test_normalizer_rejects_invalid_item_outline_contract(item_outline):
    from music_app.services.appearance_preferences_postgres import normalize_appearance_preferences

    with pytest.raises(ValueError):
        normalize_appearance_preferences(aggregate_write(interaction_overrides={
            **INTERACTION_OVERRIDES,
            "item_outline": item_outline,
        }))


@pytest.mark.parametrize("layout", ["classic_bar", "stacked_bar", "editorial_canvas"])
@pytest.mark.parametrize("animation", ["enabled", "disabled"])
def test_normalizer_accepts_album_page_appearance_choices(layout, animation):
    from music_app.services.appearance_preferences_postgres import normalize_appearance_preferences

    payload = aggregate_write(
        album_details_layout=layout,
        album_playing_row_animation=animation,
    )

    assert normalize_appearance_preferences(payload) == payload


@pytest.mark.parametrize("field,value", [
    ("album_details_layout", "poster"),
    ("album_playing_row_animation", "sometimes"),
])
def test_normalizer_rejects_unknown_album_page_appearance_choices(field, value):
    from music_app.services.appearance_preferences_postgres import normalize_appearance_preferences

    with pytest.raises(ValueError):
        normalize_appearance_preferences(aggregate_write(**{field: value}))


@pytest.mark.parametrize("family", ["ember", "signal", "quiet"])
def test_normalizer_accepts_only_curated_alert_families(family):
    from music_app.services.appearance_preferences_postgres import normalize_appearance_preferences

    payload = aggregate_write(alert_family=family)

    assert normalize_appearance_preferences(payload) == payload


@pytest.mark.parametrize("family", [None, "", "red", "Ember", 1])
def test_normalizer_rejects_unknown_alert_families(family):
    from music_app.services.appearance_preferences_postgres import normalize_appearance_preferences

    with pytest.raises(ValueError):
        normalize_appearance_preferences(aggregate_write(alert_family=family))


@pytest.mark.parametrize("payload", [
    aggregate_write(interaction_overrides={
        key: value for key, value in INTERACTION_OVERRIDES.items() if key != "item_outline"
    }),
    aggregate_write(interaction_overrides={**INTERACTION_OVERRIDES, "hover_css": "outline:lime"}),
    aggregate_write(interaction_overrides={
        **INTERACTION_OVERRIDES,
        "button_hover_border": "#6E849D",
    }),
    aggregate_write(interaction_overrides={
        **INTERACTION_OVERRIDES,
        "focus": "#6E9BD0",
    }),
    aggregate_write(selection_accent={"enabled": True, "color": "#123"}),
    aggregate_write(player_style_override={
        **CLASSIC_GREEN_PLAYER_STYLE,
        "surface": {**CLASSIC_GREEN_PLAYER_STYLE["surface"], "mode": "css"},
    }),
    aggregate_write(player_style_override={
        **CLASSIC_GREEN_PLAYER_STYLE,
        "waveform": {"fill": "#387F68"},
    }),
    aggregate_write(applied_player_set={
        **CLASSIC_GREEN_PLAYER_STYLE,
        "handles": {"color": "rgba(0,0,0,.5)"},
    }),
])
def test_normalizer_rejects_partial_unknown_or_unbounded_aggregate_nested_values(payload):
    from music_app.services.appearance_preferences_postgres import normalize_appearance_preferences

    with pytest.raises(ValueError):
        normalize_appearance_preferences(payload)


def test_repository_load_returns_the_complete_authoritative_snapshot_for_one_owner_profile():
    connection = Connection(AGGREGATE_APPEARANCE)

    result = _repository(connection).load_preferences(account_id=41, client_profile="desktop")

    assert result == AGGREGATE_APPEARANCE
    assert len(connection.operations) == 1
    sql, params = connection.operations[0]
    for column in (
        "revision", "interaction_overrides", "selection_accent",
        "player_style_override", "player_recent_sets", "alert_family",
    ):
        assert column in sql
    assert tuple(params) == (41, "desktop")
    assert connection.closed


def test_repository_conditionally_saves_every_section_and_increments_revision_in_one_statement():
    saved = {**AGGREGATE_APPEARANCE, "revision": 8}
    connection = Connection(saved)
    submitted = aggregate_write(
        applied_player_set=CLASSIC_GREEN_PLAYER_STYLE,
        waveform_color_updates=["#123456"],
    )

    result = _repository(connection).save_preferences(
        account_id=41,
        client_profile="desktop",
        preferences=submitted,
        expected_revision=7,
    )

    assert result == saved
    assert len(connection.operations) == 1
    sql, params = connection.operations[0]
    assert "app.user_appearance_preferences" in sql
    assert "revision" in sql
    assert "revision + 1" in sql or "revision+1" in sql
    assert "expected_revision" in sql or "revision = %s" in sql or "revision=%s" in sql
    assert "interaction_overrides" in sql
    assert "selection_accent" in sql
    assert "player_style_override" in sql
    assert "player_recent_sets" in sql
    assert "merge_player_recent_sets" in sql
    assert "merge_waveform_recent_colors" in sql
    assert "alert_family" in sql
    assert "updated as (" in sql
    assert "saved.revision = incoming.expected_revision" in sql
    assert "on conflict (account_id, client_profile) do nothing" in sql
    assert "returning saved.main_surface_color" in sql
    assert 41 in params
    assert "desktop" in params
    assert 7 in params
    assert ["#123456"] in params
    assert connection.closed


@pytest.mark.parametrize("legacy", [None, {"background": "#123456", "fill": "#345678", "edge": "#567890"}])
def test_aggregate_save_persists_explicit_legacy_player_values_and_clears_null(legacy):
    connection = Connection({**AGGREGATE_APPEARANCE, "revision": 8})
    _repository(connection).save_preferences(
        account_id=41, preferences=aggregate_write(player_override=legacy, player_style_override=None),
        expected_revision=7,
    )
    sql, params = connection.operations[0]
    incoming = sql.split("), updated as (")[0]
    updated = sql.split("), updated as (")[1].split("returning")[0]
    for field, target_column in (
        ("background", "player_background_color"),
        ("fill", "player_waveform_fill_color"),
        ("edge", "player_waveform_edge_color"),
    ):
        column = f"player_{field}"
        match = re.search(r"%s::text " + column + r"\b", incoming)
        assert match, f"the aggregate snapshot must carry {column}, including explicit null"
        assert params[incoming[:match.start()].count("%s")] == (legacy[field] if legacy else None)
        assert f"{target_column} = incoming.{column}" in updated
    assert "saved.revision = incoming.expected_revision" in updated
    assert len(connection.operations) == 1


def test_repository_validates_expected_revision_before_opening_database():
    from music_app.services.appearance_preferences_postgres import PostgresAppearancePreferencesRepository

    opened = []
    repository = PostgresAppearancePreferencesRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"},
        connect=lambda _url: opened.append(True),
    )

    for revision in (None, True, -1, "7"):
        with pytest.raises(ValueError):
            repository.save_preferences(
                account_id=41,
                client_profile="desktop",
                preferences=aggregate_write(),
                expected_revision=revision,
            )

    assert opened == []
