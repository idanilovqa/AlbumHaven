"""Run the separate durable-jobs worker process."""

from __future__ import annotations

import os
import logging
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
        from config import build_mail_config, build_worker_config

        config = build_worker_config(environment)
        worker = (
            worker_factory(config)
            if worker_factory is not None
            else _build_worker(config, mail_config=build_mail_config(environment))
        )
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


def _build_worker(
    config: Any,
    *,
    full_scan_log_event: Callable[[str], object] | None = None,
    mail_config: Mapping[str, Any] | None = None,
) -> Any:
    """Wire the durable worker with its closed handler set."""

    from config import Config, build_mail_config as build_runtime_mail_config
    from music_app.jobs.dispatch import JobHandlerRegistry
    from music_app.jobs.cover_handlers import (
        build_cover_bulk_refresh_resource_validator,
        build_cover_lookup_handler,
        build_cover_lookup_resource_validator,
        build_cover_remote_save_handler,
        build_cover_remote_save_resource_validator,
        build_cover_refresh_handler,
    )
    from music_app.jobs.scan_handlers import (
        build_full_scan_handler,
        build_full_scan_resource_validator,
        build_post_scan_cover_refresh_resource_validator,
        build_targeted_reconciliation_handler,
        build_targeted_reconciliation_resource_validator,
    )
    from music_app.jobs.lastfm_handlers import build_lastfm_retry_handler
    from music_app.jobs.auth_mail_handlers import build_auth_mail_handler
    from music_app.jobs.worker import (
        PostgresWorkerInstanceRepository,
        Worker,
        combine_due_reconcilers,
        create_worker_pool,
    )
    from music_app.services.jobs.authorization import (
        build_auth_mail_resource_validator,
        build_lastfm_retry_resource_validator,
        JobAuthorizationService,
        PostgresJobAuthorizationContextRepository,
    )
    from music_app.services.jobs.repository_postgres import PostgresJobRepository
    from music_app.services.cover_jobs_postgres import PostgresCoverJobRepository
    from music_app.services.cover_lookup_runtime import (
        run_claimed_cover_lookup,
        run_claimed_cover_remote_save,
    )
    from music_app.services.cover_refresh_runtime import run_claimed_cover_refresh
    from music_app.services.policy_evaluator import PolicyEvaluator
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter
    from music_app.services.scan_jobs_postgres import PostgresScanJobRepository
    from music_app.services.lastfm_retry_jobs_postgres import (
        PostgresLastfmRetryJobRepository,
    )
    from music_app.services.auth_mail_jobs_postgres import (
        PostgresAuthMailJobRepository,
    )
    from music_app.services.lastfm import scrobble_track_with_session
    from music_app.services.targeted_library_reconciliation import (
        TargetedLibraryReconciler,
    )
    from music_app.services.jobs.models import JobKind
    from music_app.jobs.full_scan_executor import DurableFullScanExecutor

    pool = create_worker_pool(config)

    def connect_to_database(_database_url: str) -> Any:
        return pool.connection()

    repository = PostgresJobRepository(
        database_url=config.database_url,
        connect_to_database=connect_to_database,
    )
    scan_repository = PostgresScanJobRepository(
        database_url=config.database_url,
        connect_to_database=connect_to_database,
        job_repository=repository,
    )
    cover_repository = PostgresCoverJobRepository(
        database_url=config.database_url,
        connect_to_database=connect_to_database,
        job_repository=repository,
    )
    lastfm_retry_repository = PostgresLastfmRetryJobRepository(
        database_url=config.database_url,
        connect_to_database=connect_to_database,
        job_repository=repository,
    )
    auth_mail_repository = PostgresAuthMailJobRepository(
        database_url=config.database_url,
        connect_to_database=connect_to_database,
        job_repository=repository,
    )
    if not callable(scan_repository.load_claimed_targeted_reconciliation_scope):
        raise RuntimeError("targeted reconciliation scope loader is unavailable")
    scan_config = {
        key: value for key, value in vars(Config).items() if key.isupper()
    }
    scan_config["ALBUM_HAVEN_APP_DATABASE_URL"] = config.database_url
    reconciler = TargetedLibraryReconciler(
        scan_config,
        repository=PostgresScanCacheAdapter(
            scan_config,
            connect=connect_to_database,
        ),
        root_definitions=(),
        exception_overrides={},
    )
    targeted_validator = build_targeted_reconciliation_resource_validator(
        scan_repository=scan_repository
    )
    full_scan_validator = build_full_scan_resource_validator(
        scan_repository=scan_repository
    )
    post_scan_cover_validator = build_post_scan_cover_refresh_resource_validator(
        scan_repository=scan_repository
    )
    cover_lookup_validator = build_cover_lookup_resource_validator(
        cover_repository=cover_repository
    )
    cover_bulk_validator = build_cover_bulk_refresh_resource_validator(
        cover_repository=cover_repository
    )
    cover_remote_save_validator = build_cover_remote_save_resource_validator(
        cover_repository=cover_repository
    )
    lastfm_retry_validator = build_lastfm_retry_resource_validator(
        retry_repository=lastfm_retry_repository
    )
    auth_mail_validators = {
        JobKind.AUTH_WELCOME_DELIVERY.value: build_auth_mail_resource_validator(
            mail_repository=auth_mail_repository, category="welcome"
        ),
        JobKind.AUTH_INVITATION_DELIVERY.value: build_auth_mail_resource_validator(
            mail_repository=auth_mail_repository, category="account_invitation"
        ),
        JobKind.AUTH_PASSWORD_RESET_DELIVERY.value: build_auth_mail_resource_validator(
            mail_repository=auth_mail_repository, category="password_reset"
        ),
    }
    authorization = JobAuthorizationService(
        context_repository=PostgresJobAuthorizationContextRepository(
            database_url=config.database_url,
            connect_to_database=connect_to_database,
        ),
        policy_evaluator=PolicyEvaluator(),
        resource_validators={
            JobKind.COVER_LOOKUP.value: cover_lookup_validator,
            JobKind.COVER_BULK_REFRESH.value: cover_bulk_validator,
            JobKind.COVER_REMOTE_SAVE.value: cover_remote_save_validator,
            JobKind.FULL_SCAN.value: full_scan_validator,
            JobKind.POST_SCAN_COVER_REFRESH.value: post_scan_cover_validator,
            JobKind.TARGETED_RECONCILIATION.value: targeted_validator,
            JobKind.LASTFM_SCROBBLE_RETRY.value: lastfm_retry_validator,
            **auth_mail_validators,
        },
    )
    instances = PostgresWorkerInstanceRepository(
        database_url=config.database_url,
        connect_to_database=connect_to_database,
    )
    handlers = JobHandlerRegistry()
    handlers.register(
        JobKind.COVER_LOOKUP,
        build_cover_lookup_handler(
            cover_repository=cover_repository,
            config=scan_config,
            logger=logging.getLogger("album_haven.jobs.cover"),
            run_lookup=run_claimed_cover_lookup,
        ),
    )
    cover_refresh_handler = build_cover_refresh_handler(
        cover_repository=cover_repository,
        config=scan_config,
        logger=logging.getLogger("album_haven.jobs.cover"),
        run_refresh=run_claimed_cover_refresh,
    )
    handlers.register(JobKind.COVER_BULK_REFRESH, cover_refresh_handler)
    handlers.register(JobKind.POST_SCAN_COVER_REFRESH, cover_refresh_handler)
    handlers.register(
        JobKind.COVER_REMOTE_SAVE,
        build_cover_remote_save_handler(
            cover_repository=cover_repository,
            config=scan_config,
            logger=logging.getLogger("album_haven.jobs.cover_save"),
            run_save=run_claimed_cover_remote_save,
        ),
    )
    handlers.register(
        JobKind.FULL_SCAN,
        build_full_scan_handler(
            scan_repository=scan_repository,
            scan_executor=DurableFullScanExecutor(
                config=scan_config,
                scan_repository=scan_repository,
            ),
            log_event=full_scan_log_event,
        ),
    )
    handlers.register(
        JobKind.TARGETED_RECONCILIATION,
        build_targeted_reconciliation_handler(
            scan_repository=scan_repository,
            reconciler=reconciler,
        ),
    )
    handlers.register(
        JobKind.LASTFM_SCROBBLE_RETRY,
        build_lastfm_retry_handler(
            retry_repository=lastfm_retry_repository,
            config=scan_config,
            scrobble_with_session=scrobble_track_with_session,
        ),
    )
    mail_config = (
        build_runtime_mail_config() if mail_config is None else dict(mail_config)
    )
    handlers.register(
        JobKind.AUTH_WELCOME_DELIVERY,
        build_auth_mail_handler(
            category="welcome",
            mail_repository=auth_mail_repository,
            mail_config=mail_config,
        ),
    )
    handlers.register(
        JobKind.AUTH_INVITATION_DELIVERY,
        build_auth_mail_handler(
            category="account_invitation",
            mail_repository=auth_mail_repository,
            mail_config=mail_config,
        ),
    )
    handlers.register(
        JobKind.AUTH_PASSWORD_RESET_DELIVERY,
        build_auth_mail_handler(
            category="password_reset",
            mail_repository=auth_mail_repository,
            mail_config=mail_config,
        ),
    )
    return Worker(
        repository=repository,
        authorization_service=authorization,
        handlers=handlers,
        lease_seconds=config.lease_seconds,
        heartbeat_seconds=config.heartbeat_seconds,
        poll_seconds=config.poll_seconds,
        max_idle_backoff_seconds=config.max_idle_backoff_seconds,
        drain_seconds=config.drain_seconds,
        concurrency=config.concurrency,
        worker_instances=instances,
        closeables=(pool,),
        claim_kinds=handlers.registered_kinds,
        due_reconciler=combine_due_reconcilers(
            lastfm_retry_repository.reconcile_due_pending,
            auth_mail_repository.reconcile_due_pending,
        ),
    )


if __name__ == "__main__":
    raise SystemExit(main())
