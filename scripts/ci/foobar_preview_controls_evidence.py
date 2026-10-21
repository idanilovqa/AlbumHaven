"""Finite supplemental controls owner. Import is inert; the validator is read-only.

The five direct commands are the entire owned process surface. A local result
never certifies hosted upload, post-actions, encoded bounds or native coverage.
"""
import argparse
from datetime import datetime
import hashlib
import importlib.machinery
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import sys
import time
import xml.etree.ElementTree as ET

_REPO = 'idanilovqa/AlbumHaven'
_BRANCH = '2026-10-03-album-tops'
_WORKFLOW = '.github/workflows/foobar-preview-validation-controls.yml'
_SELF = 'scripts/ci/foobar_preview_controls_evidence.py'
_SUBJECT_WORKFLOW = '.github/workflows/foobar-preview-backend-evidence.yml'
_PYTHON_FILE = 'tests/ci/foobar_preview_validation_controls_cases.py'
_NODE_FILE = 'tests/ci/foobar_preview_transfer_literal_cases.cjs'
_OLD = 'scripts/ci/new_feature_evidence.py'
_ADMISSION = 'scripts/ci/admit-new-feature-evidence.py'
_OLD_SHA = '8f45a3c1c3ada77a817928463527fb4add58f57f70a2d3f24cc9187cf5fb3673'
_LITERAL_SHA = '65a5239082ab154affd06ec85183a5ecd451d630954e43d8aeb04ca46eebbe90'
_PRIMITIVES = ('run_owned', 'process_success', 'node_list', 'timestamp', 'owned_file')
_IDS = ('git', 'python_collection', 'python_runtime', 'node_inventory', 'node_runtime')
_RUNTIMES = (10, 60, 180, 60, 180)
_FILE, _BYTES, _FILES = 33554432, 268435456, 4096
_SOURCE_PATHS = (
    '.github/workflows/foobar-preview-backend-evidence.yml',
    '.github/workflows/new-feature-backend-evidence.yml',
    'scripts/ci/admit-new-feature-evidence.py', 'scripts/ci/new_feature_evidence.py',
    'scripts/ci/foobar_preview_evidence.py', 'scripts/ci/foobar_preview_plan.json',
    'tests/py/test_new_feature_ci_contract.py', 'tests/py/test_new_feature_evidence.py',
    'tests/py/test_foobar_preview_ci_contract.py', 'tests/py/test_foobar_preview_evidence.py',
    'music_app/services/foobar_snapshot_parser.py', 'music_app/services/foobar_snapshot_preview.py',
    'tests/py/test_foobar_snapshot_preview.py', 'tests/py/test_foobar_snapshot_preview_resources.py',
    '.github/workflows/foobar-preview-validation-controls.yml',
    'scripts/ci/foobar_preview_controls_evidence.py',
    'tests/ci/foobar_preview_validation_controls_cases.py',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs', 'requirements.txt',
)
_EXPECTED_KEYS = {'repository', 'head_sha', 'checkout_head', 'workflow_path', 'job_id',
    'run_id', 'run_attempt', 'cancelled', 'root', 'git_executable', 'python_executable',
    'node_executable', 'python_version', 'node_version', 'source_hashes', 'event_sha256',
    'admission_sha256', 'admission_context_sha256', 'bootstrap_sha256', 'transfer_literal_sha256'}
_PROCESS_KEYS = {'argv', 'exit_code', 'timed_out', 'cleanup_complete', 'writer_errors',
                 'cancelled', 'started_at', 'finished_at'}
_ROOT_FILES = {'context.json', 'receipt.json', 'inventory.json', 'complete.json',
               'event.json', 'admission.json', 'admission-context.json', 'empty-pytest.ini'}
# The source-reviewed tuple and pins below are generated once from accepted
# documentation/afterimages, never from a runtime subject's returned registry.
_NODE_IDS = (
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::positive_helper_exact_artifact',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::positive_reconcile_complete_chain',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::two_anonymous_metadata_requests',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::raw_acquisition_bytes_and_digests',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::public_api_and_blob_no_authorization',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::artifact_service_only_synthetic_token',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::metadata_non200',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::artifact_service_non200',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::blob_non200',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::metadata_link_header',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::metadata_location_header',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::redirect_no_follow',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::compressed_response',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::stream_error',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::stream_aborted',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::incomplete_stream',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::request_timeout',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::cancellation',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::shared_deadline_not_reset',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::request_deadline_at_10_seconds',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::request_deadline_over_10_seconds',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::shared_deadline_before_110_seconds',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::shared_deadline_at_110_seconds',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::no_retry_or_credential_fallback',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::metadata_declared_exact_limit',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::metadata_declared_over_limit',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::metadata_chunked_over_limit',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::metadata_aggregate_exact_limit',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::metadata_aggregate_over_limit',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::blob_declared_over_capacity',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::blob_chunked_over_capacity',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::actual_length_short',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::actual_length_long',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::invalid_utf8',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::nonfinite_exponent_positive',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::nonfinite_exponent_negative',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::nonfinite_literal',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::wrong_artifact_owner',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::wrong_artifact_name',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::wrong_artifact_run',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::wrong_artifact_id',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::wrong_artifact_digest',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::duplicate_artifact_ids',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::unsupported_signed_host',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::request_pull_64k_bound',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::buffer_capacity_bound',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::fixture_file_read_64k_bound',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::fixture_file_mutation_during_read',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::fixture_symlink_rejected',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::archive_aggregate_over_limit',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::retained_outputs_no_bearer',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::retained_outputs_no_signed_url',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::missing_upload_outputs_reconcile_explicit_absence',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::missing_upload_outputs_producer_holds',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::partial_upload_identity_rejected',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::fixture_forbidden_effect_attempt_survives_catch',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::fixture_unlisted_module_denied',
    'tests/ci/foobar_preview_transfer_literal_cases.cjs::fixture_host_environment_not_exposed',
)
_SOURCE_PINS = {'.github/workflows/foobar-preview-backend-evidence.yml': 'c5cccbcbdfdbe85ce637fdc454a7f2c786d227d080c0814e5d08b707d8707726',
 '.github/workflows/new-feature-backend-evidence.yml': 'f4b10af233a2544a28eae486d22435e66a19fdbce0f56648a09bd308484885f9',
 'scripts/ci/admit-new-feature-evidence.py': '90641268ec59f81ff185389e881db6d1305aee89e9c25a95a0c3f64297bbe2d6',
 'scripts/ci/new_feature_evidence.py': '8f45a3c1c3ada77a817928463527fb4add58f57f70a2d3f24cc9187cf5fb3673',
 'scripts/ci/foobar_preview_evidence.py': '4749e4884526e68299548e48eabd8e5780ba3722f921134df06b922b80bbac3d',
 'scripts/ci/foobar_preview_plan.json': '268da6db28d96ca0174998259b15cba2dd10ec80bb3c20b176b8c4a55a831d72',
 'tests/py/test_new_feature_ci_contract.py': '9bb543abfb0b3c2940607be73f517d93107bf757c37929a651091b3c7c410da3',
 'tests/py/test_new_feature_evidence.py': '5611972c0fc88fae2433f974bf283e5be6f21a6a3ebac4754fa8449ac6aad847',
 'tests/py/test_foobar_preview_ci_contract.py': '7241c03e61eefe8c925f47d354515c1901592f3c8b5c7d6ec9611d8c616de01b',
 'tests/py/test_foobar_preview_evidence.py': 'e0772fef33850f4cdbd3f2d5661c2351f4e881a0ef5b1c85ac39a17502aa9002',
 'music_app/services/foobar_snapshot_parser.py': '3348d8c4980125daa82036deb90117dd35ff443f7950ada382d59a449e7728e3',
 'tests/ci/foobar_preview_validation_controls_cases.py': '769d5c1fd716d5429e903b48978b8b5c784a8ae80aafec48da92d5d7047591ea',
 'tests/ci/foobar_preview_transfer_literal_cases.cjs': 'b30698c8be4385aa72a12924a2435b0cbe3f821e32ca339126f7c951f5211b61',
 'requirements.txt': '018d1e446b65f3730ef877e68b23ecbe62b22273fb2bc3cc6a637458a37dbee7'}

_SOURCE_PINS.update({
    'music_app/services/foobar_snapshot_preview.py': '4b053caa1e6b5835f2fb2fe381c4694b8ee327a3d0771a61bfe8bbc793231f7b',
    'tests/py/test_foobar_snapshot_preview.py': '4940dca3e6d818129c5b3aff204761c2460c8ac0c9340f089f08041d1a5a5fe6',
    'tests/py/test_foobar_snapshot_preview_resources.py': '9d0aebeabee2cca98a114ee75a913fa8ea45ffa13defe52ae322aa291ba444b4',
})


class _Problem(Exception):
    def __init__(self, code, location, message='Required evidence invariant is not satisfied.'):
        self.code, self.location, self.message = code, location, message
        super().__init__(message)


def _need(condition, code='schema', location='/'):
    if not condition:
        raise _Problem(code, location)


def _closed(value, keys, location='/', code='schema'):
    _need(type(value) is dict and set(value) == set(keys), code, location)


