"""Bounded one-worker finalized-artifact intake, never a live database copier.

The authenticated service owns admission and the only consumer. The ASGI
producer supplies bytes, not paths. A private named file is closed before
SQLite opens it, including on Windows. Settled cleanup is mandatory; abrupt
process termination can leave an orphan and is NOT claimed crash-safe.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
import tempfile
import threading
import time

MAX_UPLOAD_BYTES = 536_870_912
MAX_CHUNK_BYTES = 1_048_576
# Consumer writing A, queued B, and producer-held C under backpressure.
UPLOAD_LOGICAL_BYTES = 3 * MAX_CHUNK_BYTES + 65_536
MAX_UPLOAD_SECONDS = 600.0


class EnhancedUploadRejected(Exception):
    pass


class EnhancedUploadStorageFailed(OSError):
    """Fail-stop the owner after storage/cleanup failure; never replace it."""


@dataclass(frozen=True, slots=True)
class EnhancedUploadArtifact:
    path: Path
    sha256: str
    byte_length: int


class EnhancedUploadChannel:
    """One bounded handoff slot, no request queue and no filesystem authority.

    offer() is nonblocking; False means backpressure, not acceptance. The
    producer must retain that exact chunk until accepted or abandon. finish()
    cannot race ahead of an unaccepted chunk. All failures wake the consumer.
    """
    def __init__(self, length: int, cancelled: threading.Event):
        if type(length) is not int or not 100 <= length <= MAX_UPLOAD_BYTES:
            raise EnhancedUploadRejected()
        if type(cancelled) is not threading.Event:
            raise EnhancedUploadRejected()
        self.length = length
        self.cancelled = cancelled
        self._condition = threading.Condition()
        self._chunk = None
        self._received = 0
        self._finished = False
        self._closed = False
        self._deadline = time.monotonic() + MAX_UPLOAD_SECONDS

    def _check(self):
        if self._closed or self.cancelled.is_set() or time.monotonic() >= self._deadline:
            raise EnhancedUploadRejected()

    def _reject_locked(self):
        self._closed = True
        self._chunk = None
        self._condition.notify_all()
        raise EnhancedUploadRejected()

    def offer(self, chunk: bytes) -> bool:
        with self._condition:
            self._check()
            if self._finished or type(chunk) is not bytes or not 0 < len(chunk) <= MAX_CHUNK_BYTES:
                self._reject_locked()
            if self._chunk is not None:
                return False
            if len(chunk) > self.length - self._received:
                self._reject_locked()
            self._chunk = chunk
            self._received += len(chunk)
            self._condition.notify_all()
            return True

    def finish(self):
        with self._condition:
            self._check()
            if self._finished or self._received != self.length:
                self._reject_locked()
            self._finished = True
            self._condition.notify_all()

    def receive(self) -> bytes | None:
        with self._condition:
            while True:
                self._check()
                if self._chunk is not None:
                    chunk, self._chunk = self._chunk, None
                    self._condition.notify_all()
                    return chunk
                if self._finished:
                    return None
                self._condition.wait(min(0.1, max(0.001, self._deadline-time.monotonic())))

    def close(self):
        with self._condition:
            self._closed = True
            self._chunk = None
            self._condition.notify_all()


@contextmanager
def staged_enhanced_upload(channel: EnhancedUploadChannel):
    """Run ONLY on the existing import worker; close reader before context exit.

    No supplied filename, symlink path, URI, WAL or sidecar is accepted. Normal
    cleanup failure propagates instead of publishing a successful review. No
    cleanup exception is hidden and no orphan is reopened for recovery.
    """
    if type(channel) is not EnhancedUploadChannel:
        raise EnhancedUploadRejected()
    try:
        with tempfile.TemporaryDirectory(prefix='albumhaven-foobar-upload-') as directory:
            path = Path(directory) / 'artifact.sqlite'
            digest = sha256()
            written = 0
            with path.open('xb') as destination:
                while True:
                    chunk = channel.receive()
                    if chunk is None:
                        break
                    if destination.write(chunk) != len(chunk):
                        raise EnhancedUploadRejected()
                    digest.update(chunk)
                    written += len(chunk)
                    del chunk
                destination.flush()
            if written != channel.length:
                raise EnhancedUploadRejected()
            channel._check()
            yield EnhancedUploadArtifact(path, digest.hexdigest(), written)
    except OSError:
        # Includes cleanup failures. Conservatively fault the worker even if
        # an earlier write failed but cleanup succeeded, rather than permit an
        # unbounded sequence of failed raw-artifact allocations.
        raise EnhancedUploadStorageFailed() from None
    finally:
        channel.close()
