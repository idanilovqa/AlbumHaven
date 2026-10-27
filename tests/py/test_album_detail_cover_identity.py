from __future__ import annotations

import asyncio
from types import SimpleNamespace


def test_album_details_replaces_an_orphan_cover_album_id_from_exact_track_paths(
    monkeypatch,
) -> None:
    from music_app.routes import api_read_asgi_routes as read_routes

    resolved_paths: list[set[str]] = []

    class FakeSnapshotRepository:
        def __init__(self, _config):
            pass

        def resolve_album_id_for_track_paths(self, *, track_paths: set[str]) -> int:
            resolved_paths.append(track_paths)
            return 92

    monkeypatch.setattr(
        read_routes,
        "AlbumCoverCandidateSnapshotRepository",
        FakeSnapshotRepository,
    )
    payload = {
        "album_id": 17,
        "tracks": [
            {"path": r"D:\Music\Artist\Album\01.flac"},
            {"path": r"D:\Music\Artist\Album\02.flac"},
        ],
    }

    read_routes._repair_album_detail_cover_identity({}, payload)

    assert payload["album_id"] == 92
    assert resolved_paths == [
        {
            r"D:\Music\Artist\Album\01.flac",
            r"D:\Music\Artist\Album\02.flac",
        }
    ]


def test_album_details_keeps_the_existing_id_when_exact_paths_are_ambiguous(
    monkeypatch,
) -> None:
    from music_app.routes import api_read_asgi_routes as read_routes

    class FakeSnapshotRepository:
        def __init__(self, _config):
            pass

        def resolve_album_id_for_track_paths(self, *, track_paths: set[str]) -> None:
            assert track_paths == {"one.flac", "two.flac"}
            return None

    monkeypatch.setattr(
        read_routes,
        "AlbumCoverCandidateSnapshotRepository",
        FakeSnapshotRepository,
    )
    payload = {
        "album_id": 17,
        "tracks": [{"path": "one.flac"}, {"path": "two.flac"}],
    }

    read_routes._repair_album_detail_cover_identity({}, payload)

    assert payload["album_id"] == 17


def test_cover_lookup_still_rejects_track_paths_resolving_to_multiple_albums(
    monkeypatch,
) -> None:
    from music_app.routes import api_wave_d_asgi_routes as cover_routes

    class FakeSnapshotRepository:
        def __init__(self, _config):
            pass

        def resolve_album_id_for_track_paths(self, *, track_paths: set[str]) -> None:
            assert track_paths == {"one.flac", "two.flac"}
            return None

    monkeypatch.setattr(
        cover_routes,
        "AlbumCoverCandidateSnapshotRepository",
        FakeSnapshotRepository,
    )

    repository, album_id, error = cover_routes._resolved_snapshot_album_context(
        {},
        {"album_id": 17},
        {"one.flac", "two.flac"},
    )

    assert repository is None
    assert album_id is None
    assert error is not None
    assert error[1] == 409
    assert error[0]["ok"] is False
    assert error[0]["error"] == "Album identity does not match the resolved track inventory"


def test_cover_lookup_accepts_the_corrected_unanimous_album_id(monkeypatch) -> None:
    from music_app.routes import api_wave_d_asgi_routes as cover_routes

    class FakeSnapshotRepository:
        def __init__(self, _config):
            pass

        def resolve_album_id_for_track_paths(self, *, track_paths: set[str]) -> int:
            assert track_paths == {"one.flac", "two.flac"}
            return 92

    monkeypatch.setattr(
        cover_routes,
        "AlbumCoverCandidateSnapshotRepository",
        FakeSnapshotRepository,
    )

    repository, album_id, error = cover_routes._resolved_snapshot_album_context(
        {},
        {"album_id": 92},
        {"one.flac", "two.flac"},
    )

    assert isinstance(repository, FakeSnapshotRepository)
    assert album_id == 92
    assert error is None


