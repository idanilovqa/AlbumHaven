import pytest

from music_app.services.appearance_preferences_postgres import (
    normalize_appearance_device_profiles,
    resolve_appearance_device_section,
)


BASE = {
    "main_surface_color": None,
    "panel_background_color": None,
    "palette_id": "black",
    "panel_index": 0,
    "player_override": None,
    "waveform_recent_colors": [],
    "compact_player_style": "docked",
    "docked_compact_player_behavior": "follow_sidebar",
    "docked_compact_player_regular_style": False,
    "album_details_layout": "classic_bar",
    "album_playing_row_animation": "enabled",
    "alert_family": "ember",
    "interaction_overrides": {
        "item_hover": None,
        "item_selected": None,
        "button_hover_background": None,
        "button_pressed": None,
        "item_outline": {"source": "automatic", "color": None},
    },
    "selection_accent": {"enabled": True, "color": "#34CA78"},
    "player_style_override": None,
    "loop_control_style": "capsule",
    "action_button_outlines": True,
}


def test_new_mobile_and_tv_sections_follow_the_base_and_preserve_outline_preference():
    profiles = normalize_appearance_device_profiles({}, base_preferences=BASE)

    for profile in ("mobile", "tv"):
        assert set(profiles[profile]["sections"]) == {"main", "player", "interaction", "alerts", "album"}
        assert all(section["mode"] == "follow" for section in profiles[profile]["sections"].values())
        assert all(section["values"] == {} for section in profiles[profile]["sections"].values())


def test_mobile_and_tv_player_sections_strip_legacy_loop_control_values():
    payload = {
        profile: {
            "sections": {
                "player": {
                    "mode": "custom",
                    "values": {
                        "compact_player_style": "floating",
                        "loop_control_style": "companion",
                    },
                },
            },
        }
        for profile in ("mobile", "tv")
    }

    profiles = normalize_appearance_device_profiles(payload, base_preferences=BASE)

    for profile in ("mobile", "tv"):
        values = profiles[profile]["sections"]["player"]["values"]
        assert values["compact_player_style"] == "floating"
        assert "loop_control_style" not in values
        assert "loop_control_style" not in resolve_appearance_device_section(
            profiles,
            profile=profile,
            section="player",
            base_preferences=BASE,
        )


def test_legacy_base_custom_player_section_defaults_new_dock_behavior():
    legacy_base = {key: value for key, value in BASE.items() if key != "docked_compact_player_behavior"}

    profiles = normalize_appearance_device_profiles(
        {"mobile": {"sections": {"player": {
            "mode": "custom",
            "values": {"compact_player_style": "docked"},
        }}}},
        base_preferences=legacy_base,
    )

    assert profiles["mobile"]["sections"]["player"]["values"]["docked_compact_player_behavior"] == "follow_sidebar"
    assert resolve_appearance_device_section(
        profiles, profile="mobile", section="interaction", base_preferences=BASE,
    )["action_button_outlines"] is True


def test_follow_uses_later_base_values_while_dormant_custom_values_remain_stored():
    profiles = normalize_appearance_device_profiles({
        "mobile": {
            "alerts": {"mode": "follow", "values": {"alert_family": "quiet"}},
        },
    }, base_preferences=BASE)
    changed_base = {**BASE, "alert_family": "signal"}

    assert profiles["mobile"]["sections"]["alerts"]["values"]["alert_family"] == "quiet"
    assert resolve_appearance_device_section(
        profiles, profile="mobile", section="alerts", base_preferences=changed_base,
    ) == {"alert_family": "signal"}


@pytest.mark.parametrize("payload", [
    {"watch": {}},
    {"mobile": {"alerts": {"mode": "inherit", "values": {}}}},
    {"mobile": {"alerts": {"mode": "custom", "values": {"alert_family": "unknown"}}}},
    {"tv": {"interaction": {"mode": "custom", "values": {"action_button_outlines": "off"}}}},
])
def test_device_profile_validation_rejects_unknown_profiles_modes_and_values(payload):
    with pytest.raises(ValueError):
        normalize_appearance_device_profiles(payload, base_preferences=BASE)

class _SequenceConnection:
    def __init__(self, rows):
        self.rows = list(rows)
        self.operations = []

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc, _traceback):
        return False

    def execute(self, sql, params=()):
        self.operations.append((" ".join(sql.lower().split()), params))
        return self

    def fetchone(self):
        return self.rows.pop(0)


def _aggregate_write():
    from tests.py.test_account_appearance_asgi import AGGREGATE_APPEARANCE

    return {
        **{
            key: value
            for key, value in AGGREGATE_APPEARANCE.items()
            if key not in {"revision", "player_recent_sets"}
        },
        "applied_player_set": None,
        "loop_control_style": "capsule",
    }


def test_device_profile_conflict_reads_current_snapshot_on_the_same_connection():
    from music_app.services.appearance_preferences_postgres import (
        AppearanceRevisionConflict,
        PostgresAppearancePreferencesRepository,
    )
    from tests.py.test_account_appearance_asgi import AGGREGATE_APPEARANCE

    current = {
        **AGGREGATE_APPEARANCE,
        "revision": 9,
        "action_button_outlines": False,
        "device_section_profiles": {},
    }
    connection = _SequenceConnection([None, current])
    opens = []
    repository = PostgresAppearancePreferencesRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"},
        connect=lambda _url: opens.append(True) or connection,
    )

    with pytest.raises(AppearanceRevisionConflict) as failure:
        repository.save_device_profiles(
            account_id=41,
            preferences=_aggregate_write(),
            device_profiles={},
            action_button_outlines=True,
            expected_revision=7,
        )

    assert len(opens) == 1
    assert len(connection.operations) == 2
    assert connection.operations[1][1] == (41,)
    assert failure.value.current["revision"] == 9
    assert failure.value.current["action_button_outlines"] is False

