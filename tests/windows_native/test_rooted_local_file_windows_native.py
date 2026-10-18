"""W0 parent: stdlib/pytest only. Native work stays in fixed isolated children.

Explicit CI command: python -I -B tests/windows_native/test_rooted_local_file_windows_native.py --ci
This directory is outside the legacy pytest testpaths/conftest tree. Nothing in
this module imports AlbumHaven or constructs a native binding.
"""
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import threading
import time
import xml.etree.ElementTree as ET

import pytest

SCENARIOS = (
    'abi_selector', 'ordinary_reads', 'missing_and_kinds',
    'rename_root', 'rename_intermediate', 'rename_leaf', 'content_mutations',
    'wrong_expected_root', 'sharing_denial', 'locked_read',
    'junction_root', 'junction_intermediate', 'junction_leaf',
    'reader_lifecycle', 'repeated_cleanup',
)
CHECKS = {
    'abi_selector': 'abi_and_selector', 'ordinary_reads': 'ordinary_reads',
    'missing_and_kinds': 'missing_and_kind_failures',
    'rename_root': 'rename_and_sticky_failure',
    'rename_intermediate': 'rename_and_sticky_failure',
    'rename_leaf': 'rename_and_sticky_failure',
    'content_mutations': 'observed_content_mutations',
    'wrong_expected_root': 'actual_wrong_root_rejected',
    'sharing_denial': 'genuine_sharing_denial', 'locked_read': 'genuine_lock_denial',
    'junction_root': 'genuine_junction_rejected',
    'junction_intermediate': 'genuine_junction_rejected',
    'junction_leaf': 'genuine_junction_rejected',
    'reader_lifecycle': 'ordinary_reader_ownership',
    'repeated_cleanup': 'bounded_repeated_cleanup',
}
TEST_PATH = 'tests/windows_native/test_rooted_local_file_windows_native.py'
NODE_IDS = tuple(TEST_PATH + '::test_native_scenario[' + scenario + ']'
                 for scenario in SCENARIOS)
MAX_PIPE = 16384
CHILD_SECONDS = 20.0
REAP_SECONDS = 5.0
REPARSE = 0x400
STAGES = frozenset(('admission', 'bootstrap', 'fixture_setup', 'scenario',
    'rename_acquire', 'rename_move_out', 'rename_replacement_create',
    'rename_check_changed', 'rename_replacement_remove', 'rename_restore',
    'rename_check_sticky', 'cleanup', 'complete'))
# Fail closed even if setup or evidence writing interrupts the ordinary stop path.
_can_continue = True


def require(condition, code):
    if not condition:
        raise RuntimeError(code)


def plain_chain(path):
    require(path.is_absolute() and re.fullmatch(r'[A-Za-z]:', path.drive),
            'w0_host_not_direct_drive')
    current = Path(path.anchor)
    for part in (None, *path.parts[1:]):
        if part is not None:
            require(part not in ('.', '..'), 'w0_unsafe_component')
            current = current / part
        value = current.lstat()
        require(stat.S_ISDIR(value.st_mode) and
                not value.st_file_attributes & REPARSE, 'w0_unsafe_root_chain')


def origin():
    here = Path(__file__).resolve(strict=True)
    require(here.parts[-3:] == ('tests', 'windows_native',
            'test_rooted_local_file_windows_native.py'), 'w0_parent_origin')
    root = here.parents[2]
    worker = here.with_name('rooted_windows_acceptance_worker.py')
    require(worker.is_file() and worker.resolve(strict=True) == worker,
            'w0_worker_origin')
    return root, worker


def clean_environment():
    require(sys.flags.isolated == 1 and sys.dont_write_bytecode and __debug__,
            'w0_interpreter_not_isolated')
    require(os.environ.get('PYTEST_DISABLE_PLUGIN_AUTOLOAD') == '1' and
            not os.environ.get('PYTEST_PLUGINS') and not os.environ.get('PYTEST_ADDOPTS'),
            'w0_pytest_environment_not_isolated')
    require(not any(name == 'config' or name == 'music_app' or name.startswith('music_app.')
                    for name in sys.modules), 'w0_parent_imported_product')


