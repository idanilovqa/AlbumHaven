"""Temporary diagnostic instrumentation. Never published to the PR."""
from pathlib import Path
import subprocess
import sys

p = Path('tests/py/conftest.py')
s = p.read_text(encoding='utf-8')
start = s.index('def _remove_owned_generated_pytest_root(')
end = s.index('\ndef _cleanup_stale_generated_pytest_roots()', start)
part = s[start:end]
# Trace rmtree failures and revalidation separately without changing their handling.
part = part.replace('        except OSError:\n            if not path.exists():', '        except OSError as exc:\n            print("CLEANUP_RMTREE", repr(exc), getattr(exc, "winerror", None), str(path), flush=True)\n            if not path.exists():')
part = part.replace('            return False\n        try:\n            shutil.rmtree(path)', '            print("CLEANUP_IDENTITY_REJECT", str(path), directory_identity, (current.st_dev, current.st_ino), _owned_generated_pytest_root(path), owner, flush=True)\n            return False\n        try:\n            shutil.rmtree(path)')
s = s[:start] + part + s[end:]
s += '''\n_cleanup_original = _remove_owned_generated_pytest_root\ndef _remove_owned_generated_pytest_root(path, *, expected_owner=None):\n    result = _cleanup_original(path, expected_owner=expected_owner)\n    print("CLEANUP_RESULT", str(path), expected_owner, result, flush=True)\n    if path.exists():\n        print("CLEANUP_REMAINS", [(str(p.relative_to(path)), p.is_dir()) for p in path.rglob("*")], flush=True)\n    return result\n'''
compile(s, str(p), 'exec')
p.write_text(s, encoding='utf-8', newline='\n')
p = Path('tests/py/test_pytest_harness_config.py')
s = p.read_text(encoding='utf-8')
s = s.replace('        results.append(_probe_result(stdout))', '        print("CHILD_PROBE", process.pid, stdout, stderr, flush=True)\n        results.append(_probe_result(stdout))')
p.write_text(s, encoding='utf-8', newline='\n')
failures = 0
for trial in range(6):
    print('INDEPENDENT DIAGNOSTIC TRIAL', trial + 1, flush=True)
    result = subprocess.run([sys.executable, '-m', 'pytest', '-q', '-s', '--tb=short', 'tests/py/test_pytest_harness_config.py::test_two_concurrent_default_pytest_processes_use_isolated_roots_and_cleanup_both'])
    failures += result.returncode != 0
print('FAILED DIAGNOSTIC TRIALS', failures, flush=True)
raise SystemExit(bool(failures))
