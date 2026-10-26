from __future__ import annotations


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
