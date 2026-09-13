"""Live constraint coverage; uses only a transaction-owned temporary table."""
import json
import os
from pathlib import Path

import pytest

psycopg = pytest.importorskip("psycopg")
_DATABASE_URL = os.environ.get("ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL", "")


@pytest.mark.skipif(not _DATABASE_URL, reason="Live Postgres contract database required")
@pytest.mark.parametrize("outline, valid", [(None, True), ("#55C7FF", True), ("red", False), ("#123", False), (123, False), ({}, False)])
def test_panel_outline_live_constraint_accepts_only_nullable_rgb(outline, valid):
    with psycopg.connect(_DATABASE_URL) as connection:
        connection.execute("create temporary table outline_contract (like app.user_appearance_preferences including defaults including constraints) on commit drop")
        overrides = {"item_hover": None, "item_selected": None, "button_hover_background": None, "button_pressed": None, "item_outline": {"source": "automatic", "color": None}, "panel_outline": outline}
        def insert():
            connection.execute("insert into outline_contract(account_id, client_profile, interaction_overrides) values (1, 'desktop', %s::jsonb)", (json.dumps(overrides),))
        if valid:
            insert()
            assert connection.execute("select interaction_overrides->'panel_outline' from outline_contract").fetchone()[0] == outline
        else:
            with pytest.raises(psycopg.errors.CheckViolation) as error:
                insert()
            assert error.value.diag.constraint_name == "user_appearance_aggregate_shape"
        connection.rollback()


@pytest.mark.skipif(not _DATABASE_URL, reason="Live Postgres contract database required")
def test_panel_outline_migration_preserves_legacy_rows_and_rejects_unknown_keys():
    migration = (Path(__file__).resolve().parents[2] / "migrations/postgres/0066_allow_appearance_panel_outline.sql").read_text(encoding="utf-8")
    with psycopg.connect(_DATABASE_URL) as connection:
        connection.execute("create temporary table outline_contract (like app.user_appearance_preferences including defaults including constraints) on commit drop")
        old_sql = (Path(__file__).resolve().parents[2] / "migrations/postgres/0060_player_aware_interaction_outline.sql").read_text(encoding="utf-8")
        start = old_sql.index("alter table app.user_appearance_preferences\n  add constraint user_appearance_aggregate_shape")
        end = old_sql.index("\n  );", start) + len("\n  );")
        connection.execute("alter table outline_contract drop constraint user_appearance_aggregate_shape")
        connection.execute(old_sql[start:end].replace("app.user_appearance_preferences", "pg_temp.outline_contract"))
        connection.execute("insert into outline_contract(account_id, client_profile) values (1, 'desktop')")
        before = connection.execute("select to_jsonb(outline_contract) from outline_contract").fetchone()[0]
        connection.execute(migration.replace("app.user_appearance_preferences", "pg_temp.outline_contract"))
        assert connection.execute("select to_jsonb(outline_contract) from outline_contract").fetchone()[0] == before
        with pytest.raises(psycopg.errors.CheckViolation) as error:
            connection.execute("update outline_contract set interaction_overrides = interaction_overrides || '{\"unknown_key\":null}'::jsonb")
        connection.rollback()
