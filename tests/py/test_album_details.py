from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest


def _explicit_config(tmp_path: Path) -> dict[str, str]:
    return {
        "DATA_DIR": str((tmp_path / "data").resolve()),
        "MUSIC_DIR": str((tmp_path / "music").resolve()),
    }


def test_build_album_detail_payload_accepts_explicit_config_and_client_surface_class_outside_request_context(
    tmp_path,
    monkeypatch,
):
    from music_app.services import album_details as album_details_module

    config = _explicit_config(tmp_path)
    track_path = str((Path(config["MUSIC_DIR"]) / "Artist One" / "Album One" / "01 Track.flac").resolve())

    library_state = {
        "albums": [
            SimpleNamespace(
                key="album-1",
                name="Album One",
                album_artist="Artist One",
                artists=["Artist One"],
                cover_path=None,
                local_cover_width=None,
                local_cover_height=None,
                remote_cover_url=None,
                remote_cover_thumbnail_url=None,
                remote_cover_source=None,
                remote_cover_source_label=None,
                remote_cover_album_url=None,
                remote_cover_width=None,
                remote_cover_height=None,
                year=2001,
                release_date="2001-01-01",
                edition="",
                album_rating=8,
                total_duration_seconds=245,
                tracks=[
                    SimpleNamespace(
                        path=track_path,
                        title="Track One",
                        track_number=1,
                        disc_number=1,
                        disc_number_raw="1",
                        artist="Artist One",
                        album="Album One",
                        album_artist="Artist One",
                        year=2001,
                        release_date="2001-01-01",
                        edition="",
                        album_rating=8,
                        exception_type=None,
                        cover_path=None,
                        local_cover_width=None,
                        local_cover_height=None,
                        remote_cover_url=None,
                        remote_cover_thumbnail_url=None,
                        remote_cover_source=None,
                        remote_cover_source_label=None,
                        remote_cover_album_url=None,
                        remote_cover_width=None,
                        remote_cover_height=None,
                        duration_seconds=245,
                    )
                ],
                is_compilation=False,
                library_root_id=None,
                library_root_category=None,
                root_provenance=None,
            ),
        ],
        "file_cache": {},
        "scan_in_progress": False,
    }

    def build_scrobbled_play_count_lookup(received_config, track_refs):
        assert received_config is config
        assert list(track_refs) == [track_path]
        return {}

    def build_track_preference_overlay_lookup(received_config, *, client_surface_class=None, track_refs=None):
        assert received_config is config
        assert client_surface_class == "TV"
        assert list(track_refs or []) == [track_path]
        return {}

    monkeypatch.setattr(
        album_details_module,
        "build_scrobbled_play_count_lookup",
        build_scrobbled_play_count_lookup,
    )
    monkeypatch.setattr(
        album_details_module,
        "build_track_preference_overlay_lookup",
        build_track_preference_overlay_lookup,
    )

    payload = album_details_module.build_album_detail_payload(
        "album-1",
        client_surface_class="TV",
        config=config,
        library_state=library_state,
    )

    assert payload is not None
    assert payload["track_rows"][0]["track_preference"]["allowed_actions"]["client_surface_class"] == "tv"
    assert payload["gallery_list_block"]["track_rows"][0]["track_preference"]["allowed_actions"]["client_surface_class"] == "tv"


def test_build_album_detail_payload_without_config_does_not_consult_flask_globals(tmp_path, monkeypatch):
    from music_app.services import album_details as album_details_module

    config = _explicit_config(tmp_path)
    track_path = str((Path(config["MUSIC_DIR"]) / "Artist One" / "Album One" / "01 Track.flac").resolve())
    album = SimpleNamespace(key="album-1")
    album_payload = {
        "key": "album-1",
        "name": "Album One",
        "album_artist": "Artist One",
        "year": 2001,
        "album_rating": 8,
        "total_duration_seconds": 245,
        "tracks": [
            {
                "path": track_path,
                "title": "Track One",
                "track_number": 1,
                "disc_number": 1,
                "disc_number_raw": "1",
                "artist": "Artist One",
                "duration_seconds": 245,
            }
        ],
    }

    def fail_has_app_context():
        raise AssertionError("album details must not inspect Flask globals when config is missing")

    def fail_scrobble_lookup(*_args, **_kwargs):
        raise AssertionError("missing config should skip scrobble lookup")

    def fail_track_preference_lookup(*_args, **_kwargs):
        raise AssertionError("missing config should skip track preference lookup")

    monkeypatch.setattr(album_details_module, "has_app_context", fail_has_app_context, raising=False)
    monkeypatch.setattr(album_details_module, "album_to_dict", lambda *_args, **_kwargs: dict(album_payload))
    monkeypatch.setattr(album_details_module, "build_scrobbled_play_count_lookup", fail_scrobble_lookup)
    monkeypatch.setattr(album_details_module, "build_track_preference_overlay_lookup", fail_track_preference_lookup)

    payload = album_details_module.build_album_detail_payload(
        "album-1",
        library_state={"albums": [album], "file_cache": {}, "scan_in_progress": False},
    )

    assert payload is not None
    assert payload["track_rows"][0]["track_stats"]["scrobble_count"] == 0
    assert payload["track_rows"][0]["track_preference"] == {
        "rating": None,
        "love_tier": "off",
        "allowed_actions": {
            "client_surface_class": "private_web",
            "can_rate": False,
            "can_set_love_tier": False,
        },
    }


def test_build_album_detail_payload_empty_key_returns_none_without_library_state():
    from music_app.services import album_details as album_details_module

    assert not hasattr(album_details_module, "state")
    assert album_details_module.build_album_detail_payload("") is None


def test_build_album_detail_payload_requires_library_state_before_album_lookup():
    from music_app.services import album_details as album_details_module

    assert not hasattr(album_details_module, "state")
    with pytest.raises(ValueError, match="library_state is required"):
        album_details_module.build_album_detail_payload("album-1")


def test_build_album_detail_payload_requires_library_state_before_non_album_lookup():
    from music_app.services import album_details as album_details_module

    assert not hasattr(album_details_module, "state")
    with pytest.raises(ValueError, match="library_state is required"):
        album_details_module.build_album_detail_payload("non-album::mono::type::non-album rarity::")


def test_attach_album_detail_track_rows_uses_prehydrated_track_overlays_without_config():
    from music_app.services import album_details as album_details_module

    payload = album_details_module._attach_album_detail_track_rows(
        {
            "key": "album-1",
            "name": "Album One",
            "album_artist": "Artist One",
            "album_rating": 0,
            "total_duration_seconds": 245,
            "tracks": [
                {
                    "path": r"C:\Music\Artist One\Album One\01 Track.flac",
                    "title": "Track One",
                    "track_number": 1,
                    "disc_number": 1,
                    "disc_number_raw": "1",
                    "artist": "Artist One",
                    "album_artist": "Artist One",
                    "duration_seconds": 245,
                    "track_scrobble_count": 7,
                    "track_preference_overlay": {
                        "rating": 4,
                        "love_tier": "loved",
                    },
                }
            ],
        },
        client_surface_class="tv",
        config=None,
        viewer_opinion_preferences={},
    )

    assert payload["track_rows"][0]["track_stats"]["scrobble_count"] == 7
    assert payload["track_rows"][0]["track_preference"]["rating"] == 4
    assert payload["track_rows"][0]["track_preference"]["love_tier"] == "loved"
    assert payload["track_rows"][0]["track_preference"]["allowed_actions"]["client_surface_class"] == "tv"
    assert payload["track_rows"][0]["can_edit_preferences"] is True
