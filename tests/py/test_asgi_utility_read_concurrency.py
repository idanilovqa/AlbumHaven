from __future__ import annotations

import asyncio
import inspect
from threading import Event, Timer
import time

import pytest

from tests.py.asgi_testing import run_asgi_request_async


def test_problematic_read_paths_have_no_legacy_projector_or_prewarm_fallback():
    from music_app.routes import api_read_asgi_routes
    from music_app.services import library_browse_postgres

    route_source = "\n".join(
        inspect.getsource(owner)
        for owner in (
            api_read_asgi_routes.utilities_problematic_files,
            api_read_asgi_routes.utilities_problematic_file_detail_query,
            api_read_asgi_routes.utilities_problematic_file_detail,
        )
    )
    for forbidden in (
        "build_problematic_files_payload",
        "build_problematic_albums_payload",
        "build_problematic_album_detail_payload",
        "_hydrate_cached_library_for_asgi",
        "_is_postgres_utility_projection_request",
    ):
        assert forbidden not in route_source

    browse_source = inspect.getsource(
        library_browse_postgres.PostgresLibraryBrowseRepository
    )
    for forbidden in (
        "def build_problematic_files_payload(",
        "def _build_problematic_files_payload_uncached(",
        "def _build_problematic_files_payload_from_rows(",
        "self.build_problematic_files_payload()",
    ):
        assert forbidden not in browse_source


@pytest.mark.parametrize(
    ("module_name", "selector_name", "path"),
    (
        (
            "music_app.routes.api_read_asgi_routes",
            None,
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
    selector_name: str | None,
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

        def build_problematic_files_page(self, **_kwargs):
            return self.build_problematic_files_payload()

        def build_utility_rules_payload(self):
            self._block()
            return {"ok": True, "rules": [], "ignored_version_keys": []}

    if selector_name is not None:
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
