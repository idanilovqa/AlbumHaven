from __future__ import annotations

import io
import struct

import pytest

mutagen_id3 = pytest.importorskip("mutagen.id3")
mutagen_flac = pytest.importorskip("mutagen.flac")

from music_app.services import art_free_tag_reader, metadata

PICTURE_BYTES = b"\xff\xd8" + bytes(2_000_000) + b"\xff\xd9"
# MPEG-1 Layer III, 128 kbit/s, 44.1 kHz: 417-byte frames of silence.
MP3_FRAME = b"\xff\xfb\x90\x64" + bytes(413)


def _write_mp3(path, version):
    path.write_bytes(MP3_FRAME * 400)
    tags = mutagen_id3.ID3()
    tags.add(mutagen_id3.TIT2(encoding=3, text=["Fugata"]))
    tags.add(mutagen_id3.TALB(encoding=3, text=["Astor Piazzolla"]))
    tags.add(mutagen_id3.TPE1(encoding=3, text=["Astor Piazzolla"]))
    tags.add(mutagen_id3.APIC(encoding=3, mime="image/jpeg", type=3, desc="Cover", data=PICTURE_BYTES))
    tags.add(mutagen_id3.TRCK(encoding=3, text=["1/12"]))
    tags.add(mutagen_id3.TPOS(encoding=3, text=["1/3"]))
    tags.add(mutagen_id3.TDRC(encoding=3, text=["2004-05-01"]))
    tags.save(path, v2_version=version)


def _write_flac(path):
    streaminfo = struct.pack(">HH", 4096, 4096) + bytes(6)
    # 44.1 kHz, 2 channels, 16 bits, 441000 samples (10 s).
    packed = (44100 << 44) | (1 << 41) | (15 << 36) | 441000
    streaminfo += packed.to_bytes(8, "big") + bytes(16)
    path.write_bytes(b"fLaC" + bytes((0x80,)) + len(streaminfo).to_bytes(3, "big") + streaminfo + bytes(4096))
    audio = mutagen_flac.FLAC(path)
    audio["title"] = ["Soledad"]
    audio["album"] = ["Astor Piazzolla"]
    audio["artist"] = ["Astor Piazzolla"]
    audio["tracknumber"] = ["2"]
    picture = mutagen_flac.Picture()
    picture.type, picture.mime, picture.data = 3, "image/jpeg", PICTURE_BYTES
    audio.add_picture(picture)
    audio.save()


def _full_read(path, monkeypatch):
    with monkeypatch.context() as patch:
        patch.setattr(art_free_tag_reader, "open_art_free", lambda _path: None)
        return metadata.read_metadata_for_file(path)


class _CountingOpen:
    def __init__(self):
        self.bytes_read = 0

    def __call__(self, path, mode="rb"):
        counter = self

        class Counted(io.BufferedReader):
            def read(self, size=-1):
                data = super().read(size)
                counter.bytes_read += len(data)
                return data

        return Counted(io.FileIO(path, mode))


@pytest.mark.parametrize("kind", ["id3v2.3", "id3v2.4", "flac"])
def test_scan_metadata_skips_embedded_pictures_and_matches_a_full_read(tmp_path, monkeypatch, kind):
    path = tmp_path / ("track.flac" if kind == "flac" else "track.mp3")
    if kind == "flac":
        _write_flac(path)
    else:
        _write_mp3(path, 3 if kind == "id3v2.3" else 4)
    expected = _full_read(path, monkeypatch)

    counting_open = _CountingOpen()
    monkeypatch.setattr(art_free_tag_reader, "open", counting_open, raising=False)
    entry = metadata.read_metadata_for_file(path)

    assert entry == expected
    assert entry["album"] == "Astor Piazzolla"
    assert entry["duration_seconds"] == expected["duration_seconds"] > 0
    assert counting_open.bytes_read < len(PICTURE_BYTES) // 20


def test_unsupported_layouts_fall_back_to_the_real_file(tmp_path):
    path = tmp_path / "track.mp3"
    path.write_bytes(MP3_FRAME * 10)
    assert art_free_tag_reader.open_art_free(path) is None
    truncated = tmp_path / "broken.mp3"
    # A frame claiming more bytes than its tag holds.
    truncated.write_bytes(b"ID3\x04\x00\x00\x00\x00\x00\x10" + b"TIT2\x00\x00\x01\x00\x00\x00" + bytes(6))
    assert art_free_tag_reader.open_art_free(truncated) is None


def test_ape_tail_probe_still_reads_ape_tags(tmp_path):
    item = (5).to_bytes(4, "little") + bytes(4) + b"Title\x00" + b"Hello"
    footer = b"APETAGEX" + (2000).to_bytes(4, "little") + (len(item) + 32).to_bytes(4, "little") + (1).to_bytes(4, "little") + bytes(12)
    path = tmp_path / "track.ape"
    path.write_bytes(bytes(1000) + item + footer)
    assert metadata.read_apev2_tags(path) == {"title": "Hello"}
    plain = tmp_path / "plain.mp3"
    plain.write_bytes(MP3_FRAME * 10)
    assert metadata.read_apev2_tags(plain) == {}
