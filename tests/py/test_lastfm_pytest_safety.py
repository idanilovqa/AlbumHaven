from __future__ import annotations

import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
import threading
from urllib.request import Request
import urllib.request

import pytest

from music_app.services import lastfm
from tests.py import conftest as python_test_config


class _LoopbackLastfmHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        payload = b'<lfm status="ok"></lfm>'
        self.send_response(200)
        self.send_header("Content-Type", "application/xml")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, _format: str, *_args: object) -> None:
        return


@pytest.fixture
def fixture_owned_lastfm_provider():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _LoopbackLastfmHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield {
            "api_root": f"http://127.0.0.1:{server.server_port}/2.0/",
            "api_key": "fixture-api-key",
            "api_secret": "fixture-api-secret",
        }
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.fixture
def fixture_owned_isolated_database(isolated_database_safety_token):
    return {
        "database_url": "postgresql://album_haven_app@localhost:5432/album_haven_fake_e2e",
        "pytest_isolated_database_safety_token": isolated_database_safety_token,
    }


def test_pytest_sets_safe_lastfm_and_database_sentinels_before_config_use():
    import config

    assert set(python_test_config._LASTFM_SENSITIVE_ENV_KEYS) == {
        "LASTFM_API_ENABLED",
        "LASTFM_API_KEY",
        "LASTFM_API_SECRET",
        "LASTFM_API_ROOT",
        "LASTFM_SESSION",
        "LASTFM_SESSION_KEY",
        "LASTFM_USERNAME",
    }
    assert os.environ["LASTFM_API_ENABLED"] == "false"
    assert all(os.environ[key] == "" for key in python_test_config._LASTFM_SENSITIVE_ENV_KEYS if key != "LASTFM_API_ENABLED")
    assert os.environ["ALBUM_HAVEN_APP_DATABASE_URL"] == ""
    python_test_config._assert_safe_runtime_config(config.Config)


def test_pytest_blocks_accidental_lastfm_outbound_http_by_default():
    with pytest.raises(AssertionError, match="Outbound Last.fm HTTP is blocked"):
        lastfm.urlopen(Request("https://ws.audioscrobbler.com/2.0/"), timeout=1)


def test_test_local_stub_cannot_restore_the_production_lastfm_transport(monkeypatch):
    calls = []
    monkeypatch.setattr(lastfm, "urlopen", lambda request, **_kwargs: calls.append(request.full_url) or "response")

    assert lastfm.urlopen(Request("https://example.invalid/2.0/"), timeout=1) == "response"
    assert calls == ["https://example.invalid/2.0/"]
    with pytest.raises(AssertionError, match="production transport is blocked"):
        lastfm._post_lastfm({}, "track.scrobble", {})

    monkeypatch.setattr(lastfm, "urlopen", urllib.request.urlopen)
    with pytest.raises(AssertionError, match="Outbound Last.fm HTTP is blocked"):
        lastfm.urlopen(Request("https://ws.audioscrobbler.com/2.0/"), timeout=1)


def test_loopback_validation_rejects_non_loopback_and_missing_port_roots():
    for api_root in ("https://last.fm/2.0/", "http://localhost/2.0/", "file:///tmp/lastfm"):
        with pytest.raises(pytest.UsageError, match=r"fixture-owned http\(s\) loopback URL"):
            python_test_config._validated_loopback_lastfm_root({"api_root": api_root})


def _attested_isolated_database(database_url: str) -> dict[str, object]:
    return {
        "database_url": database_url,
        "pytest_isolated_database_safety_token": python_test_config._ISOLATED_DATABASE_SAFETY_TOKEN,
    }


def test_database_validation_requires_fixture_owned_safety_attestation():
    database_url = "postgresql://album_haven_app@localhost/album_haven_fake_e2e"
    for database_fixture in (
        {"database_url": database_url},
        {"database_url": database_url, "pytest_isolated_database_safety_token": "trusted"},
        {"database_url": database_url, "pytest_isolated_database_safety_token": object()},
    ):
        with pytest.raises(pytest.UsageError, match="fixture-owned pytest isolated-database safety token"):
            python_test_config._validated_isolated_database_url(database_fixture)


def test_database_validation_rejects_owner_and_deceptive_database_names():
    for database_url in (
        "postgresql://owner@db.example/album_haven",
        "postgresql://owner@localhost/album_haven",
        "sqlite:///album_haven_test",
        "postgresql://owner@localhost/contest",
        "postgresql://owner@localhost/latest",
        "postgresql://owner@localhost/my_fake_prod",
        "postgresql://owner@localhost/album_haven_fake_e2e_backup",
        "postgresql://owner@localhost/prod_pytest_data",
        "postgresql://owner@localhost/pytest",
    ):
        with pytest.raises(pytest.UsageError, match="repo-managed isolated identity"):
            python_test_config._validated_isolated_database_url(_attested_isolated_database(database_url))


