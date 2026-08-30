from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
from types import SimpleNamespace

import pytest

from music_app.services import metadata


@pytest.mark.parametrize(
    ("entry", "expected"),
    [
        ({}, False),
        ({"metadata_schema_version": None}, False),
        ({"metadata_schema_version": 0}, False),
        ({"metadata_schema_version": False}, False),
        ({"metadata_schema_version": True}, False),
        ({"metadata_schema_version": "1"}, False),
        ({"metadata_schema_version": 1}, False),
        ({"metadata_schema_version": 2}, False),
        ({"metadata_schema_version": 2, "release_date": None}, True),
        ({"metadata_schema_version": 2, "release_date": "2004-07-16"}, True),
    ],
)
def test_file_metadata_schema_is_current_requires_exact_non_bool_version(
    entry,
    expected,
):
    assert metadata.file_metadata_schema_is_current(entry) is expected


def _generate_tagged_mp3(path: Path, *, album_rating: int) -> None:
    try:
        import imageio_ffmpeg
        from mutagen.id3 import ID3, TALB, TCON, TIT2, TPE1, TPE2, TXXX
    except ImportError as exc:  # pragma: no cover - required project test dependencies
        pytest.skip(f"generated ID3 integration dependencies unavailable: {exc}")

    ffmpeg = shutil.which("ffmpeg") or imageio_ffmpeg.get_ffmpeg_exe()
    result = subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=0.1:sample_rate=44100",
            "-codec:a",
            "libmp3lame",
            "-q:a",
            "9",
            str(path),
        ],
        capture_output=True,
        text=True,
        check=False,
        creationflags=0x08000000 if os.name == "nt" else 0,
    )
    if result.returncode != 0:
        pytest.fail(result.stderr.strip() or "ffmpeg failed to generate parser fixture")

    tags = ID3(path)
    tags.add(TALB(encoding=3, text=["Calling All Dawns"]))
    tags.add(TIT2(encoding=3, text=["Kia Hora Te Marino"]))
    tags.add(TPE1(encoding=3, text=["Christopher Tin"]))
    tags.add(TPE2(encoding=3, text=["Christopher Tin"]))
    tags.add(TCON(encoding=3, text=["Classical Crossover"]))
    tags.add(TXXX(encoding=3, desc="Album Rating", text=[str(album_rating)]))
    tags.save(path)


class _FakeEasyAudio(dict):
    def __init__(self, save_events: list[str]):
        super().__init__()
        self.tags = {}
        self._save_events = save_events

    def add_tags(self):
        self.tags = {}

    def save(self):
        self._save_events.append("easy.save")


class _FakeId3Frame:
    def __init__(self, *, text: list[str]):
        self.text = text


class _FakeId3Tags:
    __module__ = "mutagen.id3"

    def __init__(self):
        self._frames: dict[str, list[object]] = {}

    def getall(self, key: str):
        return list(self._frames.get(key, []))

    def delall(self, key: str):
        self._frames.pop(key, None)

    def add(self, frame):
        self._frames["TXXX:AlbumHavenException"] = [_FakeId3Frame(text=list(getattr(frame, "text", []) or []))]


class _FakeFullAudio:
    def __init__(self, save_events: list[str]):
        self.tags = _FakeId3Tags()
        self._save_events = save_events

    def add_tags(self):
        self.tags = _FakeId3Tags()

    def save(self):
        self._save_events.append("full.save")


def test_read_tags_opens_mutagen_once_and_normalizes_full_mp4_tags(monkeypatch):
    calls = []
    audio = SimpleNamespace(
        tags={
            "\xa9alb": ["Fixture Album"],
            "aART": ["Fixture Album Artist"],
            "\xa9ART": ["Fixture Track Artist"],
            "\xa9nam": ["Fixture Track"],
            "\xa9day": ["2026-07-23"],
            "trkn": [(3, 9)],
            "disk": [(1, 2)],
            "----:com.apple.iTunes:Album Rating": [b"9"],
        },
        info=SimpleNamespace(length=183.9),
    )

    def fake_mutagen_file(path, easy=False):
        calls.append((path, easy))
        return audio

    monkeypatch.setattr(metadata, "MutagenFile", fake_mutagen_file)
    monkeypatch.setattr(metadata, "read_apev2_tags", lambda _path: {})
    track_path = Path("C:/Music/fixture.m4a")

    tags = metadata.read_tags(track_path)

    assert calls == [(track_path, False)]
    assert tags["album"] == ["Fixture Album"]
    assert tags["albumartist"] == ["Fixture Album Artist"]
    assert tags["artist"] == ["Fixture Track Artist"]
    assert tags["title"] == ["Fixture Track"]
    assert tags["date"] == ["2026-07-23"]
    assert tags["tracknumber"] == ["3/9"]
    assert tags["discnumber"] == ["1/2"]
    assert tags["----:com.apple.itunes:album rating"] == [b"9"]
    assert tags["duration_seconds"] == 183


