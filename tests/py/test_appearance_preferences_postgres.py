"""Validation and SQL ownership contracts for per-account appearance preferences."""

import pytest


DEFAULTS = {"main_surface_color": None, "panel_background_color": None}
EXTENDED_DEFAULTS = {"palette_id": None, "panel_index": 0, "player_override": None, "waveform_recent_colors": [], "compact_player_style": "docked"}


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

    assert result == {**(row or DEFAULTS), **EXTENDED_DEFAULTS}
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
    assert tuple(params) == (52, "desktop", "#12ABCD", "#FE019A")
    assert connection.closed


def test_repository_reset_writes_null_overrides_for_only_the_requested_account():
    connection = Connection(DEFAULTS)

    assert _repository(connection).save_preferences(account_id=41, preferences=DEFAULTS) == {**DEFAULTS, **EXTENDED_DEFAULTS}

    assert len(connection.operations) == 1
    assert tuple(connection.operations[0][1]) == (41, "desktop", None, None)
