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