def test_cover_lookup_refreshes_stale_paths_from_the_persisted_album_identity(
    monkeypatch,
):
    from music_app.routes import api_wave_d_asgi_routes as cover_routes

    class FakeSnapshotRepository:
        def __init__(self, _config):
            pass

        def resolve_album_track_context(self, *, album_id, album_key):
            assert (album_id, album_key) == (92, "artist::album")
            return {
                "album_id": 92,
                "album_key": "artist::album",
                "track_paths": ["current/01.flac", "current/02.flac"],
            }

    def fake_resolve_album_context(_config, album):
        paths = cover_routes._album_track_paths(album)
        if paths == {"current/01.flac", "current/02.flac"}:
            return SimpleNamespace(track_paths=paths, album_root="current")
        return None

    monkeypatch.setattr(
        cover_routes,
        "AlbumCoverCandidateSnapshotRepository",
        FakeSnapshotRepository,
    )
    monkeypatch.setattr(cover_routes, "resolve_album_context", fake_resolve_album_context)
    album, context = asyncio.run(
        cover_routes._resolve_album_payload_context(
            {},
            {
                "album_id": 92,
                "key": "artist::album",
                "tracks": [{"path": "renamed/01.flac"}],
            },
        )
    )

    assert album["album_id"] == 92
    assert album["key"] == "artist::album"
    assert cover_routes._album_track_paths(album) == {
        "current/01.flac",
        "current/02.flac",
    }
    assert context.album_root == "current"


def test_cover_lookup_uses_one_safe_root_for_a_distributed_logical_album(
    monkeypatch,
):
    from music_app.routes import api_wave_d_asgi_routes as cover_routes

    class FakeSnapshotRepository:
        def __init__(self, _config):
            pass

        def resolve_album_track_context(self, *, album_id, album_key):
            assert (album_id, album_key) == (92, "artist::album")
            return {
                "album_id": 92,
                "album_key": "artist::album",
                "track_paths": ["copy-b/01.flac", "copy-a/01.flac"],
            }

    def fake_resolve_album_context(_config, album):
        paths = cover_routes._album_track_paths(album)
        if len(paths) == 1 and next(iter(paths)).startswith("copy-"):
            return SimpleNamespace(album_root=next(iter(paths)).split("/")[0])
        return None

    monkeypatch.setattr(
        cover_routes,
        "AlbumCoverCandidateSnapshotRepository",
        FakeSnapshotRepository,
    )
    monkeypatch.setattr(cover_routes, "resolve_album_context", fake_resolve_album_context)
    monkeypatch.setattr(
        cover_routes,
        "resolve_album_write_root_from_track_paths",
        lambda _config, paths: sorted(paths)[0].split("/")[0],
    )

    album, context = asyncio.run(
        cover_routes._resolve_album_payload_context(
            {},
            {
                "album_id": 92,
                "key": "artist::album",
                "tracks": [{"path": "renamed/01.flac"}],
            },
        )
    )

    assert cover_routes._album_track_paths(album) == {
        "copy-a/01.flac",
        "copy-b/01.flac",
    }
    assert context.album_root == "copy-a"
    assert context.track_paths == {"copy-a/01.flac", "copy-b/01.flac"}


def test_cover_lookup_resolves_stale_identity_through_shared_lineage(monkeypatch):
    from music_app.routes import api_wave_d_asgi_routes as cover_routes

    class FakeLineageRepository:
        def __init__(self, _config):
            pass

        def resolve(self, **identity):
            assert identity == {
                "album_id": 17,
                "album_key": "artist::old",
                "track_paths": {"old/01.flac"},
            }
            return {
                "status": "resolved",
                "album": {
                    "album_id": 92,
                    "album_key": "artist::current",
                    "name": "Current Album",
                    "album_artist": "Artist",
                    "year": 2026,
                },
                "choices": [],
            }

    class FakeSnapshotRepository:
        def __init__(self, _config):
            pass

        def resolve_album_track_context(self, *, album_id, album_key):
            if (album_id, album_key) == (17, "artist::old"):
                return None
            assert (album_id, album_key) == (92, "artist::current")
            return {
                "album_id": 92,
                "album_key": "artist::current",
                "track_paths": ["current/01.flac"],
            }

    monkeypatch.setattr(
        cover_routes,
        "AlbumIdentityLineageRepository",
        FakeLineageRepository,
    )
    monkeypatch.setattr(
        cover_routes,
        "AlbumCoverCandidateSnapshotRepository",
        FakeSnapshotRepository,
    )
    monkeypatch.setattr(
        cover_routes,
        "resolve_album_context",
        lambda _config, album: (
            SimpleNamespace(album_root="current", track_paths={"current/01.flac"})
            if cover_routes._album_track_paths(album) == {"current/01.flac"}
            else None
        ),
    )

    album, context = asyncio.run(
        cover_routes._resolve_album_payload_context(
            {},
            {
                "album_id": 17,
                "key": "artist::old",
                "tracks": [{"path": "old/01.flac"}],
            },
            fallback_track_paths={"old/01.flac"},
        )
    )

    assert album["album_id"] == 92
    assert album["key"] == "artist::current"
    assert context.track_paths == {"current/01.flac"}