def test_full_tag_aliases_preserve_easy_id3_names_used_by_metadata_extraction():
    frames = {
        "talb": SimpleNamespace(text=["Fixture Album"]),
        "tpe2": SimpleNamespace(text=["Fixture Album Artist"]),
        "tpe1": SimpleNamespace(text=["Fixture Track Artist"]),
        "tit2": SimpleNamespace(text=["Fixture Track"]),
        "tcon": SimpleNamespace(text=["Progressive Rock"]),
        "tdrc": SimpleNamespace(text=["2026-07-23"]),
        "tdor": SimpleNamespace(text=["2025"]),
        "trck": SimpleNamespace(text=["3/9"]),
        "tpos": SimpleNamespace(text=["1/2"]),
        "tit3": SimpleNamespace(text=["Deluxe Edition"]),
        "tsst": SimpleNamespace(text=["Bonus Disc"]),
        "tso2": SimpleNamespace(text=["Album Artist, Fixture"]),
    }

    aliases = metadata._full_tag_aliases(frames)

    assert aliases == {
        "album": frames["talb"],
        "albumartist": frames["tpe2"],
        "artist": frames["tpe1"],
        "title": frames["tit2"],
        "genre": frames["tcon"],
        "date": frames["tdrc"],
        "originaldate": frames["tdor"],
        "tracknumber": frames["trck"],
        "discnumber": frames["tpos"],
        "version": frames["tit3"],
        "discsubtitle": frames["tsst"],
        "albumartistsort": frames["tso2"],
    }


def test_first_tag_treats_an_empty_text_sequence_as_absent():
    tags = {
        "albumartist": SimpleNamespace(text=[""]),
        "artist": SimpleNamespace(text=["Ayreon"]),
    }

    assert metadata.first_tag(tags, ["albumartist", "artist"]) == "Ayreon"


def test_first_tag_preserves_a_real_multi_value_text_sequence():
    tags = {
        "artist": SimpleNamespace(text=["Ayreon", "Arjen Anthony Lucassen"]),
    }

    assert metadata.first_tag(tags, ["artist"]) == "Ayreon"


def test_read_metadata_falls_back_from_empty_album_artist_text_to_track_artist(
    monkeypatch,
    tmp_path: Path,
):
    track_path = tmp_path / "01 - The Day That the World Breaks Down.mp3"
    track_path.touch()
    monkeypatch.setattr(
        metadata,
        "read_tags",
        lambda _path: {
            "album": SimpleNamespace(text=["The Source"]),
            "albumartist": SimpleNamespace(text=[""]),
            "artist": SimpleNamespace(text=["Ayreon"]),
            "title": SimpleNamespace(text=["The Day That the World Breaks Down"]),
        },
    )

    parsed = metadata.read_metadata_for_file(track_path)

    assert parsed["album_artist"] == "Ayreon"
    assert parsed["artist"] == "Ayreon"


def test_read_metadata_preserves_a_missing_album_tag_as_blank(monkeypatch, tmp_path: Path):
    track_path = tmp_path / "Album Folder" / "02 - Albumless.mp3"
    track_path.parent.mkdir()
    track_path.touch()
    monkeypatch.setattr(
        metadata,
        "read_tags",
        lambda _path: {
            "artist": SimpleNamespace(text=["Mono"]),
            "title": SimpleNamespace(text=["Albumless"]),
            "tracknumber": SimpleNamespace(text=["2"]),
        },
    )

    parsed = metadata.read_metadata_for_file(track_path)

    assert parsed["album"] == ""


def test_apply_text_repairs_saves_easy_tags_before_custom_exception_tag(monkeypatch):
    save_events: list[str] = []
    easy_audio = _FakeEasyAudio(save_events)
    full_audio = _FakeFullAudio(save_events)

    def fake_mutagen_file(path, easy=False):
        return easy_audio if easy else full_audio

    monkeypatch.setattr(metadata, "MutagenFile", fake_mutagen_file)
    monkeypatch.setattr(
        metadata,
        "TXXX",
        lambda encoding, desc, text: type("FakeTXXX", (), {"encoding": encoding, "desc": desc, "text": text})(),
    )
    monkeypatch.setattr(metadata, "Encoding", type("FakeEncoding", (), {"UTF8": 3}))

    changed, changed_fields = metadata.apply_text_repairs_to_file(
        Path("C:/Music/test.mp3"),
        {"title": "New Title", "exception_type": "Non-album rarity"},
    )

    assert changed is True
    assert changed_fields == ["title", "exception_type"]
    assert save_events == ["easy.save", "full.save"]


def test_apply_text_repairs_writes_genre_through_the_standard_tag_path(monkeypatch):
    save_events: list[str] = []
    easy_audio = _FakeEasyAudio(save_events)
    monkeypatch.setattr(metadata, "MutagenFile", lambda _path, easy=False: easy_audio)

    changed, changed_fields = metadata.apply_text_repairs_to_file(
        Path("C:/Music/test.mp3"),
        {"genre": "Art Rock"},
    )

    assert changed is True
    assert changed_fields == ["genre"]
    assert easy_audio["genre"] == ["Art Rock"]
    assert save_events == ["easy.save"]