def _same(a, b):
    if type(a) is not type(b):
        return False
    if type(a) is dict:
        return a.keys() == b.keys() and all(_same(a[k], b[k]) for k in a)
    if type(a) is list:
        return len(a) == len(b) and all(_same(x, y) for x, y in zip(a, b))
    return a == b


def _hex(value, width=64):
    return type(value) is str and re.fullmatch('[0-9a-f]{' + str(width) + '}', value) is not None


def _positive(value):
    return type(value) is int and value > 0


def _stamp(value, location='/timestamp'):
    _need(type(value) is str and 1 <= len(value) <= 64, 'deadline', location)
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
        _need(result.utcoffset() is not None, 'deadline', location)
        return result
    except (ValueError, OverflowError):
        raise _Problem('deadline', location) from None


def _json(data, location='/'):
    def pairs(items):
        result = {}
        for key, value in items:
            _need(key not in result, 'schema', location)
            result[key] = value
        return result
    def finite(value):
        result = float(value)
        _need(math.isfinite(result), 'schema', location)
        return result
    def forbidden(value):
        raise _Problem('schema', location)
    try:
        return json.loads(data.decode('utf-8'), object_pairs_hook=pairs,
                          parse_float=finite, parse_constant=forbidden)
    except (ValueError, UnicodeError, RecursionError, OverflowError):
        raise _Problem('schema', location) from None


def _digest(data):
    return hashlib.sha256(data).hexdigest()


def _relative(value):
    _need(type(value) is str and value and not any(c in value for c in ('\\', ':', '\x00')),
          'path', '/path')
    _need(all(x not in ('', '.', '..') for x in value.split('/')), 'path', '/path')
    return value


def _stat_id(s):
    return s.st_dev, s.st_ino, s.st_mode, s.st_nlink, s.st_size, s.st_mtime_ns, s.st_ctime_ns


def _confined(root, relative):
    relative = _relative(relative)
    root = Path(root)
    _need(root.is_absolute(), 'path', '/root')
    # Inspect every component, not merely the final path. No symlink ancestor
    # may lend authority to a file inside an otherwise plausible directory.
    path = Path(root.anchor)
    for part in root.parts[1:]:
        path /= part
        info = os.lstat(path)
        _need(stat.S_ISDIR(info.st_mode), 'path', '/root')
    for index, part in enumerate(relative.split('/')):
        path /= part
        info = os.lstat(path)
        if index < len(relative.split('/')) - 1:
            _need(stat.S_ISDIR(info.st_mode), 'path', '/' + relative)
        else:
            _need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'path', '/' + relative)
    return path


def _open_directory(path):
    path = Path(path)
    _need(path.is_absolute() and '..' not in path.parts, 'path', '/directory')
    descriptor = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor); descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _read_file(path, maximum=_FILE):
    path = Path(path)
    before = os.lstat(path)
    _need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, 'path', '/file')
    _need(0 <= before.st_size <= maximum, 'size_limit', '/file')
    parent = _open_directory(path.parent)
    try:
        descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    finally:
        os.close(parent)
    try:
        opened = os.fstat(descriptor)
        _need(_stat_id(opened) == _stat_id(before), 'path', '/file')
        chunks, remaining = [], before.st_size
        while remaining:
            chunk = os.read(descriptor, min(65536, remaining))
            _need(bool(chunk), 'writer', '/file')
            chunks.append(chunk); remaining -= len(chunk)
        _need(not os.read(descriptor, 1), 'writer', '/file')
        _need(_stat_id(os.fstat(descriptor)) == _stat_id(before), 'writer', '/file')
        _need(_stat_id(os.lstat(path)) == _stat_id(before), 'writer', '/file')
        return b''.join(chunks), _stat_id(before)
    finally:
        os.close(descriptor)


class _Reader:
    def __init__(self, root):
        self.root = Path(root)
        _need(self.root.is_absolute(), 'path', '/root')
        current = Path(self.root.anchor)
        for part in self.root.parts[1:]:
            current /= part
            _need(stat.S_ISDIR(os.lstat(current).st_mode), 'path', '/root')
        info = os.lstat(self.root)
        _need(stat.S_ISDIR(info.st_mode), 'path', '/root')
        self.root_identity = (info.st_dev, info.st_ino)
        self.records = {}

    def read(self, relative):
        try:
            path = _confined(self.root, relative)
            raw, identity = _read_file(path)
        except FileNotFoundError:
            raise _Problem('missing', '/' + str(relative)) from None
        entry = (identity, _digest(raw), len(raw))
        _need(relative not in self.records or self.records[relative] == entry, 'writer', '/' + relative)
        self.records[relative] = entry
        return raw

    def json(self, relative):
        return _json(self.read(relative), '/' + relative)

    def scan(self):
        found, dirs, stack, total = {}, set(), [(self.root, '')], 0
        while stack:
            directory, prefix = stack.pop()
            descriptor = _open_directory(directory)
            try:
                with os.scandir(descriptor) as entries:
                    batch = []
                    for entry in entries:
                        _need(len(batch) < _FILES * 2, 'size_limit', '/inventory')
                        batch.append((entry.name, entry.stat(follow_symlinks=False)))
            finally:
                os.close(descriptor)
            for entry_name, info in batch:
                relative = prefix + entry_name
                _relative(relative)
                if stat.S_ISDIR(info.st_mode):
                    dirs.add(relative)
                    _need(len(dirs) <= _FILES, 'size_limit', '/inventory')
                    stack.append((directory / entry_name, relative + '/'))
                else:
                    _need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'path', '/' + relative)
                    _need(info.st_size <= _FILE, 'size_limit', '/' + relative)
                    found[relative] = _stat_id(info); total += info.st_size
                    _need(len(found) <= _FILES and total <= _BYTES, 'size_limit', '/inventory')
        return found, dirs

    def finish(self):
        info = os.lstat(self.root)
        _need(stat.S_ISDIR(info.st_mode) and (info.st_dev, info.st_ino) == self.root_identity, 'writer', '/root')
        for name, (identity, _, _) in self.records.items():
            _need(_stat_id(os.lstat(_confined(self.root, name))) == identity, 'writer', '/' + name)


def _expected(expected):
    _closed(expected, _EXPECTED_KEYS, '/expected', 'identity')
    _need(expected['repository'] == _REPO and expected['workflow_path'] == _WORKFLOW and
          expected['job_id'] == 'validation_controls', 'identity', '/expected')
    _need(_hex(expected['head_sha'], 40) and expected['head_sha'] == expected['checkout_head'], 'identity', '/expected/head_sha')
    _need(_positive(expected['run_id']) and type(expected['run_attempt']) is int and
          expected['run_attempt'] >= 2 and type(expected['cancelled']) is bool, 'identity', '/expected/run_id')
    for key in ('root', 'git_executable', 'python_executable', 'node_executable'):
        _need(type(expected[key]) is str and '\x00' not in expected[key] and Path(expected[key]).is_absolute(), 'identity', '/expected/' + key)
    _need(type(expected['python_version']) is str and re.fullmatch(r'3\.11\.\d+(?:[^\r\n]*)', expected['python_version']), 'identity', '/expected/python_version')
    _need(type(expected['node_version']) is str and re.fullmatch(r'v20\.\d+\.\d+', expected['node_version']), 'identity', '/expected/node_version')
    _closed(expected['source_hashes'], _SOURCE_PATHS, '/expected/source_hashes', 'source_hash')
    _need(all(_hex(v) for v in expected['source_hashes'].values()), 'source_hash', '/expected/source_hashes')
    for key in ('event_sha256', 'admission_sha256', 'admission_context_sha256', 'bootstrap_sha256', 'transfer_literal_sha256'):
        _need(_hex(expected[key]), 'identity', '/expected/' + key)
    return {k: v for k, v in expected.items() if k != 'cancelled'}


