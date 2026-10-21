"""Bounded Foobar preview evidence orchestration and read-only validation.

Importing this module initializes no product, helper, process or network activity.
The three public validation seams are read-only; CLI activity is explicit only.
"""

# Import-safe orchestration. No hosted activity is reachable merely by import.
import argparse
from contextlib import contextmanager
import copy
import hashlib
import importlib.machinery
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import signal
import stat
import struct
import sys
import time
import types
import xml.etree.ElementTree as ET
import zipfile
import zlib

_C_ADAPTER = 'scripts/ci/foobar_preview_evidence.py'
_C_PLAN = 'scripts/ci/foobar_preview_plan.json'
_C_OLD = 'scripts/ci/new_feature_evidence.py'
_C_OLD_SHA = '8f45a3c1c3ada77a817928463527fb4add58f57f70a2d3f24cc9187cf5fb3673'
_C_WORKFLOW = '.github/workflows/foobar-preview-backend-evidence.yml'
_C_REPOSITORY = 'idanilovqa/AlbumHaven'
_C_FILE = 33554432
_C_BYTES = 268435456
_C_FILES = 4096
_C_AGGREGATE = 2147483648
_C_AGGREGATE_FILES = 32768
_C_OWNERS = ('admission', 'helper', 'core', 'resource_1', 'resource_2', 'resource_3', 'resource_4', 'reconcile')
_C_CONTROLS = (_C_WORKFLOW, '.github/workflows/new-feature-backend-evidence.yml',
    'scripts/ci/admit-new-feature-evidence.py', _C_OLD, _C_ADAPTER, _C_PLAN,
    'tests/py/test_new_feature_ci_contract.py', 'tests/py/test_new_feature_evidence.py',
    'tests/py/test_foobar_preview_ci_contract.py', 'tests/py/test_foobar_preview_evidence.py')
_C_PRODUCTS = ('music_app/services/foobar_snapshot_parser.py',
    'music_app/services/foobar_snapshot_preview.py', 'tests/py/test_foobar_snapshot_preview.py',
    'tests/py/test_foobar_snapshot_preview_resources.py')
_C_SUPERVISOR = None
_CHILD_PROGRAM = '''import hashlib, importlib.machinery, importlib.util, json, pathlib, sys
root = pathlib.Path(sys.argv[1]).resolve(strict=True)
request = pathlib.Path(sys.argv[2])
if request.is_symlink() or request.stat().st_size > 33554432:
    raise ValueError("Unbounded or linked child request")
with request.open("rb") as stream:
    admitted = json.loads(stream.read(33554433))
path = root / "scripts/ci/foobar_preview_evidence.py"
if path.is_symlink() or path.stat().st_size > 33554432:
    raise ValueError("Unbounded or linked adapter")
with path.open("rb") as stream:
    source = stream.read(33554433)
if hashlib.sha256(source).hexdigest() != admitted["expected"]["source_hashes"]["scripts/ci/foobar_preview_evidence.py"]:
    raise ValueError("Adapter source changed before child initialization")
class BoundSource(importlib.machinery.SourceFileLoader):
    def get_data(self, location):
        if location != str(path):
            raise OSError("Only admitted source is available")
        return source
    def set_data(self, location, data, *, _mode=0o666):
        return None
spec = importlib.util.spec_from_file_location("foobar_preview_child", path, loader=BoundSource("foobar_preview_child", str(path)))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
raise SystemExit(module._child_entry(root, request, sys.argv[3:]))
'''


def _c_require(condition, message):
    if not condition:
        raise ValueError(message)


def _c_path(root, relative):
    _c_require(type(relative) is str and relative and '\\' not in relative and '\x00' not in relative,
               'Invalid confined path')
    parts = relative.split('/')
    _c_require(all(p not in ('', '.', '..') and ':' not in p for p in parts), 'Unconfined path')
    root = Path(root)
    _c_require(root.is_dir() and not root.is_symlink(), 'Unowned root')
    path = root
    for part in parts:
        path = path / part
        _c_require(not path.is_symlink(), 'Linked path')
    _c_require(path.resolve(strict=True).is_relative_to(root.resolve(strict=True)), 'Escaped path')
    return path


def _c_bytes(path, maximum=_C_FILE):
    path = Path(path)
    before = path.lstat()
    _c_require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= maximum, 'File type or size limit')
    result = bytearray()
    with path.open('rb') as stream:
        opened = os.fstat(stream.fileno())
        _c_require((opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns) ==
                   (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns), 'Changed file identity')
        left = before.st_size
        while left:
            chunk = stream.read(min(left, 65536))
            _c_require(chunk and len(chunk) <= left, 'File length changed')
            result.extend(chunk)
            left -= len(chunk)
        _c_require(stream.read(1) == b'', 'File stream exceeds declared length')
        after_fd = os.fstat(stream.fileno())
    after = path.lstat()
    identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_mode)
    _c_require(identity(before) == identity(after_fd) == identity(after), 'Changed file bytes or identity')
    return bytes(result)


def _c_json_bytes(data):
    def pairs(items):
        result = {}
        for key, value in items:
            _c_require(key not in result, 'Duplicate JSON key')
            result[key] = value
        return result
    def invalid(value):
        raise ValueError('Nonfinite JSON number')
    def finite(value):
        number = float(value)
        _c_require(math.isfinite(number), 'Nonfinite JSON number')
        return number
    return json.loads(data.decode('utf-8'), object_pairs_hook=pairs, parse_constant=invalid, parse_float=finite)


def _c_json(path):
    return _c_json_bytes(_c_bytes(path))


class _HashBoundLoader(importlib.machinery.SourceFileLoader):
    def __init__(self, name, path, data):
        super().__init__(name, str(path))
        self._source_path = str(path)
        self._source_bytes = data

    def get_data(self, path):
        if path != self._source_path:
            raise OSError('Only the admitted source file is available')
        return self._source_bytes

    def set_data(self, path, data, *, _mode=0o666):
        # The immutable source loader never writes bytecode caches.
        return None


def _legacy_helper():
    global _C_SUPERVISOR
    root = Path(__file__).resolve(strict=True).parents[2]
    path = _c_path(root, _C_OLD)
    data = _c_bytes(path)
    _c_require(hashlib.sha256(data).hexdigest() == _C_OLD_SHA, 'Supervisor source hash changed')
    if _C_SUPERVISOR is None:
        name = '_foobar_preview_owned_supervisor'
        loader = _HashBoundLoader(name, path, data)
        specification = importlib.util.spec_from_file_location(name, path, loader=loader)
        _c_require(specification is not None and specification.loader is not None, 'No supervisor loader')
        module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(module)
        _C_SUPERVISOR = module
    return _C_SUPERVISOR