def test_apply_text_repairs_round_trips_every_exposed_physical_field(tmp_path: Path):
    track_path = tmp_path / "all-fields.mp3"
    _generate_tagged_mp3(track_path, album_rating=4)

    repairs = {
        "artist": "Edited Artist",
        "album_artist": "Edited Album Artist",
        "album": "Edited Album",
        "title": "Edited Track",
        "genre": "Progressive Folk",
        "year": "2026",
        "track_number": "7",
        "disc_number": "2",
        "edition": "Anniversary Edition",
        "album_rating": "8",
    }

    changed, changed_fields = metadata.apply_text_repairs_to_file(track_path, repairs)

    assert changed is True
    assert set(changed_fields) == set(repairs)
    parsed = metadata.read_metadata_for_file(track_path)
    assert {
        "artist": parsed["artist"],
        "album_artist": parsed["album_artist"],
        "album": parsed["album"],
        "title": parsed["title"],
        "genre": parsed["genre"],
        "year": str(parsed["year"]),
        "track_number": str(parsed["track_number"]),
        "disc_number": str(parsed["disc_number"]),
        "edition": parsed["edition"],
        "album_rating": str(parsed["album_rating"]),
    } == repairs

    blank_repairs = {
        "album": "",
        "genre": "",
        "edition": "",
        "album_rating": "",
    }
    changed, changed_fields = metadata.apply_text_repairs_to_file(
        track_path,
        blank_repairs,
    )

    assert changed is True
    assert set(changed_fields) == set(blank_repairs)
    parsed = metadata.read_metadata_for_file(track_path)
    assert parsed["album"] == ""
    assert parsed["genre"] is None
    assert parsed["edition"] is None
    assert parsed["album_rating"] is None


def test_apply_text_repairs_raises_when_reopened_value_does_not_match(monkeypatch):
    save_events: list[str] = []
    writable_audio = _FakeEasyAudio(save_events)
    stale_audio = _FakeEasyAudio(save_events)
    stale_audio["title"] = ["Old Title"]
    opened = iter((writable_audio, stale_audio))
    monkeypatch.setattr(metadata, "MutagenFile", lambda _path, easy=False: next(opened))

    with pytest.raises(RuntimeError, match="title"):
        metadata.apply_text_repairs_to_file(
            Path("C:/Music/test.mp3"),
            {"title": "New Title"},
        )


@pytest.mark.parametrize(
    ("raw_rating", "expected"),
    [
        (1, 1),
        (7, 7),
        (10, 10),
        ("7", 7),
        (b"7", 7),
        (["7"], 7),
        (80, 8),
        ("80", 8),
        (204, 8),
        ("8/10", 8),
        ("rating: 8", 8),
    ],
)
def test_extract_album_rating_preserves_supported_normalized_file_tag_formats(
    raw_rating,
    expected,
):
    assert metadata.extract_album_rating({"album_rating": raw_rating}) == expected


@pytest.mark.parametrize(
    "raw_rating",
    [
        None,
        "",
        "undefined",
        "null",
        0,
        "0",
        -7,
        256,
        1000,
        "8 10",
        [],
    ],
)
def test_extract_album_rating_strictly_rejects_invalid_cached_values(raw_rating):
    assert metadata.extract_album_rating({"album_rating": raw_rating}) is None


def test_read_metadata_for_generated_mp3_parses_real_id3_album_rating_txxx(
    tmp_path: Path,
):
    track_path = tmp_path / "01 - Kia Hora Te Marino.mp3"
    _generate_tagged_mp3(track_path, album_rating=9)

    parsed = metadata.read_metadata_for_file(track_path)

    assert parsed["album"] == "Calling All Dawns"
    assert parsed["album_artist"] == "Christopher Tin"
    assert parsed["genre"] == "Classical Crossover"
    assert parsed["album_rating"] == 9
    assert parsed["metadata_schema_version"] == metadata.FILE_METADATA_SCHEMA_VERSION == 2

def test_read_editable_tag_values_returns_exact_blanks_and_requested_fields(monkeypatch):
    audio = {
        "artist": ["Folkstone"],
        "albumartist": ["Folkstone"],
        "title": ["Track"],
        "tracknumber": ["03/12"],
        "albumrating": ["9"],
    }
    monkeypatch.setattr(metadata, "MutagenFile", lambda _path, easy=True: audio)

    values = metadata.read_editable_tag_values(
        Path("X:/SyntheticMusic/Fictional Artist/track.mp3"),
        {"album", "artist", "track_number", "album_rating"},
    )

    assert values == {
        "album": "",
        "artist": "Folkstone",
        "track_number": "03/12",
        "album_rating": "9",
    }