def test_cover_lookup_task_identity_uses_legacy_nested_paths_and_merged_subset():
    from music_app.routes import api_wave_d_asgi_routes as cover_routes

    task = {
        "track_paths": [],
        "album_payload": {
            "tracks": [{"path": "disc-1/01.flac"}],
        },
    }

    assert cover_routes._task_matches_album_context(
        task,
        track_paths={"disc-1/01.flac", "disc-2/01.flac"},
        album_id=92,
    )


def test_cover_lookup_task_identity_follows_stable_id_after_tracks_split():
    from music_app.routes import api_wave_d_asgi_routes as cover_routes

    task = {
        "track_paths": ["disc-1/01.flac", "other-album/01.flac"],
        "album_payload": {"album_id": 92},
    }

    assert cover_routes._task_matches_album_context(
        task,
        track_paths={"disc-1/01.flac", "disc-2/01.flac"},
        album_id=92,
    )
    assert not cover_routes._task_matches_album_context(
        task,
        track_paths={"disc-1/01.flac", "disc-2/01.flac"},
        album_id=93,
    )


def test_cover_lookup_task_identity_follows_same_album_key_out_of_generic_residual_paths():
    from music_app.routes import api_wave_d_asgi_routes as cover_routes

    task = {
        "track_paths": ["tagged/01.flac", "untagged-copy/01.flac"],
        "album_payload": {
            "_persisted_album_key": "artist::album",
        },
    }

    assert cover_routes._task_matches_album_context(
        task,
        track_paths={"tagged/01.flac"},
        album_key="artist::album",
    )


def test_cover_lookup_split_rejects_an_album_with_unrelated_paths(monkeypatch):
    from music_app.routes import api_wave_d_asgi_routes as cover_routes

    task_paths = {"tagged/01.flac", "tagged/02.flac", "untagged-copy/01.flac"}

    class BrowseRepository:
        def __init__(self, _config):
            pass

        def build_album_payloads_by_track_paths(self, _track_paths):
            return [
                {
                    "id": 41,
                    "key": "artist::album",
                    "album_artist": "Artist",
                    "name": "Album",
                    "tracks": [
                        {"path": "tagged/01.flac"},
                        {"path": "tagged/02.flac"},
                    ],
                },
                {
                    "id": 99,
                    "key": "unknown artist::",
                    "album_artist": "Unknown Artist",
                    "name": "Unknown Album",
                    "tracks": [
                        {"path": "untagged-copy/01.flac"},
                        {"path": "unrelated/01.flac"},
                    ],
                },
            ]

    monkeypatch.setattr(
        cover_routes,
        "PostgresLibraryBrowseRepository",
        BrowseRepository,
    )

    response = asyncio.run(
        cover_routes._cover_lookup_album_split_response({}, task_paths)
    )

    assert response is None


def test_cover_lookup_task_identity_accepts_renamed_paths_for_same_album_id():
    from music_app.routes import api_wave_d_asgi_routes as cover_routes

    task = {
        "track_paths": ["old/01.flac"],
        "album_payload": {"album_id": 92},
    }

    assert cover_routes._task_matches_album_context(
        task,
        track_paths={"new/01.flac"},
        album_id=92,
    )
