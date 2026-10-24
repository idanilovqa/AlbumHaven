"""Incremental private byte owner, not an ASGI or native admission authority.

No receive callback, Request, file, temporary storage or public upload result is
accepted here. The actual factory's live boundary is deliberately not bound.
Known byte charges below are NOT a total process/heap/native/context proof.
"""
from __future__ import annotations

from dataclasses import dataclass

from .foobar_snapshot_parser import MAX_INPUT_BYTES
from .foobar_source_postgres import SourceUnavailable


@dataclass(frozen=True, slots=True)
class FoobarIntakeByteCharges:
    """Known Python-visible byte holders, not a complete reservation proof."""

    allocation: int
    append: int
    conversion: int
    retained_upload: int

    @property
    def maximum(self) -> int:
        return max(self.allocation, self.append, self.conversion,
                   self.retained_upload)


def intake_byte_charges(length: int) -> FoobarIntakeByteCharges:
    if type(length) is not int or not 1 <= length <= MAX_INPUT_BYTES:
        raise SourceUnavailable()
    # Allocation: the one exact-size accumulation field.
    allocation = length
    # Append at k <= N: field + local buffer + whole memoryview (3N),
    # slice view + controller chunk + argument chunk (3k).
    # These are distinct logical holders even when the underlying bytes alias.
    # CPython managed-buffer/native view holders and genuine ingress owners
    # are unresolved additional charges, NOT silently included in these terms.
    append = length + length + length + length + length + length
    # Conversion: field + local buffer + local bytes + retained bytes field.
    conversion = length + length + length + length
    # Before invocation the one immutable field is the accepted caller's
    # included outer-upload owner. This term is not subtracted from other phases.
    retained_upload = length
    return FoobarIntakeByteCharges(allocation, append, conversion, retained_upload)


class _IntakeBuffer:
    """One slot's original accumulation owner. Never returns the raw upload."""

    __slots__ = ("length", "written", "_buffer", "_payload", "_state")

    def __init__(self, length: int, *, known_byte_budget: int) -> None:
        charge = intake_byte_charges(length)
        if (type(known_byte_budget) is not int
                or known_byte_budget < charge.maximum):
            raise SourceUnavailable()
        self.length = length
        self.written = 0
        self._buffer = None
        self._payload = None
        self._state = "reserved"

    def allocate(self) -> None:
        if self._state != "reserved":
            raise SourceUnavailable()
        self._state = "allocating"
        # The root registers this object before its first body allocation.
        # The known-byte check is not live admission or an upstream receive
        # bound. The canonical live path stays closed pending those owners.
        self._buffer = bytearray(self.length)
        self._state = "reading"

    def append(self, chunk: bytes) -> None:
        if (self._state != "reading" or type(chunk) is not bytes
                or len(chunk) > self.length - self.written):
            raise SourceUnavailable()
        if not chunk:
            return
        buffer = self._buffer
        if type(buffer) is not bytearray:
            raise SourceUnavailable()
        end = self.written + len(chunk)
        whole = None
        part = None
        try:
            whole = memoryview(buffer)
            part = whole[self.written:end]
            # Both are one-dimensional contiguous byte buffers. Assignment
            # cannot resize the original accumulation owner.
            part[:] = chunk
            self.written = end
        finally:
            try:
                if part is not None:
                    part.release()
            finally:
                try:
                    if whole is not None:
                        whole.release()
                finally:
                    part = whole = buffer = None

    def finish(self) -> None:
        if self._state != "reading" or self.written != self.length:
            raise SourceUnavailable()
        buffer = self._buffer
        payload = None
        try:
            if type(buffer) is not bytearray:
                raise SourceUnavailable()
            payload = bytes(buffer)
            self._payload = payload
            self._buffer = None
            self._state = "complete"
        finally:
            payload = buffer = None

    def discard(self) -> None:
        # The caller must first retire its actual receive/generator holders.
        # This clears only this owner and is not a reader-task completion flag.
        self._buffer = None
        self._payload = None
        self._state = "discarded"