def _admission(event, admission, context, expected):
    """Independently replay the original finite admission policy over raw views."""
    loc = '/admission.json'
    def check(value):
        _need(value, 'admission', loc)
    def normalized(pr):
        check(type(pr) is dict and type(pr.get('head')) is dict and type(pr['head'].get('repo')) is dict)
        check(_positive(pr.get('number')) and type(pr.get('draft')) is bool and pr.get('state') == 'open')
        head = pr['head']
        check(head.get('sha') == expected['head_sha'] and head.get('ref') == _BRANCH and head['repo'].get('full_name') == _REPO)
        labels = pr.get('labels')
        check(type(labels) is list and all(type(x) is dict and type(x.get('name')) is str for x in labels))
        names = sorted({x['name'].strip() for x in labels if x['name'].strip()})
        controls = [x for x in names if x in ('run_reviews', 'skip_tests', 'ci:full-review', 'ci:focused-e2e', 'ci:focused-related') or x.startswith(('ci:e2e:', 'ci:e2e-performance:'))]
        return {'repository': _REPO, 'number': pr['number'], 'branch': _BRANCH, 'head_sha': head['sha'], 'draft': pr['draft'], 'control_labels': controls, 'all_labels': names}
    check(type(event) is dict and type(event.get('repository')) is dict and event['repository'].get('full_name') == _REPO)
    check(event.get('action') in ('opened', 'synchronize', 'reopened', 'ready_for_review', 'labeled', 'unlabeled'))
    trigger = normalized(event.get('pull_request'))
    check(type(event.get('number')) is int and event['number'] == trigger['number'])
    wanted = {'schema_version': 1, 'repository': _REPO, 'head_sha': expected['head_sha'], 'run_id': expected['run_id'],
              'attempt': expected['run_attempt'], 'admission_sha256': expected['admission_sha256'],
              'event_sha256': expected['event_sha256'], 'workflow_path': _WORKFLOW, 'job_id': 'validation_controls'}
    check(_same(context, wanted))
    check(type(admission) is dict and type(admission.get('schema_version')) is int and admission['schema_version'] == 1)
    check(admission.get('decision') == 'admit' and admission.get('reason_codes') == [] and
          admission.get('authority') == 'supplemental-only' and admission.get('coverage') == 'unproven')
    observed = _stamp(admission.get('observed_at'), loc)
    inspections = admission.get('inspected')
    check(type(inspections) is list and 6 <= len(inspections) <= 24)
    cursor, last = 0, observed
    def read(route):
        nonlocal cursor, last
        check(cursor < len(inspections))
        item = inspections[cursor]; cursor += 1
        check(type(item) is dict and set(item) == {'url', 'fetched_at', 'body'})
        check(item['url'] == 'https://api.github.com/repos/' + _REPO + route and type(item['body']) is dict)
        moment = _stamp(item['fetched_at'], loc)
        check(last <= moment and 0 <= (moment - observed).total_seconds() <= 90)
        last = moment
        return item['body']
    def listing(route, key, query=''):
        items, ids, total = [], set(), None
        for page in range(1, 11):
            value = read(route + '?' + query + 'per_page=100&page=' + str(page))
            count, batch = value.get('total_count'), value.get(key)
            check(type(count) is int and 0 <= count <= 1000 and type(batch) is list)
            if total is None: total = count
            check(count == total and len(batch) == min(100, max(0, total - len(items))))
            for item in batch:
                check(type(item) is dict and _positive(item.get('id')) and item['id'] not in ids)
                ids.add(item['id'])
            items.extend(batch)
            if len(items) == total: return items
        check(False)
    current = normalized(read('/pulls/' + str(trigger['number'])))
    check(_same(admission.get('trigger'), trigger) and _same(admission.get('current'), current))
    check(all(_same(trigger[k], current[k]) for k in trigger if k != 'all_labels'))
    workflow = read('/actions/workflows/pr-gates.yml')
    check(_positive(workflow.get('id')) and workflow.get('name') == 'PR Gates' and
          workflow.get('path') == '.github/workflows/pr-gates.yml' and workflow.get('state') == 'active')
    def run_identity(run):
        check(type(run) is dict and all(_positive(run.get(k)) for k in ('id', 'workflow_id', 'run_number', 'run_attempt')))
        check(run['workflow_id'] == workflow['id'] and run.get('head_sha') == expected['head_sha'] and run.get('head_branch') == _BRANCH and
              run.get('event') == 'pull_request' and run.get('path') == '.github/workflows/pr-gates.yml' and run.get('name') == 'PR Gates')
        for key in ('repository', 'head_repository'):
            check(type(run.get(key)) is dict and run[key].get('full_name') == _REPO)
        prs = run.get('pull_requests')
        check(type(prs) is list and len(prs) == 1 and type(prs[0]) is dict and prs[0].get('number') == trigger['number'])
        check(type(prs[0].get('head')) is dict and prs[0]['head'].get('sha') == expected['head_sha'] and prs[0]['head'].get('ref') == _BRANCH)
    runs = listing('/actions/workflows/pr-gates.yml/runs', 'workflow_runs',
                   'head_sha=' + expected['head_sha'] + '&branch=' + _BRANCH + '&event=pull_request&')
    check(bool(runs))
    for run in runs:
        run_identity(run); check(run.get('status') == 'completed')
    check(len({run['run_number'] for run in runs}) == len(runs))
    latest = max(runs, key=lambda x: x['run_number'])
    check(latest.get('conclusion') in ('success', 'failure'))
    route = '/actions/runs/' + str(latest['id'])
    for view in (read(route), read(route + '/attempts/' + str(latest['run_attempt']))):
        run_identity(view)
        check(all(_same(view.get(k), latest.get(k)) for k in ('id', 'run_number', 'workflow_id', 'head_sha', 'head_branch', 'event', 'run_attempt', 'status', 'conclusion')))
    jobs = listing(route + '/attempts/' + str(latest['run_attempt']) + '/jobs', 'jobs')
    check(cursor == len(inspections))
    for job in jobs:
        check(type(job.get('run_id')) is int and job['run_id'] == latest['id'] and type(job.get('run_attempt')) is int and job['run_attempt'] == latest['run_attempt'])
        check(job.get('head_sha') == expected['head_sha'] and job.get('head_branch') == _BRANCH and job.get('workflow_name') == 'PR Gates')
        check(type(job.get('name')) is str and job['name'] and job.get('status') == 'completed' and
              job.get('conclusion') in ('success', 'failure', 'timed_out', 'cancelled', 'skipped', 'neutral', 'action_required', 'stale', 'startup_failure'))
    required = ('PR Review Scope', 'Review Prerequisites', 'JavaScript Tests (Portable)', 'Component Tests (Pinned Chrome)', 'JavaScript Tests (Windows Contract)', 'Python Tests')
    for name in required:
        owners = [x for x in jobs if x['name'] == name]
        check(len(owners) == 1)
        if name in required[:2]: check(owners[0]['conclusion'] == 'success')
        else: check(type(owners[0].get('started_at')) is str and owners[0]['started_at'] and owners[0]['conclusion'] in ('success', 'failure', 'timed_out', 'cancelled'))
    wanted_native = {'id': latest['id'], 'run_number': latest['run_number'], 'attempt': latest['run_attempt'],
                     'workflow_id': workflow['id'], 'head_sha': expected['head_sha'], 'status': 'completed',
                     'conclusion': latest['conclusion'], 'jobs': jobs}
    check(_same(admission.get('native'), wanted_native))


def _container(reader):
    files, directories = reader.scan()
    inventory = reader.json('inventory.json'); marker = reader.json('complete.json')
    _closed(inventory, {'schema_version', 'files'}, '/inventory.json', 'inventory')
    _closed(marker, {'schema_version', 'inventory_sha256', 'receipt_sha256', 'writer_complete'}, '/complete.json', 'writer')
    _need(marker['schema_version'] == 'foobar-preview-controls-complete-v1' and marker['writer_complete'] is True,
          'writer', '/complete.json')
    _need(marker['inventory_sha256'] == reader.records['inventory.json'][1], 'inventory', '/complete.json')
    _need(inventory['schema_version'] == 'foobar-preview-controls-inventory-v1' and type(inventory['files']) is list,
          'inventory', '/inventory.json')
    listed = []
    for item in inventory['files']:
        _closed(item, {'path', 'size', 'sha256'}, '/inventory.json/files', 'inventory')
        _relative(item['path'])
        _need(type(item['size']) is int and 0 <= item['size'] <= _FILE and _hex(item['sha256']), 'inventory', '/inventory.json/files')
        listed.append(item['path'])
    _need(listed == sorted(set(listed)) and set(listed) == set(files) - {'inventory.json', 'complete.json'}, 'inventory', '/inventory.json')
    permitted_dirs = {'/'.join(name.split('/')[:i]) for name in files for i in range(1, len(name.split('/')))}
    _need(directories == permitted_dirs, 'inventory', '/inventory.json')
    for item in inventory['files']:
        reader.read(item['path'])
        _need(reader.records[item['path']][1:] == (item['sha256'], item['size']), 'inventory', '/' + item['path'])
    _need(marker['receipt_sha256'] == reader.records.get('receipt.json', (None, None))[1], 'inventory', '/complete.json/receipt_sha256')
    return files


def _producer_output(record):
    """Bind historical OUTPUT as an exact string; never use it for local I/O."""
    loc = '/processes/python_collection.json/argv'
    _need(type(record) is dict and type(record.get('argv')) is list and
          len(record['argv']) == 8 and all(type(x) is str for x in record['argv']), 'process', loc)
    context = record['argv'][6]; suffix = '/context.json'
    _need(context.endswith(suffix), 'process', loc + '/6')
    output = context[:-len(suffix)]
    _need(output.startswith('/') and
          all(part not in ('', '.', '..') for part in output.split('/')[1:]) and
          not any(char in output for char in ('\\', ':', '\x00')), 'process', loc + '/6')
    try:
        output.encode('utf-8', errors='strict')
    except UnicodeError:
        raise _Problem('process', loc + '/6') from None
    return output


