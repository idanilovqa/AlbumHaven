from __future__ import annotations

from pathlib import Path


def configure_test_app_paths(tmp_path: Path, monkeypatch) -> dict[str, Path]:
    music_dir = (tmp_path / "music").resolve()
    data_dir = (tmp_path / "appdata").resolve()
    for path in (music_dir, data_dir):
        path.mkdir(parents=True, exist_ok=True)
    cover_cache_path = (data_dir / "cover_search_cache.json").resolve()

    monkeypatch.setenv("MUSIC_DIR", str(music_dir))
    monkeypatch.setenv("MUSIC_APP_DATA_DIR", str(data_dir))
    monkeypatch.setenv("MUSIC_COVER_CACHE_PATH", str(cover_cache_path))
    import config

    monkeypatch.setattr(config.Config, "MUSIC_DIR", music_dir)
    monkeypatch.setattr(config.Config, "DATA_DIR", data_dir)
    monkeypatch.setattr(config.Config, "COVER_CACHE_PATH", cover_cache_path)
    monkeypatch.setattr(config.Config, "TESTING", True, raising=False)

    return {
        "music_dir": music_dir,
        "data_dir": data_dir,
        "cover_cache_path": cover_cache_path,
    }


def stub_targeted_reconciliation_repository(monkeypatch) -> None:
    """Keep unrelated lifespan unit tests off persistence while retaining lifecycle code."""
    from types import SimpleNamespace
    from music_app.services import exception_overrides, library_roots, scan_cache_persistence

    def owned_roots(config):
        settings = library_roots.normalize_library_root_settings(
            {}, fallback_main_root=Path(config["MUSIC_DIR"]).resolve(),
        )
        return [
            {**root, "category": category}
            for category, roots in settings.items()
            if isinstance(roots, list)
            for root in roots
            if isinstance(root, dict)
        ]

    monkeypatch.setattr(library_roots, "get_library_roots", owned_roots)
    monkeypatch.setattr(exception_overrides, "load_exception_overrides", lambda _config: {})

    monkeypatch.setattr(
        scan_cache_persistence,
        "select_scan_cache_adapter",
        lambda _config: SimpleNamespace(),
    )
