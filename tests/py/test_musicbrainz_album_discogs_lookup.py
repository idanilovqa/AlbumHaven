"""A matched band's album that MusicBrainz lacks, asked on Discogs (owner 2026-11-21: "not
found" means found in neither; an album still waiting for a lookup doesn't count)."""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from music_app.services.discogs_metadata import DiscogsMetadataClient
from music_app.services.musicbrainz_album_discogs_lookup import (
    MAX_ALBUMS_PER_JOB,
    AlbumDiscogsLookupProcessor,
)

NOW = datetime(2026, 11, 22, 8, 0, tzinfo=timezone.utc)
TRACKS = [("Opening", 200), ("Middle", 250), ("Closing", 300)]


def _album(album_id=7, *, local_name="PFM", canonical_name="Premiata Forneria Marconi"):
    return {"id": album_id, "title": "Kingdom", "year": 2010, "signature": f"signature-{album_id}",
            "local_name": local_name, "canonical_name": canonical_name,
            "tracks": [{"title": title, "duration_seconds": seconds, "disc_number": 1, "track_number": number}
                       for number, (title, seconds) in enumerate(TRACKS, start=1)]}


def _discogs(*, known_artist=None, tracks=TRACKS, hits=1, fail_after=None):
    calls = []

    def get_json(path, params):
        calls.append((path, dict(params)))
        if fail_after is not None and len(calls) > fail_after:
            return None
        if path == "/database/search":
            found = known_artist in (None, params.get("artist"))
            return {"results": [{"id": 600 + number, "title": "Band - Kingdom"} for number in range(hits)]
                    if found else []}
        return {"title": "Kingdom", "year": 2010, "master_id": 501, "identifiers": [],
                "tracklist": [{"position": str(number), "type_": "track", "title": title,
                               "duration": f"{seconds // 60}:{seconds % 60:02d}"}
                              for number, (title, seconds) in enumerate(tracks, start=1)]}

    client = DiscogsMetadataClient(get_json)
    client.calls = calls
    return client


class _Repository:
    def __init__(self, albums, *, attempts=1, has_job=True):
        self.albums, self.attempts, self.has_job = list(albums), attempts, has_job
        self.recorded, self.finished, self.enqueued = [], [], []

    def claim_due_job(self, **_options):
        return {"id": 3, "local_artist_id": 11, "attempt_count": self.attempts} if self.has_job else {}

    def load_albums(self, *, limit, **_options):
        self.limit = limit
        return self.albums[:limit]

    def record(self, *, album, found, **_options):
        self.recorded.append((album["id"], album["signature"], found and found["discogs_release_id"]))

    def finish(self, **options):
        self.finished.append(options)

    def enqueue(self, **options):
        self.enqueued.append(options)


def _run(repository, discogs):
    return AlbumDiscogsLookupProcessor(
        repository=repository, discogs=discogs, now=lambda: NOW,
    ).process_next(worker_id="worker")


def test_an_album_discogs_certainly_has_is_stored_as_found():
    repository = _Repository([_album()])
    assert _run(repository, _discogs())["state"] == "succeeded"
    assert repository.recorded == [(7, "signature-7", 600)]


def test_an_album_discogs_lacks_is_stored_as_not_found():
    repository = _Repository([_album()])
    assert _run(repository, _discogs(hits=0))["state"] == "succeeded"
    assert repository.recorded == [(7, "signature-7", None)]


def test_the_same_title_with_other_tracks_on_discogs_is_not_that_album():
    repository = _Repository([_album()])
    _run(repository, _discogs(tracks=[("Alpha", 91), ("Beta", 92)]))
    assert repository.recorded == [(7, "signature-7", None)]


def test_the_musicbrainz_name_is_tried_before_saying_not_found():
    repository = _Repository([_album()])
    discogs = _discogs(known_artist="Premiata Forneria Marconi")
    _run(repository, discogs)
    assert repository.recorded == [(7, "signature-7", 600)]
    searched = [params["artist"] for path, params in discogs.calls if path == "/database/search"]
    assert searched == ["PFM", "Premiata Forneria Marconi"]


def test_one_name_is_never_searched_twice():
    discogs = _discogs(hits=0)
    _run(_Repository([_album(local_name="Muse", canonical_name="muse")]), discogs)
    assert len(discogs.calls) == 1


def test_one_album_costs_at_most_six_requests():
    discogs = _discogs(hits=5, tracks=[("Alpha", 91)])
    _run(_Repository([_album()]), discogs)
    assert len(discogs.calls) == 6


@pytest.mark.parametrize("fail_after", [0, 1])
def test_an_outage_never_reads_as_not_found(fail_after):
    repository = _Repository([_album()])
    assert _run(repository, _discogs(fail_after=fail_after))["state"] == "retry_wait"
    assert repository.recorded == []
    assert repository.finished[0]["retry_at"] > NOW


def test_answers_before_an_outage_are_kept():
    repository = _Repository([_album(1), _album(2)])
    _run(repository, _discogs(fail_after=2))
    assert repository.recorded == [(1, "signature-1", 600)]
    assert repository.enqueued == []


def test_retries_end():
    repository = _Repository([_album()], attempts=6)
    assert _run(repository, _discogs(fail_after=0))["state"] == "exhausted"
    assert repository.finished[0]["retry_at"] is None


@pytest.mark.parametrize("waiting", [12, 500])
def test_a_job_asks_about_a_bounded_number_of_albums(waiting):
    repository = _Repository([_album(number) for number in range(1, waiting + 1)])
    discogs = _discogs(hits=0)
    _run(repository, discogs)
    asked = min(waiting, MAX_ALBUMS_PER_JOB)
    assert repository.limit == MAX_ALBUMS_PER_JOB
    assert len(repository.recorded) == asked
    assert len(discogs.calls) == 2 * asked
    # A full job queues its artist again; a short one is done.
    assert len(repository.enqueued) == (1 if waiting >= MAX_ALBUMS_PER_JOB else 0)


def test_without_a_queued_job_nothing_is_asked_and_nothing_is_swept():
    repository, discogs = _Repository([_album()], has_job=False), _discogs()
    assert _run(repository, discogs) == {"processed": False, "state": "idle"}
    assert discogs.calls == [] and repository.enqueued == []
