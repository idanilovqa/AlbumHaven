"""Real lock and unique-conflict coverage for concurrent appearance saves."""

from copy import deepcopy
from threading import Event, Thread
from time import monotonic

import pytest

from music_app.services.appearance_preferences_postgres import (
    AppearanceRevisionConflict,
    PostgresAppearancePreferencesRepository,
)
from tests.e2e.support import isolatedPostgres
from tests.py.test_appearance_preferences_postgres import CLASSIC_GREEN_PLAYER_STYLE, aggregate_write
from tests.py.test_auth_locking_live import auth_lock_inventory


@pytest.mark.parametrize("existing", [False, True], ids=["first-use", "existing-revision"])
def test_live_competing_appearance_saves_keep_only_winner(auth_lock_inventory, existing):
    fixture = auth_lock_inventory
    repository = PostgresAppearancePreferencesRepository(fixture.config)
    seed_style = deepcopy(CLASSIC_GREEN_PLAYER_STYLE)
    if existing:
        repository.save_preferences(account_id=fixture.target_id,
            preferences=aggregate_write(player_style_override=seed_style, applied_player_set=seed_style,
                waveform_color_updates=["#010203"]), expected_revision=0)
    else:
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            assert connection.execute("select count(*) as n from app.user_appearance_preferences where account_id = %s",
                (fixture.target_id,)).fetchone()["n"] == 0
    revision = 1 if existing else 0
    payloads = {}
    for name, color, family in (("winner", "#112233", "signal"), ("loser", "#ABCDEF", "quiet")):
        style = deepcopy(CLASSIC_GREEN_PLAYER_STYLE)
        style["handles"]["color"] = color
        payloads[name] = aggregate_write(main_surface_color=color, panel_background_color=color,
            alert_family=family, player_style_override=style, applied_player_set=style,
            waveform_color_updates=[color])
    winner_written, release_winner, loser_connected = Event(), Event(), Event()
    backends, results, failures = {}, {}, {}

    class HeldCommit:
        def __init__(self, connection):
            self.connection = connection

        def __enter__(self):
            self.connection.__enter__()
            return self

        def __getattr__(self, name):
            return getattr(self.connection, name)

        def __exit__(self, exc_type, exc, traceback):
            if exc_type is None:
                winner_written.set()
                if not release_winner.wait(10):
                    self.connection.rollback()
                    self.connection.close()
                    raise AssertionError("winner commit was not released")
            return self.connection.__exit__(exc_type, exc, traceback)

    def save(name):
        def connect(_url):
            connection = isolatedPostgres._connect(fixture.runtime_url)
            connection.execute("set statement_timeout = '8s'")
            connection.commit()
            backends[name] = connection.info.backend_pid
            if name == "loser":
                loser_connected.set()
                return connection
            return HeldCommit(connection)
        try:
            results[name] = PostgresAppearancePreferencesRepository(fixture.config, connect=connect).save_preferences(
                account_id=fixture.target_id, preferences=payloads[name], expected_revision=revision)
        except BaseException as error:
            failures[name] = error

    winner = Thread(target=save, args=("winner",))
    loser = Thread(target=save, args=("loser",))
    winner.start()
    try:
        assert winner_written.wait(3), f"winner did not reach commit: {failures!r}"
        loser.start()
        assert loser_connected.wait(2), f"loser did not connect: {failures!r}"
        blocked = False
        with isolatedPostgres._connect(fixture.setup_url) as inspect:
            deadline = monotonic() + 3
            while monotonic() < deadline:
                blocked = inspect.execute("select %s = any(pg_blocking_pids(%s)) as blocked",
                    (backends["winner"], backends["loser"])).fetchone()["blocked"]
                if blocked:
                    break
                Event().wait(0.01)
        assert blocked, "competing save never reached the winner's real PostgreSQL lock"
    finally:
        release_winner.set()
        winner.join(12)
        if loser.ident is not None:
            loser.join(12)
        assert not winner.is_alive() and not loser.is_alive(), "workers must exit before fixture teardown"
    assert set(results) == {"winner"}
    assert set(failures) == {"loser"}
    assert isinstance(failures["loser"], AppearanceRevisionConflict)
    saved = repository.load_preferences(account_id=fixture.target_id)
    assert failures["loser"].current == results["winner"] == saved
    assert saved["revision"] == revision + 1
    assert saved["main_surface_color"] == saved["panel_background_color"] == "#112233"
    assert saved["alert_family"] == "signal"
    assert saved["player_style_override"] == payloads["winner"]["player_style_override"]
    assert saved["player_recent_sets"] == [payloads["winner"]["player_style_override"], *([seed_style] if existing else [])]
    assert saved["waveform_recent_colors"] == ["#112233", *(["#010203"] if existing else [])]
