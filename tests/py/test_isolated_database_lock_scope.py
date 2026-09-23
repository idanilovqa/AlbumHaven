"""Ownership locks serialize one validated database, not unrelated E2E jobs."""
import pytest
import json
import subprocess
import sys
import time

from tests.e2e.support import isolatedPostgres


def _url(database, *, host="localhost", port="5432", scheme="postgresql", role="album_haven_migrator"):
    return f"{scheme}://{role}@{host}{':' + port if port else ''}/{database}"


def test_database_scoped_locks_allow_independent_jobs_and_contend_for_same_database(tmp_path, monkeypatch):
    monkeypatch.setattr(isolatedPostgres.tempfile, "gettempdir", lambda: str(tmp_path))
    first = isolatedPostgres.IsolatedDatabaseOwnershipLock(database_url=_url("album_haven_ci_first"), wait_seconds=0)
    second = isolatedPostgres.IsolatedDatabaseOwnershipLock(database_url=_url("album_haven_ci_second"), wait_seconds=0)
    same = isolatedPostgres.IsolatedDatabaseOwnershipLock(database_url=_url("album_haven_ci_first", host="127.0.0.1", port="", scheme="postgres", role="album_haven_app"), wait_seconds=0)
    assert first.lock_path == same.lock_path and first.lock_path != second.lock_path
    first.acquire()
    try:
        second.acquire()
        try:
            with pytest.raises(TimeoutError, match="album_haven_ci_first"):
                same.acquire()
        finally:
            second.release()
    finally:
        first.release()
    assert not first.lock_path.exists() and not second.lock_path.exists()


def test_database_lock_keeps_legacy_fake_database_owner_path():
    lock = isolatedPostgres.IsolatedDatabaseOwnershipLock(database_url=_url("album_haven_fake_e2e"))
    assert lock.lock_path == isolatedPostgres._DATABASE_LOCK_PATH


@pytest.mark.parametrize("database", ["album_haven_ci_first", "album_haven_fake_e2e"])
def test_database_lock_distinguishes_server_port(tmp_path, monkeypatch, database):
    monkeypatch.setattr(isolatedPostgres.tempfile, "gettempdir", lambda: str(tmp_path))
    first = isolatedPostgres.IsolatedDatabaseOwnershipLock(database_url=_url(database))
    second = isolatedPostgres.IsolatedDatabaseOwnershipLock(database_url=_url(database, port="5433"))
    assert first.lock_path != second.lock_path


@pytest.mark.parametrize("url", [
    _url("album_haven_core"), _url("album_haven_ci_invalid-name"),
    _url("album_haven_ci_first", host="example.com"),
    _url("album_haven_ci_first") + "?sslmode=require",
    "postgresql://album_haven_migrator:secret@localhost/album_haven_ci_first",
    _url("other/album_haven_ci_first"), _url("album_haven_ci_first/"),
    _url("ALBUM_HAVEN_CI_FIRST"), _url("album_haven_ci_first", port="0"),
])
def test_database_lock_rejects_unowned_or_ambiguous_identity(url):
    with pytest.raises(ValueError, match="lock database"):
        isolatedPostgres.IsolatedDatabaseOwnershipLock(database_url=url)


def test_scan_and_functional_launchers_use_same_ci_database_lock():
    from tests.e2e.support import scanPerformanceApp
    url = _url("album_haven_ci_shared", role="album_haven_migrator_shared")
    scan = scanPerformanceApp._scan_database_lock(url)
    functional = isolatedPostgres.IsolatedDatabaseOwnershipLock(database_url=url)
    assert scan.lock_path == functional.lock_path


def test_shared_lock_accepts_existing_scan_database_without_changing_runtime_allowlist():
    from tests.e2e.support import scanPerformanceApp
    url = _url("album_haven_scan_e2e", role="album_haven_scan_migrator")
    lock = scanPerformanceApp._scan_database_lock(url)
    assert lock.database_label == "album_haven_scan_e2e"
    assert not isolatedPostgres._is_owned_isolated_database_name("album_haven_scan_e2e")


def test_lock_only_cleanup_reaps_terminated_owned_child_without_database_reset(tmp_path, monkeypatch):
    from tests.e2e.support import isolatedLibraryApp
    database_url = _url("album_haven_ci_terminated")
    monkeypatch.setattr(isolatedPostgres.tempfile, "gettempdir", lambda: str(tmp_path))
    lock = isolatedPostgres.IsolatedDatabaseOwnershipLock(database_url=database_url)
    code = (
        "import sys,time; from pathlib import Path; "
        "from tests.e2e.support.isolatedPostgres import IsolatedDatabaseOwnershipLock; "
        "lock=IsolatedDatabaseOwnershipLock(lock_path=Path(sys.argv[1])); "
        "lock.acquire(); time.sleep(60)"
    )
    child = subprocess.Popen([sys.executable, "-c", code, str(lock.lock_path)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        deadline = time.monotonic() + 5
        while not lock.owner_path.exists() and child.poll() is None and time.monotonic() < deadline:
            time.sleep(0.01)
        assert lock.owner_path.exists(), "owned child did not acquire its lock"
        owner = json.loads(lock.owner_path.read_text(encoding="utf-8"))
        assert owner["pid"] == child.pid
        assert isolatedPostgres._process_identity(child.pid).identity == owner["process_identity"]
        child.terminate()
        child.communicate(timeout=5)
        assert isolatedPostgres._process_identity(child.pid).state is isolatedPostgres._ProcessIdentityState.ABSENT
        monkeypatch.setattr(isolatedLibraryApp, "resolve_isolated_database_urls", lambda: (database_url, database_url))
        monkeypatch.setattr(isolatedLibraryApp, "IsolatedDatabaseOwnershipLock", isolatedPostgres.IsolatedDatabaseOwnershipLock)
        def unexpected_reset(*_args):
            pytest.fail("lock-only cleanup must not connect to or reset the database")
        monkeypatch.setattr(isolatedLibraryApp, "reset_application_tables", unexpected_reset)
        monkeypatch.setattr(isolatedPostgres, "_connect", unexpected_reset)
        isolatedLibraryApp.cleanup_isolated_database(lock_only=True)
        assert not lock.lock_path.exists()
    finally:
        if child.poll() is None:
            child.terminate()
        child.communicate(timeout=5)


def test_lock_only_cleanup_rejects_live_owner_without_wait_or_reset(tmp_path, monkeypatch):
    from tests.e2e.support import isolatedLibraryApp
    database_url = _url("album_haven_ci_live")
    monkeypatch.setattr(isolatedPostgres.tempfile, "gettempdir", lambda: str(tmp_path))
    monkeypatch.setattr(isolatedLibraryApp, "resolve_isolated_database_urls", lambda: (database_url, database_url))
    monkeypatch.setattr(isolatedLibraryApp, "IsolatedDatabaseOwnershipLock", isolatedPostgres.IsolatedDatabaseOwnershipLock)
    owner = isolatedPostgres.IsolatedDatabaseOwnershipLock(database_url=database_url)
    owner.acquire()
    original = owner.owner_path.read_bytes()
    try:
        with pytest.raises(TimeoutError, match="waiting 0s"):
            isolatedLibraryApp.cleanup_isolated_database(lock_only=True)
        assert owner.owner_path.read_bytes() == original
    finally:
        owner.release()
