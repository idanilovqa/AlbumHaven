class Connection:
    def __init__(self, row=None): self.row, self.operations = row, []
    def __enter__(self): return self
    def __exit__(self, *_args): return False
    def execute(self, sql, params=()): self.operations.append((" ".join(sql.lower().split()), params)); return self
    def fetchone(self): return self.row


def _repository(connection):
    from music_app.services.appearance_preferences_postgres import PostgresAppearancePreferencesRepository
    return PostgresAppearancePreferencesRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"}, connect=lambda _url: connection
    )


def test_compact_player_style_is_canonical_and_defaults_to_docked():
    from music_app.services.appearance_preferences_postgres import expand_appearance_preferences

    base = {"main_surface_color": None, "panel_background_color": None}
    assert expand_appearance_preferences(base)["compact_player_style"] == "docked"
    assert expand_appearance_preferences({**base, "compact_player_style": "floating"})["compact_player_style"] == "floating"


def test_repository_scopes_appearance_to_server_selected_client_profile():
    connection = Connection(None)

    _repository(connection).load_preferences(account_id=41, client_profile="desktop")

    sql, params = connection.operations[0]
    assert "client_profile = %s" in sql
    assert tuple(params) == (41, "desktop")


def test_desktop_and_private_web_share_one_appearance_profile():
    from music_app.services.appearance_preferences_postgres import appearance_client_profile

    assert appearance_client_profile("private_web") == "desktop"
    assert appearance_client_profile("desktop") == "desktop"
    assert appearance_client_profile("mobile") == "mobile"
    assert appearance_client_profile("tv") == "tv"


def test_invalid_compact_style_is_rejected_for_legacy_and_canonical_payloads():
    import pytest
    from music_app.services.appearance_preferences_postgres import normalize_appearance_preferences

    legacy = {"main_surface_color": None, "panel_background_color": None}
    canonical = {**legacy, "palette_id": None, "panel_index": 0, "player_override": None}
    for payload in ({**legacy, "compact_player_style": "unknown"}, {**canonical, "compact_player_style": "unknown"}):
        with pytest.raises(ValueError, match="compact player style"):
            normalize_appearance_preferences(payload)


def test_legacy_compact_write_persists_style_without_replacing_other_appearance_fields():
    row = {
        "main_surface_color": "#123456", "panel_background_color": None,
        "palette_id": None, "panel_index": 0,
        "player_background_color": "#112820", "player_waveform_fill_color": "#79B390",
        "player_waveform_edge_color": "#DCEBE3", "waveform_recent_colors": [],
        "compact_player_style": "floating",
    }
    connection = Connection(row)

    result = _repository(connection).save_preferences(account_id=41, preferences={
        "main_surface_color": "#123456", "panel_background_color": None,
        "compact_player_style": "floating",
    })

    sql, params = connection.operations[0]
    assert result["compact_player_style"] == "floating"
    assert "compact_player_style = excluded.compact_player_style" in sql
    assert tuple(params) == (41, "desktop", "#123456", None, "floating")


def test_canonical_compact_write_inserts_revision_but_no_unprovided_aggregate_columns():
    row = {
        "main_surface_color": None, "panel_background_color": None,
        "palette_id": None, "panel_index": 0,
        "player_background_color": None, "player_waveform_fill_color": None,
        "player_waveform_edge_color": None, "waveform_recent_colors": [],
        "compact_player_style": "floating",
    }
    connection = Connection(row)

    _repository(connection).save_preferences(account_id=41, preferences={
        "main_surface_color": None, "panel_background_color": None,
        "palette_id": None, "panel_index": 0, "player_override": None,
        "compact_player_style": "floating",
    })

    sql, _params = connection.operations[0]
    insert_columns = sql.split("select account_id", 1)[0]
    assert "revision" in insert_columns
    assert "revision = saved.revision + 1" in sql
    assert "interaction_overrides" not in insert_columns


