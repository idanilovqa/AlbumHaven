"""Real SQL proof on an explicitly provisioned, uniquely owned verification DB."""
import os
from pathlib import Path
import uuid

import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.test_library_source_appearance import CUSTOM, DEFAULT, FIELD, aggregate
from music_app.services.appearance_preferences_postgres import (
    AppearanceRevisionConflict,
    PostgresAppearancePreferencesRepository,
    resolve_appearance_device_section,
)


@pytest.fixture(scope="module")
def database():
    setup = os.environ.get("ALBUM_HAVEN_APPEARANCE_VERIFY_SETUP_DATABASE_URL", "")
    runtime = os.environ.get("ALBUM_HAVEN_APPEARANCE_VERIFY_DATABASE_URL", "")
    if not setup or not runtime:
        pytest.skip("Requires uniquely provisioned Appearance verification database")
    setup, runtime = isolatedPostgres.resolve_isolated_database_urls({
        isolatedPostgres.SETUP_DATABASE_ENV: setup,
        isolatedPostgres.RUNTIME_DATABASE_ENV: runtime,
    })
    assert isolatedPostgres._database_name(setup).startswith("album_haven_ci_mrverify_")
    lock = isolatedPostgres.IsolatedDatabaseOwnershipLock(database_url=setup)
    lock.acquire()
    try:
        for url, role in ((setup, isolatedPostgres.SETUP_ROLE), (runtime, isolatedPostgres.RUNTIME_ROLE)):
            with isolatedPostgres._connect(url) as connection:
                isolatedPostgres._assert_connected_role(connection, role)
        yield setup, runtime
    finally:
        lock.release()


@pytest.fixture
def account(database):
    setup, runtime = database
    name = "appearance-verify-" + uuid.uuid4().hex
    with isolatedPostgres._connect(setup) as connection:
        account_id = connection.execute(
            "insert into app.accounts(display_name,username_display,username_normalized,contact_email,contact_email_normalized) "
            "values(%s,%s,%s,%s,%s) returning id",
            (name, name, name, name + "@example.test", name + "@example.test"),
        ).fetchone()["id"]
    try:
        yield account_id, PostgresAppearancePreferencesRepository({"ALBUM_HAVEN_APP_DATABASE_URL": runtime})
    finally:
        with isolatedPostgres._connect(setup) as connection:
            connection.execute("delete from app.accounts where id=%s", (account_id,))


def test_live_source_defaults_save_reload_legacy_revision_and_profiles(account):
    account_id, repository = account
    assert repository.load_preferences(account_id=account_id)[FIELD] == DEFAULT
    saved = repository.save_preferences(account_id=account_id, preferences=aggregate(**{FIELD: CUSTOM}), expected_revision=0)
    assert saved[FIELD] == CUSTOM
    assert saved["revision"] == 1
    assert repository.load_preferences(account_id=account_id)[FIELD] == CUSTOM
    legacy = repository.save_preferences(account_id=account_id, preferences=aggregate(), expected_revision=1)
    assert legacy[FIELD] == CUSTOM
    assert legacy["revision"] == 2
    with pytest.raises(AppearanceRevisionConflict):
        repository.save_preferences(account_id=account_id, preferences=aggregate(**{FIELD: DEFAULT}), expected_revision=1)
    assert repository.load_preferences(account_id=account_id)[FIELD] == CUSTOM
    profile = repository.save_device_profiles(
        account_id=account_id, preferences=aggregate(), expected_revision=2,
        action_button_outlines=True,
        device_profiles={"mobile": {"album": {"mode": "custom", "values": {FIELD: DEFAULT}}}},
    )
    assert profile[FIELD] == CUSTOM
    loaded = repository.load_device_profiles(account_id=account_id)
    resolved = resolve_appearance_device_section(
        loaded["device_profiles"], profile="mobile", section="album", base_preferences=loaded,
    )
    assert resolved[FIELD] == DEFAULT
    assert repository.load_preferences(account_id=account_id)[FIELD] == CUSTOM


def test_live_source_migration_is_idempotent_and_constraint_rejects_invalid_json(database, account):
    from psycopg.errors import CheckViolation
    from psycopg.types.json import Jsonb

    setup, runtime = database
    account_id, repository = account
    migration = Path(__file__).resolve().parents[2] / "migrations/postgres/0080_library_source_indicators.sql"
    for _ in range(2):
        with isolatedPostgres._connect(setup) as connection:
            connection.execute(migration.read_text(encoding="utf-8"))
    repository.save_preferences(account_id=account_id, preferences=aggregate(), expected_revision=0)
    assert repository.load_preferences(account_id=account_id)[FIELD] == DEFAULT
    for invalid in ({}, dict.fromkeys(DEFAULT, False), {**DEFAULT, "icons": None}, {**DEFAULT, "extra": True}):
        with pytest.raises(CheckViolation):
            with isolatedPostgres._connect(runtime) as connection:
                connection.execute(
                    "update app.user_appearance_preferences set library_source_indicators=%s where account_id=%s",
                    (Jsonb(invalid), account_id),
                )
    assert repository.load_preferences(account_id=account_id)[FIELD] == DEFAULT
