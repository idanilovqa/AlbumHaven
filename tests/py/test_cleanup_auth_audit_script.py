import io

from scripts import cleanup_auth_audit


class CleanupService:
    def __init__(self, deleted=7, error=None):
        self.deleted = deleted
        self.error = error
        self.batch_sizes = []

    def cleanup(self, *, batch_size):
        self.batch_sizes.append(batch_size)
        if self.error is not None:
            raise self.error
        return self.deleted


def _environment():
    return {
        "ALBUM_HAVEN_MIGRATOR_DATABASE_URL": "postgresql://migrator@localhost/db",
        "ALBUM_HAVEN_BOOTSTRAP_EMAIL": "owner@example.com",
        "ALBUM_HAVEN_PUBLIC_BASE_URL": "https://music.example.com",
        "ALBUM_HAVEN_AUTH_HMAC_SECRET": "s" * 32,
    }


def test_command_runs_one_bounded_batch_and_prints_only_count():
    stdout = io.StringIO()
    stderr = io.StringIO()
    service = CleanupService(deleted=7)

    exit_code = cleanup_auth_audit.main(
        ["--batch-size", "500"],
        environ=_environment(),
        stdout=stdout,
        stderr=stderr,
        config_builder=lambda _env: {"audit_retention_seconds": 90 * 86_400},
        service_factory=lambda config: service,
    )

    assert exit_code == 0
    assert service.batch_sizes == [500]
    assert stdout.getvalue() == "Deleted 7 security audit events.\n"
    assert stderr.getvalue() == ""
    assert "postgresql" not in stdout.getvalue()


def test_command_reports_configuration_failure_without_secret_values():
    stderr = io.StringIO()
    secret = "postgresql://user:private-password@localhost/db"

    exit_code = cleanup_auth_audit.main(
        [],
        environ={"ALBUM_HAVEN_MIGRATOR_DATABASE_URL": secret},
        stdout=io.StringIO(),
        stderr=stderr,
        config_builder=lambda _env: (_ for _ in ()).throw(RuntimeError(secret)),
    )

    assert exit_code == 2
    assert stderr.getvalue() == "Security audit cleanup configuration is invalid.\n"
    assert "private-password" not in stderr.getvalue()


def test_command_reports_cleanup_failure_without_secret_values():
    stderr = io.StringIO()
    service = CleanupService(error=RuntimeError("private-password"))

    exit_code = cleanup_auth_audit.main(
        [],
        environ=_environment(),
        stdout=io.StringIO(),
        stderr=stderr,
        config_builder=lambda _env: {"audit_retention_seconds": 90 * 86_400},
        service_factory=lambda config: service,
    )

    assert exit_code == 1
    assert stderr.getvalue() == "Security audit cleanup failed.\n"
    assert "private-password" not in stderr.getvalue()