def _process(record, index, expected, output, previous):
    pid = _IDS[index]; loc = '/processes/' + pid + '.json'
    _closed(record, _PROCESS_KEYS, loc, 'process')
    _need(type(record['argv']) is list and all(type(x) is str for x in record['argv']), 'process', loc + '/argv')
    if index == 0:
        wanted = [expected['git_executable'], 'rev-parse', 'HEAD']
    elif index < 3:
        _need(len(record['argv']) == 8, 'process', loc + '/argv')
        bootstrap = record['argv'][4]
        _need(_digest(bootstrap.encode('utf-8')) == expected['bootstrap_sha256'], 'source_hash', loc + '/argv/4')
        wanted = [expected['python_executable'], '-I', '-B', '-c', bootstrap, expected['root'],
                  str(output) + '/context.json', 'collect' if index == 1 else 'run']
    else:
        wanted = [expected['node_executable'], str(Path(expected['root']) / _NODE_FILE),
                  '--list' if index == 3 else '--run', '--root', expected['root'], '--evidence-dir', str(output)]
    _need(_same(record['argv'], wanted), 'process', loc + '/argv')
    _need(record['exit_code'] is None or type(record['exit_code']) is int, 'process', loc + '/exit_code')
    for key in ('timed_out', 'cleanup_complete', 'cancelled'):
        _need(type(record[key]) is bool, 'process', loc + '/' + key)
    _need(type(record['writer_errors']) is list and all(type(x) is str for x in record['writer_errors']), 'process', loc + '/writer_errors')
    start, finish = _stamp(record['started_at'], loc), _stamp(record['finished_at'], loc)
    _need(start <= finish and (finish - start).total_seconds() <= _RUNTIMES[index] + 60, 'deadline', loc)
    _need(previous is None or previous <= start, 'order', loc + '/started_at')
    _need(type(record['exit_code']) is int, 'process', loc + '/exit_code')
    return finish


def _clean(record):
    return record['exit_code'] == 0 and not record['timed_out'] and not record['cancelled'] and record['cleanup_complete'] and record['writer_errors'] == []


def _collection(data):
    loc = '/python/collection.json'
    _closed(data, {'schema_version', 'discovered_nodeids', 'nodeids', 'deselected_nodeids', 'collection_errors'}, loc, 'collection')
    _need(type(data['schema_version']) is int and data['schema_version'] == 1, 'collection', loc)
    ids = data['nodeids']
    _need(type(ids) is list and bool(ids) and all(type(x) is str and x.startswith(_PYTHON_FILE + '::') and not any(c in x for c in ('\n', '\r', '\x00')) for x in ids), 'collection', loc)
    _need(len(ids) == len(set(ids)) and _same(ids, data['discovered_nodeids']) and data['deselected_nodeids'] == [] and data['collection_errors'] == [], 'collection', loc)
    return list(ids)


def _failed_collection(data):
    loc = '/python/collection.json'
    _closed(data, {'schema_version', 'discovered_nodeids', 'nodeids', 'deselected_nodeids', 'collection_errors'}, loc, 'collection')
    _need(type(data['schema_version']) is int and data['schema_version'] == 1, 'collection', loc)
    for key in ('discovered_nodeids', 'nodeids', 'deselected_nodeids'):
        ids = data[key]
        _need(type(ids) is list and all(type(x) is str and x.startswith(_PYTHON_FILE + '::') and not any(c in x for c in ('\n', '\r', '\x00')) for x in ids), 'collection', loc)
        _need(len(ids) == len(set(ids)), 'collection', loc)
    _need(type(data['collection_errors']) is list, 'collection', loc)
    for problem in data['collection_errors']:
        _closed(problem, {'nodeid', 'outcome', 'longrepr'}, loc, 'collection')
        _need(type(problem['nodeid']) is str and problem['nodeid'].startswith(_PYTHON_FILE) and
              problem['outcome'] in ('failed', 'skipped') and type(problem['longrepr']) is str, 'collection', loc)


def _junit(raw, ids, failed):
    loc = '/python/junit.xml'
    try:
        text = raw.decode('utf-8-sig')
        _need('\x00' not in text and '<!DOCTYPE' not in text.upper() and '<!ENTITY' not in text.upper(), 'junit', loc)
        root = ET.fromstring(text)
    except (UnicodeError, ET.ParseError, ValueError, RecursionError):
        raise _Problem('junit', loc) from None
    _need(root.tag in ('testsuite', 'testsuites'), 'junit', loc)
    wanted = {}
    for node in ids:
        parts = node.split('::')
        identity = (parts[0][:-3].replace('/', '.') + ''.join('.' + p for p in parts[1:-1]), parts[-1])
        _need(identity not in wanted, 'junit', loc)
        wanted[identity] = node
    cases = list(root.iter('testcase')); seen = set()
    _need(len(cases) == len(ids), 'junit', loc)
    for case in cases:
        identity = (case.get('classname'), case.get('name'))
        _need(identity in wanted and identity not in seen, 'junit', loc)
        seen.add(identity)
        _need(len(list(case.iter('testcase'))) == 1, 'junit', loc)
        _need(not list(case.iter('skipped')) and not list(case.iter('error')), 'junit', loc)
        _need(len(list(case.iter('failure'))) == (1 if wanted[identity] in failed else 0), 'junit', loc)
    for element in root.iter():
        for key, tag in (('tests', 'testcase'), ('failures', 'failure'), ('errors', 'error'), ('skipped', 'skipped')):
            if element.tag == 'testsuite': _need(key in element.attrib, 'junit', loc)
            if key in element.attrib:
                value = element.attrib[key]
                _need(re.fullmatch(r'[0-9]{1,12}', value) is not None and int(value) == len(list(element.iter(tag))), 'junit', loc)
    _need(len(list(root.iter('failure'))) == len(failed) and not list(root.iter('error')) and not list(root.iter('skipped')), 'junit', loc)


def _python(reader, ids, record):
    data = reader.json('python/reports.json'); loc = '/python/reports.json'
    _closed(data, {'schema_version', 'reports'}, loc, 'phase')
    _need(type(data['schema_version']) is int and data['schema_version'] == 1 and type(data['reports']) is list, 'phase', loc)
    wanted = [(node, phase) for node in ids for phase in ('setup', 'call', 'teardown')]
    _need(len(data['reports']) == len(wanted), 'phase', loc)
    failed = []
    for report, (node, phase) in zip(data['reports'], wanted):
        _closed(report, {'nodeid', 'when', 'outcome', 'wasxfail'}, loc, 'phase')
        _need(report['nodeid'] == node and report['when'] == phase and report['wasxfail'] is None and
              report['outcome'] in ('passed', 'failed'), 'phase', loc)
        _need(phase == 'call' or report['outcome'] == 'passed', 'phase', loc)
        if phase == 'call' and report['outcome'] == 'failed': failed.append(node)
    _junit(reader.read('python/junit.xml'), ids, failed)
    _need(record['exit_code'] == (1 if failed else 0), 'process', '/processes/python_runtime.json/exit_code')
    return failed


def _binding(expected):
    return {'workflow_path': _SUBJECT_WORKFLOW, 'workflow_sha256': expected['source_hashes'][_SUBJECT_WORKFLOW],
            'literal_sha256': expected['transfer_literal_sha256'], 'harness_path': _NODE_FILE,
            'harness_sha256': expected['source_hashes'][_NODE_FILE],
            'capability_profile': 'foobar-preview-transfer-fakes-v1', 'node_version': expected['node_version']}


def _listing(data, expected):
    loc = '/node/list.json'
    _closed(data, {'schema_version', 'case_ids', 'binding'}, loc, 'node_inventory')
    _need(data['schema_version'] == 'foobar-preview-controls-node-list-v1' and _same(data['case_ids'], list(_NODE_IDS)) and
          _same(data['binding'], _binding(expected)), 'node_inventory', loc)


def _ledger(data, node, path):
    loc = '/' + path
    _closed(data, {'schema_version', 'case_id', 'events'}, loc, 'capability')
    _need(data['schema_version'] == 'foobar-preview-controls-fake-ledger-v1' and data['case_id'] == node and type(data['events']) is list, 'capability', loc)
    controls = []
    for i, event in enumerate(data['events']):
        _closed(event, {'sequence', 'origin', 'capability', 'operation', 'disposition', 'requested_bytes', 'returned_bytes', 'fake_time_ms'}, loc, 'capability')
        _need(type(event['sequence']) is int and event['sequence'] == i + 1, 'capability', loc)
        _need(event['origin'] in ('subject', 'control') and event['capability'] in ('https', 'fs', 'path', 'crypto', 'util', 'buffer', 'clock', 'timer', 'core', 'environment', 'forbidden'), 'capability', loc)
        _need(type(event['operation']) is str and 1 <= len(event['operation']) <= 128 and '\x00' not in event['operation'], 'capability', loc)
        _need(event['disposition'] in ('fake', 'blocked'), 'capability', loc)
        for key in ('requested_bytes', 'returned_bytes'):
            _need(event[key] is None or type(event[key]) is int and event[key] >= 0, 'capability', loc)
        _need(type(event['fake_time_ms']) in (int, float) and math.isfinite(event['fake_time_ms']) and event['fake_time_ms'] >= 0, 'capability', loc)
        if event['origin'] == 'subject':
            _need(event['disposition'] == 'fake' and event['capability'] != 'forbidden', 'capability', loc)
        else: controls.append(event)
    special = {
        'fixture_forbidden_effect_attempt_survives_catch': ('forbidden', 'child_process.spawn', 'blocked'),
        'fixture_unlisted_module_denied': ('forbidden', 'require.node:net', 'blocked'),
        'fixture_host_environment_not_exposed': ('environment', 'read.GITHUB_TOKEN', 'fake'),
    }
    name = node.split('::')[-1]
    if name in special:
        _need(len(controls) == 1, 'capability', loc)
        event = controls[0]
        _need((event['capability'], event['operation'], event['disposition']) == special[name] and
              event['requested_bytes'] is None and event['returned_bytes'] is None, 'capability', loc)
    else: _need(not controls, 'capability', loc)


