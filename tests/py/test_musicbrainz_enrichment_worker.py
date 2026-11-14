from __future__ import annotations

import asyncio
from importlib import import_module
import inspect
from types import SimpleNamespace

import pytest


def worker_api():
    try:
        return import_module("music_app.services.musicbrainz_enrichment_worker")
    except ModuleNotFoundError:
        pytest.fail("MusicBrainz enrichment worker is not implemented yet", pytrace=False)


class Processor:
    def __init__(self, results):
        self.results = list(results)
        self.calls = []

    def process_next(self, *, worker_id):
        self.calls.append(worker_id)
        if not self.results:
            return {"processed": False, "state": "idle"}
        return self.results.pop(0)


def test_worker_run_once_is_batch_bounded_and_stops_claiming_when_queue_is_empty():
    api = worker_api()
    processor = Processor(
        [
            {"processed": True, "state": "succeeded"},
            {"processed": True, "state": "needs_review"},
            {"processed": False, "state": "idle"},
            {"processed": True, "state": "succeeded"},
        ]
    )

    async def scenario():
        worker = api.MusicBrainzEnrichmentWorker(
            processor=processor,
            worker_id="worker-a",
            batch_size=10,
            poll_seconds=30,
        )
        assert await worker.run_once() == {
            "processed": 2,
            "succeeded": 1,
            "needs_review": 1,
            "retry_wait": 0,
            "exhausted": 0,
            "rate_limited": 0,
        }
        await worker.stop()

    asyncio.run(scenario())
    assert processor.calls == ["worker-a", "worker-a", "worker-a"]


def test_worker_never_processes_more_than_configured_batch_size():
    api = worker_api()
    processor = Processor(
        [{"processed": True, "state": "succeeded"} for _index in range(5)]
    )

    async def scenario():
        worker = api.MusicBrainzEnrichmentWorker(
            processor=processor,
            worker_id="worker-a",
            batch_size=2,
            poll_seconds=30,
        )
        summary = await worker.run_once()
        assert summary["processed"] == 2
        await worker.stop()

    asyncio.run(scenario())
    assert processor.calls == ["worker-a", "worker-a"]
    assert len(processor.results) == 3


def test_rate_limit_result_stops_the_batch_and_applies_shared_cooldown():
    api = worker_api()
    processor = Processor(
        [
            {
                "processed": True,
                "state": "retry_wait",
                "classification": "rate_limited",
                "cooldown_seconds": 120,
            },
            {"processed": True, "state": "succeeded"},
        ]
    )
    delays = []

    async def scenario():
        worker = api.MusicBrainzEnrichmentWorker(
            processor=processor,
            worker_id="worker-a",
            batch_size=10,
            poll_seconds=30,
            set_provider_cooldown=lambda seconds: delays.append(seconds),
        )
        summary = await worker.run_once()
        assert summary["processed"] == 1
        assert summary["retry_wait"] == 1
        await worker.stop()

    asyncio.run(scenario())
    assert processor.calls == ["worker-a"]
    assert delays == [120]


def test_worker_start_is_idempotent_and_stop_owns_the_loop_until_exit():
    api = worker_api()
    processor = Processor([])

    async def scenario():
        worker = api.MusicBrainzEnrichmentWorker(
            processor=processor,
            worker_id="worker-a",
            batch_size=1,
            poll_seconds=60,
        )
        worker.start()
        task = worker.task
        worker.start()
        assert worker.task is task
        assert task is not None and not task.done()
        await worker.stop()
        assert worker.task is None
        assert task.done()

    asyncio.run(scenario())


def test_worker_failure_is_safely_logged_and_does_not_kill_owned_loop():
    api = worker_api()
    calls = []

    class FailingProcessor:
        def process_next(self, *, worker_id):
            calls.append(worker_id)
            if len(calls) == 1:
                raise RuntimeError("private provider payload")
            return {"processed": False, "state": "idle"}

    logged = []

    async def until(predicate):
        async def wait():
            while not predicate():
                await asyncio.sleep(0)

        await asyncio.wait_for(wait(), 2)

    async def scenario():
        worker = api.MusicBrainzEnrichmentWorker(
            processor=FailingProcessor(),
            worker_id="worker-a",
            batch_size=1,
            poll_seconds=0.01,
            logger=SimpleNamespace(warning=lambda message: logged.append(message)),
        )
        worker.start()
        try:
            await until(lambda: len(calls) >= 2)
        finally:
            await worker.stop()

    asyncio.run(scenario())
    assert logged == ["MusicBrainz enrichment pass failed safely (RuntimeError)."]


