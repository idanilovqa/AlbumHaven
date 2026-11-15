"""Playback's own threads, so starting, seeking and streaming never queue behind library work.

``asyncio.to_thread`` shares one pool with scans, cover lookups, preview relocation and every other
background job; under load a playback step waited seconds there (a reference resolution once took
7.8 s). Everything on the audible path runs here instead.
"""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from typing import Callable, TypeVar

_T = TypeVar("_T")
_EXECUTOR = ThreadPoolExecutor(max_workers=8, thread_name_prefix="playback-io")


async def run_playback_io(function: Callable[..., _T], *args: object) -> _T:
    return await asyncio.get_running_loop().run_in_executor(_EXECUTOR, partial(function, *args))
