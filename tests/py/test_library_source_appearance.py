"""Source indicators are one revisioned, account-owned Appearance preference."""

from itertools import product

import pytest

from music_app.services.appearance_preferences_postgres import (
    AppearanceRevisionConflict,
    PostgresAppearancePreferencesRepository,
    appearance_preference_sections,
    expand_appearance_preferences,
    normalize_appearance_device_profiles,
    normalize_appearance_preferences,
    resolve_appearance_device_section,
)
from tests.py.test_account_appearance_asgi import AGGREGATE_APPEARANCE


FIELD = "library_source_indicators"
DEFAULT = {"card_colors": False, "hover_outline_colors": False, "icons": True}
CUSTOM = {"card_colors": True, "hover_outline_colors": True, "icons": False}


def aggregate(**changes):
    return {
        **{key: value for key, value in AGGREGATE_APPEARANCE.items()
           if key not in {"revision", "player_recent_sets", FIELD}},
        "applied_player_set": None,
        **changes,
    }


@pytest.mark.parametrize("legacy", [
    {"main_surface_color": None, "panel_background_color": None},
    {key: value for key, value in AGGREGATE_APPEARANCE.items() if key != FIELD},
])
def test_legacy_reads_default_to_icons_without_coloring(legacy):
    assert expand_appearance_preferences(legacy)[FIELD] == DEFAULT


def test_legacy_writes_leave_source_indicators_omitted():
    assert FIELD not in normalize_appearance_preferences(aggregate())


@pytest.mark.parametrize("flags", [values for values in product((False, True), repeat=3) if any(values)])
def test_each_nonempty_combination_of_indicators_is_independent(flags):
    indicators = dict(zip(DEFAULT, flags))
    normalized = normalize_appearance_preferences(aggregate(**{FIELD: indicators}))
    assert normalized[FIELD] == indicators


@pytest.mark.parametrize("indicators", [
    {name: False for name in DEFAULT}, None, {}, True,
    {"icons": True}, {**DEFAULT, "unknown": True},
    *[{**DEFAULT, name: value} for name in DEFAULT for value in (0, 1, "true", None, [])],
])
def test_invalid_or_invisible_source_indicator_preferences_are_rejected(indicators):
    with pytest.raises(ValueError):
        normalize_appearance_preferences(aggregate(**{FIELD: indicators}))


def test_album_profile_section_defaults_legacy_base_and_inherits_later_changes():
    assert appearance_preference_sections(AGGREGATE_APPEARANCE)["album"][FIELD] == DEFAULT
    profiles = normalize_appearance_device_profiles({}, base_preferences=AGGREGATE_APPEARANCE)
    for profile in ("web_desktop", "mobile", "tv"):
        resolved = resolve_appearance_device_section(
            profiles, profile=profile, section="album",
            base_preferences={**AGGREGATE_APPEARANCE, FIELD: CUSTOM},
        )
        assert resolved[FIELD] == CUSTOM


@pytest.mark.parametrize("profile", ["mobile", "tv"])
def test_custom_album_profile_preserves_independent_indicators(profile):
    profiles = normalize_appearance_device_profiles(
        {profile: {"album": {"mode": "custom", "values": {FIELD: CUSTOM}}}},
        base_preferences=AGGREGATE_APPEARANCE,
    )
    resolved = resolve_appearance_device_section(
        profiles, profile=profile, section="album", base_preferences=AGGREGATE_APPEARANCE,
    )
    assert resolved[FIELD] == CUSTOM


def test_custom_album_profile_cannot_disable_every_indicator():
    with pytest.raises(ValueError):
        normalize_appearance_device_profiles(
            {"mobile": {"album": {"mode": "custom", "values": {
                FIELD: dict.fromkeys(DEFAULT, False),
            }}}}, base_preferences=AGGREGATE_APPEARANCE,
        )


class Connection:
    def __init__(self, rows):
        self.rows = list(rows)
        self.operations = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, sql, params):
        self.operations.append((" ".join(sql.lower().split()), params))
        return self

    def fetchone(self):
        return self.rows.pop(0)


def repository(connection):
    return PostgresAppearancePreferencesRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"},
        connect=lambda _url: connection,
    )


def test_source_indicators_save_in_same_revisioned_account_statement():
    connection = Connection([{**AGGREGATE_APPEARANCE, FIELD: CUSTOM, "revision": 8}])
    saved = repository(connection).save_preferences(
        account_id=41, preferences=aggregate(**{FIELD: CUSTOM}), expected_revision=7,
    )
    assert saved[FIELD] == CUSTOM
    assert saved["revision"] == 8
    assert len(connection.operations) == 1
    sql, params = connection.operations[0]
    assert FIELD in sql
    assert "saved.revision = incoming.expected_revision" in sql
    assert sql.count("%s") == len(params)


def test_stale_revision_returns_current_source_indicators_without_overwrite():
    current = {**AGGREGATE_APPEARANCE, FIELD: CUSTOM, "revision": 9}
    connection = Connection([None, current])
    with pytest.raises(AppearanceRevisionConflict) as raised:
        repository(connection).save_preferences(
            account_id=41, preferences=aggregate(**{FIELD: DEFAULT}), expected_revision=7,
        )
    assert raised.value.current[FIELD] == CUSTOM
    assert raised.value.current["revision"] == 9


def test_invalid_indicator_save_is_rejected_before_database_connection():
    def unexpected_connection(_url):
        pytest.fail("Invalid indicators must be rejected before persistence")

    repo = PostgresAppearancePreferencesRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"}, connect=unexpected_connection,
    )
    with pytest.raises(ValueError):
        repo.save_preferences(account_id=41, expected_revision=7, preferences=aggregate(
            **{FIELD: dict.fromkeys(DEFAULT, False)},
        ))


@pytest.mark.parametrize("payload", [
    {"main_surface_color": None, "panel_background_color": None},
    {"main_surface_color": None, "panel_background_color": None,
     "palette_id": None, "panel_index": 0, "player_override": None},
    aggregate(),
])
def test_legacy_writes_preserve_saved_source_indicators(payload):
    connection = Connection([{**AGGREGATE_APPEARANCE, FIELD: CUSTOM, "revision": 8}])
    saved = repository(connection).save_preferences(
        account_id=41, preferences=payload, expected_revision=7,
    )
    assert saved[FIELD] == CUSTOM
    sql, params = connection.operations[0]
    assert sql.count("%s") == len(params)
    update = sql.split("do update", 1)[-1] if "do update" in sql else sql
    if f"{FIELD} =" in update:
        assert f"saved.{FIELD}" in update


def test_device_profile_save_preserves_omitted_legacy_album_indicator_override():
    current = {**AGGREGATE_APPEARANCE, FIELD: CUSTOM, "revision": 8,
               "device_section_profiles": {}}
    connection = Connection([current])
    result = repository(connection).save_device_profiles(
        account_id=41, preferences=aggregate(),
        device_profiles={"mobile": {"album": {"mode": "custom", "values": {
            "album_details_layout": "stacked_bar",
        }}}}, action_button_outlines=True, expected_revision=7,
    )
    assert result[FIELD] == CUSTOM
    sql, params = connection.operations[0]
    assert sql.count("%s") == len(params)
    assert "saved.device_section_profiles #> '{mobile,sections,album,values,library_source_indicators}'" in sql
