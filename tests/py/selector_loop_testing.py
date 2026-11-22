"""Real children on the Selector loop that serves Windows deployments."""

from __future__ import annotations

import asyncio
import subprocess

import pytest


def on_selector_loop(scenario):
    loop = asyncio.SelectorEventLoop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(asyncio.wait_for(scenario, 60))
    finally:
        loop.run_until_complete(loop.shutdown_default_executor())
        loop.close()
        asyncio.set_event_loop(None)


@pytest.fixture
def children(monkeypatch) -> list[subprocess.Popen]:
    started: list[subprocess.Popen] = []

    class RecordedPopen(subprocess.Popen):
        def __init__(self, *args, **kwargs) -> None:
            super().__init__(*args, **kwargs)
            started.append(self)

    monkeypatch.setattr(subprocess, "Popen", RecordedPopen)
    return started