def test_database_validation_accepts_repo_managed_isolated_database_names():
    for database_url in (
        "postgresql://album_haven_app@localhost:5432/album_haven_fake_e2e",
        "postgres://album_haven_app@127.0.0.1/album_haven_scan_e2e",
        "postgresql://pytest@localhost/pytest_lastfm_retry",
    ):
        assert (
            python_test_config._validated_isolated_database_url(_attested_isolated_database(database_url))
            == database_url
        )


@pytest.mark.isolated_app_database(database_fixture="fixture_owned_isolated_database")
def test_explicit_database_opt_in_updates_only_the_attested_isolated_database(
    allow_isolated_app_database,
):
    import config

    assert allow_isolated_app_database == (
        "postgresql://album_haven_app@localhost:5432/album_haven_fake_e2e"
    )
    assert os.environ["ALBUM_HAVEN_APP_DATABASE_URL"] == allow_isolated_app_database
    assert config.Config.ALBUM_HAVEN_APP_DATABASE_URL == allow_isolated_app_database


def test_dotenv_loading_cannot_rehydrate_owner_lastfm_or_database_values(tmp_path):
    import config

    dotenv_path = tmp_path / ".env"
    dotenv_path.write_text(
        "\n".join(
            (
                "LASTFM_API_ENABLED=true",
                "LASTFM_API_KEY=owner-key",
                "LASTFM_API_SECRET=owner-secret",
                "LASTFM_API_ROOT=https://ws.audioscrobbler.com/2.0/",
                "LASTFM_SESSION_KEY=owner-session",
                "LASTFM_USERNAME=owner-name",
                "ALBUM_HAVEN_APP_DATABASE_URL=postgresql://owner@localhost/album_haven",
            )
        ),
        encoding="utf-8",
    )

    config.load_dotenv_file(dotenv_path)

    assert os.environ["LASTFM_API_ENABLED"] == "false"
    assert os.environ["LASTFM_API_KEY"] == ""
    assert os.environ["LASTFM_API_SECRET"] == ""
    assert os.environ["LASTFM_API_ROOT"] == ""
    assert os.environ["LASTFM_SESSION_KEY"] == ""
    assert os.environ["LASTFM_USERNAME"] == ""
    assert os.environ["ALBUM_HAVEN_APP_DATABASE_URL"] == ""
    python_test_config._assert_safe_runtime_config(config.Config)


def test_app_lifespan_receives_only_safe_lastfm_and_database_config(monkeypatch):
    from music_app import create_asgi_app
    from music_app.services import lastfm_retry, runtime_shutdown, state

    captured_configs = []
    monkeypatch.setattr(state, "hydrate_runtime_library_state_on_startup", lambda _runtime: True)
    monkeypatch.setattr(
        state,
        "ensure_runtime_relation_projection_ready",
        lambda _runtime: {},
        raising=False,
    )
    monkeypatch.setattr(lastfm_retry, "start_lastfm_retry_worker", lambda runtime: captured_configs.append(runtime.config))
    monkeypatch.setattr(lastfm_retry, "stop_lastfm_retry_worker", lambda _runtime: None)
    monkeypatch.setattr(runtime_shutdown, "request_runtime_shutdown", lambda _runtime: None)
    app = create_asgi_app()

    async def exercise_lifespan() -> None:
        async with app.router.lifespan_context(app):
            pass

    asyncio.run(exercise_lifespan())

    assert captured_configs == [app.state.config]
    python_test_config._assert_safe_runtime_config(captured_configs[0])


@pytest.mark.lastfm_loopback_transport(provider_fixture="fixture_owned_lastfm_provider")
def test_explicit_opt_in_allows_only_the_fixture_owned_loopback_endpoint(
    allow_lastfm_loopback_transport,
):
    import config

    api_root = allow_lastfm_loopback_transport
    assert config.Config.LASTFM_API_ENABLED is True
    assert config.Config.LASTFM_API_KEY == "fixture-api-key"
    assert config.Config.LASTFM_API_SECRET == "fixture-api-secret"
    assert config.Config.LASTFM_API_ROOT == api_root
    request = Request(api_root, data=b"method=test", method="POST")
    with lastfm.urlopen(request, timeout=2) as response:
        assert response.read() == b'<lfm status="ok"></lfm>'

    with pytest.raises(AssertionError, match="only permits the fixture-owned endpoint"):
        lastfm.urlopen(Request("http://127.0.0.1:9/2.0/"), timeout=1)
