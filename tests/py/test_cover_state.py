from __future__ import annotations

import hashlib
import io
from pathlib import Path
from types import SimpleNamespace

from music_app.services.cover_state import (
    apply_cover_selection_for_tracks,
    serialize_cover_gallery_payload,
)
from music_app.services import covers as covers_module
from music_app.services.covers import Image, image_dimensions


def _write_jpeg(path: Path, color: tuple[int, int, int], *, size: tuple[int, int] = (12, 12)) -> None:
    assert Image is not None
    path.parent.mkdir(parents=True, exist_ok=True)
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format="JPEG", quality=95)
    path.write_bytes(buffer.getvalue())


def test_serialize_cover_gallery_payload_prefers_saved_remote_cover(tmp_path: Path):
    album_root = (tmp_path / "Artist" / "Album").resolve()
    track_path = (album_root / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    local_cover = (album_root / "cover.jpg").resolve()
    other_art = (album_root / "booklet.png").resolve()
    _write_jpeg(local_cover, (220, 40, 40))
    _write_jpeg(other_art, (40, 40, 220), size=(20, 12))

    remote_url = "https://images.example/cover.jpg"
    payload = serialize_cover_gallery_payload(
        album_root=album_root,
        track_paths={str(track_path)},
        file_cache={
            str(track_path): {
                "cover_path": str(local_cover),
                "remote_cover_url": remote_url,
                "remote_cover_thumbnail_url": "https://images.example/thumb.jpg",
                "remote_cover_source": "discogs",
                "remote_cover_source_label": "Discogs",
                "remote_cover_album_url": "https://discogs.example/release/1",
                "remote_cover_width": 1500,
                "remote_cover_height": 1500,
            }
        },
        image_extensions={".jpg", ".png"},
        image_dimensions=image_dimensions,
        is_squareish_cover=lambda width, height: abs(width - height) / max(width, height) <= 0.18,
        task_payload={"id": "task-1"},
    )

    assert payload["ok"] is True
    assert payload["active_cover_path"] == str(local_cover)
    assert payload["task"] == {"id": "task-1"}
    assert payload["remote_cover"] == {
        "id": f"saved-remote:{hashlib.sha1(remote_url.encode('utf-8', 'ignore')).hexdigest()}",
        "url": remote_url,
        "thumbnail_url": "https://images.example/thumb.jpg",
        "source": "discogs",
        "source_label": "Discogs",
        "album_url": "https://discogs.example/release/1",
        "width": 1500,
        "height": 1500,
        "resolution": "1500x1500",
    }
    assert payload["local_covers"][0]["path"] == str(local_cover)
    assert payload["local_covers"][0]["is_active"] is False
    assert payload["other_art"][0]["path"] == str(other_art)


def test_serialize_cover_gallery_payload_assigns_revision_only_to_active_local_cover(
    tmp_path: Path,
):
    album_root = (tmp_path / "Artist" / "Album").resolve()
    track_path = (album_root / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    active_cover = (album_root / "cover.jpg").resolve()
    inactive_cover = (album_root / "alternate.jpg").resolve()
    _write_jpeg(active_cover, (220, 40, 40))
    _write_jpeg(inactive_cover, (40, 40, 220))

    payload = serialize_cover_gallery_payload(
        album_root=album_root,
        track_paths={str(track_path)},
        file_cache={
            str(track_path): {
                "cover_path": str(active_cover),
                "cover_revision": "authoritative-cover-revision",
            }
        },
        image_extensions={".jpg"},
        image_dimensions=image_dimensions,
        is_squareish_cover=lambda width, height: abs(width - height) / max(width, height) <= 0.18,
    )

    candidates_by_path = {
        candidate["path"]: candidate for candidate in payload["local_covers"]
    }
    assert candidates_by_path[str(active_cover)].get("cover_revision") == (
        "authoritative-cover-revision"
    )
    assert "cover_revision" not in candidates_by_path[str(inactive_cover)]


def test_serialize_cover_gallery_payload_includes_task_independent_candidate_snapshot(
    tmp_path: Path,
):
    album_root = (tmp_path / "Artist" / "Album").resolve()
    track_path = (album_root / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    candidate = {
        "id": "candidate-1",
        "url": "https://images.example/cover.jpg",
        "source": "apple",
        "source_label": "Apple Music",
    }

    payload = serialize_cover_gallery_payload(
        album_root=album_root,
        track_paths={str(track_path)},
        file_cache={str(track_path): {"cover_path": None}},
        image_extensions={".jpg"},
        image_dimensions=image_dimensions,
        is_squareish_cover=lambda _width, _height: True,
        task_payload=None,
        candidate_snapshot={
            "album_id": 41,
            "search_kind": "automatic",
            "status": "running",
            "revision": 7,
            "candidates": [candidate],
            "best_candidate_id": "candidate-1",
            "automatic_improvement_revision": 3,
            "seen_automatic_improvement_revision": 2,
        },
    )

    assert payload["task"] is None
    assert payload["candidate_snapshot"] == {
        "candidates": [candidate],
        "search_kind": "automatic",
        "status": "running",
        "revision": 7,
        "best_candidate_id": "candidate-1",
        "automatic_improvement_revision": 3,
        "seen_automatic_improvement_revision": 2,
        "unseen_automatic_improvement": True,
        "diagnostic": None,
    }


def test_serialize_cover_gallery_payload_fails_closed_for_malformed_candidate_snapshot(
    tmp_path: Path,
):
    album_root = (tmp_path / "Artist" / "Album").resolve()
    track_path = (album_root / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")

    payload = serialize_cover_gallery_payload(
        album_root=album_root,
        track_paths={str(track_path)},
        file_cache={str(track_path): {"cover_path": None}},
        image_extensions={".jpg"},
        image_dimensions=image_dimensions,
        is_squareish_cover=lambda _width, _height: True,
        candidate_snapshot={
            "search_kind": "manual",
            "status": "completed",
            "revision": 4,
            "candidates": {"not": "an array"},
        },
    )

    assert payload["candidate_snapshot"]["candidates"] == []
    assert payload["candidate_snapshot"]["diagnostic"] == (
        "malformed_candidate_snapshot"
    )
    assert payload["candidate_snapshot"]["unseen_automatic_improvement"] is False


def test_apply_cover_selection_for_tracks_updates_cache_and_media_state(tmp_path: Path):
    track_path = (tmp_path / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    next_cover = (track_path.parent / "cover.jpg").resolve()
    _write_jpeg(next_cover, (10, 180, 80))

    track = SimpleNamespace(
        path=str(track_path),
        cover_path=None,
        remote_cover_url=None,
        remote_cover_thumbnail_url=None,
        remote_cover_source=None,
        remote_cover_source_label=None,
        remote_cover_album_url=None,
        remote_cover_width=None,
        remote_cover_height=None,
    )
    album = SimpleNamespace(
        key="album-1",
        name="Test Album",
        album_artist="Test Artist",
        artists=["Test Artist"],
        cover_path=None,
        remote_cover_url=None,
        remote_cover_thumbnail_url=None,
        remote_cover_source=None,
        remote_cover_source_label=None,
        remote_cover_album_url=None,
        remote_cover_width=None,
        remote_cover_height=None,
        year=2001,
        release_date=None,
        edition="",
        album_rating=0,
        total_duration_seconds=0,
        tracks=[track],
        is_compilation=False,
    )
    library_state = {
        "albums": [album],
        "file_cache": {
            str(track_path): {
                "path": str(track_path),
                "title": "Song",
                "track_number": 1,
                "disc_number": 1,
                "disc_number_raw": "1",
                "artist": "Test Artist",
                "album": "Test Album",
                "album_artist": "Test Artist",
                "year": 2001,
                "edition": "",
                "album_rating": 0,
                "duration_seconds": 0,
                "cover_path": None,
                "remote_cover_url": None,
                "remote_cover_thumbnail_url": None,
                "remote_cover_source": None,
                "remote_cover_source_label": None,
                "remote_cover_album_url": None,
                "remote_cover_width": None,
                "remote_cover_height": None,
            }
        },
    }
    scheduled_updates: list[tuple[Path, dict[str, dict[str, object]]]] = []

    updated_albums, updated_problematic = apply_cover_selection_for_tracks(
        library_state=library_state,
        track_paths={str(track_path)},
        schedule_cache_updates_save=lambda cache_path, changed_entries: scheduled_updates.append((cache_path, changed_entries)),
        cache_path=(tmp_path / "cache.json").resolve(),
        find_updated_albums=lambda track_paths: [{"key": "album-1", "track_paths": sorted(track_paths)}],
        find_problematic_album=lambda track_paths: {"key": "problem-1", "track_paths": sorted(track_paths)},
        cover_path=next_cover,
        remote_cover_url="https://images.example/cover.jpg",
        remote_cover_thumbnail_url="https://images.example/thumb.jpg",
        remote_cover_source="apple",
        remote_cover_source_label="Apple Music",
        remote_cover_album_url="https://music.example/album/1",
        remote_cover_width=1200,
        remote_cover_height=1200,
    )

    assert updated_albums == [{"key": "album-1", "track_paths": [str(track_path)]}]
    assert updated_problematic == {"key": "problem-1", "track_paths": [str(track_path)]}
    assert library_state["file_cache"][str(track_path)]["cover_path"] == str(next_cover)
    assert library_state["file_cache"][str(track_path)]["remote_cover_source_label"] == "Apple Music"
    assert album.cover_path == str(next_cover)
    assert album.remote_cover_width == 1200
    assert track.cover_path == str(next_cover)
    assert track.remote_cover_album_url == "https://music.example/album/1"
    assert scheduled_updates == [
        (
            (tmp_path / "cache.json").resolve(),
            {
                str(track_path): library_state["file_cache"][str(track_path)],
            },
        )
    ]


def test_image_dimensions_reuses_cached_result_for_unchanged_file(tmp_path: Path, monkeypatch):
    if Image is None:
        return

    cover_path = (tmp_path / "cover.jpg").resolve()
    _write_jpeg(cover_path, (90, 140, 220), size=(32, 32))

    original_open = covers_module.Image.open
    open_calls = 0

    def counting_open(*args, **kwargs):
        nonlocal open_calls
        open_calls += 1
        return original_open(*args, **kwargs)

    monkeypatch.setattr(covers_module.Image, "open", counting_open)

    assert image_dimensions(cover_path) == (32, 32)
    assert image_dimensions(cover_path) == (32, 32)
    assert open_calls == 1