def _node(reader, expected):
    data = reader.json('node/runtime.json'); loc = '/node/runtime.json'
    _closed(data, {'schema_version', 'binding', 'case_ids', 'events', 'writer_complete'}, loc, 'node_event')
    _need(data['schema_version'] == 'foobar-preview-controls-node-runtime-v1' and _same(data['case_ids'], list(_NODE_IDS)) and
          _same(data['binding'], _binding(expected)) and type(data['writer_complete']) is bool and type(data['events']) is list,
          'node_event', loc)
    _need(len(data['events']) <= len(_NODE_IDS) * 2, 'node_event', loc)
    outcomes, ledgers = [], set()
    for i, event in enumerate(data['events']):
        terminal = bool(i % 2); node = _NODE_IDS[i // 2]
        keys = {'event', 'case_id', 'sequence'} | ({'status', 'error_code', 'ledger_path'} if terminal else set())
        _closed(event, keys, loc, 'node_event')
        _need(type(event['sequence']) is int and event['sequence'] == i + 1 and event['case_id'] == node and event['event'] == ('finish' if terminal else 'start'), 'node_event', loc)
        if terminal:
            _need(event['status'] in ('passed', 'failed', 'error') and event['error_code'] == {'passed': None, 'failed': 'assertion', 'error': 'harness'}[event['status']], 'node_event', loc)
            path = 'node/ledgers/%03d.json' % (i // 2 + 1)
            _need(event['ledger_path'] == path, 'path', loc + '/ledger_path')
            _ledger(reader.json(path), node, path)
            ledgers.add(path); outcomes.append(event['status'])
    complete = data['writer_complete'] and len(outcomes) == len(_NODE_IDS) and len(data['events']) == 2 * len(_NODE_IDS)
    return outcomes, ledgers, complete


def validate_controls_evidence(evidence_dir: Path, *, expected: dict) -> dict:
    """Read one confined proof without imports, effects, or completion authority.

    The caller supplies independently verified expected values. Nothing in this
    function promotes a producer's own identity dictionary into that authority.
    KeyboardInterrupt/SystemExit deliberately propagate; ordinary errors hold.
    """
    result = {'schema_version': 'foobar-preview-controls-validation-v1', 'authority': 'supplemental-only',
              'status': 'passed', 'errors': [], 'phases': [{'id': x, 'status': 'unknown'} for x in _IDS],
              'expected_ids': list(_NODE_IDS), 'observed_ids': [],
              'nodes': [{'case_id': x, 'language': 'node', 'status': 'unrun', 'cause': 'predecessor_nonpass'} for x in _NODE_IDS],
              'completion': 'unproven', 'continue_allowed': False}
    ranks = {'passed': 0, 'failed': 1, 'incomplete': 2, 'invalid': 3, 'writer_uncertain': 4, 'cleanup_unsafe': 5, 'cancelled': 6}
    def error(problem, phase=None, status=None, case=None):
        if status is None:
            status = {'missing': 'incomplete', 'cancellation': 'cancelled', 'cleanup': 'cleanup_unsafe',
                      'writer': 'writer_uncertain', 'assertion': 'failed'}.get(problem.code, 'invalid')
        if ranks[status] > ranks[result['status']]: result['status'] = status
        result['errors'].append({'code': problem.code, 'location': problem.location or '/', 'phase': phase,
                                 'case_id': case, 'message': problem.message})
    def invalidate(language=None, cause='invalid_evidence'):
        for node in result['nodes']:
            if language is None or node['language'] == language:
                node.update(status='unknown', cause=cause)
        for phase in result['phases']:
            if language is None or phase['id'].startswith(language):
                if phase['status'] == 'passed': phase['status'] = 'unknown'
    reader, files, attempted, records = None, {}, [], {}
    if type(expected) is dict and expected.get('cancelled') is True:
        error(_Problem('cancellation', '/expected/cancelled'))
    try:
        identity = _expected(expected)
        reader = _Reader(Path(evidence_dir))
        # Observe every available raw safety record before other structural
        # checks, so a contradictory green envelope cannot mask unsafe cleanup.
        for pid in _IDS:
            try:
                record = reader.json('processes/' + pid + '.json')
                if type(record) is dict:
                    for key, code in (('cancelled', 'cancellation'), ('cleanup_complete', 'cleanup'), ('writer_errors', 'writer')):
                        value = record.get(key)
                        unsafe = value is True if key == 'cancelled' else value is False if key == 'cleanup_complete' else type(value) is list and bool(value)
                        if unsafe: error(_Problem(code, '/processes/' + pid + '.json/' + key), pid)
            except _Problem:
                pass
        files = _container(reader)
        receipt, context = reader.json('receipt.json'), reader.json('context.json')
        _closed(receipt, {'schema_version', 'identity', 'attempted_process_ids'}, '/receipt.json')
        _need(receipt['schema_version'] == 'foobar-preview-controls-receipt-v1', 'schema', '/receipt.json')
        _need(_same(receipt['identity'], identity) and _same(context, identity), 'identity', '/receipt.json/identity')
        attempted = receipt['attempted_process_ids']
        _need(type(attempted) is list and attempted == list(_IDS[:len(attempted)]) and len(attempted) <= 5, 'order', '/receipt.json/attempted_process_ids')
        for phase in result['phases']:
            phase['status'] = 'unknown' if phase['id'] in attempted else 'unrun'
        for name, key in (('event.json', 'event_sha256'), ('admission.json', 'admission_sha256'), ('admission-context.json', 'admission_context_sha256')):
            _need(_digest(reader.read(name)) == expected[key], 'identity', '/' + name)
        _admission(reader.json('event.json'), reader.json('admission.json'), reader.json('admission-context.json'), expected)
        _need(reader.read('empty-pytest.ini') == b'', 'identity', '/empty-pytest.ini')
        allowed = set(_ROOT_FILES)
        for pid in attempted: allowed.update(('processes/' + pid + '.json', 'logs/' + pid + '.log'))
        if len(attempted) >= 2: allowed.add('python/collection.json')
        if len(attempted) >= 3: allowed.update(('python/reports.json', 'python/junit.xml'))
        if len(attempted) >= 4: allowed.add('node/list.json')
        if len(attempted) >= 5:
            allowed.add('node/runtime.json')
            allowed.update('node/ledgers/%03d.json' % i for i in range(1, 59))
        _need(set(files) <= allowed, 'inventory', '/inventory.json/files')
    except _Problem as problem:
        error(problem); invalidate()
        return result
    except Exception:
        error(_Problem('schema', '/')); invalidate()
        return result
    previous, stopped, unknown_prefix, python_ids = None, False, False, []
    producer_output = None
    for index, pid in enumerate(_IDS):
        phase = result['phases'][index]
        if pid not in attempted: continue
        if stopped:
            error(_Problem('order', '/receipt.json/attempted_process_ids'), pid)
            phase['status'] = 'unknown'; invalidate(); continue
        if unknown_prefix:
            phase['status'] = 'unknown'
            if index in (1, 2): invalidate('python', 'runtime_incomplete')
            if index in (3, 4): invalidate('node', 'runtime_incomplete')
            continue
        try:
            record = reader.json('processes/' + pid + '.json')
            records[pid] = record
            if index == 1:
                producer_output = _producer_output(record)
            previous = _process(record, index, expected, producer_output, previous)
            log = reader.read('logs/' + pid + '.log')
            if result['status'] in ('cancelled', 'cleanup_unsafe', 'writer_uncertain'):
                phase['status'] = 'unknown'; stopped = True; continue
            if record['timed_out']:
                phase['status'] = 'timed_out'; stopped = True
                error(_Problem('deadline', '/processes/' + pid + '.json/timed_out'), pid, 'incomplete')
                if pid in ('python_runtime', 'node_runtime'):
                    for node in result['nodes']:
                        if node['language'] == pid.split('_')[0]: node.update(status='timed_out', cause='timed_out')
                continue
            if record['exit_code'] == 0:
                # Independent read-only check of the unchanged success
                # predicate; the CLI additionally calls process_success itself.
                _need(_clean(record), 'process', '/processes/' + pid + '.json')
            if index == 0:
                _need(log in ((expected['checkout_head'] + '\n').encode(), (expected['checkout_head'] + '\r\n').encode()), 'identity', '/logs/git.log')
                _need(record['exit_code'] == 0, 'process', '/processes/git.json/exit_code')
                phase['status'] = 'passed'
            elif index in (1, 3) and record['exit_code'] != 0:
                # A collection/inventory command owns no runtime case result.
                # Validate available JSON syntax, but never derive canonical
                # Python ownership from a failed collection.
                if index == 1:
                    _failed_collection(reader.json('python/collection.json'))
                else:
                    _listing(reader.json('node/list.json'), expected)
                phase['status'] = 'failed'; stopped = True
                error(_Problem('collection' if index == 1 else 'node_inventory', '/processes/' + pid + '.json/exit_code'), pid, 'failed')
            elif index == 1:
                python_ids = _collection(reader.json('python/collection.json'))
                result['expected_ids'] = python_ids + list(_NODE_IDS)
                result['nodes'] = [{'case_id': x, 'language': 'python', 'status': 'unrun', 'cause': 'predecessor_nonpass'} for x in python_ids] + result['nodes']
                phase['status'] = 'passed'
            elif index == 2:
                if record['exit_code'] not in (0, 1):
                    invalidate('python', 'unexpected_exit')
                    raise _Problem('process', '/processes/python_runtime.json/exit_code')
                failed = _python(reader, python_ids, record)
                phase['status'] = 'failed' if failed else 'passed'
                for node in result['nodes'][:len(python_ids)]:
                    node.update(status='failed' if node['case_id'] in failed else 'unknown' if failed else 'passed',
                                cause='assertion_failed' if node['case_id'] in failed else 'invocation_nonzero_exit' if failed else None)
                if failed:
                    stopped = True
                    error(_Problem('assertion', '/python/reports.json'), pid, 'failed', failed[0])
            elif index == 3:
                _listing(reader.json('node/list.json'), expected); phase['status'] = 'passed'
            else:
                outcomes, ledgers, complete = _node(reader, expected)
                _need({x for x in files if x.startswith('node/ledgers/')} == ledgers, 'node_event', '/node/ledgers')
                if not complete:
                    invalidate('node', 'runtime_incomplete'); phase['status'] = 'unknown'
                    error(_Problem('node_event', '/node/runtime.json/events'), pid, 'incomplete'); stopped = True; continue
                code = record['exit_code']
                if code not in (0, 1, 2):
                    invalidate('node', 'unexpected_exit')
                    raise _Problem('process', '/processes/node_runtime.json/exit_code')
                wanted = 2 if 'error' in outcomes else 1 if 'failed' in outcomes else 0
                if code != wanted:
                    invalidate('node', 'exit_report_mismatch')
                    raise _Problem('node_event', '/node/runtime.json/events')
                phase['status'] = 'passed' if code == 0 else 'failed'
                for node, outcome in zip(result['nodes'][len(python_ids):], outcomes):
                    node.update(status='passed' if code == 0 else 'failed' if outcome == 'failed' else 'unknown',
                                cause=None if code == 0 else 'assertion_failed' if outcome == 'failed' else 'harness_error' if outcome == 'error' else 'invocation_nonzero_exit')
                if code:
                    stopped = True
                    error(_Problem('assertion' if code == 1 else 'node_event', '/node/runtime.json/events'), pid, 'failed' if code == 1 else 'invalid')
        except _Problem as problem:
            phase['status'] = 'unknown'; unknown_prefix = True
            error(problem, pid)
            language = 'python' if index in (1, 2) else 'node' if index in (3, 4) else None
            # Preserve declared per-invocation mismatch causes, not accepted
            # passes, when the complete proof explains the nonzero result.
            if not any(n['language'] == language and n['cause'] in ('unexpected_exit', 'exit_report_mismatch') for n in result['nodes']):
                invalidate(language, 'runtime_incomplete' if problem.code == 'missing' else 'invalid_evidence')
        except Exception:
            phase['status'] = 'unknown'; unknown_prefix = True
            error(_Problem('schema', '/processes/' + pid + '.json'), pid)
            invalidate('python' if index in (1, 2) else 'node' if index in (3, 4) else None)
    if not stopped and len(attempted) < 5:
        error(_Problem('missing', '/receipt.json/attempted_process_ids'))
    try:
        reader.finish()
        now, _ = reader.scan()
        _need(now == files, 'writer', '/inventory.json')
    except _Problem as problem:
        error(problem); invalidate()
    except Exception:
        error(_Problem('writer', '/inventory.json')); invalidate()
    if result['status'] in ('cancelled', 'cleanup_unsafe', 'writer_uncertain'):
        invalidate(cause=result['status'])
    result['observed_ids'] = [n['case_id'] for n in result['nodes'] if n['status'] == 'passed']
    return result


_BOOTSTRAP = '''import hashlib, importlib.machinery, importlib.util, json, math, os, pathlib, stat, sys
if len(sys.argv) != 4 or sys.argv[3] not in ("collect", "run"):
    raise ValueError("Closed child entry")
root = pathlib.Path(sys.argv[1])
context_path = pathlib.Path(sys.argv[2])
def bounded(path, cap):
    current = pathlib.Path(path.anchor)
    for part in path.parts[1:-1]:
        current /= part
        if not stat.S_ISDIR(os.lstat(current).st_mode): raise ValueError("Linked parent")
    before = os.lstat(path)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or not 0 <= before.st_size <= cap: raise ValueError("Unbounded source")
    def identity(s): return (s.st_dev, s.st_ino, s.st_mode, s.st_nlink, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
    parent = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent); parent = child
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    finally: os.close(parent)
    try:
        if identity(os.fstat(fd)) != identity(before): raise ValueError("Changed source")
        parts = []; remaining = before.st_size
        while remaining:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk: raise ValueError("Short source")
            parts.append(chunk); remaining -= len(chunk)
        if os.read(fd, 1) or identity(os.fstat(fd)) != identity(before) or identity(os.lstat(path)) != identity(before): raise ValueError("Changed source")
        return b"".join(parts)
    finally: os.close(fd)
def pairs(items):
    data = {}
    for key, value in items:
        if key in data: raise ValueError("Duplicate key")
        data[key] = value
    return data
def finite(value):
    result = float(value)
    if not math.isfinite(result): raise ValueError("Nonfinite number")
    return result
def forbidden(value): raise ValueError("Nonfinite JSON")
context = json.loads(bounded(context_path, 1048576).decode("utf-8"), object_pairs_hook=pairs, parse_float=finite, parse_constant=forbidden)
path = root / "scripts/ci/foobar_preview_controls_evidence.py"
source = bounded(path, 33554432)
if hashlib.sha256(source).hexdigest() != context["source_hashes"]["scripts/ci/foobar_preview_controls_evidence.py"]: raise ValueError("Adapter source changed")
class Bound(importlib.machinery.SourceFileLoader):
    def get_data(self, location):
        if location != str(path): raise OSError("Only admitted source")
        return source
    def set_data(self, location, data, *, _mode=0o666): return None
spec = importlib.util.spec_from_file_location("foobar_controls_child", path, loader=Bound("foobar_controls_child", str(path)))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
raise SystemExit(module._child(root, context_path, sys.argv[3]))
'''


class _BoundSource(importlib.machinery.SourceFileLoader):
    def __init__(self, name, path, source):
        super().__init__(name, str(path)); self.source = source
    def get_data(self, location):
        if location != self.path:
            raise OSError('Only the verified source file is available.')
        return self.source
    def set_data(self, location, data, *, _mode=0o666):
        return None


def _primitives(root):
    # No import is performed by the public validator. CLI-only capability
    # exposure is restricted to the five unchanged reviewed primitives.
    path = _confined(root, _OLD); source, _ = _read_file(path)
    _need(_digest(source) == _OLD_SHA, 'source_hash', '/' + _OLD)
    spec = importlib.util.spec_from_file_location('foobar_controls_owned', path,
        loader=_BoundSource('foobar_controls_owned', path, source))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return {name: getattr(module, name) for name in _PRIMITIVES}


def _write(path, value):
    raw = value if type(value) is bytes else (json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8')
    _need(len(raw) <= _FILE, 'size_limit', '/writer')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        offset = 0
        while offset < len(raw):
            count = os.write(fd, raw[offset:offset + 65536])
            _need(count > 0, 'writer', '/writer'); offset += count
        os.fsync(fd)
    finally:
        os.close(fd)


class _LiveWriter:
    """One owned descriptor retains partial reports; it never replaces a path."""
    def __init__(self, path):
        self.fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        info = os.fstat(self.fd); self.identity = info.st_dev, info.st_ino
    def update(self, value):
        raw = (json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8')
        _need(len(raw) <= _FILE, 'size_limit', '/writer')
        info = os.fstat(self.fd)
        _need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and (info.st_dev, info.st_ino) == self.identity, 'writer', '/writer')
        os.lseek(self.fd, 0, os.SEEK_SET); offset = 0
        while offset < len(raw):
            count = os.write(self.fd, raw[offset:offset + 65536])
            _need(count > 0, 'writer', '/writer'); offset += count
        os.ftruncate(self.fd, len(raw)); os.fsync(self.fd)
    def close(self):
        os.close(self.fd)


def _literal(raw):
    text = raw.decode('utf-8')
    _need('\t' not in text and '\r' not in text, 'literal', '/workflow')
    lines = text.splitlines(); header = '  PREVIEW_TRANSFER_SCRIPT: |'
    _need(lines.count('env:') == 1 and lines.count(header) == 1, 'literal', '/workflow')
    start = lines.index(header)
    _need(start > lines.index('env:') and all(not line or line.startswith(' ') or line.startswith('#') for line in lines[lines.index('env:') + 1:start]), 'literal', '/workflow')
    _need(sum('PREVIEW_TRANSFER_SCRIPT:' in x for x in lines) == 1, 'literal', '/workflow')
    result = []
    for line in lines[start + 1:]:
        if line and not line.startswith('    '):
            _need(not line.startswith('   '), 'literal', '/workflow')
            break
        result.append(line[4:] if line else '')
    data = ('\n'.join(result).rstrip('\n') + '\n').encode('utf-8')
    _need(len(data) == 15483 and _digest(data) == _LITERAL_SHA, 'literal', '/workflow')
    return data


def _sources(root):
    result = {}
    for path in _SOURCE_PATHS:
        raw, _ = _read_file(_confined(root, path))
        digest = _digest(raw)
        if path in _SOURCE_PINS: _need(digest == _SOURCE_PINS[path], 'source_hash', '/' + path)
        result[path] = digest
        if path == _SUBJECT_WORKFLOW: _literal(raw)
    return result


def _checkout(root, head):
    raw, _ = _read_file(_confined(root, '.git/HEAD'), 128)
    _need(raw in ((head + '\n').encode(), (head + '\r\n').encode()), 'identity', '/.git/HEAD')


def _live_expected(root, event_path, admission_path, output):
    """Current hosted facts, never a returned context dictionary, own identity."""
    root, output = Path(root), Path(output)
    _need(root.is_absolute() and root.resolve(strict=True) == root and output.resolve(strict=True) == output, 'path', '/root')
    _need(Path(__file__).resolve(strict=True) == root / _SELF, 'source_hash', '/' + _SELF)
    event_raw, _ = _read_file(event_path, 1048576)
    admission_raw, _ = _read_file(admission_path)
    live_raw, _ = _read_file(Path(os.environ['GITHUB_EVENT_PATH']), 1048576)
    _need(event_raw == live_raw and os.environ.get('GITHUB_EVENT_NAME') == 'pull_request' and
          os.environ.get('GITHUB_REPOSITORY') == _REPO and os.environ.get('GITHUB_JOB') == 'validation_controls', 'identity', '/environment')
    event = _json(event_raw)
    head = event['pull_request']['head']['sha']
    _need(head == os.environ.get('CONTROLS_EXPECTED_HEAD') and _hex(head, 40), 'identity', '/event/head')
    _checkout(root, head)
    run, attempt = os.environ['GITHUB_RUN_ID'], os.environ['GITHUB_RUN_ATTEMPT']
    _need(re.fullmatch('[1-9][0-9]*', run) and re.fullmatch('[1-9][0-9]*', attempt), 'identity', '/environment/run')
    _need(output == Path(os.environ['RUNNER_TEMP']).resolve(strict=True) / ('foobar-preview-validation-controls-' + run + '-' + attempt + '-' + head), 'path', '/output')
    _need(Path(os.environ['GITHUB_WORKSPACE']).resolve(strict=True) == root, 'identity', '/environment/workspace')
    _need(os.environ.get('GITHUB_WORKFLOW_REF', '').startswith(_REPO + '/' + _WORKFLOW + '@'), 'identity', '/environment/workflow')
    _need(sys.version_info[:2] == (3, 11), 'identity', '/python_version')
    executables = {key: shutil.which(name) for key, name in (('git_executable', 'git'), ('python_executable', 'python'), ('node_executable', 'node'))}
    _need(all(executables.values()), 'identity', '/executables')
    executables = {key: str(Path(value).resolve(strict=True)) for key, value in executables.items()}
    _need(Path(sys.executable).resolve(strict=True) == Path(executables['python_executable']), 'identity', '/python_executable')
    context = {'schema_version': 1, 'repository': _REPO, 'head_sha': head, 'run_id': int(run), 'attempt': int(attempt),
               'admission_sha256': _digest(admission_raw), 'event_sha256': _digest(event_raw), 'workflow_path': _WORKFLOW, 'job_id': 'validation_controls'}
    context_raw = (json.dumps(context, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8')
    expected = {'repository': _REPO, 'head_sha': head, 'checkout_head': head, 'workflow_path': _WORKFLOW,
                'job_id': 'validation_controls', 'run_id': int(run), 'run_attempt': int(attempt), 'cancelled': False,
                'root': str(root), **executables, 'python_version': sys.version.split()[0],
                'node_version': os.environ['CONTROLS_NODE_VERSION'], 'source_hashes': _sources(root),
                'event_sha256': _digest(event_raw), 'admission_sha256': _digest(admission_raw),
                'admission_context_sha256': _digest(context_raw), 'bootstrap_sha256': _digest(_BOOTSTRAP.encode()),
                'transfer_literal_sha256': _LITERAL_SHA}
    _expected(expected); _admission(event, _json(admission_raw), context, expected)
    return expected, context_raw


def _alarm(seconds):
    _need(seconds > 0, 'deadline', '/overhead')
    def expired(signum, frame):
        raise TimeoutError('Controls infrastructure deadline.')
    old = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    return old


def _disarm(old):
    signal.setitimer(signal.ITIMER_REAL, 0); signal.signal(signal.SIGALRM, old)


def _prepare(root, event_path, admission_path, output, admitted_source_sha256):
    """Private workflow preparation, before dependency installation, not a CLI."""
    started = time.monotonic(); old = _alarm(120)
    try:
        output = Path(output)
        reader = _Reader(output); files, dirs = reader.scan()
        _need(set(files) == {'event.json', 'admission.json'} and not dirs, 'inventory', '/output')
        expected, context_raw = _live_expected(root, event_path, admission_path, output)
        _need(expected['source_hashes'][_SELF] == admitted_source_sha256, 'source_hash', '/' + _SELF)
        _write(output / 'admission-context.json', context_raw)
        _write(output / 'context.json', _expected(expected))
        _write(output / 'empty-pytest.ini', b'')
        _need(time.monotonic() - started < 120, 'deadline', '/prepare')
        # This private process-local observation only narrows the later guard.
        # Completed hosted step intervals still own external acceptance.
        elapsed = time.monotonic() - started
        with open(os.environ['GITHUB_ENV'], 'a', encoding='utf-8') as stream:
            stream.write('CONTROLS_PREP_SECONDS=' + repr(elapsed) + '\n')
    finally:
        _disarm(old)


class _Capture:
    def __init__(self, writer, mode, collected):
        self.writer, self.mode, self.collected = writer, mode, collected
        self.collection = {'schema_version': 1, 'discovered_nodeids': [], 'nodeids': [], 'deselected_nodeids': [], 'collection_errors': []}
        self.reports = {'schema_version': 1, 'reports': []}
        self.persist()
    def persist(self):
        self.writer.update(self.collection if self.mode == 'collect' else self.reports)
    def pytest_collection_modifyitems(self, session, config, items):
        self.collection['discovered_nodeids'] = [item.nodeid for item in items]
        yield
        self.collection['nodeids'] = [item.nodeid for item in items]
        self.persist()
    def pytest_collection_finish(self, session):
        self.collection['nodeids'] = [item.nodeid for item in session.items]
        self.persist()
        if self.mode == 'run':
            _need(_collection(self.collection) == self.collected, 'collection', '/python/collection.json')
    def pytest_deselected(self, items):
        self.collection['deselected_nodeids'].extend(item.nodeid for item in items); self.persist()
    def pytest_collectreport(self, report):
        if not report.passed:
            self.collection['collection_errors'].append({'nodeid': report.nodeid, 'outcome': report.outcome, 'longrepr': str(report.longrepr)})
            self.persist()
    def pytest_runtest_logreport(self, report):
        self.reports['reports'].append({'nodeid': report.nodeid, 'when': report.when, 'outcome': report.outcome, 'wasxfail': getattr(report, 'wasxfail', None)})
        self.persist()


def _child(root, context_path, mode):
    """Private in-process pytest entry. It never calls the parent run CLI."""
    _need(mode in ('collect', 'run') and Path(root).is_absolute(), 'identity', '/child')
    root, output = Path(root), Path(context_path).parent
    identity = _json(_read_file(_confined(output, 'context.json'), 1048576)[0])
    expected = {**identity, 'cancelled': False}; _expected(expected)
    _need(identity['root'] == str(root) and _same(identity['source_hashes'], _sources(root)) and
          identity['bootstrap_sha256'] == _digest(_BOOTSTRAP.encode()), 'source_hash', '/child')
    _checkout(root, identity['head_sha'])
    _need(Path(sys.executable).resolve(strict=True) == Path(identity['python_executable']) and
          sys.version.split()[0] == identity['python_version'] and sys.version_info[:2] == (3, 11), 'identity', '/child/python')
    _need(_read_file(_confined(output, 'empty-pytest.ini'))[0] == b'', 'identity', '/child/config')
    # Imported only in the separately authorized owned Python child.
    import pytest
    _Capture.pytest_collection_modifyitems = pytest.hookimpl(wrapper=True)(_Capture.pytest_collection_modifyitems)
    collected = None if mode == 'collect' else _collection(_json(_read_file(_confined(output, 'python/collection.json'))[0]))
    directory = output / 'python'
    if mode == 'collect': directory.mkdir(mode=0o700)
    writer = _LiveWriter(directory / ('collection.json' if mode == 'collect' else 'reports.json'))
    capture = _Capture(writer, mode, collected)
    args = ['--noconftest', '--import-mode=importlib', '-p', 'no:cacheprovider', '-c', str(output / 'empty-pytest.ini'), '--rootdir', str(root)]
    args += ['--collect-only'] if mode == 'collect' else ['--junitxml', str(directory / 'junit.xml')]
    args += [_PYTHON_FILE]
    try:
        code = int(pytest.main(args, plugins=[capture]))
        if code == 0:
            _collection(capture.collection)
            if mode == 'run': _need(capture.collection['nodeids'] == collected, 'collection', '/child')
        return code
    finally:
        capture.persist(); writer.close()


def _child_environment(expected):
    # No inherited credentials, Actions/event context, loaders, startup or
    # pytest options. Executables are absolute; PATH is explicit infrastructure.
    return {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'TZ': 'UTC',
            'TMPDIR': str(Path(os.environ['RUNNER_TEMP']).resolve(strict=True)),
            'PYTHONUNBUFFERED': '1', 'PYTHONDONTWRITEBYTECODE': '1', 'PYTEST_DISABLE_PLUGIN_AUTOLOAD': '1',
            'PYTEST_ADDOPTS': '', 'PYTEST_PLUGINS': '', 'PYTHONPATH': '', 'PYTHONHOME': '',
            'PYTHONSTARTUP': '', 'PYTHONINSPECT': '', 'NODE_OPTIONS': '', 'NODE_PATH': ''}


def _seal(output, identity, attempted):
    _write(output / 'receipt.json', {'schema_version': 'foobar-preview-controls-receipt-v1',
                                    'identity': identity, 'attempted_process_ids': attempted})
    reader = _Reader(output); files, _ = reader.scan()
    _need('inventory.json' not in files and 'complete.json' not in files, 'inventory', '/output')
    entries = []
    for name in sorted(files):
        raw = reader.read(name)
        entries.append({'path': name, 'size': len(raw), 'sha256': _digest(raw)})
    reader.finish()
    _write(output / 'inventory.json', {'schema_version': 'foobar-preview-controls-inventory-v1', 'files': entries})
    raw, _ = _read_file(output / 'inventory.json')
    marker = {'schema_version': 'foobar-preview-controls-complete-v1', 'inventory_sha256': _digest(raw),
              'receipt_sha256': reader.records['receipt.json'][1], 'writer_complete': True}
    # Count both excluded container files and their bytes before final marker.
    marker_raw = (json.dumps(marker, sort_keys=True, separators=(',', ':')) + '\n').encode()
    _need(len(files) + 2 <= _FILES and sum(x['size'] for x in entries) + len(raw) + len(marker_raw) <= _BYTES,
          'size_limit', '/complete.json')
    _write(output / 'complete.json', marker_raw)


def _run(root, event_path, admission_path, output):
    root, output = Path(root), Path(output)
    _need(Path(event_path) == output / 'event.json' and Path(admission_path) == output / 'admission.json', 'path', '/arguments')
    started = time.monotonic(); owned_elapsed = 0.0; attempted = []; fatal = False
    prepare_seconds = float(os.environ['CONTROLS_PREP_SECONDS'])
    _need(math.isfinite(prepare_seconds) and 0 <= prepare_seconds < 120, 'deadline', '/prepare')
    def arm_remaining():
        # The whole non-owned residual is conservatively charged to BOTH
        # independent verify/finalize caps. Earlier preparation also consumes
        # verify. There is no reset or borrowed process/category allowance.
        remaining = 120 - prepare_seconds - (time.monotonic() - started - owned_elapsed)
        return _alarm(remaining)
    old = arm_remaining()
    try:
        expected, context_raw = _live_expected(root, event_path, admission_path, output)
        identity = _expected(expected)
        _need(_same(_json(_read_file(_confined(output, 'context.json'))[0]), identity) and
              _read_file(_confined(output, 'admission-context.json'))[0] == context_raw and
              _read_file(_confined(output, 'empty-pytest.ini'))[0] == b'', 'identity', '/context.json')
        reader = _Reader(output); files, dirs = reader.scan()
        _need(set(files) == {'context.json', 'admission-context.json', 'event.json', 'admission.json', 'empty-pytest.ini'} and not dirs,
              'inventory', '/output')
        primitives = _primitives(root)
        (output / 'processes').mkdir(mode=0o700); (output / 'logs').mkdir(mode=0o700)
        commands = (
            [expected['git_executable'], 'rev-parse', 'HEAD'],
            [expected['python_executable'], '-I', '-B', '-c', _BOOTSTRAP, str(root), str(output / 'context.json'), 'collect'],
            [expected['python_executable'], '-I', '-B', '-c', _BOOTSTRAP, str(root), str(output / 'context.json'), 'run'],
            [expected['node_executable'], str(root / _NODE_FILE), '--list', '--root', str(root), '--evidence-dir', str(output)],
            [expected['node_executable'], str(root / _NODE_FILE), '--run', '--root', str(root), '--evidence-dir', str(output)],
        )
    finally:
        _disarm(old)
    previous, collection = None, None
    try:
        for index, (pid, argv, runtime) in enumerate(zip(_IDS, commands, _RUNTIMES)):
            old = arm_remaining()
            try:
                live, raw = _live_expected(root, event_path, admission_path, output)
                _need(_same(live, expected) and raw == context_raw and
                      _same(_json(_read_file(_confined(output, 'context.json'))[0]), identity), 'identity', '/context.json')
                _Reader(output).scan()
                log = output / 'logs' / (pid + '.log')
                _need(not log.exists() and not log.is_symlink(), 'path', '/logs/' + pid + '.log')
            finally:
                _disarm(old)
            attempted.append(pid)
            child_started = time.monotonic()
            # This is the only process-creation call site. No alternate factory,
            # shell, retry, hidden probe or recursively invoked supervisor.
            record = primitives['run_owned'](argv, cwd=root, env=_child_environment(expected),
                log_path=log, timeout_seconds=runtime, terminate_grace_seconds=30)
            owned_elapsed += time.monotonic() - child_started
            # Preserve the unchanged actual return before a residual-overrun
            # guard can stop acceptance/finalization. No status field is edited.
            _write(output / 'processes' / (pid + '.json'), record)
            old = arm_remaining()
            try:
                primitives['owned_file'](output, 'logs/' + pid + '.log')
                previous = _process(record, index, expected, output, previous)
                primitives['timestamp'](record['started_at']); primitives['timestamp'](record['finished_at'])
                primitives['process_success'](record)
                _need(record['cancelled'] is False, 'cancellation', '/processes/' + pid + '.json')
                reader = _Reader(output)
                if index == 0:
                    _need(reader.read('logs/git.log') in ((expected['head_sha'] + '\n').encode(), (expected['head_sha'] + '\r\n').encode()), 'identity', '/logs/git.log')
                elif index == 1:
                    collection = _collection(reader.json('python/collection.json'))
                    _need(primitives['node_list'](collection) == collection, 'collection', '/python/collection.json')
                elif index == 2:
                    _need(_python(reader, collection, record) == [], 'phase', '/python/reports.json')
                elif index == 3:
                    _listing(reader.json('node/list.json'), expected)
                else:
                    outcomes, _, complete = _node(reader, expected)
                    _need(complete and outcomes == ['passed'] * 58, 'node_event', '/node/runtime.json')
                reader.finish(); reader.scan()
            finally:
                _disarm(old)
    except (KeyboardInterrupt, SystemExit):
        fatal = True
    except Exception:
        fatal = True
    try:
        old = arm_remaining()
        try:
            _seal(output, identity, attempted)
            result = validate_controls_evidence(output, expected=expected)
            accepted = not fatal and result['status'] == 'passed'
            print('Supplemental controls raw proof: ' + ('passed; hosted completion unproven.' if accepted else 'nonpassing; hosted completion unproven.'))
        finally:
            _disarm(old)
        return 0 if accepted else 1
    except (KeyboardInterrupt, SystemExit):
        raise
    except Exception:
        print('Supplemental controls finalization incomplete; no acceptance.')
        return 1


def _main():
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument('mode', choices=('run',))
    for name in ('root', 'event', 'admission', 'output'):
        parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    def cancelled(signum, frame):
        raise KeyboardInterrupt()
    previous_term = signal.signal(signal.SIGTERM, cancelled)
    try:
        return _run(args.root, args.event, args.admission, args.output)
    except Exception:
        print('Supplemental controls failed closed before completion.')
        return 1
    finally:
        signal.signal(signal.SIGTERM, previous_term)


if __name__ == '__main__':
    raise SystemExit(_main())