def run_location():
    require(sys.platform == 'win32' and sys.implementation.name == 'cpython'
            and sys.version_info[:2] == (3, 11) and sys.maxsize == 2**63 - 1,
            'w0_host_not_admitted')
    run_id, attempt = os.environ.get('GITHUB_RUN_ID', ''), os.environ.get('GITHUB_RUN_ATTEMPT', '')
    require(re.fullmatch(r'[0-9]{1,20}', run_id) and re.fullmatch(r'[0-9]{1,8}', attempt),
            'w0_run_identity_missing')
    base = Path(os.environ['RUNNER_TEMP'])
    plain_chain(base)
    return base / ('albumhaven-w0-' + run_id + '-' + attempt)


def owned_run():
    expected = run_location()
    require(os.environ.get('ALBUMHAVEN_W0_ROOT') == str(expected), 'w0_run_root_mismatch')
    plain_chain(expected)
    marker = expected / '.owner'
    value = marker.lstat()
    require(stat.S_ISREG(value.st_mode) and not value.st_file_attributes & REPARSE
            and value.st_size == 32, 'w0_run_marker_kind')
    nonce = marker.read_text('ascii')
    require(re.fullmatch(r'[a-f0-9]{32}', nonce), 'w0_run_marker_invalid')
    return expected, nonce


def bounded_child(command, environment):
    """Cap both pipes during capture, then kill and reap on timeout/overflow.

    Reader threads never retain more than MAX_PIPE bytes each. A live/draining
    process is never considered cleaned merely because termination was requested.
    A timed-out case's scratch remains for runner disposal; we never guess a safe
    traversal of a partially constructed native fixture.
    """
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, env=environment, shell=False,
                               close_fds=True, bufsize=0)
    buffers = [bytearray(), bytearray()]
    overflow = threading.Event()
    pipe_error = threading.Event()

    def consume(pipe, buffer):
        try:
            while True:
                chunk = pipe.read(1024)
                if not chunk:
                    break
                available = MAX_PIPE - len(buffer)
                if len(chunk) > available:
                    buffer.extend(chunk[:max(0, available)])
                    overflow.set()
                    break
                buffer.extend(chunk)
        except BaseException:
            pipe_error.set()
        finally:
            pipe.close()

    readers = [threading.Thread(target=consume, args=(pipe, buffer), daemon=True)
               for pipe, buffer in zip((process.stdout, process.stderr), buffers)]
    reason = ''
    try:
        for reader in readers:
            reader.start()
        deadline = time.monotonic() + CHILD_SECONDS
        while process.poll() is None:
            if overflow.is_set() or pipe_error.is_set():
                reason = 'child_output_bound' if overflow.is_set() else 'child_pipe_error'
                break
            if time.monotonic() >= deadline:
                reason = 'child_deadline'
                break
            time.sleep(0.01)
    except BaseException:
        reason = 'child_supervision_failed'
    reap_end = time.monotonic() + REAP_SECONDS
    if reason and process.poll() is None:
        try:
            process.kill()
        except OSError:
            reason = 'child_kill_failed'
    try:
        process.wait(timeout=max(0.0, reap_end - time.monotonic()))
    except subprocess.TimeoutExpired:
        return {'error': 'child_not_reaped', 'returncode': None,
                'stdout': b'', 'stderr': b'', 'reaped': False}
    # Pipe joins share the SAME five-second reap budget; never add per-pipe waits.
    for reader in readers:
        if reader.ident is not None:
            reader.join(max(0.0, reap_end - time.monotonic()))
    if any(reader.is_alive() for reader in readers):
        reason = 'child_pipe_not_drained'
    elif overflow.is_set() or pipe_error.is_set():
        reason = 'child_output_bound' if overflow.is_set() else 'child_pipe_error'
    return {'error': reason, 'returncode': process.returncode,
            'stdout': bytes(buffers[0]), 'stderr': bytes(buffers[1]), 'reaped': True}