def _c_write(path, value):
    data = value if type(value) is bytes else (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()
    _c_require(len(data) < _C_FILE, 'Producer file reached storage ceiling')
    path = Path(path)
    _c_require(not path.exists() and not path.is_symlink(), 'Refusing uncertain overwrite')
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('xb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    _c_require(_c_bytes(path) == data, 'Writer verification failed')


@contextmanager
def _c_deadline(seconds):
    _c_require(type(seconds) in (int, float) and 0 < seconds <= 120, 'Invalid orchestration deadline')
    def expired(signum, frame):
        raise TimeoutError('Orchestration budget exceeded')
    previous = signal.getsignal(signal.SIGALRM)
    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def _c_context(root, producer, provenance):
    env = os.environ
    _c_require(env.get('GITHUB_ACTIONS') == 'true' and env.get('RUNNER_OS') == 'Linux', 'Hosted Linux only')
    _c_require(env.get('GITHUB_REPOSITORY') == _C_REPOSITORY and env.get('GITHUB_EVENT_NAME') == 'pull_request', 'Wrong workflow event')
    event = _c_json(Path(env['GITHUB_EVENT_PATH']))
    pr = event['pull_request']
    head = pr['head']['sha']
    _c_require(pr['head']['repo']['full_name'] == _C_REPOSITORY and
               pr['head']['ref'] == '2026-10-03-album-tops', 'Wrong pull request source')
    _c_require(env.get('GITHUB_JOB') == producer and producer in _C_OWNERS, 'Wrong producer job')
    run_id, attempt = int(env['GITHUB_RUN_ID']), int(env['GITHUB_RUN_ATTEMPT'])
    _c_require(run_id > 0 and attempt >= 2 and re.fullmatch('[0-9a-f]{40}', head), 'Wrong run identity')
    checkout_head = _c_bytes(_c_path(root, '.git/HEAD'), 256).decode('ascii').strip()
    _c_require(checkout_head == head, 'Checkout must be detached at the admitted head')
    workflow_ref = env.get('GITHUB_WORKFLOW_REF', '')
    _c_require(workflow_ref.startswith(_C_REPOSITORY + '/' + _C_WORKFLOW + '@'), 'Wrong workflow path')
    hashes = {relative: hashlib.sha256(_c_bytes(_c_path(root, relative))).hexdigest()
              for relative in (*_C_CONTROLS, *_C_PRODUCTS)}
    _c_require(hashes[_C_OLD] == _C_OLD_SHA, 'Unadmitted supervisor')
    plan = _c_json(_c_path(root, _C_PLAN))
    _v_check_plan(plan)
    expected = {'repository': _C_REPOSITORY, 'head_sha': head, 'checkout_head': checkout_head,
                'workflow_path': _C_WORKFLOW, 'workflow_sha256': hashes[_C_WORKFLOW],
                'plan_sha256': hashes[_C_PLAN], 'run_id': run_id, 'run_attempt': attempt,
                'producer_job': producer, 'cancelled': env.get('PREVIEW_CANCELLED') != 'false',
                'source_hashes': hashes, 'provenance': provenance}
    _v_check_expected(expected)
    _c_require(not expected['cancelled'], 'Cancellation or missing independent cancellation state')
    return plan, expected


def _c_check_sources(root, expected, *, product=True):
    paths = (*_C_CONTROLS, *_C_PRODUCTS) if product else _C_CONTROLS
    for path in paths:
        _c_require(hashlib.sha256(_c_bytes(_c_path(root, path))).hexdigest() == expected['source_hashes'][path],
                   'Admitted source changed')


def _c_zip_preflight(path):
    # Inspect bounded EOCD/ZIP64 counts before zipfile can allocate its directory.
    size = path.stat().st_size
    _c_require(22 <= size <= _C_BYTES, 'Encoded artifact size limit')
    with path.open('rb') as stream:
        stream.seek(max(0, size - 65557))
        tail = stream.read(min(size, 65557))
        offset = tail.rfind(b'PK\x05\x06')
        _c_require(offset >= 0 and len(tail) - offset >= 22, 'Missing ZIP directory')
        eocd = struct.unpack_from('<4s4H2IH', tail, offset)
        _, disk, directory_disk, disk_count, count, length, start, comment = eocd
        _c_require(len(tail) - offset == 22 + comment and disk == directory_disk == 0, 'Multidisk or trailing ZIP')
        absolute = size - len(tail) + offset
        directory_boundary = absolute
        stream.seek(max(0, absolute - 20))
        possible_locator = stream.read(20) if absolute >= 20 else b''
        has_zip64 = possible_locator.startswith(b'PK\x06\x07')
        if has_zip64 or count == 65535 or length == 4294967295 or start == 4294967295:
            _c_require(absolute >= 20, 'Missing ZIP64 locator')
            stream.seek(absolute - 20)
            locator = stream.read(20)
            _c_require(len(locator) == 20, 'Truncated ZIP64 locator')
            signature, zip_disk, zip_offset, disks = struct.unpack('<4sIQI', locator)
            _c_require(signature == b'PK\x06\x07' and zip_disk == 0 and disks == 1, 'Invalid ZIP64 locator')
            _c_require(0 <= zip_offset and zip_offset + 76 == absolute, 'ZIP64 end records are not contiguous')
            stream.seek(zip_offset)
            record = stream.read(56)
            _c_require(len(record) == 56, 'Truncated ZIP64 directory')
            values = struct.unpack('<4sQ2H2I4Q', record)
            _c_require(values[0] == b'PK\x06\x06' and values[1] == 44 and values[4] == values[5] == 0, 'Invalid ZIP64 directory')
            disk_count, count, length, start = values[6:]
            directory_boundary = zip_offset
        _c_require(disk_count == count and 0 < count <= _C_FILES, 'ZIP entry count limit')
        _c_require(0 < length <= 8388608 and 0 <= start and start + length == directory_boundary, 'ZIP directory size limit')
        # ZipFile allocates until directory byte length, not the advertised count.
        # Count and bound each real directory record before its constructor runs.
        cursor, observed = start, 0
        while cursor < start + length:
            _c_require(observed < _C_FILES and cursor + 46 <= start + length, 'ZIP actual entry count or directory bound')
            stream.seek(cursor)
            header = stream.read(46)
            _c_require(len(header) == 46, 'Truncated central directory')
            central = struct.unpack('<4s6H3I5H2I', header)
            _c_require(central[0] == b'PK\x01\x02' and central[13] == 0, 'Invalid central directory record')
            name_size, extra_size, comment_size = central[10:13]
            _c_require(0 < name_size <= 4096, 'ZIP central name bound')
            cursor += 46 + name_size + extra_size + comment_size
            _c_require(cursor <= start + length, 'Central directory record escapes')
            observed += 1
        _c_require(cursor == start + length and observed == count, 'ZIP actual directory count mismatch')
    return count, start


def _c_decode_zip(path, destination, remaining_bytes, remaining_files):
    count, central_start = _c_zip_preflight(path)
    _c_require(count <= remaining_files and not destination.exists(), 'Aggregate file bound or duplicate owner')
    destination.mkdir(parents=True, exist_ok=False)
    names, decoded, spans = set(), 0, []
    with zipfile.ZipFile(path, 'r') as archive, path.open('rb') as raw:
        entries = archive.infolist()
        _c_require(len(entries) == count, 'ZIP directory count mismatch')
        for entry in entries:
            relative = entry.filename
            mode = entry.external_attr >> 16
            _c_require(not entry.is_dir() and not (entry.flag_bits & 1) and entry.compress_type in (0, 8), 'Unsupported ZIP entry')
            _c_require(not mode or stat.S_IFMT(mode) in (0, stat.S_IFREG), 'Special ZIP file')
            _c_require(type(relative) is str and relative and relative not in names and '\\' not in relative and
                       all(part not in ('', '.', '..') and ':' not in part for part in relative.split('/')), 'Unconfined duplicate ZIP path')
            _c_require('\x00' not in relative and len(relative.encode('utf-8')) <= 4096, 'Invalid ZIP name')
            names.add(relative)
            _c_require(0 <= entry.file_size <= _C_FILE and 0 <= entry.compress_size <= _C_BYTES, 'ZIP file size limit')
            _c_require(entry.compress_type != 0 or entry.compress_size == entry.file_size, 'Stored ZIP size disagreement')
            decoded += entry.file_size
            _c_require(decoded <= min(_C_BYTES, remaining_bytes), 'Decoded aggregate storage limit')
        for entry in entries:
            raw.seek(entry.header_offset)
            header = raw.read(30)
            _c_require(len(header) == 30, 'Truncated ZIP local header')
            local = struct.unpack('<4s5H3I2H', header)
            _c_require(local[0] == b'PK\x03\x04' and local[2] == entry.flag_bits and local[3] == entry.compress_type,
                       'ZIP local/central disagreement')
            if not (entry.flag_bits & 8):
                _c_require(local[6] == entry.CRC and local[7] in (entry.compress_size, 4294967295) and
                           local[8] in (entry.file_size, 4294967295), 'ZIP local sizes or CRC disagree')
            name_size, extra_size = local[-2:]
            _c_require(name_size <= 4096 and extra_size <= 65535, 'ZIP local metadata limit')
            name = raw.read(name_size)
            encoding = 'utf-8' if entry.flag_bits & 2048 else 'cp437'
            _c_require(name.decode(encoding) == entry.filename, 'ZIP local name mismatch')
            raw.seek(extra_size, 1)
            start = raw.tell()
            finish = start + entry.compress_size
            _c_require(0 <= entry.header_offset < start <= finish <= central_start, 'ZIP data escapes archive')
            span_end = finish
            if entry.flag_bits & 8:
                raw.seek(finish)
                descriptor = raw.read(min(24, central_start - finish))
                offset = 4 if descriptor.startswith(b'PK\x07\x08') else 0
                widths = []
                if len(descriptor) >= offset + 12:
                    crc32, compressed32, decoded32 = struct.unpack_from('<III', descriptor, offset)
                    if (crc32, compressed32, decoded32) == (entry.CRC, entry.compress_size, entry.file_size):
                        widths.append(offset + 12)
                if len(descriptor) >= offset + 20:
                    crc64, compressed64, decoded64 = struct.unpack_from('<IQQ', descriptor, offset)
                    if (crc64, compressed64, decoded64) == (entry.CRC, entry.compress_size, entry.file_size):
                        widths.append(offset + 20)
                _c_require(len(widths) == 1, 'ZIP descriptor does not uniquely match directory')
                span_end += widths[0]
            _c_require(span_end <= central_start and all(span_end <= a or entry.header_offset >= b for a, b in spans), 'Overlapping ZIP data or descriptor')
            spans.append((entry.header_offset, span_end))
            raw.seek(start)
            output = destination / entry.filename
            output.parent.mkdir(parents=True, exist_ok=True)
            remaining, emitted, crc = entry.compress_size, 0, 0
            inflater = zlib.decompressobj(-15) if entry.compress_type == 8 else None
            with output.open('xb') as target:
                while remaining:
                    chunk = raw.read(min(remaining, 65536))
                    _c_require(chunk and len(chunk) <= remaining, 'Truncated ZIP data')
                    remaining -= len(chunk)
                    if inflater is None:
                        data = chunk
                        _c_require(len(data) <= entry.file_size - emitted, 'Stored ZIP overflow')
                        target.write(data)
                        emitted += len(data)
                        crc = zlib.crc32(data, crc)
                    else:
                        pending = chunk
                        while pending:
                            allowance = entry.file_size - emitted
                            # A valid empty stream or terminal block may consume
                            # compressed bytes without producing output. A single
                            # bounded rejection-probe byte detects overflow but is
                            # never written or counted as accepted decoded proof.
                            capacity = min(65536, max(1, allowance))
                            data = inflater.decompress(pending, capacity)
                            pending = inflater.unconsumed_tail
                            _c_require(len(data) <= allowance and not inflater.unused_data, 'Deflate surplus data')
                            target.write(data)
                            emitted += len(data)
                            crc = zlib.crc32(data, crc)
                            _c_require(data or not pending, 'Deflate made no progress')
                _c_require(emitted == entry.file_size and crc & 0xffffffff == entry.CRC, 'ZIP size or CRC mismatch')
                _c_require(inflater is None or inflater.eof, 'Incomplete bounded deflate stream')
                target.flush()
                os.fsync(target.fileno())
    return decoded, count


# Private production orchestration gate, outside the unchanged public schemas.
# The transport owns origin authentication; these bounded retained bytes are not
# self-authenticating JSON. Every consumer reacquires the exact run-attempt API.
_C_STAGE_NAMES = {
    'checkout': 'Checkout exact pull-request head',
    'download': 'Transfer only exact authenticated same-attempt artifact IDs',
    'verify': 'Decode bounded inputs and validate complete upstream proof before setup',
    'setup_python': 'Set up Python without post-job cache work',
    'install': 'Install only existing requirements after raw-proof admission',
    'legacy': 'Execute unchanged complete legacy CI-helper lane first',
    'admission': 'Observe unchanged first-attempt and native-terminal admission',
}


def _c_interval(record):
    start, finish = _v_stamp(record['started_at']), _v_stamp(record['completed_at'])
    _c_require(start <= finish, 'Reversed completed stage interval')
    duration = (finish - start).total_seconds()
    # Conservatively allow one second of timestamp uncertainty at each endpoint
    # by charging the upper interval, never by increasing a budget or deadline.
    return start, finish, duration + 2, max(0, duration - 2)


def _c_owned_residual(step, records):
    start, finish, upper, _ = _c_interval(step)
    previous, lower = None, 0
    for record in records:
        left, right = _v_stamp(record['started_at']), _v_stamp(record['finished_at'])
        _c_require(left <= right and (previous is None or previous <= left), 'Owned intervals overlap or reverse')
        _c_require((left - start).total_seconds() >= -1 and (right - finish).total_seconds() <= 1,
                   'Owned process is outside its independently observed completed step')
        _c_require((right - left).total_seconds() <= record['limits']['runtime_seconds'] + 60,
                   'Owned process exceeded its unchanged cleanup deadline')
        previous = right
        lower += max(0, (right - left).total_seconds() - 2)
    _c_require(0 <= lower <= upper, 'Impossible completed step attribution')
    return upper - lower


def _c_completed_job(job, owner, plan, receipt, assessment, observed_at):
    _c_require(job['status'] == 'completed' and job['conclusion'] in ('success', 'failure'),
               'Producer completion is missing or cancelled')
    start, finish, job_upper, _ = _c_interval(job)
    _c_require(finish <= observed_at and job_upper <= plan['job_minutes'][owner] * 60,
               'Producer job completion is unobserved or exceeds its fixed cap')
    main = [_C_STAGE_NAMES['checkout']]
    run_name = ('Execute fixed ' + ('resource' if owner.startswith('resource_') else owner) +
                ' phase with fail-closed evidence')
    upload_name = 'Retain ' + owner + ' proof without masking any failure'
    if owner == 'admission':
        main += [_C_STAGE_NAMES['admission'], 'Retain fresh original admission even on hold']
        upload_name = main[-1]
    else:
        main += [_C_STAGE_NAMES[k] for k in ('download', 'verify', 'setup_python', 'install')]
        if owner == 'helper':
            main += [_C_STAGE_NAMES['legacy']]
        main += [run_name, upload_name]
    post = (['Post ' + _C_STAGE_NAMES['setup_python']] if owner != 'admission' else [])
    post += ['Post ' + _C_STAGE_NAMES['checkout']]
    names = ['Set up job', *main, *post, 'Complete job']
    steps = job.get('steps')
    _c_require(type(steps) is list and len(steps) == len(names), 'Missing or unexpected completed producer stage')
    _c_require([step.get('name') for step in steps] == names, 'Unknown, duplicate or reordered producer stage')
    numbers = [step.get('number') for step in steps]
    _c_require(all(type(number) is int and number > 0 for number in numbers) and
               numbers == sorted(set(numbers)), 'Malformed or duplicate stage identity')
    safe_failure = owner not in ('admission', 'helper') and assessment['status'] in ('assertion_failed', 'timed_out_safe')
    required_conclusion = 'failure' if safe_failure else 'success'
    _c_require(job['conclusion'] == required_conclusion, 'Producer job conclusion contradicts validated raw proof')
    mapped, intervals, previous = {}, [], None
    for step in steps:
        _c_require(step.get('status') == 'completed', 'Stage is not complete')
        name = step['name']
        skipped_post = (safe_failure and name == 'Post ' + _C_STAGE_NAMES['setup_python'] and
                        step.get('conclusion') == 'skipped')
        if skipped_post:
            # setup-python@v5 declares post-if success(). Only this explicit
            # platform-recorded, source-known nonexecution may have no interval.
            skipped_start, skipped_finish = step.get('started_at'), step.get('completed_at')
            _c_require((skipped_start is None and skipped_finish is None) or
                       (type(skipped_start) is str and skipped_start == skipped_finish),
                       'Skipped conditional post contradicts zero executed work')
            if skipped_start is not None:
                _v_stamp(skipped_start)
            mapped[name] = 0
            continue
        wanted = required_conclusion if name == run_name else 'success'
        _c_require(step.get('conclusion') == wanted, 'Failed, cancelled or skipped prerequisite stage')
        left, right, upper, lower = _c_interval(step)
        _c_require((left - start).total_seconds() >= -1 and (right - finish).total_seconds() <= 1 and
                   (previous is None or previous <= left), 'Stage interval escapes or overlaps its completed job')
        previous = right
        mapped[name] = upper
        if name not in ('Set up job', 'Complete job'):
            intervals.append(lower)
    stages = {key: 0 for key in plan['overhead_seconds']}
    stages['checkout'] = mapped[_C_STAGE_NAMES['checkout']] + mapped['Post ' + _C_STAGE_NAMES['checkout']]
    stages['upload'] = mapped[upload_name]
    _c_require(sum(intervals) <= job_upper, 'Completed step attribution exceeds the containing job')
    slack = job_upper - sum(intervals)
    if owner == 'admission':
        _c_require(stages['checkout'] <= 120 and stages['upload'] <= 60 and
                   mapped[_C_STAGE_NAMES['admission']] <= 120, 'Admission stage exceeded its unchanged enclosing bound')
    else:
        for key in ('download', 'verify', 'setup_python', 'install'):
            stages[key] += mapped[_C_STAGE_NAMES[key]]
        stages['setup_python'] += mapped['Post ' + _C_STAGE_NAMES['setup_python']]
        by_name = {step['name']: step for step in steps}
        if owner == 'helper':
            _c_require(len(receipt['git_operations']) == 2, 'Both helper runners require their distinct checkout proofs')
            legacy = receipt['helper_proofs']['legacy']
            legacy_processes = [receipt['git_operations'][0], legacy['collection']['process'], legacy['invocation']]
            preview_processes = [receipt['git_operations'][1], receipt['collection']['process'], *receipt['invocations']]
            residual = (_c_owned_residual(by_name[_C_STAGE_NAMES['legacy']], legacy_processes) +
                        _c_owned_residual(by_name[run_name], preview_processes))
        else:
            records = [*receipt['git_operations'], receipt['collection']['process'], *receipt['invocations']]
            residual = _c_owned_residual(by_name[run_name], records)
        # There is no trustworthy fine-grained split in the frozen old runner.
        # Charge ALL mixed-step overhead, including startup/serialization/teardown,
        # to BOTH separate budgets. This is stricter double-charging, never pooled
        # allowance or double-spending of the reserved orchestration slack.
        stages['verify'] += residual
        stages['finalize'] += residual
        _c_require(all(stages[key] <= maximum for key, maximum in plan['overhead_seconds'].items()),
                   'A completed aggregate orchestration stage exceeds its fixed budget')
        maximum_slack = 280 if owner == 'helper' else 350 if owner == 'core' else 470
        _c_require(slack <= maximum_slack, 'Unassigned completed job overhead exceeds reserved slack')
    return {'producer_job': owner, 'job_id': job['id'], 'job_upper_seconds': job_upper,
            'unassigned_upper_seconds': slack, 'overhead_upper_seconds': stages,
            'completion': 'complete', 'source': 'exact-attempt-jobs-api'}


def _c_completed_stages(plan, expected, directories):
    temporary = Path(os.environ['RUNNER_TEMP'])
    transfer = temporary / 'foobar-preview-transfer'
    _c_require(os.environ.get('PREVIEW_TRANSFER_OUTCOME') == 'success', 'Incomplete metadata or artifact acquisition')
    acquisition = _c_json(_c_path(transfer, 'acquisition.json'))
    _c_require(set(acquisition) == {'schema_version', 'repository', 'head_sha', 'workflow_path', 'run_id',
                                  'run_attempt', 'consumer_job', 'responses'}, 'Malformed acquisition envelope')
    _c_require(acquisition['schema_version'] == 'foobar-preview-acquisition-v1' and
               acquisition['consumer_job'] == expected['producer_job'], 'Wrong acquisition consumer')
    for key in ('repository', 'head_sha', 'workflow_path', 'run_id', 'run_attempt'):
        _c_require(type(acquisition[key]) is type(expected[key]) and acquisition[key] == expected[key], 'Acquisition context differs')
    records = acquisition['responses']
    _c_require(type(records) is list and len(records) == 2 and
               [item.get('kind') for item in records] == ['run', 'jobs'], 'Incomplete acquisition response set')
    base = 'https://api.github.com/repos/' + _C_REPOSITORY + '/actions/runs/' + str(expected['run_id']) + '/attempts/' + str(expected['run_attempt'])
    parsed, previous, response_bytes = {}, None, 0
    for record, kind, relative, url in zip(records, ('run', 'jobs'), ('run-attempt.json', 'attempt-jobs.json'),
                                         (base, base + '/jobs?per_page=100&page=1')):
        _c_require(set(record) == {'kind', 'url', 'status', 'started_at', 'finished_at', 'size', 'sha256', 'path'} and
                   record['path'] == relative and record['url'] == url and type(record['status']) is int and record['status'] == 200,
                   'Untrusted acquisition URL or response')
        left, right = _v_stamp(record['started_at']), _v_stamp(record['finished_at'])
        _c_require(left <= right and (right - left).total_seconds() < 10 and
                   (previous is None or previous <= left), 'Unbounded or reversed acquisition interval')
        previous = right
        raw = _c_bytes(_c_path(transfer, relative), 1048576)
        _c_require(type(record['size']) is int and 0 < len(raw) == record['size'] and
                   hashlib.sha256(raw).hexdigest() == record['sha256'], 'Raw acquisition response differs')
        response_bytes += len(raw)
        _c_require(response_bytes <= 2097152, 'Acquisition response aggregate bound')
        parsed[kind] = _c_json_bytes(raw)
    run, listing = parsed['run'], parsed['jobs']
    _c_require(type(run) is dict and all(type(run.get(key)) is int and run[key] == expected[wanted]
               for key, wanted in (('id', 'run_id'), ('run_attempt', 'run_attempt'))), 'Wrong observed workflow attempt')
    _c_require(run.get('repository', {}).get('full_name') == _C_REPOSITORY and run.get('head_sha') == expected['head_sha'] and
               run.get('head_branch') == '2026-10-03-album-tops' and run.get('event') == 'pull_request' and
               run.get('path') == _C_WORKFLOW and run.get('name') == 'Foobar Preview Backend Evidence (supplemental)' and
               run.get('status') == 'in_progress' and run.get('conclusion') is None,
               'Workflow identity, state or source differs from independent checkout context')
    _c_require(type(listing) is dict and set(listing) == {'total_count', 'jobs'} and type(listing['jobs']) is list and
               type(listing['total_count']) is int and listing['total_count'] == len(listing['jobs']) and
               1 <= listing['total_count'] <= 8, 'Paginated, incomplete or oversized job listing')
    jobs, identities = {}, set()
    for job in listing['jobs']:
        _c_require(type(job) is dict and job.get('name') in _C_OWNERS and job['name'] not in jobs and
                   type(job.get('id')) is int and job['id'] > 0 and job['id'] not in identities, 'Duplicate or unknown job owner')
        _c_require(type(job.get('run_id')) is int and job['run_id'] == expected['run_id'] and
                   type(job.get('run_attempt')) is int and job['run_attempt'] == expected['run_attempt'] and
                   job.get('head_sha') == expected['head_sha'] and job.get('head_branch') == '2026-10-03-album-tops' and
                   job.get('workflow_name') == 'Foobar Preview Backend Evidence (supplemental)' and
                   job.get('run_url') == base.split('/attempts/')[0] and
                   job.get('url') == 'https://api.github.com/repos/' + _C_REPOSITORY + '/actions/jobs/' + str(job['id']),
                   'Job is not bound to the exact observed attempt and workflow')
        jobs[job['name']] = job
        identities.add(job['id'])
    _c_require(expected['producer_job'] in jobs and jobs[expected['producer_job']]['status'] == 'in_progress',
               'Acquisition was not observed during its actual consumer job')
    consumer_started = _v_stamp(jobs[expected['producer_job']]['started_at'])
    context = _v_Context(plan, expected, directories)
    owners, holds = [], []
    needed = _C_OWNERS[:_C_OWNERS.index(expected['producer_job'])]
    for owner in needed:
        try:
            _c_require(owner in jobs and owner in directories, 'Missing completed producer or raw artifact')
            producer_start = _v_stamp(jobs[owner]['started_at'])
            producer_finish = _v_stamp(jobs[owner]['completed_at'])
            _c_require(producer_finish <= consumer_started and all(
                predecessor in jobs and _v_stamp(jobs[predecessor]['completed_at']) <= producer_start
                for predecessor in needed[:needed.index(owner)]), 'Observed producer jobs violate serial dependency ownership')
            if owner == 'admission':
                context.admission()
                receipt, assessment = None, {'status': 'passed'}
            else:
                assessment = _v_artifact(context, owner)
                _c_require(assessment['status'] == 'passed' if owner == 'helper' else assessment['continue_allowed'],
                           'Raw producer proof is incomplete or unsafe')
                receipt = context.receipts[owner]
            owners.append(_c_completed_job(jobs[owner], owner, plan, receipt, assessment,
                                           _v_stamp(records[1]['started_at'])))
        except Exception:
            holds.append({'producer_job': owner, 'completion': 'incomplete', 'cause': 'completed_stage_unproven'})
    context.finish()
    _c_require(not holds or expected['producer_job'] == 'reconcile', 'Completed prerequisite stage acceptance failed')
    return {'schema_version': 'foobar-preview-completed-stages-v1',
            'repository': expected['repository'], 'head_sha': expected['head_sha'],
            'workflow_path': expected['workflow_path'], 'run_id': expected['run_id'], 'run_attempt': expected['run_attempt'],
            'consumer_job': expected['producer_job'], 'owners': owners, 'holds': holds,
            'own_future_completion': 'unproven', 'timestamp_uncertainty_seconds_per_endpoint': 1,
            'residual_policy': 'charge_each_mixed_step_residual_to_both_verify_and_finalize'}



def _c_hold_context(root, provenance):
    producer = 'reconcile'
    env = os.environ
    _c_require(env.get('GITHUB_ACTIONS') == 'true' and env.get('RUNNER_OS') == 'Linux', 'Hosted Linux only')
    _c_require(env.get('GITHUB_REPOSITORY') == _C_REPOSITORY and env.get('GITHUB_EVENT_NAME') == 'pull_request', 'Wrong workflow event')
    event = _c_json(Path(env['GITHUB_EVENT_PATH']))
    pr = event['pull_request']
    head = pr['head']['sha']
    _c_require(pr['head']['repo']['full_name'] == _C_REPOSITORY and
               pr['head']['ref'] == '2026-10-03-album-tops', 'Wrong pull request source')
    _c_require(env.get('GITHUB_JOB') == producer and producer in _C_OWNERS, 'Wrong producer job')
    run_id, attempt = int(env['GITHUB_RUN_ID']), int(env['GITHUB_RUN_ATTEMPT'])
    _c_require(run_id > 0 and attempt == 1 and re.fullmatch('[0-9a-f]{40}', head), 'Wrong run identity')
    checkout_head = _c_bytes(_c_path(root, '.git/HEAD'), 256).decode('ascii').strip()
    _c_require(checkout_head == head, 'Checkout must be detached at the admitted head')
    workflow_ref = env.get('GITHUB_WORKFLOW_REF', '')
    _c_require(workflow_ref.startswith(_C_REPOSITORY + '/' + _C_WORKFLOW + '@'), 'Wrong workflow path')
    hashes = {relative: hashlib.sha256(_c_bytes(_c_path(root, relative))).hexdigest()
              for relative in (*_C_CONTROLS, *_C_PRODUCTS)}
    _c_require(hashes[_C_OLD] == _C_OLD_SHA, 'Unadmitted supervisor')
    plan = _c_json(_c_path(root, _C_PLAN))
    _v_check_plan(plan)
    expected = {'repository': _C_REPOSITORY, 'head_sha': head, 'checkout_head': checkout_head,
                'workflow_path': _C_WORKFLOW, 'workflow_sha256': hashes[_C_WORKFLOW],
                'plan_sha256': hashes[_C_PLAN], 'run_id': run_id, 'run_attempt': attempt,
                'producer_job': producer, 'cancelled': env.get('PREVIEW_CANCELLED') != 'false',
                'source_hashes': hashes, 'provenance': provenance}
    _v_hold_expected(expected)
    _c_require(env.get('GITHUB_RUN_ATTEMPT') == '1' and env.get('PREVIEW_CANCELLED') in ('true', 'false'), 'Unknown held attempt or cancellation state')
    return plan, expected


def _c_hold_jobs(plan, expected, admission, retained):
    temporary = Path(os.environ['RUNNER_TEMP'])
    transfer = temporary / 'foobar-preview-transfer'
    _c_require(os.environ.get('PREVIEW_TRANSFER_OUTCOME') == 'success', 'Incomplete metadata or artifact acquisition')
    retained['acquisition.json'] = _c_bytes(_c_path(transfer, 'acquisition.json'), 1048576)
    acquisition = _c_json_bytes(retained['acquisition.json'])
    _c_require(set(acquisition) == {'schema_version', 'repository', 'head_sha', 'workflow_path', 'run_id',
                                  'run_attempt', 'consumer_job', 'responses'}, 'Malformed acquisition envelope')
    _c_require(acquisition['schema_version'] == 'foobar-preview-acquisition-v1' and
               acquisition['consumer_job'] == expected['producer_job'], 'Wrong acquisition consumer')
    for key in ('repository', 'head_sha', 'workflow_path', 'run_id', 'run_attempt'):
        _c_require(type(acquisition[key]) is type(expected[key]) and acquisition[key] == expected[key], 'Acquisition context differs')
    records = acquisition['responses']
    _c_require(type(records) is list and len(records) == 2 and
               [item.get('kind') for item in records] == ['run', 'jobs'], 'Incomplete acquisition response set')
    base = 'https://api.github.com/repos/' + _C_REPOSITORY + '/actions/runs/' + str(expected['run_id']) + '/attempts/' + str(expected['run_attempt'])
    parsed, previous, response_bytes = {}, None, 0
    for record, kind, relative, url in zip(records, ('run', 'jobs'), ('run-attempt.json', 'attempt-jobs.json'),
                                         (base, base + '/jobs?per_page=100&page=1')):
        _c_require(set(record) == {'kind', 'url', 'status', 'started_at', 'finished_at', 'size', 'sha256', 'path'} and
                   record['path'] == relative and record['url'] == url and type(record['status']) is int and record['status'] == 200,
                   'Untrusted acquisition URL or response')
        left, right = _v_stamp(record['started_at']), _v_stamp(record['finished_at'])
        _c_require(left <= right and (right - left).total_seconds() < 10 and
                   (previous is None or previous <= left), 'Unbounded or reversed acquisition interval')
        previous = right
        raw = _c_bytes(_c_path(transfer, relative), 1048576)
        _c_require(type(record['size']) is int and 0 < len(raw) == record['size'] and
                   hashlib.sha256(raw).hexdigest() == record['sha256'], 'Raw acquisition response differs')
        response_bytes += len(raw)
        _c_require(response_bytes <= 2097152, 'Acquisition response aggregate bound')
        retained[relative] = raw
        parsed[kind] = _c_json_bytes(raw)
    run, listing = parsed['run'], parsed['jobs']
    _c_require(type(run) is dict and all(type(run.get(key)) is int and run[key] == expected[wanted]
               for key, wanted in (('id', 'run_id'), ('run_attempt', 'run_attempt'))), 'Wrong observed workflow attempt')
    _c_require(run.get('repository', {}).get('full_name') == _C_REPOSITORY and run.get('head_sha') == expected['head_sha'] and
               run.get('head_branch') == '2026-10-03-album-tops' and run.get('event') == 'pull_request' and
               run.get('path') == _C_WORKFLOW and run.get('name') == 'Foobar Preview Backend Evidence (supplemental)' and
               run.get('status') == 'in_progress' and run.get('conclusion') is None,
               'Workflow identity, state or source differs from independent checkout context')
    _c_require(type(listing) is dict and set(listing) == {'total_count', 'jobs'} and type(listing['jobs']) is list and
               type(listing['total_count']) is int and listing['total_count'] == len(listing['jobs']) and
               1 <= listing['total_count'] <= 8, 'Paginated, incomplete or oversized job listing')
    jobs, identities = {}, set()
    for job in listing['jobs']:
        _c_require(type(job) is dict and job.get('name') in _C_OWNERS and job['name'] not in jobs and
                   type(job.get('id')) is int and job['id'] > 0 and job['id'] not in identities, 'Duplicate or unknown job owner')
        _c_require(type(job.get('run_id')) is int and job['run_id'] == expected['run_id'] and
                   type(job.get('run_attempt')) is int and job['run_attempt'] == expected['run_attempt'] and
                   job.get('head_sha') == expected['head_sha'] and job.get('head_branch') == '2026-10-03-album-tops' and
                   job.get('workflow_name') == 'Foobar Preview Backend Evidence (supplemental)' and
                   job.get('run_url') == base.split('/attempts/')[0] and
                   job.get('url') == 'https://api.github.com/repos/' + _C_REPOSITORY + '/actions/jobs/' + str(job['id']),
                   'Job is not bound to the exact observed attempt and workflow')
        jobs[job['name']] = job
        identities.add(job['id'])
    _c_require(expected['producer_job'] in jobs and jobs[expected['producer_job']]['status'] == 'in_progress',
               'Acquisition was not observed during its actual consumer job')
    consumer_started = _v_stamp(jobs[expected['producer_job']]['started_at'])
    _c_require(set(jobs) == set(_C_OWNERS) and jobs['reconcile'].get('conclusion') is None and
               jobs['reconcile'].get('completed_at') is None and consumer_started <= _v_stamp(records[0]['started_at']),
               'Missing owners or invalid current reconciliation interval')
    job = jobs['admission']
    _c_require(job.get('status') == 'completed' and job.get('conclusion') == 'failure', 'Initial admission was not a completed hold failure')
    start, finish, upper, _ = _c_interval(job)
    _c_require(finish <= consumer_started and finish <= _v_stamp(records[1]['started_at']) and upper <= 120,
               'Initial admission completion is missing, late or over budget')
    names = ['Set up job', _C_STAGE_NAMES['checkout'], _C_STAGE_NAMES['admission'],
             'Retain fresh original admission even on hold', 'Post ' + _C_STAGE_NAMES['checkout'], 'Complete job']
    steps = job.get('steps')
    _c_require(type(steps) is list and len(steps) == 6 and [step.get('name') for step in steps] == names,
               'Initial hold requires exactly all six source-known admission stages')
    numbers = [step.get('number') for step in steps]
    _c_require(all(type(number) is int and number > 0 for number in numbers) and numbers == sorted(set(numbers)),
               'Malformed held admission stage identities')
    previous, durations = None, {}
    for step in steps:
        wanted = 'failure' if step['name'] == _C_STAGE_NAMES['admission'] else 'success'
        _c_require(step.get('status') == 'completed' and step.get('conclusion') == wanted,
                   'Held admission has a contradictory, skipped or cancelled stage')
        left, right, duration, _ = _c_interval(step)
        _c_require((left - start).total_seconds() >= -1 and (right - finish).total_seconds() <= 1 and
                   (previous is None or previous <= left), 'Held stage timing escapes or overlaps its job')
        previous = right
        durations[step['name']] = duration
        if step['name'] == _C_STAGE_NAMES['admission']:
            observed = _v_stamp(admission['observed_at'])
            _c_require((observed - left).total_seconds() >= -1 and (observed - right).total_seconds() <= 1,
                       'Original held observation is outside its actual admission step')
    _c_require(durations[names[1]] + durations[names[4]] <= 120 and durations[names[2]] <= 120 and durations[names[3]] <= 60,
               'Held admission overhead exceeded its unchanged category bound')
    for owner in _C_OWNERS[1:-1]:
        skipped = jobs[owner]
        _c_require(skipped.get('status') == 'completed' and skipped.get('conclusion') == 'skipped' and
                   skipped.get('steps') == [], 'Downstream owner did not explicitly remain unexecuted')
        left, right = skipped.get('started_at'), skipped.get('completed_at')
        _c_require((left is None and right is None) or (type(left) is str and left == right),
                   'Skipped owner contradicts zero executed work')
        if left is not None:
            _c_require(finish <= _v_stamp(left) <= consumer_started, 'Skipped owner time contradicts dependency order')
    return retained


def _c_hold_transfer(temporary, expected):
    _c_require(os.environ.get('PREVIEW_TRANSFER_OUTCOME') == 'success', 'Initial hold transfer is unproven')
    transfer, _ = _v_directory(temporary / 'foobar-preview-transfer')
    names = set()
    wanted = {'transfer.json', 'acquisition.json', 'run-attempt.json', 'attempt-jobs.json', 'admission.zip'}
    with os.scandir(transfer) as entries:
        for entry in entries:
            _c_require(len(names) < 5 and entry.name in wanted and entry.name not in names,
                       'Held transfer contains an unexpected or interrupted writer')
            names.add(entry.name)
    _c_require(names == wanted, 'Held transfer is incomplete')
    raw = _c_bytes(_c_path(transfer, 'transfer.json'), 1048576)
    metadata = _c_json_bytes(raw)
    _c_require(set(metadata) == {'schema_version', 'repository', 'head_sha', 'workflow_path', 'run_id',
                               'run_attempt', 'cancelled', 'provenance', 'archives'} and
               metadata['schema_version'] == 'foobar-preview-transfer-v1', 'Malformed held transfer checkpoint')
    for key in ('repository', 'head_sha', 'workflow_path', 'run_id', 'run_attempt', 'cancelled', 'provenance'):
        _c_require(_v_same(metadata[key], expected[key]), 'Held transfer differs from current bound context')
    archives = metadata['archives']
    _c_require(type(archives) is list and len(archives) == 1, 'Held transfer must contain only the original admission archive')
    record = archives[0]
    _c_require(set(record) == {'producer_job', 'path', 'size', 'sha256'} and record['producer_job'] == 'admission' and
               record['path'] == 'admission.zip' and type(record['size']) is int and 0 < record['size'] <= _C_BYTES and
               _v_hex(record['sha256']), 'Invalid original admission archive binding')
    archive = _c_path(transfer, record['path'])
    before = archive.lstat()
    _c_require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size == record['size'], 'Unsafe admission archive')
    digest = hashlib.sha256()
    with archive.open('rb') as stream:
        _c_require(_v_stat_id(os.fstat(stream.fileno())) == _v_stat_id(before), 'Admission archive was replaced')
        remaining = before.st_size
        while remaining:
            chunk = stream.read(min(remaining, 65536))
            _c_require(chunk and len(chunk) <= remaining, 'Admission archive length changed')
            digest.update(chunk)
            remaining -= len(chunk)
        _c_require(stream.read(1) == b'' and _v_stat_id(os.fstat(stream.fileno())) == _v_stat_id(before), 'Admission archive changed while read')
    _c_require(digest.hexdigest() == record['sha256'], 'Admission archive digest differs from immutable transfer')
    inputs = temporary / 'foobar-preview-inputs'
    _c_require(not inputs.exists() and not inputs.is_symlink(), 'Held inputs must be fresh')
    inputs.mkdir()
    _c_decode_zip(archive, inputs / 'admission', _C_AGGREGATE - 4194304, _C_AGGREGATE_FILES - 4)
    _c_require(_v_stat_id(archive.lstat()) == _v_stat_id(before), 'Archive changed across bounded decoding')
    return raw


def _c_hold_prepare():
    # The lease is private to this terminal branch and this same runner. Ordinary
    # owners still use the unchanged one-field spent_seconds budget and reader.
    started = time.monotonic()
    with _c_deadline(120 - (time.monotonic() - started)):
        root = Path(__file__).resolve(strict=True).parents[2]
        temporary, _ = _v_directory(os.environ['RUNNER_TEMP'])
        budget_path = temporary / 'foobar-preview-verification-budget.json'
        _c_require(not budget_path.exists() and not budget_path.is_symlink(), 'Held verification lease already exists')
        metadata = _c_json(_c_path(temporary / 'foobar-preview-transfer', 'transfer.json'))
        plan, expected = _c_hold_context(root, metadata['provenance'])
        _c_require(os.environ.get('PREVIEW_TRANSFER_OUTCOME') == 'success' and not expected['cancelled'],
                   'No verification lease for failed transfer or cancellation')
        _c_write(temporary / 'foobar-preview-context.json', expected)
        spent = time.monotonic() - started
        _c_require(0 <= spent < 120, 'Held preparation exhausted aggregate verification')
        # The absolute deadline also charges this commit, interpreter exit and
        # the inter-step gap. No later reader resets it to now + remaining.
        # This is NOT a successful-prepare marker: even a later writer/readback
        # or interpreter failure leaves only this original absolute ceiling.
        _c_write(budget_path, {'spent_seconds': spent, 'deadline_monotonic': started + 120,
            'context_sha256': hashlib.sha256(_c_bytes(temporary / 'foobar-preview-context.json')).hexdigest()})


def _c_hold_main(args):
    # All this path's work is conservatively charged to finalize120, and proof
    # authentication is additionally bounded by the original prepare lease.
    # These are separate caps, not pooled allowance or a cleanup guarantee.
    final_started = time.monotonic()
    directory, expected, retained, pair = args.evidence_dir, None, {}, {}
    result = _v_hold_diagnostic(cancelled=os.environ.get('PREVIEW_CANCELLED') == 'true')
    try:
        with _c_deadline(120 - (time.monotonic() - final_started)):
            import resource
            resource.setrlimit(resource.RLIMIT_FSIZE, (_C_FILE, _C_FILE))
            _c_require(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('RUNNER_OS') == 'Linux' and
                       os.environ.get('GITHUB_REPOSITORY') == _C_REPOSITORY and os.environ.get('GITHUB_EVENT_NAME') == 'pull_request' and
                       os.environ.get('GITHUB_JOB') == 'reconcile' and os.environ.get('GITHUB_RUN_ATTEMPT') == '1',
                       'Initial diagnostic is confined to the hosted first-attempt reconcile owner')
            root = args.root.resolve(strict=True)
            _c_require(root == Path(__file__).resolve(strict=True).parents[2], 'Wrong held source root')
            temporary, _ = _v_directory(os.environ['RUNNER_TEMP'])
            _c_require(directory == temporary / 'foobar-preview-output' and not directory.exists() and not directory.is_symlink(),
                       'Held diagnostic output must be fresh, fixed and safely owned')
            inputs = temporary / 'foobar-preview-inputs'
            _c_require(args.phase == 'reconcile' and args.attempt == 1 and args.input_dir == inputs and
                       args.admission == inputs / 'admission/admission.json' and args.helper_evidence == inputs / 'helper' and
                       args.shard_index is args.canonical_core_evidence is args.predecessor_evidence is None and
                       args.plan.resolve(strict=True) == (root / _C_PLAN).resolve(strict=True), 'Unexpected held CLI paths or options')
            directory.mkdir()
            budget = None
            try:
                budget = _c_json(temporary / 'foobar-preview-verification-budget.json')
                _c_require(set(budget) == {'spent_seconds', 'deadline_monotonic', 'context_sha256'} and
                    all(type(budget[key]) in (int, float) and math.isfinite(budget[key]) for key in ('spent_seconds', 'deadline_monotonic')) and
                    0 <= budget['spent_seconds'] < 120 and _v_hex(budget['context_sha256']), 'Invalid held verification lease')
            except Exception:
                budget = None  # Unknown preparation spend: finalization only.
        # A committed valid lease can bound time even if prepare later failed;
        # it never proves that stage succeeded. Hosted completion stays external.
        if budget is not None:
            failure = ('deadline', '/verification', 'The original aggregate verification lease is malformed, expired or unproven.')
            try:
                now = time.monotonic()
                started = budget['deadline_monotonic'] - 120
                _c_require(0 <= started <= now and budget['spent_seconds'] <= now - started and
                           now < budget['deadline_monotonic'], 'Missing, reversed or expired held verification ownership')
                with _c_deadline(min(budget['deadline_monotonic'] - now, 120 - (now - final_started))):
                    failure = ('identity', '/context', 'Current held source, event or CLI identity cannot be independently bound.')
                    context_raw = _c_bytes(temporary / 'foobar-preview-context.json')
                    _c_require(hashlib.sha256(context_raw).hexdigest() == budget['context_sha256'], 'Held lease context binding changed')
                    stored = _c_json_bytes(context_raw)
                    plan, current = _c_hold_context(root, stored['provenance'])
                    _c_require(_v_same(current, stored), 'Held prepared source context changed')
                    _c_require((args.expected_head, args.run_id, args.attempt) ==
                               (current['head_sha'], current['run_id'], current['run_attempt']), 'Held CLI identity differs')
                    _v_need(not current['cancelled'], 'cancellation', '/expected/cancelled', 'Cancellation suppresses authentication.')
                    retained['transfer-context.json'] = context_raw
                    failure = ('missing_owner', '/transfer', 'Actual initial admission transfer or immutable archive binding is unproven.')
                    retained['transfer.json'] = _c_hold_transfer(temporary, current)
                    # Keep only bounded actual decoded bytes, never a replacement
                    # admission. Their retention is not authentication on failure.
                    for name in ('admission.json', 'admission-context.json'):
                        pair[name] = _c_bytes(_c_path(inputs / 'admission', name))
                    admission, verified_pair = _v_hold_pair(inputs, current)
                    _c_require(pair == verified_pair, 'Admission changed between retention and validation')
                    failure = ('admission', '/event', 'Original held trigger differs from the current raw event.')
                    event = _c_json(Path(os.environ['GITHUB_EVENT_PATH']))
                    pr, trigger = event['pull_request'], admission['trigger']
                    _c_require(event['repository']['full_name'] == _C_REPOSITORY and type(pr['number']) is int and
                               _v_same(trigger['number'], pr['number']) and _v_same(trigger['draft'], pr['draft']) and
                               _v_same(event['number'], pr['number']) and trigger['head_sha'] == pr['head']['sha'] and
                               trigger['branch'] == pr['head']['ref'] and pr['head']['repo']['full_name'] == _C_REPOSITORY,
                               'Original held trigger does not match current raw event')
                    labels = pr['labels']
                    _c_require(type(labels) is list and all(type(item) is dict and type(item.get('name')) is str for item in labels),
                               'Malformed current event labels')
                    _c_require(trigger['all_labels'] == sorted({item['name'].strip() for item in labels if item['name'].strip()}),
                               'Held trigger labels differ from current event')
                    failure = ('predecessor', '/completed-stages', 'Completed held-admission stages or explicitly skipped downstream owners remain unproven.')
                    _c_hold_jobs(plan, current, admission, retained)
                    failure = ('source_hash', '/source', 'Bound held source bytes changed before acceptance.')
                    _c_check_sources(root, current)
                    failure = ('deadline', '/verification', 'Aggregate held verification expired before acceptance.')
                    _c_require(time.monotonic() < budget['deadline_monotonic'], 'Held verification expired before acceptance')
                    expected = current
                    result = _v_hold_diagnostic()
                    result['errors'] = [_v_error(_v_Problem('missing_owner', '/admission',
                        'Authenticated original initial-attempt hold; all six dependent producers explicitly skipped. No execution is admitted.'), 'admission')]
                    for node in result['nodes']:
                        node.update(status='unrun', cause='initial_attempt_hold_owner_observed_skipped')
                    for entry in result['owners']:
                        entry['cause'] = ('authenticated_initial_attempt_hold' if entry['job_id'] == 'admission' else
                                          'final_completion_unproven' if entry['job_id'] == 'reconcile' else
                                          'initial_attempt_hold_owner_observed_skipped')
            except Exception as problem:
                expected = None
                if not isinstance(problem, _v_Problem):
                    problem = _v_Problem(*failure)
                result = _v_hold_diagnostic(problem, cancelled=os.environ.get('PREVIEW_CANCELLED') == 'true')
        remaining = 120 - (time.monotonic() - final_started)
        with _c_deadline(remaining):
            for name, raw in pair.items():
                _c_write(directory / 'admission' / name, raw)
            for name, raw in retained.items():
                _c_write(directory / ('transfer-context.json' if name == 'transfer-context.json' else 'completed-stages/' + name), raw)
            _c_write(directory / 'reconciliation.json', result)
            if expected is not None:
                _c_write(directory / 'completion.json', {'schema_version': 'foobar-preview-final-v1', 'completion': 'unproven',
                    'repository': expected['repository'], 'head_sha': expected['head_sha'], 'run_id': expected['run_id'],
                    'run_attempt': expected['run_attempt'], 'reconciliation_sha256': hashlib.sha256(_c_bytes(directory / 'reconciliation.json')).hexdigest()})
            wanted = {'reconciliation.json', *('admission/' + name for name in pair),
                      *('transfer-context.json' if name == 'transfer-context.json' else 'completed-stages/' + name for name in retained)}
            if expected is not None:
                wanted.add('completion.json')
            reader = _v_Reader(directory)
            found, folders = _v_scan(reader)
            _c_require(set(found) == wanted and folders == {name.split('/')[0] for name in wanted if '/' in name} and
                       len(found) + 2 <= _C_FILES and sum(info.st_size for info in found.values()) + 2 * _C_FILE <= _C_BYTES,
                       'Diagnostic writer set or aggregate reserve is uncertain')
            inventory = []
            for relative in sorted(wanted):
                _, digest, size = reader.read(relative, keep=False)
                inventory.append({'path': relative, 'size': size, 'sha256': digest})
            reader.check_unchanged()
            _c_write(directory / 'final-inventory.json', {'schema_version': 'foobar-preview-final-inventory-v1', 'files': inventory})
            _c_write(directory / 'final-complete.json', {'schema_version': 'foobar-preview-final-complete-v1',
                'writer_complete': True, 'upload_completion': 'unproven',
                'inventory_sha256': hashlib.sha256(_c_bytes(directory / 'final-inventory.json')).hexdigest()})
            for parent in [*(directory / name for name in sorted(folders)), directory]:
                descriptor = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
            _c_require(time.monotonic() - final_started < 120, 'Held finalization exceeded its absolute allowance')
            _c_output('continue_allowed', 'false')
    except Exception:
        # Never start another finalization allowance or manufacture a complete
        # marker after unsafe ownership, a deadline, or a failed writer.
        return 1
    return 1


def _workflow_prepare():
    if os.environ.get('GITHUB_JOB') == 'reconcile' and os.environ.get('GITHUB_RUN_ATTEMPT') == '1':
        return _c_hold_prepare()
    verification_started = time.monotonic()
    # This runs in a single bounded verification step before dependency setup.
    with _c_deadline(120):
        root = Path(__file__).resolve(strict=True).parents[2]
        temporary = Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
        transfer = temporary / 'foobar-preview-transfer'
        metadata = _c_json(_c_path(transfer, 'transfer.json'))
        _c_require(set(metadata) == {'schema_version', 'repository', 'head_sha', 'workflow_path', 'run_id',
                   'run_attempt', 'cancelled', 'provenance', 'archives'}, 'Unexpected transfer metadata')
        _c_require(metadata['schema_version'] == 'foobar-preview-transfer-v1', 'Wrong transfer schema')
        plan, expected = _c_context(root, os.environ['GITHUB_JOB'], metadata['provenance'])
        for key in ('repository', 'head_sha', 'workflow_path', 'run_id', 'run_attempt', 'cancelled'):
            _c_require(type(metadata[key]) is type(expected[key]) and metadata[key] == expected[key], 'Transfer context changed')
        owners = _C_OWNERS[:_C_OWNERS.index(expected['producer_job'])]
        _c_require(type(metadata['archives']) is list and len(metadata['archives']) <= len(owners), 'Invalid transfer count')
        inputs = temporary / 'foobar-preview-inputs'
        _c_require(not inputs.exists(), 'Inputs are not fresh')
        inputs.mkdir()
        used_bytes = sum(len(_c_bytes(_c_path(transfer, name), 1048576)) for name in
                         ('acquisition.json', 'run-attempt.json', 'attempt-jobs.json', 'transfer.json'))
        used_files, seen = 4, set()
        for record in metadata['archives']:
            _c_require(set(record) == {'producer_job', 'path', 'size', 'sha256'}, 'Wrong archive record')
            owner = record['producer_job']
            _c_require(owner in owners and owner not in seen and record['path'] == owner + '.zip', 'Wrong archive owner')
            seen.add(owner)
            path = _c_path(transfer, record['path'])
            _c_require(type(record['size']) is int and 0 < record['size'] <= _C_BYTES and path.stat().st_size == record['size'], 'Encoded archive bound')
            digest = hashlib.sha256()
            with path.open('rb') as stream:
                remaining = record['size']
                while remaining:
                    data = stream.read(min(remaining, 65536))
                    _c_require(data and len(data) <= remaining, 'Archive size changed')
                    digest.update(data)
                    remaining -= len(data)
            _c_require(digest.hexdigest() == record['sha256'], 'Transfer digest changed')
            size, count = _c_decode_zip(path, inputs / owner, _C_AGGREGATE - used_bytes, _C_AGGREGATE_FILES - used_files)
            used_bytes += size
            used_files += count
        _c_require(seen == {item['producer_job'] for item in expected['provenance']}, 'Untransferred provenance')
        _c_write(temporary / 'foobar-preview-context.json', expected)
        _preflight_from_environment(root, root / _C_PLAN, expected['producer_job'], inputs)
        spent = time.monotonic() - verification_started
        _c_require(0 <= spent < 120, 'Aggregate verification budget exhausted')
        _c_write(temporary / 'foobar-preview-verification-budget.json', {'spent_seconds': spent})


def _preflight_from_environment(root, plan_path, owner, input_dir):
    context_path = Path(os.environ['RUNNER_TEMP']) / 'foobar-preview-context.json'
    stored = _c_json(context_path)
    plan, expected = _c_context(Path(root), owner, stored['provenance'])
    _c_require(stored == expected and Path(plan_path).resolve() == (Path(root) / _C_PLAN).resolve(), 'Prepared context changed')
    directories = {job: Path(input_dir) / job for job in _C_OWNERS[:-1] if (Path(input_dir) / job).exists()}
    if owner == 'reconcile':
        return plan, expected, _c_completed_stages(plan, expected, directories)
    _v_admission(_v_Reader(directories['admission']), expected)
    if owner != 'helper':
        upstream = {**expected, 'producer_job': 'helper'}
        assessment = validate_artifact(directories['helper'], plan=plan, expected=upstream, inputs={'admission': directories['admission']})
        _c_require(assessment['status'] == 'passed', 'Full helper proof did not pass')
    if owner.startswith('resource_'):
        predecessor = 'core' if owner == 'resource_1' else 'resource_' + str(int(owner[-1]) - 1)
        ancestors = {key: value for key, value in directories.items() if key != predecessor}
        assessment = validate_artifact(directories[predecessor], plan=plan, expected={**expected, 'producer_job': predecessor}, inputs=ancestors)
        _c_require(assessment['continue_allowed'], 'Raw predecessor proof holds execution')
    return plan, expected, _c_completed_stages(plan, expected, directories)


def _c_replace_owned(path, value):
    # Only a producer-owned incremental report may be replaced. An interrupted
    # temporary file is retained and invalidates the complete writer marker.
    data = (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()
    _c_require(len(data) < _C_FILE, 'Report storage ceiling')
    temporary = path.with_name(path.name + '.writing')
    with temporary.open('xb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


class _PreviewCapture:
    def __init__(self, path, collect):
        self.path = path
        self.collect = collect
        self.data = ({'schema_version': 1, 'discovered_nodeids': [], 'nodeids': [],
                      'deselected_nodeids': [], 'collection_errors': []} if collect else
                     {'schema_version': 1, 'reports': []})
        _c_replace_owned(self.path, self.data)

    def pytest_collection_modifyitems(self, session, config, items):
        if self.collect:
            _c_require(len(items) <= 20000, 'Collection recording bound')
            self.data['discovered_nodeids'] = [item.nodeid for item in items]
        yield
        if self.collect:
            _c_require(len(items) <= 20000, 'Collection recording bound')
            self.data['nodeids'] = [item.nodeid for item in items]
            _c_replace_owned(self.path, self.data)

    def pytest_deselected(self, items):
        if self.collect:
            _c_require(len(self.data['deselected_nodeids']) + len(items) <= 20000, 'Deselection recording bound')
            self.data['deselected_nodeids'].extend(item.nodeid for item in items)
            _c_replace_owned(self.path, self.data)

    def pytest_collectreport(self, report):
        if self.collect and not report.passed:
            _c_require(len(self.data['collection_errors']) < 20000, 'Collection error bound')
            self.data['collection_errors'].append({'nodeid': report.nodeid,
                'outcome': 'skipped' if report.skipped else 'failed', 'longrepr': str(report.longrepr)})
            _c_replace_owned(self.path, self.data)

    def pytest_runtest_logreport(self, report):
        if not self.collect:
            _c_require(len(self.data['reports']) < 60000, 'Runtime phase recording bound')
            self.data['reports'].append({'nodeid': report.nodeid, 'when': report.when,
                'outcome': report.outcome, 'wasxfail': getattr(report, 'wasxfail', None)})
            _c_replace_owned(self.path, self.data)


def _child_entry(root, request_path, selectors):
    root = Path(root).resolve(strict=True)
    request_path = Path(request_path)
    directory = Path(os.environ['RUNNER_TEMP']).resolve(strict=True) / 'foobar-preview-output'
    _c_require(request_path.resolve(strict=True).is_relative_to(directory), 'Child request escaped evidence')
    request = _c_json(request_path)
    _c_require(set(request) == {'schema_version', 'mode', 'phase', 'expected', 'selection',
               'collection_path', 'reports_path', 'junit_path'}, 'Unexpected child request')
    _c_require(request['schema_version'] == 'foobar-preview-child-v1' and request['selection'] == list(selectors), 'Child selection changed')
    _c_require(os.environ.get('PYTEST_DISABLE_PLUGIN_AUTOLOAD') == '1', 'External pytest plugins forbidden')
    plan, expected = _c_context(root, os.environ['GITHUB_JOB'], request['expected']['provenance'])
    _c_require(expected == request['expected'], 'Child source/context changed')
    _c_check_sources(root, expected)
    phase, mode = request['phase'], request['mode']
    allowed = plan['helper_selectors'] if phase == 'helper' else plan['selectors']
    _c_require(phase in ('helper', 'core', 'resource') and mode in ('collect', 'run'), 'Unknown child routing')
    if mode == 'collect':
        _c_require(selectors == allowed, 'Collection must own both whole modules')
    else:
        collection = _c_json(_c_path(directory, request['collection_path']))
        _c_require(collection['collection_errors'] == [] and collection['deselected_nodeids'] == [] and
                   collection['nodeids'] == collection['discovered_nodeids'], 'Invalid canonical collection')
        nodes = collection['nodeids']
        if phase == 'helper':
            _c_require(selectors == nodes, 'Helper must own its entire collection')
        elif phase == 'core':
            _c_require(selectors == nodes[:380] and nodes[380:] == plan['resource_ids'], 'Core must own whole collection')
        else:
            index = int(os.environ['GITHUB_JOB'][-1])
            _c_require(len(selectors) == 1 and selectors[0] in plan['shards'][index-1]['assigned_ids'], 'Resource singleton escaped shard')
    # No product initialization is reachable in the helper lane.
    if phase != 'helper':
        _c_require(not any(name == 'music_app' or name.startswith('music_app.') for name in sys.modules), 'Preexisting product modules')
        for name, relative in (('music_app', 'music_app'), ('music_app.services', 'music_app/services')):
            package = types.ModuleType(name)
            package.__path__ = [str(root / relative)]
            package.__package__ = name
            package.__spec__ = importlib.machinery.ModuleSpec(name, loader=None, is_package=True)
            package.__spec__.submodule_search_locations = package.__path__
            sys.modules[name] = package
        setattr(sys.modules['music_app'], 'services', sys.modules['music_app.services'])
        for name, relative in (('music_app.services.foobar_snapshot_parser', _C_PRODUCTS[0]),
                               ('music_app.services.foobar_snapshot_preview', _C_PRODUCTS[1])):
            path = _c_path(root, relative)
            data = _c_bytes(path)
            _c_require(hashlib.sha256(data).hexdigest() == expected['source_hashes'][relative], 'Product source changed')
            specification = importlib.util.spec_from_file_location(name, path, loader=_HashBoundLoader(name, path, data))
            _c_require(specification is not None and specification.loader is not None, 'Cannot load admitted source')
            module = importlib.util.module_from_spec(specification)
            _c_require(Path(module.__file__) == path, 'Loader must retain actual source path')
            sys.modules[name] = module
            specification.loader.exec_module(module)
            setattr(sys.modules['music_app.services'], name.rsplit('.', 1)[-1], module)
    sys.path.insert(0, str(root))
    import pytest
    _PreviewCapture.pytest_collection_modifyitems = pytest.hookimpl(hookwrapper=True, tryfirst=True)(
        _PreviewCapture.pytest_collection_modifyitems)
    reports = directory / request['reports_path']
    _c_require(reports.resolve().is_relative_to(directory) and not reports.exists(), 'Report path must be fresh')
    reports.parent.mkdir(parents=True, exist_ok=True)
    capture = _PreviewCapture(reports, mode == 'collect')
    argv = ['-q', '--tb=short', '-o', 'faulthandler_timeout=60', '--noconftest', '--import-mode=importlib', '-p', 'no:cacheprovider']
    if mode == 'collect':
        argv.append('--collect-only')
    else:
        junit = directory / request['junit_path']
        _c_require(junit.resolve().is_relative_to(directory) and not junit.exists(), 'JUnit must be fresh')
        argv.extend(['-vv', '--durations=20', '--junitxml=' + str(junit)])
    argv.extend(selectors)
    return int(pytest.main(argv, plugins=[capture]))


def _c_inventory_files(directory):
    files, total = [], 0
    pending = [Path(directory)]
    while pending:
        parent = pending.pop()
        for path in sorted(parent.iterdir()):
            info = path.lstat()
            _c_require(not stat.S_ISLNK(info.st_mode), 'Producer link forbidden')
            if stat.S_ISDIR(info.st_mode):
                pending.append(path)
                _c_require(len(pending) <= _C_FILES, 'Producer directory bound')
                continue
            _c_require(stat.S_ISREG(info.st_mode) and info.st_size < _C_FILE, 'Producer file ceiling or special file')
            relative = path.relative_to(directory).as_posix()
            _c_require(not relative.endswith('.writing'), 'Interrupted writer remains')
            total += info.st_size
            files.append((relative, info.st_size))
            _c_require(len(files) <= _C_FILES and total <= _C_BYTES, 'Producer artifact storage ceiling')
    return sorted(files), total


def _c_reserve(directory, count):
    files, total = _c_inventory_files(directory)
    _c_require(total + count * _C_FILE + 2097152 < _C_BYTES and len(files) + count + 8 < _C_FILES,
               'Insufficient bounded evidence reserve; remaining execution held')


def _c_run(root, expected, directory, identity, argv, seconds, verification):
    start = time.monotonic()
    _c_require(verification[0] < 120, 'Aggregate source verification exhausted')
    with _c_deadline(120 - verification[0]):
        _c_check_sources(root, expected)
    verification[0] += time.monotonic() - start
    path = directory / (identity + '.log')
    path.parent.mkdir(parents=True, exist_ok=True)
    result = _legacy_helper().run_owned(argv, cwd=root, env=dict(os.environ), log_path=path,
                                       timeout_seconds=seconds, terminate_grace_seconds=30)
    record = {'id': identity, **result, 'raw_log': identity + '.log',
              'limits': {'runtime_seconds': seconds, 'term_seconds': 30, 'kill_reap_seconds': 30},
              'supervisor_sha256': _C_OLD_SHA}
    _c_write(directory / (identity + '.process.json'), record)
    _c_require(path.stat().st_size < _C_FILE, 'Log reached storage bound; cannot certify complete output')
    return record


def _c_copy(source, destination):
    _c_write(destination, _c_bytes(source))


def _c_seal(directory, receipt):
    _c_write(directory / 'receipt.json', receipt)
    files, total = _c_inventory_files(directory)
    inventory = {'schema_version': 'foobar-preview-inventory-v1', 'files': [
        {'path': relative, 'size': size, 'sha256': hashlib.sha256(_c_bytes(directory / relative)).hexdigest()}
        for relative, size in files]}
    _c_write(directory / 'inventory.json', inventory)
    _c_write(directory / 'complete.json', {'schema_version': 'foobar-preview-complete-v1', 'writer_complete': True,
        'inventory_sha256': hashlib.sha256(_c_bytes(directory / 'inventory.json')).hexdigest(),
        'receipt_sha256': hashlib.sha256(_c_bytes(directory / 'receipt.json')).hexdigest()})
    _c_inventory_files(directory)
    _c_sync_tree(directory)


def _c_sync_tree(directory):
    files, _ = _c_inventory_files(directory)
    parents = {Path(directory)}
    for relative, _ in files:
        parent = (Path(directory) / relative).parent
        while parent != Path(directory):
            parents.add(parent)
            parent = parent.parent
    for parent in sorted(parents, key=lambda path: len(path.parts), reverse=True):
        descriptor = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def _c_collect(root, plan, expected, phase, directory, verification):
    selectors = plan['helper_selectors'] if phase == 'helper' else plan['selectors']
    prefix = 'preview/collection' if phase == 'helper' else 'collection'
    request = {'schema_version': 'foobar-preview-child-v1', 'mode': 'collect', 'phase': phase,
               'expected': expected, 'selection': selectors, 'collection_path': None,
               'reports_path': prefix + '.json', 'junit_path': None}
    path = directory / (prefix + '.request.json')
    _c_write(path, request)
    _c_reserve(directory, 2)
    argv = [sys.executable, '-c', _CHILD_PROGRAM, str(root), str(path), *selectors]
    process = _c_run(root, expected, directory, prefix, argv, 60 if phase == 'helper' else 300, verification)
    _legacy_helper().process_success(process)
    data = _c_json(_c_path(directory, prefix + '.json'))
    nodes = data['nodeids']
    _legacy_helper().node_list(nodes)
    _c_require(data['discovered_nodeids'] == nodes and data['deselected_nodeids'] == data['collection_errors'] == [], 'Whole collection failed')
    _c_require({n.split('::', 1)[0] for n in nodes} == set(selectors), 'Collection module ownership failed')
    if phase != 'helper':
        _c_require(len(nodes) == 416 and all(n.startswith(selectors[0] + '::') for n in nodes[:380]) and
                   nodes[380:] == plan['resource_ids'], 'Frozen preview collection mismatch')
    record = {'path': prefix + '.json', 'sha256': hashlib.sha256(_c_bytes(directory / (prefix + '.json'))).hexdigest(),
              'selectors': selectors, 'process': process}
    return record, data


def _c_execute(root, expected, phase, directory, collection, groups, seconds, verification):
    invocations, assessments = [], []
    for index, selected in enumerate(groups):
        prefix = 'preview/run' if phase == 'helper' else 'core' if phase == 'core' else 'resource-' + str(index)
        request = {'schema_version': 'foobar-preview-child-v1', 'mode': 'run', 'phase': phase,
                   'expected': expected, 'selection': selected, 'collection_path': collection['path'],
                   'reports_path': prefix + '.json', 'junit_path': prefix + '.xml'}
        path = directory / (prefix + '.request.json')
        _c_reserve(directory, 3)
        _c_write(path, request)
        argv = [sys.executable, '-c', _CHILD_PROGRAM, str(root), str(path), *selected]
        invocation = _c_run(root, expected, directory, prefix, argv, seconds, verification)
        invocation.update(selected_nodeids=selected, reports_json=prefix + '.json',
                          junit_xml=prefix + '.xml' if (directory / (prefix + '.xml')).exists() else None)
        invocations.append(invocation)
        assessment = validate_invocation(directory, invocation, assigned_ids=selected, owner=expected['producer_job'])
        assessments.append(assessment)
        if not assessment['continue_allowed'] or phase == 'helper' and assessment['status'] != 'passed':
            break
    return invocations, assessments


def _c_legacy(directory, expected):
    source = Path(os.environ.get('PREVIEW_LEGACY_DIR', str(Path(os.environ['RUNNER_TEMP']) / 'foobar-preview-legacy')))
    _c_require(source.resolve().parent == Path(os.environ['RUNNER_TEMP']).resolve(), 'Legacy evidence escaped temporary root')
    files, _ = _c_inventory_files(source)
    retained, total = _c_inventory_files(directory)
    count = len(retained)
    for relative, size in files:
        _c_require(total + size + 2097152 < _C_BYTES and count + 8 < _C_FILES, 'Legacy copy exceeds artifact reserve')
        _c_copy(_c_path(source, relative), directory / 'legacy' / relative)
        total += size
        count += 1
    identity = _c_json(directory / 'legacy/identity.json')
    collection = _c_json(directory / 'legacy/collection.json')
    invocations = _c_json(directory / 'legacy/invocations.json')
    _c_require(len(invocations) == 1, 'Legacy helper must execute its complete pair once')
    limits = {'term_seconds': 30, 'kill_reap_seconds': 30}
    def process(raw, identity, log, seconds):
        return {'id': identity, **{key: raw[key] for key in ('argv', 'started_at', 'finished_at', 'exit_code',
                'timed_out', 'cleanup_complete', 'writer_errors', 'cancelled')}, 'raw_log': 'legacy/' + log,
                'limits': {**limits, 'runtime_seconds': seconds}, 'supervisor_sha256': _C_OLD_SHA}
    old = invocations[0]
    runtime = process(old, 'legacy/' + old['id'], old['raw_log'], 180)
    runtime.update(selected_nodeids=old['selected_nodeids'], reports_json='legacy/' + old['reports_json'],
                   junit_xml='legacy/' + old['junit_xml'])
    proof = {'selectors': identity['selectors'], 'identity_path': 'legacy/identity.json',
             'collection': {'path': 'legacy/collection.json',
                 'sha256': hashlib.sha256(_c_bytes(directory / 'legacy/collection.json')).hexdigest(),
                 'selectors': identity['selectors'], 'process': process(collection, 'legacy/collection', 'collection.log', 60)},
             'invocation': runtime}
    git = process(_c_json(directory / 'legacy/checkout-process.json'), 'legacy/checkout', 'checkout.log', 10)
    return proof, git


def _c_status(assessments):
    statuses = [item['status'] for item in assessments]
    unsafe = [status for status in statuses if status not in ('passed', 'assertion_failed', 'timed_out_safe')]
    return unsafe[0] if unsafe else 'assertion_failed' if 'assertion_failed' in statuses else 'timed_out_safe' if 'timed_out_safe' in statuses else 'passed'


def _c_output(name, value):
    path = Path(os.environ['GITHUB_OUTPUT'])
    _c_require(name == 'continue_allowed' and value in ('true', 'false'), 'Unexpected workflow output')
    with path.open('a', encoding='utf-8') as stream:
        stream.write(name + '=' + value + '\n')
        stream.flush()
        os.fsync(stream.fileno())


def _main():
    parser = argparse.ArgumentParser()
    parser.add_argument('phase', choices=('helper', 'core', 'resource', 'reconcile'))
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--plan', required=True, type=Path)
    parser.add_argument('--admission', required=True, type=Path)
    parser.add_argument('--evidence-dir', required=True, type=Path)
    parser.add_argument('--expected-head', required=True)
    parser.add_argument('--run-id', required=True, type=int)
    parser.add_argument('--attempt', required=True, type=int)
    parser.add_argument('--helper-evidence', type=Path)
    parser.add_argument('--shard-index', type=int)
    parser.add_argument('--canonical-core-evidence', type=Path)
    parser.add_argument('--predecessor-evidence', type=Path)
    parser.add_argument('--input-dir', type=Path)
    args = parser.parse_args()
    directory = args.evidence_dir
    if args.phase == 'reconcile' and args.attempt == 1:
        return _c_hold_main(args)
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_FSIZE, (_C_FILE, _C_FILE))
        root = args.root.resolve(strict=True)
        _c_require(root == Path(__file__).resolve(strict=True).parents[2], 'Wrong actual source root')
        temporary = Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
        _c_require(directory == temporary / 'foobar-preview-output' and not directory.exists(), 'Evidence must be fresh and fixed')
        owner = 'resource_' + str(args.shard_index) if args.phase == 'resource' else args.phase
        inputs = temporary / 'foobar-preview-inputs'
        budget = _c_json(temporary / 'foobar-preview-verification-budget.json')
        _c_require(set(budget) == {'spent_seconds'} and type(budget['spent_seconds']) in (int, float) and
                   0 <= budget['spent_seconds'] < 120, 'Invalid aggregate verification budget')
        verification = [budget['spent_seconds']]
        verification_started = time.monotonic()
        with _c_deadline(120 - verification[0]):
            plan, expected, completed_stages = _preflight_from_environment(root, args.plan, owner, inputs)
        verification[0] += time.monotonic() - verification_started
        _c_require((args.expected_head, args.run_id, args.attempt) ==
                   (expected['head_sha'], expected['run_id'], expected['run_attempt']), 'CLI context disagrees')
        _c_require(args.admission == inputs / 'admission' / 'admission.json', 'Wrong admission path')
        _c_require((args.helper_evidence == inputs / 'helper') if args.phase != 'helper' else args.helper_evidence is None, 'Wrong helper option')
        if args.phase == 'resource':
            _c_require(args.shard_index in (1, 2, 3, 4) and args.canonical_core_evidence == inputs / 'core' and
                       args.predecessor_evidence == inputs / ('core' if args.shard_index == 1 else 'resource_' + str(args.shard_index - 1)) and
                       args.input_dir is None, 'Wrong shard controls')
        else:
            _c_require(args.shard_index is args.canonical_core_evidence is args.predecessor_evidence is None, 'Unexpected resource options')
        _c_require(args.input_dir == inputs if args.phase == 'reconcile' else args.input_dir is None, 'Wrong reconcile input')
        directory.mkdir(parents=True, exist_ok=False)
        _c_write(directory / 'transfer-context.json', expected)
        for name in ('acquisition.json', 'run-attempt.json', 'attempt-jobs.json'):
            _c_copy(_c_path(temporary / 'foobar-preview-transfer', name), directory / 'completed-stages' / name)
        _c_write(directory / 'completed-stages/assessment.json', completed_stages)
        git = _c_run(root, expected, directory, 'git', ['git', 'rev-parse', 'HEAD'], 10, verification)
        _legacy_helper().process_success(git)
        _c_require(_c_bytes(directory / 'git.log').decode('utf-8').strip() == expected['head_sha'], 'Owned git head mismatch')
        if args.phase == 'reconcile':
            with _c_deadline(120):
                result = reconcile_artifacts(inputs, plan=plan, expected=expected)
                if completed_stages['holds']:
                    result['status'], result['observed_ids'] = 'incomplete', []
                    for node in result['nodes']:
                        node.update(status='unknown', cause='completed_stage_unproven')
                    held = {item['producer_job'] for item in completed_stages['holds']}
                    for entry in result['owners']:
                        if entry['job_id'] in held or entry['job_id'] == 'reconcile':
                            entry.update(status='incomplete', completion='unproven' if entry['job_id'] == 'reconcile' else 'incomplete', cause='completed_stage_unproven')
                    result['errors'].extend(_v_error(_v_Problem('deadline', '/completed-stages/' + owner,
                        'Completed producer timing or raw prerequisite proof remains unproven.'), owner) for owner in sorted(held))
                _c_write(directory / 'git-operation.json', git)
                _c_write(directory / 'reconciliation.json', result)
                # No local summary claims its own future upload completed.
                _c_write(directory / 'completion.json', {'schema_version': 'foobar-preview-final-v1',
                    'completion': 'unproven', 'repository': expected['repository'], 'head_sha': expected['head_sha'],
                    'run_id': expected['run_id'], 'run_attempt': expected['run_attempt'],
                    'reconciliation_sha256': hashlib.sha256(_c_bytes(directory / 'reconciliation.json')).hexdigest()})
                files, _ = _c_inventory_files(directory)
                _c_write(directory / 'final-inventory.json', {'schema_version': 'foobar-preview-final-inventory-v1',
                    'files': [{'path': relative, 'size': size, 'sha256': hashlib.sha256(_c_bytes(directory / relative)).hexdigest()}
                              for relative, size in files]})
                _c_write(directory / 'final-complete.json', {'schema_version': 'foobar-preview-final-complete-v1',
                    'writer_complete': True, 'upload_completion': 'unproven',
                    'inventory_sha256': hashlib.sha256(_c_bytes(directory / 'final-inventory.json')).hexdigest()})
                _c_sync_tree(directory)
            return 0 if result['status'] == 'passed' else 1
        for name in ('admission.json', 'admission-context.json'):
            _c_copy(_c_path(inputs / 'admission', name), directory / 'admission' / name)
        legacy_proof, legacy_git = None, None
        if args.phase == 'helper':
            legacy_proof, legacy_git = _c_legacy(directory, expected)
            _c_require(os.environ.get('PREVIEW_LEGACY_OUTCOME') == 'success', 'Legacy helper job step did not pass')
            verification_started = time.monotonic()
            with _c_deadline(120 - verification[0]):
                _v_legacy_gate(_v_Reader(directory), legacy_proof, expected, legacy_git)
            verification[0] += time.monotonic() - verification_started
        collection, data = _c_collect(root, plan, expected, args.phase, directory, verification)
        nodes = data['nodeids']
        if args.phase == 'resource':
            canonical = _c_json(inputs / 'core/receipt.json')['collection']['path']
            _c_require(_c_bytes(directory / collection['path']) == _c_bytes(_c_path(inputs / 'core', canonical)), 'Full collection differs from canonical core')
        assigned = nodes if args.phase == 'helper' else nodes[:380] if args.phase == 'core' else plan['shards'][args.shard_index-1]['assigned_ids']
        groups = [[node] for node in assigned] if args.phase == 'resource' else [assigned]
        invocations, assessments = _c_execute(root, expected, args.phase, directory, collection, groups,
            180 if args.phase == 'helper' else 600 if args.phase == 'core' else 300, verification)
        with _c_deadline(120):
            helper_proofs = None
            git_operations = [git]
            if args.phase == 'helper':
                legacy = legacy_proof
                git_operations = [legacy_git, git]
                _c_write(directory / 'preview/identity.json', {'schema_version': 1, 'lane': 'foobar-preview-helper',
                    'repository': expected['repository'], 'head_sha': expected['head_sha'], 'checkout_head': expected['checkout_head'],
                    'run_id': expected['run_id'], 'run_attempt': expected['run_attempt'], 'selectors': plan['helper_selectors'],
                    'source_hashes': {path: expected['source_hashes'][path] for path in _C_CONTROLS},
                    'admission_sha256': hashlib.sha256(_c_bytes(directory / 'admission/admission.json')).hexdigest()})
                helper_proofs = {'legacy': legacy, 'preview': {'selectors': plan['helper_selectors'],
                    'identity_path': 'preview/identity.json', 'collection': collection, 'invocation': invocations[0]}}
            digest = lambda owner: hashlib.sha256(_c_bytes(inputs / owner / 'receipt.json')).hexdigest()
            receipt = {'schema_version': 'foobar-preview-evidence-v1', 'lane': 'foobar-preview', 'phase': args.phase,
                **{key: expected[key] for key in ('repository', 'plan_sha256', 'head_sha', 'workflow_path', 'workflow_sha256', 'run_id', 'run_attempt')},
                'job_id': owner, 'artifact_name': 'preview-v1-' + expected['head_sha'] + '-' + str(expected['run_id']) + '-' + str(expected['run_attempt']) + '-' + owner,
                'admission_sha256': hashlib.sha256(_c_bytes(directory / 'admission/admission.json')).hexdigest(),
                'helper_receipt_sha256': None if args.phase == 'helper' else digest('helper'),
                'canonical_core_sha256': digest('core') if args.phase == 'resource' else None,
                'predecessor_receipt_sha256': digest('core' if args.shard_index == 1 else 'resource_' + str(args.shard_index-1)) if args.phase == 'resource' else None,
                'source_hashes': {path: expected['source_hashes'][path] for path in (_C_CONTROLS if args.phase == 'helper' else (*_C_CONTROLS, *_C_PRODUCTS))},
                'selectors': collection['selectors'], 'collection_sha256': collection['sha256'], 'full_discovered_ids': data['discovered_nodeids'],
                'full_final_ids': nodes, 'collection_errors': data['collection_errors'], 'deselected_ids': data['deselected_nodeids'],
                'shard_index': args.shard_index, 'shard_count': 4, 'assigned_ids': assigned, 'invocation_ids': [item['id'] for item in invocations],
                'invocations': invocations, 'collection': collection, 'helper_proofs': helper_proofs, 'git_operations': git_operations,
                'claimed_status': _c_status(assessments)}
            _c_seal(directory, receipt)
            # Local raw-kernel checks are provisional, never fabricated upload provenance.
            directories = {job: inputs / job for job in _C_OWNERS[:-1] if (inputs / job).exists()}
            directories[owner] = directory
            context = _v_Context(plan, expected, directories, local_producer=owner)
            assessment = _v_artifact(context, owner)
            context.finish()
            allowed = assessment['continue_allowed'] and (args.phase != 'helper' or assessment['status'] == 'passed')
            _c_output('continue_allowed', 'true' if allowed else 'false')
            return 0 if assessment['status'] == 'passed' else 1
    except Exception as error:
        # No complete marker is manufactured for missing or uncertain proof.
        if directory.is_dir() and not (directory / 'failure.json').exists():
            _c_write(directory / 'failure.json', {'schema_version': 'foobar-preview-failure-v1', 'status': 'incomplete',
                'cause': type(error).__name__, 'continue_allowed': False})
        _c_output('continue_allowed', 'false')
        return 1


# Read-only validation kernels. The orchestrator supplies _legacy_helper(),
# which imports only the admitted, unchanged supervisor from its real path.
import hashlib as _v_hashlib
import json as _v_json
import math as _v_math
import os as _v_os
import re as _v_re
import stat as _v_stat
from datetime import datetime as _v_datetime
from pathlib import Path as _v_Path
import xml.etree.ElementTree as _v_ET

_v_REPO = 'idanilovqa/AlbumHaven'
_v_WORKFLOW = '.github/workflows/foobar-preview-backend-evidence.yml'
_v_OLD = 'scripts/ci/new_feature_evidence.py'
_v_ADMIT = 'scripts/ci/admit-new-feature-evidence.py'
_v_ADAPTER = 'scripts/ci/foobar_preview_evidence.py'
_v_PLAN = 'scripts/ci/foobar_preview_plan.json'
_v_SUPERVISOR = '8f45a3c1c3ada77a817928463527fb4add58f57f70a2d3f24cc9187cf5fb3673'
_v_CORE = 'tests/py/test_foobar_snapshot_preview.py'
_v_RESOURCE = 'tests/py/test_foobar_snapshot_preview_resources.py'
_v_SELECTORS = [_v_CORE, _v_RESOURCE]
_v_LEGACY = ['tests/py/test_new_feature_ci_contract.py', 'tests/py/test_new_feature_evidence.py']
_v_HELPER = ['tests/py/test_foobar_preview_ci_contract.py', 'tests/py/test_foobar_preview_evidence.py']
_v_CONTROLS = [_v_WORKFLOW, '.github/workflows/new-feature-backend-evidence.yml', _v_ADMIT, _v_OLD, _v_ADAPTER, _v_PLAN, *_v_LEGACY, *_v_HELPER]
_v_PRODUCTS = ['music_app/services/foobar_snapshot_parser.py', 'music_app/services/foobar_snapshot_preview.py', *_v_SELECTORS]
_v_JOBS = ['admission', 'helper', 'core', 'resource_1', 'resource_2', 'resource_3', 'resource_4', 'reconcile']
_v_FILE_BYTES = 33554432
_v_ARTIFACT_BYTES = 268435456
_v_ARTIFACT_FILES = 4096
_v_AGGREGATE_BYTES = 2147483648
_v_AGGREGATE_FILES = 32768
_v_SAFE = {'passed', 'assertion_failed', 'timed_out_safe'}
_v_STATUSES = _v_SAFE | {'collection_failed', 'identity_failed', 'helper_failed', 'cancelled', 'cleanup_unsafe', 'evidence_invalid', 'writer_uncertain', 'incomplete'}
_v_PROCESS_KEYS = {'id', 'argv', 'started_at', 'finished_at', 'exit_code', 'timed_out', 'cleanup_complete', 'writer_errors', 'cancelled', 'raw_log', 'limits', 'supervisor_sha256'}
_v_INVOCATION_KEYS = _v_PROCESS_KEYS | {'selected_nodeids', 'reports_json', 'junit_xml'}
_v_RECEIPT_KEYS = set('schema_version lane phase repository plan_sha256 head_sha workflow_path workflow_sha256 run_id run_attempt job_id artifact_name admission_sha256 helper_receipt_sha256 canonical_core_sha256 predecessor_receipt_sha256 source_hashes selectors collection_sha256 full_discovered_ids full_final_ids collection_errors deselected_ids shard_index shard_count assigned_ids invocation_ids invocations collection helper_proofs git_operations claimed_status'.split())
_v_EXPECTED_KEYS = set('repository head_sha checkout_head workflow_path workflow_sha256 plan_sha256 run_id run_attempt producer_job cancelled source_hashes provenance'.split())


class _v_Problem(Exception):
    def __init__(self, code, location, message):
        self.code, self.location, self.message = code, location, message
        super().__init__(message)


def _v_need(condition, code='schema', location='', message='Required evidence invariant is not satisfied.'):
    if not condition:
        raise _v_Problem(code, location, message)


def _v_closed(value, keys, location='', code='schema'):
    _v_need(type(value) is dict and set(value) == set(keys), code, location, 'Evidence has missing, extra, or malformed fields.')


def _v_same(first, second):
    if type(first) is not type(second):
        return False
    if type(first) is dict:
        return set(first) == set(second) and all(_v_same(first[k], second[k]) for k in first)
    if type(first) is list:
        return len(first) == len(second) and all(_v_same(a, b) for a, b in zip(first, second))
    return first == second


def _v_hex(value, count=64):
    return type(value) is str and _v_re.fullmatch('[0-9a-f]{' + str(count) + '}', value) is not None


def _v_string(value):
    return type(value) is str and bool(value) and '\x00' not in value and '\n' not in value and '\r' not in value


def _v_nodes(value, location='', nonempty=True):
    _v_need(type(value) is list and (bool(value) or not nonempty), 'selection', location, 'Node inventory must be a list.')
    _v_need(all(_v_string(n) and '::' in n and n.split('::', 1)[1] for n in value), 'selection', location, 'Malformed node identity.')
    _v_need(len(value) == len(set(value)), 'selection', location, 'Node identities must be unique.')
    return list(value)


def _v_relative(value):
    _v_need(_v_string(value) and '\\' not in value and ':' not in value and not value.startswith('/'), 'path', '', 'Evidence path must be a confined relative POSIX path.')
    parts = value.split('/')
    _v_need(all(p and p not in ('.', '..') for p in parts), 'path', '', 'Evidence path contains a forbidden component.')
    return parts


def _v_stamp(value, location=''):
    _v_need(type(value) is str, 'invocation', location, 'Timestamp must be a timezone-aware ISO8601 string.')
    try:
        parsed = _v_datetime.fromisoformat(value.replace('Z', '+00:00'))
    except (ValueError, TypeError):
        raise _v_Problem('invocation', location, 'Timestamp cannot be parsed.') from None
    _v_need(parsed.utcoffset() is not None, 'invocation', location, 'Timestamp has no timezone.')
    return parsed


def _v_stat_id(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns)


def _v_dir_id(info):
    return (info.st_dev, info.st_ino, info.st_mode)


def _v_directory(path):
    path = _v_Path(_v_os.path.abspath(_v_os.fspath(path)))
    chain = [*reversed(path.parents), path]
    stamps = []
    for parent in chain:
        info = _v_os.lstat(parent)
        _v_need(_v_stat.S_ISDIR(info.st_mode) and not _v_stat.S_ISLNK(info.st_mode), 'path', '', 'Evidence directory is linked or not a directory.')
        stamps.append((parent, _v_dir_id(info)))
    return path, stamps


def _v_decode(data, location=''):
    def pairs(items):
        result = {}
        for key, value in items:
            _v_need(key not in result, 'schema', location, 'Duplicate JSON object key.')
            result[key] = value
        return result
    def nonfinite(value):
        raise _v_Problem('schema', location, 'Non-finite JSON number is forbidden.')
    try:
        def finite(value):
            number = float(value)
            _v_need(_v_math.isfinite(number), 'schema', location, 'Non-finite JSON number is forbidden.')
            return number
        return _v_json.loads(data.decode('utf-8'), object_pairs_hook=pairs, parse_constant=nonfinite, parse_float=finite)
    except (UnicodeError, ValueError, RecursionError):
        raise _v_Problem('schema', location, 'Evidence is not one unambiguous bounded UTF-8 JSON value.') from None


class _v_Reader:
    """A call-local confined reader, not a provenance or prior-result cache."""
    def __init__(self, directory):
        self.root, self.parents = _v_directory(directory)
        self.identity = _v_dir_id(_v_os.lstat(self.root))
        self.sealed = None
        self.records = {}
        self.total_bytes = 0
        self.total_files = 0

    def _path(self, relative):
        parts = _v_relative(relative)
        path = self.root
        parents = list(self.parents)
        for part in parts[:-1]:
            path = path / part
            info = _v_os.lstat(path)
            _v_need(_v_stat.S_ISDIR(info.st_mode) and not _v_stat.S_ISLNK(info.st_mode), 'path', '/' + relative, 'Linked or special evidence parent.')
            parents.append((path, _v_dir_id(info)))
        return path / parts[-1], parents

    def read(self, relative, keep=True, nonempty=True):
        path, parents = self._path(relative)
        info = _v_os.lstat(path)
        _v_need(_v_stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'path', '/' + relative, 'Evidence must be an exclusively owned regular file.')
        _v_need(0 <= info.st_size <= _v_FILE_BYTES, 'size_limit', '/' + relative, 'Evidence file exceeds its fixed byte ceiling.')
        if self.sealed is not None:
            _v_need(relative in self.sealed, 'inventory', '/' + relative, 'Referenced proof is not inventoried.')
            _v_need(info.st_size == self.sealed[relative]['size'], 'inventory', '/' + relative, 'Proof length differs from inventory.')
        flags = _v_os.O_RDONLY | getattr(_v_os, 'O_NOFOLLOW', 0) | getattr(_v_os, 'O_NONBLOCK', 0)
        # Hold a descriptor-rooted directory chain as a second confinement
        # witness. The absolute open remains observable to ordinary bounded
        # read instrumentation, but cannot substitute an outside inode.
        parent_fd = None
        if _v_os.open in getattr(_v_os, 'supports_dir_fd', ()) and hasattr(_v_os, 'O_DIRECTORY'):
            directory_flags = flags | _v_os.O_DIRECTORY
            parent_fd = _v_os.open(self.root, directory_flags)
            try:
                _v_need(_v_dir_id(_v_os.fstat(parent_fd)) == self.identity, 'path', '/' + relative, 'Evidence root changed before descriptor traversal.')
                for part in relative.split('/')[:-1]:
                    next_fd = _v_os.open(part, directory_flags, dir_fd=parent_fd)
                    _v_os.close(parent_fd); parent_fd = next_fd
                held = _v_os.stat(relative.split('/')[-1], dir_fd=parent_fd, follow_symlinks=False)
                _v_need((held.st_dev, held.st_ino, held.st_mode, held.st_nlink) == (info.st_dev, info.st_ino, info.st_mode, info.st_nlink), 'path', '/' + relative, 'Absolute evidence path differs from its confined descriptor owner.')
            except BaseException:
                _v_os.close(parent_fd)
                raise
        try:
            fd = _v_os.open(path, flags)
        except BaseException:
            if parent_fd is not None:
                _v_os.close(parent_fd)
            raise
        chunks, count, digest = [], 0, _v_hashlib.sha256()
        try:
            opened = _v_os.fstat(fd)
            _v_need(_v_stat_id(info) == _v_stat_id(opened), 'writer', '/' + relative, 'File identity changed before reading.')
            while True:
                size = min(65536, _v_FILE_BYTES + 1 - count)
                _v_need(size > 0, 'size_limit', '/' + relative, 'File stream exceeds its fixed byte ceiling.')
                block = _v_os.read(fd, size)
                if not block:
                    break
                _v_need(type(block) is bytes and len(block) <= size, 'writer', '/' + relative, 'Invalid bounded file read.')
                count += len(block)
                _v_need(count <= _v_FILE_BYTES, 'size_limit', '/' + relative, 'File stream exceeds its fixed byte ceiling.')
                _v_need(count <= info.st_size, 'writer', '/' + relative, 'File grew during reading.')
                digest.update(block)
                if keep:
                    chunks.append(block)
            _v_need(count == info.st_size, 'writer', '/' + relative, 'File was truncated during reading.')
            _v_need(_v_stat_id(info) == _v_stat_id(_v_os.fstat(fd)), 'writer', '/' + relative, 'File metadata changed during reading.')
        finally:
            _v_os.close(fd)
            if parent_fd is not None:
                _v_os.close(parent_fd)
        _v_need(_v_stat_id(info) == _v_stat_id(_v_os.lstat(path)), 'writer', '/' + relative, 'File was replaced during reading.')
        for parent, before in parents:
            _v_need(_v_dir_id(_v_os.lstat(parent)) == before, 'path', '/' + relative, 'Evidence parent changed during reading.')
        _v_need(count > 0 or not nonempty, 'path', '/' + relative, 'Required proof is empty.')
        hashed = digest.hexdigest()
        if self.sealed is not None:
            _v_need(hashed == self.sealed[relative]['sha256'], 'inventory', '/' + relative, 'Proof digest differs from inventory.')
        previous = self.records.get(relative)
        _v_need(previous is None or previous == (_v_stat_id(info), hashed, count), 'writer', '/' + relative, 'Proof changed between independent reads.')
        self.records[relative] = (_v_stat_id(info), hashed, count)
        return (b''.join(chunks) if keep else None, hashed, count)

    def json(self, relative):
        return _v_decode(self.read(relative)[0], '/' + relative)

    def check_unchanged(self):
        for relative, (stamp, _, _) in self.records.items():
            path, parents = self._path(relative)
            _v_need(_v_stat_id(_v_os.lstat(path)) == stamp, 'writer', '/' + relative, 'Proof changed before validation completed.')
            for parent, before in parents:
                _v_need(_v_dir_id(_v_os.lstat(parent)) == before, 'path', '/' + relative, 'Evidence directory changed before validation completed.')


def _v_error(problem, owner=None, invocation_id=None, nodeid=None):
    if not isinstance(problem, _v_Problem):
        problem = _v_Problem('path', '', 'Required evidence is unavailable or could not be safely inspected.')
    return {'code': problem.code, 'location': problem.location, 'message': problem.message,
            'owner': owner if owner in _v_JOBS else None, 'invocation_id': invocation_id if type(invocation_id) is str else None, 'nodeid': nodeid}


def _v_status(code):
    return {'identity': 'identity_failed', 'source_hash': 'identity_failed', 'provenance': 'identity_failed',
            'admission': 'identity_failed', 'plan': 'identity_failed', 'collection': 'collection_failed',
            'helper_proof': 'helper_failed', 'writer': 'writer_uncertain', 'cancellation': 'cancelled',
            'cleanup': 'cleanup_unsafe', 'missing_owner': 'incomplete', 'predecessor': 'incomplete'}.get(code, 'evidence_invalid')


def _v_result(kind, owner=None, ids=(), status='passed', errors=(), nodes=None):
    values = list(ids)
    if nodes is None:
        nodes = [{'nodeid': n, 'owner': owner, 'status': 'unknown', 'cause': status} for n in values]
    result = {'schema_version': 'foobar-preview-validation-v1', 'authority': 'supplemental-only', 'kind': kind,
              'status': status, 'continue_allowed': kind != 'global' and status in _v_SAFE,
              'errors': list(errors), 'nodes': list(nodes), 'expected_ids': values,
              'observed_ids': [n['nodeid'] for n in nodes if n['status'] == 'passed'], 'owners': []}
    if kind == 'artifact':
        result['owners'] = [{'job_id': owner, 'status': status, 'completion': 'complete' if status in _v_SAFE else 'incomplete',
                             'cause': None if status == 'passed' else status}]
    return result


def _v_failure(kind, owner, ids, problem, invocation_id=None):
    error = _v_error(problem, owner, invocation_id)
    return _v_result(kind, owner, ids, _v_status(error['code']), [error])

_v_RESOURCE_IDS = ['tests/py/test_foobar_snapshot_preview_resources.py::test_inventory_entry_limit_is_not_truncation[at-limit]', 'tests/py/test_foobar_snapshot_preview_resources.py::test_inventory_entry_limit_is_not_truncation[over-limit]', 'tests/py/test_foobar_snapshot_preview_resources.py::test_revision_validation_precedes_count_and_count_precedes_entry_validation', 'tests/py/test_foobar_snapshot_preview_resources.py::test_inventory_aggregate_budget_counts_repeated_strings_per_entry[at-limit-ascii]', 'tests/py/test_foobar_snapshot_preview_resources.py::test_inventory_aggregate_budget_counts_repeated_strings_per_entry[at-limit-utf8]', 'tests/py/test_foobar_snapshot_preview_resources.py::test_inventory_aggregate_budget_counts_repeated_strings_per_entry[over-limit-ascii]', 'tests/py/test_foobar_snapshot_preview_resources.py::test_inventory_aggregate_budget_counts_repeated_strings_per_entry[over-limit-utf8]', 'tests/py/test_foobar_snapshot_preview_resources.py::test_all_entries_and_duplicates_are_checked_before_aggregate_rejection[invalid-over-budget]', 'tests/py/test_foobar_snapshot_preview_resources.py::test_all_entries_and_duplicates_are_checked_before_aggregate_rejection[duplicate-over-budget]', 'tests/py/test_foobar_snapshot_preview_resources.py::test_all_entries_and_duplicates_are_checked_before_aggregate_rejection[invalid-over-duplicate]', 'tests/py/test_foobar_snapshot_preview_resources.py::test_maximum_parser_rows_are_preserved_and_share_one_candidate_projection', 'tests/py/test_foobar_snapshot_preview_resources.py::test_many_distinct_path_groups_keep_exact_counts_and_bounded_candidates', 'tests/py/test_foobar_snapshot_preview_resources.py::test_all_inventory_entries_can_be_distinct_candidates_without_false_uniqueness', 'tests/py/test_foobar_snapshot_preview_resources.py::test_invalid_parser_row_dimensions_reject_without_partial_results[empty]', 'tests/py/test_foobar_snapshot_preview_resources.py::test_invalid_parser_row_dimensions_reject_without_partial_results[over-limit]', 'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_header_width_boundary[at-limit]', 'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_header_width_boundary[over-limit]', 'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_total_cells_includes_header[at-limit]', 'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_total_cells_includes_header[over-limit]', 'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_cell_and_header_byte_bounds[at-limit-ascii-header]', 'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_cell_and_header_byte_bounds[at-limit-ascii-cell]', 'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_cell_and_header_byte_bounds[at-limit-utf8-header]', 'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_cell_and_header_byte_bounds[at-limit-utf8-cell]', 'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_cell_and_header_byte_bounds[over-limit-ascii-header]', 'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_cell_and_header_byte_bounds[over-limit-ascii-cell]', 'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_cell_and_header_byte_bounds[over-limit-utf8-header]', 'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_cell_and_header_byte_bounds[over-limit-utf8-cell]', 'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_record_budget_includes_tab_separators[at-limit-header]', 'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_record_budget_includes_tab_separators[at-limit-row]', 'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_record_budget_includes_tab_separators[over-limit-header]', 'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_record_budget_includes_tab_separators[over-limit-row]', 'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_zero_byte_data_record_is_invalid_even_with_consistent_empty_path', 'tests/py/test_foobar_snapshot_preview_resources.py::test_reconstructed_parser_64_mib_lower_bound[at-limit]', 'tests/py/test_foobar_snapshot_preview_resources.py::test_reconstructed_parser_64_mib_lower_bound[over-limit]', 'tests/py/test_foobar_snapshot_preview_resources.py::test_exact_diagnostic_prefix_and_truncation_accounting[at-cap]', 'tests/py/test_foobar_snapshot_preview_resources.py::test_exact_diagnostic_prefix_and_truncation_accounting[over-cap]']


def _v_plan():
    return {'schema_version': 'foobar-preview-plan-v1', 'workflow_path': _v_WORKFLOW, 'lane': 'foobar-preview',
            'selectors': list(_v_SELECTORS), 'legacy_helper_selectors': list(_v_LEGACY), 'helper_selectors': list(_v_HELPER),
            'core_count': 380, 'resource_ids': list(_v_RESOURCE_IDS),
            'shards': [{'index': i, 'job': 'resource_' + str(i), 'assigned_ids': _v_RESOURCE_IDS[(i-1)*9:i*9]} for i in range(1, 5)],
            'reuse': {'path': _v_OLD, 'sha256': _v_SUPERVISOR, 'callables': ['run_owned', 'process_success', 'node_list', 'timestamp', 'owned_file']},
            'limits': {'collection_seconds': 300, 'core_seconds': 600, 'resource_seconds': 300, 'helper_collection_seconds': 60,
                       'helper_runtime_seconds': 180, 'term_seconds': 30, 'kill_reap_seconds': 30, 'git_seconds': 10,
                       'artifact_bytes': _v_ARTIFACT_BYTES, 'artifact_files': _v_ARTIFACT_FILES, 'file_bytes': _v_FILE_BYTES,
                       'aggregate_bytes': _v_AGGREGATE_BYTES, 'aggregate_files': _v_AGGREGATE_FILES},
            'job_minutes': {'admission': 2, 'helper': 40, 'core': 45, 'resource_1': 90, 'resource_2': 90, 'resource_3': 90, 'resource_4': 90, 'reconcile': 15},
            'overhead_seconds': {'checkout': 120, 'setup_python': 300, 'install': 300, 'download': 120, 'verify': 120, 'finalize': 120, 'upload': 180}}


def _v_check_plan(plan):
    _v_need(_v_same(plan, _v_plan()), 'plan', '/plan', 'Plan differs from the frozen reviewed execution contract.')


def _v_name(expected, owner):
    return 'preview-v1-' + expected['head_sha'] + '-' + str(expected['run_id']) + '-' + str(expected['run_attempt']) + '-' + owner


def _v_check_expected(expected, producer=None):
    _v_closed(expected, _v_EXPECTED_KEYS, '/expected')
    _v_need(expected['repository'] == _v_REPO and expected['workflow_path'] == _v_WORKFLOW, 'identity', '/expected', 'Unexpected repository or workflow.')
    _v_need(_v_hex(expected['head_sha'], 40) and expected['checkout_head'] == expected['head_sha'], 'identity', '/expected/checkout_head', 'Checkout must be the exact admitted head.')
    for key in ('workflow_sha256', 'plan_sha256'):
        _v_need(_v_hex(expected[key]), 'identity', '/expected/' + key, 'Malformed trusted source digest.')
    _v_need(type(expected['run_id']) is int and expected['run_id'] > 0 and type(expected['run_attempt']) is int and expected['run_attempt'] >= 2, 'identity', '/expected', 'Companion execution identity is invalid or first-attempt.')
    _v_need(expected['producer_job'] in _v_JOBS and (producer is None or expected['producer_job'] == producer), 'identity', '/expected/producer_job', 'Expected producer must be the independently selected owner.')
    _v_need(type(expected['cancelled']) is bool, 'schema', '/expected/cancelled', 'Cancellation state must be independently observed.')
    hashes = expected['source_hashes']
    _v_closed(hashes, _v_CONTROLS + _v_PRODUCTS, '/expected/source_hashes', 'source_hash')
    _v_need(all(_v_hex(value) for value in hashes.values()), 'source_hash', '/expected/source_hashes', 'Malformed checkout source digest.')
    _v_need(hashes[_v_OLD] == _v_SUPERVISOR and hashes[_v_PLAN] == expected['plan_sha256'] and hashes[_v_WORKFLOW] == expected['workflow_sha256'], 'identity', '/expected/source_hashes', 'Trusted source identities are inconsistent.')
    _v_need(type(expected['provenance']) is list, 'provenance', '/expected/provenance', 'Missing trusted artifact transfer provenance.')
    owners, ids = set(), set()
    for index, record in enumerate(expected['provenance']):
        where = '/expected/provenance/' + str(index)
        _v_closed(record, {'producer_job', 'artifact_name', 'artifact_id', 'repository', 'head_sha', 'workflow_path', 'run_id', 'run_attempt'}, where, 'provenance')
        owner, identity = record['producer_job'], record['artifact_id']
        _v_need(type(owner) is str and owner in _v_JOBS and owner not in owners and type(identity) is int and identity > 0 and identity not in ids, 'provenance', where, 'Duplicate or malformed artifact transfer owner or identity.')
        owners.add(owner); ids.add(identity)
        _v_need(record['artifact_name'] == _v_name(expected, owner) and all(_v_same(record[k], expected[k]) for k in ('repository', 'head_sha', 'workflow_path', 'run_id', 'run_attempt')), 'provenance', where, 'Artifact transfer does not belong to this exact run, attempt, head and producer.')


def _v_scan(reader):
    found, directories, inode_ids = {}, set(), set()
    pending = [(reader.root, '')]
    while pending:
        directory, prefix = pending.pop()
        with _v_os.scandir(directory) as entries:
            for entry in entries:
                relative = prefix + entry.name
                _v_relative(relative)
                info = _v_os.lstat(reader.root / relative)
                if _v_stat.S_ISDIR(info.st_mode):
                    directories.add(relative)
                    _v_need(len(directories) <= _v_ARTIFACT_FILES, 'size_limit', '/inventory', 'Too many artifact directories.')
                    pending.append((reader.root / relative, relative + '/'))
                else:
                    _v_need(_v_stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'path', '/' + relative, 'Artifact contains a link or special file.')
                    identity = (info.st_dev, info.st_ino)
                    _v_need(identity not in inode_ids, 'path', '/' + relative, 'Artifact files alias the same inode.')
                    inode_ids.add(identity)
                    _v_need(0 <= info.st_size <= _v_FILE_BYTES, 'size_limit', '/' + relative, 'Artifact file exceeds its fixed ceiling.')
                    found[relative] = info
                    _v_need(len(found) <= _v_ARTIFACT_FILES, 'size_limit', '/inventory', 'Artifact contains too many files.')
    return found, directories


def _v_inventory(reader, context=None):
    raw_inventory, inventory_digest, inventory_size = reader.read('inventory.json')
    raw_marker, _, marker_size = reader.read('complete.json')
    inventory, marker = _v_decode(raw_inventory, '/inventory.json'), _v_decode(raw_marker, '/complete.json')
    _v_closed(inventory, {'schema_version', 'files'}, '/inventory.json', 'inventory')
    _v_need(inventory['schema_version'] == 'foobar-preview-inventory-v1' and type(inventory['files']) is list, 'inventory', '/inventory.json', 'Malformed file inventory.')
    _v_closed(marker, {'schema_version', 'inventory_sha256', 'receipt_sha256', 'writer_complete'}, '/complete.json', 'writer')
    _v_need(marker['schema_version'] == 'foobar-preview-complete-v1' and marker['writer_complete'] is True and marker['inventory_sha256'] == inventory_digest and _v_hex(marker['receipt_sha256']), 'writer', '/complete.json', 'Writer-complete marker is absent, uncertain or mismatched.')
    _v_need(len(inventory['files']) + 2 <= _v_ARTIFACT_FILES, 'size_limit', '/inventory.json', 'Artifact exceeds its fixed file ceiling.')
    mapped, paths, total = {}, [], inventory_size + marker_size
    for index, entry in enumerate(inventory['files']):
        location = '/inventory.json/files/' + str(index)
        _v_closed(entry, {'path', 'size', 'sha256'}, location, 'inventory')
        relative = entry['path']; _v_relative(relative)
        _v_need(relative not in mapped and relative not in ('inventory.json', 'complete.json') and relative.split('/')[-1] not in ('inventory.json', 'complete.json'), 'inventory', location, 'Duplicate, recursive or reserved inventory entry.')
        _v_need(type(entry['size']) is int and 0 <= entry['size'] <= _v_FILE_BYTES, 'size_limit', location, 'Declared file size exceeds its fixed ceiling.')
        _v_need(_v_hex(entry['sha256']), 'inventory', location, 'Malformed inventoried file digest.')
        mapped[relative] = dict(entry); paths.append(relative); total += entry['size']
    _v_need(paths == sorted(paths) and 'receipt.json' in mapped, 'inventory', '/inventory.json/files', 'Inventory must be sorted and include the producer receipt.')
    _v_need(total <= _v_ARTIFACT_BYTES, 'size_limit', '/inventory.json', 'Artifact exceeds its fixed aggregate byte ceiling.')
    actual, directories = _v_scan(reader)
    _v_need(set(actual) == set(mapped) | {'inventory.json', 'complete.json'}, 'inventory', '/inventory.json', 'Artifact contains unlisted files or lacks listed files.')
    permitted_dirs = {'/'.join(path.split('/')[:i]) for path in mapped for i in range(1, len(path.split('/')))}
    _v_need(directories == permitted_dirs, 'inventory', '/inventory.json', 'Artifact contains unowned directories.')
    _v_need(sum(info.st_size for info in actual.values()) <= _v_ARTIFACT_BYTES, 'size_limit', '/inventory.json', 'Actual artifact length exceeds its fixed ceiling.')
    for relative, entry in mapped.items():
        _v_need(actual[relative].st_size == entry['size'], 'inventory', '/' + relative, 'Actual and inventoried file lengths differ.')
    if context is not None:
        context.account(reader, total, len(mapped) + 2)
    reader.sealed = dict(mapped)
    for name in ('inventory.json', 'complete.json'):
        _, digest, size = reader.records[name]
        reader.sealed[name] = {'path': name, 'size': size, 'sha256': digest}
    for relative in mapped:
        reader.read(relative, keep=False, nonempty=False)
    _v_need(reader.records['receipt.json'][1] == marker['receipt_sha256'], 'writer', '/complete.json/receipt_sha256', 'Writer marker does not bind the actual receipt.')
    reader.total_bytes, reader.total_files = total, len(mapped) + 2
    reader.check_unchanged()
    return marker


def _v_check_command(reader, argv, selected, *, collecting=False, git=False, record=None, legacy=False):
    _v_need(type(argv) is list and bool(argv) and all(_v_string(arg) for arg in argv), 'invocation', '/argv', 'Process command is not a nonempty string vector.')
    if git:
        _v_need(argv == ['git', 'rev-parse', 'HEAD'], 'process', '/argv', 'Only the single bounded checkout probe is permitted.')
        return
    flags = ['--noconftest', '--import-mode=importlib', '-p', 'no:cacheprovider']
    direct = ['-m', 'pytest', *(['--collect-only'] if collecting else []), *flags, *selected]
    if argv[1:] == direct:
        _v_need(_v_Path(argv[0]).name.lower().startswith(('python', 'pypy')), 'invocation', '/argv/0', 'Runtime must use the reviewed Python entry point.')
        return
    program = globals().get('_CHILD_PROGRAM')
    if type(program) is str and len(argv) >= 6 and argv[1:3] == ['-c', program]:
        _v_need(argv[5:] == selected and _v_Path(argv[3]).is_absolute(), 'selection', '/argv', 'Wrapper command differs from its exact ordered assignment.')
        _v_need(_v_Path(argv[0]).name.lower().startswith(('python', 'pypy')), 'invocation', '/argv/0', 'Wrapper must use the reviewed Python entry point.')
        _v_need(type(record) is dict and type(record.get('raw_log')) is str and record['raw_log'].endswith('.log'), 'invocation', '/argv', 'Wrapper has no deterministic owned request identity.')
        relative = record['raw_log'][:-4] + '.request.json'
        _v_relative(relative)
        request = _v_Path(argv[4])
        _v_need(request.is_absolute() and request.as_posix().endswith('/' + relative), 'path', '/argv/4', 'Child request does not match its owned relative proof path.')
        # Absolute producer paths move at transfer. The deterministic relative
        # request copy is inspected here, never the foreign absolute path.
        data = reader.json(relative)
        _v_closed(data, {'schema_version', 'mode', 'phase', 'expected', 'selection', 'collection_path', 'reports_path', 'junit_path'}, '/' + relative, 'invocation')
        _v_need(data['schema_version'] == 'foobar-preview-child-v1' and data['selection'] == selected and data['mode'] == ('collect' if collecting else 'run') and data['phase'] in ('helper', 'core', 'resource'), 'selection', '/argv/4', 'Child request does not reproduce the exact command selection, phase and mode.')
        _v_check_expected(data['expected'])
        request_owner = data['expected']['producer_job']
        _v_need(data['phase'] == ('helper' if request_owner == 'helper' else 'core' if request_owner == 'core' else 'resource') and request_owner in _v_JOBS[1:-1], 'identity', '/' + relative, 'Child phase does not match its exact producer job.')
        if hasattr(reader, 'expected'):
            _v_need(request_owner == reader.owner and all(_v_same(data['expected'][key], reader.expected[key]) for key in _v_EXPECTED_KEYS - {'producer_job', 'provenance'}), 'identity', '/' + relative, 'Child request source and run context differ from the independently admitted transfer.')
        reports = record['raw_log'][:-4] + '.json'
        _v_need(data['reports_path'] == reports and (collecting or record['reports_json'] == reports), 'invocation', '/' + relative + '/reports_path', 'Child output paths differ from retained raw proof.')
        if collecting:
            _v_need(data['collection_path'] is None and data['junit_path'] is None, 'invocation', '/' + relative, 'Collection request has runtime-only output paths.')
        else:
            _v_need(data['junit_path'] == record['raw_log'][:-4] + '.xml' and (record['junit_xml'] is None or data['junit_path'] == record['junit_xml']), 'junit', '/' + relative + '/junit_path', 'Child JUnit path differs from retained proof.')
            _v_relative(data['collection_path'])
            collected = reader.json(data['collection_path'])
            _v_need(type(collected) is dict and collected.get('deselected_nodeids') == [] and collected.get('collection_errors') == [] and collected.get('nodeids') == collected.get('discovered_nodeids') and type(collected.get('nodeids')) is list, 'collection', '/' + relative + '/collection_path', 'Child runtime lacks its complete original collection.')
            if data['phase'] == 'helper':
                _v_need(selected == collected['nodeids'], 'selection', '/' + relative, 'Helper wrapper must run its entire new helper collection.')
            elif data['phase'] == 'core':
                _v_need(len(collected['nodeids']) == 416 and selected == collected['nodeids'][:380] and collected['nodeids'][380:] == _v_RESOURCE_IDS, 'selection', '/' + relative, 'Core wrapper must run its complete canonical core collection.')
            else:
                index = int(request_owner[-1])
                _v_need(len(selected) == 1 and selected[0] in _v_RESOURCE_IDS[(index-1)*9:index*9], 'selection', '/' + relative, 'Resource wrapper must run one rightful singleton.')
        return
    if legacy and len(argv) >= 11 and argv[1] == '-u' and argv[3:5] == ['_child', '--identity']:
        _v_need(_v_Path(argv[0]).name.lower().startswith(('python', 'pypy')), 'invocation', '/argv/0', 'Legacy child must use the reviewed Python entry point.')
        source = _v_Path(argv[2])
        _v_need(source.is_absolute() and source.as_posix().endswith('/' + _v_OLD), 'source_hash', '/argv/2', 'Legacy child is not the unchanged supervisor entry point.')
        identity = _v_Path(argv[5])
        _v_need(identity.is_absolute() and identity.name == 'identity.json', 'path', '/argv/5', 'Legacy identity command path is malformed.')
        original = identity.parent
        prefix = [argv[0], '-u', argv[2], '_child', '--identity', str(identity), '--mode', 'collect' if collecting else 'runtime', '--capture']
        capture = str(original / ('collection.capture.json' if collecting else record['reports_json'].removeprefix('legacy/')))
        suffix = [capture] + ([] if collecting else ['--junit', str(original / record['junit_xml'].removeprefix('legacy/'))]) + ['--', *selected]
        _v_need(argv == prefix + suffix, 'invocation', '/argv', 'Legacy child command differs from fixed collection or whole-suite runtime.')
        return
    raise _v_Problem('invocation', '/argv', 'Command does not match an allowed isolated whole-selection invocation.')


def _v_process(reader, record, seconds, selected=None, collecting=False, git=False, legacy=False, command_nodes=None):
    _v_closed(record, _v_PROCESS_KEYS if selected is None else _v_INVOCATION_KEYS, '/process')
    _v_need(_v_string(record['id']), 'invocation', '/process/id', 'Missing process identity.')
    _v_need(type(record['exit_code']) is int or record['exit_code'] is None, 'process', '/process/exit_code', 'Exit code must be an integer or explicit null.')
    for key in ('timed_out', 'cleanup_complete', 'cancelled'):
        _v_need(type(record[key]) is bool, 'schema', '/process/' + key, 'Process state must be a Boolean.')
    _v_need(type(record['writer_errors']) is list and all(type(item) is str for item in record['writer_errors']), 'schema', '/process/writer_errors', 'Writer errors must be a list of diagnostic strings.')
    _v_need(record['supervisor_sha256'] == _v_SUPERVISOR, 'source_hash', '/process/supervisor_sha256', 'Process is not bound to the admitted unchanged supervisor.')
    _v_need(_v_same(record['limits'], {'runtime_seconds': seconds, 'term_seconds': 30, 'kill_reap_seconds': 30}), 'deadline', '/process/limits', 'Process deadline differs from the reviewed fixed ceiling.')
    start, finish = _v_stamp(record['started_at']), _v_stamp(record['finished_at'])
    _v_need(start <= finish, 'invocation', '/process/finished_at', 'Process timestamps are reversed.')
    _v_need((finish - start).total_seconds() <= seconds + 60, 'deadline', '/process/finished_at', 'Process exceeded its runtime and cleanup ceiling.')
    _v_check_command(reader, record['argv'], selected if selected is not None else (command_nodes or []), collecting=collecting, git=git, record=record, legacy=legacy)
    reader.read(record['raw_log'], keep=False)
    if not legacy and not (git and record['raw_log'] == 'legacy/checkout.log') and record['raw_log'].endswith('.log'):
        proof = record['raw_log'][:-4] + '.process.json'
        _v_relative(proof)
        candidate = reader.root / proof
        real_wrapper = len(record['argv']) >= 3 and record['argv'][1:3] == ['-c', globals().get('_CHILD_PROGRAM')]
        producer_inventory = reader.sealed is not None and any(name.endswith('.request.json') or name == 'transfer-context.json' for name in reader.sealed)
        try:
            _v_os.lstat(candidate)
            present_proof = True
        except FileNotFoundError:
            present_proof = False
        if real_wrapper or producer_inventory or present_proof:
            actual = reader.json(proof)
            _v_closed(actual, _v_PROCESS_KEYS, '/' + proof, 'process')
            _v_need(_v_same(actual, {key: record[key] for key in _v_PROCESS_KEYS}), 'process', '/' + proof, 'Retained actual supervisor result contradicts its receipt envelope.')
    _v_need(not record['cancelled'], 'cancellation', '/process/cancelled', 'Caller cancellation suppresses continuation.')
    _v_need(record['cleanup_complete'], 'cleanup', '/process/cleanup_complete', 'Owned process cleanup is not complete.')
    _v_need(record['writer_errors'] == [], 'writer', '/process/writer_errors', 'Process output writer is incomplete or uncertain.')
    _v_need(type(record['exit_code']) is int, 'process', '/process/exit_code', 'Owned process has not been reaped.')
    return start, finish


def _v_success(record):
    try:
        _legacy_helper().process_success(record)
    except Exception:
        raise _v_Problem('process', '/process', 'Unchanged supervisor did not validate complete process success.') from None
    _v_need(record['cancelled'] is False, 'cancellation', '/process/cancelled', 'Cancelled process cannot pass.')


def _v_reports(reader, relative, selected, legacy=False):
    data = reader.json(relative)
    keys = {'schema_version', 'reports'}
    if legacy:
        keys |= {'discovered_nodeids', 'nodeids', 'deselected_nodeids', 'collection_errors'}
    _v_closed(data, keys, '/' + relative, 'phase')
    _v_need(type(data['schema_version']) is int and data['schema_version'] == 1 and type(data['reports']) is list, 'schema', '/' + relative, 'Malformed phase report schema.')
    if legacy:
        _v_need(data['nodeids'] == selected and data['discovered_nodeids'] == selected and data['deselected_nodeids'] == [] and data['collection_errors'] == [], 'collection', '/' + relative, 'Legacy runtime capture does not reproduce its entire collection.')
    observed = {}
    for index, report in enumerate(data['reports']):
        location = '/' + relative + '/reports/' + str(index)
        _v_closed(report, {'nodeid', 'when', 'outcome', 'wasxfail'}, location, 'phase')
        node, phase = report['nodeid'], report['when']
        _v_need(type(node) is str and node in selected and type(phase) is str and phase in ('setup', 'call', 'teardown'), 'phase', location, 'Unselected node or unknown phase in raw report.')
        _v_need((node, phase) not in observed, 'phase', location, 'Duplicate execution phase.')
        _v_need(type(report['outcome']) is str and report['outcome'] in ('passed', 'failed', 'skipped') and (report['wasxfail'] is None or type(report['wasxfail']) is str), 'phase', location, 'Malformed execution outcome or xfail diagnostic.')
        observed[node, phase] = dict(report)
    return observed


def _v_junit(reader, relative, selected, timeout=False):
    data = reader.read(relative)[0]
    # The admitted pytest writer emits UTF-8. Decode before declaration scans
    # so alternate encodings cannot conceal DTD/entity expansion from the gate.
    try:
        xml_text = data.decode('utf-8-sig')
    except UnicodeError:
        raise _v_Problem('junit', '/' + relative, 'JUnit must use the admitted UTF-8 writer encoding.') from None
    _v_need('\x00' not in xml_text and '<!DOCTYPE' not in xml_text.upper() and '<!ENTITY' not in xml_text.upper(), 'junit', '/' + relative, 'NULs, DTD and entity declarations are forbidden in JUnit evidence.')
    try:
        root = _v_ET.fromstring(xml_text)
    except (_v_ET.ParseError, ValueError, RecursionError):
        raise _v_Problem('junit', '/' + relative, 'Malformed JUnit XML.') from None
    _v_need(root.tag in ('testsuite', 'testsuites'), 'junit', '/' + relative, 'Unexpected JUnit root element.')
    cases = list(root.iter('testcase'))
    _v_need(len(cases) <= len(selected) if timeout else len(cases) == len(selected), 'junit', '/' + relative, 'JUnit testcase cardinality differs from the owning invocation.')
    counts = {}
    for key, tag in (('failures', 'failure'), ('errors', 'error'), ('skipped', 'skipped')):
        counts[key] = sum(bool(list(case.iter(tag))) for case in cases)
        _v_need(len(list(root.iter(tag))) == counts[key], 'junit', '/' + relative, 'JUnit outcomes must belong uniquely to individual testcases.')
    for case in cases:
        _v_need(len(list(case.iter('testcase'))) == 1, 'junit', '/' + relative, 'Nested JUnit testcases are not valid execution evidence.')
        _v_need(sum(bool(list(case.iter(tag))) for tag in ('failure', 'error', 'skipped')) <= 1, 'junit', '/' + relative, 'JUnit testcase has contradictory outcomes.')
    for element in root.iter():
        for key, tag in (('tests', 'testcase'), ('failures', 'failure'), ('errors', 'error'), ('skipped', 'skipped')):
            if key in element.attrib:
                value = element.attrib[key]
                _v_need(_v_re.fullmatch(r'[0-9]+', value) is not None and len(value) <= 12, 'junit', '/' + relative, 'JUnit count is not a bounded nonnegative decimal integer.')
                _v_need(int(value) == len(list(element.iter(tag))), 'junit', '/' + relative, 'JUnit aggregate disagrees with its own subtree.')
    return counts


def _v_invocation(reader, invocation, assigned_ids, owner, legacy=False):
    nodes = _v_nodes(assigned_ids, '/assigned_ids')
    _v_need(owner in _v_JOBS[1:-1], 'identity', '/owner', 'Invocation owner is not a product or helper producer.')
    _v_closed(invocation, _v_INVOCATION_KEYS, '/invocation')
    _v_need(_v_same(invocation['selected_nodeids'], nodes), 'selection', '/invocation/selected_nodeids', 'Invocation differs from the independently assigned ordered selection.')
    seconds = 180 if owner == 'helper' else 600 if owner == 'core' else 300
    _v_process(reader, invocation, seconds, nodes, legacy=legacy)
    reports = _v_reports(reader, invocation['reports_json'], nodes, legacy=legacy)
    timeout = invocation['timed_out']
    proof_paths = [invocation['raw_log'], invocation['reports_json']] + ([] if invocation['junit_xml'] is None else [invocation['junit_xml']])
    _v_need(len(proof_paths) == len(set(proof_paths)), 'path', '/invocation', 'Runtime log, phase report and JUnit must be separately owned retained files.')
    if timeout:
        remaining = list(reports)
        for node in nodes:
            if not remaining:
                break
            _v_need(remaining[0] == (node, 'setup'), 'phase', '/invocation/reports_json', 'Timeout report prefix starts a node out of execution order.')
            remaining.pop(0)
            if remaining and remaining[0] == (node, 'call'):
                _v_need(reports[node, 'setup']['outcome'] == 'passed', 'phase', '/invocation/reports_json', 'A call cannot follow a nonpassing setup in a truthful timeout prefix.')
                remaining.pop(0)
            if remaining and remaining[0] == (node, 'teardown'):
                remaining.pop(0)
            elif remaining:
                raise _v_Problem('phase', '/invocation/reports_json', 'Timeout report prefix starts later work before prior teardown.')
        _v_need(not remaining, 'phase', '/invocation/reports_json', 'Timeout report prefix contains reordered phase evidence.')
    if invocation['junit_xml'] is None:
        _v_need(timeout, 'junit', '/invocation/junit_xml', 'Only a safely reaped timeout may explicitly lack JUnit.')
        junit = None
    else:
        junit = _v_junit(reader, invocation['junit_xml'], nodes, timeout=timeout)
    if timeout:
        status = 'timed_out_safe'
        records = [{'nodeid': n, 'owner': owner, 'status': 'timed_out', 'cause': 'timed_out'} for n in nodes]
        errors = [_v_error(_v_Problem('timed_out', '/invocation/timed_out', 'Owning invocation timed out and was safely cleaned; no selected node is accepted as passed.'), owner, invocation['id'])]
    else:
        wanted = {(n, phase) for n in nodes for phase in ('setup', 'call', 'teardown')}
        _v_need(set(reports) == wanted, 'phase', '/invocation/reports_json', 'Each selected node requires exactly one setup, call, and teardown report.')
        _v_need(all(r['wasxfail'] is None and r['outcome'] != 'skipped' for r in reports.values()), 'phase', '/invocation/reports_json', 'Skipped or xfail/xpass phases cannot validate success or ordinary assertion continuation.')
        _v_need(all(reports[n, phase]['outcome'] == 'passed' for n in nodes for phase in ('setup', 'teardown')), 'phase', '/invocation/reports_json', 'Setup and teardown must both pass for every selected node.')
        failed = [n for n in nodes if reports[n, 'call']['outcome'] == 'failed']
        _v_need(junit is not None and junit['errors'] == junit['skipped'] == 0 and junit['failures'] == len(failed), 'junit', '/invocation/junit_xml', 'JUnit and raw call outcomes disagree.')
        if failed:
            _v_need(invocation['exit_code'] == 1, 'process', '/invocation/exit_code', 'Ordinary assertion continuation requires exactly exit code one.')
            status = 'assertion_failed'
            records = [{'nodeid': n, 'owner': owner, 'status': 'failed' if n in failed else 'unknown',
                        'cause': 'assertion_failed' if n in failed else 'invocation_nonzero_exit'} for n in nodes]
            errors = [_v_error(_v_Problem('assertion_failed', '/invocation/reports_json', 'Owning invocation contains an ordinary assertion failure; no node in this nonzero-exit invocation is accepted as passed.'), owner, invocation['id'], failed[0])]
        else:
            _v_success(invocation)
            status, errors = 'passed', []
            records = [{'nodeid': n, 'owner': owner, 'status': 'passed', 'cause': None} for n in nodes]
    return _v_result('invocation', owner, nodes, status, errors, records)


def validate_invocation(evidence_dir, invocation, *, assigned_ids, owner):
    """Read one exact owned runtime proof; never launch or modify anything."""
    ids = []
    try:
        ids = _v_nodes(assigned_ids, '/assigned_ids')
        reader = _v_Reader(evidence_dir)
        result = _v_invocation(reader, invocation, ids, owner)
        reader.check_unchanged()
        return result
    except Exception as problem:
        return _v_failure('invocation', owner if owner in _v_JOBS else 'core', ids, problem,
                          invocation.get('id') if type(invocation) is dict else None)


def _v_admission(reader, expected):
    data = reader.json('admission.json')
    context = reader.json('admission-context.json')
    _v_closed(context, {'schema_version', 'repository', 'head_sha', 'run_id', 'attempt', 'admission_sha256'}, '/admission-context.json', 'admission')
    _v_need(type(context['schema_version']) is int and context['schema_version'] == 1 and
            all(_v_same(context[key], expected[key]) for key in ('repository', 'head_sha', 'run_id')) and
            _v_same(context['attempt'], expected['run_attempt']) and context['admission_sha256'] == reader.records['admission.json'][1], 'admission', '/admission-context.json', 'Admission sidecar does not bind the exact companion run and original snapshot bytes.')
    _v_need(type(data) is dict and type(data.get('schema_version')) is int and data['schema_version'] == 1 and
            data.get('decision') == 'admit' and data.get('reason_codes') == [] and data.get('authority') == 'supplemental-only' and data.get('coverage') == 'unproven' and type(data.get('inspected')) is list,
            'admission', '/admission.json', 'Admission is not a complete supplemental-only admit snapshot.')
    _v_stamp(data.get('observed_at'), '/admission.json/observed_at')
    trigger, current = data.get('trigger'), data.get('current')
    keys = {'repository', 'number', 'branch', 'head_sha', 'draft', 'control_labels', 'all_labels'}
    controls = {'run_reviews', 'skip_tests', 'ci:full-review', 'ci:focused-e2e', 'ci:focused-related'}
    for entry in (trigger, current):
        _v_closed(entry, keys, '/admission.json/trigger', 'admission')
        _v_need(entry['repository'] == _v_REPO and entry['head_sha'] == expected['head_sha'] and entry['branch'] == '2026-10-03-album-tops' and
                type(entry['number']) is int and entry['number'] > 0 and type(entry['draft']) is bool, 'admission', '/admission.json/trigger', 'Admission PR identity is invalid.')
        labels = entry['all_labels']
        _v_need(type(labels) is list and all(_v_string(label) and label == label.strip() for label in labels) and labels == sorted(set(labels)), 'admission', '/admission.json/trigger/all_labels', 'Admission labels are malformed.')
        _v_need(entry['control_labels'] == [name for name in labels if name in controls or name.startswith(('ci:e2e:', 'ci:e2e-performance:'))], 'admission', '/admission.json/trigger/control_labels', 'Admission control labels are inconsistent.')
    _v_need(all(_v_same(trigger[key], current[key]) for key in keys - {'all_labels'}), 'admission', '/admission.json/current', 'Current PR identity, draft state or control labels changed.')
    native = data.get('native')
    _v_need(type(native) is dict and all(type(native.get(k)) is int and native[k] > 0 for k in ('id', 'run_number', 'attempt', 'workflow_id')) and
            native.get('head_sha') == expected['head_sha'] and native.get('status') == 'completed' and native.get('conclusion') in ('success', 'failure'), 'admission', '/admission.json/native', 'Native owner must be terminal on the exact admitted head; its failure is not success.')
    jobs = native.get('jobs')
    _v_need(type(jobs) is list and bool(jobs), 'admission', '/admission.json/native/jobs', 'Native job snapshot is incomplete.')
    ids = set()
    terminal = {'success', 'failure', 'timed_out', 'cancelled', 'skipped', 'neutral', 'action_required', 'stale', 'startup_failure'}
    for job in jobs:
        _v_need(type(job) is dict and type(job.get('id')) is int and job['id'] > 0 and job['id'] not in ids and _v_string(job.get('name')), 'admission', '/admission.json/native/jobs', 'Native job identities are malformed or duplicated.')
        ids.add(job['id'])
        _v_need(type(job.get('run_id')) is int and job['run_id'] == native['id'] and type(job.get('run_attempt')) is int and job['run_attempt'] == native['attempt'] and
                job.get('head_sha') == expected['head_sha'] and job.get('head_branch') == trigger['branch'] and job.get('workflow_name') == 'PR Gates' and
                job.get('status') == 'completed' and job.get('conclusion') in terminal, 'admission', '/admission.json/native/jobs', 'Native jobs are active or have mismatched exact ownership.')
    for name in ('PR Review Scope', 'Review Prerequisites', 'JavaScript Tests (Portable)', 'Component Tests (Pinned Chrome)', 'JavaScript Tests (Windows Contract)', 'Python Tests'):
        owners = [job for job in jobs if job['name'] == name]
        _v_need(len(owners) == 1, 'admission', '/admission.json/native/jobs', 'Required native prerequisite or foundation owner is missing or duplicated.')
        if name in ('PR Review Scope', 'Review Prerequisites'):
            _v_need(owners[0]['conclusion'] == 'success', 'admission', '/admission.json/native/jobs', 'Native prerequisite did not pass.')
        else:
            _v_need(_v_string(owners[0].get('started_at')) and owners[0]['conclusion'] in ('success', 'failure', 'timed_out', 'cancelled'), 'admission', '/admission.json/native/jobs', 'Native foundation execution was not admitted.')
    reader.check_unchanged()
    return reader.records['admission.json'][1]


def _v_collection(reader, record, selectors, *, product=False, legacy=False):
    _v_closed(record, {'path', 'sha256', 'selectors', 'process'}, '/collection', 'collection')
    _v_need(_v_same(record['selectors'], selectors) and _v_hex(record['sha256']), 'collection', '/collection', 'Collection selectors or raw digest are invalid.')
    _v_process(reader, record['process'], 300 if product else 60, collecting=True, legacy=legacy, command_nodes=selectors)
    _v_success(record['process'])
    _v_need(record['path'] != record['process']['raw_log'], 'path', '/collection', 'Collection capture and raw process log must be separately owned files.')
    data = reader.json(record['path'])
    _v_need(record['sha256'] == reader.records[record['path']][1], 'collection', '/collection/sha256', 'Collection digest must bind its original raw bytes.')
    collection_keys = {'discovered_nodeids', 'nodeids', 'deselected_nodeids', 'collection_errors'}
    if legacy:
        raw_keys = _v_PROCESS_KEYS - {'id', 'limits', 'supervisor_sha256'}
        _v_closed(data, collection_keys | raw_keys, '/collection/raw', 'collection')
        for key in raw_keys:
            value = record['process'][key]
            if key == 'raw_log':
                value = value.removeprefix('legacy/')
            _v_need(_v_same(data[key], value), 'helper_proof', '/collection/raw/' + key, 'Legacy raw collection process differs from its enclosing reference.')
    else:
        _v_closed(data, collection_keys | {'schema_version'}, '/collection/raw', 'collection')
        _v_need(type(data['schema_version']) is int and data['schema_version'] == 1, 'collection', '/collection/raw/schema_version', 'Invalid raw collection schema.')
    nodes = _v_nodes(data['nodeids'], '/collection/raw/nodeids')
    discovered = _v_nodes(data['discovered_nodeids'], '/collection/raw/discovered_nodeids')
    _v_need(nodes == discovered and data['deselected_nodeids'] == [] and data['collection_errors'] == [], 'collection', '/collection/raw', 'Whole-module discovery must equal final collection without errors, skips or deselections.')
    _v_need({node.split('::', 1)[0] for node in nodes} == set(selectors), 'collection', '/collection/raw/nodeids', 'Whole collection omits a selected module or includes an unselected one.')
    if product:
        _v_need(len(nodes) == 416 and all(node.startswith(_v_CORE + '::') for node in nodes[:380]) and nodes[380:] == _v_RESOURCE_IDS, 'collection', '/collection/raw/nodeids', 'Product collection is not the entire 380-node core followed by the frozen 36 resource nodes.')
    return nodes, data


def _v_timeline(records):
    ids, logs, previous = set(), set(), None
    for record in records:
        _v_need(record['id'] not in ids, 'invocation', '/processes/id', 'Process identities must be unique within their producer.')
        _v_need(record['raw_log'] not in logs, 'process', '/processes/raw_log', 'Each owned process requires an exclusive raw log.')
        ids.add(record['id']); logs.add(record['raw_log'])
        start, finish = _v_stamp(record['started_at']), _v_stamp(record['finished_at'])
        _v_need(previous is None or previous <= start, 'deadline', '/processes/started_at', 'Owned processes overlap or are presented out of execution order.')
        previous = finish


class _v_Context:
    """Fresh one-call validation state. Never persist or reuse this as authority.

    local_producer may be set only by producer-local CLI validation before an
    upload. That private mode skips that producer's unavailable future transfer
    record, not any upstream provenance. Public seams never set it, and producer
    local outcomes remain provisional until actual downstream transferred proof.
    """
    def __init__(self, plan, expected, directories, local_producer=None):
        _v_check_plan(plan); _v_check_expected(expected)
        self.plan, self.expected = plan, expected
        self.directories = dict(directories)
        self.provisional_owner = local_producer
        self.readers, self.results, self.receipts, self.collections = {}, {}, {}, {}
        self.accounted, self.directory_ids = {}, {}
        self.admission_digest = None
        self.total_bytes, self.total_files = 0, 0
        _v_need(local_producer is None or local_producer == expected['producer_job'], 'identity', '/provisional_owner', 'Only the current producer may have a provisional local check.')
        for owner, directory in self.directories.items():
            _v_need(owner in _v_JOBS[:-1], 'global_ownership', '/inputs', 'Unknown upstream owner is forbidden.')
            try:
                root, _ = _v_directory(directory)
                identity = _v_dir_id(_v_os.lstat(root))
            except FileNotFoundError:
                continue
            _v_need(identity not in self.directory_ids, 'duplicate_owner', '/inputs/' + owner, 'Artifact directories alias another owner.')
            self.directory_ids[identity] = owner

    def provenance(self, owner):
        if owner == self.provisional_owner:
            return
        matching = [item for item in self.expected['provenance'] if item['producer_job'] == owner]
        _v_need(len(matching) == 1, 'provenance', '/expected/provenance', 'Consumer lacks unique trusted transfer provenance for a required producer.')

    def reader(self, owner):
        _v_need(owner in self.directories, 'missing_owner', '/inputs/' + owner, 'Required producer artifact is absent.')
        self.provenance(owner)
        if owner not in self.readers:
            try:
                self.readers[owner] = _v_Reader(self.directories[owner])
                self.readers[owner].expected = self.expected
                self.readers[owner].owner = owner
            except FileNotFoundError:
                raise _v_Problem('missing_owner', '/inputs/' + owner, 'Required producer artifact is absent.') from None
        return self.readers[owner]

    def account(self, reader, size, count):
        previous = self.accounted.get(reader.identity)
        _v_need(previous is None or previous == (size, count), 'writer', '/inputs', 'Transferred artifact changed its decoded size during validation.')
        if previous is None:
            _v_need(self.total_bytes + size <= _v_AGGREGATE_BYTES and self.total_files + count <= _v_AGGREGATE_FILES, 'size_limit', '/inputs', 'Distinct transferred artifacts exceed aggregate decoded limits.')
            self.accounted[reader.identity] = (size, count)
            self.total_bytes += size; self.total_files += count

    def admission(self):
        if self.admission_digest is None:
            reader = self.reader('admission')
            actual, directories = _v_scan(reader)
            _v_need(set(actual) == {'admission.json', 'admission-context.json'} and not directories, 'inventory', '/admission', 'Original admission producer contains unexpected or missing files.')
            self.account(reader, sum(item.st_size for item in actual.values()), 2)
            self.admission_digest = _v_admission(reader, self.expected)
        return self.admission_digest

    def finish(self):
        for reader in self.readers.values():
            reader.check_unchanged()
            if reader.sealed is not None:
                actual, directories = _v_scan(reader)
                _v_need(set(actual) == set(reader.sealed), 'inventory', '/inventory', 'Artifact file inventory changed before validation completed.')
                permitted_dirs = {'/'.join(path.split('/')[:i]) for path in reader.sealed for i in range(1, len(path.split('/')))}
                _v_need(directories == permitted_dirs, 'inventory', '/inventory', 'Artifact directory inventory changed before validation completed.')


def _v_copy_admission(reader, context, prefix='admission/'):
    digest = context.admission()
    source = context.reader('admission')
    for name in ('admission.json', 'admission-context.json'):
        reader.read(prefix + name, keep=False)
        _v_need(reader.records[prefix + name][1:] == source.records[name][1:], 'admission', '/' + prefix + name, 'Copied admission bytes differ from the original authenticated producer.')
    return digest


def _v_helper(reader, receipt, context):
    proofs = receipt['helper_proofs']
    _v_closed(proofs, {'legacy', 'preview'}, '/helper_proofs', 'helper_proof')
    expected, source = context.expected, context.expected['source_hashes']
    all_nodes, all_results, operations = [], [], []
    for label, selectors in (('legacy', _v_LEGACY), ('preview', _v_HELPER)):
        proof = proofs[label]
        _v_closed(proof, {'selectors', 'identity_path', 'collection', 'invocation'}, '/helper_proofs/' + label, 'helper_proof')
        _v_need(proof['selectors'] == selectors and proof['identity_path'] == label + '/identity.json', 'helper_proof', '/helper_proofs/' + label, 'Helper proof is not the complete fixed module pair.')
        for relative in (proof['collection'].get('path') if type(proof['collection']) is dict else None,
                         proof['collection'].get('process', {}).get('raw_log') if type(proof['collection']) is dict and type(proof['collection'].get('process')) is dict else None):
            _v_need(type(relative) is str and relative.startswith(label + '/'), 'helper_proof', '/helper_proofs/' + label, 'Helper raw collection is outside its separate producer prefix.')
        identity = reader.json(proof['identity_path'])
        if label == 'legacy':
            keys = {'schema_version', 'lane', 'head_sha', 'checkout_head', 'run_id', 'attempt', 'authority', 'python_version', 'selectors', 'file_hashes', 'admission_sha256'}
            _v_closed(identity, keys, '/legacy/identity.json', 'helper_proof')
            wanted = {p: source[p] for p in [*_v_LEGACY, _v_OLD, _v_ADMIT]}
            _v_need(type(identity['schema_version']) is int and identity['schema_version'] == 1 and identity['lane'] == 'ci-helper' and identity['authority'] == 'supplemental-only' and _v_string(identity['python_version']) and
                    _v_same(identity['file_hashes'], wanted) and _v_same(identity['attempt'], expected['run_attempt']), 'helper_proof', '/legacy/identity.json', 'Legacy helper identity or admitted source map differs.')
            _v_copy_admission(reader, context, 'legacy/')
        else:
            keys = {'schema_version', 'lane', 'repository', 'head_sha', 'checkout_head', 'run_id', 'run_attempt', 'selectors', 'source_hashes', 'admission_sha256'}
            _v_closed(identity, keys, '/preview/identity.json', 'helper_proof')
            wanted = {p: source[p] for p in _v_CONTROLS}
            _v_need(type(identity['schema_version']) is int and identity['schema_version'] == 1 and identity['lane'] == 'foobar-preview-helper' and identity['repository'] == _v_REPO and
                    _v_same(identity['source_hashes'], wanted) and _v_same(identity['run_attempt'], expected['run_attempt']), 'helper_proof', '/preview/identity.json', 'Preview helper identity or admitted source map differs.')
        _v_need(all(_v_same(identity[k], expected[k]) for k in ('head_sha', 'checkout_head', 'run_id')) and identity['selectors'] == selectors and identity['admission_sha256'] == context.admission(), 'helper_proof', '/' + label + '/identity.json', 'Helper proof identity or admission binding differs from the admitted exact run.')
        nodes, data = _v_collection(reader, proof['collection'], selectors, legacy=label == 'legacy')
        invocation = proof['invocation']
        _v_need(type(invocation) is dict, 'helper_proof', '/helper_proofs/' + label + '/invocation', 'Helper must have one whole-collected-suite runtime, not collection-only evidence.')
        for key in ('raw_log', 'reports_json', 'junit_xml'):
            _v_need(type(invocation.get(key)) is str and invocation[key].startswith(label + '/'), 'helper_proof', '/helper_proofs/' + label + '/invocation/' + key, 'Helper runtime raw proof is missing or outside its producer prefix.')
        result = _v_invocation(reader, invocation, nodes, 'helper', legacy=label == 'legacy')
        if label == 'legacy':
            raw_invocations = reader.json('legacy/invocations.json')
            _v_need(type(raw_invocations) is list and len(raw_invocations) == 1, 'helper_proof', '/legacy/invocations.json', 'Legacy runtime must preserve its single raw whole-suite invocation.')
            raw = raw_invocations[0]
            _v_closed(raw, _v_INVOCATION_KEYS - {'limits', 'supervisor_sha256'}, '/legacy/invocations.json/0', 'helper_proof')
            for key in raw:
                value = invocation[key]
                if key in ('id', 'raw_log', 'reports_json', 'junit_xml'):
                    value = value.removeprefix('legacy/')
                _v_need(_v_same(raw[key], value), 'helper_proof', '/legacy/invocations.json/0/' + key, 'Legacy raw invocation differs from its enclosing reference.')
            capture = reader.json('legacy/collection.capture.json')
            _v_closed(capture, {'schema_version', 'discovered_nodeids', 'nodeids', 'deselected_nodeids', 'collection_errors', 'reports'}, '/legacy/collection.capture.json', 'helper_proof')
            _v_need(type(capture['schema_version']) is int and capture['schema_version'] == 1 and capture['reports'] == [] and all(_v_same(capture[k], data[k]) for k in ('discovered_nodeids', 'nodeids', 'deselected_nodeids', 'collection_errors')), 'collection', '/legacy/collection.capture.json', 'Legacy raw collection capture is missing, incomplete or inconsistent.')
            checkout = reader.json('legacy/checkout-process.json')
            raw_keys = _v_PROCESS_KEYS - {'id', 'raw_log', 'limits', 'supervisor_sha256'}
            _v_closed(checkout, raw_keys, '/legacy/checkout-process.json', 'helper_proof')
            _v_need(all(_v_same(checkout[k], receipt['git_operations'][0][k]) for k in raw_keys) and receipt['git_operations'][0]['raw_log'] == 'legacy/checkout.log', 'helper_proof', '/legacy/checkout-process.json', 'Legacy original checkout process differs from its bound envelope.')
        else:
            _v_need(_v_same(receipt['collection'], proof['collection']) and receipt['invocations'] == [invocation] and receipt['invocation_ids'] == [invocation['id']] and receipt['assigned_ids'] == nodes, 'helper_proof', '/helper_proofs/preview', 'Top-level preview helper fields must mirror its exact single proof, not an additional execution.')
        all_nodes.extend(nodes); all_results.append(result)
        operations.extend([proof['collection']['process'], invocation])
    _v_need(len(all_nodes) == len(set(all_nodes)), 'helper_proof', '/helper_proofs', 'Helper pairs overlap execution ownership.')
    git = receipt['git_operations']
    timeline = [git[0], *operations[:2]] + ([git[1]] if len(git) == 2 else []) + operations[2:]
    _v_timeline(timeline)
    return all_nodes, all_results


def _v_receipt_identity(receipt, expected, owner):
    _v_closed(receipt, _v_RECEIPT_KEYS, '/receipt.json')
    phase = 'helper' if owner == 'helper' else 'core' if owner == 'core' else 'resource'
    _v_need(receipt['schema_version'] == 'foobar-preview-evidence-v1' and receipt['lane'] == 'foobar-preview' and receipt['phase'] == phase and receipt['job_id'] == owner and receipt['artifact_name'] == _v_name(expected, owner), 'identity', '/receipt.json', 'Receipt producer, phase or immutable artifact identity is incorrect.')
    for key in ('repository', 'head_sha', 'workflow_path', 'workflow_sha256', 'plan_sha256', 'run_id', 'run_attempt'):
        _v_need(_v_same(receipt[key], expected[key]), 'identity', '/receipt.json/' + key, 'Receipt identity differs from the independently verified checkout and run.')
    selected_hashes = {p: expected['source_hashes'][p] for p in (_v_CONTROLS if owner == 'helper' else _v_CONTROLS + _v_PRODUCTS)}
    _v_need(_v_same(receipt['source_hashes'], selected_hashes), 'source_hash', '/receipt.json/source_hashes', 'Receipt source map is not the exact admitted owner-specific map.')
    _v_need(receipt['selectors'] == (_v_HELPER if owner == 'helper' else _v_SELECTORS), 'selection', '/receipt.json/selectors', 'Receipt changed the frozen whole-module collection selectors.')
    index = int(owner[-1]) if phase == 'resource' else None
    _v_need(_v_same(receipt['shard_index'], index) and type(receipt['shard_count']) is int and receipt['shard_count'] == 4, 'selection', '/receipt.json/shard_index', 'Receipt shard ownership differs from its fixed producer.')
    for key in ('admission_sha256', 'collection_sha256'):
        _v_need(_v_hex(receipt[key]), 'identity', '/receipt.json/' + key, 'Malformed receipt proof digest.')
    for key in ('helper_receipt_sha256', 'canonical_core_sha256', 'predecessor_receipt_sha256'):
        _v_need(receipt[key] is None or _v_hex(receipt[key]), 'identity', '/receipt.json/' + key, 'Malformed nullable chain reference.')
    _v_need(type(receipt['claimed_status']) is str and receipt['claimed_status'] in _v_STATUSES, 'schema', '/receipt.json/claimed_status', 'Receipt outcome claim is malformed.')
    _v_need(type(receipt['git_operations']) is list and (1 <= len(receipt['git_operations']) <= 2 if owner == 'helper' else len(receipt['git_operations']) == 1), 'process', '/receipt.json/git_operations', 'Producer owns an invalid number of checkout probes.')
    _v_need(type(receipt['invocations']) is list and type(receipt['invocation_ids']) is list, 'invocation', '/receipt.json/invocations', 'Runtime ownership must be an ordered invocation list.')


def _v_artifact(context, owner):
    """Actual call-local artifact kernel used by public validation and CLI."""
    if owner in context.results:
        return context.results[owner]
    ids = _v_RESOURCE_IDS[(int(owner[-1])-1)*9:int(owner[-1])*9] if owner.startswith('resource_') else []
    try:
        reader = context.reader(owner)
        _v_inventory(reader, context)
        receipt = reader.json('receipt.json')
        _v_receipt_identity(receipt, context.expected, owner)
        context.receipts[owner] = receipt
        _v_need(not context.expected['cancelled'], 'cancellation', '/expected/cancelled', 'Current workflow cancellation suppresses all continuation and accepted pass accounting.')
        admission_digest = _v_copy_admission(reader, context)
        _v_need(receipt['admission_sha256'] == admission_digest, 'admission', '/receipt.json/admission_sha256', 'Receipt does not bind the original admitted snapshot.')
        selectors = _v_HELPER if owner == 'helper' else _v_SELECTORS
        full, raw_collection = _v_collection(reader, receipt['collection'], selectors, product=owner != 'helper')
        _v_need(receipt['collection_sha256'] == receipt['collection']['sha256'] and receipt['full_discovered_ids'] == raw_collection['discovered_nodeids'] and receipt['full_final_ids'] == full and receipt['collection_errors'] == raw_collection['collection_errors'] and receipt['deselected_ids'] == raw_collection['deselected_nodeids'], 'collection', '/receipt.json', 'Top-level collection fields do not mirror the retained raw collection.')
        context.collections[owner] = list(full)
        if owner == 'core':
            ids = full[:380]
        elif owner == 'helper':
            ids = list(full)
        _v_need(receipt['assigned_ids'] == ids, 'selection', '/receipt.json/assigned_ids', 'Producer assigned IDs differ from its exact canonical ownership.')
        for record in receipt['git_operations']:
            _v_process(reader, record, 10, git=True)
            _v_success(record)
            log = reader.read(record['raw_log'])[0]
            _v_need(log.decode('utf-8').strip() == context.expected['head_sha'], 'identity', '/git_operations/raw_log', 'Checkout probe did not return the exact admitted head.')
        if owner == 'helper':
            _v_need(all(receipt[key] is None for key in ('helper_receipt_sha256', 'canonical_core_sha256', 'predecessor_receipt_sha256')), 'helper_proof', '/receipt.json', 'Helper cannot claim upstream helper, core or resource receipts.')
            ids, results = _v_helper(reader, receipt, context)
        else:
            _v_need(receipt['helper_proofs'] is None, 'helper_proof', '/receipt.json/helper_proofs', 'Nonhelper may not masquerade as a helper proof producer.')
            helper = _v_artifact(context, 'helper')
            _v_need(helper['status'] == 'passed', 'helper_proof', '/inputs/helper', 'Both independently source-bound helper pairs must pass before product acceptance.')
            _v_need(receipt['helper_receipt_sha256'] == context.reader('helper').records['receipt.json'][1], 'helper_proof', '/receipt.json/helper_receipt_sha256', 'Receipt helper digest differs from the actual same-run transferred proof.')
            if owner == 'core':
                _v_need(receipt['canonical_core_sha256'] is None and receipt['predecessor_receipt_sha256'] is None, 'predecessor', '/receipt.json', 'Core has no prior canonical core or resource predecessor.')
            else:
                core = _v_artifact(context, 'core')
                index = int(owner[-1])
                predecessor = 'core' if index == 1 else 'resource_' + str(index-1)
                previous = core if predecessor == 'core' else _v_artifact(context, predecessor)
                _v_need(core['continue_allowed'] and previous['continue_allowed'], 'predecessor', '/inputs/' + predecessor, 'Complete raw predecessor chain does not permit independent continuation.')
                _v_need(receipt['canonical_core_sha256'] == context.reader('core').records['receipt.json'][1] and receipt['predecessor_receipt_sha256'] == context.reader(predecessor).records['receipt.json'][1], 'predecessor', '/receipt.json', 'Canonical core or immediate predecessor digest does not bind actual raw transferred proof.')
                core_receipt = context.receipts['core']
                _v_need(full == context.collections['core'] and receipt['collection_sha256'] == core_receipt['collection_sha256'], 'collection', '/receipt.json/collection_sha256', 'Shard full collection bytes and order differ from the canonical core collection.')
            runtimes = receipt['invocations']
            assigned_groups = [ids] if owner == 'core' else [[node] for node in ids]
            _v_need(len(runtimes) == len(assigned_groups), 'invocation', '/receipt.json/invocations', 'Runtime invocation count does not cover exact ownership once.')
            _v_need(all(type(item) is dict for item in runtimes), 'invocation', '/receipt.json/invocations', 'Malformed owned runtime record.')
            runtime_ids = [item.get('id') for item in runtimes]
            _v_need(all(_v_string(value) for value in runtime_ids) and len(runtime_ids) == len(set(runtime_ids)) and receipt['invocation_ids'] == runtime_ids, 'invocation', '/receipt.json/invocation_ids', 'Runtime IDs are absent, duplicated or out of order.')
            results = []
            for record, selection in zip(runtimes, assigned_groups):
                _v_need(record.get('selected_nodeids') == selection, 'selection', '/receipt.json/invocations', 'Runtime selection violates exact singleton or whole-core execution ownership.')
                results.append(_v_invocation(reader, record, selection, owner))
            _v_timeline([*receipt['git_operations'], receipt['collection']['process'], *runtimes])
        statuses = [result['status'] for result in results]
        derived = 'assertion_failed' if 'assertion_failed' in statuses else 'timed_out_safe' if 'timed_out_safe' in statuses else 'passed'
        _v_need(receipt['claimed_status'] == derived, 'identity', '/receipt.json/claimed_status', 'Receipt outcome claim disagrees with independently validated raw proof.')
        nodes = [node for result in results for node in result['nodes']]
        _v_need([node['nodeid'] for node in nodes] == ids and len(ids) == len(set(ids)), 'global_ownership', '/receipt.json/invocations', 'Owned execution does not cover each assigned node exactly once in order.')
        errors = [error for result in results for error in result['errors']]
        reader.check_unchanged()
        result = _v_result('artifact', owner, ids, derived, errors, nodes)
        if owner == 'helper' and derived != 'passed':
            result['continue_allowed'] = False
        context.results[owner] = result
        return result
    except Exception as problem:
        result = _v_failure('artifact', owner, ids, problem)
        # A verified complete collection can identify genuinely absent work,
        # but malformed ownership never promotes earlier green-looking proof.
        receipt = context.receipts.get(owner)
        if owner != 'helper' and owner in context.collections and type(receipt) is dict and type(receipt.get('invocations')) is list:
            runtimes = receipt['invocations']
            groups = [ids] if owner == 'core' else [[node] for node in ids]
            if len(runtimes) < len(groups) and all(type(record) is dict and record.get('selected_nodeids') == group for record, group in zip(runtimes, groups)):
                absent = {node for group in groups[len(runtimes):] for node in group}
                for node in result['nodes']:
                    if node['nodeid'] in absent:
                        node.update(status='unrun', cause='missing_invocation')
        context.results[owner] = result
        return result


def validate_artifact(evidence_dir, *, plan, expected, inputs):
    """Independently revalidate complete immutable transfers and raw ancestors."""
    owner, ids = 'core', []
    try:
        _v_check_plan(plan); _v_check_expected(expected)
        owner = expected['producer_job']
        _v_need(owner in _v_JOBS[1:-1], 'identity', '/expected/producer_job', 'Artifact validator requires a helper, core or resource owner.')
        if owner.startswith('resource_'):
            ids = _v_RESOURCE_IDS[(int(owner[-1])-1)*9:int(owner[-1])*9]
        _v_need(type(inputs) is dict and set(inputs) == set(_v_JOBS[:_v_JOBS.index(owner)]), 'predecessor', '/inputs', 'Inputs must contain exactly the fixed raw upstream ancestor roles.')
        context = _v_Context(plan, expected, {**inputs, owner: evidence_dir})
        result = _v_artifact(context, owner)
        context.finish()
        return result
    except Exception as problem:
        return _v_failure('artifact', owner, ids, problem)


def _v_global_shell(status='incomplete'):
    nodes = [{'nodeid': node, 'owner': 'resource_' + str(index // 9 + 1), 'status': 'unknown', 'cause': status} for index, node in enumerate(_v_RESOURCE_IDS)]
    result = _v_result('global', ids=_v_RESOURCE_IDS, status=status, nodes=nodes)
    result['owners'] = [{'job_id': owner, 'status': status, 'completion': 'unproven' if owner == 'reconcile' else 'incomplete', 'cause': status} for owner in _v_JOBS]
    return result


def _v_hold_expected(expected):
    """Separate terminal-diagnostic identity; never an execution admission."""
    _v_closed(expected, _v_EXPECTED_KEYS, '/expected')
    _v_need(expected['repository'] == _v_REPO and expected['workflow_path'] == _v_WORKFLOW,
            'identity', '/expected', 'Unexpected hold repository or workflow.')
    _v_need(_v_hex(expected['head_sha'], 40) and expected['checkout_head'] == expected['head_sha'],
            'identity', '/expected/checkout_head', 'Hold checkout must match the exact head.')
    _v_need(type(expected['run_id']) is int and expected['run_id'] > 0 and
            type(expected['run_attempt']) is int and expected['run_attempt'] == 1 and
            expected['producer_job'] == 'reconcile', 'identity', '/expected',
            'Only first-attempt reconciliation may diagnose an initial hold.')
    _v_need(type(expected['cancelled']) is bool, 'schema', '/expected/cancelled', 'Cancellation must be independently observed.')
    for key in ('workflow_sha256', 'plan_sha256'):
        _v_need(_v_hex(expected[key]), 'identity', '/expected/' + key, 'Malformed source digest.')
    hashes = expected['source_hashes']
    _v_closed(hashes, _v_CONTROLS + _v_PRODUCTS, '/expected/source_hashes', 'source_hash')
    _v_need(all(_v_hex(value) for value in hashes.values()), 'source_hash', '/expected/source_hashes', 'Malformed source digest.')
    _v_need(hashes[_v_OLD] == _v_SUPERVISOR and hashes[_v_PLAN] == expected['plan_sha256'] and
            hashes[_v_WORKFLOW] == expected['workflow_sha256'], 'identity', '/expected/source_hashes', 'Inconsistent source binding.')
    provenance = expected['provenance']
    _v_need(type(provenance) is list and len(provenance) == 1, 'provenance', '/expected/provenance',
            'An initial hold requires exactly the original admission artifact, no downstream execution.')
    record = provenance[0]
    _v_closed(record, {'producer_job', 'artifact_name', 'artifact_id', 'repository', 'head_sha',
                      'workflow_path', 'run_id', 'run_attempt'}, '/expected/provenance/0', 'provenance')
    _v_need(record['producer_job'] == 'admission' and type(record['artifact_id']) is int and record['artifact_id'] > 0 and
            record['artifact_name'] == _v_name(expected, 'admission') and
            all(_v_same(record[key], expected[key]) for key in ('repository', 'head_sha', 'workflow_path', 'run_id', 'run_attempt')),
            'provenance', '/expected/provenance/0', 'Original admission provenance differs from the exact held attempt.')


def _v_hold_pair(input_dir, expected):
    root, stamps = _v_directory(input_dir)
    root_before = _v_stat_id(_v_os.lstat(root))
    names = []
    with _v_os.scandir(root) as entries:
        for entry in entries:
            _v_need(len(names) < 7 and entry.name in _v_JOBS[:-1], 'global_ownership', '/inputs', 'Unexpected initial-hold owner.')
            names.append(entry.name)
    _v_need(names == ['admission'], 'global_ownership', '/inputs', 'Initial hold cannot contain downstream execution artifacts.')
    reader = _v_Reader(root / 'admission')
    admission_before = _v_stat_id(_v_os.lstat(reader.root))
    found, directories = _v_scan(reader)
    _v_need(set(found) == {'admission.json', 'admission-context.json'} and not directories,
            'admission', '/inputs/admission', 'Initial admission must retain exactly the original two files.')
    pair = {name: reader.read(name)[0] for name in ('admission.json', 'admission-context.json')}
    data = _v_decode(pair['admission.json'], '/admission.json')
    context = _v_decode(pair['admission-context.json'], '/admission-context.json')
    _v_closed(context, {'schema_version', 'repository', 'head_sha', 'run_id', 'attempt', 'admission_sha256'}, '/admission-context.json', 'admission')
    _v_need(type(context['schema_version']) is int and context['schema_version'] == 1 and
            all(_v_same(context[key], expected[key]) for key in ('repository', 'head_sha', 'run_id')) and
            _v_same(context['attempt'], expected['run_attempt']) and context['admission_sha256'] == reader.records['admission.json'][1],
            'admission', '/admission-context.json', 'Original hold sidecar does not bind this exact snapshot and attempt.')
    _v_closed(data, {'schema_version', 'authority', 'coverage', 'observed_at', 'decision', 'reason_codes',
                     'trigger', 'current', 'native', 'inspected'}, '/admission.json', 'admission')
    _v_need(type(data['schema_version']) is int and data['schema_version'] == 1 and
            data['authority'] == 'supplemental-only' and data['coverage'] == 'unproven' and
            data['decision'] == 'hold' and data['reason_codes'] == ['initial-attempt'] and
            data['current'] is None and data['native'] is None and data['inspected'] == [],
            'admission', '/admission.json', 'Snapshot is not the unchanged original initial-attempt hold.')
    _v_stamp(data['observed_at'], '/admission.json/observed_at')
    entry = data['trigger']
    _v_closed(entry, {'repository', 'number', 'branch', 'head_sha', 'draft', 'control_labels', 'all_labels'}, '/admission.json/trigger', 'admission')
    _v_need(entry['repository'] == _v_REPO and entry['head_sha'] == expected['head_sha'] and
            entry['branch'] == '2026-10-03-album-tops' and type(entry['number']) is int and entry['number'] > 0 and
            type(entry['draft']) is bool, 'admission', '/admission.json/trigger', 'Invalid held pull-request identity.')
    labels = entry['all_labels']
    _v_need(type(labels) is list and all(_v_string(label) and label == label.strip() for label in labels) and
            labels == sorted(set(labels)), 'admission', '/admission.json/trigger/all_labels', 'Malformed normalized labels.')
    controls = {'run_reviews', 'skip_tests', 'ci:full-review', 'ci:focused-e2e', 'ci:focused-related'}
    _v_need(entry['control_labels'] == [name for name in labels if name in controls or name.startswith(('ci:e2e:', 'ci:e2e-performance:'))],
            'admission', '/admission.json/trigger/control_labels', 'Inconsistent control-label normalization.')
    reader.check_unchanged()
    _v_need(_v_stat_id(_v_os.lstat(root)) == root_before and
            _v_stat_id(_v_os.lstat(reader.root)) == admission_before, 'writer', '/inputs', 'Held directory inventory changed during validation.')
    for path, stamp in stamps:
        _v_need(_v_dir_id(_v_os.lstat(path)) == stamp, 'path', '/inputs', 'Hold input ownership changed.')
    return data, pair


def _v_hold_diagnostic(problem=None, *, cancelled=False, raw_held=False):
    status = 'cancelled' if cancelled else 'incomplete' if problem is None else _v_status(_v_error(problem)['code'])
    result = _v_global_shell(status)
    problem = (_v_Problem('cancellation', '/expected/cancelled', 'Cancellation suppresses initial-hold authentication.')
               if cancelled else problem or _v_Problem('missing_owner', '/admission',
                   'Raw initial-attempt hold is not execution admission; transfer, completed stages and downstream nonexecution remain unproven.'
                   if raw_held else 'Initial admission acquisition or verification is unavailable; no hold authentication or downstream nonexecution is proved.'))
    result['errors'] = [_v_error(problem, 'admission')]
    for node in result['nodes']:
        node['cause'] = 'initial_hold_provenance_unproven'
    for owner in result['owners']:
        owner['cause'] = 'cancellation' if cancelled else 'initial_hold_provenance_unproven'
    return result


def _v_reconcile_hold(input_dir, plan, expected):
    try:
        _v_check_plan(plan)
        _v_hold_expected(expected)
        _v_need(not expected['cancelled'], 'cancellation', '/expected/cancelled', 'Cancellation suppresses initial-hold authentication.')
        _v_hold_pair(input_dir, expected)
        return _v_hold_diagnostic(raw_held=True)
    except Exception as problem:
        return _v_hold_diagnostic(problem, cancelled=isinstance(problem, _v_Problem) and problem.code == 'cancellation')


def reconcile_artifacts(input_dir, *, plan, expected):
    """Read only seven fixed transfers. The computed result is not upload proof."""
    if type(expected) is dict and type(expected.get('run_attempt')) is int and expected['run_attempt'] == 1:
        return _v_reconcile_hold(input_dir, plan, expected)
    result = _v_global_shell()
    try:
        _v_check_plan(plan); _v_check_expected(expected, 'reconcile')
        root, root_stamps = _v_directory(input_dir)
        directories, seen = {}, set()
        with _v_os.scandir(root) as entries:
            for entry in entries:
                _v_need(entry.name in _v_JOBS[:-1], 'global_ownership', '/inputs', 'Unexpected owner directory or prior reconciliation output is forbidden.')
                info = _v_os.lstat(root / entry.name)
                _v_need(_v_stat.S_ISDIR(info.st_mode) and not _v_stat.S_ISLNK(info.st_mode), 'path', '/inputs/' + entry.name, 'Producer inputs must be unlinked directories.')
                identity = _v_dir_id(info)
                _v_need(identity not in seen, 'duplicate_owner', '/inputs/' + entry.name, 'Two producer owners alias the same directory.')
                seen.add(identity); directories[entry.name] = root / entry.name
        context = _v_Context(plan, expected, directories)
        errors, owners = [], []
        try:
            context.admission()
            _v_need(not expected['cancelled'], 'cancellation', '/expected/cancelled', 'Current cancellation suppresses global acceptance.')
            owners.append({'job_id': 'admission', 'status': 'passed', 'completion': 'complete', 'cause': None})
        except Exception as problem:
            error = _v_error(problem, 'admission'); errors.append(error)
            owners.append({'job_id': 'admission', 'status': _v_status(error['code']), 'completion': 'incomplete', 'cause': error['code']})
        results = {}
        for owner in _v_JOBS[1:-1]:
            if owner not in directories:
                error = _v_error(_v_Problem('missing_owner', '/inputs/' + owner, 'Required producer artifact is absent.'), owner)
                errors.append(error)
            results[owner] = _v_artifact(context, owner)
            errors.extend(results[owner]['errors'])
            owners.extend(results[owner]['owners'])
        canonical = context.collections.get('core')
        if canonical is None:
            ids = list(_v_RESOURCE_IDS)
            errors.append(_v_error(_v_Problem('collection', '/inputs/core/collection', 'Canonical core collection is unavailable; no core node identities are invented.'), 'core'))
        else:
            ids = list(canonical)
        node_map = {}
        for owner in _v_JOBS[2:-1]:
            for node in results[owner]['nodes']:
                _v_need(node['nodeid'] not in node_map, 'global_ownership', '/nodes', 'A node has more than one execution owner.')
                node_map[node['nodeid']] = dict(node)
        nodes = []
        for node in ids:
            owner = 'core' if node.startswith(_v_CORE + '::') else 'resource_' + str(_v_RESOURCE_IDS.index(node) // 9 + 1)
            if node in node_map and node_map[node]['owner'] == owner:
                nodes.append(node_map[node])
            else:
                nodes.append({'nodeid': node, 'owner': owner, 'status': 'unrun' if owner not in directories else 'unknown', 'cause': 'missing_owner' if owner not in directories else 'invalid_ownership'})
        helper_good = results['helper']['status'] == 'passed'
        if not helper_good:
            for node in nodes:
                node.update(status='unknown', cause='helper_failed')
            if not any(error['code'] == 'helper_proof' for error in errors):
                errors.append(_v_error(_v_Problem('helper_proof', '/inputs/helper', 'Global product acceptance requires both complete helper pairs passing.'), 'helper'))
        all_status = [entry['status'] for entry in owners]
        unsafe = [value for value in all_status if value not in _v_SAFE]
        if expected['cancelled']:
            status = 'cancelled'
            for node in nodes:
                node.update(status='unknown', cause='cancelled')
        elif unsafe or canonical is None or not helper_good:
            status = 'incomplete'
        elif 'assertion_failed' in all_status:
            status = 'assertion_failed'
        elif 'timed_out_safe' in all_status:
            status = 'timed_out_safe'
        else:
            status = 'passed'
        if status == 'passed':
            _v_need(not errors and [node['nodeid'] for node in nodes if node['status'] == 'passed'] == ids and len(ids) == 416, 'global_ownership', '/nodes', 'Global success requires every canonical node passed once under its rightful owner.')
        elif not errors:
            errors.append(_v_error(_v_Problem('global_ownership', '/nodes', 'Global evidence remains incomplete.')))
        owners.append({'job_id': 'reconcile', 'status': status, 'completion': 'unproven', 'cause': None if status == 'passed' else status})
        result = _v_result('global', ids=ids, status=status, errors=errors, nodes=nodes)
        result['owners'] = owners
        context.finish()
        for parent, stamp in root_stamps:
            _v_need(_v_dir_id(_v_os.lstat(parent)) == stamp, 'path', '/inputs', 'Input parent identity changed during reconciliation.')
        with _v_os.scandir(root) as entries:
            _v_need({entry.name for entry in entries} == set(directories), 'global_ownership', '/inputs', 'Producer input inventory changed during reconciliation.')
        return result
    except Exception as problem:
        error = _v_error(problem)
        result = _v_global_shell(_v_status(error['code']))
        result['errors'] = [error]
        return result


def _v_legacy_gate(reader, proof, expected, git):
    """Product-free prebootstrap gate; no legacy reconciliation summary authority.

    The producer supplies copied unchanged raw files. They remain provisional
    until sealed/uploaded and revalidated by the full consumer artifact seam.
    """
    _v_check_expected(expected)
    _v_closed(proof, {'selectors', 'identity_path', 'collection', 'invocation'}, '/helper_proofs/legacy', 'helper_proof')
    _v_need(proof['selectors'] == _v_LEGACY and proof['identity_path'] == 'legacy/identity.json', 'helper_proof', '/helper_proofs/legacy', 'Bootstrap must use both complete unchanged helper modules.')
    local_admission = _v_Reader(reader.root / 'admission')
    old_admission = _v_Reader(reader.root / 'legacy')
    admitted = _v_admission(local_admission, expected)
    _v_need(_v_admission(old_admission, expected) == admitted, 'admission', '/legacy/admission.json', 'Legacy admission snapshot differs from the current admitted producer copy.')
    for name in ('admission.json', 'admission-context.json'):
        _v_need(local_admission.records[name][1:] == old_admission.records[name][1:], 'admission', '/legacy/' + name, 'Legacy admission pair is not an unchanged copy.')
    identity = reader.json('legacy/identity.json')
    _v_closed(identity, {'schema_version', 'lane', 'head_sha', 'checkout_head', 'run_id', 'attempt', 'authority', 'python_version', 'selectors', 'file_hashes', 'admission_sha256'}, '/legacy/identity.json', 'helper_proof')
    _v_need(type(identity['schema_version']) is int and identity['schema_version'] == 1 and identity['lane'] == 'ci-helper' and identity['authority'] == 'supplemental-only' and _v_string(identity['python_version']) and identity['selectors'] == _v_LEGACY and identity['admission_sha256'] == admitted and _v_same(identity['attempt'], expected['run_attempt']) and all(_v_same(identity[key], expected[key]) for key in ('head_sha', 'checkout_head', 'run_id')), 'helper_proof', '/legacy/identity.json', 'Legacy identity does not match the admitted whole-suite run.')
    _v_need(_v_same(identity['file_hashes'], {p: expected['source_hashes'][p] for p in [*_v_LEGACY, _v_OLD, _v_ADMIT]}), 'helper_proof', '/legacy/identity.json/file_hashes', 'Legacy helper source identity changed.')
    nodes, raw_collection = _v_collection(reader, proof['collection'], _v_LEGACY, legacy=True)
    result = _v_invocation(reader, proof['invocation'], nodes, 'helper', legacy=True)
    _v_need(result['status'] == 'passed', 'helper_proof', '/legacy/invocations.json', 'Legacy helper runtime did not pass all complete raw proof checks.')
    invocation = proof['invocation']
    raw_invocations = reader.json('legacy/invocations.json')
    _v_need(type(raw_invocations) is list and len(raw_invocations) == 1, 'helper_proof', '/legacy/invocations.json', 'Legacy helper needs exactly one whole-suite invocation.')
    _v_closed(raw_invocations[0], _v_INVOCATION_KEYS - {'limits', 'supervisor_sha256'}, '/legacy/invocations.json/0', 'helper_proof')
    for key, value in raw_invocations[0].items():
        wanted = invocation[key]
        if key in ('id', 'raw_log', 'reports_json', 'junit_xml'):
            wanted = wanted.removeprefix('legacy/')
        _v_need(_v_same(value, wanted), 'helper_proof', '/legacy/invocations.json/0/' + key, 'Legacy raw invocation differs from its enclosing reference.')
    capture = reader.json('legacy/collection.capture.json')
    _v_closed(capture, {'schema_version', 'discovered_nodeids', 'nodeids', 'deselected_nodeids', 'collection_errors', 'reports'}, '/legacy/collection.capture.json', 'collection')
    _v_need(type(capture['schema_version']) is int and capture['schema_version'] == 1 and capture['reports'] == [] and all(_v_same(capture[key], raw_collection[key]) for key in ('discovered_nodeids', 'nodeids', 'deselected_nodeids', 'collection_errors')), 'collection', '/legacy/collection.capture.json', 'Legacy collection capture does not reconcile.')
    _v_process(reader, git, 10, git=True); _v_success(git)
    _v_need(git['raw_log'] == 'legacy/checkout.log' and reader.read(git['raw_log'])[0].decode('utf-8').strip() == expected['head_sha'], 'identity', '/legacy/checkout.log', 'Legacy checkout is not the admitted exact head.')
    checkout = reader.json('legacy/checkout-process.json')
    keys = _v_PROCESS_KEYS - {'id', 'raw_log', 'limits', 'supervisor_sha256'}
    _v_closed(checkout, keys, '/legacy/checkout-process.json', 'helper_proof')
    _v_need(all(_v_same(checkout[key], git[key]) for key in keys), 'helper_proof', '/legacy/checkout-process.json', 'Legacy raw checkout process differs from the envelope.')
    _v_timeline([git, proof['collection']['process'], invocation])
    local_admission.check_unchanged(); old_admission.check_unchanged(); reader.check_unchanged()
    return result


if __name__ == '__main__':
    raise SystemExit(_main())
