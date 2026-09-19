from pathlib import Path
import base64, gzip, hashlib, re, subprocess

EXPECTED = 'ea256e48e5b72e1617f01c9954beec3b432e7da2'
BRANCH = '2026-09-08-settings-refactor'
DIGEST = '0e8004d8b6d4f7635a82e2e1059626fcc2710b987e4f58431c9a372e68d7e8a0'
transport = Path(__file__).resolve().parent

def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()

def require_head():
    assert git('ls-remote', '--exit-code', 'origin', 'refs/heads/' + BRANCH).split()[0] == EXPECTED, 'PR changed; refusing to overwrite'

require_head()
patch = gzip.decompress(base64.b64decode((transport / 'e2e-recovered.patch.gz.b64').read_text()))
assert hashlib.sha256(patch).hexdigest() == DIGEST, 'Patch digest mismatch'
assert len(patch) == 37546
subprocess.run(['git', 'switch', '--detach', EXPECTED], check=True)
files = {}
for section in patch.decode().split('diff --git ')[1:]:
    header = section.splitlines()[0]
    a, b = header.split(' ')
    assert a[2:] == b[2:]
    path = b[2:]
    assert path.startswith(('music_app/static/', 'tests/', 'docs/superpowers/plans/'))
    before, after = re.search(r'^index ([0-9a-f]{40})\.\.([0-9a-f]{40})', section, re.M).groups()
    if before == '0' * 40:
        assert not Path(path).exists(), path
    else:
        assert git('rev-parse', EXPECTED + ':' + path) == before, 'Baseline mismatch: ' + path
    files[path] = after
assert len(files) == 27
patch_path = transport / 'verified-e2e.patch'
patch_path.write_bytes(patch)
subprocess.run(['git', 'apply', '--unidiff-zero', '--check', '--whitespace=error-all', str(patch_path)], check=True)
subprocess.run(['git', 'apply', '--unidiff-zero', '--whitespace=error-all', str(patch_path)], check=True)
subprocess.run(['node', 'scripts/build-runtime-bundle.cjs'], check=True)
for path, after in files.items():
    assert git('hash-object', '--', path) == after, 'Changed bytes: ' + path
    if path.endswith('.js'):
        subprocess.run(['node', '--check', path], check=True)
subprocess.run(['node', 'scripts/check-e2e-production-parity.cjs'], check=True)
subprocess.run(['git', 'diff', '--check'], check=True)
subprocess.run(['git', 'add', '--', *files], check=True)
assert git('diff', '--cached', '--name-only').splitlines() == sorted(files)
require_head()
subprocess.run(['git', 'config', 'user.name', 'github-actions[bot]'], check=True)
subprocess.run(['git', 'config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'], check=True)
subprocess.run(['git', 'commit', '-m', 'fix: recover E2E action state and approved settings contracts'], check=True)
require_head()
subprocess.run(['git', 'push', 'origin', 'HEAD:refs/heads/' + BRANCH], check=True)
print('Published recovered batch:', git('rev-parse', 'HEAD'))
