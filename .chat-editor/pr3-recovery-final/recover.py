"""Verify the pinned PR3 recovery and publish only its exact reviewed tree delta."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

BASE = 'ff81ffd4e846fa6606054b9d3b30dadffa4a6e18'
HELPER = 'cd2779d9bf51fc84a76c8cbb34ae6eec64040841'
TARGET = '2026-09-08-settings-refactor'
TRANSPORT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = '.chat-editor/pr3-recovery-final/manifest.json'
NODE_TESTS = [
    'tests/js/runtime/problem-exclusion-mutations.test.js',
    'tests/js/e2e-run192-contracts.test.js',
    'tests/js/e2e-run204-contracts.test.js',
    'tests/js/e2e-settings-contracts.test.js',
    'tests/js/e2e-action-production-paths.test.js',
    'tests/js/track-modal-actions.test.js',
    'tests/js/runtime/utility-loop-playback.test.js',
    'tests/js/runtime/playback-control-cluster.test.js',
    'tests/js/runtime/loop-range-controls.test.js',
    'tests/js/validate-foundation-gates.test.js',
]


def git(*args: str, cwd: Path | None = None, data: bytes | None = None) -> bytes:
    return subprocess.run(['git', *args], cwd=cwd, input=data, check=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout


def manifest() -> dict:
    raw = git('show', f'HEAD:{MANIFEST_PATH}', cwd=TRANSPORT)
    result = json.loads(raw)
    assert result['base_head'] == BASE
    assert result['source_helper_head'] == HELPER
    assert result['target_branch'] == TARGET
    assert len(result['files']) == 19
    return result


def remote_head() -> str:
    return git('ls-remote', '--exit-code', 'origin', f'refs/heads/{TARGET}').decode().split()[0]


def verify_tree(spec: dict) -> None:
    expected = sorted(spec['files'])
    observed = git('diff', '--cached', '--name-only', '-z').decode().strip('\0').split('\0')
    assert sorted(observed) == expected, ('Unexpected staged file inventory', observed)
    for name, hashes in spec['files'].items():
        got = git('rev-parse', ':' + name).decode().strip()
        assert got == hashes['after'], ('Output blob mismatch', name, got, hashes['after'])
        mode = git('ls-files', '--stage', '--', name).decode().split()[0]
        assert mode == '100644', ('Unexpected output mode', name, mode)
    git('diff', '--cached', '--check')
    assert not git('diff', '--name-only'), 'Unstaged tracked changes remain'


def apply(spec: dict) -> None:
    assert git('rev-parse', 'HEAD').decode().strip() == BASE
    assert remote_head() == BASE, 'PR advanced; reconcile before applying'
    assert not git('status', '--porcelain', '--untracked-files=no'), 'Checkout is not clean'
    for name, hashes in spec['files'].items():
        entry = git('ls-tree', BASE, '--', name).decode().strip()
        if hashes['before'] is None:
            assert not entry, ('New file already exists', name)
        else:
            metadata, actual_name = entry.split('\t', 1)
            mode, kind, sha = metadata.split()
            assert (mode, kind, actual_name, sha) == ('100644', 'blob', name, hashes['before']), ('Input blob mismatch', name, entry)
    print('Verified exact PR head and all 19 input identities.', flush=True)
    for index, item in enumerate(spec['patches']):
        ref = HELPER if index < 3 else 'HEAD'
        patch = git('show', f"{ref}:{item['path']}", cwd=TRANSPORT)
        assert hashlib.sha256(patch).hexdigest() == item['sha256'], ('Patch digest mismatch', item['path'])
        # The index contains canonical Git bytes; preserve native Windows checkout
        # conversion instead of changing core.autocrlf or rewriting patch hashes.
        git('apply', '--cached', '--check', '--whitespace=error-all', '-', data=patch)
        git('apply', '--cached', '--whitespace=error-all', '-', data=patch)
        print('Applied checksum-verified patch:', item['path'], flush=True)
    paths = b'\0'.join(name.encode() for name in spec['files']) + b'\0'
    git('checkout-index', '--force', '-z', '--stdin', data=paths)
    verify_tree(spec)
    evidence = Path(os.environ['RUNNER_TEMP']) / 'pr3-recovery-evidence'
    evidence.mkdir(exist_ok=True)
    (evidence / 'verified-manifest.json').write_text(json.dumps(spec, indent=2) + '\n', encoding='utf-8')
    print('Verified all 19 output blobs and exact staged inventory.', flush=True)


def publish(spec: dict) -> None:
    results = {name: os.environ.get(name) for name in ('NODE_RESULT', 'PYTHON_RESULT', 'COMPONENT_RESULT', 'INVENTORY_RESULT', 'BUILD_RESULT')}
    assert set(results.values()) == {'success'}, ('Focused verification did not pass', results)
    assert remote_head() == BASE, 'PR advanced; refusing publication'
    assert git('rev-parse', 'HEAD').decode().strip() == BASE
    git('add', '--', *sorted(spec['files']))
    verify_tree(spec)
    git('-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        'commit', '-m', 'fix: recover complete PR3 CI repair batch')
    assert git('rev-parse', 'HEAD^').decode().strip() == BASE
    assert remote_head() == BASE, 'PR advanced before push; commit was not pushed'
    git('push', 'origin', f'HEAD:refs/heads/{TARGET}')
    head = git('rev-parse', 'HEAD').decode().strip()
    assert remote_head() == head, 'Remote publication identity could not be confirmed'
    print('PR3_PUBLISHED_HEAD=' + head, flush=True)
    evidence = Path(os.environ['RUNNER_TEMP']) / 'pr3-recovery-evidence'
    (evidence / 'publication.json').write_text(json.dumps({'head': head, 'parent': BASE, 'branch': TARGET, 'checks': results}, indent=2) + '\n', encoding='utf-8')
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as stream:
        stream.write(f'Published 19 verified files to `{TARGET}` at `{head}`. Full native PR CI remains required.\n')


def main() -> None:
    spec = manifest()
    mode = sys.argv[1]
    if mode == 'apply':
        apply(spec)
    elif mode == 'node':
        for name in NODE_TESTS:
            assert Path(name).is_file(), ('Missing focused test', name)
        subprocess.run(['node', '--test', '--test-concurrency=1', *NODE_TESTS], check=True)
    elif mode == 'publish':
        publish(spec)
    else:
        raise ValueError('Unknown operation: ' + mode)


if __name__ == '__main__':
    main()
