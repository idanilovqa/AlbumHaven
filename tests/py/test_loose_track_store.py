"""Case 64: the Loose Tracks store's start-up owner builds without any read and retries a failed build on a timer."""
from __future__ import annotations

from types import SimpleNamespace

from music_app.services import loose_track_store


class _Repository:
    def __init__(self, reads):
        self._inventory_repository = object()
        self._reads = reads

    def _owned_connection_context(self):
        raise AssertionError("the owner reads its state through _seconds_until_retry, stubbed here")

    def build_library_loose_tracks_payload(self, **_kwargs):
        self._reads.append(True)


def test_a_fresh_store_is_prepared_at_start_without_any_read(monkeypatch):
    reads, prepared = [], []
    monkeypatch.setattr(loose_track_store, "prepare", lambda inventory, connect: prepared.append(inventory))
    owner = loose_track_store.LooseTrackStoreOwner({}, repository_factory=lambda: _Repository(reads))
    monkeypatch.setattr(owner, "_seconds_until_retry", lambda _repository: None)

    assert owner.run_once() is None

    assert len(prepared) == 1, "start-up preparation runs once, in the background owner"
    assert reads == [], "no read is needed for the store to become ready"


def test_a_failed_build_is_retried_after_its_backoff_with_no_read(monkeypatch):
    reads, prepared, waits = [], [], []
    monkeypatch.setattr(loose_track_store, "prepare", lambda inventory, connect: prepared.append(inventory))
    owner = loose_track_store.LooseTrackStoreOwner({}, repository_factory=lambda: _Repository(reads), poll_seconds=60)
    # The first build failed with 120 s to wait; after that wait the retry is due, and then the store is ready.
    retry_times = iter([120.0, 0.0, None, None])
    monkeypatch.setattr(owner, "_seconds_until_retry", lambda _repository: next(retry_times))

    def wait(seconds):
        waits.append(seconds)
        if len(waits) == 2:
            owner._stop.set()

    owner._stop = SimpleNamespace(is_set=lambda: getattr(owner, "_stopped", False),
                                  wait=wait, set=lambda: setattr(owner, "_stopped", True))
    owner._run()

    assert waits[0] == 120.0, "the owner waits for the failed build's own retry time, on a timer"
    assert len(prepared) == 2, "the build is retried once its backoff has passed"
    assert reads == []
