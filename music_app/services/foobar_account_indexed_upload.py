"""Worker-owned ephemeral TSV and genuine inventory projection cache.

Not durable job state or authority. Actual Prepare transactions still rebuild
current account/source/library authority and inventory before cache reuse.
"""
from types import MappingProxyType
from . import foobar_snapshot_parser as parser
from . import foobar_source_window as window
from . import foobar_import_preparation as intake
from . import foobar_account_prepare_gate as gate
from .foobar_account_authority import account_foobar_context
from .foobar_account_source_postgres import SourceStale, SourceUnavailable

_CREATE = object()


def _scope(context, command):
    gate.validate_prepare_command(command)
    live = account_foobar_context(context)
    return (live.actor.account_id, live.actor.session_id, command.source_ref,
            command.generation, command.upload_sha256, command.mapping_name,
            command.matching_library_id, command.inventory_sha256)


class _AccountIndexedUpload:
    """Private single-worker owner; never accept this object from a wire codec."""
    __slots__ = ('_upload', '_scope', '_projections', '_counts', '_cache_bytes')

    def __init__(self, token, upload, scope):
        if token is not _CREATE or type(upload) is not parser.FoobarIndexedUpload:
            raise SourceUnavailable()
        self._upload, self._scope = upload, scope
        self._projections = self._counts = None
        self._cache_bytes = 0

    def __reduce_ex__(self, protocol):
        raise TypeError('Private upload state cannot be serialized.')

    def __len__(self):
        return self._upload.payload_bytes

    def validate(self, context, command):
        if self._upload.terminal.source_sha256 != command.upload_sha256 or self._scope != _scope(context, command):
            raise SourceStale()

    @property
    def retained_bytes(self):
        return window.indexed_upload_intake_bytes(len(self)) + self._cache_bytes

    def close(self):
        self._upload.close()
        self._projections = self._counts = None
        self._cache_bytes = 0

    def rows(self, offset):
        return self._upload.iter_window(offset=offset, limit=window.MAX_WINDOW_ROWS)

    def proof(self, offset, capacity):
        try:
            total = self._upload.terminal.summary.data_rows
        except parser.FoobarIndexedUploadClosed:
            raise SourceUnavailable() from None
        if type(offset) is not int or not 0 <= offset < total:
            raise intake.FoobarPreparationRejected()
        intake._admit(capacity, self.retained_bytes + window.WINDOW_WORK_BYTES)
        return window.prove_indexed_foobar_source_window(self._upload,
            offset=offset, intake_capacity=capacity)

    def _global_target_counts(self, projections, *, reservation):
        """Called only by the genuine current inventory owner after admission.

        Changed actual projections stop this upload rather than silently changing
        cross-window decisions. Revision strings alone never justify cache reuse.
        """
        if type(projections) is not dict or type(reservation) is not int or reservation < 0:
            raise SourceUnavailable()
        if self._projections is not None:
            if self._projections != projections:
                raise SourceStale()
            return self._upload.terminal, self._counts
        counts = {}
        first = self._upload.terminal
        for offset in range(0, first.summary.data_rows, window.MAX_WINDOW_ROWS):
            stream = self.rows(offset)
            try:
                while True:
                    try:
                        row = next(stream)
                    except StopIteration as done:
                        if done.value != first:
                            raise SourceUnavailable()
                        break
                    raw_path = row.cells[row.fields[0].column_index]
                    projection = projections.get(raw_path) if raw_path else None
                    if projection is not None and projection[0] == 'exact_unique':
                        target = projection[4]
                        counts[target] = counts.get(target, 0) + 1
            finally:
                stream.close()
        # No partial cache is published on failure. Values are immutable tuples;
        # the actual reader produced all projections, never request input.
        self._projections = MappingProxyType(dict(projections))
        self._counts = MappingProxyType(counts)
        self._cache_bytes = reservation
        return first, self._counts


def open_account_indexed_upload(context, *, payload, command, intake_capacity):
    scope = _scope(context, command)
    upload = window.build_foobar_upload_index(payload, mapping_name=command.mapping_name,
                                            intake_capacity=intake_capacity)
    try:
        if upload.terminal.source_sha256 != command.upload_sha256:
            raise gate.PrepareInvalid()
        return _AccountIndexedUpload(_CREATE, upload, scope)
    except BaseException:
        upload.close()
        raise


def retained_bytes(value):
    return value.retained_bytes if type(value) is _AccountIndexedUpload else 0


def iter_source_rows(value, *, offset):
    if type(value) is _AccountIndexedUpload:
        return value.rows(offset)
    return parser.iter_foobar_snapshot_rows(value, mapping_name=gate.MAPPING)


def adopt_account_indexed_upload(context, *, upload, command, intake_capacity):
    """Transfer the worker's genuine already-validated parser owner, no reparse.

    No serialized index or caller validation flag is accepted. The caller must
    relinquish its ownership after success; the wrapper closes the same index.
    """
    if type(upload) is not parser.FoobarIndexedUpload:
        raise gate.PrepareInvalid()
    intake._admit(intake_capacity,window.indexed_upload_intake_bytes(upload.payload_bytes)+8192)
    scope=_scope(context,command)
    if upload.terminal.source_sha256!=command.upload_sha256:
        raise gate.PrepareInvalid()
    return _AccountIndexedUpload(_CREATE,upload,scope)
