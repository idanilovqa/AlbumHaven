"""Private counted Windows lexical observations, without capture or authority.

The fixed common resolver owns the sole process-wide two-job budget. Importing
this module loads no DLL, configuration, application, database or decoder.
"""
import re
import sys

from music_app.services import _top_artwork_resolution as common
from music_app.services.rooted_local_file import (
    RootSelection, RootObservationSelection, observe_root, observe_selection,
)
from music_app.services._rooted_local_file_windows import (
    WindowsIdentity, WindowsRootStamp, SelectorSnapshot, WindowsSelectionObservation,
    WindowsUnavailable, validate_component, utf16_units, _VOLUME_GUID, _VOLUME_TARGET,
)

CONTRACT = 'artwork-win32-lexical-selection-v1'
_DRIVE = re.compile(r'[A-Za-z]:\Z', re.ASCII)
_MAX_PAYLOAD = common._MAX_PAYLOAD


def _invalid():
    common._invalid()


def _text(value, maximum):
    if type(value) is not str or not value or len(value) > maximum:
        _invalid()
    try:
        size = len(value.encode('utf-8', 'strict'))
    except UnicodeError:
        _invalid()
    if size > maximum or '\0' in value:
        _invalid()
    return size


def _path(value, *, root=False, absolute=False):
    """Return exact (drive-or-None, components, UTF-8 size), never normalize."""
    size = _text(value, 8192 if root else 16384)
    drive = value[:2] if len(value) >= 3 and value[2] == '\\' else None
    if drive is not None:
        if _DRIVE.fullmatch(drive) is None:
            _invalid()
        rest = value[3:]
        parts = tuple(rest.split('\\')) if rest else ()
    else:
        if root or absolute:
            _invalid()
        parts = tuple(value.split('\\'))
    if len(parts) > 256 or (drive is None and not parts):
        _invalid()
    try:
        for part in parts:
            validate_component(part, 255)
    except WindowsUnavailable:
        _invalid()
    return drive, parts, size


def _copy_stamp(stamp):
    common._record(stamp, WindowsRootStamp, {'platform', 'identity', 'selector'})
    identity, selector = stamp.identity, stamp.selector
    common._record(identity, WindowsIdentity, {'platform', 'volume_serial', 'file_id'})
    common._record(selector, SelectorSnapshot, {'drive', 'volume_guid', 'drive_target', 'guid_target'})
    return WindowsRootStamp(stamp.platform,
        WindowsIdentity(identity.platform, identity.volume_serial, identity.file_id),
        SelectorSnapshot(selector.drive, selector.volume_guid,
                         selector.drive_target, selector.guid_target))


def _validate_stamp(stamp, root_path):
    identity, selector = stamp.identity, stamp.selector
    if (type(stamp.platform) is not str or stamp.platform != 'win32'
            or type(identity.platform) is not str or identity.platform != 'win32'
            or type(identity.volume_serial) is not int
            or not 0 <= identity.volume_serial < 2 ** 64
            or type(identity.file_id) is not bytes or len(identity.file_id) != 16):
        _invalid()
    for value in (selector.drive, selector.volume_guid, selector.drive_target, selector.guid_target):
        _text(value, 131064)
        try:
            utf16_units(value)
        except WindowsUnavailable:
            _invalid()
    if (selector.drive != root_path[:2] or _DRIVE.fullmatch(selector.drive) is None
            or _VOLUME_GUID.fullmatch(selector.volume_guid) is None
            or _VOLUME_TARGET.fullmatch(selector.drive_target) is None
            or selector.drive_target != selector.guid_target):
        _invalid()
    return stamp


def _copy_input(value):
    common._record(value, common.ResolutionInput, {'operation_ref', 'snapshot_digest',
        'platform', 'resolver_contract', 'roots', 'rows', 'ceilings_version'})
    roots, rows = value.roots, value.rows
    if type(roots) is not tuple or len(roots) > 1024 or type(rows) is not tuple or len(rows) > 5000:
        _invalid()
    copied_roots, copied_rows = [], []
    for root in roots:
        common._record(root, common.RootInput, {'root_id', 'root_path'})
        copied_roots.append(common.RootInput(root.root_id, root.root_path))
    for row in rows:
        common._record(row, common.RowInput,
                       {'row_ref', 'local_album_id', 'stored_cover_path', 'expected'})
        expected = row.expected
        if expected is not None:
            common._record(expected, common.ExpectedSelection, {'root_id', 'root_path',
                'resolved_cover_path', 'relative_parts', 'root_stamp'})
            expected = common.ExpectedSelection(expected.root_id, expected.root_path,
                expected.resolved_cover_path, expected.relative_parts,
                _copy_stamp(expected.root_stamp))
        copied_rows.append(common.RowInput(row.row_ref, row.local_album_id,
                                          row.stored_cover_path, expected))
    return common.ResolutionInput(value.operation_ref, value.snapshot_digest,
        value.platform, value.resolver_contract, tuple(copied_roots),
        tuple(copied_rows), value.ceilings_version)


