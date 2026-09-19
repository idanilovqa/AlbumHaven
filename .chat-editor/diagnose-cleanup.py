"""Read-only Windows cleanup diagnostics; never published to the PR branch."""
from pathlib import Path
import os
import subprocess
import sys

INSTRUMENTATION = r'''
# Temporary diagnostic instrumentation: the removal implementation is unchanged.
def _cleanup_diagnostic(event, path, **values):
    import logging
    output = Path(os.environ["AH_CLEANUP_DIAGNOSTICS"]) / f"process-{os.getpid()}.jsonl"
    try:
        handlers = []
        for ref in logging._handlerList:
            handler = ref()
            if handler is not None and getattr(handler, "baseFilename", None):
                handlers.append({"file": str(handler.baseFilename), "closed": getattr(getattr(handler, "stream", None), "closed", None)})
        values.update(event=event, pid=os.getpid(), path=str(path), workspace=str(_workspace_pytest_temp_root()),
                      exists=path.exists(), owner=_owned_generated_pytest_root(path),
                      remaining=[str(item.relative_to(path)) for item in path.rglob("*")][:50] if path.is_dir() else [],
                      file_handlers=handlers)
        with output.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(values, default=str) + "\n")
    except Exception as exc:
        print("cleanup diagnostic failed:", repr(exc), file=sys.stderr)
_diagnostic_original_rmtree = shutil.rmtree
def _diagnostic_rmtree(path, *args, **kwargs):
    try:
        return _diagnostic_original_rmtree(path, *args, **kwargs)
    except OSError as exc:
        _cleanup_diagnostic("rmtree-error", Path(path), error=repr(exc), errno=exc.errno, winerror=getattr(exc,"winerror",None), filename=exc.filename, filename2=exc.filename2)
        raise
shutil.rmtree = _diagnostic_rmtree
_diagnostic_original_remove = _remove_owned_generated_pytest_root
def _remove_owned_generated_pytest_root(path, *, expected_owner=None):
    result = _diagnostic_original_remove(path, expected_owner=expected_owner)
    _cleanup_diagnostic("remove-result", path, expected_owner=expected_owner, result=result)
    return result
'''


def main():
    folder = Path(os.environ['RUNNER_TEMP']) / 'cleanup-diagnostics'
    folder.mkdir(parents=True, exist_ok=True)
    os.environ['AH_CLEANUP_DIAGNOSTICS'] = str(folder)
    harness = Path('tests/py/conftest.py')
    original = harness.read_bytes()
    instrumented = original.decode('utf-8') + INSTRUMENTATION
    compile(instrumented, str(harness), 'exec')
    harness.write_text(instrumented, encoding='utf-8', newline='\n')
    command = [sys.executable, '-m', 'pytest', '-q', '--tb=short',
               'tests/py/test_pytest_harness_config.py::test_two_concurrent_default_pytest_processes_use_isolated_roots_and_cleanup_both']
    results = []
    try:
        for attempt in range(1, int(os.environ.get('DIAGNOSTIC_ATTEMPTS', '12')) + 1):
            result = subprocess.run(command, capture_output=True, text=True, timeout=120)
            (folder / f'attempt-{attempt:02d}.log').write_text(result.stdout + '\n' + result.stderr, encoding='utf-8')
            results.append(result.returncode)
            print(f'DIAGNOSTIC attempt {attempt}: exit={result.returncode}', flush=True)
            if result.returncode:
                print(result.stdout[-5000:] + result.stderr[-5000:])
                break
    finally:
        harness.write_bytes(original)
    print('Diagnostic exit codes:', results)
    for path in sorted(folder.glob('process-*.jsonl')):
        for line in path.read_text(encoding='utf-8').splitlines():
            if '"result": false' in line or '"event": "rmtree-error"' in line:
                print(line)


if __name__ == '__main__':
    main()
