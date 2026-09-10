"""Lifespan-owned, bounded retries for the existing welcome outbox."""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping
import logging
import math
from typing import Any

from starlette.concurrency import run_in_threadpool

from music_app.services.auth_mail import DeliveryResult, compose_welcome_email, send_auth_email
from music_app.services.auth_mail_outbox_postgres import (
    PostgresWelcomeOutboxService, deliver_welcome, dict_row, psycopg,
)

_DATABASE_TIMEOUT_SECONDS = 5


def _positive_seconds(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("Welcome worker timeout must be positive and finite.")
    parsed = float(value)
    if not math.isfinite(parsed) or parsed <= 0:
        raise ValueError("Welcome worker timeout must be positive and finite.")
    return parsed


def _worker_connect(database_url: str):
    if psycopg is None:
        raise RuntimeError("PostgreSQL support is required for welcome delivery.")
    return psycopg.connect(
        database_url, row_factory=dict_row, connect_timeout=_DATABASE_TIMEOUT_SECONDS,
        options="-c statement_timeout=5000 -c lock_timeout=5000",
    )


class WelcomeMailWorker:
    def __init__(
        self, *, repository: PostgresWelcomeOutboxService, config: Mapping[str, Any],
        sender: Callable = send_auth_email, composer: Callable = compose_welcome_email,
        batch_size: int = 20, poll_seconds: float = 30,
        shutdown_timeout_seconds: float | None = None, logger=None,
    ):
        if isinstance(batch_size, bool) or not isinstance(batch_size, int) or not 1 <= batch_size <= 100:
            raise ValueError("Welcome batch size must be between 1 and 100.")
        self._repository, self._config = repository, config
        self._sender, self._composer = sender, composer
        self._batch_size = batch_size
        self._poll_seconds = _positive_seconds(poll_seconds)
        command_seconds = _positive_seconds(config.get("command_timeout_seconds", 10))
        self._attempt_seconds = _positive_seconds(config.get("connect_timeout_seconds", 10)) + 4 * command_seconds
        self._shutdown_seconds = _positive_seconds(
            shutdown_timeout_seconds if shutdown_timeout_seconds is not None
            else 8 * _DATABASE_TIMEOUT_SECONDS + command_seconds
        )
        self._logger = logger or logging.getLogger(__name__)
        self._stopping = asyncio.Event()
        self._drain_lock = asyncio.Lock()
        self._database_task: asyncio.Task | None = None
        self.task: asyncio.Task | None = None

    def start(self) -> None:
        if self._config.get("welcome_enabled") is True and not self._stopping.is_set() and self.task is None:
            self.task = asyncio.create_task(self._run(), name="albumhaven-welcome-retry")

    async def stop(self) -> None:
        self._stopping.set()
        if self.task is None:
            return
        done, _ = await asyncio.wait({self.task}, timeout=self._shutdown_seconds)
        if not done:
            # A finite wait cannot terminate an off-loop database operation.
            # Retain task ownership so the lifespan reports incomplete shutdown.
            raise RuntimeError("Welcome retry worker shutdown is incomplete.")
        task, self.task = self.task, None
        await task

    async def _database_operation(self, operation, *args, **kwargs):
        task = asyncio.create_task(run_in_threadpool(operation, *args, **kwargs))
        self._database_task = task
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            self._stopping.set()
            await asyncio.shield(task)
            raise
        finally:
            if task.done():
                self._database_task = None

    async def _send(self, message, *, config) -> DeliveryResult:
        if self._stopping.is_set():
            # No transport started: keep this known-unsent message retryable.
            return DeliveryResult(False, "failed")
        sending = asyncio.create_task(self._sender(message, config=config))
        stopping = asyncio.create_task(self._stopping.wait())
        try:
            done, _ = await asyncio.wait(
                {sending, stopping}, timeout=self._attempt_seconds,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if sending in done:
                return await sending
            sending.cancel()
            results = await asyncio.gather(sending, return_exceptions=True)
            if any(isinstance(result, Exception) for result in results):
                self._logger.warning("Welcome delivery cleanup failed.")
            return DeliveryResult(False, "unknown")
        finally:
            for task in (sending, stopping):
                if not task.done():
                    task.cancel()
            await asyncio.gather(sending, stopping, return_exceptions=True)

    async def run_once(self) -> int:
        async with self._drain_lock:
            if self._stopping.is_set() or self._config.get("welcome_enabled") is not True:
                return 0
            identifiers = await self._database_operation(
                self._repository.list_due_welcome_ids, limit=self._batch_size,
            )
            processed = 0
            for identifier in identifiers[:self._batch_size]:
                if self._stopping.is_set():
                    break
                await deliver_welcome(
                    identifier, config=self._config, repository=self._repository,
                    composer=self._composer, sender=self._send,
                    run_repository=self._database_operation,
                )
                processed += 1
            return processed

    async def _run(self) -> None:
        while not self._stopping.is_set():
            try:
                await self.run_once()
            except Exception:
                self._logger.warning("Welcome retry pass failed.")
            try:
                await asyncio.wait_for(self._stopping.wait(), timeout=self._poll_seconds)
            except asyncio.TimeoutError:
                pass


def start_welcome_retry_worker(app) -> WelcomeMailWorker | None:
    from config import build_mail_config

    config = build_mail_config()
    if config.get("welcome_enabled") is not True:
        return None
    repository = PostgresWelcomeOutboxService(app.state.config, connect=_worker_connect)
    worker = WelcomeMailWorker(repository=repository, config=config)
    app.state.welcome_mail_worker = worker
    worker.start()
    return worker
