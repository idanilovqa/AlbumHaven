from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image

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


def test_build_cover_refresh_jobs_checks_shared_cover_and_lookup_once(tmp_path: Path, monkeypatch):
    folder = tmp_path / "Artist" / "Album"
    folder.mkdir(parents=True)
    cover = folder / "cover.jpg"
    cover.write_bytes(b"cover")
    tracks = [folder / f"0{index}.mp3" for index in (1, 2)]
    cache = _CoverCacheStub()
    checked: list[Path] = []
    identities = []
    original_key = cover_refresh_planning.cover_query_key
    def counted_key(*identity):
        identities.append(identity)
        return original_key(*identity)
    monkeypatch.setattr(cover_refresh_planning, "cover_query_key", counted_key)
    monkeypatch.setattr(
        cover_refresh_planning,
        "local_cover_requires_upgrade_check",
        lambda path, _cache_entry: checked.append(path) or False,
    )

    jobs = cover_refresh_planning.build_cover_refresh_jobs(
        {str(track): {"album_artist": "Artist", "album": "Album", "cover_path": str(cover)} for track in tracks},
        require_missing_cover=True,
        cover_cache=cache,
    )

    assert jobs == []
    assert len(cache.queries) == 1
    assert checked == [cover]
    assert identities == [("Artist", "Album", None, None)]


def test_build_cover_refresh_jobs_keeps_missing_track_cover_semantics(tmp_path: Path, monkeypatch):
    folder = tmp_path / "Artist" / "Album"
    folder.mkdir(parents=True)
    cover = folder / "cover.jpg"
    cover.write_bytes(b"cover")
    monkeypatch.setattr(cover_refresh_planning, "local_cover_requires_upgrade_check", lambda *_args: False)

    jobs = cover_refresh_planning.build_cover_refresh_jobs(
        {
            str(folder / "01.mp3"): {"album_artist": "Artist", "album": "Album", "cover_path": str(cover)},
            str(folder / "02.mp3"): {"album_artist": "Artist", "album": "Album", "cover_path": None},
        },
        require_missing_cover=True,
    )

    assert len(jobs) == 1
    assert jobs[0]["needs_cover_fetch"] is True


def test_build_cover_refresh_jobs_rechecks_when_album_query_identity_changes(tmp_path: Path, monkeypatch):
    folder = tmp_path / "Artist" / "Album"
    folder.mkdir(parents=True)
    cover = folder / "cover.jpg"
    cover.write_bytes(b"cover")
    cache = _CoverCacheStub()
    checked: list[Path] = []
    identities = []
    original_key = cover_refresh_planning.cover_query_key
    def counted_key(*identity):
        identities.append(identity)
        return original_key(*identity)
    monkeypatch.setattr(cover_refresh_planning, "cover_query_key", counted_key)
    monkeypatch.setattr(
        cover_refresh_planning,
        "local_cover_requires_upgrade_check",
        lambda path, _cache_entry: checked.append(path) or False,
    )

    jobs = cover_refresh_planning.build_cover_refresh_jobs(
        {
            str(folder / "01.mp3"): {"album_artist": "Artist", "album": "Album", "cover_path": str(cover)},
            str(folder / "02.mp3"): {"album_artist": "Artist", "album": "Album", "year": 2001, "cover_path": str(cover)},
        },
        require_missing_cover=True,
        cover_cache=cache,
    )

    assert jobs == []
    assert len(set(cache.queries)) == 2
    assert checked == [cover, cover]
    assert identities == [("Artist", "Album", None, None), ("Artist", "Album", None, 2001)]


@pytest.mark.parametrize("kind,needs_fetch", [("missing", True), ("corrupt", True), ("disappearing", True), ("small", True), ("adequate", False)])
def test_planner_uses_one_owned_existence_probe_per_cover(tmp_path, monkeypatch, kind, needs_fetch):
    cover = tmp_path / "cover.jpg"
    if kind == "corrupt":
        cover.write_bytes(b"not an image")
    elif kind != "missing":
        Image.new("RGB", (1199 if kind == "small" else 1200, 1200)).save(cover)
    probes = []
    original_exists = Path.exists
    def counted_exists(path):
        if path == cover:
            probes.append(path)
            if kind == "disappearing" and len(probes) == 1:
                cover.unlink()
                return True
        return original_exists(path)
    monkeypatch.setattr(Path, "exists", counted_exists)
    jobs = cover_refresh_planning.build_cover_refresh_jobs(
        {str(tmp_path / f"{i}.mp3"): {"album_artist": "Artist", "album": "Album", "cover_path": str(cover)} for i in range(3)},
        require_missing_cover=True,
    )
    assert bool(jobs) is needs_fetch
    assert probes == [cover]


@pytest.mark.parametrize("shared_cover", [True, False])
def test_planner_memoizes_query_independently_of_cover_path(tmp_path, monkeypatch, shared_cover):
    identities, checked = [], []
    original_key = cover_refresh_planning.cover_query_key
    def counted_key(*identity):
        identities.append(identity)
        return original_key(*identity)
    monkeypatch.setattr(cover_refresh_planning, "cover_query_key", counted_key)
    monkeypatch.setattr(cover_refresh_planning, "local_cover_requires_upgrade_check", lambda path, entry: checked.append(path) or False)
    entries = {}
    for index in range(2):
        folder = tmp_path / str(index)
        folder.mkdir()
        cover = tmp_path / ("shared.jpg" if shared_cover else f"{index}.jpg")
        cover.write_bytes(b"cover")
        entries[str(folder / "song.mp3")] = {"album_artist": "Artist", "album": f"Album {index}" if shared_cover else "Album", "cover_path": str(cover)}
    assert cover_refresh_planning.build_cover_refresh_jobs(entries, require_missing_cover=True, cover_cache=_CoverCacheStub()) == []
    assert len(identities) == (2 if shared_cover else 1)
    assert len(checked) == 2