def test_device_profile_load_returns_profiles_and_outline_for_one_account():
    from music_app.services.appearance_preferences_postgres import (
        PostgresAppearancePreferencesRepository,
    )
    from tests.py.test_account_appearance_asgi import AGGREGATE_APPEARANCE

    row = {
        **AGGREGATE_APPEARANCE,
        "action_button_outlines": False,
        "device_section_profiles": {},
    }
    connection = _SequenceConnection([row])
    repository = PostgresAppearancePreferencesRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"},
        connect=lambda _url: connection,
    )

    loaded = repository.load_device_profiles(account_id=41)

    assert loaded["action_button_outlines"] is False
    assert set(loaded["device_profiles"]) == {"mobile", "tv"}
    assert connection.operations[0][1] == (41,)
    assert "client_profile = 'desktop'" in connection.operations[0][0]


def test_device_profile_save_persists_profiles_and_outline_in_one_account_owned_statement():
    from music_app.services.appearance_preferences_postgres import (
        PostgresAppearancePreferencesRepository,
    )
    from tests.py.test_account_appearance_asgi import AGGREGATE_APPEARANCE

    saved = {
        **AGGREGATE_APPEARANCE,
        "revision": 8,
        "action_button_outlines": False,
        "device_section_profiles": {},
    }
    connection = _SequenceConnection([saved])
    repository = PostgresAppearancePreferencesRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"},
        connect=lambda _url: connection,
    )

    result = repository.save_device_profiles(
        account_id=41,
        preferences=_aggregate_write(),
        device_profiles={},
        action_button_outlines=False,
        expected_revision=7,
    )

    assert result["revision"] == 8
    assert result["action_button_outlines"] is False
    assert set(result["device_profiles"]) == {"mobile", "tv"}
    assert len(connection.operations) == 1
    sql, params = connection.operations[0]
    assert sql.count("%s") == len(params)
    assert "device_section_profiles = incoming.profiles" in sql
    assert "action_button_outlines = incoming.outlines" in sql
    assert "saved.account_id = incoming.account_id" in sql
    assert "saved.revision = incoming.expected_revision" in sql
    assert params[0] == 41
    assert params[2] is False

def test_legacy_device_loop_style_is_ignored_before_revision_conflict_handling():
    from music_app.services.appearance_preferences_postgres import (
        AppearanceRevisionConflict,
        PostgresAppearancePreferencesRepository,
    )
    from tests.py.test_account_appearance_asgi import AGGREGATE_APPEARANCE

    current = {
        **AGGREGATE_APPEARANCE,
        "loop_control_style": "capsule",
        "action_button_outlines": True,
        "device_section_profiles": {},
    }
    connection = _SequenceConnection([None, current])
    repository = PostgresAppearancePreferencesRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"},
        connect=lambda _url: connection,
    )

    with pytest.raises(AppearanceRevisionConflict):
        repository.save_device_profiles(
            account_id=41,
            preferences=_aggregate_write(),
            device_profiles={
                "mobile": {
                    "sections": {
                        "player": {
                            "mode": "custom",
                            "values": {"loop_control_style": "companion"},
                        },
                    },
                },
            },
            action_button_outlines=True,
            expected_revision=7,
            allow_loop_control_style=False,
        )

    assert len(connection.operations) == 2

def test_appearance_device_migration_preserves_base_and_adds_validated_profile_storage():
    from pathlib import Path

    sql = (
        Path(__file__).resolve().parents[2]
        / "migrations/postgres/0075_appearance_device_sections.sql"
    ).read_text(encoding="utf-8").lower()

    assert "alter table app.user_appearance_preferences" in sql
    assert "action_button_outlines boolean not null default true" in sql
    assert "device_section_profiles jsonb not null" in sql
    assert "user_appearance_device_section_profiles_shape" in sql
    assert "device_section_profiles ? 'mobile'" in sql
    assert "device_section_profiles ? 'tv'" in sql
    assert "drop column" not in sql


def test_sidebar_preferences_remain_owned_by_each_device_player_section():
    base = {**BASE, "docked_compact_player_regular_style": False, "compact_player_motion": "normal",
            "floating_player_edge": {"source": "player", "color": None}}
    custom = {"docked_compact_player_behavior": "artbox", "docked_compact_player_regular_style": True, "compact_player_motion": "slow",
              "floating_player_edge": {"source": "custom", "color": "#123456"}}
    profiles = normalize_appearance_device_profiles({
        "mobile": {"sections": {"player": {"mode": "custom", "values": custom}}},
    }, base_preferences=base)
    changed_base = {**base, "docked_compact_player_behavior": "float_on_collapse",
                    "floating_player_edge": {"source": "theme", "color": None}}
    mobile = resolve_appearance_device_section(
        profiles, profile="mobile", section="player", base_preferences=changed_base,
    )
    tv = resolve_appearance_device_section(
        profiles, profile="tv", section="player", base_preferences=changed_base,
    )
    for key, value in custom.items():
        assert mobile[key] == value
    assert tv["docked_compact_player_behavior"] == "float_on_collapse"
    assert tv["compact_player_motion"] == "normal"
    assert tv["floating_player_edge"] == {"source": "theme", "color": None}
    assert profiles["mobile"]["sections"]["player"]["values"]["compact_player_motion"] == "slow"
