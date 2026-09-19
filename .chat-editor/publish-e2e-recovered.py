from pathlib import Path
import json, subprocess

EXPECTED = 'ea256e48e5b72e1617f01c9954beec3b432e7da2'
BRANCH = '2026-09-08-settings-refactor'
transport = Path(__file__).resolve().parent

def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()

def require_head():
    assert git('ls-remote', '--exit-code', 'origin', 'refs/heads/' + BRANCH).split()[0] == EXPECTED, 'PR changed; refusing to overwrite'

require_head()
files = json.loads((transport / 'e2e-recovered-files.json').read_text())
assert len(files) == 27
subprocess.run(['git', 'switch', '--detach', EXPECTED], check=True)
for path, (before, after) in files.items():
    if before is None:
        assert not Path(path).exists(), path
    else:
        assert git('rev-parse', EXPECTED + ':' + path) == before, 'Baseline mismatch: ' + path
subprocess.run(['python', str(transport / 'add-e2e-recovered-tests.py')], check=True)
subprocess.run(['python', str(transport / 'restore-e2e-recovered.py')], check=True)
plan = Path('docs/superpowers/plans/2026-09-09-settings-refactor.md')
checkpoint = (transport / 'e2e-recovered-checkpoint.md').read_text()
assert checkpoint.splitlines()[0] not in plan.read_text()
plan.write_text(plan.read_text().replace('## 6. Verification commands', checkpoint + '## 6. Verification commands'))
subprocess.run(['node', 'scripts/build-runtime-bundle.cjs'], check=True)
for path, (before, after) in files.items():
    actual = git('hash-object', '--', path)
    assert actual == after, (path, actual, after)
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