def test_runtime_start_constructs_exactly_one_enabled_worker_and_stop_clears_it(
    monkeypatch,
):
    api = worker_api()
    started = []
    stopped = []

    async def stop():
        stopped.append(True)

    worker = SimpleNamespace(
        start=lambda: started.append(True),
        stop=stop,
    )
    app = SimpleNamespace(
        state=SimpleNamespace(
            config={
                "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://owned-test",
                "MUSICBRAINZ_ENRICHMENT_ENABLED": True,
            }
        )
    )
    constructed = []

    def make_worker(*, config):
        constructed.append(config)
        return worker

    monkeypatch.setattr(api, "build_musicbrainz_enrichment_worker", make_worker)

    assert api.start_musicbrainz_enrichment_worker(app) is worker
    assert api.start_musicbrainz_enrichment_worker(app) is worker
    assert app.state.musicbrainz_enrichment_worker is worker
    assert constructed == [app.state.config]
    assert started == [True]

    async def scenario():
        assert await api.stop_musicbrainz_enrichment_worker(app) is True

    asyncio.run(scenario())
    assert stopped == [True]
    assert app.state.musicbrainz_enrichment_worker is None


def test_disabled_runtime_does_not_construct_a_worker(monkeypatch):
    api = worker_api()
    app = SimpleNamespace(
        state=SimpleNamespace(
            config={
                "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://owned-test",
                "MUSICBRAINZ_ENRICHMENT_ENABLED": False,
            }
        )
    )
    monkeypatch.setattr(
        api,
        "build_musicbrainz_enrichment_worker",
        lambda **_kwargs: pytest.fail("disabled enrichment constructed a worker"),
    )

    assert api.start_musicbrainz_enrichment_worker(app) is None


def test_runtime_worker_can_be_disabled_without_disabling_management_api(monkeypatch):
    api = worker_api()
    app = SimpleNamespace(
        state=SimpleNamespace(
            config={
                "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://owned-test",
                "MUSICBRAINZ_ENRICHMENT_ENABLED": True,
                "MUSICBRAINZ_ENRICHMENT_WORKER_ENABLED": False,
            }
        )
    )
    monkeypatch.setattr(
        api,
        "build_musicbrainz_enrichment_worker",
        lambda **_kwargs: pytest.fail("disabled worker was constructed"),
    )

    assert api.start_musicbrainz_enrichment_worker(app) is None


def test_lifespan_source_starts_and_stops_the_musicbrainz_worker():
    music_app = import_module("music_app")
    source = inspect.getsource(music_app.create_asgi_app)

    assert "start_musicbrainz_enrichment_worker" in source
    assert "stop_musicbrainz_enrichment_worker" in source
    assert source.index("start_musicbrainz_enrichment_worker(") < source.index("yield")


def test_lanes_claim_under_their_own_lease_owner_until_the_queue_is_empty():
    api = worker_api()
    processor = Processor([{"processed": True, "state": "succeeded"}] * 5)

    async def scenario():
        worker = api.MusicBrainzEnrichmentWorker(
            processor=processor, worker_id="worker-a", batch_size=10, poll_seconds=30, concurrency=3,
        )
        summary = await worker.run_once()
        await worker.stop()
        return summary

    summary = asyncio.run(scenario())

    assert summary["processed"] == 5
    assert set(processor.calls) == {"worker-a-lane0", "worker-a-lane1", "worker-a-lane2"}


def test_a_busy_queue_is_claimed_again_without_the_idle_wait():
    api = worker_api()
    processor = Processor([{"processed": True, "state": "succeeded"}] * 3)

    async def scenario():
        worker = api.MusicBrainzEnrichmentWorker(
            processor=processor, worker_id="worker-a", batch_size=1, poll_seconds=30,
        )
        worker.start()
        # Three single-artist batches finish long before one 30 s idle wait could.
        for _ in range(200):
            if len(processor.calls) >= 4:
                break
            await asyncio.sleep(0.01)
        await worker.stop()

    asyncio.run(scenario())
    assert len(processor.calls) >= 4, "the worker waited between busy batches"


def test_concurrency_must_be_positive():
    api = worker_api()
    with pytest.raises(ValueError):
        api.MusicBrainzEnrichmentWorker(processor=Processor([]), worker_id="w", concurrency=0)
