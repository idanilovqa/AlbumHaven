"""Apply only the reviewed, hash-verified PR 3 recovery; never merge transport."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import xml.etree.ElementTree as ET

TRANSPORT = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((Path(__file__).parent / 'recover-pr3-manifest.json').read_text(encoding='utf-8'))
WORK = Path.cwd()
EVIDENCE = Path(os.environ['RUNNER_TEMP']) / 'pr3-recovery-evidence'
EVIDENCE.mkdir(parents=True, exist_ok=True)
BUNDLE = 'music_app/static/js/runtime-bundle.js'


def output(*args: str, cwd: Path = WORK) -> bytes:
    return subprocess.check_output(list(args), cwd=cwd)


def run(*args: str) -> None:
    subprocess.run(list(args), cwd=WORK, check=True)


def blob(data: bytes) -> str:
    return hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()


def unchanged_remote() -> None:
    line = output('git', 'ls-remote', '--exit-code', 'origin', 'refs/heads/' + MANIFEST['branch']).decode().strip()
    if line.split()[0] != MANIFEST['head']:
        raise RuntimeError('PR head changed; refusing to overwrite concurrent work.')


def verify_files(state: str) -> None:
    for name, identities in MANIFEST['files'].items():
        path = WORK / name
        expected = identities[state]
        if expected is None:
            if path.exists():
                raise RuntimeError('Expected absent file: ' + name)
            continue
        actual = blob(path.read_bytes())
        if actual != expected:
            raise RuntimeError(f'{state} blob mismatch: {name}: {actual} != {expected}')
        if state == 'before':
            stored = output('git', 'rev-parse', 'HEAD:' + name).decode().strip()
            if stored != expected:
                raise RuntimeError('Commit tree blob mismatch: ' + name)
    print(f'Verified all {len(MANIFEST["files"])} {state} file identities.', flush=True)


def logged(label: str, command: list[str]) -> None:
    with (EVIDENCE / (label + '.log')).open('w', encoding='utf-8') as log:
        process = subprocess.Popen(command, cwd=WORK, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   text=True, encoding='utf-8', errors='replace')
        assert process.stdout is not None
        for line in process.stdout:
            log.write(line)
            print(line, end='', flush=True)
        code = process.wait()
        if code:
            raise subprocess.CalledProcessError(code, command)


def apply() -> None:
    if output('git', 'rev-parse', 'HEAD').decode().strip() != MANIFEST['head']:
        raise RuntimeError('Wrong application checkout.')
    if output('git', 'status', '--porcelain').strip():
        raise RuntimeError('Application checkout must start clean.')
    unchanged_remote()
    # This is a fresh disposable runner checkout, not an owner working directory.
    run('git', 'config', 'core.autocrlf', 'false')
    run('git', 'checkout-index', '--force', '--all')
    verify_files('before')
    for name, digest in MANIFEST['patches'].items():
        data = output('git', 'show', MANIFEST['transport_head'] + ':.chat-editor/run202-repair/' + name, cwd=TRANSPORT)
        if hashlib.sha256(data).hexdigest() != digest:
            raise RuntimeError('Saved patch checksum mismatch: ' + name)
        patch = EVIDENCE / name
        patch.write_bytes(data)
        run('git', 'apply', '--check', '--whitespace=error-all', '--exclude=' + BUNDLE, str(patch))
        run('git', 'apply', '--whitespace=error-all', '--exclude=' + BUNDLE, str(patch))
    plan = WORK / 'docs/superpowers/plans/2026-09-09-settings-refactor.md'
    text = plan.read_text(encoding='utf-8')
    anchor = '## 6. Verification commands\n'
    if text.count(anchor) != 1:
        raise RuntimeError('Unexpected owning plan anchor.')
    note = (Path(__file__).parent / 'recover-pr3-note.md').read_text(encoding='utf-8')
    plan.write_bytes(text.replace(anchor, note + anchor).encode('utf-8'))
    run('node', 'scripts/build-runtime-bundle.cjs')
    verify_files('after')
    run('git', 'diff', '--check')
    (EVIDENCE / 'verified-manifest.json').write_text(json.dumps(MANIFEST, indent=2), encoding='utf-8')


def check_node() -> None:
    tests = [
        'tests/js/runtime/problem-exclusion-mutations.test.js',
        'tests/js/runtime/utility-suggested-edits.test.js',
        'tests/js/runtime/utility-problematic-review-contracts.test.js',
        'tests/js/runtime/utility-problematic-tab.test.js',
        'tests/js/runtime/playback-control-cluster.test.js',
        'tests/js/runtime/loop-range-controls.test.js',
        'tests/js/runtime/utility-loop-playback.test.js',
        'tests/js/e2e-action-production-paths.test.js',
        'tests/js/e2e-performance-helper-guards.test.js',
        'tests/js/e2e-run192-contracts.test.js',
        'tests/js/e2e-run204-contracts.test.js',
        'tests/js/e2e-settings-contracts.test.js',
        'tests/js/global-player-detail-waveform.test.js',
        'tests/js/track-modal-actions.test.js',
    ]
    logged('node', ['node', '--test', '--test-concurrency=1', *tests])
    logged('parity', ['node', 'scripts/check-e2e-production-parity.cjs'])


def check_python() -> None:
    junit = EVIDENCE / 'pytest.xml'
    logged('python', [sys.executable, '-m', 'pytest', 'tests/py/test_pytest_harness_config.py', '-q', '--junitxml=' + str(junit)])
    cases = ET.parse(junit).findall('.//testcase')
    if len(cases) != 17 or any(case.find('skipped') is not None for case in cases):
        raise RuntimeError('Expected all 17 native Windows harness cases, without skips.')


def check_components() -> None:
    logged('components', ['node', 'node_modules/@playwright/test/cli.js', 'test', '--config=playwright.component.config.js',
                          'tests/components/playerViews.spec.js'])


def publish() -> None:
    if any(os.environ.get(key) != 'success' for key in ('NODE_RESULT', 'PYTHON_RESULT', 'COMPONENT_RESULT')):
        raise RuntimeError('Every focused verification must pass; nothing will be published.')
    unchanged_remote()
    verify_files('after')
    run('git', 'diff', '--check')
    names = sorted(MANIFEST['files'])
    run('git', 'add', '--', *names)
    staged = sorted(output('git', 'diff', '--cached', '--name-only').decode().splitlines())
    if staged != names:
        raise RuntimeError('Staged inventory differs from reviewed files: ' + repr(staged))
    for name in names:
        if output('git', 'rev-parse', ':' + name).decode().strip() != MANIFEST['files'][name]['after']:
            raise RuntimeError('Staged blob mismatch: ' + name)
    (EVIDENCE / 'repair.diff').write_bytes(output('git', 'diff', '--cached', '--binary'))
    run('git', 'config', 'user.name', 'github-actions[bot]')
    run('git', 'config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
    run('git', 'commit', '-m', 'fix: recover complete PR3 CI repair with ownership-safe cleanup')
    unchanged_remote()
    run('git', 'push', 'origin', 'HEAD:refs/heads/' + MANIFEST['branch'])
    published = output('git', 'rev-parse', 'HEAD').decode().strip()
    print('PUBLISHED_PR_HEAD=' + published, flush=True)
    with Path(os.environ['GITHUB_STEP_SUMMARY']).open('a', encoding='utf-8') as summary:
        summary.write(f'Published 17 reviewed repair files to `{MANIFEST["branch"]}` at `{published}`.\n\n'
                      'Focused native checks passed. Complete PR Gates and final manual acceptance remain required.\n')


if __name__ == '__main__':
    commands = {'apply': apply, 'node': check_node, 'python': check_python, 'components': check_components, 'publish': publish}
    if len(sys.argv) != 2 or sys.argv[1] not in commands:
        raise SystemExit('Expected apply, node, python, components or publish.')
    commands[sys.argv[1]]()
