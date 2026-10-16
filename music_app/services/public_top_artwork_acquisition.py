"""Dormant local artwork acquisition for an already-authorized preparation.

This module grants no authority and accepts no HTTP request, URL, config or asset
handle. The owner supplies the current album's stored cover, its existing resolver
result and the actual active artwork root admitted by current library policy.
It must compare a fresh descriptor in a new authorized transaction before saving
pixels. The metadata source root is not a substitute for the artwork root.

Only POSIX hosts with descriptor-relative nofollow opens are supported here.
Other hosts fail closed; no mutable-path or FFmpeg-dependent fallback exists.
The preparation owner controls its nonqueued process gate and sequential batch.
"""
from contextlib import ExitStack
from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import stat

from music_app.services.artwork_pixels import (
    ArtworkPixelsUnavailable, sanitize_artwork_pixels,
)


SANITIZER_CONTRACT = 1
MAX_INPUT_BYTES = 16 * 1024 * 1024
MAX_INPUT_PIXELS = 16_000_000
MAX_EDGE = 256
MAX_OUTPUT_BYTES = 320 * 1024
_MAX_ROOT_PATH_BYTES = 8192
_MAX_COVER_PATH_BYTES = 16384
_MAX_PATH_PARTS = 256
_READ_CHUNK_BYTES = 64 * 1024
_MAX_ID = 9223372036854775807


class ArtworkAcquisitionUnavailable(ValueError):
    """A bounded, non-sensitive code; no filesystem path is exposed."""


@dataclass(frozen=True)
class ArtworkSourceDescriptor:
    library_id: int
    local_album_id: int
    artwork_root_id: int
    artwork_root_path: str
    stored_cover_path: str
    resolved_cover_path: str
    relative_parts: tuple[str, ...]
    root_device: int
    root_inode: int


@dataclass(frozen=True)
class ArtworkFileObservation:
    device: int
    inode: int
    size: int
    mtime_ns: int
    ctime_ns: int


@dataclass(frozen=True)
class CapturedArtwork:
    source: ArtworkSourceDescriptor
    file_observation: ArtworkFileObservation
    png: bytes
    content_digest: str
    width: int
    height: int
    input_bytes: int
    input_pixels: int
    sanitizer_contract: int = SANITIZER_CONTRACT
    mime_type: str = "image/png"


def _require_platform():
    if (os.name != "posix"
            or any(not hasattr(os, flag) for flag in
                   ("O_DIRECTORY", "O_NOFOLLOW", "O_NONBLOCK", "O_CLOEXEC"))
            or os.open not in os.supports_dir_fd
            or os.stat not in os.supports_dir_fd
            or os.stat not in os.supports_follow_symlinks):
        raise ArtworkAcquisitionUnavailable("artwork_platform_unavailable")


def _path(value, maximum):
    # No expanduser, resolve, normpath, cwd or URL interpretation is performed.
    # Paths are supplied by the trusted resolver and must already be canonical.
    if not isinstance(value, Path):
        raise ArtworkAcquisitionUnavailable("artwork_source_invalid")
    text = str(value)
    if (not text or "\x00" in text or value.anchor != "/" or ".." in value.parts
            or len(text.encode("utf-8")) > maximum
            or len(value.parts) > _MAX_PATH_PARTS):
        raise ArtworkAcquisitionUnavailable("artwork_source_invalid")
    return value


def _selection(*, library_id, local_album_id, artwork_root_id, artwork_root_path,
               stored_cover_path, resolved_cover_path):
    if any(type(value) is not int or not 0 < value <= _MAX_ID
           for value in (library_id, local_album_id, artwork_root_id)):
        raise ArtworkAcquisitionUnavailable("artwork_source_invalid")
    if (type(stored_cover_path) is not str or not stored_cover_path
            or "\x00" in stored_cover_path or "://" in stored_cover_path
            or len(stored_cover_path.encode("utf-8")) > _MAX_COVER_PATH_BYTES):
        raise ArtworkAcquisitionUnavailable("artwork_source_invalid")
    root = _path(artwork_root_path, _MAX_ROOT_PATH_BYTES)
    cover = _path(resolved_cover_path, _MAX_COVER_PATH_BYTES)
    try:
        relative = cover.relative_to(root).parts
    except ValueError:
        raise ArtworkAcquisitionUnavailable("artwork_source_outside_root") from None
    if not relative or len(root.parts) + len(relative) > _MAX_PATH_PARTS:
        raise ArtworkAcquisitionUnavailable("artwork_source_invalid")
    return root, cover, relative


def _directory_identity(info):
    if not stat.S_ISDIR(info.st_mode):
        raise ArtworkAcquisitionUnavailable("artwork_root_unavailable")
    return info.st_dev, info.st_ino


def _file_observation(info):
    if not stat.S_ISREG(info.st_mode):
        raise ArtworkAcquisitionUnavailable("artwork_not_regular")
    return ArtworkFileObservation(info.st_dev, info.st_ino, info.st_size,
                                  info.st_mtime_ns, info.st_ctime_ns)


class _DirectoryChain:
    """Retain every traversed directory and verify exact parent/name bindings."""
    def __init__(self, stack, root):
        self.stack = stack
        self.links = []
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        self.fd = os.open("/", flags)
        stack.callback(os.close, self.fd)
        _directory_identity(os.fstat(self.fd))
        for part in root.parts[1:]:
            self.descend(part)

    def descend(self, part):
        parent = self.fd
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        child = os.open(part, flags, dir_fd=parent)
        self.stack.callback(os.close, child)
        identity = _directory_identity(os.fstat(child))
        self.links.append((parent, part, child, identity))
        self.fd = child

    def check(self):
        for parent, name, child, expected in self.links:
            current = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if (_directory_identity(current) != expected
                    or _directory_identity(os.fstat(child)) != expected):
                raise ArtworkAcquisitionUnavailable("artwork_source_changed")


