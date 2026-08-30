from __future__ import annotations

import base64
from copy import deepcopy
import io
from pathlib import Path
from threading import Event, Thread

import pytest

from music_app.services import cover_workflow
from music_app.services import library_roots as library_roots_module
from music_app.services.cover_workflow import (
    delete_local_cover_and_choose_next,
    download_remote_cover_to_folder,
    resolve_album_context,
    resolve_album_root_from_track_paths,
    save_pasted_image_as_authoritative_cover,
    validate_local_cover_source,
    write_remote_cover_bytes_as_authoritative_cover,
)
from music_app.services.cover_remote_image_downloads import RemoteImageFetchResult
from music_app.services.covers import Image, image_dimensions, score_image
from music_app.services.library_roots import normalize_library_root_settings
from music_app.services.library_roots import save_library_root_settings
from tests.py.runtime_testing import configure_test_app_paths


@pytest.fixture
def config(tmp_path, monkeypatch):
    paths = configure_test_app_paths(tmp_path, monkeypatch)
    return {
        "DATA_DIR": paths["data_dir"],
        "MUSIC_DIR": paths["music_dir"],
        "CACHE_PATH": paths["cache_path"],
        "COVER_CACHE_PATH": paths["cover_cache_path"],
        "LIBRARY_ROOTS_PATH": paths["library_roots_path"],
        "TESTING": True,
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
        "PERSISTENCE_BACKENDS": {"library_roots": "postgres"},
    }


def test_cover_workflow_tests_do_not_use_flask_fixture_or_app_context():
    source = Path(__file__).read_text(encoding="utf-8")

    assert "tests.py." + "flask_fixtures" not in source
    assert "app." + "app_context(" not in source


class FakePostgresLibraryRootSettingsStore:
    _settings_by_config_id: dict[int, dict[str, object]] = {}
    load_call_count = 0

    def __init__(self, config):
        self._config = config

    @classmethod
    def reset(cls) -> None:
        cls._settings_by_config_id = {}
        cls.load_call_count = 0

    def load_settings(self):
        type(self).load_call_count += 1
        return deepcopy(self._current_settings())

    def save_settings(self, raw_payload):
        settings = normalize_library_root_settings(
            raw_payload,
            fallback_main_root=Path(self._config["MUSIC_DIR"]).expanduser().resolve(strict=False),
        )
        self._settings_by_config_id[id(self._config)] = settings
        return deepcopy(settings)

    def _current_settings(self):
        config_id = id(self._config)
        if config_id not in self._settings_by_config_id:
            self._settings_by_config_id[config_id] = normalize_library_root_settings(
                {},
                fallback_main_root=Path(self._config["MUSIC_DIR"]).expanduser().resolve(strict=False),
            )
        return self._settings_by_config_id[config_id]


@pytest.fixture(autouse=True)
def postgres_library_root_fakes(monkeypatch):
    FakePostgresLibraryRootSettingsStore.reset()
    monkeypatch.setattr(
        library_roots_module,
        "PostgresLibraryRootSettingsStore",
        FakePostgresLibraryRootSettingsStore,
    )


def _write_jpeg(path: Path, color: tuple[int, int, int], *, size: tuple[int, int] = (12, 12)) -> None:
    assert Image is not None
    path.parent.mkdir(parents=True, exist_ok=True)
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format="JPEG", quality=95)
    path.write_bytes(buffer.getvalue())


def test_older_failed_cover_promotion_cannot_rollback_newer_committed_cover(tmp_path: Path):
    album_root = (tmp_path / "Generated" / "Kaipa" / "Kaipa").resolve()
    prior_cover = album_root / "cover.jpg"
    older_selection = album_root / "Front.jpg"
    newer_selection = album_root / "Folder.jpg"
    _write_jpeg(prior_cover, (180, 40, 40))
    _write_jpeg(older_selection, (40, 180, 220))
    _write_jpeg(newer_selection, (220, 180, 40))
    newer_bytes = newer_selection.read_bytes()

    older_promotion = cover_workflow.begin_local_image_promotion(
        older_selection,
        album_root,
    )
    assert prior_cover.read_bytes() == older_selection.read_bytes()
    newer_promotion = cover_workflow.begin_local_image_promotion(
        newer_selection,
        album_root,
    )
    assert prior_cover.read_bytes() == newer_bytes

    # The newer selection has committed. A delayed persistence failure from the
    # older selection must not restore bytes that predate the newer commit.
    cover_workflow.rollback_local_image_promotion(older_promotion)

    assert prior_cover.read_bytes() == newer_bytes
    assert newer_promotion.cover_path == prior_cover


