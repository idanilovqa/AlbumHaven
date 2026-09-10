"""Compatibility appearance APIs must obey the migrated Postgres schema."""

import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import (
    _dedicated_database_urls_or_skip, _drop_application_schemas,
)


@pytest.fixture
def appearance_database(monkeypatch):
    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    _drop_application_schemas(setup_url)
    isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
    try:
        with isolatedPostgres._connect(setup_url) as connection:
            owner = connection.execute("select account_id from app.bootstrap_owners where owner_key = 'local-bootstrap-owner'").fetchone()["account_id"]
            peer = connection.execute("""insert into app.accounts (
                display_name, account_kind, username_display, username_normalized,
                contact_email, contact_email_normalized
                ) values ('Appearance compatibility peer', 'managed', 'appearance-compatibility-peer',
                          'appearance-compatibility-peer', 'appearance-compatibility-peer@example.test',
                          'appearance-compatibility-peer@example.test') returning id""").fetchone()["id"]
            connection.execute("""insert into app.user_appearance_preferences
                (account_id, client_profile, main_surface_color, revision)
                values (%s, 'mobile', '#123456', 8), (%s, 'desktop', '#ABCDEF', 11)""", (owner, peer))
            metadata = connection.execute("select id, metadata from app.accounts order by id").fetchall()
            others = connection.execute("select to_jsonb(saved) as row from app.user_appearance_preferences saved order by account_id, client_profile").fetchall()
        yield setup_url, runtime_url, owner
        with isolatedPostgres._connect(setup_url) as connection:
            assert connection.execute("select id, metadata from app.accounts order by id").fetchall() == metadata
            assert connection.execute("select to_jsonb(saved) as row from app.user_appearance_preferences saved where account_id <> %s or client_profile <> 'desktop' order by account_id, client_profile", (owner,)).fetchall() == others
    finally:
        isolatedPostgres.reset_application_tables(setup_url)


@pytest.mark.parametrize("include_alert", [False, True])
def test_live_compatibility_palette_round_trip_preserves_provided_and_omitted_fields(appearance_database, include_alert):
    from music_app.services.appearance_preferences_postgres import PostgresAppearancePreferencesRepository
    setup_url, runtime_url, owner = appearance_database
    repository = PostgresAppearancePreferencesRepository({"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url}, connect=isolatedPostgres._connect)
    base = {"main_surface_color": None, "panel_background_color": None, "palette_id": "steelblue",
            "panel_index": 0, "player_override": None, "compact_player_style": "floating"}
    for revision, layout, animation, alert in [(1, "editorial_canvas", "disabled", "quiet"), (2, "stacked_bar", "enabled", "signal")]:
        requested = {**base, "album_details_layout": layout, "album_playing_row_animation": animation}
        if include_alert:
            requested["alert_family"] = alert
        saved = repository.save_preferences(account_id=owner, preferences=requested)
        assert saved["album_details_layout"] == layout
        assert saved["album_playing_row_animation"] == animation
        assert saved["alert_family"] == (alert if include_alert else "ember")
        assert saved["revision"] == revision
        assert repository.load_preferences(account_id=owner) == saved
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("""update app.user_appearance_preferences
            set interaction_overrides = jsonb_set(interaction_overrides, '{item_hover}', '"#123456"'::jsonb)
            where account_id = %s and client_profile = 'desktop'""", (owner,))
    omitted = repository.save_preferences(account_id=owner, preferences={**base, "palette_id": "paper"})
    assert omitted["album_details_layout"] == "stacked_bar"
    assert omitted["album_playing_row_animation"] == "enabled"
    assert omitted["alert_family"] == ("signal" if include_alert else "ember")
    assert omitted["interaction_overrides"]["item_hover"] == "#123456"
    assert omitted["revision"] == 3


@pytest.mark.parametrize("existing_row", [False, True])
def test_live_selection_accent_first_use_and_existing_row_preserve_aggregate_fields(appearance_database, existing_row):
    from music_app.services.selection_accent import PostgresSelectionAccentStore
    setup_url, runtime_url, owner = appearance_database
    if existing_row:
        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute("""insert into app.user_appearance_preferences
                (account_id, client_profile, main_surface_color, revision, album_details_layout)
                values (%s, 'desktop', '#123456', 9, 'editorial_canvas')""", (owner,))
    store = PostgresSelectionAccentStore({"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url}, connect=isolatedPostgres._connect)
    assert store.load(owner) == ({"enabled": True, "color": "#34ca78"} if existing_row else None)
    preference = {"enabled": False, "color": "#aB09Fe"}
    assert store.save(owner, preference) == {"enabled": False, "color": "#ab09fe"}
    assert store.load(owner) == {"enabled": False, "color": "#ab09fe"}
    with isolatedPostgres._connect(setup_url) as connection:
        row = connection.execute("select * from app.user_appearance_preferences where account_id = %s and client_profile = 'desktop'", (owner,)).fetchone()
    assert row["selection_accent"] == {"enabled": False, "color": "#AB09FE"}
    assert row["main_surface_color"] == ("#123456" if existing_row else None)
    assert row["album_details_layout"] == ("editorial_canvas" if existing_row else "classic_bar")
    assert row["revision"] == (10 if existing_row else 1)
    for operation in [lambda: store.load(owner + 100000), lambda: store.save(owner + 100000, preference)]:
        with pytest.raises(RuntimeError, match="account is unavailable"):
            operation()
