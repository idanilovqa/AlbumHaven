"""Bounded-interaction contracts for cover, preview, inventory and hydration workers.

Each contract runs the real worker over real files and counts filesystem and
media work; only Postgres collaborators are doubles.
"""

from __future__ import annotations

from concurrent.futures import Future
from copy import deepcopy
from dataclasses import asdict
import hashlib
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

from music_app.services import covers as covers_module
from music_app.services import library_roots as library_roots_module
from music_app.services.library_roots import normalize_library_root_settings
from tests.py.bounded_interactions import OperationCounts, assert_plateau, measure_scale_pair
from tests.py.filesystem_operation_counting import count_filesystem_and_media

_DATABASE_URL = "postgresql://album_haven_app@localhost/app"


class _RootSettingsStore:
    settings: dict[str, object] = {}

    def __init__(self, _config):
        pass

    def load_settings(self, **_kwargs):
        return deepcopy(type(self).settings)


@pytest.fixture
def music_dir(tmp_path, monkeypatch):
    root = (tmp_path / "music").resolve()
    root.mkdir()
    _RootSettingsStore.settings = normalize_library_root_settings({}, fallback_main_root=root)
    monkeypatch.setattr(library_roots_module, "PostgresLibraryRootSettingsStore", _RootSettingsStore)
    return root


def _write_cover(path: Path, *, edge: int = 600) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (edge, edge), "teal").save(path, format="JPEG")
    return path


def _seed_sibling_albums(music_dir: Path, album_count: int) -> None:
    for index in range(album_count):
        folder = music_dir / f"Artist {index:04d}" / f"Album {index:04d}"
        folder.mkdir(parents=True)
        (folder / "01.mp3").write_bytes(b"track")
        (folder / "cover.jpg").write_bytes(b"sibling cover")


def _counted(monkeypatch, action, *, media_modules=()) -> tuple[OperationCounts, object]:
    counts = OperationCounts()
    with count_filesystem_and_media(monkeypatch, counts, media_modules=media_modules):
        result = action()
    return counts, result


class _Rows:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return list(self._rows)

    def fetchone(self):
        return self._rows[0] if self._rows else None


def test_cover_preview_backfill_contract_settles_after_one_pass_over_production_cycles(tmp_path, monkeypatch):
    from music_app.services.cover_preview_backfill import CoverPreviewBackfill

    album_count = 20
    sources = [_write_cover(tmp_path / "music" / f"Artist {index:02d}" / "Album" / "cover.jpg") for index in range(album_count)]
    rows = [{"cover_path": str(source), "cover_revision": None} for source in sources]

    def run(cycles: int) -> OperationCounts:
        data_dir = tmp_path / f"appdata-{cycles}"
        per_cycle: list[dict[str, float]] = []  # counts when each pass starts
        worker = None

        class Connection:
            def __enter__(self):
                return self

            def __exit__(self, *_exc):
                return False

            def execute(self, _sql):
                counts.sql_statements += 1
                if len(per_cycle) == cycles:
                    worker._stop_requested.set()
                    return _Rows([])
                per_cycle.append(asdict(counts))
                counts.returned_rows += len(rows)
                return _Rows(rows)

        worker = CoverPreviewBackfill(
            {"ALBUM_HAVEN_APP_DATABASE_URL": _DATABASE_URL, "DATA_DIR": data_dir},
            connect=lambda *_args, **_kwargs: Connection(),
            quiet_seconds=0,
            throttle_seconds=0,
            rescan_seconds=0.01,
        )
        counts = OperationCounts()
        with count_filesystem_and_media(monkeypatch, counts, media_modules=(covers_module,)):
            worker._run_forever()
        assert len(per_cycle) == cycles
        assert len(list((data_dir / "display-cover-cache").rglob("*.jpg"))) == album_count
        # Every pass after the first finds every preview settled and touches no file.
        settled = [*per_cycle[1:], asdict(counts)]
        if len(settled) > 1:
            for metric in ("stat_calls", "open_calls", "media_parses"):
                assert_plateau([sample[metric] for sample in settled], label=f"backfill {metric} per settled pass")
        return counts

    measure_scale_pair(
        interaction_id="py:services/cover_preview_backfill.py#CoverPreviewBackfill._run_forever",
        small=1,
        large=100,
        run=run,
        budgets={"filesystem_enumerations": 0, "stat_calls": 481, "open_calls": 20, "media_parses": 20},
        growth=("stat_calls", 0),
    )


