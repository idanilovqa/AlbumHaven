from __future__ import annotations

from importlib import import_module
import inspect

import pytest

from music_app.services import scan_state, state


class Scheduler:
    def __init__(self):
        self.calls = []

    def schedule(self, trigger, **kwargs):
        self.calls.append((trigger, kwargs))
        return {"enqueued_count": 1}


def trigger_api():
    try:
        return import_module("music_app.services.musicbrainz_enrichment_triggers")
    except ModuleNotFoundError:
        pytest.fail("MusicBrainz enrichment trigger wiring is not implemented yet", pytrace=False)


@pytest.mark.parametrize(
    ("scan_mode", "added_album_count", "expected"),
    [
        ("manual_full_rescan", 0, ["full_scan"]),
        ("background", 0, ["periodic_scan"]),
        ("background", 2, ["periodic_scan", "new_album"]),
        ("manual_full_rescan", 2, ["full_scan", "new_album"]),
    ],
)
def test_successful_scan_publication_schedules_scan_and_new_album_triggers(
    scan_mode,
    added_album_count,
    expected,
):
    api = trigger_api()
    scheduler = Scheduler()

    api.schedule_after_scan(
        scheduler,
        scan_mode=scan_mode,
        added_album_count=added_album_count,
        publication_succeeded=True,
        superseded=False,
    )

    assert [trigger for trigger, _kwargs in scheduler.calls] == expected


@pytest.mark.parametrize(
    ("publication_succeeded", "superseded"),
    [(False, False), (True, True), (False, True)],
)
def test_failed_or_superseded_scan_never_schedules_enrichment(
    publication_succeeded,
    superseded,
):
    api = trigger_api()
    scheduler = Scheduler()

    api.schedule_after_scan(
        scheduler,
        scan_mode="manual_full_rescan",
        added_album_count=3,
        publication_succeeded=publication_succeeded,
        superseded=superseded,
    )

    assert scheduler.calls == []


def test_startup_and_stale_refresh_use_the_same_idempotent_scheduler():
    api = trigger_api()
    scheduler = Scheduler()

    api.schedule_startup_backfill(scheduler)
    api.schedule_stale_refresh(scheduler)

    assert scheduler.calls == [
        ("startup_backfill", {}),
        ("stale_refresh", {}),
    ]


def test_authorized_retry_requires_capability_and_artist_scope():
    api = trigger_api()
    scheduler = Scheduler()

    with pytest.raises(PermissionError):
        api.schedule_authorized_retry(
            scheduler,
            local_artist_id=41,
            has_enrichment_request_capability=False,
        )
    assert scheduler.calls == []

    api.schedule_authorized_retry(
        scheduler,
        local_artist_id=41,
        has_enrichment_request_capability=True,
    )
    assert scheduler.calls == [
        ("authorized_retry", {"local_artist_id": 41})
    ]


def test_scan_runtime_exposes_a_nonblocking_enrichment_hook_after_publication():
    signature = inspect.signature(scan_state.refresh_library_state)
    source = inspect.getsource(scan_state.refresh_library_state)

    assert "queue_musicbrainz_enrichment" in signature.parameters
    assert "schedule_after_scan" in source
    assert source.index("scan_completed_successfully") < source.index("schedule_after_scan")


def test_state_runtime_passes_scheduler_hook_without_waiting_for_provider_calls():
    source = inspect.getsource(state.refresh_library_for_state)

    assert "queue_musicbrainz_enrichment" in source
    assert "MusicBrainzClient" not in source
    assert "lookup_artist" not in source
    assert "search_artists" not in source


def test_startup_backfill_is_wired_before_the_worker_begins_polling():
    music_app = import_module("music_app")
    source = inspect.getsource(music_app.create_asgi_app)

    assert "schedule_startup_backfill" in source
    assert "start_musicbrainz_enrichment_worker" in source
    assert source.index("schedule_startup_backfill(") < source.index(
        "start_musicbrainz_enrichment_worker("
    )


def test_watcher_publication_with_changed_albums_queues_new_album_enrichment():
    from types import SimpleNamespace

    from music_app.services.musicbrainz_enrichment_triggers import schedule_after_targeted_commit

    calls = []
    scheduler = SimpleNamespace(schedule=lambda trigger, **_kwargs: calls.append(trigger))

    schedule_after_targeted_commit(scheduler, SimpleNamespace(revision=7, affected_album_keys=("new-album",)))
    schedule_after_targeted_commit(scheduler, SimpleNamespace(revision=8, affected_album_keys=()))
    schedule_after_targeted_commit(None, SimpleNamespace(revision=9, affected_album_keys=("other",)))

    assert calls == ["new_album"]


def test_watcher_scheduling_failure_never_fails_the_publication():
    from types import SimpleNamespace

    from music_app.services.musicbrainz_enrichment_triggers import schedule_after_targeted_commit

    warnings = []

    def fail(_trigger, **_kwargs):
        raise RuntimeError("database unavailable")

    schedule_after_targeted_commit(
        SimpleNamespace(schedule=fail),
        SimpleNamespace(revision=7, affected_album_keys=("new-album",)),
        logger=SimpleNamespace(warning=warnings.append),
    )

    assert len(warnings) == 1
