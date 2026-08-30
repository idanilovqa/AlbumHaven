from __future__ import annotations

from pathlib import Path

from music_app.services import cover_refresh_planning


class _LoggerStub:
    def __init__(self) -> None:
        self.verbose_calls: list[tuple[str, tuple[object, ...]]] = []

    def verbose(self, message: str, *args: object) -> None:
        self.verbose_calls.append((message, args))


class _CoverCacheStub:
    def __init__(self, entries: dict[str, object] | None = None) -> None:
        self.entries = entries or {}
        self.queries: list[str] = []

    def get(self, key: str):
        self.queries.append(key)
        return self.entries.get(key)


def test_build_cover_refresh_jobs_groups_folder_tracks_and_logs_summary(tmp_path: Path):
    logger = _LoggerStub()
    album_folder = tmp_path / "Artist" / "Album"
    album_folder.mkdir(parents=True)
    first_track = (album_folder / "01 Song.mp3").resolve()
    second_track = (album_folder / "02 Song.mp3").resolve()
    first_track.write_bytes(b"a")
    second_track.write_bytes(b"b")

    jobs = cover_refresh_planning.build_cover_refresh_jobs(
        {
            str(first_track): {
                "album_artist": "Artist",
                "album": "Album",
                "edition": "Deluxe",
                "year": 2001,
                "cover_path": None,
            },
            str(second_track): {
                "artist": "Artist",
                "album": "Album",
                "cover_path": None,
            },
        },
        logger=logger,
    )

    assert len(jobs) == 1
    assert jobs[0]["folder"] == album_folder
    assert jobs[0]["track_paths"] == [str(first_track), str(second_track)]
    assert jobs[0]["artist"] == "Artist"
    assert jobs[0]["album"] == "Album"
    assert jobs[0]["edition"] == "Deluxe"
    assert jobs[0]["year"] == 2001
    assert jobs[0]["needs_cover_fetch"] is True
    assert logger.verbose_calls[0][0].startswith("Cover jobs built")
    assert logger.verbose_calls[0][1][:3] == (1, 1, 0)


def test_build_cover_refresh_jobs_copies_normalized_cover_selection_origin_to_every_job(
    tmp_path: Path,
):
    entries = {}
    expected_origins = {
        "User Album": "user",
        "Automatic Album": "automatic",
        "Unowned Album": None,
    }
    for index, (album, raw_origin) in enumerate(
        [
            ("User Album", " USER "),
            ("Automatic Album", "Automatic"),
            ("Unowned Album", "legacy"),
        ],
        start=1,
    ):
        track_path = (tmp_path / f"Artist {index}" / album / "song.mp3").resolve()
        track_path.parent.mkdir(parents=True)
        track_path.write_bytes(b"track")
        entries[str(track_path)] = {
            "album_artist": f"Artist {index}",
            "album": album,
            "cover_path": None,
            "cover_selection_origin": raw_origin,
        }

    jobs = cover_refresh_planning.build_cover_refresh_jobs(entries)

    assert len(jobs) == 3
    assert {
        str(job["album"]): job["cover_selection_origin"]
        for job in jobs
    } == expected_origins


def test_build_cover_refresh_jobs_skips_existing_cover_when_missing_only_requested(tmp_path: Path, monkeypatch):
    logger = _LoggerStub()
    album_folder = tmp_path / "Artist" / "Album"
    album_folder.mkdir(parents=True)
    track_path = (album_folder / "song.mp3").resolve()
    cover_path = (album_folder / "cover.jpg").resolve()
    track_path.write_bytes(b"track")
    cover_path.write_bytes(b"cover")

    # A current authoritative local cover should not be re-queued for the
    # missing-cover-only path when the upgrade check says no refresh is needed.
    monkeypatch.setattr(
        cover_refresh_planning,
        "local_cover_requires_upgrade_check",
        lambda *_args, **_kwargs: False,
    )

    jobs = cover_refresh_planning.build_cover_refresh_jobs(
        {
            str(track_path): {
                "album_artist": "Artist",
                "album": "Album",
                "cover_path": str(cover_path),
            }
        },
        require_missing_cover=True,
        logger=logger,
    )

    assert jobs == []
    assert logger.verbose_calls[0][1][:3] == (1, 0, 1)
    assert logger.verbose_calls[0][1][3] == [
        {
            "folder": str(album_folder),
            "artist": "Artist",
            "album": "Album",
            "track_count": 1,
            "reason": "cover_already_present",
        }
    ]


def test_build_cover_refresh_jobs_marks_upgrade_candidates_for_refetch(tmp_path: Path, monkeypatch):
    album_folder = tmp_path / "Artist" / "Album"
    album_folder.mkdir(parents=True)
    track_path = (album_folder / "song.mp3").resolve()
    cover_path = (album_folder / "cover.jpg").resolve()
    track_path.write_bytes(b"track")
    cover_path.write_bytes(b"cover")
    cache_stub = _CoverCacheStub({"cache-key": {"provider": "test"}})

    monkeypatch.setattr(cover_refresh_planning, "cover_query_key", lambda *args: "cache-key")
    monkeypatch.setattr(
        cover_refresh_planning,
        "local_cover_requires_upgrade_check",
        lambda resolved_cover_path, cache_entry: resolved_cover_path == cover_path and cache_entry == {"provider": "test"},
    )

    jobs = cover_refresh_planning.build_cover_refresh_jobs(
        {
            str(track_path): {
                "album_artist": "Artist",
                "album": "Album",
                "cover_path": str(cover_path),
            }
        },
        require_missing_cover=True,
        cover_cache=cache_stub,
    )

    assert cache_stub.queries == ["cache-key"]
    assert len(jobs) == 1
    assert jobs[0]["needs_cover_fetch"] is True