def test_appearance_http_boundary_uses_only_the_server_policy_classification():
    from types import SimpleNamespace
    from music_app.routes.appearance_asgi import _client_profile

    request = SimpleNamespace(state=SimpleNamespace(policy_evaluation=SimpleNamespace(
        audit=SimpleNamespace(client_surface_class="private_web")
    )))
    assert _client_profile(request) == "desktop"


def test_migration_moves_existing_rows_to_desktop_and_keys_each_account_profile():
    from pathlib import Path

    sql = (Path(__file__).parents[2] / "migrations/postgres/0056_compact_player_appearance_profiles.sql").read_text(encoding="utf-8").lower()
    assert "client_profile text not null default 'desktop'" in sql
    assert "primary key (account_id, client_profile)" in sql
    assert "compact_player_style text not null default 'docked'" in sql


def test_compact_sidebar_defaults_and_explicit_values_are_canonical():
    from music_app.services.appearance_preferences_postgres import expand_appearance_preferences

    base = {"main_surface_color": None, "panel_background_color": None}
    defaults = expand_appearance_preferences(base)
    assert defaults["docked_compact_player_regular_style"] is False
    assert defaults["compact_player_motion"] == "normal"
    assert defaults["floating_player_edge"] == {"source": "player", "color": None}
    for behavior in ("follow_sidebar", "float_on_collapse", "artbox", "stay_docked"):
        value = expand_appearance_preferences({
            **base, "palette_id": None, "panel_index": 0, "player_override": None,
            "compact_player_style": "docked", "docked_compact_player_behavior": behavior,
            "docked_compact_player_regular_style": True,
            "compact_player_motion": "slow",
            "floating_player_edge": {"source": "custom", "color": "#123abc"},
        })
        assert value["docked_compact_player_behavior"] == behavior
        assert value["docked_compact_player_regular_style"] is True
        assert value["compact_player_motion"] == "slow"
        assert value["floating_player_edge"] == {"source": "custom", "color": "#123ABC"}


def test_compact_sidebar_optional_fields_preserve_omission_in_old_writes():
    from music_app.services.appearance_preferences_postgres import normalize_appearance_preferences

    base = {"main_surface_color": None, "panel_background_color": None}
    for payload in (base, {**base, "compact_player_style": "floating"},
                    {**base, "palette_id": None, "panel_index": 0, "player_override": None}):
        value = normalize_appearance_preferences(payload)
        assert "docked_compact_player_regular_style" not in value
        assert "compact_player_motion" not in value
        assert "floating_player_edge" not in value


def test_compact_sidebar_rejects_invalid_closed_preferences():
    import pytest
    from music_app.services.appearance_preferences_postgres import normalize_appearance_preferences

    base = {"main_surface_color": None, "panel_background_color": None,
            "palette_id": None, "panel_index": 0, "player_override": None,
            "compact_player_style": "docked"}
    invalid = [
        ("docked_compact_player_behavior", "unknown"),
        ("docked_compact_player_regular_style", None),
        ("docked_compact_player_regular_style", "true"),
        ("docked_compact_player_regular_style", 1),
        ("compact_player_motion", "fast"), ("compact_player_motion", None),
        ("compact_player_motion", True),
        *[("floating_player_edge", edge) for edge in (
            None, "theme", {}, {"source": "custom"}, {"source": "theme", "color": "#123456"},
            {"source": "player", "color": "#123456"}, {"source": "custom", "color": None},
            {"source": "custom", "color": "#123"}, {"source": "custom", "color": "#12345678"},
            {"source": "unknown", "color": None}, {"source": "player", "color": None, "extra": True},
        )],
    ]
    for key, value in invalid:
        with pytest.raises(ValueError):
            normalize_appearance_preferences({**base, key: value})
    for source in ("player", "theme"):
        value = normalize_appearance_preferences({
            **base, "floating_player_edge": {"source": source, "color": None},
        })
        assert value["floating_player_edge"] == {"source": source, "color": None}
