const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { _private } = require('../../scripts/run-functional-playwright.cjs');

test('functional orchestrator runs the three isolated scenarios before one shared general suite', () => {
  const calls = [];
  const result = _private.runFunctionalSuites(['test', '--headed'], {
    spawnSyncFn(command, args, options) {
      calls.push({ command, args, options });
      return { status: calls.length === 1 ? 1 : 0, signal: null };
    },
  });

  assert.deepEqual(result, { exitCode: 1, signal: null });
  assert.equal(calls.length, 4, 'the unfiltered full run must launch each suite directly');
  assert.deepEqual(
    calls.map((call) => call.args.slice(1)),
    [
      ['test', '--headed', '--config=playwright.lastfm-auto-timezone.config.js'],
      ['test', '--headed', '--config=playwright.cover-rescan.config.js'],
      ['test', '--headed', '--config=playwright.non-album-rescan.config.js'],
      ['test', '--headed', '--config=playwright.config.js'],
    ],
  );
  for (const call of calls) {
    assert.equal(call.command, process.execPath);
    assert.equal(call.args[0], path.resolve(__dirname, '..', '..', 'scripts', 'run-playwright.cjs'));
    assert.equal(call.options.stdio, 'inherit');
    assert.equal(call.options.windowsHide, true);
  }
  assert.equal(
    calls[0].options.env.ALBUM_HAVEN_E2E_LASTFM_TIMEZONE_MODE,
    'blank',
  );
  assert.equal(calls[1].options.env.ALBUM_HAVEN_E2E_LASTFM_TIMEZONE_MODE, undefined);
  assert.equal(calls[2].options.env.ALBUM_HAVEN_E2E_LASTFM_TIMEZONE_MODE, undefined);
  assert.equal(calls[3].options.env.ALBUM_HAVEN_E2E_LASTFM_TIMEZONE_MODE, undefined);
});

test('functional orchestrator succeeds only when all four suites pass', () => {
  assert.deepEqual(_private.runFunctionalSuites(['test'], {
    spawnSyncFn: () => ({
      status: 0,
      signal: null,
    }),
  }), { exitCode: 0, signal: null });
});

test('functional orchestrator treats spawn errors as failure and still runs the next suite', () => {
  let callCount = 0;
  const result = _private.runFunctionalSuites(['test'], {
    spawnSyncFn() {
      callCount += 1;
      return callCount === 1
        ? { status: null, signal: null, error: new Error('spawn failed') }
        : { status: 0, signal: null };
    },
  });

  assert.deepEqual(result, { exitCode: 1, signal: null });
  assert.equal(callCount, 4);
});

test('focused filters skip no-tests discovery without a terminal period and run a later match', () => {
  const calls = [];
  const result = _private.runFunctionalSuites(['test', 'coverLookup.spec.js', '--grep', 'FTC-COVERS-007'], {
    spawnSyncFn(_command, args) {
      calls.push(args.slice(1));
      const isDedicated = args.some((arg) => (
        arg.includes('lastfm-auto-timezone')
        || arg.includes('cover-rescan')
        || arg.includes('non-album-rescan')
      ));
      if (args.includes('--list')) {
        return isDedicated
          ? { status: 1, signal: null, stdout: '', stderr: 'Error: No tests found\n' }
          : { status: 0, signal: null, stdout: 'Total: 2 tests in 1 file\n', stderr: '' };
      }
      return { status: 0, signal: null, stdout: '', stderr: '' };
    },
  });

  assert.deepEqual(result, { exitCode: 0, signal: null });
  assert.deepEqual(calls, [
    ['test', 'coverLookup.spec.js', '--grep', 'FTC-COVERS-007', '--list', '--config=playwright.lastfm-auto-timezone.config.js'],
    ['test', 'coverLookup.spec.js', '--grep', 'FTC-COVERS-007', '--list', '--config=playwright.cover-rescan.config.js'],
    ['test', 'coverLookup.spec.js', '--grep', 'FTC-COVERS-007', '--list', '--config=playwright.non-album-rescan.config.js'],
    ['test', 'coverLookup.spec.js', '--grep', 'FTC-COVERS-007', '--list', '--config=playwright.config.js'],
    ['test', 'coverLookup.spec.js', '--grep', 'FTC-COVERS-007', '--config=playwright.config.js'],
  ]);
});

