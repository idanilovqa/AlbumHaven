from __future__ import annotations

import asyncio
from threading import Event, Timer
import time

import pytest

from tests.py.asgi_testing import run_asgi_request_async


@pytest.mark.parametrize(
    ("module_name", "selector_name", "path"),
    (
        (
            "music_app.routes.api_read_asgi_routes",
            "_is_postgres_utility_projection_request",
            "/utilities/problematic-files",
        ),
        (
            "music_app.routes.api_wave_a_asgi_routes",
            "_is_postgres_utility_rules_request",
            "/utilities/rules",
        ),
    ),
)
def test_blocking_postgres_utility_reads_do_not_block_the_asgi_event_loop(
    asgi_app,
    monkeypatch,
    module_name: str,
    selector_name: str,
    path: str,
):
    module = __import__(module_name, fromlist=["unused"])
    started = Event()
    release = Event()

    class BlockingPostgresBrowseRepository:
        def __init__(self, _config):
            pass

        def _block(self):
            started.set()
            assert release.wait(2), "test release timer did not unblock the repository"

        def build_problematic_files_payload(self):
            self._block()
            return {"ok": True, "items": [], "initial_detail": None}

        def build_utility_rules_payload(self):
            self._block()
            return {"ok": True, "rules": [], "ignored_version_keys": []}

    monkeypatch.setattr(module, selector_name, lambda *_args, **_kwargs: True)
    monkeypatch.setattr(module, "PostgresLibraryBrowseRepository", BlockingPostgresBrowseRepository)

    async def exercise_concurrent_status_request() -> tuple[float, int, int]:
        release_timer = Timer(0.75, release.set)
        release_timer.start()
        started_at = time.perf_counter()
        utility_task = asyncio.create_task(run_asgi_request_async(asgi_app, "GET", path))
        try:
            assert await asyncio.to_thread(started.wait, 1), "utility repository did not start"
            status, _headers, _body = await asyncio.wait_for(
                run_asgi_request_async(asgi_app, "GET", "/status"),
                timeout=0.25,
            )
            status_elapsed = time.perf_counter() - started_at
        finally:
            release.set()
            release_timer.cancel()
        utility_status, _headers, _body = await utility_task
        return status_elapsed, status, utility_status

    status_elapsed, status, utility_status = asyncio.run(exercise_concurrent_status_request())

    assert status == 200
    assert utility_status == 200
    assert status_elapsed < 0.5
