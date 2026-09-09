"""Bounded welcome retry worker ownership and delivery controls."""

import asyncio
from importlib import import_module
from threading import Event
from types import SimpleNamespace

import pytest

from music_app.services.auth_mail import DeliveryResult


CONFIG = {"welcome_enabled": True, "connect_timeout_seconds": 1,
          "command_timeout_seconds": 1, "public_base_url": "https://music.example.test"}


class Repository:
    def __init__(self):
        self.selected = []
        self.claims = []
        self.finalized = []

    def list_due_welcome_ids(self, *, limit):
        self.selected.append(limit)
        return [1, 2]

    def claim_welcome(self, identifier):
        from music_app.services.auth_mail_outbox_postgres import WelcomeClaim
        from datetime import datetime, timezone
        self.claims.append(identifier)
        return WelcomeClaim(identifier, identifier, "member", "member@example.test", 1, datetime.now(timezone.utc))

    def finalize_welcome(self, claim, result):
        self.finalized.append((claim.outbox_id, result.reason))


async def _until(predicate):
    async def wait():
        while not predicate():
            await asyncio.sleep(0)
    await asyncio.wait_for(wait(), 2)


def test_welcome_worker_stops_during_selection_without_abandoning_database_work():
    module = import_module("music_app.services.auth_welcome_worker")
    entered, release, exited = Event(), Event(), Event()
    repository = Repository()

    def select(*, limit):
        entered.set()
        try:
            assert release.wait(3)
            return [1, 2]
        finally:
            exited.set()

    repository.list_due_welcome_ids = select

    async def scenario():
        worker = module.WelcomeMailWorker(repository=repository, config=CONFIG)
        worker.start()
        stopping = None
        try:
            await _until(entered.is_set)
            stopping = asyncio.create_task(worker.stop())
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            assert not stopping.done(), "Shutdown must retain ownership of the running DB operation"
            assert not exited.is_set()
        finally:
            release.set()
            if stopping is None:
                await worker.stop()
            else:
                await asyncio.wait_for(stopping, 2)
        assert exited.is_set()
        assert repository.claims == []
        assert repository.finalized == []
        assert worker.task is None
    asyncio.run(scenario())


def test_welcome_worker_stops_smtp_and_finalizes_unknown_before_shutdown_returns():
    module = import_module("music_app.services.auth_welcome_worker")
    repository = Repository()

    async def scenario():
        started, cleaned = asyncio.Event(), asyncio.Event()
        async def sender(_message, *, config):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cleaned.set()
        worker = module.WelcomeMailWorker(repository=repository, config=CONFIG,
            sender=sender, composer=lambda **_kwargs: object())
        worker.start()
        try:
            await asyncio.wait_for(started.wait(), 2)
        finally:
            await asyncio.wait_for(worker.stop(), 2)
        assert cleaned.is_set()
        assert repository.claims == [1], "No next message may be claimed after stop"
        assert repository.finalized == [(1, "unknown")]
        assert worker.task is None
    asyncio.run(scenario())


def test_welcome_worker_stop_during_claim_keeps_known_unsent_message_retryable():
    module = import_module("music_app.services.auth_welcome_worker")
    entered, release, exited = Event(), Event(), Event()
    repository = Repository()
    original_claim = repository.claim_welcome
    sent = []

    def claim(identifier):
        entered.set()
        try:
            assert release.wait(3)
            return original_claim(identifier)
        finally:
            exited.set()

    repository.claim_welcome = claim

    async def scenario():
        async def sender(_message, *, config):
            sent.append(True)
            return DeliveryResult(True, "delivered")

        worker = module.WelcomeMailWorker(
            repository=repository, config=CONFIG,
            sender=sender, composer=lambda **_kwargs: object(),
        )
        worker.start()
        stopping = None
        try:
            await _until(entered.is_set)
            stopping = asyncio.create_task(worker.stop())
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            assert not stopping.done()
        finally:
            release.set()
            if stopping is None:
                await worker.stop()
            else:
                await asyncio.wait_for(stopping, 2)
        assert exited.is_set()
        assert sent == [], "Shutdown before SMTP starts is known not to have sent"
        assert repository.claims == [1], "Shutdown must not claim the next message"
        assert repository.finalized == [(1, "failed")], "Existing failed retry semantics retain known-unsent mail"
        assert worker.task is None

    asyncio.run(scenario())