def describe_artwork_source(*, library_id, local_album_id, artwork_root_id,
                            artwork_root_path, stored_cover_path, resolved_cover_path):
    """Freeze selection plus actual root identity without reading image bytes.

    Call only after current album, artwork-root and Browse/artwork policy checks.
    The returned value is a private comparison stamp, never authorization.
    This descriptor can be persisted as bounded private preparation state; it
    does not require keeping an OS handle across requests or database phases.
    """
    _require_platform()
    try:
        root, cover, relative = _selection(library_id=library_id,
            local_album_id=local_album_id, artwork_root_id=artwork_root_id,
            artwork_root_path=artwork_root_path, stored_cover_path=stored_cover_path,
            resolved_cover_path=resolved_cover_path)
        with ExitStack() as stack:
            chain = _DirectoryChain(stack, root)
            root_device, root_inode = _directory_identity(os.fstat(chain.fd))
            chain.check()
            return ArtworkSourceDescriptor(library_id, local_album_id, artwork_root_id,
                str(root), stored_cover_path, str(cover), relative, root_device, root_inode)
    except ArtworkAcquisitionUnavailable:
        raise
    except (OSError, UnicodeError, ValueError):
        raise ArtworkAcquisitionUnavailable("artwork_root_unavailable") from None


def _validate_descriptor(source):
    if type(source) is not ArtworkSourceDescriptor:
        raise ArtworkAcquisitionUnavailable("artwork_source_invalid")
    root, cover, relative = _selection(library_id=source.library_id,
        local_album_id=source.local_album_id, artwork_root_id=source.artwork_root_id,
        artwork_root_path=Path(source.artwork_root_path), stored_cover_path=source.stored_cover_path,
        resolved_cover_path=Path(source.resolved_cover_path))
    if (str(root) != source.artwork_root_path or str(cover) != source.resolved_cover_path
            or type(source.relative_parts) is not tuple or relative != source.relative_parts
            or any(type(value) is not int or value < 0
                   for value in (source.root_device, source.root_inode))):
        raise ArtworkAcquisitionUnavailable("artwork_source_invalid")
    return root, relative


def _read_bounded(fd):
    chunks = []
    count = 0
    while count <= MAX_INPUT_BYTES:
        chunk = os.read(fd, min(_READ_CHUNK_BYTES, MAX_INPUT_BYTES + 1 - count))
        if not chunk:
            break
        chunks.append(chunk)
        count += len(chunk)
    if count > MAX_INPUT_BYTES:
        raise ArtworkAcquisitionUnavailable("artwork_input_limit")
    return b"".join(chunks)


def capture_artwork(source):
    """Read only a checked regular descriptor and sanitize outside DB locks.

    Absolute root traversal and every descendant use nofollow dirfd opens.
    Nonblocking file open prevents a FIFO replacement from hanging the worker.
    Regular-file checks precede every read; a changed pathname/root/inode or
    observed in-place mutation rejects the result. Observations are conservative
    mutation guards, not a proof against privileged metadata restoration.
    The final bytes are an immutable capture, not a future disk-file promise.
    """
    _require_platform()
    try:
        root, relative = _validate_descriptor(source)
        with ExitStack() as stack:
            chain = _DirectoryChain(stack, root)
            if _directory_identity(os.fstat(chain.fd)) != (source.root_device, source.root_inode):
                raise ArtworkAcquisitionUnavailable("artwork_source_changed")
            for part in relative[:-1]:
                chain.descend(part)
            parent, name = chain.fd, relative[-1]
            # Precheck avoids ordinary special-file opens. The fstat below is
            # still mandatory: a replacement can race this nofollow lookup.
            expected = _file_observation(os.stat(name, dir_fd=parent, follow_symlinks=False))
            if expected.size <= 0 or expected.size > MAX_INPUT_BYTES:
                raise ArtworkAcquisitionUnavailable("artwork_input_limit")
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
            fd = os.open(name, flags, dir_fd=parent)
            stack.callback(os.close, fd)

            def check():
                chain.check()
                if (_file_observation(os.fstat(fd)) != expected
                        or _file_observation(os.stat(name, dir_fd=parent,
                                                    follow_symlinks=False)) != expected):
                    raise ArtworkAcquisitionUnavailable("artwork_source_changed")

            check()
            payload = _read_bounded(fd)
            check()
            if len(payload) != expected.size:
                raise ArtworkAcquisitionUnavailable("artwork_source_changed")
            image = sanitize_artwork_pixels(payload, max_input_bytes=MAX_INPUT_BYTES,
                max_pixels=MAX_INPUT_PIXELS, max_edge=MAX_EDGE, max_output_bytes=MAX_OUTPUT_BYTES)
            check()
            return CapturedArtwork(source, expected, image.png,
                hashlib.sha256(image.png).hexdigest(), image.width, image.height,
                image.input_bytes, image.input_pixels)
    except ArtworkAcquisitionUnavailable:
        raise
    except ArtworkPixelsUnavailable as error:
        raise ArtworkAcquisitionUnavailable(str(error)) from None
    except (OSError, UnicodeError, ValueError, TypeError):
        raise ArtworkAcquisitionUnavailable("artwork_source_unavailable") from None
