import ctypes
from ctypes import wintypes
import ipaddress
import json
import os
import re
import shutil
import sys
import tempfile
import urllib.request
import uuid
from collections.abc import Mapping
from pathlib import Path
from urllib.parse import urlparse

import pytest


_SAFE_PYTEST_ENV = {
    "LASTFM_API_ENABLED": "false",
    "LASTFM_API_KEY": "",
    "LASTFM_API_SECRET": "",
    "LASTFM_API_ROOT": "",
    "LASTFM_SESSION": "",
    "LASTFM_SESSION_KEY": "",
    "LASTFM_USERNAME": "",
    "ALBUM_HAVEN_APP_DATABASE_URL": "",
}
_LASTFM_SENSITIVE_ENV_KEYS = tuple(key for key in _SAFE_PYTEST_ENV if key.startswith("LASTFM_"))
_SAFE_RUNTIME_CONFIG = {
    "LASTFM_API_ENABLED": False,
    "LASTFM_API_KEY": "",
    "LASTFM_API_SECRET": "",
    "LASTFM_API_ROOT": "",
    "LASTFM_SESSION": "",
    "LASTFM_SESSION_KEY": "",
    "LASTFM_USERNAME": "",
    "ALBUM_HAVEN_APP_DATABASE_URL": "",
}
_REAL_URLLIB_URLOPEN = urllib.request.urlopen
_ISOLATED_DATABASE_SAFETY_TOKEN = object()
_ISOLATED_DATABASE_NAME_PATTERNS = (
    re.compile(r"^album_haven(?:_[a-z0-9]+)*_e2e$"),
    re.compile(r"^pytest(?:_[a-z0-9]+)+$"),
)
_PYTEST_BASETEMP_PATTERN = re.compile(r"^pytest-(?P<pid>[1-9][0-9]*)-(?P<token>[a-f0-9]{8})$")
_PYTEST_BASETEMP_OWNER_FILE = ".album-haven-pytest-owner.json"
_PYTEST_ROOT_ENV = "ALBUM_HAVEN_PYTEST_ROOT"
_MAX_PYTEST_ROOTS_INSPECTED_PER_SESSION = 64
_MAX_STALE_PYTEST_ROOTS_PER_SESSION = 16

for key, value in _SAFE_PYTEST_ENV.items():
    os.environ[key] = value


def _workspace_pytest_temp_root() -> Path:
    configured_root = os.environ.get(_PYTEST_ROOT_ENV, "").strip()
    if configured_root:
        return Path(configured_root).resolve()
    return (Path(__file__).resolve().parents[2] / ".tmp").resolve()


def _activate_pytest_app_paths(base_temp: Path) -> Path:
    test_root = (base_temp / "app-env").resolve()
    music_dir = (test_root / "music").resolve()
    data_dir = (test_root / "appdata").resolve()
    for path in (music_dir, data_dir):
        path.mkdir(parents=True, exist_ok=True)

    app_paths = {
        "MUSIC_DIR": music_dir,
        "MUSIC_APP_DATA_DIR": data_dir,
        "MUSIC_CACHE_PATH": data_dir / "library_cache.json",
        "MUSIC_COVER_CACHE_PATH": data_dir / "cover_search_cache.json",
        "MUSIC_LIBRARY_ROOTS_PATH": data_dir / "library_roots.json",
    }
    for key, path in app_paths.items():
        os.environ[key] = str(path.resolve())
    return data_dir


def _process_is_running(pid: int) -> bool:
    if pid == os.getpid():
        return True
    if os.name == "nt":
        process_query_limited_information = 0x1000
        still_active = 259
        error_invalid_parameter = 87
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.GetExitCodeProcess.argtypes = (
            wintypes.HANDLE,
            ctypes.POINTER(wintypes.DWORD),
        )
        kernel32.GetExitCodeProcess.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
        kernel32.CloseHandle.restype = wintypes.BOOL

        ctypes.set_last_error(0)
        handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
        if not handle:
            return ctypes.get_last_error() != error_invalid_parameter
        try:
            exit_code = wintypes.DWORD()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                return True
            return exit_code.value == still_active
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return True
    return True


