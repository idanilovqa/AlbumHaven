from pathlib import Path
from types import SimpleNamespace

from music_app.jobs import full_scan_executor


def test_full_scan_progress_is_bounded_and_phase_changes_are_immediate(monkeypatch):
    clock = {"value": 10.0}
    checkpoints = []
    cancellation_checks = []

    def checkpoint(**values):
        checkpoints.append(values)
        clock["value"] += 2.0  # Model a slow durable checkpoint round trip.

    def scan_music_incremental(**kwargs):
        callback = kwargs["progress_callback"]
        state = kwargs["library_state"]
        for current in range(1, 11):
            state.update(
                scan_elapsed_seconds=current / 2,
                scan_estimated_remaining_seconds=(10 - current) / 2,
                scan_files_per_second=2.0,
                scan_album_folders_processed=current,
                scan_album_folders_total=10,
            )
            callback(
                phase="indexing",
                current=current,
                total=10,
                current_path=f"Artist/Album/{current:02}.flac",
            )
        return ({"track": {}}, 1.0)

    class Adapter:
        def __init__(self, _config):
            pass

        def prepare_full_scan_inventory(self, _cache, **_kwargs):
            return {"artists": [], "albums": [], "tracks": [], "track_files": []}

    class Repository:
        def load_claimed_full_scan_cache(self, **_kwargs):
            return {"track": {"mtime": 1.0, "size": 1}}

        def publish_claimed_full_scan(self, **_kwargs):
            return {"publication_won": True, "inventory_mutation_revision": 41}

    monkeypatch.setattr(full_scan_executor.time, "monotonic", lambda: clock["value"])
    monkeypatch.setattr(
        full_scan_executor.state_service,
        "scan_music_incremental",
        scan_music_incremental,
    )
    monkeypatch.setattr(full_scan_executor, "PostgresScanCacheAdapter", Adapter)

    executor = full_scan_executor.DurableFullScanExecutor(
        config={}, scan_repository=Repository()
    )
    executor.bind_claim(SimpleNamespace(job_id=1))
    executor.bind_scope(SimpleNamespace(separate_release_keys=()))
    result = executor.run(
        SimpleNamespace(intent_id=2, mode="manual_full_rescan", force=True),
        roots=({"id": "root-a", "path": Path("C:/Music")},),
        checkpoint=checkpoint,
        should_cancel=lambda: cancellation_checks.append(clock["value"]) or False,
        expected_revision=40,
    )

    assert result.inventory_mutation_revision == 41
    assert [item["phase"] for item in checkpoints] == [
        "indexing",
        "indexing",
        "finalizing",
    ]
    assert checkpoints[1]["current"] == 10
    assert checkpoints[1]["album_folders_processed"] == 10
    assert checkpoints[1]["files_per_second"] == 2.0
    assert len(cancellation_checks) <= len(checkpoints) + 2


def test_full_scan_publishes_claim_fenced_partial_browse_snapshots(monkeypatch):
    published_previews = []

    def scan_music_incremental(**kwargs):
        publication_state = kwargs["publication_state"]
        publication_state.update(
            file_cache={"C:/Music/Artist/Album/track.flac": {"artist": "Artist"}},
            albums=[SimpleNamespace(key="artist::album")],
        )
        kwargs["publish_partial_snapshot"]()
        return publication_state["file_cache"], 1.0

    class Adapter:
        def __init__(self, _config):
            pass

        def prepare_full_scan_inventory(self, _cache, **_kwargs):
            return {"artists": [], "albums": [], "tracks": [], "track_files": []}

    class Repository:
        def publish_claimed_full_scan_preview(self, **values):
            published_previews.append(values)
            return True

        def publish_claimed_full_scan(self, **_kwargs):
            return {"publication_won": True, "inventory_mutation_revision": 41}

    monkeypatch.setattr(
        full_scan_executor.state_service,
        "scan_music_incremental",
        scan_music_incremental,
    )
    monkeypatch.setattr(full_scan_executor, "PostgresScanCacheAdapter", Adapter)

    claim = SimpleNamespace(
        job_id=1,
        attempt=2,
        worker_id="worker-a",
        lease_token="lease-a",
    )
    executor = full_scan_executor.DurableFullScanExecutor(
        config={}, scan_repository=Repository()
    )
    executor.bind_claim(claim)
    executor.bind_scope(SimpleNamespace(separate_release_keys=("release-a",)))
    result = executor.run(
        SimpleNamespace(intent_id=2, mode="manual_full_rescan", force=True),
        roots=({"id": "root-a", "path": Path("C:/Music")},),
        checkpoint=lambda **_values: None,
        should_cancel=lambda: False,
        expected_revision=40,
    )

    assert result.inventory_mutation_revision == 41
    assert published_previews == [
        {
            "claim": claim,
            "intent_id": 2,
            "file_cache": {
                "C:/Music/Artist/Album/track.flac": {"artist": "Artist"}
            },
            "separate_release_keys": ("release-a",),
            "album_total": 1,
            "now": published_previews[0]["now"],
        }
    ]


def test_regular_durable_scan_reuses_existing_metadata_cache(monkeypatch):
    cache_flags = []

    def scan_music_incremental(**kwargs):
        cache_flags.append(kwargs["use_existing_cache"])
        return ({"track": {}}, 1.0)

    class Adapter:
        def __init__(self, _config):
            pass

        def prepare_full_scan_inventory(self, _cache, **_kwargs):
            return {"artists": [], "albums": [], "tracks": [], "track_files": []}

    class Repository:
        def load_claimed_full_scan_cache(self, **_kwargs):
            return {"track": {"mtime": 1.0, "size": 1}}

        def publish_claimed_full_scan(self, **_kwargs):
            return {"publication_won": True, "inventory_mutation_revision": 41}

    monkeypatch.setattr(
        full_scan_executor.state_service,
        "scan_music_incremental",
        scan_music_incremental,
    )
    monkeypatch.setattr(full_scan_executor, "PostgresScanCacheAdapter", Adapter)
    executor = full_scan_executor.DurableFullScanExecutor(
        config={}, scan_repository=Repository()
    )
    executor.bind_claim(SimpleNamespace(job_id=1))
    executor.bind_scope(SimpleNamespace(separate_release_keys=()))

    executor.run(
        SimpleNamespace(intent_id=2, mode="background", force=True),
        roots=({"id": "root-a", "path": Path("C:/Music")},),
        checkpoint=lambda **_values: None,
        should_cancel=lambda: False,
        expected_revision=40,
    )

    assert cache_flags == [True]
