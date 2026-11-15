"""Open audio files for tag reading without loading embedded pictures.

A library scan needs text tags and stream info only. Embedded cover art (ID3
APIC frames, FLAC PICTURE blocks) is often megabytes per track and dominated
the bytes a scan read from slow USB disks. This module presents mutagen with a
virtual file whose tag region omits those payloads (they are skipped with a
seek, never read) while every byte after the tag maps to the real file, so
stream length, bitrate and duration are computed from the real audio.

Covers that need embedded art read it separately (covers.py) and are unchanged.
Anything this module does not fully understand falls back to the real file.
"""
from __future__ import annotations

import io
from pathlib import Path

_ID3_SKIPPED_FRAMES = {b"APIC", b"GEOB"}
_FLAC_PICTURE_BLOCK = 6
_FLAC_PADDING_BLOCK = 1


class _ArtFreeView(io.RawIOBase):
    """Read-only file: a rebuilt tag prefix followed by the real file's tail."""

    def __init__(self, handle, name: str, prefix: bytes, real_tail_start: int, real_size: int):
        super().__init__()
        self._handle = handle
        self.name = name
        self._prefix = prefix
        self._tail_start = real_tail_start
        self._size = len(prefix) + max(0, real_size - real_tail_start)
        self._position = 0

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self._position

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        base = {io.SEEK_SET: 0, io.SEEK_CUR: self._position, io.SEEK_END: self._size}[whence]
        self._position = max(0, base + offset)
        return self._position

    def readinto(self, buffer) -> int:
        wanted = len(buffer)
        written = 0
        while written < wanted and self._position < self._size:
            if self._position < len(self._prefix):
                chunk = self._prefix[self._position:self._position + wanted - written]
            else:
                self._handle.seek(self._tail_start + self._position - len(self._prefix))
                chunk = self._handle.read(min(wanted - written, self._size - self._position))
                if not chunk:
                    break
            buffer[written:written + len(chunk)] = chunk
            written += len(chunk)
            self._position += len(chunk)
        return written

    def close(self) -> None:
        try:
            self._handle.close()
        finally:
            super().close()


def _syncsafe(value: bytes) -> int:
    return (value[0] << 21) | (value[1] << 14) | (value[2] << 7) | value[3]


def _to_syncsafe(value: int) -> bytes:
    return bytes(((value >> 21) & 0x7F, (value >> 14) & 0x7F, (value >> 7) & 0x7F, value & 0x7F))


def _id3_prefix(handle, header: bytes) -> tuple[bytes, int] | None:
    major, flags = header[3], header[5]
    # v2.2 frames, tag-wide unsynchronisation and extended headers are rare;
    # the real file handles them.
    if major not in (3, 4) or flags & 0xC0:
        return None
    tag_size = _syncsafe(header[6:10])
    tag_end = 10 + tag_size + (10 if flags & 0x10 else 0)
    frames = bytearray()
    position = 10
    while position + 10 <= 10 + tag_size:
        handle.seek(position)
        frame_header = handle.read(10)
        if len(frame_header) < 10 or frame_header[:1] == b"\x00":
            break  # padding
        frame_id = frame_header[:4]
        frame_size = _syncsafe(frame_header[4:8]) if major == 4 else int.from_bytes(frame_header[4:8], "big")
        if frame_size <= 0 or position + 10 + frame_size > 10 + tag_size:
            return None
        if frame_id not in _ID3_SKIPPED_FRAMES:
            data = handle.read(frame_size)
            if len(data) < frame_size:
                return None
            frames += frame_header + data
        position += 10 + frame_size
    # The footer flag is cleared: the rebuilt tag has no footer.
    rebuilt = header[:5] + bytes((flags & ~0x10,)) + _to_syncsafe(len(frames)) + bytes(frames)
    return bytes(rebuilt), tag_end


def _flac_prefix(handle) -> tuple[bytes, int] | None:
    blocks: list[tuple[int, bytes]] = []
    position = 4
    while True:
        handle.seek(position)
        block_header = handle.read(4)
        if len(block_header) < 4:
            return None
        is_last = bool(block_header[0] & 0x80)
        block_type = block_header[0] & 0x7F
        block_size = int.from_bytes(block_header[1:4], "big")
        if block_type not in (_FLAC_PICTURE_BLOCK, _FLAC_PADDING_BLOCK):
            data = handle.read(block_size)
            if len(data) < block_size:
                return None
            blocks.append((block_type, data))
        position += 4 + block_size
        if is_last:
            break
    if not blocks or blocks[0][0] != 0:  # STREAMINFO must come first
        return None
    rebuilt = bytearray(b"fLaC")
    for index, (block_type, data) in enumerate(blocks):
        last_flag = 0x80 if index == len(blocks) - 1 else 0
        rebuilt += bytes((last_flag | block_type,)) + len(data).to_bytes(3, "big") + data
    return bytes(rebuilt), position


def open_art_free(path: Path):
    """An art-free view of an ID3v2 or FLAC file, or None to use the real file."""
    try:
        handle = open(path, "rb")
    except OSError:
        return None
    try:
        real_size = handle.seek(0, io.SEEK_END)
        handle.seek(0)
        header = handle.read(10)
        if header[:3] == b"ID3" and len(header) == 10:
            rebuilt = _id3_prefix(handle, header)
        elif header[:4] == b"fLaC":
            rebuilt = _flac_prefix(handle)
        else:
            rebuilt = None
        if rebuilt is None:
            handle.close()
            return None
        prefix, tail_start = rebuilt
        return io.BufferedReader(_ArtFreeView(handle, str(path), prefix, tail_start, real_size))
    except Exception:
        handle.close()
        return None
