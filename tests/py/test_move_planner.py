from __future__ import annotations

from datetime import date
from pathlib import Path
from types import SimpleNamespace
from copy import deepcopy

import pytest

from music_app.services import library_roots as library_roots_module
from music_app.services.library_roots import normalize_library_root_settings
from music_app.services.library_roots import save_library_root_settings
from music_app.services.move_planner import build_move_availability_payload
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
    }


def test_move_planner_tests_do_not_use_flask_fixture_or_app_context():
    source = Path(__file__).read_text(encoding="utf-8")

    assert "tests.py." + "flask_fixtures" not in source
    assert "app." + "app_context(" not in source


class FakePostgresLibraryRootSettingsStore:
    _settings_by_config_id: dict[int, dict[str, object]] = {}

    def __init__(self, config):
        self.config = config

    @classmethod
    def reset(cls) -> None:
        cls._settings_by_config_id = {}

    def load_settings(self) -> dict[str, object]:
        return deepcopy(self._current_settings())

    def save_settings(self, raw_payload) -> dict[str, object]:
        settings = normalize_library_root_settings(
            raw_payload,
            fallback_main_root=Path(self.config["MUSIC_DIR"]).resolve(strict=False),
        )
        self._settings_by_config_id[id(self.config)] = settings
        return deepcopy(settings)

    def _current_settings(self) -> dict[str, object]:
        config_id = id(self.config)
        if config_id not in self._settings_by_config_id:
            self._settings_by_config_id[config_id] = normalize_library_root_settings(
                {},
                fallback_main_root=Path(self.config["MUSIC_DIR"]).resolve(strict=False),
            )
        return self._settings_by_config_id[config_id]


@pytest.fixture(autouse=True)
def fake_library_root_settings_store(monkeypatch):
    FakePostgresLibraryRootSettingsStore.reset()
    monkeypatch.setattr(
        library_roots_module,
        "PostgresLibraryRootSettingsStore",
        FakePostgresLibraryRootSettingsStore,
    )


def _make_album(
    *,
    root_category: str = "new_arrivals",
    root_id: str = "arrivals-1",
    year: int | None = 2004,
    track_paths: list[str],
) -> SimpleNamespace:
    return SimpleNamespace(
        key="arrival-album",
        name="Tender Buttons",
        album_artist="Broadcast",
        artists=["Broadcast"],
        cover_path=None,
        year=year,
        edition="",
        album_rating=0,
        total_duration_seconds=0,
        tracks=[SimpleNamespace(path=track_path) for track_path in track_paths],
        is_compilation=False,
        library_root_id=root_id,
        library_root_category=root_category,
        root_provenance={
            "root_ids": [root_id],
            "categories": [root_category],
            "category_labels": ["New Arrivals"] if root_category == "new_arrivals" else ["Main Library"],
            "primary_category": root_category,
            "primary_category_label": "New Arrivals" if root_category == "new_arrivals" else "Main Library",
            "badges": ["New"] if root_category == "new_arrivals" else [],
            "is_mixed": False,
        },
    )


def test_move_planner_exposes_new_arrivals_destinations_from_saved_policy(config):
    arrivals_root = (Path(config["DATA_DIR"]) / "arrivals").resolve()
    hoard_root = (Path(config["DATA_DIR"]) / "hoard").resolve()
    main_root = (Path(config["DATA_DIR"]) / "library").resolve()
    track_path = arrivals_root / "Broadcast" / "Tender Buttons" / "01 - I Found the F.mp3"
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")

    save_library_root_settings(
        config,
        {
            "main_library_roots": [{"id": "main-1", "path": str(main_root), "layout_mode": "artist"}],
            "hoarding_library_roots": [{"id": "hoard-1", "path": str(hoard_root)}],
            "new_arrivals_roots": [{"id": "arrivals-1", "path": str(arrivals_root)}],
            "move_policy": {
                "preferred_main_write_root": "main-1",
                "move_new_arrivals_to": "hoard-1",
            },
        },
    )

    payload = build_move_availability_payload(
        _make_album(track_paths=[str(track_path)]),
        config,
    )

    current_year_arrivals = f"{date.today().year} Arrivals"
    assert payload["can_move"] is True
    assert payload["available_actions"] == ["move_to_hoard", "move_to_library"]
    assert payload["blocked_reasons"] == []
    assert payload["actions"]["move_to_hoard"]["destination_path"] == str(
        hoard_root / current_year_arrivals / "2004 - Broadcast - Tender Buttons"
    )
    assert payload["actions"]["move_to_library"]["destination_path"] == str(
        main_root / "Broadcast" / "2004 - Tender Buttons"
    )
    assert payload["actions"]["move_to_library"]["layout_mode"] == "artist"