def validate_host(host):
    require(type(host) is dict and set(host) == {'platform', 'python', 'pointer_bytes',
            'wchar_bytes', 'windows_build', 'ntfs', 'no_thread_token_observed'} and
            host['platform'] == 'win32' and type(host['python']) is list and
            len(host['python']) == 3 and host['python'][:2] == [3, 11] and
            all(type(item) is int for item in host['python']) and
            host['pointer_bytes'] == 8 and host['wchar_bytes'] == 2 and
            type(host['windows_build']) is int and 0 < host['windows_build'] < 1000000 and
            host['ntfs'] is True and host['no_thread_token_observed'] is True,
            'w0_host_evidence_missing')


def validate_counts(counts, *, balanced):
    require(type(counts) is dict and set(counts) == {'native_opens', 'native_closes',
            'crt_transfers', 'crt_closes', 'oracle_opens', 'oracle_closes'} and
            all(type(value) is int and 0 <= value < 20000 for value in counts.values()),
            'w0_ownership_evidence')
    if balanced:
        require(counts['native_opens'] == counts['native_closes'] + counts['crt_transfers'] and
                counts['crt_transfers'] == counts['crt_closes'] and
                counts['oracle_opens'] == counts['oracle_closes'], 'w0_ownership_evidence')


def validate_schema(result, scenario):
    """Project failure evidence only after the same closed, bounded wire check."""
    require(type(result) is dict and set(result) == {
        'version', 'scenario', 'ok', 'cleanup', 'checks', 'counts', 'host', 'error',
        'diagnostic'}, 'w0_result_schema')
    require(type(result['version']) is int and result['version'] == 2 and
            result['scenario'] == scenario and type(result['ok']) is bool and
            type(result['cleanup']) is bool and type(result['error']) is str and
            re.fullmatch(r'[A-Za-z0-9_]{0,80}', result['error']) and
            bool(result['error']) is (not result['ok']), 'w0_result_schema')
    require(type(result['checks']) is dict and result['checks'] in
            ({}, {CHECKS[scenario]: True}) and all(value is True
            for value in result['checks'].values()), 'w0_checkpoint_schema')
    value = result['diagnostic']
    require(type(value) is dict and set(value) == {'stage', 'errno', 'winerror'} and
            type(value['stage']) is str and value['stage'] in STAGES and
            all(value[name] is None or type(value[name]) is int and
                0 <= value[name] < 2**32 for name in ('errno', 'winerror')),
            'w0_diagnostic_schema')
    if result['host'] != {}:
        validate_host(result['host'])
    if result['counts'] != {}:
        validate_counts(result['counts'], balanced=False)
    require(type(result['host']) is dict and type(result['counts']) is dict,
            'w0_result_schema')


def validate_result(result, scenario):
    validate_schema(result, scenario)
    require(result['ok'] is True and result['cleanup'] is True and result['error'] == '',
            'w0_native_or_cleanup_failure')
    require(result['checks'] == {CHECKS[scenario]: True}, 'w0_checkpoint_missing')
    require(result['diagnostic'] == {'stage': 'complete', 'errno': None, 'winerror': None},
            'w0_success_diagnostic')
    validate_host(result['host'])
    validate_counts(result['counts'], balanced=True)


def validate_clean_case(case, nonce):
    plain_chain(case)
    require({entry.name for entry in case.iterdir()} == {'.owner'}, 'w0_scratch_not_clean')
    marker = case / '.owner'
    marker_stat = marker.lstat()
    require(stat.S_ISREG(marker_stat.st_mode) and marker_stat.st_size == 32 and
            not marker_stat.st_file_attributes & REPARSE, 'w0_case_marker_kind')
    require(marker.read_text('ascii') == nonce, 'w0_case_owner_changed')


