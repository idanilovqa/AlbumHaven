"""Apply one digest-verified repair; publish only the explicit tested file set."""
import base64
import gzip
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import sys

transport = Path(__file__).resolve().parent
manifest = json.loads((transport / 'js-batch-manifest.json').read_text())

def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()

def require_head():
    actual = git('ls-remote', '--exit-code', 'origin', 'refs/heads/' + manifest['target_branch']).split()[0]
    assert actual == manifest['expected_head'], 'PR head changed; reconcile instead of overwriting'

def require_files(expected, cached=False):
    args = ['diff', '--name-only'] + (['--cached'] if cached else [])
    actual = set(git(*args).splitlines())
    expected = set(expected)
    assert actual == expected, {'unexpected': sorted(actual - expected), 'missing': sorted(expected - actual)}

mode = sys.argv[1]
if mode == 'apply':
    assert git('rev-parse', 'HEAD') == manifest['expected_head']
    require_head()
    encoded = ''.join((transport / 'js-batch.patch.gz.b64').read_text().split())
    # Correct the identified transcription byte; the unchanged decoded SHA256
    # still verifies every source edit against the locally tested patch.
    encoded = encoded.replace('F1LHailIVhe+VKAG', 'F1LHailIVhf+VKAG')
    patch = gzip.decompress(base64.b64decode(encoded, validate=True))
    assert hashlib.sha256(patch).hexdigest() == manifest['patch_sha256'], 'Patch transport digest mismatch'
    subprocess.run(['git', 'config', 'core.autocrlf', 'false'], check=True)
    for name in manifest['files']:
        p = Path(name)
        p.write_bytes(p.read_bytes().replace(b'\r\n', b'\n'))
    patch_path = Path(os.environ['RUNNER_TEMP']) / 'js-repair.patch'
    patch_path.write_bytes(patch)
    subprocess.run(['git', 'apply', '--check', '--unidiff-zero', '--whitespace=error-all', str(patch_path)], check=True)
    subprocess.run(['git', 'apply', '--unidiff-zero', '--whitespace=error-all', str(patch_path)], check=True)
    # Untouched Windows checkout files remain CRLF; use the original clean
    # conversion for diff and staging rather than treating all of them as edits.
    subprocess.run(['git', 'config', 'core.autocrlf', 'true'], check=True)
    require_files(manifest['files'])
    subprocess.run(['git', 'diff', '--check'], check=True)
    for name in manifest['files']:
        if name.endswith('.js'):
            subprocess.run(['node', '--check', name], check=True)
    print('Verified and applied complete', len(manifest['files']), 'file repair')
elif mode == 'node':
    subprocess.run(['node', '--test', '--test-concurrency=1', '--test-reporter=spec', *manifest['node_tests']], check=True)
elif mode == 'publish':
    expected = sorted(manifest['files'] + manifest['snapshots'])
    require_files(expected)
    for name, height in zip(manifest['snapshots'], [76, 100]):
        data = Path(name).read_bytes()
        assert data[:8] == b'\x89PNG\r\n\x1a\n'
        assert struct.unpack('>II', data[16:24]) == (1280, height), 'Unexpected snapshot geometry'
    subprocess.run(['git', 'diff', '--check'], check=True)
    subprocess.run(['git', 'add', '--', *expected], check=True)
    require_files(expected, cached=True)
    require_head()
    subprocess.run(['git', 'config', 'user.name', 'github-actions[bot]'], check=True)
    subprocess.run(['git', 'config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'], check=True)
    subprocess.run(['git', 'commit', '-m', 'fix: repair JavaScript and component contracts across all three CI jobs'], check=True)
    require_head()
    subprocess.run(['git', 'push', 'origin', 'HEAD:refs/heads/' + manifest['target_branch']], check=True)
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as out:
        out.write('Repair commit: ' + git('rev-parse', 'HEAD') + '\nNative PR CI for all three jobs remains required.\n')
else:
    raise ValueError(mode)