def test_move_planner_uses_injected_settings_loader_for_move_policy(config):
    arrivals_root = (Path(config["DATA_DIR"]) / "arrivals").resolve()
    hoard_root = (Path(config["DATA_DIR"]) / "hoard").resolve()
    main_root = (Path(config["DATA_DIR"]) / "library").resolve()
    track_path = arrivals_root / "Broadcast" / "Tender Buttons" / "01 - I Found the F.mp3"
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    seen_configs = []

    payload = build_move_availability_payload(
        _make_album(track_paths=[str(track_path)]),
        config,
        load_settings=lambda config: seen_configs.append(config) or {
            "main_library_roots": [{
                "id": "main-1",
                "path": str(main_root),
                "layout_mode": "album-at-root",
            }],
            "hoarding_library_roots": [{
                "id": "hoard-1",
                "path": str(hoard_root),
            }],
            "new_arrivals_roots": [{
                "id": "arrivals-1",
                "path": str(arrivals_root),
            }],
            "move_policy": {
                "preferred_main_write_root": "main-1",
                "move_new_arrivals_to": "hoard-1",
            },
        },
    )

    assert seen_configs == [config]
    assert payload["actions"]["move_to_library"]["target_root_id"] == "main-1"
    assert payload["actions"]["move_to_library"]["layout_mode"] == "album-at-root"


def test_move_planner_reuses_existing_artist_folder_before_preferred_write_root(config):
    arrivals_root = (Path(config["DATA_DIR"]) / "arrivals").resolve()
    existing_main_root = (Path(config["DATA_DIR"]) / "existing-main").resolve()
    preferred_main_root = (Path(config["DATA_DIR"]) / "preferred-main").resolve()
    hoard_root = (Path(config["DATA_DIR"]) / "hoard").resolve()
    existing_artist_folder = existing_main_root / "Broadcast"
    existing_artist_folder.mkdir(parents=True, exist_ok=True)
    track_path = arrivals_root / "Broadcast" / "Tender Buttons" / "01 - I Found the F.mp3"
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")

    save_library_root_settings(
        config,
        {
            "main_library_roots": [
                {"id": "existing-main", "path": str(existing_main_root), "layout_mode": "artist"},
                {"id": "preferred-main", "path": str(preferred_main_root), "layout_mode": "album-at-root"},
            ],
            "hoarding_library_roots": [{"id": "hoard-1", "path": str(hoard_root)}],
            "new_arrivals_roots": [{"id": "arrivals-1", "path": str(arrivals_root)}],
            "move_policy": {
                "preferred_main_write_root": "preferred-main",
                "move_new_arrivals_to": "hoard-1",
            },
        },
    )

    payload = build_move_availability_payload(
        _make_album(track_paths=[str(track_path)]),
        config,
    )

    assert payload["actions"]["move_to_library"]["destination_path"] == str(
        existing_artist_folder / "2004 - Tender Buttons"
    )
    assert payload["actions"]["move_to_library"]["reuses_existing_artist_folder"] is True
    assert payload["actions"]["move_to_library"]["target_root_id"] == "existing-main"


def test_move_planner_blocks_missing_year_metadata(config):
    arrivals_root = (Path(config["DATA_DIR"]) / "arrivals").resolve()
    hoard_root = (Path(config["DATA_DIR"]) / "hoard").resolve()
    main_root = (Path(config["DATA_DIR"]) / "library").resolve()
    track_path = arrivals_root / "Broadcast" / "Tender Buttons" / "01 - I Found the F.mp3"
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")

    save_library_root_settings(
        config,
        {
            "main_library_roots": [{"id": "main-1", "path": str(main_root), "layout_mode": "artist"}],
            "hoarding_library_roots": [{"id": "hoard-1", "path": str(hoard_root)}],
            "new_arrivals_roots": [{"id": "arrivals-1", "path": str(arrivals_root)}],
            "move_policy": {
                "preferred_main_write_root": "main-1",
                "move_new_arrivals_to": "hoard-1",
            },
        },
    )

    payload = build_move_availability_payload(
        _make_album(year=None, track_paths=[str(track_path)]),
        config,
    )

    assert payload["can_move"] is False
    assert "Missing or invalid year metadata blocks move planning." in payload["blocked_reasons"]
    assert payload["actions"]["move_to_hoard"]["available"] is False
    assert payload["actions"]["move_to_library"]["available"] is False


