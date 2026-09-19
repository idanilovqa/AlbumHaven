"""Real account/profile storage and atomic authorization for the A/B choice."""

import os
import re
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from urllib.parse import urlparse

import pytest

from music_app.services import appearance_preferences_postgres as appearance
from tests.py.test_settings_loop_style_preferences import aggregate_write


@pytest.fixture
def style_store():
    import psycopg

    runtime = os.environ.get("ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL", "")
    if not runtime:
        pytest.skip("Requires the isolated Postgres contract database.")
    setup = os.environ.get("DATABASE_MIGRATOR_URL", "")
    target = urlparse(runtime)
    assert target.hostname in {"localhost", "127.0.0.1", "::1"}
    assert re.fullmatch(r"(?:album_haven_ci_|pytest_|album_haven_fake_e2e)[a-z0-9_]*", target.path[1:])
    assert setup and urlparse(setup).hostname == target.hostname
    assert urlparse(setup).path == target.path
    accounts = []
    try:
        with psycopg.connect(setup) as connection:
            for _ in range(2):
                name = "settings-style-" + uuid.uuid4().hex
                accounts.append(connection.execute(
                    """insert into app.accounts
                       (display_name,username_display,username_normalized,contact_email,contact_email_normalized)
                       values(%s,%s,%s,%s,%s) returning id""",
                    (name, name, name, name + "@example.test", name + "@example.test"),
                ).fetchone()[0])
        yield appearance.PostgresAppearancePreferencesRepository(
            {"ALBUM_HAVEN_APP_DATABASE_URL": runtime}
        ), accounts
    finally:
        with psycopg.connect(setup) as connection:
            for account in accounts:
                connection.execute("delete from app.accounts where id=%s", (account,))


def save(repository, account, *, revision=0, allowed=True, **changes):
    return repository.save_preferences(
        account_id=account, preferences=aggregate_write(**changes),
        expected_revision=revision, allow_loop_control_style=allowed,
    )


def test_style_round_trip_is_account_and_client_profile_owned(style_store):
    repository, (account, other) = style_store
    saved = save(repository, account, loop_control_style="companion")
    assert saved["loop_control_style"] == "companion"
    assert repository.load_preferences(account_id=account)["loop_control_style"] == "companion"
    assert repository.load_preferences(account_id=other)["loop_control_style"] == "capsule"
    assert repository.load_preferences(account_id=account, client_profile="mobile")["loop_control_style"] == "capsule"


def test_denied_style_change_does_not_write_any_part_of_the_aggregate(style_store):
    repository, (account, _) = style_store
    before = save(repository, account, loop_control_style="companion")
    with pytest.raises(appearance.AppearanceLoopStyleForbidden):
        save(repository, account, revision=before["revision"], allowed=False,
             loop_control_style="capsule", main_surface_color="#102030")
    assert repository.load_preferences(account_id=account) == before


def test_unchanged_and_omitted_style_allow_unrelated_edits_after_grant_loss(style_store):
    repository, (account, _) = style_store
    before = save(repository, account, loop_control_style="companion")
    same = save(repository, account, revision=before["revision"], allowed=False,
                loop_control_style="companion", main_surface_color="#102030")
    omitted = save(repository, account, revision=same["revision"], allowed=False,
                   main_surface_color="#203040")
    assert omitted["loop_control_style"] == "companion"
    assert omitted["main_surface_color"] == "#203040"
    assert omitted["revision"] == before["revision"] + 2


def test_missing_row_uses_capsule_as_comparison_default_without_grant(style_store):
    repository, (account, _) = style_store
    with pytest.raises(appearance.AppearanceLoopStyleForbidden):
        save(repository, account, allowed=False, loop_control_style="companion")
    assert repository.load_preferences(account_id=account)["revision"] == 0
    assert save(repository, account, allowed=False,
                loop_control_style="capsule")["loop_control_style"] == "capsule"


def test_old_background_writer_preserves_the_saved_loop_choice(style_store):
    repository, (account, _) = style_store
    before = save(repository, account, loop_control_style="companion")
    result = repository.save_preferences(account_id=account, preferences={
        "main_surface_color": "#102030", "panel_background_color": None,
    })
    assert result["loop_control_style"] == "companion"
    assert result["revision"] == before["revision"] + 1


def test_two_same_revision_style_saves_have_exactly_one_winner(style_store):
    repository, (account, _) = style_store
    before = save(repository, account, loop_control_style="capsule")
    barrier = Barrier(2)

    def attempt(color):
        barrier.wait(timeout=5)
        try:
            return save(repository, account, revision=before["revision"],
                        loop_control_style="companion", main_surface_color=color)
        except appearance.AppearanceRevisionConflict:
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(attempt, ["#102030", "#203040"]))
    winners = [result for result in results if result is not None]
    assert len(winners) == 1
    assert repository.load_preferences(account_id=account) == winners[0]
    assert winners[0]["revision"] == before["revision"] + 1


def test_stale_denied_style_write_returns_current_revision_without_overwriting(style_store):
    repository, (account, _) = style_store
    first = save(repository, account, loop_control_style="capsule")
    current = save(repository, account, revision=first["revision"], loop_control_style="companion")
    with pytest.raises(appearance.AppearanceRevisionConflict) as conflict:
        save(repository, account, revision=first["revision"], allowed=False,
             loop_control_style="capsule", main_surface_color="#203040")
    assert conflict.value.current == current
    assert repository.load_preferences(account_id=account) == current


def test_legacy_palette_write_preserves_style_and_profile_owned_writes_do_not_cross(style_store):
    repository, (account, _) = style_store
    desktop = save(repository, account, loop_control_style="companion")
    mobile = repository.save_preferences(
        account_id=account, client_profile="mobile", expected_revision=0,
        preferences=aggregate_write(loop_control_style="capsule"),
        allow_loop_control_style=False,
    )
    assert mobile["loop_control_style"] == "capsule"
    result = repository.save_preferences(account_id=account, preferences={
        "main_surface_color": None, "panel_background_color": None,
        "palette_id": "harbor-mint", "panel_index": 0, "player_override": None,
    })
    assert result["loop_control_style"] == "companion"
    assert result["revision"] == desktop["revision"] + 1
    assert repository.load_preferences(account_id=account, client_profile="mobile") == mobile
