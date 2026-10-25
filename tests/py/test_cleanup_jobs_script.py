from __future__ import annotations

from datetime import datetime
import io

import pytest

from scripts import cleanup_jobs


MIGRATOR_URL = "postgresql://album_haven_migrator:private@localhost/album_haven"
COUNTS = {
    "transitions": 11,
    "compacted_jobs": 7,
    "tombstones": 5,
    "worker_instances": 3,
}


class CleanupService:
    def __init__(self, *, error=None) -> None:
        self.error = error
        self.calls: list[tuple[int, datetime]] = []

    def cleanup(self, *, batch_size, now):
        self.calls.append((batch_size, now))
        if self.error is not None:
            raise self.error
        return COUNTS


@pytest.mark.parametrize(
    ("argv", "expected_batch_size"),
    [([], 1_000), (["--batch-size", "1"], 1), (["--batch-size", "10000"], 10_000)],
)
def test_command_runs_one_bounded_batch_with_an_aware_now(argv, expected_batch_size):
    service = CleanupService()

    exit_code = cleanup_jobs.main(
        argv,
        environ={"ALBUM_HAVEN_MIGRATOR_DATABASE_URL": MIGRATOR_URL},
        stdout=io.StringIO(),
        stderr=io.StringIO(),
        service_factory=lambda _database_url: service,
    )

    assert exit_code == 0
    assert len(service.calls) == 1
    batch_size, now = service.calls[0]
    assert batch_size == expected_batch_size
    assert now.tzinfo is not None
    assert now.utcoffset() is not None


@pytest.mark.parametrize("value", ["0", "10001", "not-an-integer"])
def test_parser_rejects_invalid_or_out_of_range_batch_sizes(value):
    with pytest.raises(SystemExit):
        cleanup_jobs._parser().parse_args(["--batch-size", value])


def test_command_uses_only_the_migrator_database_url_and_prints_exact_counts():
    stdout = io.StringIO()
    stderr = io.StringIO()
    received_urls: list[str] = []

    exit_code = cleanup_jobs.main(
        [],
        environ={
            "ALBUM_HAVEN_MIGRATOR_DATABASE_URL": MIGRATOR_URL,
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app:wrong@localhost/db",
            "ALBUM_HAVEN_WORKER_DATABASE_URL": "postgresql://worker:wrong@localhost/db",
        },
        stdout=stdout,
        stderr=stderr,
        service_factory=lambda database_url: received_urls.append(database_url)
        or CleanupService(),
    )

    assert exit_code == 0
    assert received_urls == [MIGRATOR_URL]
    assert stdout.getvalue() == (
        "transitions=11 compacted_jobs=7 tombstones=5 worker_instances=3\n"
    )
    assert stderr.getvalue() == ""
    assert "postgresql" not in stdout.getvalue()
    assert "private" not in stdout.getvalue()


def test_default_factory_passes_the_migrator_url_by_keyword(monkeypatch):
    stdout = io.StringIO()
    created = []

    class ProductionService:
        def __init__(self, *, database_url):
            self.database_url = database_url
            self.calls = []
            created.append(self)

        def cleanup(self, *, batch_size, now):
            self.calls.append((batch_size, now))
            return COUNTS

    monkeypatch.setattr(
        "music_app.services.jobs.retention_postgres.PostgresJobRetentionService",
        ProductionService,
    )

    exit_code = cleanup_jobs.main(
        [],
        environ={"ALBUM_HAVEN_MIGRATOR_DATABASE_URL": MIGRATOR_URL},
        stdout=stdout,
        stderr=io.StringIO(),
    )

    assert exit_code == 0
    assert len(created) == 1
    assert created[0].database_url == MIGRATOR_URL
    assert len(created[0].calls) == 1
    batch_size, now = created[0].calls[0]
    assert batch_size == 1_000
    assert now.tzinfo is not None and now.utcoffset() is not None
    assert stdout.getvalue() == (
        "transitions=11 compacted_jobs=7 tombstones=5 worker_instances=3\n"
    )


def test_command_does_not_fall_back_to_app_or_worker_database_urls():
    stderr = io.StringIO()
    factory_calls: list[str] = []

    exit_code = cleanup_jobs.main(
        [],
        environ={
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app:private@localhost/db",
            "ALBUM_HAVEN_WORKER_DATABASE_URL": "postgresql://worker:private@localhost/db",
        },
        stdout=io.StringIO(),
        stderr=stderr,
        service_factory=lambda database_url: factory_calls.append(database_url),
    )

    assert exit_code == 2
    assert factory_calls == []
    assert stderr.getvalue() == "Job retention cleanup configuration is invalid.\n"
    assert "private" not in stderr.getvalue()


def test_command_reports_service_failure_without_secret_values():
    stdout = io.StringIO()
    stderr = io.StringIO()
    service = CleanupService(
        error=RuntimeError(f"database failure at {MIGRATOR_URL}; subject=private")
    )

    exit_code = cleanup_jobs.main(
        [],
        environ={"ALBUM_HAVEN_MIGRATOR_DATABASE_URL": MIGRATOR_URL},
        stdout=stdout,
        stderr=stderr,
        service_factory=lambda _database_url: service,
    )

    assert exit_code == 1
    assert stdout.getvalue() == ""
    assert stderr.getvalue() == "Job retention cleanup failed.\n"
    assert MIGRATOR_URL not in stderr.getvalue()
    assert "private" not in stderr.getvalue()
