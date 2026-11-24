"""The owner's manual MusicBrainz lookups in the enrichment worker (Delivery 2, S5)."""
from __future__ import annotations

from datetime import datetime, timezone

from music_app.services.musicbrainz_enrichment_worker import MusicBrainzEnrichmentChain
from music_app.services.musicbrainz_lookup_queue_postgres import MANUAL_LOOKUP_PRIORITY
from music_app.services.musicbrainz_release_identity import MusicBrainzAlbumReleaseProcessor

NOW = datetime(2026, 11, 16, 12, 0, tzinfo=timezone.utc)


class Lookups:
    def __init__(self, calls):
        self.calls = calls

    def advance(self, *, observed_at):
        self.calls.append(("advance", observed_at))


class Artists:
    def __init__(self, calls, processed=True):
        self.calls, self.processed = calls, processed

    def process_next(self, *, worker_id):
        self.calls.append("artist")
        return {"processed": self.processed, "state": "succeeded" if self.processed else "idle"}


class Albums:
    def __init__(self, calls, manual=()):
        self.calls, self.manual = calls, list(manual)

    def queue_artist(self, local_artist_id):
        self.calls.append(("queue", local_artist_id))

    def process_next(self, *, worker_id, min_priority=None):
        self.calls.append(("album", min_priority))
        if min_priority is not None:
            return self.manual.pop(0) if self.manual else {"processed": False, "state": "idle"}
        return {"processed": True, "state": "succeeded"}


def test_each_step_advances_the_lookup_queue_and_runs_a_manual_album_lookup_before_the_artist_backlog():
    calls = []
    chain = MusicBrainzEnrichmentChain(Artists(calls), Albums(calls, [{"processed": True, "state": "succeeded"}]),
                                       lookups=Lookups(calls), now=lambda: NOW)

    chain.process_next(worker_id="w")
    chain.process_next(worker_id="w")

    assert calls == [("advance", NOW), ("album", MANUAL_LOOKUP_PRIORITY),
                     ("advance", NOW), ("album", MANUAL_LOOKUP_PRIORITY), "artist"]


def test_without_a_lookup_queue_the_chain_keeps_its_order():
    calls = []
    chain = MusicBrainzEnrichmentChain(Artists(calls, processed=False), Albums(calls))

    chain.process_next(worker_id="w")

    assert calls == ["artist", ("album", None)]


class Repository:
    def __init__(self):
        self.claims, self.enqueued = [], 0

    def claim_due_job(self, **kwargs):
        self.claims.append(kwargs.get("min_priority"))
        return None

    def enqueue(self, **kwargs):
        self.enqueued += 1
        return 0

    def claim_transliteration(self, **_kwargs):
        return None

    def refresh_latin_titles(self, **_kwargs):
        return 0


def test_a_manual_only_album_claim_never_sweeps_the_library():
    repository = Repository()
    processor = MusicBrainzAlbumReleaseProcessor(repository=repository, client=None, now=lambda: NOW)

    assert processor.process_next(worker_id="w", min_priority=MANUAL_LOOKUP_PRIORITY) == {
        "processed": False, "state": "idle"}
    assert (repository.claims, repository.enqueued) == ([MANUAL_LOOKUP_PRIORITY], 0)

    processor.process_next(worker_id="w")
    assert (repository.claims[-1], repository.enqueued) == (None, 1)
