"""Focused Postgres roundtrip and constraint coverage for player inheritance."""

import json

import pytest

from tests.py.test_appearance_preferences_postgres import CLASSIC_GREEN_PLAYER_STYLE, aggregate_write
from tests.py.test_isolated_postgres_live import (
    _dedicated_database_urls_or_skip,
    _drop_application_schemas,
    isolatedPostgres,
)


def test_live_native_player_components_roundtrip_and_constraints(monkeypatch):
    from music_app.services.appearance_preferences_postgres import PostgresAppearancePreferencesRepository
    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    psycopg = pytest.importorskip("psycopg")
    try:
        _drop_application_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
        with isolatedPostgres._connect(setup_url) as connection:
            account_id = int(connection.execute("select min(id) as id from app.accounts").fetchone()["id"])
        repository = PostgresAppearancePreferencesRepository({"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url})
        old_style = CLASSIC_GREEN_PLAYER_STYLE
        old_payload = aggregate_write(player_style_override=old_style, applied_player_set=old_style)
        repository.save_preferences(account_id=account_id, preferences=old_payload, expected_revision=0)
        assert repository.load_preferences(account_id=account_id)["player_style_override"] == old_style
        inherited = {**old_style, "native_components": ["surface", "waveform"]}
        payload = aggregate_write(player_style_override=inherited, applied_player_set=inherited)
        repository.save_preferences(account_id=account_id, preferences=payload, expected_revision=1)
        reloaded = repository.load_preferences(account_id=account_id)
        assert reloaded["player_style_override"] == inherited
        assert reloaded["player_recent_sets"] == [inherited, old_style]
        for native in (None, "surface", ["surface", "surface"], ["unknown"], [1], {}, ["surface", "controls", "waveform", "handles", "surface"]):
            invalid = {**old_style, "native_components": native}
            for column, value in (("player_style_override", invalid), ("player_recent_sets", [invalid])):
                with isolatedPostgres._connect(setup_url) as connection:
                    connection.autocommit = True
                    with pytest.raises(psycopg.errors.CheckViolation):
                        connection.execute(
                            f"update app.user_appearance_preferences set {column} = %s::jsonb where account_id = %s",
                            (json.dumps(value), account_id),
                        )
        assert repository.load_preferences(account_id=account_id) == reloaded
    finally:
        isolatedPostgres.reset_application_tables(setup_url)
