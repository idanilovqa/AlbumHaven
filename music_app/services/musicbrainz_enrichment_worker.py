from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import Callable, Mapping

from music_app.services.musicbrainz_client import MusicBrainzClient
from music_app.services.musicbrainz_enrichment import (
    MusicBrainzArtistEnrichmentProcessor,
    resolve_artist,
)
from music_app.services.musicbrainz_enrichment_postgres import (
    MusicBrainzEnrichmentPostgresRepository,
)
from music_app.services.musicbrainz_http import _set_block


class MusicBrainzEnrichmentWorker:
    def __init__(
        self,
        *,
        processor,
        worker_id: str,
        batch_size: int = 10,
        poll_seconds: float = 30,
        set_provider_cooldown: Callable[[float], None] | None = None,
        logger=None,
    ) -> None:
        if (
            isinstance(batch_size, bool)
            or not isinstance(batch_size, int)
            or batch_size < 1
        ):
            raise ValueError("MusicBrainz worker batch size must be positive.")
        if (
            isinstance(poll_seconds, bool)
            or not isinstance(poll_seconds, (int, float))
            or poll_seconds <= 0
        ):
            raise ValueError("MusicBrainz worker poll interval must be positive.")
        self._processor = processor
        self._worker_id = str(worker_id)
        self._batch_size = batch_size
        self._poll_seconds = float(poll_seconds)
        self._set_provider_cooldown = set_provider_cooldown or (lambda _seconds: None)
        self._logger = logger or logging.getLogger(__name__)
        self._stopping = asyncio.Event()
        self.task: asyncio.Task | None = None

    async def run_once(self) -> dict[str, int]:
        summary = {
            "processed": 0,
            "succeeded": 0,
            "needs_review": 0,
            "retry_wait": 0,
            "exhausted": 0,
        }
        for _index in range(self._batch_size):
            if self._stopping.is_set():
                break
            result = await asyncio.to_thread(
                self._processor.process_next,
                worker_id=self._worker_id,
            )
            if not result.get("processed"):
                break
            summary["processed"] += 1
            state = str(result.get("state") or "")
            if state in summary:
                summary[state] += 1
            if result.get("classification") == "rate_limited":
                self._set_provider_cooldown(float(result.get("cooldown_seconds") or 30))
                break
        return summary

    def start(self) -> None:
        if self.task is None and not self._stopping.is_set():
            self.task = asyncio.create_task(
                self._run(),
                name="albumhaven-musicbrainz-enrichment",
            )

    async def stop(self) -> None:
        self._stopping.set()
        if self.task is None:
            return
        task = self.task
        try:
            await task
        finally:
            if self.task is task:
                self.task = None

    async def _run(self) -> None:
        while not self._stopping.is_set():
            try:
                await self.run_once()
            except Exception:
                self._logger.warning("MusicBrainz enrichment pass failed safely.")
            try:
                await asyncio.wait_for(
                    self._stopping.wait(),
                    timeout=self._poll_seconds,
                )
            except asyncio.TimeoutError:
                pass


def build_musicbrainz_enrichment_worker(*, config: Mapping[str, object]):
    repository = MusicBrainzEnrichmentPostgresRepository(config)
    client = MusicBrainzClient(
        base_url=str(config.get("MUSICBRAINZ_BASE_URL") or ""),
        user_agent=str(config.get("MUSICBRAINZ_USER_AGENT") or "Album Haven"),
    )
    processor = MusicBrainzArtistEnrichmentProcessor(
        repository=repository,
        client=client,
        resolve_artist=resolve_artist,
    )
    return MusicBrainzEnrichmentWorker(
        processor=processor,
        worker_id=f"musicbrainz-{uuid.uuid4()}",
        batch_size=int(config.get("MUSICBRAINZ_ENRICHMENT_BATCH_SIZE") or 10),
        poll_seconds=float(config.get("MUSICBRAINZ_ENRICHMENT_POLL_SECONDS") or 30),
        set_provider_cooldown=lambda seconds: _set_block(
            "rate_limited",
            cooldown_seconds=seconds,
        ),
    )


def start_musicbrainz_enrichment_worker(app):
    existing = getattr(app.state, "musicbrainz_enrichment_worker", None)
    if existing is not None:
        return existing
    config = app.state.config
    if (
        config.get("MUSICBRAINZ_ENRICHMENT_ENABLED") is not True
        or not str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
    ):
        return None
    worker = build_musicbrainz_enrichment_worker(config=config)
    app.state.musicbrainz_enrichment_worker = worker
    worker.start()
    return worker


async def stop_musicbrainz_enrichment_worker(app) -> bool:
    worker = getattr(app.state, "musicbrainz_enrichment_worker", None)
    if worker is None:
        return False
    try:
        await worker.stop()
    finally:
        app.state.musicbrainz_enrichment_worker = None
    return True
