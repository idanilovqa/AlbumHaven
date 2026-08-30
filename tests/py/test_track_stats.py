from __future__ import annotations

from music_app.services import track_stats
from music_app.services.track_stats import build_scrobbled_play_count_lookup


def test_build_scrobbled_play_count_lookup_counts_scrobbled_plays_only(monkeypatch):
    config = {}
    track_path = r"C:\Music\Artist One\Album One\01 Track.flac"
    monkeypatch.setattr(
        track_stats,
        "load_listen_history",
        lambda config: [
            {"id": "1", "path": track_path, "scrobbled": True},
            {"id": "2", "path": track_path, "scrobbled": True},
            {"id": "3", "path": track_path, "scrobble_eligible": True, "scrobbled": False},
            {"id": "4", "path": track_path, "scrobble_eligible": False, "scrobbled": False},
            {"id": "5", "path": r"C:\Music\Artist Two\Album Two\02 Track.flac", "scrobbled": True},
        ],
    )

    lookup = build_scrobbled_play_count_lookup(config, [track_path])

    assert lookup == {
        track_path: 2,
    }


def test_build_scrobbled_play_count_lookup_prefers_track_ref_identity(monkeypatch):
    config = {}
    track_path = r"C:\Music\Artist One\Album One\01 Track.flac"
    monkeypatch.setattr(
        track_stats,
        "load_listen_history",
        lambda config: [
            {"id": "1", "track_ref": track_path, "scrobbled": True},
            {"id": "2", "track_ref": track_path, "scrobbled": True},
            {"id": "3", "path": track_path, "scrobbled": False},
        ],
    )

    lookup = build_scrobbled_play_count_lookup(config, [track_path])

    assert lookup == {
        track_path: 2,
    }


def test_build_scrobbled_play_count_lookup_uses_postgres_adapter_for_scoped_track_refs(monkeypatch):
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"}
    track_path = r"C:\Music\Artist One\Album One\01 Track.flac"

    class FakeAdapter:
        def __init__(self, received_config):
            assert received_config is config

        def load_scrobbled_play_count_lookup(self, track_refs):
            assert list(track_refs) == [track_path]
            return {track_path: 4}

    monkeypatch.setattr(track_stats, "is_listen_history_postgres_available", lambda received_config: received_config is config)
    monkeypatch.setattr(track_stats, "PostgresListenHistoryAdapter", FakeAdapter)
    monkeypatch.setattr(track_stats, "load_listen_history", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("fallback history load should not run")))

    lookup = build_scrobbled_play_count_lookup(config, [track_path])

    assert lookup == {track_path: 4}
