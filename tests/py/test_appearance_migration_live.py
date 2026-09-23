"""Upgrade actual legacy appearance data through the production migrations."""

from pathlib import Path

import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import (
    _dedicated_database_urls_or_skip, _drop_application_schemas,
)


@pytest.mark.parametrize("existing_profile", [None, "desktop", "mobile"])
@pytest.mark.parametrize("enabled", [False, True])
def test_live_legacy_selection_accent_survives_aggregate_upgrade(
    monkeypatch, existing_profile, enabled,
):
    from music_app.services.selection_accent import PostgresSelectionAccentStore

    setup_url, _ = _dedicated_database_urls_or_skip(monkeypatch)
    from psycopg.types.json import Jsonb
    migrations = sorted((Path(__file__).resolve().parents[2] / "migrations" / "postgres").glob("*.sql"))
    legacy = [path for path in migrations if path.name < "0057_"]
    upgrade = [path for path in migrations if path.name >= "0057_"]
    assert legacy[-1].name.startswith("0056_")
    assert upgrade[0].name == "0057_aggregate_appearance_workspace.sql"
    metadata = {"retained_setting": "unchanged", "appearance_selection_accent_v1": {
        "enabled": enabled, "color": "#ab09fe",
    }}
    try:
        _drop_application_schemas(setup_url)
        with isolatedPostgres._connect(setup_url) as connection:
            for path in legacy:
                connection.execute(path.read_text(encoding="utf-8"))
            account_id = connection.execute("""
                insert into app.accounts (display_name, account_kind,
                    username_display, username_normalized,
                    contact_email, contact_email_normalized, metadata)
                values ('Legacy Accent', 'managed_user', 'legacy-accent', 'legacy-accent',
                    'legacy-accent@example.test', 'legacy-accent@example.test', %s)
                returning id
            """, (Jsonb(metadata),)).fetchone()["id"]
            control_id = connection.execute("""
                insert into app.accounts (display_name, account_kind,
                    username_display, username_normalized,
                    contact_email, contact_email_normalized)
                values ('No Accent', 'managed_user', 'no-accent', 'no-accent',
                    'no-accent@example.test', 'no-accent@example.test') returning id
            """).fetchone()["id"]
            if existing_profile:
                connection.execute("""
                    insert into app.user_appearance_preferences
                        (account_id, client_profile, main_surface_color, compact_player_style)
                    values (%s, %s, '#123456', 'floating')
                """, (account_id, existing_profile))
        with isolatedPostgres._connect(setup_url) as connection:
            for path in upgrade:
                connection.execute(path.read_text(encoding="utf-8"))
        with isolatedPostgres._connect(setup_url) as connection:
            row = connection.execute("""select * from app.user_appearance_preferences
                where account_id = %s and client_profile = 'desktop'""", (account_id,)).fetchone()
            assert row is not None, "An accent-only account needs its desktop preference migrated"
            assert row["selection_accent"] == {"enabled": enabled, "color": "#AB09FE"}
            assert row["main_surface_color"] == ("#123456" if existing_profile == "desktop" else None)
            assert row["compact_player_style"] == ("floating" if existing_profile == "desktop" else "docked")
            assert connection.execute("select metadata from app.accounts where id = %s", (account_id,)).fetchone()["metadata"] == metadata
            assert connection.execute("select count(*) as n from app.user_appearance_preferences where account_id = %s", (control_id,)).fetchone()["n"] == 0
            if existing_profile == "mobile":
                mobile = connection.execute("""select main_surface_color, compact_player_style
                    from app.user_appearance_preferences where account_id = %s and client_profile = 'mobile'""", (account_id,)).fetchone()
                assert mobile == {"main_surface_color": "#123456", "compact_player_style": "floating"}
        store = PostgresSelectionAccentStore({"ALBUM_HAVEN_APP_DATABASE_URL": setup_url}, connect=isolatedPostgres._connect)
        assert store.load(account_id) == {"enabled": enabled, "color": "#ab09fe"}
        assert store.load(control_id) is None
    finally:
        # This fixture owns all schemas in a validated disposable database.
        _drop_application_schemas(setup_url)
        isolatedPostgres.apply_all_migrations(setup_url)