def test_serialized_same_album_cover_promotions_run_in_order_and_release_lock(
    tmp_path: Path,
):
    album_root = (tmp_path / "Generated" / "Kaipa" / "Kaipa").resolve()
    canonical_cover = album_root / "cover.jpg"
    first_selection = album_root / "Art" / "Front.jpg"
    second_selection = album_root / "Art" / "Back.jpg"
    _write_jpeg(canonical_cover, (180, 40, 40))
    _write_jpeg(first_selection, (40, 180, 220))
    _write_jpeg(second_selection, (220, 180, 40))
    first_bytes = first_selection.read_bytes()
    second_bytes = second_selection.read_bytes()
    lock_key = str(album_root.resolve(strict=False)).casefold()
    first_acquired = Event()
    allow_first_completion = Event()
    first_completed = Event()
    second_started = Event()
    second_acquired = Event()
    second_completed = Event()
    promotions: list[cover_workflow.LocalCoverPromotion] = []
    worker_errors: list[BaseException] = []

    def select_first_cover() -> None:
        promotion = None
        try:
            promotion = cover_workflow.begin_local_image_promotion(
                first_selection,
                album_root,
                serialize_selection=True,
            )
            promotions.append(promotion)
            first_acquired.set()
            if not allow_first_completion.wait(2):
                raise AssertionError("first promotion was not released by the test")
        except BaseException as exc:
            worker_errors.append(exc)
        finally:
            if promotion is not None:
                cover_workflow.complete_local_image_promotion(promotion)
            first_completed.set()

    def select_second_cover() -> None:
        promotion = None
        try:
            second_started.set()
            promotion = cover_workflow.begin_local_image_promotion(
                second_selection,
                album_root,
                serialize_selection=True,
            )
            promotions.append(promotion)
            second_acquired.set()
        except BaseException as exc:
            worker_errors.append(exc)
        finally:
            if promotion is not None:
                cover_workflow.complete_local_image_promotion(promotion)
            second_completed.set()

    first_worker = Thread(target=select_first_cover)
    second_worker = Thread(target=select_second_cover)
    first_worker.start()
    try:
        assert first_acquired.wait(1)
        assert canonical_cover.read_bytes() == first_bytes
        second_worker.start()
        assert second_started.wait(1)

        for _attempt in range(100):
            with cover_workflow._LOCAL_COVER_SELECTION_LOCKS_GUARD:
                lock_entry = cover_workflow._LOCAL_COVER_SELECTION_LOCKS.get(lock_key)
            if lock_entry is not None and lock_entry[1] == 2:
                break
            assert not second_completed.wait(0.01)
        else:
            pytest.fail("second same-album promotion did not queue on the selection lock")

        assert not second_acquired.is_set()
        assert canonical_cover.read_bytes() == first_bytes

        allow_first_completion.set()
        assert first_completed.wait(1)
        assert second_completed.wait(1)
    finally:
        allow_first_completion.set()
        first_worker.join(timeout=2)
        if second_worker.ident is not None:
            second_worker.join(timeout=2)

    assert not first_worker.is_alive()
    assert not second_worker.is_alive()
    assert worker_errors == []
    assert len(promotions) == 2
    assert promotions[1].prior_cover_bytes == first_bytes
    assert canonical_cover.read_bytes() == second_bytes
    with cover_workflow._LOCAL_COVER_SELECTION_LOCKS_GUARD:
        assert lock_key not in cover_workflow._LOCAL_COVER_SELECTION_LOCKS


def test_local_cover_promotion_atomically_replaces_canonical_for_concurrent_readers(
    tmp_path: Path,
    monkeypatch,
):
    album_root = (tmp_path / "Generated" / "Kaipa" / "Kaipa").resolve()
    canonical_cover = album_root / "cover.jpg"
    selected_cover = album_root / "Art" / "Front.jpg"
    _write_jpeg(canonical_cover, (180, 40, 40), size=(512, 512))
    _write_jpeg(selected_cover, (40, 180, 220), size=(512, 512))
    old_bytes = canonical_cover.read_bytes()
    new_bytes = selected_cover.read_bytes()
    replace_started = Event()
    allow_replace = Event()
    reader_stop = Event()
    observed: list[bytes | None] = []
    promotion_result: list[object] = []
    original_replace = cover_workflow.os.replace

    def gated_replace(source, destination):
        if Path(destination) == canonical_cover:
            replace_started.set()
            assert allow_replace.wait(2)
        return original_replace(source, destination)

    def read_canonical() -> None:
        while not reader_stop.is_set():
            try:
                observed.append(canonical_cover.read_bytes())
            except FileNotFoundError:
                observed.append(None)

    def promote() -> None:
        promotion_result.append(
            cover_workflow.begin_local_image_promotion(selected_cover, album_root)
        )

    monkeypatch.setattr(cover_workflow.os, "replace", gated_replace)
    reader = Thread(target=read_canonical)
    worker = Thread(target=promote)
    reader.start()
    worker.start()
    try:
        assert replace_started.wait(1), "promotion must reach an atomic canonical replacement"
        for _index in range(20):
            observed.append(canonical_cover.read_bytes())
        reader_stop.set()
        reader.join(timeout=2)
        assert not reader.is_alive()
        allow_replace.set()
        worker.join(timeout=2)
        assert not worker.is_alive()
        observed.append(canonical_cover.read_bytes())
    finally:
        reader_stop.set()
        reader.join(timeout=2)
        allow_replace.set()
        worker.join(timeout=2)

    assert promotion_result
    cover_workflow.complete_local_image_promotion(promotion_result[0])
    assert old_bytes in observed
    assert new_bytes in observed
    assert set(observed) <= {old_bytes, new_bytes}