@pytest.mark.parametrize('scenario', SCENARIOS, ids=SCENARIOS)
def test_native_scenario(scenario):
    global _can_continue
    if not _can_continue:
        pytest.exit('w0_prior_case_cleanup_unconfirmed', returncode=1)
    _can_continue = False
    continuation_safe = False
    clean_environment()
    _, worker = origin()
    run, nonce = owned_run()
    cases = run / 'scenarios'
    evidence = run / 'evidence'
    plain_chain(cases)
    plain_chain(evidence)
    case = cases / scenario
    case.mkdir()  # Exclusive: no stale attempt or previous fixture is reused.
    with (case / '.owner').open('x', encoding='ascii') as marker:
        marker.write(nonce)
    environment = dict(os.environ)
    for name in ('PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PYTHONINSPECT',
                 'PYTEST_PLUGINS', 'PYTEST_ADDOPTS'):
        environment.pop(name, None)
    captured = bounded_child([sys.executable, '-I', '-S', '-B', str(worker),
                              scenario, str(case), nonce], environment)
    summary = {'scenario': scenario, 'reaped': captured['reaped'],
               'supervisor_error': captured['error'], 'returncode': captured['returncode'],
               'stdout_bytes': len(captured['stdout']), 'stderr_bytes': len(captured['stderr'])}
    result = None
    try:
        if captured['stdout'] and len(captured['stdout']) <= MAX_PIPE:
            result = json.loads(captured['stdout'].decode('ascii'))
    except (UnicodeError, ValueError, RecursionError):
        summary['supervisor_error'] = 'child_result_invalid'
    # Never persist arbitrary child output: only a complete bounded schema.
    try:
        validate_schema(result, scenario)
    except (RuntimeError, TypeError, KeyError):
        result = None
        summary['supervisor_error'] = 'child_result_invalid'
    else:
        summary['result'] = result
        summary['worker_error'] = result['error']
    try:
        if (not captured['error'] and captured['reaped'] and not captured['stderr']
                and captured['returncode'] == 1 and result is not None
                and result['ok'] is False and result['cleanup'] is True):
            # A safely reaped, positively cleaned failed scenario may be followed
            # by another exclusive child. It remains a FAILED test, never a pass.
            validate_host(result['host'])
            validate_counts(result['counts'], balanced=True)
            validate_clean_case(case, nonce)
            require(owned_run() == (run, nonce), 'w0_run_owner_changed')
            plain_chain(cases)
            plain_chain(evidence)
            continuation_safe = True
        require(not captured['error'] and captured['reaped'] and
                captured['returncode'] == 0 and not captured['stderr'],
                'w0_child_failed_' + str(summary.get('worker_error', captured['error'])))
        validate_result(result, scenario)
        validate_clean_case(case, nonce)
        marker = case / '.owner'
        marker.unlink()
        plain_chain(case)
        case.rmdir()  # Empty case only, after verified native cleanup and child reap.
        require(not case.exists(), 'w0_case_removal_failed')
        require(owned_run() == (run, nonce), 'w0_run_owner_changed')
        plain_chain(cases)
        plain_chain(evidence)
        summary['accepted'] = True
        continuation_safe = True
    finally:
        clean_environment()
        summary['continuation_safe'] = continuation_safe
        encoded = json.dumps(summary, sort_keys=True, separators=(',', ':'))
        require(len(encoded) < MAX_PIPE, 'w0_evidence_bound')
        with (evidence / (scenario + '.json')).open('x', encoding='ascii') as output:
            output.write(encoded + '\n')
        _can_continue = continuation_safe
        if not continuation_safe:
            pytest.exit('w0_case_cleanup_unconfirmed', returncode=1)


class Inventory:
    def __init__(self):
        self.items = []
        self.reports = []

    def pytest_collection_finish(self, session):
        self.items = [item.nodeid for item in session.items]

    def pytest_runtest_logreport(self, report):
        self.reports.append((report.nodeid, report.when, report.outcome))


def write_json(path, value):
    text = json.dumps(value, sort_keys=True, separators=(',', ':'))
    require(len(text) <= 65536, 'w0_driver_evidence_bound')
    with path.open('x', encoding='ascii') as output:
        output.write(text + '\n')


