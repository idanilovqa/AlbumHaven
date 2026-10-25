"""Atomic cleanup contracts for runner-owned watcher recovery fixtures."""

from __future__ import annotations

import json

import pytest

from tests.e2e.support import isolatedPostgres, watcherFixture


@pytest.mark.parametrize(
    "failure_stage",
    ["mark-stale", "load-removal", "confirm-removal", "transaction-rollback"],
)
def test_recovery_cleanup_keeps_owned_evidence_until_database_commit(
    tmp_path,
    monkeypatch,
    failure_stage,
):
    temp_root = tmp_path.resolve()
    boundary = temp_root / "cases" / "watcher-recovery-atomicity"
    failure_root = boundary / "failure-root"
    failure_staging = boundary / "failure-root-staging"
    healthy_root = boundary / "healthy-root"
    evidence = []
    for index, root in enumerate((failure_root, failure_staging, healthy_root), start=1):
        root.mkdir(parents=True)
        evidence_path = root / f"evidence-{index}.mp3"
        evidence_path.write_bytes(f"owned evidence {index}".encode())
        evidence.append((evidence_path, evidence_path.read_bytes()))

    manifest_path = temp_root / "app-data" / "watcher-recovery-fixture.json"
    manifest_path.parent.mkdir()
    manifest_payload = {
        "failure_root_id": "watcher-recovery-failure-atomicity",
        "failure_root_path": str(failure_root),
        "failure_root_staging_path": str(failure_staging),
        "healthy_root_id": "watcher-recovery-healthy-atomicity",
        "healthy_root_path": str(healthy_root),
        "viewer_username": "watcher-recovery-viewer-atomicity",
        "viewer_password": "private fixture password",
    }
    manifest_bytes = json.dumps(manifest_payload).encode()
    manifest_path.write_bytes(manifest_bytes)

    class Result:
        def __init__(self, *, rows=(), row=None):
            self.rows = list(rows)
            self.row = row

        def fetchall(self):
            return self.rows

        def fetchone(self):
            return self.row

    class FailingConnection:
        def __enter__(self):
            return self

        def __exit__(self, error_type, _error, _traceback):
            if error_type is None and failure_stage == "transaction-rollback":
                raise RuntimeError("database commit failed")
            return False

        def execute(self, statement, _parameters=None):
            sql = " ".join(str(statement).split()).lower()
            if "pg_advisory_xact_lock" in sql:
                return Result()
            if "select file.id, file.private_path, track.album_id" in sql:
                if failure_stage == "transaction-rollback":
                    return Result(rows=[])
                return Result(rows=[{
                    "id": 41,
                    "private_path": str(evidence[0][0]),
                    "album_id": 73,
                }])
            if "and not (" in sql:
                return Result(row=None)
            if "select album_key" in sql:
                if failure_stage == "load-removal":
                    raise RuntimeError("removal lookup failed")
                return Result(rows=[{"album_key": "owner::watcher recovery"}])
            if "update library.local_track_files" in sql:
                if failure_stage == "mark-stale":
                    raise RuntimeError("stale marking failed")
                return Result()
            if "confirm_missing_album_removal" in sql:
                if failure_stage == "confirm-removal":
                    return Result(row={"removed_album_count": 0})
                return Result(row={"removed_album_count": 1})
            raise AssertionError(f"Unexpected watcher cleanup SQL: {sql}")

    monkeypatch.setenv("ALBUM_HAVEN_E2E_TEMP_ROOT", str(temp_root))
    monkeypatch.setattr(
        isolatedPostgres,
        "resolve_isolated_database_urls",
        lambda: ("setup", "runtime"),
    )
    monkeypatch.setattr(isolatedPostgres, "_connect", lambda _url: FailingConnection())
    monkeypatch.setattr(isolatedPostgres, "_assert_connected_role", lambda *_args: None)

    with pytest.raises(RuntimeError):
        watcherFixture.remove_watcher_recovery_fixture(manifest_path)

    assert manifest_path.read_bytes() == manifest_bytes
    assert all(root.is_dir() for root in (failure_root, failure_staging, healthy_root))
    assert all(path.read_bytes() == contents for path, contents in evidence)