def test_move_planner_blocks_duplicate_source_albums(config):
    arrivals_root = (Path(config["DATA_DIR"]) / "arrivals").resolve()
    hoard_root = (Path(config["DATA_DIR"]) / "hoard").resolve()
    main_root = (Path(config["DATA_DIR"]) / "library").resolve()
    first_track = arrivals_root / "Broadcast" / "Tender Buttons" / "01 - I Found the F.mp3"
    duplicate_track = arrivals_root / "Broadcast" / "Tender Buttons [Duplicate]" / "01 - I Found the F.mp3"
    first_track.parent.mkdir(parents=True, exist_ok=True)
    duplicate_track.parent.mkdir(parents=True, exist_ok=True)
    first_track.write_bytes(b"track")
    duplicate_track.write_bytes(b"track")

    duplicate_album = _make_album(
        track_paths=[str(first_track), str(duplicate_track)],
    )
    duplicate_album.tracks = [
        SimpleNamespace(
            path=str(first_track),
            title="I Found the F",
            track_number=1,
            disc_number=1,
            disc_number_raw="1",
            artist="Broadcast",
            album="Tender Buttons",
            album_artist="Broadcast",
            year=2004,
            edition="",
            album_rating=0,
            exception_type=None,
            cover_path=None,
            duration_seconds=180,
        ),
        SimpleNamespace(
            path=str(duplicate_track),
            title="I Found the F",
            track_number=1,
            disc_number=1,
            disc_number_raw="1",
            artist="Broadcast",
            album="Tender Buttons",
            album_artist="Broadcast",
            year=2004,
            edition="",
            album_rating=0,
            exception_type=None,
            cover_path=None,
            duration_seconds=180,
        ),
    ]

    save_library_root_settings(
        config,
        {
            "main_library_roots": [{"id": "main-1", "path": str(main_root), "layout_mode": "artist"}],
            "hoarding_library_roots": [{"id": "hoard-1", "path": str(hoard_root)}],
            "new_arrivals_roots": [{"id": "arrivals-1", "path": str(arrivals_root)}],
            "move_policy": {
                "preferred_main_write_root": "main-1",
                "move_new_arrivals_to": "hoard-1",
            },
        },
    )

    payload = build_move_availability_payload(duplicate_album, config)

    assert payload["can_move"] is False
    assert payload["available_actions"] == []
    assert "Duplicate-source albums must be narrowed to one source folder before moving." in payload["blocked_reasons"]


def test_move_planner_blocks_new_artist_library_plan_when_preferred_root_requires_genre_match(config):
    arrivals_root = (Path(config["DATA_DIR"]) / "arrivals").resolve()
    hoard_root = (Path(config["DATA_DIR"]) / "hoard").resolve()
    genre_root = (Path(config["DATA_DIR"]) / "genre-library").resolve()
    track_path = arrivals_root / "Broadcast" / "Tender Buttons" / "01 - I Found the F.mp3"
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")

    save_library_root_settings(
        config,
        {
            "main_library_roots": [{"id": "genre-main", "path": str(genre_root), "layout_mode": "genre/artist"}],
            "hoarding_library_roots": [{"id": "hoard-1", "path": str(hoard_root)}],
            "new_arrivals_roots": [{"id": "arrivals-1", "path": str(arrivals_root)}],
            "move_policy": {
                "preferred_main_write_root": "genre-main",
                "move_new_arrivals_to": "hoard-1",
            },
        },
    )

    payload = build_move_availability_payload(
        _make_album(track_paths=[str(track_path)]),
        config,
    )

    assert payload["actions"]["move_to_hoard"]["available"] is True
    assert payload["actions"]["move_to_library"]["available"] is False
    assert payload["actions"]["move_to_library"]["blocked_reasons"] == [
        "The preferred Main Library root requires a broad-genre match before creating a new artist destination.",
    ]