def test_live_parchment_pine_migration_preserves_all_existing_preferences(monkeypatch):
    """The additive palette allowlist must not rewrite an existing preference."""
    from uuid import uuid4

    setup_url, _ = _dedicated_database_urls_or_skip(monkeypatch)
    migrations = sorted((Path(__file__).resolve().parents[2] / "migrations" / "postgres").glob("*.sql"))
    upgrade = Path(__file__).resolve().parents[2] / "migrations" / "postgres" / "0077_allow_parchment_pine_appearance_palette.sql"
    assert upgrade.is_file()
    cases = [
        (None, None, None, None),
        (None, "#123456", "#654321", None),
        ("paper", None, None, None),
        ("harbor-mint", None, None, {"background": "#123456", "fill": "#ABCDEF", "edge": "#987654"}),
    ]
    try:
        _drop_application_schemas(setup_url)
        with isolatedPostgres._connect(setup_url) as connection:
            for path in migrations:
                if path.name < upgrade.name:
                    connection.execute(path.read_text(encoding="utf-8"))
            for index, (palette, main, panel, player) in enumerate(cases):
                name = f"pine-{uuid4().hex}"
                account_id = connection.execute("""
                    insert into app.accounts (display_name, account_kind,
                        username_display, username_normalized,
                        contact_email, contact_email_normalized)
                    values (%s, 'managed_user', %s, %s, %s, %s) returning id
                """, (name, name, name, f"{name}@example.test", f"{name}@example.test")).fetchone()["id"]
                connection.execute("""
                    insert into app.user_appearance_preferences
                        (account_id, client_profile, palette_id, main_surface_color,
                         panel_background_color, player_background_color,
                         player_waveform_fill_color, player_waveform_edge_color, revision)
                    values (%s, 'desktop', %s, %s, %s, %s, %s, %s, %s)
                """, (account_id, palette, main, panel,
                      *((player or {}).get(role) for role in ('background', 'fill', 'edge')),
                      index + 2))
            before = connection.execute("""
                select * from app.user_appearance_preferences order by account_id, client_profile
            """).fetchall()
            assert len(before) == len(cases)
            connection.execute(upgrade.read_text(encoding="utf-8"))
            after = connection.execute("""
                select * from app.user_appearance_preferences order by account_id, client_profile
            """).fetchall()
            assert after == before
            for panel_index in [0, 1, 2]:
                connection.execute("""
                    update app.user_appearance_preferences
                    set palette_id = 'parchment-pine', panel_index = %s,
                        main_surface_color = null, panel_background_color = null
                    where account_id = %s and client_profile = 'desktop'
                """, (panel_index, before[0]["account_id"]))
                row = connection.execute("""
                    select palette_id, panel_index from app.user_appearance_preferences
                    where account_id = %s and client_profile = 'desktop'
                """, (before[0]["account_id"],)).fetchone()
                assert row == {"palette_id": "parchment-pine", "panel_index": panel_index}
    finally:
        # The shared fixture validates this database as disposable before use.
        _drop_application_schemas(setup_url)
        isolatedPostgres.apply_all_migrations(setup_url)


def test_live_sidebar_migration_preserves_rows_and_revisions(monkeypatch):
    from uuid import uuid4

    setup_url, _ = _dedicated_database_urls_or_skip(monkeypatch)
    directory = Path(__file__).resolve().parents[2] / "migrations" / "postgres"
    upgrade = directory / "0078_add_compact_player_motion_and_floating_edge.sql"
    assert upgrade.is_file()
    try:
        _drop_application_schemas(setup_url)
        with isolatedPostgres._connect(setup_url) as connection:
            for path in sorted(directory.glob("*.sql")):
                if path.name < upgrade.name:
                    connection.execute(path.read_text(encoding="utf-8"))
            for index, behavior in enumerate(("follow_sidebar", "stay_docked")):
                name = f"sidebar-{uuid4().hex}"
                owner = connection.execute("""
                    insert into app.accounts (display_name, account_kind,
                        username_display, username_normalized, contact_email, contact_email_normalized)
                    values (%s, 'managed_user', %s, %s, %s, %s) returning id
                """, (name, name, name, f"{name}@example.test", f"{name}@example.test")).fetchone()["id"]
                for profile in ("desktop", "mobile", "tv"):
                    connection.execute("""
                        insert into app.user_appearance_preferences
                            (account_id, client_profile, palette_id, revision,
                             compact_player_style, docked_compact_player_behavior)
                        values (%s, %s, 'parchment-pine', %s, 'docked', %s)
                    """, (owner, profile, index + 9, behavior))
            before = connection.execute(
                "select * from app.user_appearance_preferences order by account_id, client_profile"
            ).fetchall()
            connection.execute(upgrade.read_text(encoding="utf-8"))
            after = connection.execute(
                "select * from app.user_appearance_preferences order by account_id, client_profile"
            ).fetchall()
            assert len(after) == 6
            for old, new in zip(before, after):
                assert {key: new[key] for key in old} == old
                assert new["compact_player_motion"] == "normal"
                assert new["floating_player_edge"] == {"source": "player", "color": None}
    finally:
        _drop_application_schemas(setup_url)
        isolatedPostgres.apply_all_migrations(setup_url)
