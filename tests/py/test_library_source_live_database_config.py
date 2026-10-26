from contextlib import nullcontext
from types import SimpleNamespace

import pytest

from tests.py import test_library_source_appearance_live as live


@pytest.mark.parametrize("suffix", ["mrverify_local_123", "py_contract_37218749498_1"])
def test_source_live_fixture_accepts_only_owned_verification_lanes(monkeypatch, suffix):
    setup = f"postgresql://album_haven_migrator_{suffix}@127.0.0.1/album_haven_ci_{suffix}"
    runtime = f"postgresql://album_haven_app_{suffix}@127.0.0.1/album_haven_ci_{suffix}"
    monkeypatch.setenv("ALBUM_HAVEN_APPEARANCE_VERIFY_SETUP_DATABASE_URL", setup)
    monkeypatch.setenv("ALBUM_HAVEN_APPEARANCE_VERIFY_DATABASE_URL", runtime)
    connected = []
    monkeypatch.setattr(live.isolatedPostgres, "IsolatedDatabaseOwnershipLock", lambda **kwargs: SimpleNamespace(acquire=lambda: None, release=lambda: None))
    monkeypatch.setattr(live.isolatedPostgres, "_connect", lambda url: connected.append(url) or nullcontext(object()))
    monkeypatch.setattr(live.isolatedPostgres, "_assert_connected_role", lambda *args: None)
    fixture = live.database.__wrapped__()
    assert next(fixture) == (setup, runtime)
    fixture.close()
    assert connected == [setup, runtime]


@pytest.mark.parametrize("suffix", ["py_37218749498_1", "py_contract_production", "sandbox3"])
def test_source_live_fixture_rejects_other_lanes_before_connecting(monkeypatch, suffix):
    monkeypatch.setenv("ALBUM_HAVEN_APPEARANCE_VERIFY_SETUP_DATABASE_URL", f"postgresql://album_haven_migrator_{suffix}@127.0.0.1/album_haven_ci_{suffix}")
    monkeypatch.setenv("ALBUM_HAVEN_APPEARANCE_VERIFY_DATABASE_URL", f"postgresql://album_haven_app_{suffix}@127.0.0.1/album_haven_ci_{suffix}")
    monkeypatch.setattr(live.isolatedPostgres, "_connect", lambda url: pytest.fail("Unowned database connection"))
    with pytest.raises((AssertionError, RuntimeError)):
        next(live.database.__wrapped__())
