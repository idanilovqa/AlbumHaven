import io

from scripts import cleanup_auth_throttles


class Service:
    def __init__(self, deleted=4, error=None):
        self.deleted = deleted
        self.error = error
        self.batch_sizes = []

    def cleanup(self, *, batch_size):
        self.batch_sizes.append(batch_size)
        if self.error:
            raise self.error
        return self.deleted


def test_command_runs_one_bounded_batch_and_prints_only_count():
    stdout = io.StringIO()
    service = Service()
    exit_code = cleanup_auth_throttles.main(
        ["--batch-size", "250"],
        environ={"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app:secret@localhost/db"},
        stdout=stdout,
        stderr=io.StringIO(),
        service_factory=lambda config: service,
    )

    assert exit_code == 0
    assert service.batch_sizes == [250]
    assert stdout.getvalue() == "Deleted 4 expired authentication throttle buckets.\n"
    assert "secret" not in stdout.getvalue()


def test_command_reports_cleanup_failure_without_secret_values():
    stderr = io.StringIO()
    exit_code = cleanup_auth_throttles.main(
        [],
        environ={"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app:secret@localhost/db"},
        stdout=io.StringIO(),
        stderr=stderr,
        service_factory=lambda config: Service(error=RuntimeError("secret")),
    )

    assert exit_code == 1
    assert stderr.getvalue() == "Authentication throttle cleanup failed.\n"
    assert "secret" not in stderr.getvalue()
