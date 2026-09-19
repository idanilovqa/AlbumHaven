"""Read-only-behavior diagnostic; no instrumentation is published to the PR."""
from pathlib import Path
import subprocess
import sys

p = Path('tests/py/conftest.py')
s = p.read_text(encoding='utf-8')
a = s.index('def _owned_generated_pytest_root(')
b = s.index('\ndef _preserve_pytest_owner_after_partial_removal', a)
part = s[a:b].replace('except (OSError, ValueError, TypeError):', 'except (OSError, ValueError, TypeError) as exc:\n        print("OWNER_READ_ERROR", str(path), repr(exc), getattr(exc, "winerror", None), flush=True)')
s = s[:a]+part+s[b:]
a=s.index('def _remove_owned_generated_pytest_root(');b=s.index('\ndef _cleanup_stale_generated_pytest_roots()',a)
part=s[a:b].replace('        except OSError:\n            if not path.exists():','        except OSError as exc:\n            print("CLEANUP_RMTREE", repr(exc), getattr(exc, "winerror", None), str(path), flush=True)\n            if not path.exists():')
part=part.replace('            return False\n        try:\n            shutil.rmtree(path)', '            print("IDENTITY_REJECT", str(path), directory_identity, (current.st_dev,current.st_ino), _owned_generated_pytest_root(path), owner, flush=True)\n            return False\n        try:\n            shutil.rmtree(path)')
s=s[:a]+part+s[b:]
compile(s,str(p),'exec');p.write_text(s,encoding='utf-8',newline='\n')
p=Path('tests/py/test_pytest_harness_config.py');s=p.read_text(encoding='utf-8')
s=s.replace('        results.append(_probe_result(stdout))','        print("CHILD_PROBE", process.pid, stdout, stderr, flush=True)\n        results.append(_probe_result(stdout))')
s=s.replace('    assert all(not root.exists() for root in roots)', '    assert all(not root.exists() for root in roots), [(str(root), [(str(item.relative_to(root)), item.is_dir()) for item in root.rglob("*")]) for root in roots if root.exists()]')
p.write_text(s,encoding='utf-8',newline='\n')
failed=0
for trial in range(20):
    print('COMPLETE HARNESS DIAGNOSTIC TRIAL',trial+1,flush=True)
    result=subprocess.run([sys.executable,'-m','pytest','-q','-s','--tb=short','tests/py/test_pytest_harness_config.py'],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
    if result.returncode:
        print(result.stdout,flush=True)
        failed+=1
    else:
        print('Trial passed',flush=True)
print('FAILED TRIALS',failed,flush=True)
raise SystemExit(bool(failed))