test('focused filters fail when neither config discovers a test', () => {
  let callCount = 0;
  const result = _private.runFunctionalSuites(['test', '--grep', 'DOES-NOT-EXIST'], {
    spawnSyncFn() {
      callCount += 1;
      return { status: 1, signal: null, stdout: '', stderr: 'Error: No tests found.\n' };
    },
  });

  assert.deepEqual(result, { exitCode: 1, signal: null });
  assert.equal(callCount, 4);
});

test('short positive grep alias discovers and runs only the matching config', () => {
  for (const alias of ['-g']) {
    const calls = [];
    const result = _private.runFunctionalSuites(['test', alias, 'FTC-COVERS-007'], {
      spawnSyncFn(_command, args) {
        calls.push(args.slice(1));
        const isDedicated = args.some((arg) => (
          arg.includes('lastfm-auto-timezone')
          || arg.includes('cover-rescan')
          || arg.includes('non-album-rescan')
        ));
        if (args.includes('--list')) {
          return isDedicated
            ? { status: 1, signal: null, stdout: '', stderr: 'Error: No tests found.\n' }
            : { status: 0, signal: null, stdout: 'Total: 2 tests in 1 file\n', stderr: '' };
        }
        return { status: 0, signal: null, stdout: '', stderr: '' };
      },
    });

    assert.deepEqual(result, { exitCode: 0, signal: null }, alias);
    assert.deepEqual(calls, [
      ['test', alias, 'FTC-COVERS-007', '--list', '--config=playwright.lastfm-auto-timezone.config.js'],
      ['test', alias, 'FTC-COVERS-007', '--list', '--config=playwright.cover-rescan.config.js'],
      ['test', alias, 'FTC-COVERS-007', '--list', '--config=playwright.non-album-rescan.config.js'],
      ['test', alias, 'FTC-COVERS-007', '--list', '--config=playwright.config.js'],
      ['test', alias, 'FTC-COVERS-007', '--config=playwright.config.js'],
    ], alias);
  }
});

test('short inverted grep alias is treated as a focused selection', () => {
  const calls = [];
  const result = _private.runFunctionalSuites(['test', '-G', 'FTC-COVERS-007'], {
    spawnSyncFn(_command, args) {
      calls.push(args.slice(1));
      return { status: 1, signal: null, stdout: '', stderr: 'Error: No tests found.\n' };
    },
  });

  assert.deepEqual(result, { exitCode: 1, signal: null });
  assert.equal(calls.length, 4);
  assert.ok(calls.every((args) => args.includes('--list')));
});

test('a child signal stops immediately and is returned for propagation', () => {
  let callCount = 0;
  const result = _private.runFunctionalSuites(['test'], {
    spawnSyncFn() {
      callCount += 1;
      return { status: null, signal: 'SIGINT', stdout: '', stderr: '' };
    },
  });

  assert.deepEqual(result, { exitCode: 1, signal: 'SIGINT' });
  assert.equal(callCount, 1, 'the second suite must not be launched after interruption');
});

test('unexpected focused discovery errors are surfaced and fail the run', () => {
  const stderrWrites = [];
  let callCount = 0;
  const result = _private.runFunctionalSuites(['test', '--grep', 'FTC-COVERS'], {
    stderr: { write(value) { stderrWrites.push(String(value)); } },
    spawnSyncFn() {
      callCount += 1;
      return callCount === 1
        ? { status: 2, signal: null, stdout: '', stderr: 'configuration exploded\n' }
        : { status: 1, signal: null, stdout: '', stderr: 'Error: No tests found.\n' };
    },
  });

  assert.deepEqual(result, { exitCode: 1, signal: null });
  assert.equal(callCount, 4);
  assert.deepEqual(stderrWrites, ['configuration exploded\n']);
});

test('main re-raises a child signal instead of flattening it to an exit code', () => {
  const calls = [];
  const processObject = {
    pid: 123,
    exitCode: undefined,
    kill(pid, signal) {
      calls.push({ pid, signal });
    },
  };

  _private.applyFunctionalSuiteResult({ exitCode: 1, signal: 'SIGTERM' }, processObject);

  assert.deepEqual(calls, [{ pid: 123, signal: 'SIGTERM' }]);
  assert.equal(processObject.exitCode, undefined);
});
