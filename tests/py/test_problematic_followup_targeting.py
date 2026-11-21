"""Mutation follow-ups query only the affected Problematic Files owners."""

from types import SimpleNamespace

import pytest


@pytest.mark.parametrize("caller", ["repair", "cover", "move"])
def test_problematic_followup_uses_targeted_persisted_reader(monkeypatch, caller):
    from music_app.routes import api_cover_helpers, api_wave_a_asgi_routes
    from music_app.services import library_browse_postgres, repair_previews

    paths = {"/music/selected/01.flac"}
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://isolated/followup",
              "CACHE_PATH": "unused"}
    expected = {"key": "selected", "tracks": [{"path": next(iter(paths))}]}
    calls = []

    class Repository:
        def __init__(self, supplied_config):
            assert supplied_config is config

        def build_problematic_album_payload_by_track_paths(self, selected_paths):
            calls.append(selected_paths)
            return expected

    def reject_full_projection(*_args, **_kwargs):
        pytest.fail("Mutation follow-up rebuilt the full Problematic Files projection")

    monkeypatch.setattr(library_browse_postgres, "PostgresLibraryBrowseRepository", Repository)
    monkeypatch.setattr(repair_previews, "build_problematic_albums_payload", reject_full_projection)
    # Guard legacy aliases while they exist; replacement code removes these imports.
    for module, name in (
        (api_cover_helpers, "build_problematic_albums_payload"),
        (api_wave_a_asgi_routes, "_build_problematic_albums_payload"),
    ):
        if hasattr(module, name):
            monkeypatch.setattr(module, name, reject_full_projection)

    if caller == "repair":
        actual = repair_previews.find_problematic_album_by_track_paths(
            paths, config=config, library_state={}, logger=object(),
        )
    elif caller == "cover":
        def apply_selection(**kwargs):
            return [], kwargs["find_problematic_album"](kwargs["track_paths"])

        monkeypatch.setattr(api_cover_helpers, "apply_cover_selection_service", apply_selection)
        _, actual = api_cover_helpers.apply_cover_selection_for_tracks(
            paths, config=config, library_state={}, logger=object(),
        )
    else:
        monkeypatch.setattr(api_wave_a_asgi_routes, "_app_config", lambda _request: config)
        monkeypatch.setattr(api_wave_a_asgi_routes, "_library_state", lambda _request: {})
        monkeypatch.setattr(api_wave_a_asgi_routes, "_asgi_logger", lambda _request: object())
        actual = api_wave_a_asgi_routes._asgi_problematic_album_by_track_paths_finder(
            SimpleNamespace()
        )(paths)

    assert actual is expected
    assert calls == [paths]