def test_welcome_worker_drain_is_bounded_and_smtp_runs_outside_repository_operations():
    module = import_module("music_app.services.auth_welcome_worker")
    repository = Repository()
    async def scenario():
        async def sender(_message, *, config):
            assert repository.claims[-1] not in [item[0] for item in repository.finalized]
            return DeliveryResult(True, "delivered")
        worker = module.WelcomeMailWorker(repository=repository, config=CONFIG,
            batch_size=2, sender=sender, composer=lambda **_kwargs: object())
        assert await worker.run_once() == 2
        assert repository.selected == [2]
        assert repository.finalized == [(1, "delivered"), (2, "delivered")]
        await worker.stop()
        assert await worker.run_once() == 0
        assert repository.selected == [2]
    asyncio.run(scenario())


def test_welcome_worker_failure_does_not_end_owned_loop_or_duplicate_start():
    module = import_module("music_app.services.auth_welcome_worker")
    repository = Repository()
    calls = []
    def select(*, limit):
        calls.append(limit)
        if len(calls) == 1:
            raise RuntimeError("private database value")
        return []
    repository.list_due_welcome_ids = select
    logged = []
    async def scenario():
        worker = module.WelcomeMailWorker(repository=repository, config=CONFIG,
            poll_seconds=0.01, logger=SimpleNamespace(warning=lambda message: logged.append(message)))
        worker.start()
        first = worker.task
        worker.start()
        assert worker.task is first
        try:
            await _until(lambda: len(calls) >= 2)
        finally:
            await asyncio.wait_for(worker.stop(), 2)
        assert worker.task is None
    asyncio.run(scenario())
    assert logged and all("private database value" not in message for message in logged)


def test_disabled_welcome_runtime_does_not_construct_repository(monkeypatch):
    module = import_module("music_app.services.auth_welcome_worker")
    monkeypatch.setattr("config.build_mail_config", lambda: {"welcome_enabled": False})
    monkeypatch.setattr(module, "PostgresWelcomeOutboxService", lambda *_args, **_kwargs: pytest.fail("disabled mail accessed persistence"))
    assert module.start_welcome_retry_worker(SimpleNamespace(state=SimpleNamespace())) is None


def test_enabled_welcome_runtime_uses_config_available_before_first_auth_request(monkeypatch):
    module = import_module("music_app.services.auth_welcome_worker")
    runtime_config = {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://owned-test"}
    app = SimpleNamespace(state=SimpleNamespace(config=runtime_config))
    repositories = []
    started = []
    repository = object()
    worker = SimpleNamespace(start=lambda: started.append(True))

    def make_repository(config, *, connect):
        assert connect is module._worker_connect
        repositories.append(config)
        return repository

    def make_worker(*, repository: object, config):
        assert repository is expected_repository
        assert config is CONFIG
        return worker

    expected_repository = repository
    monkeypatch.setattr("config.build_mail_config", lambda: CONFIG)
    monkeypatch.setattr(module, "PostgresWelcomeOutboxService", make_repository)
    monkeypatch.setattr(module, "WelcomeMailWorker", make_worker)
    assert module.start_welcome_retry_worker(app) is worker
    assert app.state.welcome_mail_worker is worker
    assert repositories == [runtime_config]
    assert started == [True]


def test_welcome_worker_connection_enforces_finite_database_waits(monkeypatch):
    module = import_module("music_app.services.auth_welcome_worker")
    calls = []
    monkeypatch.setattr(module, "psycopg", SimpleNamespace(connect=lambda url, **kwargs: calls.append((url, kwargs)) or object()))
    module._worker_connect("postgresql://owned-test")
    assert calls[0][1]["connect_timeout"] > 0
    assert "statement_timeout=" in calls[0][1]["options"]
    assert "lock_timeout=" in calls[0][1]["options"]


def test_welcome_worker_shutdown_deadline_retains_actual_database_task_until_it_exits():
    module = import_module("music_app.services.auth_welcome_worker")
    entered, release, exited = Event(), Event(), Event()
    repository = Repository()
    def select(*, limit):
        entered.set()
        try:
            assert release.wait(3)
            return [1]
        finally:
            exited.set()
    repository.list_due_welcome_ids = select
    async def scenario():
        worker = module.WelcomeMailWorker(repository=repository, config=CONFIG,
            shutdown_timeout_seconds=0.01)
        worker.start()
        try:
            await _until(entered.is_set)
            with pytest.raises(RuntimeError, match="shutdown is incomplete"):
                await worker.stop()
            assert worker.task is not None and not worker.task.done()
            assert not exited.is_set(), "A deadline must not be mistaken for thread termination"
            assert repository.claims == []
        finally:
            release.set()
            await _until(exited.is_set)
            await _until(lambda: worker.task.done())
            await worker.stop()
        assert worker.task is None
    asyncio.run(scenario())