def _owned_generated_pytest_root(path: Path) -> dict[str, object] | None:
    match = _PYTEST_BASETEMP_PATTERN.fullmatch(path.name)
    if match is None or path.is_symlink() or path.parent.resolve() != _workspace_pytest_temp_root():
        return None
    try:
        payload = json.loads((path / _PYTEST_BASETEMP_OWNER_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    if not isinstance(payload, dict):
        return None
    if payload.get("kind") != "album-haven-pytest-basetemp":
        return None
    if payload.get("pid") != int(match.group("pid")):
        return None
    if payload.get("token") != match.group("token"):
        return None
    return payload


def _remove_owned_generated_pytest_root(path: Path, *, expected_owner: tuple[int, str] | None = None) -> bool:
    owner = _owned_generated_pytest_root(path)
    if owner is None:
        return False
    owner_identity = (int(owner["pid"]), str(owner["token"]))
    if expected_owner is not None:
        if owner_identity != expected_owner:
            return False
    elif _process_is_running(owner_identity[0]):
        return False
    try:
        shutil.rmtree(path)
    except OSError:
        return False
    return not path.exists()


def _cleanup_stale_generated_pytest_roots() -> None:
    workspace_temp = _workspace_pytest_temp_root()
    if not workspace_temp.is_dir():
        return
    candidates: list[tuple[float, Path]] = []
    inspected_candidate_count = 0
    for path in workspace_temp.iterdir():
        if _PYTEST_BASETEMP_PATTERN.fullmatch(path.name) is None:
            continue
        inspected_candidate_count += 1
        if inspected_candidate_count > _MAX_PYTEST_ROOTS_INSPECTED_PER_SESSION:
            break
        try:
            if path.is_symlink() or not path.is_dir():
                continue
            candidates.append((path.stat().st_mtime, path))
        except OSError:
            continue
    removed_count = 0
    for _modified_at, path in sorted(candidates):
        if _remove_owned_generated_pytest_root(path):
            removed_count += 1
        if removed_count >= _MAX_STALE_PYTEST_ROOTS_PER_SESSION:
            break


def _activate_pytest_session_temp(config: pytest.Config) -> Path:
    base_temp = config._tmp_path_factory.getbasetemp()
    session_temp = (base_temp / "session-temp").resolve()
    session_temp.mkdir(parents=True, exist_ok=True)
    for key in ("TMP", "TEMP", "TMPDIR"):
        os.environ[key] = str(session_temp)
    tempfile.tempdir = str(session_temp)
    config._album_haven_session_temp = session_temp
    return session_temp


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers",
        "lastfm_loopback_transport(provider_fixture): allow the named fixture-owned loopback Last.fm provider only",
    )
    config.addinivalue_line(
        "markers",
        "isolated_app_database(database_fixture): allow the named fixture-owned isolated Postgres database only",
    )
    explicit_basetemp = config.option.basetemp is not None
    generated_token = None
    if not explicit_basetemp:
        generated_token = uuid.uuid4().hex[:8]
        config.option.basetemp = str(
            (_workspace_pytest_temp_root() / f"pytest-{os.getpid()}-{generated_token}").resolve()
        )
    config._album_haven_generated_basetemp = not explicit_basetemp
    config._album_haven_generated_basetemp_token = generated_token
    config._album_haven_test_appdata = _activate_pytest_app_paths(
        Path(config.option.basetemp).resolve()
    )


@pytest.hookimpl(trylast=True)
def pytest_sessionstart(session: pytest.Session) -> None:
    config = session.config
    _cleanup_stale_generated_pytest_roots()
    base_temp = config._tmp_path_factory.getbasetemp()
    if config._album_haven_generated_basetemp:
        token = str(config._album_haven_generated_basetemp_token)
        owner_payload = {
            "kind": "album-haven-pytest-basetemp",
            "pid": os.getpid(),
            "token": token,
        }
        (base_temp / _PYTEST_BASETEMP_OWNER_FILE).write_text(
            json.dumps(owner_payload, sort_keys=True),
            encoding="utf-8",
        )
    _activate_pytest_session_temp(config)


@pytest.hookimpl(trylast=True)
def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    config = session.config
    if not getattr(config, "_album_haven_generated_basetemp", False):
        return
    base_temp = config._tmp_path_factory._basetemp
    token = getattr(config, "_album_haven_generated_basetemp_token", None)
    if base_temp is None or not isinstance(token, str):
        return
    _remove_owned_generated_pytest_root(base_temp, expected_owner=(os.getpid(), token))


def _request_url(value: object) -> str:
    return str(getattr(value, "full_url", value) or "").strip()


def _fixture_provider_api_root(provider: object) -> str:
    if isinstance(provider, Mapping):
        api_root = provider.get("api_root")
    else:
        api_root = getattr(provider, "api_root", None)
    return str(api_root or "").strip()


def _fixture_value(provider: object, key: str) -> str:
    if isinstance(provider, Mapping):
        value = provider.get(key)
    else:
        value = getattr(provider, key, None)
    return str(value or "").strip()


def _validated_loopback_lastfm_root(provider: object) -> str:
    api_root = _fixture_provider_api_root(provider)
    parsed = urlparse(api_root)
    hostname = str(parsed.hostname or "").strip().lower()
    try:
        is_loopback = ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        is_loopback = hostname == "localhost"
    if parsed.scheme not in {"http", "https"} or not is_loopback or parsed.port is None:
        raise pytest.UsageError(
            "Last.fm transport opt-in requires a fixture-owned http(s) loopback URL with an explicit port."
        )
    return api_root


def _same_lastfm_endpoint(candidate_url: str, allowed_root: str) -> bool:
    candidate = urlparse(candidate_url)
    allowed = urlparse(allowed_root)
    return (
        candidate.scheme == allowed.scheme
        and candidate.hostname == allowed.hostname
        and candidate.port == allowed.port
        and candidate.path.rstrip("/") == allowed.path.rstrip("/")
    )


def _validated_isolated_database_url(database_fixture: object) -> str:
    database_url = _fixture_value(database_fixture, "database_url")
    if isinstance(database_fixture, Mapping):
        safety_token = database_fixture.get("pytest_isolated_database_safety_token")
    else:
        safety_token = getattr(database_fixture, "pytest_isolated_database_safety_token", None)
    if safety_token is not _ISOLATED_DATABASE_SAFETY_TOKEN:
        raise pytest.UsageError(
            "Database opt-in requires the fixture-owned pytest isolated-database safety token."
        )
    parsed = urlparse(database_url)
    hostname = str(parsed.hostname or "").strip().lower()
    try:
        is_loopback = ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        is_loopback = hostname == "localhost"
    database_name = parsed.path.strip("/").lower()
    if (
        parsed.scheme not in {"postgres", "postgresql"}
        or not is_loopback
        or not database_name
        or not any(pattern.fullmatch(database_name) for pattern in _ISOLATED_DATABASE_NAME_PATTERNS)
    ):
        raise pytest.UsageError(
            "Database opt-in requires a fixture-owned loopback Postgres URL whose database name matches "
            "a repo-managed isolated identity (album_haven_*_e2e or pytest_*)."
        )
    return database_url


def _set_runtime_config_values(config_carrier: object, values: Mapping[str, object]) -> None:
    if isinstance(config_carrier, dict):
        config_carrier.update(values)
        return
    for key, value in values.items():
        setattr(config_carrier, key, value)


def _entrypoint_runtime_config() -> dict[str, object] | None:
    entrypoint_module = sys.modules.get("app")
    entrypoint_app = getattr(entrypoint_module, "app", None) if entrypoint_module is not None else None
    state = getattr(entrypoint_app, "state", None)
    runtime_config = getattr(state, "config", None)
    return runtime_config if isinstance(runtime_config, dict) else None


def _assert_safe_runtime_config(config_carrier: object) -> None:
    for key, expected in _SAFE_RUNTIME_CONFIG.items():
        actual = config_carrier.get(key) if isinstance(config_carrier, dict) else getattr(config_carrier, key, None)
        if actual != expected:
            raise AssertionError(f"Pytest runtime safety expected {key}={expected!r}, got {actual!r}.")


@pytest.fixture(autouse=True)
def _reset_transient_log_history_between_tests():
    from music_app.services import log_history

    reset = getattr(log_history, "_reset_log_history_for_tests", None)
    if callable(reset):
        reset()
    try:
        yield
    finally:
        if callable(reset):
            reset()


@pytest.fixture(autouse=True)
def _block_owner_runtime_and_lastfm_outbound_by_default(monkeypatch: pytest.MonkeyPatch):
    for key, value in _SAFE_PYTEST_ENV.items():
        monkeypatch.setenv(key, value)

    import config as app_config

    for key, value in _SAFE_RUNTIME_CONFIG.items():
        monkeypatch.setattr(app_config.Config, key, value, raising=False)
    entrypoint_config = _entrypoint_runtime_config()
    if entrypoint_config is not None:
        _set_runtime_config_values(entrypoint_config, _SAFE_RUNTIME_CONFIG)
    _assert_safe_runtime_config(app_config.Config)
    if entrypoint_config is not None:
        _assert_safe_runtime_config(entrypoint_config)

    from music_app.services import lastfm

    real_post_lastfm = lastfm._post_lastfm

    def blocked_urlopen(request_value: object, *_args: object, **_kwargs: object):
        raise AssertionError(
            "Outbound Last.fm HTTP is blocked in pytest by default: "
            f"{_request_url(request_value) or '<unknown URL>'}. "
            "Use the explicit fixture-owned loopback transport opt-in for transport coverage."
        )

    def blocked_post_lastfm(_config: dict[str, object], method: str, _params: dict[str, object]):
        raise AssertionError(
            "Outbound Last.fm production transport is blocked in pytest by default: "
            f"method={method}. Use the explicit fixture-owned loopback transport opt-in."
        )

    monkeypatch.setattr(urllib.request, "urlopen", blocked_urlopen)
    monkeypatch.setattr(lastfm, "urlopen", blocked_urlopen)
    monkeypatch.setattr(lastfm, "_post_lastfm", blocked_post_lastfm)
    return {"real_post_lastfm": real_post_lastfm}


@pytest.fixture
def allow_lastfm_loopback_transport(
    request: pytest.FixtureRequest,
    monkeypatch: pytest.MonkeyPatch,
    _block_owner_runtime_and_lastfm_outbound_by_default,
) -> str:
    marker = request.node.get_closest_marker("lastfm_loopback_transport")
    provider_fixture_name = str(marker.kwargs.get("provider_fixture") if marker else "").strip()
    if not provider_fixture_name:
        raise pytest.UsageError(
            "allow_lastfm_loopback_transport requires "
            "@pytest.mark.lastfm_loopback_transport(provider_fixture='fixture_name')."
        )
    provider = request.getfixturevalue(provider_fixture_name)
    api_root = _validated_loopback_lastfm_root(provider)
    api_key = _fixture_value(provider, "api_key")
    api_secret = _fixture_value(provider, "api_secret")
    if not api_key or not api_secret:
        raise pytest.UsageError("The fixture-owned Last.fm provider must supply non-empty fake api_key and api_secret values.")

    safe_provider_config = {
        "LASTFM_API_ENABLED": True,
        "LASTFM_API_KEY": api_key,
        "LASTFM_API_SECRET": api_secret,
        "LASTFM_API_ROOT": api_root,
    }
    for key, value in safe_provider_config.items():
        monkeypatch.setenv(key, str(value).lower() if isinstance(value, bool) else str(value))

    import config as app_config

    for key, value in safe_provider_config.items():
        monkeypatch.setattr(app_config.Config, key, value, raising=False)
    entrypoint_config = _entrypoint_runtime_config()
    if entrypoint_config is not None:
        _set_runtime_config_values(entrypoint_config, safe_provider_config)

    from music_app.services import lastfm

    def loopback_only_urlopen(request_value: object, *args: object, **kwargs: object):
        candidate_url = _request_url(request_value)
        if not _same_lastfm_endpoint(candidate_url, api_root):
            raise AssertionError(
                "Last.fm transport opt-in only permits the fixture-owned endpoint "
                f"{api_root}; received {candidate_url or '<unknown URL>'}."
            )
        return _REAL_URLLIB_URLOPEN(request_value, *args, **kwargs)

    monkeypatch.setattr(lastfm, "urlopen", loopback_only_urlopen)
    monkeypatch.setattr(
        lastfm,
        "_post_lastfm",
        _block_owner_runtime_and_lastfm_outbound_by_default["real_post_lastfm"],
    )
    return api_root


@pytest.fixture
def isolated_database_safety_token() -> object:
    return _ISOLATED_DATABASE_SAFETY_TOKEN


@pytest.fixture
def allow_isolated_app_database(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> str:
    marker = request.node.get_closest_marker("isolated_app_database")
    database_fixture_name = str(marker.kwargs.get("database_fixture") if marker else "").strip()
    if not database_fixture_name:
        raise pytest.UsageError(
            "allow_isolated_app_database requires "
            "@pytest.mark.isolated_app_database(database_fixture='fixture_name')."
        )
    database_fixture = request.getfixturevalue(database_fixture_name)
    database_url = _validated_isolated_database_url(database_fixture)
    monkeypatch.setenv("ALBUM_HAVEN_APP_DATABASE_URL", database_url)

    import config as app_config

    monkeypatch.setattr(app_config.Config, "ALBUM_HAVEN_APP_DATABASE_URL", database_url)
    entrypoint_config = _entrypoint_runtime_config()
    if entrypoint_config is not None:
        entrypoint_config["ALBUM_HAVEN_APP_DATABASE_URL"] = database_url
    return database_url


@pytest.fixture
def asgi_app(request: pytest.FixtureRequest, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from tests.py.asgi_testing import create_test_asgi_app

    app = create_test_asgi_app(tmp_path, monkeypatch)
    if "app" in request.fixturenames:
        legacy_app = request.getfixturevalue("app")
        app.state.config = legacy_app.config
        app.state.library_state = legacy_app.library_state
        app.state.logger = legacy_app.logger
    return app


@pytest.fixture
def asgi_request():
    from tests.py.asgi_testing import run_asgi_request

    return run_asgi_request