def _stamp_size(stamp):
    # Both platform tags, complete uint64/128-bit identity and exact selector.
    return (common._text_size(stamp.platform) + common._text_size(stamp.identity.platform)
        + 8 + 16 + sum(common._text_size(value) for value in
            (stamp.selector.drive, stamp.selector.volume_guid,
             stamp.selector.drive_target, stamp.selector.guid_target)))


def _validate(value):
    try:
        value = _copy_input(value)
    except AttributeError:
        _invalid()
    if (not common._uuid(value.operation_ref)
            or type(value.snapshot_digest) is not str or len(value.snapshot_digest) != 64
            or common._DIGEST.fullmatch(value.snapshot_digest) is None
            or type(value.platform) is not str or value.platform != 'win32'
            or type(value.resolver_contract) is not str or value.resolver_contract != CONTRACT
            or type(value.ceilings_version) is not int or value.ceilings_version != 1):
        _invalid()
    payload, last, refs = 512, 0, set()
    for root in value.roots:
        if not common._identifier(root.root_id) or root.root_id <= last:
            _invalid()
        last = root.root_id
        _, _, size = _path(root.root_path, root=True)
        payload += size + 128
        if payload > _MAX_PAYLOAD:
            _invalid()
    for row in value.rows:
        if (not common._uuid(row.row_ref) or row.row_ref in refs
                or not common._identifier(row.local_album_id)):
            _invalid()
        refs.add(row.row_ref)
        _, _, size = _path(row.stored_cover_path)
        payload += size + 256
        expected = row.expected
        if expected is not None:
            if (not common._identifier(expected.root_id)
                    or type(expected.relative_parts) is not tuple
                    or not 1 <= len(expected.relative_parts) <= 256):
                _invalid()
            root_drive, root_parts, root_size = _path(expected.root_path, root=True)
            cover_drive, cover_parts, cover_size = _path(expected.resolved_cover_path, absolute=True)
            relative_size = relative_bytes = 0
            for part in expected.relative_parts:
                part_bytes = _text(part, 16384)
                relative_bytes += part_bytes
                relative_size += 4 + part_bytes
                if relative_bytes > 16384:
                    _invalid()
                try:
                    validate_component(part, 255)
                except WindowsUnavailable:
                    _invalid()
            joined = expected.root_path + ('' if expected.root_path.endswith('\\') else '\\')
            joined += '\\'.join(expected.relative_parts)
            if (relative_bytes > 16384 or len(root_parts) + len(expected.relative_parts) > 256
                    or root_drive != cover_drive
                    or cover_parts != (*root_parts, *expected.relative_parts)
                    or expected.resolved_cover_path != joined):
                _invalid()
            _validate_stamp(expected.root_stamp, expected.root_path)
            payload += root_size + cover_size + relative_size + 256 + _stamp_size(expected.root_stamp)
        if payload > _MAX_PAYLOAD:
            _invalid()
    return value


class _Context(common._Context):
    """Counted native calls plus bounded strong pre-resource cleanup owners."""
    def __init__(self, deadline, abandoned, clock=None, *, job=None):
        super().__init__(deadline, abandoned, clock)
        self._job = job
        self._cleanup_owners = set()
        self.cleanup_incomplete = False

    def check_syscall_admission(self):
        """Non-charging outer bridge check; the actual foreign call charges."""
        self.check()
        with self._counts_lock:
            if self.components + self.syscalls + self.expansions >= 262144:
                raise common._Stop('artwork_validation_limit')

    def register_cleanup_owner(self, owner):
        self.check()
        with self._counts_lock:
            if self.cleanup_incomplete or len(self._cleanup_owners) >= 8:
                raise common._Stop('artwork_probe_unavailable')
            self._cleanup_owners.add(owner)

    def forget_cleanup_owner(self, owner):
        with self._counts_lock:
            self._cleanup_owners.discard(owner)

    def owner_cleanup_failed(self, owner, error=None):
        # Already registered before admission: this path needs no new owner/set.
        with self._counts_lock:
            self.cleanup_incomplete = True
        if self._job is not None:
            self._job.report_cleanup_failure(error)

    def record_cleanup_attempt(self):
        with self._counts_lock:
            self.cleanup_attempts += 1

    def record_cleanup_failure(self):
        with self._counts_lock:
            self.cleanup_failures += 1
            self.cleanup_incomplete = True
        if self._job is not None:
            self._job.report_cleanup_failure()

    def finish_work(self):
        # An exceptional exit cannot silently release an admitted native owner.
        with self._counts_lock:
            if self._cleanup_owners:
                self.cleanup_incomplete = True
            incomplete = self.cleanup_incomplete
        if incomplete and self._job is not None:
            self._job.report_cleanup_failure()

    def assert_discharged(self):
        self.finish_work()
        if self.cleanup_incomplete:
            raise common._Stop('artwork_probe_unavailable')