@pytest.fixture
def background_admissions(monkeypatch):
    """Queues background admissions without starting drainers, then clears the scheduler."""
    submitted: list[dict[str, bool]] = []

    class RecordingExecutor:
        def submit(self, _fn, token):
            submitted.append(token)
            return Future()

    def clear() -> None:
        covers_module._COVER_VARIANT_ADMISSION_INFLIGHT.clear()
        covers_module._COVER_VARIANT_BACKGROUND_PENDING.clear()
        covers_module._COVER_VARIANT_BACKGROUND_RUNNING.clear()
        monkeypatch.setattr(covers_module, "_COVER_VARIANT_BACKGROUND_DRAINERS", 0)

    clear()
    monkeypatch.setattr(covers_module, "_COVER_VARIANT_ADMISSION_EXECUTOR", RecordingExecutor())
    yield submitted
    clear()


def test_background_cover_admission_drain_contract_handles_only_the_capacity_at_production_queue_size(
    tmp_path, monkeypatch, background_admissions,
):
    def run(requested: int) -> OperationCounts:
        cache_root = tmp_path / f"cache-{requested}"
        for index in range(requested):
            source = tmp_path / f"covers-{requested}" / f"{index:04d}.jpg"
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_bytes(b"cover")
            preview = covers_module.build_cover_variant_base_path(source, cache_root=cache_root, max_size=480).with_suffix(".jpg")
            preview.parent.mkdir(parents=True, exist_ok=True)
            preview.write_bytes(b"preview")
            covers_module.queue_cover_display_variant_generation(source, cache_root=cache_root, max_size=480)
        tokens = list(background_admissions)
        background_admissions.clear()
        counts, _ = _counted(monkeypatch, lambda: [covers_module._drain_background_cover_admissions(token) for token in tokens])
        assert not covers_module._COVER_VARIANT_BACKGROUND_PENDING
        return counts

    measure_scale_pair(
        interaction_id="py:services/covers.py#_drain_background_cover_admissions",
        small=20,
        large=1_000,
        run=run,
        budgets={"filesystem_enumerations": 0, "stat_calls": 20, "open_calls": 0, "media_parses": 0},
        growth=("stat_calls", 0),
    )