def test_local_cover_promotion_rollback_atomically_restores_prior_bytes(
    tmp_path: Path,
    monkeypatch,
):
    album_root = (tmp_path / "Generated" / "Kaipa" / "Kaipa").resolve()
    canonical_cover = album_root / "cover.jpg"
    selected_cover = album_root / "Art" / "Front.jpg"
    _write_jpeg(canonical_cover, (180, 40, 40), size=(32, 32))
    _write_jpeg(selected_cover, (40, 180, 220), size=(32, 32))
    old_bytes = canonical_cover.read_bytes()
    new_bytes = selected_cover.read_bytes()
    canonical_replace_observations: list[tuple[bool, bytes]] = []
    original_replace = cover_workflow.os.replace

    def observe_replace(source, destination):
        if Path(destination) == canonical_cover:
            canonical_replace_observations.append(
                (canonical_cover.is_file(), Path(source).read_bytes())
            )
        return original_replace(source, destination)

    monkeypatch.setattr(cover_workflow.os, "replace", observe_replace)

    promotion = cover_workflow.begin_local_image_promotion(selected_cover, album_root)
    assert canonical_cover.read_bytes() == new_bytes
    cover_workflow.rollback_local_image_promotion(promotion)

    assert canonical_cover.read_bytes() == old_bytes
    assert canonical_replace_observations == [
        (True, new_bytes),
        (True, old_bytes),
    ]


def test_local_cover_promotion_never_allocates_an_existing_cover_reserve(
    tmp_path: Path,
):
    album_root = (tmp_path / "Generated" / "Kaipa" / "Kaipa").resolve()
    canonical_cover = album_root / "cover.jpg"
    selected_cover = album_root / "Art" / "Front.jpg"
    _write_jpeg(canonical_cover, (180, 40, 40), size=(32, 32))
    _write_jpeg(selected_cover, (40, 180, 220), size=(32, 32))
    for index in range(1, 100):
        (album_root / f"cover-existing-{index}.jpg").write_bytes(
            f"occupied-{index}".encode("ascii")
        )

    promotion = cover_workflow.begin_local_image_promotion(selected_cover, album_root)

    assert promotion.reserve_artifact is None
    assert not (album_root / "cover-existing-100.jpg").exists()
    assert canonical_cover.read_bytes() == selected_cover.read_bytes()
    cover_workflow.complete_local_image_promotion(promotion)


def test_external_cover_snapshot_without_serialization_preserves_read_failure_without_lock_release(
    tmp_path: Path,
    monkeypatch,
):
    album_root = (tmp_path / "Artist" / "Album").resolve()
    cover_path = album_root / "cover.jpg"
    cover_path.parent.mkdir(parents=True)
    cover_path.write_bytes(b"prior-cover-bytes")
    snapshot_error = OSError("cover snapshot read failed")
    release_error = AssertionError("lock release must not run without a lock")
    release_calls = []
    original_read_bytes = Path.read_bytes

    def fail_cover_snapshot(path):
        if path == cover_path:
            raise snapshot_error
        return original_read_bytes(path)

    def fail_lock_release(lock_key, selection_lock):
        release_calls.append((lock_key, selection_lock))
        raise release_error

    monkeypatch.setattr(Path, "read_bytes", fail_cover_snapshot)
    monkeypatch.setattr(
        cover_workflow,
        "_release_local_cover_selection_lock",
        fail_lock_release,
    )

    with pytest.raises(Exception) as exc_info:
        cover_workflow.begin_external_cover_write_promotion(
            album_root,
            serialize_selection=False,
        )

    assert exc_info.value is snapshot_error
    assert release_calls == []


def _image_bytes(color: tuple[int, int, int], *, image_format: str = "PNG", size: tuple[int, int] = (12, 12)) -> bytes:
    assert Image is not None
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format=image_format)
    return buffer.getvalue()