def _canonical(root, relative, context):
    drive, parts, _ = _path(root, root=True)
    if len(parts) + len(relative) > 256:
        raise common._Stop('artwork_validation_limit')
    for _ in parts:
        context.charge_component()
    for _ in relative:
        context.charge_component()
    all_parts = (*parts, *relative)
    value = drive + '\\' + '\\'.join(all_parts)
    if len(value.encode('utf-8')) > 16384:
        raise common._Stop('artwork_validation_limit')
    return value


def _below(path, root):
    return path.startswith(root + '\\') if not root.endswith('\\') else path.startswith(root) and path != root


def _observed_stamp(value, root):
    try:
        return _validate_stamp(_copy_stamp(value), root)
    except (common.ResolutionInputInvalid, AttributeError):
        raise common._Stop('artwork_unavailable') from None


def _observe(call, *args, **kwargs):
    try:
        return call(*args, **kwargs)
    except WindowsUnavailable as error:
        code = 'artwork_source_changed' if str(error) in (
            'windows_root_changed', 'windows_source_changed', 'windows_directory_changed',
            'windows_bootstrap_changed') else 'artwork_unavailable'
        raise common._Stop(code) from None
    except OSError:
        raise common._Stop('artwork_unavailable') from None


def _root_size(key, stamp):
    return common._key_size(key) + 2 * _stamp_size(stamp)


def _run(value, context):
    if not value.rows:
        return common.Success(value.operation_ref, value.snapshot_digest, value.platform,
                              value.resolver_contract, (), (), context.counts())
    if sys.platform != 'win32':
        raise common._Stop('artwork_unavailable')
    if not value.roots:
        raise common._Stop('artwork_unavailable')
    required = sum(1 if _path(row.stored_cover_path)[0] is not None else len(value.roots)
                   for row in value.rows)
    if required > 16384:
        raise common._Stop('artwork_validation_limit')
    ledger, rows, output = {}, [], common._OutputBudget(value)
    for row in value.rows:
        drive, stored_parts, _ = _path(row.stored_cover_path)
        paths = set()
        if drive is not None:
            context.candidate()
            for _ in stored_parts:
                context.charge_component()
            paths.add(row.stored_cover_path)
        else:
            for root in value.roots:
                context.candidate()
                paths.add(_canonical(root.root_path, stored_parts, context))
        if len(paths) != 1:
            raise common._Stop('artwork_unavailable')
        resolved = next(iter(paths))
        if any(root.root_path == resolved for root in value.roots):
            raise common._Stop('artwork_unavailable')
        roots = [root for root in value.roots if _below(resolved, root.root_path)]
        if not roots:
            raise common._Stop('artwork_unavailable')
        selected = max(roots, key=lambda root: (len(_path(root.root_path, root=True)[1]), -root.root_id))
        key = ('win32', selected.root_id, selected.root_path)
        if key not in ledger:
            context.root_components(len(_path(selected.root_path, root=True)[1]))
            stamp = _observed_stamp(_observe(observe_root,
                RootObservationSelection('win32', selected.root_path), operation_context=context),
                selected.root_path)
            # A single bounded temporary stamp is allowed; reserve both full
            # ledger copies before retention. Its native owner is already closed.
            output.reserve(_root_size(key, stamp))
            ledger[key] = stamp
        relative = tuple(resolved[len(selected.root_path.rstrip('\\')) + 1:].split('\\'))
        expected = row.expected
        if expected is not None and (expected.root_id != selected.root_id
                or expected.root_path != selected.root_path
                or expected.resolved_cover_path != resolved or expected.relative_parts != relative
                or expected.root_stamp != ledger[key]):
            raise common._Stop('artwork_source_changed')
        observed = _observe(observe_selection,
            RootSelection('win32', selected.root_path, relative), ledger[key], operation_context=context)
        if (type(observed) is not WindowsSelectionObservation
                or type(observed.platform) is not str or observed.platform != 'win32'
                or type(observed.leaf_state) is not str
                or observed.leaf_state not in ('regular', 'missing_tail')):
            raise common._Stop('artwork_unavailable')
        if _observed_stamp(observed.root_stamp, selected.root_path) != ledger[key]:
            raise common._Stop('artwork_source_changed')
        output.reserve(common._row_size(row.row_ref, row.stored_cover_path, resolved,
            relative, selected.root_path, key, observed.leaf_state))
        rows.append(common.RowObservation(row.row_ref, row.local_album_id, row.stored_cover_path,
            resolved, relative, selected.root_id, selected.root_path, key, observed.leaf_state))
    roots = []
    for key in sorted(ledger, key=lambda item: item[1]):
        final = _observed_stamp(_observe(observe_root,
            RootObservationSelection(key[0], key[2]), operation_context=context), key[2])
        if final != ledger[key]:
            raise common._Stop('artwork_source_changed')
        roots.append(common.RootObservation(key, ledger[key], final))
    context.assert_discharged()
    context.check()
    return common.Success(value.operation_ref, value.snapshot_digest, value.platform,
                          value.resolver_contract, tuple(rows), tuple(roots), context.counts())
