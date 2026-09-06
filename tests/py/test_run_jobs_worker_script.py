from __future__ import annotations

import io

from scripts import run_jobs_worker


WORKER_URL = "postgresql://worker-role:private@db.example/album_haven"


class Worker:
    def __init__(self, error=None):
        self.error = error
        self.stop_events = []

    def run(self, stop_event):
        self.stop_events.append(stop_event)
        if self.error is not None:
            raise self.error


def test_command_returns_two_for_invalid_configuration_without_echoing_value():
    stderr = io.StringIO()

    exit_code = run_jobs_worker.main(
        [],
        environ={
            "ALBUM_HAVEN_WORKER_DATABASE_URL": WORKER_URL,
            "ALBUM_HAVEN_WORKER_CONCURRENCY": "secret-invalid-value",
        },
        stdout=io.StringIO(),
        stderr=stderr,
        worker_factory=lambda _: (_ for _ in ()).throw(AssertionError()),
    )

    assert exit_code == 2
    assert stderr.getvalue() == "Durable jobs worker configuration is invalid.\n"
    assert "secret" not in stderr.getvalue()
    assert WORKER_URL not in stderr.getvalue()


def test_command_returns_one_for_runtime_failure_with_bounded_redacted_output():
    stderr = io.StringIO()

    exit_code = run_jobs_worker.main(
        [],
        environ={"ALBUM_HAVEN_WORKER_DATABASE_URL": WORKER_URL},
        stdout=io.StringIO(),
        stderr=stderr,
        worker_factory=lambda _: Worker(RuntimeError("secret subject parameters")),
    )

    assert exit_code == 1
    assert stderr.getvalue() == "Durable jobs worker failed.\n"
    assert "secret" not in stderr.getvalue()
    assert WORKER_URL not in stderr.getvalue()
    assert len(stderr.getvalue()) <= 128


def test_command_returns_zero_after_clean_shutdown():
    stdout = io.StringIO()
    created = []

    exit_code = run_jobs_worker.main(
        [],
        environ={"ALBUM_HAVEN_WORKER_DATABASE_URL": WORKER_URL},
        stdout=stdout,
        stderr=io.StringIO(),
        worker_factory=lambda config: created.append((config, Worker())) or created[-1][1],
    )

    assert exit_code == 0
    assert len(created) == 1
    assert created[0][0].database_url == WORKER_URL
    assert len(created[0][1].stop_events) == 1
    assert stdout.getvalue() == "Durable jobs worker stopped cleanly.\n"
    assert WORKER_URL not in stdout.getvalue()


def test_command_output_never_includes_url_subject_or_parameters():
    stdout = io.StringIO()
    stderr = io.StringIO()
    sensitive_values = (WORKER_URL, "subject:private", "parameter-secret")

    run_jobs_worker.main(
        [],
        environ={"ALBUM_HAVEN_WORKER_DATABASE_URL": WORKER_URL},
        stdout=stdout,
        stderr=stderr,
        worker_factory=lambda _: Worker(RuntimeError(" ".join(sensitive_values))),
    )

    output = stdout.getvalue() + stderr.getvalue()
    assert all(value not in output for value in sensitive_values)
    assert len(output) <= 256


def test_worker_heartbeat_failure_maps_to_redacted_runtime_exit():
    stderr = io.StringIO()

    exit_code = run_jobs_worker.main(
        [],
        environ={"ALBUM_HAVEN_WORKER_DATABASE_URL": WORKER_URL},
        stdout=io.StringIO(),
        stderr=stderr,
        worker_factory=lambda _: Worker(
            RuntimeError("worker heartbeat failed: private subject secret")
        ),
    )

    assert exit_code == 1
    assert stderr.getvalue() == "Durable jobs worker failed.\n"
    assert "heartbeat" not in stderr.getvalue().casefold()
    assert "secret" not in stderr.getvalue().casefold()


def test_worker_bootstrap_registers_the_closed_targeted_reconciliation_handler():
    import inspect

    source = inspect.getsource(run_jobs_worker._build_worker)

    assert "build_targeted_reconciliation_handler" in source
    assert "JobKind.TARGETED_RECONCILIATION" in source
    assert "handlers.register" in source
    assert "load_claimed_targeted_reconciliation_scope" in source
    assert "resource_validators" in source