def test_preview_relocation_contract_moves_each_claimed_batch_with_fixed_work_at_production_inventory_size(tmp_path, monkeypatch):
    from music_app.services.generated_preview_relocation import GeneratedPreviewRelocationWorker

    batch_size = 20

    def run(preview_count: int) -> OperationCounts:
        source_root = tmp_path / f"album-previews-{preview_count}"
        target_root = tmp_path / f"custom-previews-{preview_count}"
        pending = []
        for index in range(preview_count):
            source = source_root / f"{index:04d}.jpg"
            source.parent.mkdir(parents=True, exist_ok=True)
            payload = f"preview {index}".encode()
            source.write_bytes(payload)
            pending.append({
                "id": index, "source_path": str(source), "target_path": str(target_root / f"{index:04d}.jpg"),
                "expected_bytes": len(payload), "expected_sha256": hashlib.sha256(payload).hexdigest(),
            })
        counts = OperationCounts()
        batches: list[dict[str, int]] = []
        completed = []
        worker = None

        class Repository:
            state = {"operation_id": "move-1", "operation_state": "running"}

            def load(self):
                return dict(self.state)

            def operation_lock(self):
                from contextlib import nullcontext
                return nullcontext(True)

            def recover_interrupted_items(self, **_kwargs):
                pass

            def claim_batch(self, *, operation_id, limit):
                batches.append(asdict(counts))
                claimed, pending[:limit] = pending[:limit], []
                return claimed

            def complete_item(self, **result):
                completed.append(result["status"])

            def finish_operation(self, _operation_id):
                self.state = {"operation_state": "completed"}
                worker._stop_requested.set()
                return dict(self.state)

        worker = GeneratedPreviewRelocationWorker(Repository(), batch_size=batch_size, sync_grace_seconds=0)
        worker.wake()
        with count_filesystem_and_media(monkeypatch, counts):
            worker._run()
        batches.append(asdict(counts))
        assert completed == ["completed"] * preview_count
        assert not any(source_root.iterdir())
        deltas = [
            {metric: after[metric] - before[metric] for metric in before}
            for before, after in zip(batches, batches[1:])
        ]
        busiest = max(deltas, key=lambda delta: delta["stat_calls"])
        return OperationCounts(**busiest)

    measure_scale_pair(
        interaction_id="py:services/generated_preview_relocation.py#GeneratedPreviewRelocationWorker._run",
        small=20,
        large=1_000,
        run=run,
        budgets={"filesystem_enumerations": 0, "stat_calls": 140, "open_calls": 40, "media_parses": 0},
        growth=("open_calls", 0),
    )


def test_cover_job_contract_reads_only_the_job_album_folder_at_production_library_size(music_dir, monkeypatch):
    from music_app.services.cover_refresh_execution import execute_cover_job

    def run(album_count: int) -> OperationCounts:
        library = music_dir / f"library-{album_count}"
        _seed_sibling_albums(library, album_count)
        folder = library / "Selected Artist" / "Selected Album"
        for number in range(1, 13):
            (folder / f"{number:02d}.mp3").parent.mkdir(parents=True, exist_ok=True)
            (folder / f"{number:02d}.mp3").write_bytes(b"track")
        cover = _write_cover(folder / "cover.jpg")
        counts, result = _counted(monkeypatch, lambda: execute_cover_job(
            job={"folder": folder, "artist": "Selected Artist", "album": "Selected Album"},
            image_extensions={".jpg", ".jpeg", ".png"},
            user_agent="AlbumHavenTests/1.0",
            cover_cache=None,
            force_search=False,
            allow_apple_web_fallback=False,
            allow_apple_web_fallback_when_has_cover=False,
            negative_cache_ttl_seconds=None,
            enabled_provider_groups=[],
        ), media_modules=(covers_module,))
        assert result[0] == cover
        return counts

    measure_scale_pair(
        interaction_id="py:services/cover_refresh_execution.py#execute_cover_job",
        small=20,
        large=1_000,
        run=run,
        budgets={"filesystem_enumerations": 0, "stat_calls": 6, "open_calls": 0, "media_parses": 2},
        growth=("stat_calls", 0),
    )


def test_missing_album_removal_contract_probes_only_the_album_files_at_production_library_size(music_dir, monkeypatch):
    from music_app.services.missing_album_removal_postgres import PostgresMissingAlbumRemovalService

    stale_tracks = 12

    def run(album_count: int) -> OperationCounts:
        library = music_dir / f"library-{album_count}"
        _seed_sibling_albums(library, album_count)
        album_folder = library / "Removed Artist" / "Removed Album"
        # library.confirm_missing_album_removal returns only the locked album's
        # stale files and owning roots (migrations/postgres/0082).
        row = {
            "album_found": True, "active_file_count": 0, "unresolved_root_count": 0, "unhealthy_root_count": 0,
            "root_private_paths": [str(library)],
            "stale_private_paths": [str(album_folder / f"{number:02d}.mp3") for number in range(stale_tracks)],
            "removed_album_count": 1, "removed_album_key": "removed-album", "inventory_mutation_revision": 7,
        }

        class Connection:
            def __enter__(self):
                return self

            def __exit__(self, *_exc):
                return False

            def transaction(self):
                return self

            def execute(self, _sql, _params=None):
                return _Rows([row])

        service = PostgresMissingAlbumRemovalService(
            {"ALBUM_HAVEN_APP_DATABASE_URL": _DATABASE_URL}, connect=lambda _url: Connection(),
        )
        counts, result = _counted(monkeypatch, lambda: service.confirm_removal("removed-album"))
        assert result == {"removed_album_key": "removed-album", "library_revision": 7}
        return counts

    measure_scale_pair(
        interaction_id="py:routes/api_wave_a_asgi_routes.py#confirm_missing_album_removal",
        small=20,
        large=1_000,
        run=run,
        budgets={"filesystem_enumerations": 0, "stat_calls": 1 + stale_tracks, "open_calls": 0},
        growth=("stat_calls", 0),
    )