def main():
    require(sys.argv[1:] == ['--ci'], 'w0_fixed_command_required')
    clean_environment()
    checkout, _ = origin()
    require(Path.cwd().resolve(strict=True) == checkout, 'w0_checkout_cwd')
    run = run_location()
    run.mkdir()  # An existing path is a failure, never deleted/reused.
    plain_chain(run)
    nonce = secrets.token_hex(16)
    with (run / '.owner').open('x', encoding='ascii') as marker:
        marker.write(nonce)
    evidence, cases = run / 'evidence', run / 'scenarios'
    evidence.mkdir()
    cases.mkdir()
    plain_chain(evidence)
    # Disabling cacheprovider makes the repository's cache_dir option unknown.
    # Use only this fixed inert config, without weakening strict validation.
    pytest_config = evidence / 'pytest-isolated.ini'
    with pytest_config.open('x', encoding='ascii', newline='\n') as output:
        output.write('[pytest]\n')
    os.environ['ALBUMHAVEN_W0_ROOT'] = str(run)
    args = ['-c', str(pytest_config), '--noconftest', '--import-mode=importlib', '-p', 'no:cacheprovider',
            '--strict-config', '--strict-markers', '--rootdir=' + str(checkout),
            '--tb=short', TEST_PATH]
    write_json(evidence / 'command.json', {
        'version': 1, 'parent': ['python', '-I', '-B', TEST_PATH, '--ci'],
        'pytest_common': args,
        'worker_flags': ['-I', '-S', '-B'], 'scenarios': list(SCENARIOS),
        'child_seconds': CHILD_SECONDS, 'reap_seconds': REAP_SECONDS,
        'pipe_bound_bytes_each': MAX_PIPE, 'activation': False,
    })
    inventory = Inventory()
    collection_code = int(pytest.main([*args, '--collect-only', '-q'], plugins=[inventory]))
    write_json(evidence / 'collection.json', {'exit_code': collection_code,
               'node_ids': inventory.items, 'expected_node_ids': list(NODE_IDS)})
    clean_environment()
    if collection_code != 0 or tuple(inventory.items) != NODE_IDS:
        return collection_code or 1
    run_inventory = Inventory()
    junit = evidence / 'junit.xml'
    run_code = int(pytest.main([*args, '-q', '-vv', '--junitxml=' + str(junit)],
                              plugins=[run_inventory]))
    clean_environment()
    accepted = run_code == 0 and tuple(run_inventory.items) == NODE_IDS
    expected_reports = {(node, phase, 'passed') for node in NODE_IDS
                        for phase in ('setup', 'call', 'teardown')}
    accepted = accepted and len(run_inventory.reports) == len(expected_reports) and \
        set(run_inventory.reports) == expected_reports
    if accepted:
        require(junit.stat().st_size <= 1024 * 1024, 'w0_junit_bound')
        document = ET.parse(junit)
        testcases = document.findall('.//testcase')
        accepted = len(testcases) == len(SCENARIOS) and not any(
            node.tag in ('failure', 'error', 'skipped') for node in document.iter())
        for scenario in SCENARIOS:
            path = evidence / (scenario + '.json')
            require(path.stat().st_size <= MAX_PIPE, 'w0_case_evidence_bound')
            record = json.loads(path.read_text('ascii'))
            require(record.get('accepted') is True and record.get('reaped') is True,
                    'w0_case_not_accepted')
            validate_result(record['result'], scenario)
    write_json(evidence / 'summary.json', {'version': 1, 'accepted': bool(accepted),
        'pytest_exit_code': run_code, 'expected_count': len(SCENARIOS),
        'actual_count': len(run_inventory.items), 'activation': False})
    return 0 if accepted else run_code or 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except RuntimeError as error:
        message = str(error)
        print(message if re.fullmatch(r'[A-Za-z0-9_]{1,160}', message)
              else 'w0_driver_failure', file=sys.stderr)
        raise SystemExit(1) from None
