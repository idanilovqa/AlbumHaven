"""Run the separate durable-jobs worker process."""

from __future__ import annotations

import os
from pathlib import Path
import signal
import sys
import threading
from collections.abc import Callable, Mapping, Sequence
from typing import Any, TextIO


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main(
    argv: Sequence[str] | None = None,
    *,
    environ: Mapping[str, str] | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
    worker_factory: Callable[[Any], Any] | None = None,
) -> int:
    """Validate configuration, run until signaled, and emit only closed messages."""

    output = sys.stdout if stdout is None else stdout
    errors = sys.stderr if stderr is None else stderr
    environment = os.environ if environ is None else environ
    arguments = tuple(sys.argv[1:] if argv is None else argv)
    worker = None

    try:
        if arguments:
            raise ValueError("the durable jobs worker accepts no arguments")
        from config import build_worker_config

        config = build_worker_config(environment)
        worker = (worker_factory or _build_worker)(config)
    except Exception:
        print("Durable jobs worker configuration is invalid.", file=errors)
        return 2

    stop_event = threading.Event()
    previous_handlers: dict[int, Any] = {}

    def request_stop(_signum: int, _frame: Any) -> None:
        stop_event.set()

    try:
        if threading.current_thread() is threading.main_thread():
            for signal_number in _shutdown_signals():
                previous_handlers[signal_number] = signal.signal(
                    signal_number, request_stop
                )
        worker.run(stop_event)
    except Exception:
        print("Durable jobs worker failed.", file=errors)
        return 1
    finally:
        for signal_number, previous_handler in previous_handlers.items():
            try:
                signal.signal(signal_number, previous_handler)
            except (OSError, RuntimeError, ValueError):
                pass
        close = getattr(worker, "close", None)
        if callable(close):
            try:
                close()
            except Exception:
                pass

    print("Durable jobs worker stopped cleanly.", file=output)
    return 0


def _shutdown_signals() -> tuple[int, ...]:
    candidates = [signal.SIGINT]
    if hasattr(signal, "SIGTERM"):
        candidates.append(signal.SIGTERM)
    return tuple(dict.fromkeys(candidates))


def _build_worker(config: Any) -> Any:
    """Wire the foundation; workflow slices later register closed handlers."""

    from music_app.jobs.dispatch import JobHandlerRegistry
    from music_app.jobs.worker import (
        PostgresWorkerInstanceRepository,
        Worker,
        create_worker_pool,
    )
    from music_app.services.jobs.authorization import (
        JobAuthorizationService,
        PostgresJobAuthorizationContextRepository,
    )
    from music_app.services.jobs.repository_postgres import PostgresJobRepository
    from music_app.services.policy_evaluator import PolicyEvaluator

    pool = create_worker_pool(config)

    def connect_to_database(_database_url: str) -> Any:
        return pool.connection()

    repository = PostgresJobRepository(
        database_url=config.database_url,
        connect_to_database=connect_to_database,
    )
    authorization = JobAuthorizationService(
        context_repository=PostgresJobAuthorizationContextRepository(
            database_url=config.database_url,
            connect_to_database=connect_to_database,
        ),
        policy_evaluator=PolicyEvaluator(),
        resource_validators={},
    )
    instances = PostgresWorkerInstanceRepository(
        database_url=config.database_url,
        connect_to_database=connect_to_database,
    )
    return Worker(
        repository=repository,
        authorization_service=authorization,
        handlers=JobHandlerRegistry(),
        lease_seconds=config.lease_seconds,
        heartbeat_seconds=config.heartbeat_seconds,
        poll_seconds=config.poll_seconds,
        max_idle_backoff_seconds=config.max_idle_backoff_seconds,
        drain_seconds=config.drain_seconds,
        concurrency=config.concurrency,
        worker_instances=instances,
        closeables=(pool,),
    )


if __name__ == "__main__":
    raise SystemExit(main())