def _resized_patterned_jpeg_bytes(
    *,
    size: tuple[int, int],
    quality: int,
) -> bytes:
    assert Image is not None
    source = Image.new("RGB", (173, 179), (18, 28, 48))
    pixels = source.load()
    for y in range(source.height):
        for x in range(source.width):
            if (x // 11 + y // 13) % 3 == 0:
                pixels[x, y] = (32, 148, 216)
            elif abs(x - y) <= 3 or abs((source.width - x) - y) <= 3:
                pixels[x, y] = (232, 118, 42)
    resized = source.resize(size)
    buffer = io.BytesIO()
    resized.save(buffer, format="JPEG", quality=quality)
    return buffer.getvalue()


def test_remote_cover_save_does_not_reserve_a_larger_reencoded_copy_of_same_art(
    tmp_path: Path,
):
    album_root = (tmp_path / "Generated" / "Kaipa" / "Kaipa").resolve()
    canonical_cover = album_root / "cover.jpg"
    canonical_cover.parent.mkdir(parents=True, exist_ok=True)
    canonical_cover.write_bytes(
        _resized_patterned_jpeg_bytes(size=(173, 179), quality=18)
    )
    incoming_bytes = _resized_patterned_jpeg_bytes(
        size=(1038, 1074),
        quality=95,
    )

    written = write_remote_cover_bytes_as_authoritative_cover(
        album_root,
        incoming_bytes,
    )

    assert written == canonical_cover
    assert list(album_root.glob("cover-existing-*.jpg")) == []
    assert image_dimensions(canonical_cover) == (1038, 1074)


def test_remote_cover_save_reserves_distinct_low_detail_artwork(tmp_path: Path):
    album_root = (tmp_path / "Generated" / "Artist" / "Minimal Album").resolve()
    canonical_cover = album_root / "cover.jpg"
    canonical_cover.parent.mkdir(parents=True, exist_ok=True)
    canonical_cover.write_bytes(
        _image_bytes((100, 100, 100), image_format="JPEG", size=(300, 300))
    )

    written = write_remote_cover_bytes_as_authoritative_cover(
        album_root,
        _image_bytes((114, 114, 114), image_format="PNG", size=(1800, 1800)),
    )

    assert written == canonical_cover
    assert image_dimensions(album_root / "cover-existing-1.jpg") == (300, 300)


def test_remote_cover_save_reserves_subtle_localized_artwork_change(tmp_path: Path):
    album_root = (tmp_path / "Generated" / "Artist" / "Minimal Variant").resolve()
    canonical_cover = album_root / "cover.jpg"
    canonical_cover.parent.mkdir(parents=True, exist_ok=True)
    canonical_cover.write_bytes(
        _image_bytes((100, 100, 100), image_format="JPEG", size=(300, 300))
    )
    incoming = Image.new("RGB", (1800, 1800), (100, 100, 100))
    incoming.paste((114, 114, 114), (720, 720, 1080, 1080))
    incoming_buffer = io.BytesIO()
    incoming.save(incoming_buffer, format="PNG")

    written = write_remote_cover_bytes_as_authoritative_cover(
        album_root,
        incoming_buffer.getvalue(),
    )

    assert written == canonical_cover
    assert image_dimensions(album_root / "cover-existing-1.jpg") == (300, 300)


def test_resolve_album_context_uses_saved_library_roots_and_disc_parent(config):
    arrivals_root = (Path(config["DATA_DIR"]) / "ArrivalsRoot").resolve()
    album_disc = (arrivals_root / "Artist" / "Album" / "Disc 1").resolve()
    track_path = (album_disc / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")

    save_library_root_settings(
        config,
        {
            "main_library_roots": [{
                "id": "main-1",
                "path": str(config["MUSIC_DIR"]),
                "layout_mode": "artist",
            }],
            "new_arrivals_roots": [{
                "id": "arrivals-1",
                "path": str(arrivals_root),
            }],
        },
    )

    context = resolve_album_context(config, {"tracks": [{"path": str(track_path)}]})

    assert context is not None
    assert context.album_root == (arrivals_root / "Artist" / "Album").resolve()
    assert context.track_paths == {str(track_path)}


def test_resolve_album_context_rejects_tracks_outside_configured_library_roots(config, tmp_path: Path):
    outside_track = (tmp_path / "outside" / "Artist" / "Album" / "song.mp3").resolve()
    outside_track.parent.mkdir(parents=True, exist_ok=True)
    outside_track.write_bytes(b"track")

    save_library_root_settings(
        config,
        {
            "main_library_roots": [{
                "id": "main-1",
                "path": str(config["MUSIC_DIR"]),
                "layout_mode": "artist",
            }],
        },
    )

    context = resolve_album_context(config, {"tracks": [{"path": str(outside_track)}]})

    assert context is None
    assert not (outside_track.parent / "cover.jpg").exists()


def test_resolve_album_root_rejects_mixed_valid_and_unsafe_track_paths(config):
    valid_track = (config["MUSIC_DIR"] / "Artist" / "Album" / "one.mp3").resolve()
    outside_track = (config["MUSIC_DIR"].parent / "Outside" / "Artist" / "Album" / "two.mp3").resolve()
    valid_track.parent.mkdir(parents=True, exist_ok=True)
    outside_track.parent.mkdir(parents=True, exist_ok=True)
    valid_track.write_bytes(b"track")
    outside_track.write_bytes(b"track")
    traversal_track = config["MUSIC_DIR"] / ".." / "Outside" / "Artist" / "Album" / "two.mp3"

    save_library_root_settings(
        config,
        {
            "main_library_roots": [{
                "id": "main-1",
                "path": str(config["MUSIC_DIR"]),
                "layout_mode": "artist",
            }],
        },
    )

    assert resolve_album_root_from_track_paths(config, {str(valid_track), str(traversal_track)}) is None
    assert resolve_album_context(
        config,
        {"tracks": [{"path": str(valid_track)}, {"path": str(traversal_track)}]},
    ) is None


def test_resolve_album_root_rejects_cross_root_common_parent(config, tmp_path: Path):
    main_root = (tmp_path / "ConfiguredA").resolve()
    sibling_root = (tmp_path / "ConfiguredB").resolve()
    first_track = (main_root / "Artist" / "Album" / "one.mp3").resolve()
    second_track = (sibling_root / "Artist" / "Album" / "two.mp3").resolve()
    for track_path in (first_track, second_track):
        track_path.parent.mkdir(parents=True, exist_ok=True)
        track_path.write_bytes(b"track")

    save_library_root_settings(
        config,
        {
            "main_library_roots": [
                {
                    "id": "main-1",
                    "path": str(main_root),
                    "layout_mode": "artist",
                },
                {
                    "id": "main-2",
                    "path": str(sibling_root),
                    "layout_mode": "artist",
                },
            ],
        },
    )

    assert resolve_album_root_from_track_paths(config, {str(first_track), str(second_track)}) is None
    assert resolve_album_context(
        config,
        {"tracks": [{"path": str(first_track)}, {"path": str(second_track)}]},
    ) is None


def test_resolve_album_root_fails_closed_when_commonpath_raises_for_multiple_dirs(
    config,
    monkeypatch,
    tmp_path: Path,
):
    main_root = (tmp_path / "ConfiguredA").resolve()
    sibling_root = (tmp_path / "ConfiguredB").resolve()
    first_track = (main_root / "Artist" / "Album" / "one.mp3").resolve()
    second_track = (sibling_root / "Artist" / "Album" / "two.mp3").resolve()
    for track_path in (first_track, second_track):
        track_path.parent.mkdir(parents=True, exist_ok=True)
        track_path.write_bytes(b"track")

    save_library_root_settings(
        config,
        {
            "main_library_roots": [
                {
                    "id": "main-1",
                    "path": str(main_root),
                    "layout_mode": "artist",
                },
                {
                    "id": "main-2",
                    "path": str(sibling_root),
                    "layout_mode": "artist",
                },
            ],
        },
    )

    commonpath_calls: list[list[str]] = []

    def fake_commonpath(paths):
        commonpath_calls.append(list(paths))
        raise ValueError("Paths don't have the same drive")

    monkeypatch.setattr(cover_workflow.os.path, "commonpath", fake_commonpath)

    assert resolve_album_root_from_track_paths(config, {str(first_track), str(second_track)}) is None
    assert len(commonpath_calls) == 1


def test_resolve_album_root_rejects_same_root_mixed_album_folders(config, tmp_path: Path):
    library_root = (tmp_path / "Library").resolve()
    first_track = (library_root / "Artist" / "First Album" / "one.mp3").resolve()
    second_track = (library_root / "Artist" / "Second Album" / "two.mp3").resolve()
    for track_path in (first_track, second_track):
        track_path.parent.mkdir(parents=True, exist_ok=True)
        track_path.write_bytes(b"track")

    save_library_root_settings(
        config,
        {
            "main_library_roots": [{
                "id": "main-1",
                "path": str(library_root),
                "layout_mode": "artist",
            }],
        },
    )

    assert resolve_album_root_from_track_paths(config, {str(first_track), str(second_track)}) is None
    assert resolve_album_context(
        config,
        {"tracks": [{"path": str(first_track)}, {"path": str(second_track)}]},
    ) is None


def test_resolve_album_root_keeps_multitrack_same_album_folder(config, tmp_path: Path):
    library_root = (tmp_path / "Library").resolve()
    album_root = (library_root / "Artist" / "Album").resolve()
    first_track = album_root / "one.mp3"
    second_track = album_root / "two.mp3"
    for track_path in (first_track, second_track):
        track_path.parent.mkdir(parents=True, exist_ok=True)
        track_path.write_bytes(b"track")

    save_library_root_settings(
        config,
        {
            "main_library_roots": [{
                "id": "main-1",
                "path": str(library_root),
                "layout_mode": "artist",
            }],
        },
    )

    assert resolve_album_root_from_track_paths(config, {str(first_track), str(second_track)}) == album_root


def test_resolve_album_root_loads_library_roots_once_for_all_tracks(config, tmp_path: Path):
    library_root = (tmp_path / "Library").resolve()
    album_root = (library_root / "Artist" / "Album").resolve()
    track_paths = {
        album_root / f"{track_number:02d}.mp3"
        for track_number in range(1, 19)
    }
    for track_path in track_paths:
        track_path.parent.mkdir(parents=True, exist_ok=True)
        track_path.write_bytes(b"track")

    save_library_root_settings(
        config,
        {
            "main_library_roots": [{
                "id": "main-1",
                "path": str(library_root),
                "layout_mode": "artist",
            }],
        },
    )
    FakePostgresLibraryRootSettingsStore.load_call_count = 0

    assert resolve_album_root_from_track_paths(
        config,
        {str(track_path) for track_path in track_paths},
    ) == album_root
    assert FakePostgresLibraryRootSettingsStore.load_call_count == 1


def test_resolve_album_root_rejects_single_track_directly_under_library_root(config, tmp_path: Path):
    library_root = (tmp_path / "Library").resolve()
    track_path = (library_root / "loose-track.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")

    save_library_root_settings(
        config,
        {
            "main_library_roots": [{
                "id": "main-1",
                "path": str(library_root),
                "layout_mode": "artist",
            }],
        },
    )

    assert resolve_album_root_from_track_paths(config, {str(track_path)}) is None
    assert resolve_album_context(config, {"tracks": [{"path": str(track_path)}]}) is None


def test_resolve_album_root_accepts_album_at_root_direct_album_folder(config, tmp_path: Path):
    library_root = (tmp_path / "Library").resolve()
    album_root = (library_root / "Album").resolve()
    track_path = (album_root / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")

    save_library_root_settings(
        config,
        {
            "main_library_roots": [{
                "id": "main-1",
                "path": str(library_root),
                "layout_mode": "album-at-root",
            }],
        },
    )

    assert resolve_album_root_from_track_paths(config, {str(track_path)}) == album_root
    assert resolve_album_context(config, {"tracks": [{"path": str(track_path)}]}).album_root == album_root


def test_resolve_album_root_accepts_non_numeric_album_subfolders(config, tmp_path: Path):
    library_root = (tmp_path / "Library").resolve()
    album_root = (library_root / "Artist" / "Album").resolve()
    first_track = (album_root / "Disc One" / "one.mp3").resolve()
    second_track = (album_root / "Bonus Tracks" / "two.mp3").resolve()
    for track_path in (first_track, second_track):
        track_path.parent.mkdir(parents=True, exist_ok=True)
        track_path.write_bytes(b"track")

    save_library_root_settings(
        config,
        {
            "main_library_roots": [{
                "id": "main-1",
                "path": str(library_root),
                "layout_mode": "artist",
            }],
        },
    )

    assert resolve_album_root_from_track_paths(config, {str(first_track), str(second_track)}) == album_root
    assert resolve_album_context(
        config,
        {"tracks": [{"path": str(first_track)}, {"path": str(second_track)}]},
    ).album_root == album_root


def test_validate_local_cover_source_rejects_outside_path(config, tmp_path: Path):
    album_root = (tmp_path / "Artist" / "Album").resolve()
    inside_cover = (album_root / "cover.jpg").resolve()
    outside_cover = (tmp_path / "outside.jpg").resolve()
    inside_cover.parent.mkdir(parents=True, exist_ok=True)
    inside_cover.write_bytes(b"cover")
    outside_cover.write_bytes(b"outside")
    save_library_root_settings(
        config,
        {
            "main_library_roots": [{
                "id": "main-1",
                "path": str(tmp_path),
                "layout_mode": "artist",
            }],
        },
    )

    assert validate_local_cover_source(config, album_root, str(inside_cover)) == inside_cover
    with pytest.raises(ValueError, match="outside the album folder"):
        validate_local_cover_source(config, album_root, str(outside_cover))


def test_validate_local_cover_source_requires_configured_library_root(config, tmp_path: Path):
    configured_root = (tmp_path / "configured").resolve()
    album_root = (tmp_path / "unconfigured" / "Artist" / "Album").resolve()
    source_cover = (album_root / "cover.jpg").resolve()
    source_cover.parent.mkdir(parents=True, exist_ok=True)
    source_cover.write_bytes(b"cover")

    save_library_root_settings(
        config,
        {
            "main_library_roots": [{
                "id": "main-1",
                "path": str(configured_root),
                "layout_mode": "artist",
            }],
        },
    )

    with pytest.raises(ValueError, match="outside the configured library roots"):
        validate_local_cover_source(config, album_root, str(source_cover))


def test_write_remote_cover_bytes_as_authoritative_cover_reserves_existing_cover_and_writes_jpeg(tmp_path: Path):
    album_root = (tmp_path / "Artist" / "Album").resolve()
    current_cover = album_root / "cover.jpg"
    _write_jpeg(current_cover, (220, 60, 60), size=(16, 16))

    written = write_remote_cover_bytes_as_authoritative_cover(
        album_root,
        _image_bytes((30, 160, 220), image_format="PNG", size=(24, 24)),
    )

    assert written == current_cover
    assert image_dimensions(current_cover) == (24, 24)
    assert image_dimensions(album_root / "cover-existing-1.jpg") == (16, 16)


class _LifecycleConvertedImage:
    def __init__(
        self,
        *,
        encoded_bytes: bytes = b"encoded-jpeg-bytes",
        save_error: BaseException | None = None,
        close_error: BaseException | None = None,
    ):
        self.encoded_bytes = encoded_bytes
        self.save_error = save_error
        self.close_error = close_error
        self.close_calls = 0

    def save(self, target, *, format, quality):
        assert format == "JPEG"
        assert quality == 95
        if self.save_error is not None:
            raise self.save_error
        target.write(self.encoded_bytes)

    def close(self):
        self.close_calls += 1
        if self.close_error is not None:
            raise self.close_error


class _LifecycleSourceImage:
    def __init__(
        self,
        converted_image=None,
        *,
        convert_error: BaseException | None = None,
        close_error: BaseException | None = None,
    ):
        self.converted_image = converted_image
        self.convert_error = convert_error
        self.close_error = close_error
        self.close_calls = 0

    def convert(self, mode):
        assert mode == "RGB"
        if self.convert_error is not None:
            raise self.convert_error
        return self.converted_image

    def close(self):
        self.close_calls += 1
        if self.close_error is not None:
            raise self.close_error


def _decode_as(monkeypatch, source_image):
    monkeypatch.setattr(
        cover_workflow,
        "decode_image_bytes",
        lambda raw_bytes: (source_image, 24, 24),
    )


def test_prepare_remote_cover_bytes_closes_source_and_converted_images_after_encoding(monkeypatch):
    converted_image = _LifecycleConvertedImage()
    source_image = _LifecycleSourceImage(converted_image)
    _decode_as(monkeypatch, source_image)

    prepared_bytes = cover_workflow.prepare_remote_cover_bytes_for_authoritative_write(
        b"remote-image-bytes",
    )

    assert prepared_bytes == b"encoded-jpeg-bytes"
    assert source_image.close_calls == 1
    assert converted_image.close_calls == 1


def test_prepare_remote_cover_bytes_closes_source_without_masking_convert_failure(monkeypatch):
    convert_error = RuntimeError("convert failed")
    source_image = _LifecycleSourceImage(convert_error=convert_error)
    _decode_as(monkeypatch, source_image)

    with pytest.raises(RuntimeError) as exc_info:
        cover_workflow.prepare_remote_cover_bytes_for_authoritative_write(
            b"remote-image-bytes",
        )

    assert exc_info.value is convert_error
    assert source_image.close_calls == 1


def test_prepare_remote_cover_bytes_closes_both_images_without_masking_save_failure(monkeypatch):
    save_error = RuntimeError("save failed")
    converted_image = _LifecycleConvertedImage(save_error=save_error)
    source_image = _LifecycleSourceImage(converted_image)
    _decode_as(monkeypatch, source_image)

    with pytest.raises(RuntimeError) as exc_info:
        cover_workflow.prepare_remote_cover_bytes_for_authoritative_write(
            b"remote-image-bytes",
        )

    assert exc_info.value is save_error
    assert converted_image.close_calls == 1
    assert source_image.close_calls == 1


def test_prepare_remote_cover_bytes_cleanup_failures_do_not_mask_save_failure(monkeypatch):
    save_error = RuntimeError("save failed")
    converted_image = _LifecycleConvertedImage(
        save_error=save_error,
        close_error=RuntimeError("converted close failed"),
    )
    source_image = _LifecycleSourceImage(
        converted_image,
        close_error=RuntimeError("source close failed"),
    )
    _decode_as(monkeypatch, source_image)

    with pytest.raises(RuntimeError) as exc_info:
        cover_workflow.prepare_remote_cover_bytes_for_authoritative_write(
            b"remote-image-bytes",
        )

    assert exc_info.value is save_error
    assert converted_image.close_calls == 1
    assert source_image.close_calls == 1


def test_save_pasted_image_as_authoritative_cover_does_not_reserve_existing_cover(tmp_path: Path):
    album_root = (tmp_path / "Artist" / "Album").resolve()
    current_cover = album_root / "cover.jpg"
    _write_jpeg(current_cover, (220, 60, 60), size=(16, 16))
    pasted_bytes = _image_bytes((30, 160, 220), image_format="PNG", size=(24, 24))
    data_url = f"data:image/png;base64,{base64.b64encode(pasted_bytes).decode('ascii')}"

    saved = save_pasted_image_as_authoritative_cover(data_url, album_root)

    assert saved == current_cover
    assert image_dimensions(current_cover) == (24, 24)
    assert list(album_root.glob("cover-existing-*.jpg")) == []


def test_download_remote_cover_to_folder_reports_write_returned_no_file(tmp_path: Path):
    fetch_calls: list[dict[str, object]] = []

    def fake_fetch_remote_image(image_url: str, *, user_agent: str, service: str, context: str):
        fetch_calls.append({
            "image_url": image_url,
            "user_agent": user_agent,
            "service": service,
            "context": context,
        })
        return RemoteImageFetchResult(b"image-bytes", "image/jpeg", "ok", image_url)

    written, detail = download_remote_cover_to_folder(
        tmp_path,
        " https://images.example/cover.jpg ",
        "AlbumHavenTests/1.0",
        fetch_remote_image_func=fake_fetch_remote_image,
        write_cover_func=lambda *_args, **_kwargs: None,
    )

    assert written is None
    assert fetch_calls == [{
        "image_url": "https://images.example/cover.jpg",
        "user_agent": "AlbumHavenTests/1.0",
        "service": "manual-remote",
        "context": f"manual-cover-download:{tmp_path.name}",
    }]
    assert detail == {
        "source": "manual-remote",
        "url": "https://images.example/cover.jpg",
        "folder": str(tmp_path),
        "written_path": None,
        "reason": "write_returned_no_file",
    }


def test_download_remote_cover_to_folder_reports_invalid_image_as_write_returned_no_file(tmp_path: Path):
    album_root = (tmp_path / "Artist" / "Album").resolve()

    def fake_fetch_remote_image(image_url: str, *, user_agent: str, service: str, context: str):
        return RemoteImageFetchResult(b"not-an-image", "image/jpeg", "ok", image_url)

    written, detail = download_remote_cover_to_folder(
        album_root,
        "https://images.example/not-an-image.jpg",
        "AlbumHavenTests/1.0",
        fetch_remote_image_func=fake_fetch_remote_image,
    )

    assert written is None
    assert not (album_root / "cover.jpg").exists()
    assert detail == {
        "source": "manual-remote",
        "url": "https://images.example/not-an-image.jpg",
        "folder": str(album_root),
        "written_path": None,
        "reason": "write_returned_no_file",
    }


def test_delete_local_cover_and_choose_next_promotes_best_remaining_square_cover(tmp_path: Path):
    album_root = (tmp_path / "Artist" / "Album").resolve()
    active_cover = (album_root / "cover.jpg").resolve()
    better_cover = (album_root / "folder.jpg").resolve()
    other_art = (album_root / "booklet.png").resolve()
    _write_jpeg(active_cover, (220, 60, 60), size=(12, 12))
    _write_jpeg(better_cover, (30, 160, 220), size=(40, 40))
    _write_jpeg(other_art, (30, 30, 180), size=(40, 20))

    next_cover = delete_local_cover_and_choose_next(
        album_root=album_root,
        source_path=active_cover,
        active_cover_path=active_cover,
        image_extensions={".jpg", ".png"},
        image_dimensions=image_dimensions,
        is_squareish_cover=lambda width, height: abs(width - height) / max(width, height) <= 0.18
        if width > 0 and height > 0
        else False,
        score_image=score_image,
    )

    assert not active_cover.exists()
    assert next_cover == better_cover


def test_delete_local_cover_and_choose_next_preserves_active_cover_when_non_active_image_is_deleted(tmp_path: Path):
    album_root = (tmp_path / "Artist" / "Album").resolve()
    active_cover = (album_root / "cover.jpg").resolve()
    non_active_cover = (album_root / "alternate.jpg").resolve()
    _write_jpeg(active_cover, (220, 60, 60), size=(12, 12))
    _write_jpeg(non_active_cover, (30, 160, 220), size=(40, 40))

    next_cover = delete_local_cover_and_choose_next(
        album_root=album_root,
        source_path=non_active_cover,
        active_cover_path=active_cover,
        image_extensions={".jpg", ".png"},
        image_dimensions=image_dimensions,
        is_squareish_cover=lambda width, height: abs(width - height) / max(width, height) <= 0.18
        if width > 0 and height > 0
        else False,
        score_image=score_image,
    )

    assert not non_active_cover.exists()
    assert active_cover.exists()
    assert next_cover == active_cover