def test_background_hydration_contract_publishes_the_inventory_without_probing_files_at_production_track_count(
    music_dir, monkeypatch,
):
    from music_app.services import library_hydration, state as state_module

    tracks_per_album = 16
    snapshot: dict[str, dict[str, object]] = {}

    class SnapshotAdapter:
        backend = "postgres"

        def load_snapshot_strict(self, _cache_path, _root_identity):
            return snapshot, 1.0, {}, 0.0, None

        load_snapshot = load_snapshot_strict

    class InlineExecutor:
        def submit(self, fn, *args, **kwargs):
            fn(*args, **kwargs)

    monkeypatch.setattr(library_hydration, "select_scan_cache_adapter", lambda _config: SnapshotAdapter())
    monkeypatch.setattr(library_hydration, "load_separate_release_keys", lambda _config: set())
    monkeypatch.setattr(
        library_hydration, "select_runtime_persistence_adapter",
        lambda seam_id, _config: SimpleNamespace(seam_id=seam_id, effective_backend="postgres"),
    )
    monkeypatch.setattr(state_module, "load_exception_overrides", lambda _config: {})
    monkeypatch.setattr(state_module, "_HYDRATE_EXECUTOR", InlineExecutor())
    monkeypatch.setattr(state_module, "_prewarm_root_browse_payload_for_state", lambda *_args: None)
    config = {
        "MUSIC_DIR": music_dir,
        "CACHE_PATH": music_dir.parent / "inert-cache.json",
        "IMAGE_EXTENSIONS": {".jpg", ".png"},
        "ALBUM_HAVEN_APP_DATABASE_URL": _DATABASE_URL,
        "PERSISTENCE_BACKENDS": {"library_roots": "postgres"},
    }

    def run(track_count: int) -> OperationCounts:
        snapshot.clear()
        for index in range(track_count):
            album = index // tracks_per_album
            folder = music_dir / f"Artist {album % 997:03d}" / f"Album {album:05d}"
            path = str(folder / f"{index % tracks_per_album:02d}.mp3")
            snapshot[path] = {
                "path": path, "album": f"Album {album:05d}", "album_artist": f"Artist {album % 997:03d}",
                "artist": f"Artist {album % 997:03d}", "title": f"Track {index}",
                "track_number": index % tracks_per_album + 1, "cover_path": str(folder / "cover.jpg"),
            }
        library_state: dict[str, object] = {}
        counts, ready = _counted(
            monkeypatch,
            lambda: state_module.request_library_hydration_for_state(library_state, config, None),
            media_modules=(covers_module,),
        )
        assert ready is False and library_state["hydration_settled"] is True, library_state.get("last_error")
        assert len(library_state["albums"]) == -(-track_count // tracks_per_album)
        return counts

    measure_scale_pair(
        interaction_id="py:services/state.py#_hydrate_library_state_worker",
        small=20,
        large=160_000,
        run=run,
        budgets={"filesystem_enumerations": 0, "stat_calls": 3, "open_calls": 0, "media_parses": 0},
        growth=("stat_calls", 0),
    )
