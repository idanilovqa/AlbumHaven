from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest


def test_file_does_not_use_flask_fixture_or_app_context():
    text = Path(__file__).read_text(encoding="utf-8")

    assert "tests.py." + "flask_fixtures" not in text
    assert "app." + "app_context(" not in text


@pytest.mark.parametrize(
    "dependencies",
    [
        pytest.param({}, id="missing-all"),
        pytest.param(
            {
                "logger": SimpleNamespace(info=lambda *args, **kwargs: None),
                "library_state": {"file_cache": {}},
            },
            id="missing-config",
        ),
        pytest.param(
            {
                "config": {},
                "library_state": {"file_cache": {}},
            },
            id="missing-logger",
        ),
        pytest.param(
            {
                "config": {},
                "logger": SimpleNamespace(info=lambda *args, **kwargs: None),
            },
            id="missing-library-state",
        ),
    ],
)
def test_apply_cover_selection_requires_explicit_dependencies(dependencies):
    from music_app.routes.api_cover_helpers import apply_cover_selection_for_tracks

    with pytest.raises(ValueError, match="config, logger, and library_state"):
        apply_cover_selection_for_tracks(set(), **dependencies)


def test_apply_cover_path_wrapper_forwards_linked_remote_cover_fields(monkeypatch):
    from music_app.routes import api_cover_helpers

    captured = {}

    def capture(track_paths, **kwargs):
        captured.update(track_paths=track_paths, **kwargs)
        return [], None

    monkeypatch.setattr(api_cover_helpers, "apply_cover_selection_for_tracks", capture)
    logger = object()
    library_state = {"file_cache": {}}

    result = api_cover_helpers.apply_cover_path_for_tracks(
        {r"D:\\Music\\Album\\01.flac"},
        None,
        remote_cover_url="https://i.scdn.co/image/fixture",
        remote_cover_thumbnail_url="https://i.scdn.co/image/fixture-small",
        remote_cover_source="spotify",
        remote_cover_source_label="Spotify",
        remote_cover_album_url="https://open.spotify.com/album/fixture",
        remote_cover_width=1400,
        remote_cover_height=1400,
        config={"CACHE_PATH": "unused"},
        logger=logger,
        library_state=library_state,
    )

    assert result == ([], None)
    assert captured == {
        "track_paths": {r"D:\\Music\\Album\\01.flac"},
        "cover_path": None,
        "remote_cover_url": "https://i.scdn.co/image/fixture",
        "remote_cover_thumbnail_url": "https://i.scdn.co/image/fixture-small",
        "remote_cover_source": "spotify",
        "remote_cover_source_label": "Spotify",
        "remote_cover_album_url": "https://open.spotify.com/album/fixture",
        "remote_cover_width": 1400,
        "remote_cover_height": 1400,
        "config": {"CACHE_PATH": "unused"},
        "logger": logger,
        "library_state": library_state,
        "cover_revision": None,
        "schedule_cache_update": True,
    }
