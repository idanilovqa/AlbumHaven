const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { _private } = require('../../scripts/run-playwright.cjs');
const TEST_RESULT_NONCE = 'unit-test-result-nonce';
const PASS_FINAL_RESULT = `[album-haven-playwright-result] {"version":1,"phase":"run-final","nonce":"${TEST_RESULT_NONCE}","status":"passed","total":1,"completed":1,"failed":0,"skipped":0,"errors":0}`;
const RUNNER_ENTRYPOINT = path.resolve(__dirname, '..', '..', 'scripts', 'run-playwright.cjs');
const BROWSERLESS_RUNNER_SELF_PROBE_CHILD_BUDGET_MS = 20_000;
const TEST_PROCESS_CREATION_IDENTITY = 'test-process-creation-identity';
const runPlaywrightProcessWithGeneratedNonce = _private.runPlaywrightProcess;
_private.runPlaywrightProcess = (passthroughArgv, childEnv, runTimeoutMs, options = {}) => (
  runPlaywrightProcessWithGeneratedNonce(passthroughArgv, childEnv, runTimeoutMs, {
    ...options,
    resultNonce: TEST_RESULT_NONCE,
    processObject: options.processObject || { exitCode: null },
  })
);

function createFakeChildProcess(pid = 4242, { autoCloseOnExit = true } = {}) {
  const child = new EventEmitter();
  const emit = child.emit.bind(child);
  child.emit = (eventName, ...args) => {
    const emitted = emit(eventName, ...args);
    if (eventName === 'exit' && autoCloseOnExit) {
      emit('close', ...args);
    }
    return emitted;
  };
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

function createTimerHarness() {
  const timers = [];
  return {
    timers,
    setTimeoutFn(fn, delay) {
      const handle = {
        fn,
        delay,
        cleared: false,
      };
      timers.push(handle);
      return handle;
    },
    clearTimeoutFn(handle) {
      if (handle) {
        handle.cleared = true;
      }
    },
  };
}

function parseFinalResultPayloads(output) {
  return String(output || '')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('[album-haven-playwright-result] '))
    .map((line) => JSON.parse(line.slice(line.indexOf('{'))));
}

async function runBrowserlessRunnerEntrypointProbe({
  outcome,
  noTests = false,
  listOnly = false,
  specSource = '',
  env = {},
}) {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const tempRoot = fs.mkdtempSync(path.join(repoRoot, 'tests', '.runner-entrypoint-probe-'));
  const configPath = path.join(tempRoot, 'playwright.config.cjs');
  const specPath = path.join(tempRoot, 'probe.spec.cjs');
  const outputPath = path.join(tempRoot, 'playwright-output');
  const reporterPath = path.join(repoRoot, 'scripts', 'playwright-final-result-reporter.cjs');
  const playwrightTestPath = path.join(repoRoot, 'node_modules', '@playwright', 'test');
  fs.writeFileSync(specPath, specSource || `
    const { test, expect } = require(${JSON.stringify(playwrightTestPath)});
    test('browserless process-boundary probe', () => {
      expect('actual').toBe(${JSON.stringify(outcome)});
    });
  `, 'utf8');
  fs.writeFileSync(configPath, `
    module.exports = {
      testDir: ${JSON.stringify(tempRoot)},
      testMatch: ${JSON.stringify(noTests ? 'missing.spec.cjs' : 'probe.spec.cjs')},
      outputDir: ${JSON.stringify(outputPath)},
      workers: 1,
      retries: 0,
      reporter: [['list'], [${JSON.stringify(reporterPath)}]],
    };
  `, 'utf8');
  try {
    const child = spawn(process.execPath, [
      RUNNER_ENTRYPOINT,
      'test',
      '--config',
      configPath,
      ...(listOnly ? ['--list'] : []),
      `--run-timeout-ms=${BROWSERLESS_RUNNER_SELF_PROBE_CHILD_BUDGET_MS}`,
    ], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
      windowsHide: true,
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let processError = null;
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      processError = error;
    });
    return await new Promise((resolve) => {
      child.once('close', (status, signal) => {
        resolve({
          pid: child.pid,
          status,
          signal,
          stdout,
          stderr,
          error: processError,
        });
      });
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function runFailureLatchProcessBoundaryProbe({ launcher, mode }) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-runner-latch-probe-'));
  const probePath = path.join(tempRoot, 'probe.cjs');
  fs.writeFileSync(probePath, `
    const { EventEmitter } = require('node:events');
    const { _private } = require(${JSON.stringify(RUNNER_ENTRYPOINT)});
    const mode = process.argv[2];
    const nonce = 'runner-latch-process-boundary';
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    let cleanupCalls = 0;
    const options = {
      resultNonce: nonce,
      spawnFn() { return child; },
      stopProcessTreeFn() {},
      reclaimPortFn() { return []; },
      waitForReclaimedProcessesExitedFn: async () => {},
      readProcessTreeIdentitiesFn() { return []; },
      cleanupIsolatedLibraryDatabaseFn() { cleanupCalls += 1; },
      stdout: { write() {} },
    };
    if (mode === 'natural-escape' || mode.startsWith('performance-')) {
      options.setTimeoutFn = () => ({ inactive: true });
      options.clearTimeoutFn = () => {};
    }
    const childEnv = mode.startsWith('performance-')
      ? { PLAYWRIGHT_PERF_VERIFICATION_GROUP_ID: 'latch-probe' }
      : {};
    const runPromise = _private.runPlaywrightProcess(
      ['test', 'tests/e2e/specs/processBoundaryProbe.spec.js'],
      childEnv,
      10000,
      options,
    );
    const failedMarkers = '[album-haven-playwright-result] '
      + JSON.stringify({
        version: 1,
        phase: 'tests-complete',
        nonce,
        status: 'failed',
        total: 1,
        completed: 1,
        failed: 1,
        skipped: 0,
        errors: 0,
      })
      + '\\n[album-haven-playwright-result] '
      + JSON.stringify({
        version: 1,
        phase: 'run-final',
        nonce,
        status: 'failed',
        total: 1,
        completed: 1,
        failed: 1,
        skipped: 0,
        errors: 0,
      })
      + '\\n';
    const runErrorMarker = '[album-haven-playwright-result] '
      + JSON.stringify({
        version: 1,
        phase: 'run-error',
        nonce,
        status: 'failed',
        total: 1,
        completed: 0,
        failed: 0,
        skipped: 0,
        errors: 1,
      })
      + '\\n';
    const performanceFinalMarker = failedMarkers.slice(failedMarkers.indexOf(
      '[album-haven-playwright-result] ',
      '[album-haven-playwright-result] '.length,
    ));
    child.stdout.emit('data', Buffer.from(
      mode === 'natural-escape'
        ? runErrorMarker
        : (mode.startsWith('performance-') ? performanceFinalMarker : failedMarkers),
    ));
    if (mode === 'natural-escape' || mode === 'performance-no-flush') {
      void runPromise;
    } else if (mode === 'performance-delayed-flush') {
      setTimeout(() => {
        child.stdout.emit('data', Buffer.from('[playwright-performance-reporter] flush-complete\\n'));
        process.stderr.write('[probe-performance-flush-delayed]\\n');
      }, 10);
      void runPromise;
    } else {
      setTimeout(() => child.stderr.emit('data', Buffer.from('[WebServer] delayed close log\\n')), 10);
      setTimeout(() => {
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      }, 20);
      runPromise.then((result) => {
        process.stdout.write(JSON.stringify({
          cleanupCalls,
          wrapperExitCode: result.exitCode,
          cleanupStatus: result.lifecycle.fakeDatabaseCleanup.status,
        }) + '\\n');
        const exitCode = _private.finalizeMainResult(result);
        process.exit(exitCode);
      });
    }
  `, 'utf8');
  try {
    if (launcher === 'node.cmd') {
      const nodeCommandShim = path.join(tempRoot, 'node boundary & owned.cmd');
      fs.writeFileSync(nodeCommandShim, [
        '@echo off',
        '"%ALBUM_HAVEN_NODE_EXECUTABLE%" %*',
        'exit /b %errorlevel%',
        '',
      ].join('\r\n'), 'utf8');
      const commandLine = `call "${nodeCommandShim}" "${probePath}" "${mode}"`;
      return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', commandLine], {
        cwd: path.resolve(__dirname, '..', '..'),
        env: {
          ...process.env,
          ALBUM_HAVEN_NODE_EXECUTABLE: process.execPath,
        },
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
        windowsVerbatimArguments: true,
      });
    }
    return spawnSync(process.execPath, [probePath, mode], {
      cwd: path.resolve(__dirname, '..', '..'),
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function waitForChildEvent(child, eventName, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for child ${eventName}.`));
    }, timeoutMs);
    const onEvent = (...args) => {
      cleanup();
      resolve(args);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off(eventName, onEvent);
      child.off('error', onError);
    };

    child.once(eventName, onEvent);
    child.once('error', onError);
  });
}

test('stopProcessTree accepts taskkill status 0 without invoking the fallback', () => {
  const fallbackCalls = [];

  _private.stopProcessTree(1234, {
    runCommandFn() {
      return { status: 0, stdout: 'SUCCESS', stderr: '' };
    },
    processKillFn(...args) {
      fallbackCalls.push(args);
    },
  });

  assert.deepEqual(fallbackCalls, []);
});

test('stopProcessTree invokes SIGKILL fallback when taskkill exits 1 with access denied', () => {
  const fallbackCalls = [];

  _private.stopProcessTree(2345, {
    runCommandFn() {
      return { status: 1, stdout: '', stderr: 'ERROR: Access is denied.' };
    },
    processKillFn(...args) {
      fallbackCalls.push(args);
    },
    readProcessTreeIdentitiesFn() {
      return [{ pid: 2345, creationIdentity: 'root-identity', depth: 0 }];
    },
    readProcessCreationIdentityFn() {
      return 'root-identity';
    },
  });

  assert.deepEqual(fallbackCalls, [[2345, 'SIGKILL']]);
});

test('stopProcessTree bounds taskkill and uses the identity-safe fallback after command timeout', () => {
  const fallbackCalls = [];
  let taskkillOptions = null;
  const timeoutError = new Error('taskkill timed out');
  timeoutError.code = 'ETIMEDOUT';

  _private.stopProcessTree(2345, {
    expectedCreationIdentity: 'root-identity',
    runCommandFn(_command, _args, options) {
      taskkillOptions = options;
      return { status: null, stdout: '', stderr: '', error: timeoutError };
    },
    processKillFn(...args) {
      fallbackCalls.push(args);
    },
    readProcessTreeIdentitiesFn() {
      return [{ pid: 2345, creationIdentity: 'root-identity', depth: 0 }];
    },
    readProcessCreationIdentityFn() {
      return 'root-identity';
    },
  });

  assert.equal(taskkillOptions.timeout, 15000);
  assert.deepEqual(fallbackCalls, [[2345, 'SIGKILL']]);
});

test('stopProcessTree accepts ESRCH from the SIGKILL fallback', () => {
  const missingProcessError = new Error('No such process');
  missingProcessError.code = 'ESRCH';

  assert.doesNotThrow(() => {
    _private.stopProcessTree(3456, {
      runCommandFn() {
        return { status: 1, stdout: '', stderr: 'ERROR: Access is denied.' };
      },
      processKillFn() {
        throw missingProcessError;
      },
      readProcessTreeIdentitiesFn() {
        return [{ pid: 3456, creationIdentity: 'root-identity', depth: 0 }];
      },
      readProcessCreationIdentityFn() {
        return 'root-identity';
      },
    });
  });
});

test('stopProcessTree fallback terminates identity-matched descendants before their parent', () => {
  const fallbackCalls = [];

  _private.stopProcessTree(2345, {
    runCommandFn() {
      return { status: 1, stdout: '', stderr: 'ERROR: Access is denied.' };
    },
    readProcessTreeIdentitiesFn() {
      return [
        { pid: 2345, creationIdentity: 'root', depth: 0 },
        { pid: 3456, creationIdentity: 'child', depth: 1 },
        { pid: 4567, creationIdentity: 'grandchild', depth: 2 },
      ];
    },
    readProcessCreationIdentityFn(pid) {
      return new Map([
        [2345, 'root'],
        [3456, 'child'],
        [4567, 'grandchild'],
      ]).get(pid);
    },
    processKillFn(...args) {
      fallbackCalls.push(args);
    },
  });

  assert.deepEqual(fallbackCalls, [
    [4567, 'SIGKILL'],
    [3456, 'SIGKILL'],
    [2345, 'SIGKILL'],
  ]);
});

test('stopProcessTree fallback skips descendants whose PID identity changed after discovery', () => {
  const fallbackCalls = [];

  _private.stopProcessTree(2345, {
    runCommandFn() {
      return { status: 1, stdout: '', stderr: 'ERROR: Access is denied.' };
    },
    readProcessTreeIdentitiesFn() {
      return [
        { pid: 2345, creationIdentity: 'root', depth: 0 },
        { pid: 3456, creationIdentity: 'original-child', depth: 1 },
      ];
    },
    readProcessCreationIdentityFn(pid) {
      return pid === 2345 ? 'root' : 'reused-child';
    },
    processKillFn(...args) {
      fallbackCalls.push(args);
    },
  });

  assert.deepEqual(fallbackCalls, [[2345, 'SIGKILL']]);
});

test('stopProcessTree skips fallback when the expected PID identity changes after taskkill fails', () => {
  const identities = ['expected-root', 'expected-root', 'reused-root'];
  let discoveryCalls = 0;
  let fallbackCalls = 0;

  _private.stopProcessTree(2345, {
    expectedCreationIdentity: 'expected-root',
    readProcessCreationIdentityFn() {
      return identities.shift();
    },
    runCommandFn() {
      return { status: 1, stdout: '', stderr: 'ERROR: Access is denied.' };
    },
    readProcessTreeIdentitiesFn() {
      discoveryCalls += 1;
      return [{ pid: 2345, creationIdentity: 'expected-root', depth: 0 }];
    },
    processKillFn() {
      fallbackCalls += 1;
    },
  });

  assert.equal(discoveryCalls, 1);
  assert.equal(fallbackCalls, 0);
});

test('stopProcessTree uses the pre-taskkill snapshot to terminate a surviving descendant', () => {
  const fallbackCalls = [];
  let rootIdentityReads = 0;

  _private.stopProcessTree(2345, {
    expectedCreationIdentity: 'expected-root',
    readProcessCreationIdentityFn(pid) {
      if (pid === 3456) {
        return 'expected-child';
      }
      if (pid === 4567) {
        return 'reused-child';
      }
      rootIdentityReads += 1;
      return rootIdentityReads <= 2 ? 'expected-root' : null;
    },
    readProcessTreeIdentitiesFn() {
      return [
        { pid: 2345, creationIdentity: 'expected-root', depth: 0 },
        { pid: 3456, creationIdentity: 'expected-child', depth: 1 },
        { pid: 4567, creationIdentity: 'original-child', depth: 1 },
      ];
    },
    runCommandFn() {
      return {
        status: 1,
        stdout: 'SUCCESS: The process with PID 2345 was terminated.',
        stderr: 'ERROR: The process with PID 3456 could not be terminated.',
      };
    },
    processKillFn(...args) {
      fallbackCalls.push(args);
    },
  });

  assert.deepEqual(fallbackCalls, [[3456, 'SIGKILL']]);
});

test('stopProcessTree reports taskkill and SIGKILL diagnostics when both attempts fail', () => {
  const fallbackError = new Error('fallback operation not permitted');
  fallbackError.code = 'EPERM';

  assert.throws(
    () => {
      _private.stopProcessTree(4567, {
        runCommandFn() {
          return { status: 1, stdout: '', stderr: 'ERROR: Access is denied.' };
        },
        processKillFn() {
          throw fallbackError;
        },
        readProcessTreeIdentitiesFn() {
          return [{ pid: 4567, creationIdentity: 'root-identity', depth: 0 }];
        },
        readProcessCreationIdentityFn() {
          return 'root-identity';
        },
      });
    },
    (error) => {
      assert.match(error.message, /taskkill.*Access is denied/is);
      assert.match(error.message, /fallback errors=.*fallback operation not permitted/is);
      return true;
    },
  );
});

test('stopProcessTree SIGKILL fallback ends a disposable Windows child before cleanup continues', {
  skip: process.platform !== 'win32',
  timeout: 10000,
}, async () => {
  const lifecycle = [];
  const child = spawn(
    process.execPath,
    ['-e', "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );

  try {
    await waitForChildEvent(child.stdout, 'data');
    child.once('exit', () => {
      lifecycle.push('child.exit');
    });
    const creationIdentity = 'disposable-child-identity';
    const exitPromise = waitForChildEvent(child, 'exit');

    _private.stopProcessTree(child.pid, {
      runCommandFn() {
        return { status: 1, stdout: '', stderr: 'ERROR: Access is denied.' };
      },
      readProcessTreeIdentitiesFn() {
        return [{ pid: child.pid, creationIdentity, depth: 0 }];
      },
      readProcessCreationIdentityFn() {
        return creationIdentity;
      },
    });

    const [exitCode, signal] = await exitPromise;
    assert.ok(exitCode !== null || signal !== null, 'expected the fallback to terminate the child');
    assert.equal(child.exitCode !== null || child.signalCode !== null, true);
    lifecycle.push('cleanup.continue');
    assert.deepEqual(lifecycle, ['child.exit', 'cleanup.continue']);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForChildEvent(child, 'exit').catch(() => {});
    }
  }
});

test('waitForReclaimedProcessesExited waits for the same PID and creation identity to disappear', async () => {
  const identities = ['638880000000000000', '638880000000000000', null];
  const sleeps = [];

  await _private.waitForReclaimedProcessesExited(
    [{ pid: 2468, creationIdentity: '638880000000000000' }],
    {
      timeoutMs: 1000,
      pollIntervalMs: 10,
      readProcessCreationIdentityFn() {
        return identities.shift();
      },
      async sleepFn(delayMs) {
        sleeps.push(delayMs);
      },
    },
  );

  assert.deepEqual(sleeps, [10, 10]);
});

test('waitForReclaimedProcessesExited treats PID reuse with a new creation identity as exited', async () => {
  let sleepCalls = 0;

  await _private.waitForReclaimedProcessesExited(
    [{ pid: 2468, creationIdentity: '638880000000000000' }],
    {
      readProcessCreationIdentityFn() {
        return '638880000000000001';
      },
      async sleepFn() {
        sleepCalls += 1;
      },
    },
  );

  assert.equal(sleepCalls, 0);
});

test('waitForReclaimedProcessesExited propagates a bounded timeout for an unchanged owner identity', async () => {
  let now = 0;

  await assert.rejects(
    _private.waitForReclaimedProcessesExited(
      [{ pid: 2468, creationIdentity: '638880000000000000' }],
      {
        timeoutMs: 20,
        pollIntervalMs: 10,
        readProcessCreationIdentityFn() {
          return '638880000000000000';
        },
        async sleepFn(delayMs) {
          now += delayMs;
        },
        nowFn() {
          return now;
        },
      },
    ),
    /Timed out after 20 ms.*pid=2468.*creationIdentity=638880000000000000/,
  );
});

test('reclaimPort snapshots creation identities before terminating each owner', () => {
  const events = [];
  const owners = [
    { pid: 2468, creationIdentity: '638880000000000000' },
    { pid: 1357, creationIdentity: '638880000000000001' },
  ];

  const reclaimed = _private.reclaimPort(4173, {
    readPortOwningProcessIdentitiesFn(port) {
      events.push(`snapshot:${port}`);
      return owners;
    },
    readProcessCreationIdentityFn(pid) {
      events.push(`identity:${pid}`);
      return owners.find((owner) => owner.pid === pid).creationIdentity;
    },
    stopProcessTreeFn(pid, options) {
      events.push(`stop:${pid}:${options.expectedCreationIdentity}`);
    },
  });

  assert.deepEqual(reclaimed, owners);
  assert.deepEqual(events, [
    'snapshot:4173',
    'identity:2468',
    'stop:2468:638880000000000000',
    'identity:1357',
    'stop:1357:638880000000000001',
  ]);
});

test('reclaimPort internal identity guard skips taskkill when the PID is reused after caller precheck', () => {
  const identities = ['expected-owner', 'reused-owner'];
  let taskkillCalls = 0;

  const reclaimed = _private.reclaimPort(4173, {
    readPortOwningProcessIdentitiesFn() {
      return [{ pid: 2468, creationIdentity: 'expected-owner' }];
    },
    readProcessCreationIdentityFn() {
      return identities.shift();
    },
    stopProcessTreeFn(pid, options) {
      _private.stopProcessTree(pid, {
        ...options,
        readProcessCreationIdentityFn() {
          return identities.shift();
        },
        runCommandFn() {
          taskkillCalls += 1;
          return { status: 0, stdout: 'SUCCESS', stderr: '' };
        },
      });
    },
  });

  assert.deepEqual(reclaimed, [{ pid: 2468, creationIdentity: 'expected-owner' }]);
  assert.equal(taskkillCalls, 0);
});

test('reclaimPort skips absent and reused owners immediately before tree termination', () => {
  const stopCalls = [];
  const owners = [
    { pid: 2468, creationIdentity: 'original-owner' },
    { pid: 1357, creationIdentity: 'exited-owner' },
    { pid: 9753, creationIdentity: 'stable-owner' },
  ];

  const reclaimed = _private.reclaimPort(4173, {
    readPortOwningProcessIdentitiesFn() {
      return owners;
    },
    readProcessCreationIdentityFn(pid) {
      return new Map([
        [2468, 'reused-owner'],
        [1357, null],
        [9753, 'stable-owner'],
      ]).get(pid);
    },
    stopProcessTreeFn(pid) {
      stopCalls.push(pid);
    },
  });

  assert.deepEqual(reclaimed, [{ pid: 9753, creationIdentity: 'stable-owner' }]);
  assert.deepEqual(stopCalls, [9753]);
});

test('readPortOwningProcesses reports only unique positive listening owner PIDs', () => {
  const commands = [];
  const owners = _private.readPortOwningProcesses(4173, {
    runCommandFn(command, args) {
      commands.push({ command, args });
      return {
        status: 0,
        stdout: '111\n222\n111\n0\n',
        stderr: '',
      };
    },
  });

  assert.deepEqual(owners, [111, 222]);
  assert.equal(commands.length, 1);
  assert.match(commands[0].args[1], /Get-NetTCPConnection -LocalPort 4173 -State Listen/);
  assert.match(commands[0].args[1], /Select-Object -ExpandProperty OwningProcess -Unique/);
  assert.match(commands[0].args[1], /Where-Object \{ \[int\]\$_ -gt 0 \}/);
});

test('readPortOwningProcessIdentities parses Windows owner creation identities', () => {
  const commands = [];
  const owners = _private.readPortOwningProcessIdentities(4173, {
    runCommandFn(command, args) {
      commands.push({ command, args });
      return {
        status: 0,
        stdout: '[{"pid":2468,"creationIdentity":"638880000000000000"}]',
        stderr: '',
      };
    },
  });

  assert.deepEqual(owners, [{ pid: 2468, creationIdentity: '638880000000000000' }]);
  assert.match(commands[0].args[1], /Get-NetTCPConnection -LocalPort 4173 -State Listen/);
  assert.match(commands[0].args[1], /Where-Object \{ \[int\]\$_ -gt 0 \}/);
  assert.match(commands[0].args[1], /\$ownerStartTime\.ToUniversalTime\(\)\.Ticks/);
});

test('readPortOwningProcessIdentities excludes PID zero TIME_WAIT rows before process lookup', () => {
  let powershellCommand = '';
  const owners = _private.readPortOwningProcessIdentities(4173, {
    runCommandFn(_command, args) {
      powershellCommand = args[1];
      return { status: 0, stdout: '[]', stderr: '' };
    },
  });

  assert.deepEqual(owners, []);
  assert.ok(
    powershellCommand.indexOf('Where-Object { [int]$_ -gt 0 }')
      < powershellCommand.indexOf('Get-Process -Id $ownerPid'),
    'PID zero must be filtered before any process identity lookup',
  );
  assert.match(powershellCommand, /-State Listen/);
});

test('readPortOwningProcessIdentities skips an owner that exits during identity capture', () => {
  const owners = _private.readPortOwningProcessIdentities(4173, {
    runCommandFn() {
      return { status: 0, stdout: '[]', stderr: '' };
    },
  });

  assert.deepEqual(owners, []);
});

test('readPortOwningProcessIdentities fails when a live owner has no creation identity', () => {
  assert.throws(
    () => _private.readPortOwningProcessIdentities(4173, {
      runCommandFn() {
        return {
          status: 1,
          stdout: '',
          stderr: 'Process 2468 has no creation identity.',
        };
      },
    }),
    /Failed to snapshot owners of port 4173.*no creation identity/,
  );
});

test('waitForReclaimedProcessesExited observes a disposable Windows process identity after termination', {
  skip: process.platform !== 'win32',
  timeout: 20000,
}, async () => {
  const child = spawn(
    process.execPath,
    ['-e', "process.stdout.write('ready\\n'); setInterval(()=>{},1000);"],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );

  try {
    await waitForChildEvent(child.stdout, 'data');
    const creationIdentity = _private.readProcessCreationIdentity(child.pid);
    assert.match(creationIdentity, /^\d+$/);
    const exitPromise = waitForChildEvent(child, 'exit');
    child.kill('SIGKILL');
    await _private.waitForReclaimedProcessesExited([{
      pid: child.pid,
      creationIdentity,
    }], {
      timeoutMs: 5000,
      pollIntervalMs: 50,
    });
    await exitPromise;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForChildEvent(child, 'exit').catch(() => {});
    }
  }
});

test('cleanupIsolatedE2ETempRoots removes only explicitly owned isolated Playwright temp workspaces', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'run-playwright-isolated-e2e-cleanup-'));
  const isolatedOne = path.join(tempRoot, `${_private.ISOLATED_E2E_TEMP_PREFIX}one`);
  const isolatedTwo = path.join(tempRoot, `${_private.ISOLATED_E2E_TEMP_PREFIX}two`);
  const keepDir = path.join(tempRoot, 'keep-me');
  fs.mkdirSync(isolatedOne, { recursive: true });
  fs.mkdirSync(isolatedTwo, { recursive: true });
  fs.mkdirSync(keepDir, { recursive: true });
  fs.writeFileSync(path.join(isolatedOne, 'sample.txt'), 'temp');
  fs.writeFileSync(path.join(isolatedTwo, 'sample.txt'), 'temp');

  const removed = _private.cleanupIsolatedE2ETempRoots(tempRoot, [isolatedOne]);

  assert.deepEqual(
    removed.sort(),
    [isolatedOne],
  );
  assert.ok(!fs.existsSync(isolatedOne));
  assert.ok(fs.existsSync(isolatedTwo));
  assert.ok(fs.existsSync(keepDir));
});

test('cleanupIsolatedE2ETempRoots retries Windows removal and propagates explicit root failures', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'run-playwright-isolated-e2e-remove-failure-'));
  const ownedRoot = path.join(tempRoot, `${_private.ISOLATED_E2E_TEMP_PREFIX}owned`);
  const removalFailure = Object.assign(new Error('root is still busy'), { code: 'EBUSY' });
  fs.mkdirSync(ownedRoot);

  try {
    assert.throws(
      () => _private.cleanupIsolatedE2ETempRoots(tempRoot, [ownedRoot], {
        rmSyncFn(entryPath, options) {
          assert.equal(entryPath, ownedRoot);
          assert.deepEqual(options, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 100,
          });
          throw removalFailure;
        },
      }),
      (error) => error === removalFailure,
    );
    assert.equal(fs.existsSync(ownedRoot), true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('cleanupIsolatedE2ETempRoots rejects false success when an explicit root remains', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'run-playwright-isolated-e2e-remove-remains-'));
  const ownedRoot = path.join(tempRoot, `${_private.ISOLATED_E2E_TEMP_PREFIX}owned`);
  fs.mkdirSync(ownedRoot);

  try {
    assert.throws(
      () => _private.cleanupIsolatedE2ETempRoots(tempRoot, [ownedRoot], {
        rmSyncFn() {
          // Simulate a false-success filesystem removal that leaves the directory behind.
        },
      }),
      /Runner-owned isolated Playwright temp root still exists after cleanup/,
    );
    assert.equal(fs.existsSync(ownedRoot), true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('cleanupIsolatedE2ETempRoots leaves another runner isolated workspace untouched', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'run-playwright-isolated-e2e-owner-'));
  const otherRunnerRoot = path.join(tempRoot, `${_private.ISOLATED_E2E_TEMP_PREFIX}other-runner`);
  fs.mkdirSync(otherRunnerRoot, { recursive: true });

  const removed = _private.cleanupIsolatedE2ETempRoots(tempRoot);

  assert.deepEqual(removed, []);
  assert.ok(fs.existsSync(otherRunnerRoot));
});

test('cleanupIsolatedE2ETempRoots reclaims only dead-owner leased orphans and preserves live concurrent roots', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'run-playwright-isolated-e2e-leases-'));
  const deadRoot = path.join(tempRoot, `${_private.ISOLATED_E2E_TEMP_PREFIX}dead`);
  const liveRoot = path.join(tempRoot, `${_private.ISOLATED_E2E_TEMP_PREFIX}live`);
  fs.mkdirSync(deadRoot);
  fs.mkdirSync(liveRoot);
  _private.writeIsolatedE2ETempRootLease(deadRoot, { pid: 11, creationIdentity: 'dead-owner' });
  _private.writeIsolatedE2ETempRootLease(liveRoot, { pid: 22, creationIdentity: 'live-owner' });

  const removed = _private.cleanupIsolatedE2ETempRoots(tempRoot, [], {
    reclaimOrphans: true,
    readProcessCreationIdentityFn(pid) {
      return pid === 22 ? 'live-owner' : null;
    },
  });

  assert.deepEqual(removed, [deadRoot]);
  assert.equal(fs.existsSync(deadRoot), false);
  assert.equal(fs.existsSync(liveRoot), true);
});

test('cleanupIsolatedE2ETempRoots keeps orphan removal failures best-effort', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'run-playwright-isolated-e2e-orphan-failure-'));
  const deadRoot = path.join(tempRoot, `${_private.ISOLATED_E2E_TEMP_PREFIX}dead`);
  fs.mkdirSync(deadRoot);
  _private.writeIsolatedE2ETempRootLease(deadRoot, { pid: 11, creationIdentity: 'dead-owner' });

  try {
    const removed = _private.cleanupIsolatedE2ETempRoots(tempRoot, [], {
      reclaimOrphans: true,
      readProcessCreationIdentityFn() {
        return null;
      },
      rmSyncFn() {
        throw Object.assign(new Error('orphan is still busy'), { code: 'EBUSY' });
      },
    });

    assert.deepEqual(removed, []);
    assert.equal(fs.existsSync(deadRoot), true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('createOwnedIsolatedE2ETempRoot removes its directory when lease creation fails', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'run-playwright-lease-failure-'));
  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = (filePath, ...args) => {
    if (path.basename(String(filePath)) === _private.ISOLATED_E2E_TEMP_LEASE) {
      throw new Error('lease write failed');
    }
    return originalWriteFileSync(filePath, ...args);
  };
  try {
    assert.throws(
      () => _private.createOwnedIsolatedE2ETempRoot({
        tempRoot,
        readProcessCreationIdentityFn: () => TEST_PROCESS_CREATION_IDENTITY,
      }),
      /lease write failed/,
    );
    assert.deepEqual(fs.readdirSync(tempRoot), []);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('retry-shaped managed attempts use fresh leased roots and clean each attempt root', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'run-playwright-retry-roots-'));
  const observedRoots = [];
  const runAttempt = async () => {
    const ownedRoot = _private.createOwnedIsolatedE2ETempRoot({
      tempRoot,
      readProcessCreationIdentityFn: () => TEST_PROCESS_CREATION_IDENTITY,
    });
    const childEnv = { ALBUM_HAVEN_E2E_TEMP_ROOT: ownedRoot };
    const result = await _private.runManagedPlaywrightAttempt({
      passthroughArgv: ['test'],
      childEnv,
      runTimeoutMs: 1000,
      managesScanApp: false,
      servesRealApp: false,
      supportAppPort: 4173,
      realAppPort: 5001,
      managedPorts: [],
      ownedIsolatedTempRoot: ownedRoot,
      isHeadless: true,
      browserName: 'chromium',
      async runPlaywrightProcessFn(_argv, activeEnv) {
        observedRoots.push(activeEnv.ALBUM_HAVEN_E2E_TEMP_ROOT);
        return { exitCode: 1, combinedOutput: 'port conflict' };
      },
      cleanupIsolatedE2ETempRootsFn(_ignoredTempRoot, ownedRoots) {
        return _private.cleanupIsolatedE2ETempRoots(tempRoot, ownedRoots);
      },
    });
    assert.equal(result.lifecycle.managedAttempt.tempCleanup.status, 'completed');
    assert.equal(fs.existsSync(ownedRoot), false);
  };

  try {
    await runAttempt();
    await runAttempt();
    assert.equal(observedRoots.length, 2);
    assert.notEqual(observedRoots[0], observedRoots[1]);
    assert.deepEqual(fs.readdirSync(tempRoot), []);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('managed performance attempt preserves and finally removes its runner-owned temp root', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'run-playwright-performance-owned-root-'));
  const ownedRoot = _private.createOwnedIsolatedE2ETempRoot({
    tempRoot,
    readProcessCreationIdentityFn: () => TEST_PROCESS_CREATION_IDENTITY,
  });
  const child = createFakeChildProcess(4250);
  const childEnv = { ALBUM_HAVEN_E2E_TEMP_ROOT: ownedRoot };
  const cleanupRoots = [];

  try {
    const result = await _private.runManagedPlaywrightAttempt({
      passthroughArgv: ['test', '-c', 'playwright.performance.config.cjs'],
      childEnv,
      runTimeoutMs: 1000,
      managesScanApp: false,
      managesIsolatedApp: true,
      servesRealApp: false,
      supportAppPort: 4173,
      realAppPort: 5001,
      isolatedAppPort: 4173,
      isolatedProviderPort: 4175,
      managedPorts: [4173, 4175],
      ownedIsolatedTempRoot: ownedRoot,
      isHeadless: true,
      browserName: 'chromium',
      async startManagedIsolatedAppFn(activeEnv) {
        assert.equal(activeEnv.ALBUM_HAVEN_E2E_TEMP_ROOT, ownedRoot);
        assert.equal(activeEnv.ALBUM_HAVEN_E2E_PRESERVE_ON_SHUTDOWN, '1');
        return child;
      },
      async stopManagedIsolatedAppFn() {
        assert.equal(fs.existsSync(ownedRoot), true);
      },
      createManagedIsolatedAppRestartControllerFn() {
        return {
          async close() {},
          getFailure() { return null; },
          getCurrentChild() { return child; },
        };
      },
      async runPlaywrightProcessFn(_argv, activeEnv) {
        assert.equal(activeEnv.ALBUM_HAVEN_E2E_TEMP_ROOT, ownedRoot);
        assert.equal(activeEnv.ALBUM_HAVEN_E2E_PRESERVE_ON_SHUTDOWN, '1');
        return { exitCode: 0, lifecycle: {} };
      },
      cleanupIsolatedLibraryDatabaseFn() {},
      cleanupIsolatedE2ETempRootsFn(_ignoredTempRoot, ownedRoots) {
        cleanupRoots.push([...ownedRoots]);
        return _private.cleanupIsolatedE2ETempRoots(tempRoot, ownedRoots);
      },
      reportManagedPortOwnersFn() { return []; },
    });

    assert.deepEqual(cleanupRoots, [[ownedRoot]]);
    assert.equal(result.lifecycle.managedAttempt.tempCleanup.status, 'completed');
    assert.equal(result.lifecycle.managedAttempt.tempCleanup.removedCount, 1);
    assert.equal(fs.existsSync(ownedRoot), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('managed scan readiness failure still tears down its runner-owned leased root', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'run-playwright-readiness-root-'));
  const ownedRoot = _private.createOwnedIsolatedE2ETempRoot({
    tempRoot,
    readProcessCreationIdentityFn: () => TEST_PROCESS_CREATION_IDENTITY,
  });
  let cleanupCalls = 0;
  try {
    await assert.rejects(
      _private.runManagedPlaywrightAttempt({
        passthroughArgv: ['test', '-c', 'playwright.scan-performance.config.cjs'],
        childEnv: { ALBUM_HAVEN_E2E_TEMP_ROOT: ownedRoot },
        runTimeoutMs: 1000,
        managesScanApp: true,
        servesRealApp: false,
        supportAppPort: 4173,
        realAppPort: 5001,
        managedPorts: [],
        ownedIsolatedTempRoot: ownedRoot,
        isHeadless: true,
        browserName: 'chromium',
        async startManagedScanAppFn() {
          throw new Error('managed scan readiness failed');
        },
        cleanupIsolatedE2ETempRootsFn(_ignoredTempRoot, ownedRoots) {
          cleanupCalls += 1;
          return _private.cleanupIsolatedE2ETempRoots(tempRoot, ownedRoots);
        },
      }),
      /managed scan readiness failed/,
    );
    assert.equal(cleanupCalls, 1);
    assert.equal(fs.existsSync(ownedRoot), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('managed attempt preserves a caller-owned temp path when no runner lease was allocated', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'run-playwright-caller-root-'));
  const callerRoot = path.join(tempRoot, 'caller-owned');
  fs.mkdirSync(callerRoot);
  fs.writeFileSync(path.join(callerRoot, 'sentinel.txt'), 'keep', 'utf8');
  try {
    await _private.runManagedPlaywrightAttempt({
      passthroughArgv: ['test', '--config=custom.config.cjs'],
      childEnv: { ALBUM_HAVEN_E2E_TEMP_ROOT: callerRoot },
      runTimeoutMs: 1000,
      managesScanApp: false,
      servesRealApp: false,
      supportAppPort: 4173,
      realAppPort: 5001,
      managedPorts: [],
      ownedIsolatedTempRoot: '',
      isHeadless: true,
      browserName: 'chromium',
      async runPlaywrightProcessFn(_argv, activeEnv) {
        assert.equal(activeEnv.ALBUM_HAVEN_E2E_TEMP_ROOT, callerRoot);
        return { exitCode: 0 };
      },
      cleanupIsolatedE2ETempRootsFn(_ignoredTempRoot, ownedRoots) {
        assert.deepEqual(ownedRoots, []);
        return _private.cleanupIsolatedE2ETempRoots(tempRoot, ownedRoots);
      },
    });
    assert.equal(fs.readFileSync(path.join(callerRoot, 'sentinel.txt'), 'utf8'), 'keep');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('cleanupIsolatedE2ETempRoots reclaims a real dead process lease only after preserving it while live', {
  skip: process.platform !== 'win32',
  timeout: 20000,
}, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'run-playwright-isolated-e2e-real-lease-'));
  const leasedRoot = path.join(tempRoot, `${_private.ISOLATED_E2E_TEMP_PREFIX}owned`);
  fs.mkdirSync(leasedRoot);
  const child = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n'); setInterval(()=>{},1000);"], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  try {
    await waitForChildEvent(child.stdout, 'data');
    const creationIdentity = _private.readProcessCreationIdentity(child.pid);
    _private.writeIsolatedE2ETempRootLease(leasedRoot, { pid: child.pid, creationIdentity });
    assert.deepEqual(_private.cleanupIsolatedE2ETempRoots(tempRoot, [], { reclaimOrphans: true }), []);
    assert.equal(fs.existsSync(leasedRoot), true);

    const exitPromise = waitForChildEvent(child, 'exit');
    child.kill('SIGKILL');
    await exitPromise;

    assert.deepEqual(
      _private.cleanupIsolatedE2ETempRoots(tempRoot, [], { reclaimOrphans: true }),
      [leasedRoot],
    );
    assert.equal(fs.existsSync(leasedRoot), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForChildEvent(child, 'exit').catch(() => {});
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('resolvePlaywrightSummaryExitCode infers success from the final passed summary line', () => {
  assert.equal(
    _private.resolvePlaywrightSummaryExitCode(`
Running 1 test using 1 worker

  ok 1 [idle-memory] › tests\\e2e\\performance\\idleMemory.spec.js:16:1 › sample test (9.0s)

  1 passed (9.2s)
`),
    0,
  );
});

test('resolvePlaywrightSummaryExitCode infers failure when a failed summary line is present', () => {
  assert.equal(
    _private.resolvePlaywrightSummaryExitCode(`
  1 failed
    [synthetic-large-library] › tests\\e2e\\localRealData\\allArtistsResponsiveness.spec.js:1:1 › sample test
`),
    1,
  );
});

test('resolvePlaywrightListReporterExitCode infers success once all announced tests emitted ok lines', () => {
  assert.equal(
    _private.resolvePlaywrightListReporterExitCode(`
Running 2 tests using 1 worker

  ok 1 [synthetic-large-library] › tests\\e2e\\localRealData\\allArtistsResponsiveness.spec.js:1:1 › first test (24.7s)
  ok 2 [synthetic-large-library] › tests\\e2e\\localRealData\\allArtistsResponsiveness.spec.js:2:1 › second test (8.9s)
`),
    0,
  );
});

test('resolvePlaywrightListReporterExitCode infers failure once all announced tests emitted final results', () => {
  assert.equal(
    _private.resolvePlaywrightListReporterExitCode(`
Running 2 tests using 1 worker

  ok 1 [synthetic-large-library] › tests\\e2e\\localRealData\\allArtistsResponsiveness.spec.js:1:1 › first test (24.7s)
  not ok 2 [synthetic-large-library] › tests\\e2e\\localRealData\\allArtistsResponsiveness.spec.js:2:1 › second test (8.9s)
`),
    1,
  );
});

test('resolvePlaywrightListReporterExitCode also treats Playwright x-lines as completed failures', () => {
  assert.equal(
    _private.resolvePlaywrightListReporterExitCode(`
Running 2 tests using 1 worker

  x  1 [synthetic-large-library] › tests\\e2e\\localRealData\\allArtistsResponsiveness.spec.js:1:1 › first test (24.7s)
  ok 2 [synthetic-large-library] › tests\\e2e\\localRealData\\allArtistsResponsiveness.spec.js:2:1 › second test (8.9s)
`),
    1,
  );
});

test('resolvePlaywrightCompletionExitCode waits for the structured result after list reporter completion', () => {
  assert.equal(
    _private.resolvePlaywrightCompletionExitCode(`
Running 2 tests using 1 worker

  ok 1 [synthetic-large-library] › tests\\e2e\\localRealData\\allArtistsResponsiveness.spec.js:1:1 › first test (24.7s)
  ok 2 [synthetic-large-library] › tests\\e2e\\localRealData\\allArtistsResponsiveness.spec.js:2:1 › second test (8.9s)
`),
    null,
  );
});

test('hasIncompletePlaywrightListRun detects announced runs that have not emitted all final result lines yet', () => {
  assert.equal(
    _private.hasIncompletePlaywrightListRun(`
Running 3 tests using 1 worker

  ok 1 [idle-memory] вЂє tests\\e2e\\specs\\coverLookup.spec.js:4:1 вЂє first test (37.2s)
  ok 2 [idle-memory] вЂє tests\\e2e\\specs\\coverLookup.spec.js:50:1 вЂє second test (1.2m)
`),
    true,
  );
  assert.equal(
    _private.hasIncompletePlaywrightListRun(`
Running 2 tests using 1 worker

  ok 1 [idle-memory] вЂє tests\\e2e\\specs\\coverLookup.spec.js:4:1 вЂє first test (37.2s)
  x  2 [idle-memory] вЂє tests\\e2e\\specs\\loops.functional.spec.js:5:1 вЂє third test (7.8s)
`),
    false,
  );
});

test('resolvePlaywrightCompletionExitCode waits when an intermediate passed summary appears before all announced tests finish', () => {
  assert.equal(
    _private.resolvePlaywrightCompletionExitCode(`
Running 3 tests using 1 worker

  ok 1 [idle-memory] вЂє tests\\e2e\\specs\\coverLookup.spec.js:4:1 вЂє FTC-COVERS-012 fake-album fast cover search appears in the drawer and can be canceled and cleared (37.2s)
  ok 2 [idle-memory] вЂє tests\\e2e\\specs\\coverLookup.spec.js:50:1 вЂє FTC-COVERS-013 fake full cover lookup opens from the drawer and shows the expected staged cover art (1.2m)

  2 passed (2.3m)
`),
    null,
  );
});

test('parsePlaywrightListResults groups final result lines into suite and test entries', () => {
  const parsed = _private.parsePlaywrightListResults(`
Running 3 tests using 1 worker

  ok 1 [synthetic-large-library] > tests/e2e/syntheticLargeLibrary/allArtistsResponsiveness.spec.js:1:1 > FTC-GALLERY-STARTUP-005A local real-build All Artists responsiveness > App open renders All Artists UI (24.7s)
  not ok 2 [synthetic-large-library] > tests/e2e/syntheticLargeLibrary/allArtistsResponsiveness.spec.js:2:1 > FTC-SEARCH-NAV-003A local real-build search responsiveness > Search updates the All Artists view (8.9s)
  x  3 [synthetic-large-library] > tests/e2e/syntheticLargeLibrary/utilitiesResponsiveness.spec.js:3:1 > FTC-UTIL-RULES-002 local real-build Rules responsiveness > Rules view stays responsive (7.1s)
`);

  assert.deepEqual(parsed, [
    {
      status: 'passed',
      projectName: 'synthetic-large-library',
      filePath: 'tests/e2e/syntheticLargeLibrary/allArtistsResponsiveness.spec.js',
      suiteName: 'FTC-GALLERY-STARTUP-005A local real-build All Artists responsiveness',
      testName: 'App open renders All Artists UI',
      fullName: 'FTC-GALLERY-STARTUP-005A local real-build All Artists responsiveness > App open renders All Artists UI',
    },
    {
      status: 'failed',
      projectName: 'synthetic-large-library',
      filePath: 'tests/e2e/syntheticLargeLibrary/allArtistsResponsiveness.spec.js',
      suiteName: 'FTC-SEARCH-NAV-003A local real-build search responsiveness',
      testName: 'Search updates the All Artists view',
      fullName: 'FTC-SEARCH-NAV-003A local real-build search responsiveness > Search updates the All Artists view',
    },
    {
      status: 'failed',
      projectName: 'synthetic-large-library',
      filePath: 'tests/e2e/syntheticLargeLibrary/utilitiesResponsiveness.spec.js',
      suiteName: 'FTC-UTIL-RULES-002 local real-build Rules responsiveness',
      testName: 'Rules view stays responsive',
      fullName: 'FTC-UTIL-RULES-002 local real-build Rules responsiveness > Rules view stays responsive',
    },
  ]);
});

test('parsePlaywrightListResults also handles Playwright list reporter checkmark lines with unicode arrows', () => {
  const parsed = _private.parsePlaywrightListResults(`
Running 1 test using 1 worker

  ✓  1 [synthetic-large-library] › tests/e2e/syntheticLargeLibrary/artistFamilyResponsiveness.spec.js:44:3 › FTC-SEARCH-NAV-005A local real-build artist family responsiveness › Neal Morse family search, filters, details, settings, and clear-search flows stay responsive on real data (23.5s)
`);

  assert.deepEqual(parsed, [
    {
      status: 'passed',
      projectName: 'synthetic-large-library',
      filePath: 'tests/e2e/syntheticLargeLibrary/artistFamilyResponsiveness.spec.js',
      suiteName: 'FTC-SEARCH-NAV-005A local real-build artist family responsiveness',
      testName: 'Neal Morse family search, filters, details, settings, and clear-search flows stay responsive on real data',
      fullName: 'FTC-SEARCH-NAV-005A local real-build artist family responsiveness > Neal Morse family search, filters, details, settings, and clear-search flows stay responsive on real data',
    },
  ]);
});

test('formatPlaywrightTerminalSummary prints grouped suites, overall totals, and failed tests', () => {
  const summary = _private.formatPlaywrightTerminalSummary([
    {
      status: 'passed',
      suiteName: 'Suite Alpha',
      testName: 'passes quickly',
      fullName: 'Suite Alpha > passes quickly',
    },
    {
      status: 'failed',
      suiteName: 'Suite Alpha',
      testName: 'fails loudly',
      fullName: 'Suite Alpha > fails loudly',
    },
    {
      status: 'passed',
      suiteName: 'Suite Beta',
      testName: 'still passes',
      fullName: 'Suite Beta > still passes',
    },
  ]);

  const plainSummary = _private.stripAnsi(summary);

  assert.match(plainSummary, /=== Playwright Summary ===/);
  assert.match(plainSummary, /\[x\] Suite Alpha/);
  assert.match(plainSummary, /\[✓\] passes quickly/);
  assert.match(plainSummary, /\[x\] fails loudly/);
  assert.match(plainSummary, /\[✓\] Suite Beta/);
  assert.match(plainSummary, /Overall: 2\/3 passed/);
  assert.match(plainSummary, /Failed tests:/);
  assert.match(plainSummary, /- Suite Alpha > fails loudly/);
  assert.match(summary, /\x1b\[31m\[/);
  assert.match(summary, /\x1b\[32m✓\x1b\[0m/);
});

test('resolvePlaywrightCompletionExitCode waits for the performance reporter flush marker before completing a passing verification run', () => {
  const output = `
Running 1 test using 1 worker

  ok 1 [idle-memory] › tests\\e2e\\performance\\idleMemory.spec.js:11:1 › sample test (9.8s)

  1 passed (10.1s)
${PASS_FINAL_RESULT}
`;

  assert.equal(
    _private.resolvePlaywrightCompletionExitCode(output, {
      childEnv: {
        PLAYWRIGHT_PERF_VERIFICATION_GROUP_ID: 'idle-memory-123',
      },
    }),
    null,
  );
  assert.equal(
    _private.resolvePlaywrightCompletionExitCode(`${output}\n[playwright-performance-reporter] flush-complete`, {
      childEnv: {
        PLAYWRIGHT_PERF_VERIFICATION_GROUP_ID: 'idle-memory-123',
      },
    }),
    0,
  );
});

test('resolvePlaywrightCompletionExitCode waits for the performance reporter flush marker before completing a failing verification run', () => {
  const output = `
Running 1 test using 1 worker

  x  1 [idle-memory] › tests\\e2e\\performance\\idleMemory.spec.js:11:1 › sample test (9.8s)
`;
  const finalizedOutput = `${output}\n[album-haven-playwright-result] {"version":1,"phase":"run-final","nonce":"${TEST_RESULT_NONCE}","status":"failed","total":1,"completed":1,"failed":1,"skipped":0,"errors":0}`;

  assert.equal(
    _private.resolvePlaywrightCompletionExitCode(output, {
      childEnv: {
        PLAYWRIGHT_PERF_VERIFICATION_GROUP_ID: 'idle-memory-123',
      },
    }),
    null,
  );
  assert.equal(
    _private.resolvePlaywrightCompletionExitCode(`${finalizedOutput}\n[playwright-performance-reporter] flush-complete`, {
      childEnv: {
        PLAYWRIGHT_PERF_VERIFICATION_GROUP_ID: 'idle-memory-123',
      },
    }),
    1,
  );
});

test('shouldUseReporterDrivenCompletion keeps the reporter-driven completion path available for both managed and non-managed runs', () => {
  assert.equal(
    _private.shouldUseReporterDrivenCompletion({ servesRealApp: true }),
    true,
  );
  assert.equal(
    _private.shouldUseReporterDrivenCompletion({ servesRealApp: false }),
    true,
  );
  assert.equal(
    _private.shouldUseReporterDrivenCompletion({ servesRealApp: false, listOnly: true }),
    false,
  );
});

test('usesManagedSupportAppPort treats default and isolated configs as managed support-app runs', () => {
  assert.equal(
    _private.usesManagedSupportAppPort(['test', 'tests/e2e/performance/idleMemory.spec.js']),
    true,
  );
  assert.equal(
    _private.usesManagedSupportAppPort(['test', '-c', 'playwright.performance.config.cjs']),
    true,
  );
  assert.equal(
    _private.usesManagedSupportAppPort(['test', '-c', 'playwright.scan-performance.config.cjs']),
    true,
  );
  assert.equal(
    _private.usesManagedSupportAppPort(['test', '--config=playwright.scan-performance.config.cjs']),
    true,
  );
});

test('usesManagedSupportAppPort includes the runner-managed synthetic config', () => {
  assert.equal(
    _private.usesManagedSupportAppPort(['test', '-c', 'playwright.synthetic-large-library.config.cjs']),
    true,
  );
});

test('resolveManagedPortReuseTimeoutMs never restores the removed 45-second support-app cooldown', () => {
  assert.equal(
    _private.resolveManagedPortReuseTimeoutMs({ servesRealApp: true }),
    15000,
  );
  assert.equal(
    _private.resolveManagedPortReuseTimeoutMs({ servesRealApp: false }),
    _private.MANAGED_SUPPORT_APP_PORT_REUSE_TIMEOUT_MS,
  );
  assert.equal(
    _private.MANAGED_SUPPORT_APP_PORT_REUSE_TIMEOUT_MS,
    15000,
  );
});

test('resolveExplicitPlaywrightConfig reads the explicit config path from short and inline flags', () => {
  assert.equal(
    _private.resolveExplicitPlaywrightConfig(['test', '-c', 'playwright.synthetic-large-library.config.cjs']),
    'playwright.synthetic-large-library.config.cjs',
  );
  assert.equal(
    _private.resolveExplicitPlaywrightConfig(['test', '--config=playwright.performance.config.cjs']),
    'playwright.performance.config.cjs',
  );
});

test('isSyntheticLargeLibraryConfig detects only the synthetic-large Playwright config', () => {
  assert.equal(
    _private.isSyntheticLargeLibraryConfig(['test', '-c', 'playwright.synthetic-large-library.config.cjs']),
    true,
  );
  assert.equal(
    _private.isSyntheticLargeLibraryConfig(['test', '-c', 'playwright.performance.config.cjs']),
    false,
  );
});

test('usesRunnerOwnedIsolatedTempRoot includes managed performance without changing default or synthetic-large-library rules', () => {
  assert.equal(
    _private.usesRunnerOwnedIsolatedTempRoot(['test', '-c', 'playwright.performance.config.cjs']),
    true,
  );
  assert.equal(
    _private.usesRunnerOwnedIsolatedTempRoot(['test', '-c', 'playwright.scan-performance.config.cjs']),
    true,
  );
  assert.equal(_private.usesRunnerOwnedIsolatedTempRoot(['test']), true);
  assert.equal(
    _private.usesRunnerOwnedIsolatedTempRoot(
      ['test', '-c', 'playwright.lastfm-auto-timezone.config.js'],
    ),
    true,
  );
  assert.equal(
    _private.usesRunnerOwnedIsolatedTempRoot(
      ['test', '-c', 'playwright.cover-rescan.config.js'],
    ),
    true,
  );
  assert.equal(
    _private.usesRunnerOwnedIsolatedTempRoot(
      ['test', '-c', 'playwright.non-album-rescan.config.js'],
    ),
    true,
  );
  assert.equal(
    _private.usesRunnerOwnedIsolatedTempRoot(
      ['test', '-c', 'playwright.synthetic-large-library.config.cjs'],
      { PLAYWRIGHT_ISOLATED_LIBRARY_APP: '1' },
    ),
    true,
  );
  assert.equal(
    _private.usesRunnerOwnedIsolatedTempRoot(
      ['test', '-c', 'playwright.synthetic-large-library.config.cjs'],
      {},
    ),
    true,
  );
  assert.equal(
    _private.usesRunnerOwnedIsolatedTempRoot(['test', '-c', 'playwright.unmanaged.config.cjs']),
    false,
  );
});

test('prepared performance profile sessions retain their caller-owned temp root', () => {
  const preparedSessionEnv = {
    ALBUM_HAVEN_PERFORMANCE_PROFILE_SESSION: '1',
    ALBUM_HAVEN_E2E_TEMP_ROOT: 'C:\\runner-temp\\prepared-performance-profile',
  };

  assert.equal(
    _private.usesRunnerOwnedIsolatedTempRoot(
      ['test', '-c', 'playwright.performance.config.cjs'],
      preparedSessionEnv,
    ),
    false,
  );
  assert.equal(
    _private.usesRunnerOwnedIsolatedTempRoot(
      ['test', '-c', 'playwright.scan-performance.config.cjs'],
      preparedSessionEnv,
    ),
    false,
  );
});

test('dedicated functional configs retain the managed isolated app contract', () => {
  for (const config of [
    'playwright.lastfm-auto-timezone.config.js',
    'playwright.cover-rescan.config.js',
    'playwright.non-album-rescan.config.js',
  ]) {
    assert.equal(
      _private.isManagedIsolatedLibraryConfig(['test', `--config=${config}`]),
      true,
      config,
    );
  }
  assert.equal(
    _private.isManagedIsolatedLibraryConfig(
      ['test', '--config=playwright.unmanaged.config.js'],
    ),
    false,
  );
});

test('resolvePlaywrightBrowsersPath preserves Playwright default when the repo-local cache is absent', () => {
  assert.equal(typeof _private.resolvePlaywrightBrowsersPath, 'function');
  const repoLocalBrowsersPath = path.join(
    'C:',
    'repo',
    'node_modules',
    '.cache',
    'ms-playwright',
  );

  const resolvedBrowsersPath = _private.resolvePlaywrightBrowsersPath({}, {
    defaultBrowsersPath: repoLocalBrowsersPath,
    existsSyncFn(candidatePath) {
      assert.equal(candidatePath, repoLocalBrowsersPath);
      return false;
    },
  });

  assert.equal(resolvedBrowsersPath, undefined);
});

test('resolveManagedWebServerPorts returns the complete managed port allocation', () => {
  assert.deepEqual(
    _private.resolveManagedWebServerPorts({
      servesRealApp: true,
      realAppPort: 5007,
      supportAppPort: 4173,
      managesSupportAppPort: true,
    }),
    [5007],
  );
  assert.deepEqual(
    _private.resolveManagedWebServerPorts({
      servesRealApp: false,
      supportAppPort: 4174,
      providerPort: 5174,
      managesSupportAppPort: true,
    }),
    [4174, 5174],
  );
  assert.deepEqual(
    _private.resolveManagedWebServerPorts({
      servesRealApp: false,
      supportAppPort: 4174,
      providerPort: 4176,
      managesSupportAppPort: true,
      managesProviderPort: false,
    }),
    [4174],
  );
  assert.deepEqual(
    _private.resolveManagedWebServerPorts({
      servesRealApp: false,
      supportAppPort: 4174,
      managesSupportAppPort: false,
    }),
    [],
  );
});

test('resolveRunTimeoutMs uses the longer functional wrapper default when no override is provided', () => {
  assert.equal(
    _private.resolveRunTimeoutMs(),
    3000000,
  );
});

test('resolveRunTimeoutMs preserves explicit wrapper timeout overrides', () => {
  assert.equal(
    _private.resolveRunTimeoutMs(180000),
    180000,
  );
});

test('shouldRetryManagedRealAppPortConflict retries one real-app startup failure with the known port-conflict message', () => {
  assert.equal(
    _private.shouldRetryManagedRealAppPortConflict(
      {
        exitCode: 1,
        combinedOutput: 'Error: http://127.0.0.1:5001/status is already used, make sure that nothing is running on the port/url or set reuseExistingServer:true in config.webServer.',
      },
      {
        managedPorts: [5001],
        attemptsRemaining: 1,
      },
    ),
    true,
  );
});

test('shouldRetryManagedRealAppPortConflict retries the Windows socket access bind failure once', () => {
  assert.equal(
    _private.shouldRetryManagedRealAppPortConflict(
      {
        exitCode: 1,
        combinedOutput: 'Error: Process from config.webServer was not able to start. Exit code: 1\nAn attempt was made to access a socket in a way forbidden by its access permissions',
      },
      {
        managedPorts: [5002],
        attemptsRemaining: 1,
      },
    ),
    true,
  );
});

test('shouldRetryManagedRealAppPortConflict retries WinError 10013 startup failures once', () => {
  assert.equal(
    _private.shouldRetryManagedRealAppPortConflict(
      {
        exitCode: 1,
        combinedOutput: 'OSError: [WinError 10013] An attempt was made to access a socket in a way forbidden by its access permissions',
      },
      {
        managedPorts: [5002],
        attemptsRemaining: 1,
      },
    ),
    true,
  );
});

test('shouldRetryManagedRealAppPortConflict retries Windows address-in-use 10048 startup failures once', () => {
  assert.equal(
    _private.shouldRetryManagedRealAppPortConflict(
      {
        exitCode: 1,
        combinedOutput: "OSError: [Errno 10048] error while attempting to bind on address ('127.0.0.1', 5101): [WinError 10048] Only one usage of each socket address is normally permitted",
      },
      {
        managedPorts: [5101],
        attemptsRemaining: 1,
      },
    ),
    true,
  );
});

test('shouldRetryManagedRealAppPortConflict does not retry after the one allowed retry was already spent', () => {
  assert.equal(
    _private.shouldRetryManagedRealAppPortConflict(
      {
        exitCode: 1,
        combinedOutput: 'Error: http://127.0.0.1:5001/status is already used, make sure that nothing is running on the port/url or set reuseExistingServer:true in config.webServer.',
      },
      {
        managedPorts: [5001],
        attemptsRemaining: 0,
      },
    ),
    false,
  );
});

test('shouldRetryManagedRealAppPortConflict ignores ordinary test failures', () => {
  assert.equal(
    _private.shouldRetryManagedRealAppPortConflict(
      {
        exitCode: 1,
        combinedOutput: '1 failed',
      },
      {
        managedPorts: [5001],
        attemptsRemaining: 1,
      },
    ),
    false,
  );
});

test('ensurePortReleased waits until the port is bindable, not just ownerless', async () => {
  let bindAttempts = 0;
  let sleepCalls = 0;

  const released = await _private.ensurePortReleased(5001, {
    timeoutMs: 1000,
    pollIntervalMs: 1,
    stablePollCount: 1,
    readPortOwningProcessesFn() {
      return [];
    },
    async probePortBindableFn() {
      bindAttempts += 1;
      return bindAttempts >= 3;
    },
    stopProcessTreeFn() {
      throw new Error('stopProcessTreeFn should not be called when the port has no owners');
    },
    async sleepFn() {
      sleepCalls += 1;
    },
  });

  assert.equal(released, true);
  assert.equal(bindAttempts, 3);
  assert.equal(sleepCalls, 2);
});

test('waitForPortReleased keeps owner enumeration for generic callers', async () => {
  let ownerProbeCalls = 0;
  let bindProbeCalls = 0;

  const released = await _private.waitForPortReleased(5002, {
    timeoutMs: 1000,
    pollIntervalMs: 1,
    stablePollCount: 1,
    readPortOwningProcessesFn() {
      ownerProbeCalls += 1;
      return [];
    },
    async probePortBindableFn() {
      bindProbeCalls += 1;
      return true;
    },
  });

  assert.equal(released, true);
  assert.equal(ownerProbeCalls, 1);
  assert.equal(bindProbeCalls, 1);
});

test('ensurePortReleased fails closed after readiness polling is exhausted so callers cannot ignore false', async (t) => {
  const originalDateNow = Date.now;
  let currentTimeMs = 0;
  Date.now = () => currentTimeMs;
  t.after(() => {
    Date.now = originalDateNow;
  });

  await assert.rejects(
    _private.ensurePortReleased(5101, {
      timeoutMs: 10,
      pollIntervalMs: 1,
      stablePollCount: 1,
      readPortOwningProcessesFn() {
        return [];
      },
      async probePortBindableFn() {
        return false;
      },
      stopProcessTreeFn() {
        throw new Error('stopProcessTreeFn should not be called when the port has no owners');
      },
      async sleepFn() {
        currentTimeMs = 11;
      },
    }),
    /port 5101.*not reusable before startup/i,
  );
});

test('runPlaywrightProcess lets managed real-app runs exit naturally after completion is observed', async () => {
  const child = createFakeChildProcess();
  const timerHarness = createTimerHarness();
  const stdoutWrites = [];
  let stopCalls = 0;
  let reclaimCalls = 0;
  let waitCalls = 0;
  let spawnOptions;

  const runPromise = _private.runPlaywrightProcess(
    ['test', '-c', 'playwright.external-real-app.config.cjs'],
    {
      PLAYWRIGHT_SERVE_REAL_APP: '1',
      PLAYWRIGHT_REAL_APP_PORT: '5001',
      ALBUM_HAVEN_APP_DATABASE_URL: 'postgresql://album_haven_app@localhost/album_haven',
    },
    1000,
    {
      spawnFn(_command, _args, options) {
        spawnOptions = options;
        return child;
      },
      stopProcessTreeFn() {
        stopCalls += 1;
      },
      reclaimPortFn() {
        reclaimCalls += 1;
        return [];
      },
      waitForPortReleasedFn: async () => {
        waitCalls += 1;
        return true;
      },
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: {
        write(text) {
          stdoutWrites.push(text);
        },
      },
      stderr: {
        write() {},
      },
    },
  );

  child.stdout.emit('data', Buffer.from(`
Running 1 test using 1 worker

  ok 1 [synthetic-large-library] > tests/e2e/syntheticLargeLibrary/sample.spec.js:1:1 > sample test (1.0s)

  1 passed (1.1s)
${PASS_FINAL_RESULT}
`));

  const managedCompletionTimer = timerHarness.timers.find((timer) => timer.delay > 15000);
  assert.ok(managedCompletionTimer, 'expected a longer managed completion fallback timer');
  assert.equal(timerHarness.timers.filter((timer) => timer.delay === 1000).length, 1);
  assert.equal(spawnOptions.windowsHide, true);
  assert.equal(spawnOptions.env.PLAYWRIGHT_OPEN_PERFORMANCE_REPORT, '0');
  assert.equal(
    spawnOptions.env[_private.PLAYWRIGHT_FINAL_RESULT_NONCE_ENV],
    TEST_RESULT_NONCE,
  );

  assert.equal(stopCalls, 0);
  assert.equal(reclaimCalls, 0);
  assert.equal(waitCalls, 0);

  child.emit('exit', 0);
  const result = await runPromise;
  assert.equal(reclaimCalls, 1);
  assert.equal(result.exitCode, 0);
  assert.match(stdoutWrites.join(''), /1 passed/);
});

test('runPlaywrightProcess waits for close so stdout arriving after exit can authorize success', async () => {
  const child = createFakeChildProcess(4242, { autoCloseOnExit: false });
  const timerHarness = createTimerHarness();
  let settled = false;
  const runPromise = _private.runPlaywrightProcess(
    ['test', '--config=custom.config.cjs'],
    {},
    1000,
    {
      spawnFn() {
        return child;
      },
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: { write() {} },
      stderr: { write() {} },
    },
  );
  void runPromise.then(() => {
    settled = true;
  });

  child.emit('exit', 0);
  await Promise.resolve();
  assert.equal(settled, false);

  child.stdout.emit('data', Buffer.from(`${PASS_FINAL_RESULT}\n`));
  await Promise.resolve();
  assert.equal(settled, false);

  child.emit('close', 0);
  const result = await runPromise;
  assert.equal(result.exitCode, 0);
});

test('createPlaywrightResultNonce returns independent cryptographically sized run tokens', () => {
  const first = _private.createPlaywrightResultNonce();
  const second = _private.createPlaywrightResultNonce();
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.match(second, /^[a-f0-9]{64}$/);
  assert.notEqual(first, second);
});

test('Playwright workers cannot see the parent-only final-result nonce', async () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const configPath = path.join(repoRoot, 'playwright.config.js');
  const nonceEnv = _private.PLAYWRIGHT_FINAL_RESULT_NONCE_ENV;
  const previousNonce = process.env[nonceEnv];
  const privacyNonce = 'parent-only-privacy-test-nonce';

  try {
    process.env[nonceEnv] = privacyNonce;
    const { configLoader, ipc } = require('../../node_modules/playwright/lib/common/index.js');
    const fullConfig = await configLoader.loadConfigFromFile(configPath, {}, false);
    const workerConfigPayload = ipc.serializeConfig(fullConfig, true);

    assert.equal(process.env[nonceEnv], undefined);
    assert.equal(JSON.stringify(workerConfigPayload).includes(privacyNonce), false);

    const workerProbe = spawnSync(process.execPath, ['-e', `
      const config = require('./playwright.config.js');
      const nonceEnv = ${JSON.stringify(nonceEnv)};
      const reporter = config.reporter.find(([reporterPath]) =>
        String(reporterPath).includes('playwright-final-result-reporter.cjs')
      );
      process.stdout.write(JSON.stringify({
        envNonce: process.env[nonceEnv] || '',
        reporterNonce: reporter?.[1]?.nonce || '',
      }));
    `], {
      cwd: repoRoot,
      env: { ...process.env },
      encoding: 'utf8',
      windowsHide: true,
    });

    assert.equal(workerProbe.status, 0, workerProbe.stderr);
    assert.deepEqual(JSON.parse(workerProbe.stdout), {
      envNonce: '',
      reporterNonce: '',
    });
  } finally {
    if (previousNonce === undefined) {
      delete process.env[nonceEnv];
    } else {
      process.env[nonceEnv] = previousNonce;
    }
  }
});

test('resolvePlaywrightCompletionExitCode trusts the final structured failure over an earlier passing list result', () => {
  assert.equal(
    _private.resolvePlaywrightCompletionExitCode(`
Running 1 test using 1 worker

  ok 1 [idle-memory] > tests/e2e/specs/lastfmProductionPath.spec.js:1:1 > browser scenario (1.0s)

  1 failed

=== Playwright Summary ===
Overall: 0/1 passed
[album-haven-playwright-result] {"version":1,"phase":"run-final","nonce":"${TEST_RESULT_NONCE}","status":"failed","total":1,"completed":1,"failed":1,"skipped":0,"errors":1}
`),
    1,
  );
});

test('resolvePlaywrightCompletionExitCode requires valid evidence and preserves the last authenticated result', () => {
  assert.equal(
    _private.resolvePlaywrightCompletionExitCode(`
Running 1 test using 1 worker
  ok 1 [idle-memory] > tests/e2e/specs/sample.spec.js:1:1 > sample (1.0s)
  1 passed (1.1s)
`),
    null,
  );
  assert.equal(
    _private.resolvePlaywrightCompletionExitCode(`
[album-haven-playwright-result] {"version":1,"phase":"run-final","nonce":"${TEST_RESULT_NONCE}","status":"passed","total":1,"completed":0,"failed":0,"skipped":0,"errors":0}
`),
    1,
  );
  assert.equal(
    _private.resolvePlaywrightCompletionExitCode(`
${PASS_FINAL_RESULT}
[album-haven-playwright-result] {"version":1,"status":"passed"
`, { expectedNonce: TEST_RESULT_NONCE }),
    0,
  );
  assert.equal(
    _private.resolvePlaywrightCompletionExitCode(`
${PASS_FINAL_RESULT}
[album-haven-playwright-result] {"version":1,"phase":"run-final","nonce":"wrong-nonce","status":"failed","total":1,"completed":1,"failed":1,"skipped":0,"errors":1}
`, { expectedNonce: TEST_RESULT_NONCE }),
    0,
  );
  assert.equal(
    _private.resolvePlaywrightCompletionExitCode(`
${PASS_FINAL_RESULT}
[album-haven-playwright-result] {"version":1,"phase":"run-final","nonce":"${TEST_RESULT_NONCE}","status":"failed","total":1,"completed":2,"failed":1,"skipped":0,"errors":1}
`, { expectedNonce: TEST_RESULT_NONCE }),
    0,
  );
  assert.equal(
    _private.resolvePlaywrightCompletionExitCode(`
${PASS_FINAL_RESULT}
[album-haven-playwright-result] {"version":1,"phase":"run-final","nonce":"${TEST_RESULT_NONCE}","status":"failed","total":2,"completed":1,"failed":1,"skipped":1,"errors":1}
`, { expectedNonce: TEST_RESULT_NONCE }),
    0,
  );
});

test('run-error latches failure without starting cleanup or cancelling the hard timeout', async () => {
  const child = createFakeChildProcess();
  const timerHarness = createTimerHarness();
  let reclaimCalls = 0;
  const runPromise = _private.runPlaywrightProcess(
    ['test', '-c', 'playwright.performance.config.cjs'],
    {},
    1000,
    {
      spawnFn: () => child,
      reclaimPortFn() { reclaimCalls += 1; return []; },
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: { write() {} },
      stderr: { write() {} },
    },
  );
  const hardTimeout = timerHarness.timers.find((timer) => timer.delay === 1000);
  child.stdout.emit('data', Buffer.from(
    `[album-haven-playwright-result] {"version":1,"phase":"run-error","nonce":"${TEST_RESULT_NONCE}","status":"failed","total":1,"completed":0,"failed":0,"skipped":0,"errors":1}\n`,
  ));
  assert.equal(reclaimCalls, 0);
  assert.equal(hardTimeout.cleared, false);
  assert.equal(timerHarness.timers.filter((timer) => timer.delay === 15000).length, 0);
  child.stdout.emit('data', Buffer.from(`${PASS_FINAL_RESULT}\n`));
  child.emit('exit', 0);
  assert.equal((await runPromise).exitCode, 1);
});

test('every authenticated terminal non-pass status immediately latches process failure', async () => {
  const terminalCases = [
    { phase: 'run-error', status: 'failed' },
    { phase: 'tests-complete', status: 'failed' },
    { phase: 'run-final', status: 'failed' },
    { phase: 'run-final', status: 'timedout' },
    { phase: 'run-final', status: 'interrupted' },
  ];
  for (const { phase, status } of terminalCases) {
    const child = createFakeChildProcess();
    const timerHarness = createTimerHarness();
    const processObject = { exitCode: null };
    const stderrWrites = [];
    const runPromise = runPlaywrightProcessWithGeneratedNonce(
      ['test', '--config=custom.config.cjs'],
      {},
      1000,
      {
        resultNonce: TEST_RESULT_NONCE,
        processObject,
        spawnFn: () => child,
        reclaimPortFn: () => [],
        setTimeoutFn: timerHarness.setTimeoutFn,
        clearTimeoutFn: timerHarness.clearTimeoutFn,
        stdout: { write() {} },
        stderr: { write(text) { stderrWrites.push(text); } },
      },
    );
    child.stdout.emit('data', Buffer.from(
      `[album-haven-playwright-result] {"version":1,"phase":"${phase}","nonce":"${TEST_RESULT_NONCE}","status":"${status}","total":1,"completed":1,"failed":1,"skipped":0,"errors":0}\n`,
    ));
    assert.equal(processObject.exitCode, 1, `${phase}:${status}`);
    assert.match(stderrWrites.join(''), new RegExp(`"status":"${status}"`));
    child.emit('exit', 0);
    const result = await runPromise;
    assert.equal(result.exitCode, 1, `${phase}:${status}`);
    assert.equal(
      _private.finalizeMainResult(
        { exitCode: 0, lifecycle: result.lifecycle },
        { processObject, stderr: { write() {} } },
      ),
      1,
      `${phase}:${status}`,
    );
    assert.equal(processObject.exitCode, 1, `${phase}:${status}`);
  }
});

test('wrong-nonce terminal failure cannot latch the runner process', async () => {
  const child = createFakeChildProcess();
  const timerHarness = createTimerHarness();
  const processObject = { exitCode: null };
  const runPromise = runPlaywrightProcessWithGeneratedNonce(
    ['test', '--config=custom.config.cjs'],
    {},
    1000,
    {
      resultNonce: TEST_RESULT_NONCE,
      processObject,
      spawnFn: () => child,
      reclaimPortFn: () => [],
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: { write() {} },
      stderr: { write() {} },
    },
  );
  child.stdout.emit('data', Buffer.from(
    '[album-haven-playwright-result] '
    + '{"version":1,"phase":"run-final","nonce":"wrong-nonce","status":"interrupted",'
    + '"total":1,"completed":1,"failed":1,"skipped":0,"errors":0}\n',
  ));
  assert.equal(processObject.exitCode, null);
  child.stdout.emit('data', Buffer.from(`${PASS_FINAL_RESULT}\n`));
  child.emit('exit', 0);
  assert.equal((await runPromise).exitCode, 0);
  assert.equal(processObject.exitCode, null);
});

test('run-final cancels tests-complete grace but lets late webServer output and natural child close precede owned cleanup', async () => {
  const child = createFakeChildProcess(4242, { autoCloseOnExit: false });
  const timerHarness = createTimerHarness();
  let reclaimCalls = 0;
  let settled = false;
  const runPromise = _private.runPlaywrightProcess(
    ['test', '-c', 'playwright.performance.config.cjs'], {}, 1000, {
      spawnFn: () => child,
      reclaimPortFn() { reclaimCalls += 1; return []; },
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: { write() {} }, stderr: { write() {} },
    },
  );
  void runPromise.then(() => { settled = true; });
  const testsComplete = `[album-haven-playwright-result] {"version":1,"phase":"tests-complete","nonce":"${TEST_RESULT_NONCE}","status":"passed","total":1,"completed":1,"failed":0,"skipped":0,"errors":0}\n`;
  child.stdout.emit('data', Buffer.from(testsComplete));
  const grace = timerHarness.timers.find((timer) => timer.delay === 15000);
  assert.ok(grace);
  assert.equal(reclaimCalls, 0);
  child.stdout.emit('data', Buffer.from(`${PASS_FINAL_RESULT}\n`));
  await Promise.resolve();
  assert.equal(grace.cleared, true);
  assert.equal(reclaimCalls, 0);
  assert.equal(settled, false);
  assert.equal(
    timerHarness.timers.some((timer) => (
      timer.delay === 15000 && timer !== grace && timer.cleared === false
    )),
    false,
  );
  assert.equal(timerHarness.timers.find((timer) => timer.delay === 1000).cleared, false);

  child.stderr.emit('data', Buffer.from('[WebServer] shutdown hydration log after run-final\n'));
  child.emit('exit', 0);
  await Promise.resolve();
  assert.equal(reclaimCalls, 0);
  assert.equal(settled, false);

  child.emit('close', 0);
  const result = await runPromise;
  assert.equal(reclaimCalls, 2);
  assert.equal(result.exitCode, 0);
  assert.match(result.combinedOutput, /shutdown hydration log after run-final/);
});

test('tests-complete cleanup starts a bounded wait for authenticated run-final', async () => {
  const child = createFakeChildProcess(4242, { autoCloseOnExit: false });
  const timerHarness = createTimerHarness();
  let mockedNowMs = 0;
  const runPromise = _private.runPlaywrightProcess(
    ['test', '-c', 'playwright.performance.config.cjs'],
    {},
    60000,
    {
      spawnFn: () => child,
      reclaimPortFn() { return []; },
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: { write() {} },
      stderr: { write() {} },
    },
  );
  const testsComplete = `[album-haven-playwright-result] {"version":1,"phase":"tests-complete","nonce":"${TEST_RESULT_NONCE}","status":"passed","total":1,"completed":1,"failed":0,"skipped":0,"errors":0}\n`;

  child.stdout.emit('data', Buffer.from(testsComplete));
  const cleanupGrace = timerHarness.timers.find((timer) => timer.delay === 15000);
  assert.ok(cleanupGrace);
  mockedNowMs += cleanupGrace.delay + 1;
  await cleanupGrace.fn();
  await Promise.resolve();
  assert.equal(mockedNowMs, 15001);
  const finalResultTimer = timerHarness.timers.find((timer) => (
    timer.delay === 15000 && timer !== cleanupGrace
  ));
  assert.ok(finalResultTimer, 'cleanup completion must bound the wait for run-final');

  mockedNowMs += 16000;
  child.stdout.emit('data', Buffer.from(`${PASS_FINAL_RESULT}\n`));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(mockedNowMs, 31001, 'run-final arrived more than 15 seconds after tests-complete');
  const closeTimer = timerHarness.timers.find((timer) => (
    timer.delay === 15000 && timer !== cleanupGrace && timer !== finalResultTimer
  ));
  assert.ok(closeTimer, 'authenticated run-final must start the bounded child-close timer');
  assert.equal(cleanupGrace.cleared, true);
  assert.equal(finalResultTimer.cleared, true);
  assert.equal(closeTimer.cleared, false);

  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  const result = await runPromise;
  assert.equal(result.exitCode, 0);
  assert.equal(closeTimer.cleared, true);
});

test('tests-complete cleanup stops the managed shell launch root after Python releases its ports', async () => {
  const child = createFakeChildProcess(4242, { autoCloseOnExit: false });
  const timerHarness = createTimerHarness();
  const serviceOwner = { pid: 2468, creationIdentity: 'service-start' };
  const shellRoot = { pid: 2357, creationIdentity: 'shell-start' };
  const stopped = [];
  const waitedFor = [];
  let portSnapshotCalls = 0;
  const runPromise = _private.runPlaywrightProcess(
    ['test', '-c', 'playwright.performance.config.cjs'],
    {},
    60000,
    {
      spawnFn: () => child,
      readProcessTreeIdentitiesFn: () => [
        { pid: child.pid, creationIdentity: 'cli-start', parentPid: 0, depth: 0 },
        { ...shellRoot, parentPid: child.pid, depth: 1 },
        { ...serviceOwner, parentPid: shellRoot.pid, depth: 2 },
      ],
      readPortOwningProcessIdentitiesFn() {
        portSnapshotCalls += 1;
        return [serviceOwner];
      },
      readProcessCreationIdentityFn(pid) {
        return new Map([
          [shellRoot.pid, shellRoot.creationIdentity],
          [serviceOwner.pid, serviceOwner.creationIdentity],
        ]).get(pid) || null;
      },
      stopProcessTreeFn(pid, options) {
        stopped.push({ pid, options });
      },
      reclaimPortFn() {
        return [];
      },
      async waitForReclaimedProcessesExitedFn(owners) {
        waitedFor.push(...owners);
      },
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: { write() {} },
      stderr: { write() {} },
    },
  );
  const testsComplete = `[album-haven-playwright-result] {"version":1,"phase":"tests-complete","nonce":"${TEST_RESULT_NONCE}","status":"passed","total":1,"completed":1,"failed":0,"skipped":0,"errors":0}\n`;

  child.stdout.emit('data', Buffer.from(testsComplete));
  assert.equal(portSnapshotCalls, 2);
  const cleanupGrace = timerHarness.timers.find((timer) => timer.delay === 15000);
  assert.ok(cleanupGrace);
  await cleanupGrace.fn();
  await Promise.resolve();

  assert.deepEqual(stopped, [{
    pid: shellRoot.pid,
    options: { expectedCreationIdentity: shellRoot.creationIdentity },
  }]);
  assert.deepEqual(waitedFor, [shellRoot, serviceOwner]);
  assert.equal(stopped.some(({ pid }) => pid === child.pid), false);

  child.stdout.emit('data', Buffer.from(`${PASS_FINAL_RESULT}\n`));
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  assert.equal((await runPromise).exitCode, 0);
});

test('tests-complete without run-final fails on the short finalization deadline', async () => {
  const child = createFakeChildProcess(4242, { autoCloseOnExit: false });
  const timerHarness = createTimerHarness();
  const serviceOwner = { pid: 2468, creationIdentity: 'service-start' };
  const shellRoot = { pid: 2357, creationIdentity: 'shell-start' };
  const stopped = [];
  const stderrWrites = [];
  const runPromise = _private.runPlaywrightProcess(
    ['test', '-c', 'playwright.performance.config.cjs'],
    {},
    600000,
    {
      spawnFn: () => child,
      readProcessTreeIdentitiesFn: () => [
        { pid: child.pid, creationIdentity: 'cli-start', parentPid: 0, depth: 0 },
        { ...shellRoot, parentPid: child.pid, depth: 1 },
        { ...serviceOwner, parentPid: shellRoot.pid, depth: 2 },
      ],
      readPortOwningProcessIdentitiesFn: () => [serviceOwner],
      readProcessCreationIdentityFn(pid) {
        return pid === shellRoot.pid ? shellRoot.creationIdentity : null;
      },
      stopProcessTreeFn(pid) {
        stopped.push(pid);
      },
      reclaimPortFn: () => [],
      waitForReclaimedProcessesExitedFn: async () => {},
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: { write() {} },
      stderr: { write(text) { stderrWrites.push(text); } },
    },
  );
  const testsComplete = `[album-haven-playwright-result] {"version":1,"phase":"tests-complete","nonce":"${TEST_RESULT_NONCE}","status":"passed","total":1,"completed":1,"failed":0,"skipped":0,"errors":0}\n`;

  child.stdout.emit('data', Buffer.from(testsComplete));
  const cleanupGrace = timerHarness.timers.find((timer) => timer.delay === 15000);
  assert.ok(cleanupGrace);
  await cleanupGrace.fn();
  await Promise.resolve();
  assert.deepEqual(stopped, [shellRoot.pid], 'launch-root teardown must precede the run-final deadline');
  const finalResultTimer = timerHarness.timers.find((timer) => (
    timer.delay === 15000 && timer !== cleanupGrace && timer.cleared === false
  ));
  assert.ok(finalResultTimer, 'expected a short deadline instead of the 600-second run timeout');

  await finalResultTimer.fn();
  const result = await runPromise;
  assert.equal(result.exitCode, 1);
  assert.deepEqual(stopped, [shellRoot.pid, child.pid]);
  assert.match(stderrWrites.join(''), /\[playwright-wrapper-diagnostic\]/);
  assert.match(stderrWrites.join(''), /"reason":"wrapper-child-lifecycle-mismatch"/);
  assert.match(stderrWrites.join(''), /"stopReason":"finalization-timeout"/);
  assert.match(result.combinedOutput, /\[playwright-wrapper-diagnostic\]/);
});

test('recorded managed service PID reuse never stops the replacement process', async () => {
  const child = createFakeChildProcess(4242, { autoCloseOnExit: false });
  const timerHarness = createTimerHarness();
  const recordedOwner = { pid: 2468, creationIdentity: 'original-start' };
  const shellRoot = { pid: 2357, creationIdentity: 'shell-start' };
  const stopped = [];
  const runPromise = _private.runPlaywrightProcess(
    ['test', '-c', 'playwright.performance.config.cjs'],
    {},
    60000,
    {
      spawnFn: () => child,
      readProcessTreeIdentitiesFn: () => [
        { pid: child.pid, creationIdentity: 'cli-start', parentPid: 0, depth: 0 },
        { ...shellRoot, parentPid: child.pid, depth: 1 },
        { ...recordedOwner, parentPid: shellRoot.pid, depth: 2 },
      ],
      readPortOwningProcessIdentitiesFn: () => [recordedOwner],
      readProcessCreationIdentityFn: () => 'replacement-start',
      stopProcessTreeFn(pid) {
        stopped.push(pid);
      },
      reclaimPortFn: () => [],
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: { write() {} },
      stderr: { write() {} },
    },
  );
  const testsComplete = `[album-haven-playwright-result] {"version":1,"phase":"tests-complete","nonce":"${TEST_RESULT_NONCE}","status":"passed","total":1,"completed":1,"failed":0,"skipped":0,"errors":0}\n`;

  child.stdout.emit('data', Buffer.from(testsComplete));
  const cleanupGrace = timerHarness.timers.find((timer) => timer.delay === 15000);
  assert.ok(cleanupGrace);
  await cleanupGrace.fn();
  await Promise.resolve();
  assert.deepEqual(stopped, []);

  child.stdout.emit('data', Buffer.from(`${PASS_FINAL_RESULT}\n`));
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  assert.equal((await runPromise).exitCode, 0);
  assert.deepEqual(stopped, []);
});

test('authoritative pass mismatch reports child lifecycle and cleanup diagnostics', async () => {
  const child = createFakeChildProcess(4242, { autoCloseOnExit: false });
  const timerHarness = createTimerHarness();
  const stderrWrites = [];
  const runPromise = _private.runPlaywrightProcess(
    ['test', '-c', 'playwright.performance.config.cjs'], {}, 1000, {
      spawnFn: () => child,
      reclaimPortFn() { return []; },
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: { write() {} },
      stderr: { write(text) { stderrWrites.push(text); } },
    },
  );

  child.stdout.emit('data', Buffer.from(`${PASS_FINAL_RESULT}\n`));
  child.emit('exit', null, 'SIGTERM');
  child.emit('close', null, 'SIGTERM');
  const result = await runPromise;

  assert.equal(result.exitCode, 1);
  const diagnostic = stderrWrites.join('');
  assert.match(diagnostic, /\[playwright-wrapper-diagnostic\]/);
  assert.match(diagnostic, /"childExitCode":null/);
  assert.match(diagnostic, /"childExitSignal":"SIGTERM"/);
  assert.match(diagnostic, /"childCloseCode":null/);
  assert.match(diagnostic, /"childCloseSignal":"SIGTERM"/);
  assert.match(diagnostic, /"stopReason":"none"/);
  assert.match(diagnostic, /"cleanupOutcome":"completed"/);
  assert.match(result.combinedOutput, /\[playwright-wrapper-diagnostic\]/);
});

test('run-final preserves the tests-complete ownership snapshot when the exiting child cannot be resnapshotted', async () => {
  const child = createFakeChildProcess();
  const timerHarness = createTimerHarness();
  const owner = { pid: child.pid, creationIdentity: 'captured-owner', depth: 0 };
  const reclaimOptions = [];
  let snapshotCalls = 0;
  const runPromise = _private.runPlaywrightProcess(
    ['test', '-c', 'playwright.performance.config.cjs'], {}, 1000, {
      spawnFn: () => child,
      readProcessTreeIdentitiesFn() {
        snapshotCalls += 1;
        if (snapshotCalls === 1) return [owner];
        throw new Error('child already exited');
      },
      reclaimPortFn(_port, options) {
        reclaimOptions.push(options);
        return [];
      },
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: { write() {} }, stderr: { write() {} },
    },
  );
  const testsComplete = `[album-haven-playwright-result] {"version":1,"phase":"tests-complete","nonce":"${TEST_RESULT_NONCE}","status":"passed","total":1,"completed":1,"failed":0,"skipped":0,"errors":0}\n`;
  child.stdout.emit('data', Buffer.from(testsComplete));
  child.stdout.emit('data', Buffer.from(`${PASS_FINAL_RESULT}\n`));
  await Promise.resolve();
  assert.equal(snapshotCalls, 2);
  assert.equal(reclaimOptions.length, 0);
  child.emit('exit', 0);
  assert.equal((await runPromise).exitCode, 0);
  assert.equal(reclaimOptions.length, 2);
  assert.deepEqual(reclaimOptions[0].allowedOwners, [owner]);
});

test('resolvePlaywrightCompletionExitCode accepts an authoritative final pass after retry and setup output', () => {
  assert.equal(
    _private.resolvePlaywrightCompletionExitCode(`
Running 1 test using 1 worker
  x 1 [idle-memory] > tests/e2e/specs/sample.spec.js:1:1 > sample (1.0s)
Retry #1
  ok 2 [idle-memory] > tests/e2e/specs/sample.spec.js:1:1 > sample (1.0s)
[WebServer] setup output that is not a test result
[album-haven-playwright-result] {"version":1,"phase":"run-final","nonce":"${TEST_RESULT_NONCE}","status":"passed","total":1,"completed":1,"failed":0,"skipped":0,"errors":0}
`),
    0,
  );
});

test('resolvePlaywrightCompletionExitCode accepts a successful list-only result without executing tests', () => {
  assert.equal(
    _private.resolvePlaywrightCompletionExitCode(`
[album-haven-playwright-result] {"version":1,"phase":"run-final","nonce":"${TEST_RESULT_NONCE}","status":"passed","total":3,"completed":0,"failed":0,"skipped":0,"errors":0}
`, { listOnly: true }),
    0,
  );
});

test('a tests-complete pass can trigger cleanup but cannot authorize success before run-final', () => {
  const output = '[album-haven-playwright-result] {"version":1,"phase":"tests-complete","nonce":"expected-nonce","status":"passed","total":1,"completed":1,"failed":0,"skipped":0,"errors":0}';
  assert.equal(
    _private.resolvePlaywrightCompletionExitCode(output, { expectedNonce: 'expected-nonce' }),
    null,
  );
});

test('a static or wrong-nonce structured marker cannot spoof Playwright success', () => {
  const output = '[album-haven-playwright-result] {"version":1,"phase":"run-final","nonce":"attacker-nonce","status":"passed","total":1,"completed":1,"failed":0,"skipped":0,"errors":0}';
  assert.equal(
    _private.resolvePlaywrightCompletionExitCode(output, { expectedNonce: 'expected-nonce' }),
    null,
  );
});

test('runPlaywrightProcess fails closed when a zero-exit child omits the structured final result', async () => {
  const child = createFakeChildProcess();
  const timerHarness = createTimerHarness();
  const runPromise = _private.runPlaywrightProcess(
    ['test', '--config=custom.config.cjs'],
    {},
    1000,
    {
      spawnFn() {
        return child;
      },
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: { write() {} },
      stderr: { write() {} },
    },
  );

  child.stdout.emit('data', Buffer.from('Running 1 test using 1 worker\n  1 passed (1.1s)\n'));
  child.emit('exit', 0);

  const result = await runPromise;
  assert.equal(result.exitCode, 1);
  assert.equal(timerHarness.timers.some((timer) => timer.delay === 15000), false);
});

test('runPlaywrightProcess assembles the final stdout result across chunks without stderr interleaving drift', async () => {
  const child = createFakeChildProcess();
  const timerHarness = createTimerHarness();
  const runPromise = _private.runPlaywrightProcess(
    ['test', '--config=custom.config.cjs'],
    {},
    1000,
    {
      spawnFn() {
        return child;
      },
      stopProcessTreeFn() {},
      reclaimPortFn() {
        return [];
      },
      waitForPortReleasedFn: async () => true,
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: { write() {} },
      stderr: { write() {} },
    },
  );

  const marker = `[album-haven-playwright-result] {"version":1,"phase":"run-final","nonce":"${TEST_RESULT_NONCE}","status":"failed","total":1,"completed":1,"failed":1,"skipped":0,"errors":1}\n`;
  const splitAt = Math.floor(marker.length / 2);
  child.stdout.emit('data', Buffer.from(marker.slice(0, splitAt)));
  child.stderr.emit('data', Buffer.from('fixture teardown failed\n1 failed\n'));
  child.stdout.emit('data', Buffer.from(marker.slice(splitAt)));

  const completionTimer = timerHarness.timers.find((timer) => timer.delay === 15000);
  assert.ok(completionTimer, 'expected final reporter evidence to start completion cleanup');
  await completionTimer.fn();
  child.emit('exit', 0);
  const result = await runPromise;
  assert.equal(result.exitCode, 1);
});

test('runPlaywrightProcess latches a nonzero child exit during reporter grace as failure', async () => {
  const child = createFakeChildProcess();
  const timerHarness = createTimerHarness();
  const runPromise = _private.runPlaywrightProcess(
    ['test', '--config=custom.config.cjs'],
    {},
    1000,
    {
      spawnFn() {
        return child;
      },
      stopProcessTreeFn() {},
      reclaimPortFn() {
        return [];
      },
      waitForPortReleasedFn: async () => true,
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: { write() {} },
      stderr: { write() {} },
    },
  );

  child.stdout.emit('data', Buffer.from(`${PASS_FINAL_RESULT}\n`));
  child.emit('exit', 1);
  const completionTimer = timerHarness.timers.find((timer) => timer.delay === 15000);
  assert.ok(completionTimer);
  await completionTimer.fn();

  const result = await runPromise;
  assert.equal(result.exitCode, 1);
});

test('runPlaywrightProcess never promotes tests-complete pass when a later teardown error arrives', async () => {
  const child = createFakeChildProcess();
  const timerHarness = createTimerHarness();
  const runPromise = _private.runPlaywrightProcess(
    ['test', '--config=custom.config.cjs'],
    {},
    1000,
    {
      spawnFn() {
        return child;
      },
      stopProcessTreeFn() {},
      reclaimPortFn() {
        return [];
      },
      waitForPortReleasedFn: async () => true,
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: { write() {} },
      stderr: { write() {} },
    },
  );
  const testsComplete = `[album-haven-playwright-result] {"version":1,"phase":"tests-complete","nonce":"${TEST_RESULT_NONCE}","status":"passed","total":1,"completed":1,"failed":0,"skipped":0,"errors":0}\n`;
  const teardownError = `[album-haven-playwright-result] {"version":1,"phase":"run-error","nonce":"${TEST_RESULT_NONCE}","status":"failed","total":1,"completed":1,"failed":0,"skipped":0,"errors":1}\n`;

  child.stdout.emit('data', Buffer.from(testsComplete));
  const completionTimer = timerHarness.timers.find((timer) => timer.delay === 15000);
  assert.ok(completionTimer);
  completionTimer.fn();
  await Promise.resolve();
  await Promise.resolve();
  child.stdout.emit('data', Buffer.from(teardownError));
  child.emit('exit', 1);

  const result = await runPromise;
  assert.equal(result.exitCode, 1);
});

test('runPlaywrightProcess requires run-final pass and natural zero exit after tests-complete cleanup', async () => {
  const child = createFakeChildProcess();
  const timerHarness = createTimerHarness();
  const runPromise = _private.runPlaywrightProcess(
    ['test', '--config=custom.config.cjs'],
    {},
    1000,
    {
      spawnFn() {
        return child;
      },
      reclaimPortFn() {
        return [];
      },
      waitForPortReleasedFn: async () => true,
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: { write() {} },
      stderr: { write() {} },
    },
  );
  const testsComplete = `[album-haven-playwright-result] {"version":1,"phase":"tests-complete","nonce":"${TEST_RESULT_NONCE}","status":"passed","total":1,"completed":1,"failed":0,"skipped":0,"errors":0}\n`;

  child.stdout.emit('data', Buffer.from(testsComplete));
  const completionTimer = timerHarness.timers.find((timer) => timer.delay === 15000);
  assert.ok(completionTimer);
  completionTimer.fn();
  await Promise.resolve();
  await Promise.resolve();
  child.stdout.emit('data', Buffer.from(`${PASS_FINAL_RESULT}\n`));
  child.emit('exit', 0);

  const result = await runPromise;
  assert.equal(result.exitCode, 0);
});

test('runPlaywrightProcess bounds a module-load no-tests failure that never closes naturally', async () => {
  const child = createFakeChildProcess(4242, { autoCloseOnExit: false });
  const timerHarness = createTimerHarness();
  let stopCalls = 0;
  let reclaimCalls = 0;
  let cleanupCalls = 0;

  const runPromise = _private.runPlaywrightProcess(
    ['test'],
    {},
    900000,
    {
      spawnFn() {
        return child;
      },
      stopProcessTreeFn() {
        stopCalls += 1;
      },
      reclaimPortFn() {
        reclaimCalls += 1;
        return [];
      },
      cleanupIsolatedLibraryDatabaseFn() {
        cleanupCalls += 1;
      },
      readProcessTreeIdentitiesFn() {
        return [{ pid: child.pid, creationIdentity: 'probe-child', depth: 0 }];
      },
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: { write() {} },
      stderr: { write() {} },
    },
  );

  child.stderr.emit('data', Buffer.from(`ReferenceError: require is not defined\nError: No tests found.\n`));

  const failureGraceTimer = timerHarness.timers.find((timer) => (
    timer.delay === _private.PLAYWRIGHT_TERMINAL_COLLECTION_FAILURE_GRACE_MS
  ));
  assert.ok(failureGraceTimer, 'expected a prompt terminal startup-failure grace timer');
  assert.equal(failureGraceTimer.delay, 1000);
  assert.equal(
    timerHarness.timers.some((timer) => timer.delay === 15000),
    false,
    'the longer close timer must wait until terminal-failure cleanup finishes',
  );
  await failureGraceTimer.fn();
  await Promise.resolve();
  await Promise.resolve();
  const finalizationTimer = timerHarness.timers.find((timer) => timer.delay === 15000);
  assert.ok(finalizationTimer, 'expected bounded finalization after owned-port cleanup');
  await finalizationTimer.fn();
  const result = await runPromise;

  assert.equal(result.exitCode, 1);
  assert.equal(reclaimCalls, 2);
  assert.equal(stopCalls, 1);
  assert.equal(cleanupCalls, 1);
});

test('runPlaywrightProcess latches run-error without starting cleanup while tests may remain active', async () => {
  const child = createFakeChildProcess();
  const timerHarness = createTimerHarness();
  let reclaimCalls = 0;
  const runPromise = _private.runPlaywrightProcess(
    ['test'],
    {},
    1000,
    {
      spawnFn() {
        return child;
      },
      reclaimPortFn() {
        reclaimCalls += 1;
        return [];
      },
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: { write() {} },
      stderr: { write() {} },
    },
  );
  const runError = `[album-haven-playwright-result] {"version":1,"phase":"run-error","nonce":"${TEST_RESULT_NONCE}","status":"failed","total":2,"completed":1,"failed":0,"skipped":0,"errors":1}\n`;

  child.stdout.emit('data', Buffer.from(`${runError}Running 2 tests using 1 worker\n`));
  child.stderr.emit('data', Buffer.from('Error: No tests found.\n'));
  assert.equal(reclaimCalls, 0);
  assert.equal(timerHarness.timers.filter((timer) => timer.delay !== 1000).length, 0);

  child.emit('exit', 1);
  const result = await runPromise;
  assert.equal(result.exitCode, 1);
});

test('isScanPerformanceConfig limits managed scan launch to the scan config', () => {
  assert.equal(
    _private.isScanPerformanceConfig(['test', '-c', 'playwright.scan-performance.config.cjs']),
    true,
  );
  assert.equal(
    _private.isScanPerformanceConfig(['test', '-c', 'playwright.performance.config.cjs']),
    false,
  );
});

test('startManagedScanApp launches Python directly and waits for injected readiness', async () => {
  const child = createFakeChildProcess(5151);
  const calls = [];
  let probes = 0;

  const started = await _private.startManagedScanApp({
    PLAYWRIGHT_PYTHON: 'python-test.exe',
    PLAYWRIGHT_PORT: '4317',
  }, {
    spawnFn(command, args, options) {
      calls.push({ command, args, options });
      return child;
    },
    probeHttpStatusReadyFn: async (url) => {
      probes += 1;
      assert.equal(url, 'http://127.0.0.1:4317/status');
      return probes === 2;
    },
    sleepFn: async () => {},
    nowFn: (() => {
      let now = 0;
      return () => now++;
    })(),
    timeoutMs: 50,
    stdout: { write() {} },
    stderr: { write() {} },
  });

  assert.equal(started, child);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'python-test.exe');
  assert.deepEqual(calls[0].args, [
    _private.SCAN_PERFORMANCE_APP_PATH,
    '--port',
    '4317',
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.env[_private.MANAGED_SCAN_APP_ENV], '1');
  assert.match(
    calls[0].options.env[_private.SCAN_STATUS_SAMPLES_ENV],
    /playwright-scan-status[\\/]direct-port-4317\.jsonl$/,
  );
  assert.equal(probes, 2);
});

test('startManagedScanApp preserves an explicit performance-runner samples path', async () => {
  const child = createFakeChildProcess(5152);
  let spawnOptions;

  await _private.startManagedScanApp({
    PLAYWRIGHT_PYTHON: 'python-test.exe',
    PLAYWRIGHT_PORT: '4318',
    ALBUM_HAVEN_SCAN_STATUS_SAMPLES_PATH: 'C:\\managed\\attempt.jsonl',
  }, {
    spawnFn(_command, _args, options) {
      spawnOptions = options;
      return child;
    },
    probeHttpStatusReadyFn: async (url) => {
      assert.equal(url, 'http://127.0.0.1:4318/status');
      return true;
    },
    stdout: { write() {} },
    stderr: { write() {} },
  });

  assert.equal(
    spawnOptions.env.ALBUM_HAVEN_SCAN_STATUS_SAMPLES_PATH,
    'C:\\managed\\attempt.jsonl',
  );
});

test('waitForManagedScanAppReady rejects an app that exits before binding', async () => {
  const child = createFakeChildProcess(5252);
  child.exitCode = 7;

  await assert.rejects(
    _private.waitForManagedScanAppReady(child, 4318, {
      probePortListeningFn: async () => false,
    }),
    /exited before readiness with code 7/,
  );
});

test('waitForManagedScanAppReady ignores a listening port until the status endpoint is ready', async () => {
  const child = createFakeChildProcess(5253);
  let portProbes = 0;
  let statusProbes = 0;

  await _private.waitForManagedScanAppReady(child, 4318, {
    probePortListeningFn: async () => {
      portProbes += 1;
      return true;
    },
    probeHttpStatusReadyFn: async (url) => {
      statusProbes += 1;
      assert.equal(url, 'http://127.0.0.1:4318/status');
      return statusProbes === 2;
    },
    sleepFn: async () => {},
    nowFn: (() => {
      let now = 0;
      return () => now++;
    })(),
    timeoutMs: 50,
  });

  assert.equal(statusProbes, 2);
  assert.equal(portProbes, 0);
});

test('stopManagedScanApp uses injected process-tree teardown and waits for port reuse', async () => {
  const child = createFakeChildProcess(5353);
  const stopped = [];
  const waited = [];

  await _private.stopManagedScanApp(child, 4319, {
    stopProcessTreeFn(pid) {
      stopped.push(pid);
    },
    waitForPortReleasedFn: async (port, options) => {
      waited.push({ port, options });
      return true;
    },
  });

  assert.deepEqual(stopped, [5353]);
  assert.equal(waited.length, 1);
  assert.equal(waited[0].port, 4319);
  assert.equal(waited[0].options.timeoutMs, _private.MANAGED_SUPPORT_APP_PORT_REUSE_TIMEOUT_MS);
});

test('startManagedIsolatedApp launches Python directly with safe managed env and waits for status', async () => {
  const child = createFakeChildProcess(5454);
  const calls = [];
  const probes = [];

  const started = await _private.startManagedIsolatedApp({
    PLAYWRIGHT_PYTHON: 'python-test.exe',
    PLAYWRIGHT_PORT: '4320',
    PLAYWRIGHT_PROVIDER_PORT: '4322',
    LASTFM_API_KEY: 'must-not-leak',
  }, {
    spawnFn(command, args, options) {
      calls.push({ command, args, options });
      return child;
    },
    readProcessCreationIdentityFn(pid) {
      assert.equal(pid, 5454);
      return 'python-start';
    },
    probeHttpStatusReadyFn: async (url) => {
      probes.push(url);
      return true;
    },
    stdout: { write() {} },
    stderr: { write() {} },
  });

  assert.equal(started, child);
  assert.equal(child.albumHavenCreationIdentity, 'python-start');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'python-test.exe');
  assert.deepEqual(calls[0].args, [
    _private.ISOLATED_LIBRARY_APP_PATH,
    '--port',
    '4320',
    '--provider-port',
    '4322',
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.env[_private.MANAGED_ISOLATED_APP_ENV], '1');
  assert.equal(calls[0].options.env.LASTFM_API_KEY, '');
  assert.equal(
    calls[0].options.env.ALBUM_HAVEN_FAKE_E2E_PROVIDER_BASE_URL,
    'http://127.0.0.1:4322',
  );
  assert.deepEqual(probes, ['http://127.0.0.1:4320/status']);
});

test('non-album rescans and sparse metadata scans seed all unrelated functional cover misses', () => {
  assert.equal(
    _private.shouldSeedAllFunctionalCoverMisses([
      '--config=playwright.non-album-rescan.config.js',
    ]),
    true,
  );
  assert.equal(
    _private.shouldSeedAllFunctionalCoverMisses([
      'tests/e2e/specs/sparseTagEditReconciliation.spec.js',
      '--config=playwright.config.js',
    ]),
    true,
  );
  for (const config of [
    'playwright.config.js',
    'playwright.cover-rescan.config.js',
    'playwright.lastfm-auto-timezone.config.js',
    'playwright.autoplay-allowed.config.js',
  ]) {
    assert.equal(
      _private.shouldSeedAllFunctionalCoverMisses([`--config=${config}`]),
      false,
      `${config} must preserve the provider-scenario cover contract`,
    );
  }
});

test('non-album rescan startup seeds provider-scenario cover misses before launching the app', async () => {
  const child = createFakeChildProcess(5456);
  const calls = [];

  await _private.startManagedIsolatedApp({
    PLAYWRIGHT_PYTHON: 'python-test.exe',
    PLAYWRIGHT_PORT: '4320',
    PLAYWRIGHT_PROVIDER_PORT: '4322',
  }, {
    seedAllFunctionalCoverMisses: true,
    spawnFn(command, args, options) {
      calls.push({ command, args, options });
      return child;
    },
    readProcessCreationIdentityFn() {
      return 'python-non-album-rescan-start';
    },
    probeHttpStatusReadyFn: async () => true,
    stdout: { write() {} },
    stderr: { write() {} },
  });

  assert.deepEqual(calls[0].args, [
    _private.ISOLATED_LIBRARY_APP_PATH,
    '--port',
    '4320',
    '--provider-port',
    '4322',
    '--seed-all-functional-cover-misses',
  ]);
});

test('functional-core app startup completes shared gallery, cover, and utility warmup before Playwright', async () => {
  const child = createFakeChildProcess(5455);
  const startupEvents = [];

  const started = await _private.startManagedIsolatedApp({
    PLAYWRIGHT_PYTHON: 'python-test.exe',
    PLAYWRIGHT_PORT: '4324',
    PLAYWRIGHT_PROVIDER_PORT: '4326',
    ALBUM_HAVEN_FIXTURE_PROFILE: 'functional-core',
  }, {
    spawnFn() {
      return child;
    },
    readProcessCreationIdentityFn() {
      return 'python-functional-start';
    },
    probeHttpStatusReadyFn: async () => true,
    prewarmFunctionalFixtureFn: async (port, options) => {
      startupEvents.push({ stage: 'warmup', port, options });
      return true;
    },
    waitForFunctionalFixtureBackgroundIdleFn: async (managedChild, port) => {
      startupEvents.push({ stage: 'background-idle', managedChild, port });
    },
    stdout: { write() {} },
    stderr: { write() {} },
  });

  assert.equal(started, child);
  assert.equal(startupEvents.length, 2);
  assert.equal(startupEvents[0].stage, 'warmup');
  assert.equal(startupEvents[0].port, 4324);
  assert.deepEqual(startupEvents[0].options, {
    fetchHttpResponseCompleteFn: undefined,
    mediaRoot: undefined,
  });
  assert.deepEqual(startupEvents[1], {
    stage: 'background-idle',
    managedChild: child,
    port: 4324,
  });
});

test('functional fixture startup waits for a stable idle production status before Playwright', async () => {
  const child = createFakeChildProcess(5456);
  const responses = [
    { scan_in_progress: false, relations_in_progress: false, covers_in_progress: true },
    {
      scan_in_progress: false,
      relations_in_progress: false,
      covers_in_progress: false,
      pending_cover_refresh_after_scan: true,
    },
    {
      scan_in_progress: false,
      relations_in_progress: false,
      covers_in_progress: false,
      pending_cover_refresh_after_scan: false,
    },
    {
      scan_in_progress: false,
      relations_in_progress: false,
      covers_in_progress: false,
      pending_cover_refresh_after_scan: false,
    },
  ];
  const requests = [];
  let now = 0;

  await _private.waitForFunctionalFixtureBackgroundIdle(child, 4324, {
    fetchHttpResponseCompleteFn: async (url) => {
      requests.push(url);
      return { ok: true, body: JSON.stringify(responses.shift()) };
    },
    nowFn: () => now,
    sleepFn: async (milliseconds) => {
      now += milliseconds;
    },
    pollIntervalMs: 10,
    stablePollCount: 2,
    timeoutMs: 100,
  });

  assert.deepEqual(requests, Array(4).fill('http://127.0.0.1:4324/status'));
});

test('functional fixture warmup derives only fixture-owned cover previews from the real gallery payload', async () => {
  const requests = [];
  const mediaRoot = path.join(os.tmpdir(), 'album-haven-functional-media');
  const firstCover = path.join(mediaRoot, 'covers', 'fixture-one.jpg');
  const secondCover = path.join(mediaRoot, 'covers', 'fixture-two.jpg');
  const warmed = await _private.prewarmFunctionalFixture(4324, {
    mediaRoot,
    fetchHttpResponseCompleteFn: async (url) => {
      requests.push(url);
      if (requests.length === 1) {
        return { ok: true, body: '<!doctype html>' };
      }
      if (requests.length === 2) {
        return {
          ok: true,
          body: JSON.stringify({
            albums: [
              { cover_path: firstCover },
              { cover_path: firstCover },
              { cover_path: secondCover },
              { cover_path: path.join(os.tmpdir(), 'owner-music', 'cover.jpg') },
            ],
          }),
        };
      }
      return { ok: true, body: '' };
    },
  });

  assert.equal(warmed, true);
  const firstUrl = new URL('/cover', 'http://127.0.0.1:4324');
  firstUrl.searchParams.set('path', firstCover);
  firstUrl.searchParams.set('size', '480');
  const secondUrl = new URL('/cover', 'http://127.0.0.1:4324');
  secondUrl.searchParams.set('path', secondCover);
  secondUrl.searchParams.set('size', '480');
  assert.deepEqual(requests, [
    'http://127.0.0.1:4324/?surface=albums',
    'http://127.0.0.1:4324/view-data?surface=albums&omit_sidebar=1',
    firstUrl.toString(),
    secondUrl.toString(),
    'http://127.0.0.1:4324/utilities/problematic-files',
    'http://127.0.0.1:4324/utilities/rules',
  ]);
});

test('waitForManagedIsolatedAppReady rejects an app that exits before status readiness', async () => {
  const child = createFakeChildProcess(5555);
  child.exitCode = 9;

  await assert.rejects(
    _private.waitForManagedIsolatedAppReady(child, 4321, {
      probeHttpStatusReadyFn: async () => false,
    }),
    /exited before readiness with code 9/,
  );
});

test('managed isolated spawn is handed to the outer owner before identity capture', async () => {
  const child = createFakeChildProcess(5556);
  const events = [];
  let handedChild = null;
  await assert.rejects(_private.startManagedIsolatedApp({
    PLAYWRIGHT_PYTHON: 'python-test.exe',
  }, {
    port: 4327,
    providerPort: 4329,
    spawnFn() {
      events.push('spawn');
      return child;
    },
    onSpawnFn(spawnedChild) {
      events.push('handoff');
      handedChild = spawnedChild;
    },
    readProcessCreationIdentityFn() {
      events.push('identity');
      throw new Error('identity capture failed');
    },
    stdout: { write() {} },
    stderr: { write() {} },
  }), /identity capture failed/);

  assert.equal(handedChild, child);
  assert.deepEqual(events, ['spawn', 'handoff', 'identity']);
});

test('managed isolated identity-capture failure aborts a direct spawned child and waits for both ports', async () => {
  const child = createFakeChildProcess(5557);
  const killedWith = [];
  const waitedPorts = [];
  child.kill = (signal) => {
    killedWith.push(signal);
    child.exitCode = 1;
    child.emit('exit', 1);
  };

  await assert.rejects(_private.startManagedIsolatedApp({
    PLAYWRIGHT_PYTHON: 'python-test.exe',
  }, {
    port: 4330,
    providerPort: 4332,
    spawnFn() { return child; },
    readProcessCreationIdentityFn() { return ''; },
    waitForPortReleasedFn: async (port) => {
      waitedPorts.push(port);
      return true;
    },
    stdout: { write() {} },
    stderr: { write() {} },
  }), /no creation identity/);

  assert.deepEqual(killedWith, ['SIGKILL']);
  assert.deepEqual(waitedPorts, [4330, 4332]);
});

test('stopManagedIsolatedApp refuses PID reuse without stopping the replacement process', async () => {
  const child = createFakeChildProcess(5656);
  child.albumHavenCreationIdentity = 'original-python';
  let stopCalls = 0;

  await assert.rejects(
    _private.stopManagedIsolatedApp(child, [4322, 4324], {
      readProcessCreationIdentityFn() {
        return 'replacement-process';
      },
      stopProcessTreeFn() {
        stopCalls += 1;
      },
    }),
    /changed creation identity/,
  );
  assert.equal(stopCalls, 0);
});

test('stopManagedIsolatedApp uses bind-only port checks after verified process-tree exit', async (t) => {
  const child = createFakeChildProcess(5657);
  child.albumHavenCreationIdentity = 'original-python';
  const stopped = [];
  const waitedForExit = [];
  const checkedPorts = [];
  const originalDateNow = Date.now;
  let currentTimeMs = 0;
  Date.now = () => currentTimeMs;
  t.after(() => {
    Date.now = originalDateNow;
  });

  await assert.rejects(
    _private.stopManagedIsolatedApp(child, [4322, 4324], {
      readProcessCreationIdentityFn() {
        return 'original-python';
      },
      stopProcessTreeFn(pid, options) {
        stopped.push({ pid, options });
      },
      async waitForReclaimedProcessesExitedFn(owners) {
        waitedForExit.push(owners);
      },
      async waitForPortReleasedFn(port, options) {
        checkedPorts.push({
          port,
          ownerProbeResult: options.readPortOwningProcessesFn(),
        });
        currentTimeMs = 0;
        return _private.waitForPortReleased(port, {
          ...options,
          timeoutMs: 10,
          stablePollCount: 1,
          async probePortBindableFn() {
            return port === 4322;
          },
          async sleepFn() {
            currentTimeMs = 11;
          },
        });
      },
    }),
    /port 4324 was not reusable after teardown/,
  );

  assert.deepEqual(stopped, [{
    pid: 5657,
    options: { expectedCreationIdentity: 'original-python' },
  }]);
  assert.deepEqual(waitedForExit, [[{
    pid: 5657,
    creationIdentity: 'original-python',
  }]]);
  assert.deepEqual(checkedPorts, [
    { port: 4322, ownerProbeResult: [] },
    { port: 4324, ownerProbeResult: [] },
  ]);
});

test('managed isolated restart controller keeps control files under the runner-owned temp root', async () => {
  const ownedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-restart-controller-'));
  const childEnv = {
    ALBUM_HAVEN_E2E_TEMP_ROOT: ownedRoot,
    PLAYWRIGHT_PORT: '4320',
    PLAYWRIGHT_PROVIDER_PORT: '4322',
  };

  try {
    assert.equal(
      typeof _private.createManagedIsolatedAppRestartController,
      'function',
      'the runner must own a restart controller instead of asking a spec to manage app processes',
    );
    const controller = _private.createManagedIsolatedAppRestartController({
      childEnv,
      ownedIsolatedTempRoot: ownedRoot,
      initialChild: createFakeChildProcess(5660),
      ports: [4320, 4322],
      startManagedIsolatedAppFn: async () => createFakeChildProcess(5661),
      stopManagedIsolatedAppFn: async () => {},
      autoStart: false,
    });

    const controlDirectory = path.resolve(childEnv.ALBUM_HAVEN_E2E_RESTART_CONTROL_DIR);
    assert.equal(path.dirname(controlDirectory), path.resolve(ownedRoot));
    assert.equal(fs.statSync(controlDirectory).isDirectory(), true);
    assert.equal(controller.controlDirectory, controlDirectory);
    await controller.close();
  } finally {
    fs.rmSync(ownedRoot, { recursive: true, force: true });
  }
});

test('managed isolated restart request stops the old child and acknowledges only a ready replacement', async () => {
  const ownedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-restart-request-'));
  const oldChild = createFakeChildProcess(5662);
  const newChild = createFakeChildProcess(5663);
  const childEnv = {
    ALBUM_HAVEN_E2E_TEMP_ROOT: ownedRoot,
    PLAYWRIGHT_PORT: '4320',
    PLAYWRIGHT_PROVIDER_PORT: '4322',
  };
  const events = [];
  let markReplacementReady;
  const replacementReady = new Promise((resolve) => {
    markReplacementReady = resolve;
  });

  try {
    const controller = _private.createManagedIsolatedAppRestartController({
      childEnv,
      ownedIsolatedTempRoot: ownedRoot,
      initialChild: oldChild,
      ports: [4320, 4322],
      async stopManagedIsolatedAppFn(child, ports) {
        events.push(['stop', child.pid, ...ports]);
      },
      async startManagedIsolatedAppFn(activeEnv, options) {
        events.push(['start', options.port, options.providerPort]);
        assert.equal(activeEnv.ALBUM_HAVEN_E2E_REUSE_STATE, '1');
        assert.equal(activeEnv.ALBUM_HAVEN_E2E_PRESERVE_ON_SHUTDOWN, '1');
        options.onSpawnFn(newChild);
        await replacementReady;
        events.push(['ready', newChild.pid]);
        return newChild;
      },
      autoStart: false,
    });
    const nonce = 'cover-authority-restart-1';
    fs.writeFileSync(
      path.join(controller.controlDirectory, 'restart-request.json'),
      JSON.stringify({ nonce }),
      'utf8',
    );

    const restartPromise = controller.processPendingRequest();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, [
      ['stop', 5662, 4320, 4322],
      ['start', 4320, 4322],
    ]);
    assert.equal(
      fs.existsSync(path.join(controller.controlDirectory, 'restart-ack.json')),
      false,
      'an app that has spawned but is not status-ready must not be acknowledged',
    );

    markReplacementReady();
    await restartPromise;
    assert.deepEqual(events, [
      ['stop', 5662, 4320, 4322],
      ['start', 4320, 4322],
      ['ready', 5663],
    ]);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(controller.controlDirectory, 'restart-ack.json'), 'utf8')),
      { nonce, status: 'ready' },
    );
    assert.equal(controller.getCurrentChild(), newChild);
    await controller.close();
  } finally {
    fs.rmSync(ownedRoot, { recursive: true, force: true });
  }
});

test('managed isolated restart failure is fail-closed and retains the spawned child for final cleanup', async () => {
  const ownedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-restart-failure-'));
  const oldChild = createFakeChildProcess(5664);
  const failedReplacement = createFakeChildProcess(5665);
  const childEnv = {
    ALBUM_HAVEN_E2E_TEMP_ROOT: ownedRoot,
    PLAYWRIGHT_PORT: '4320',
    PLAYWRIGHT_PROVIDER_PORT: '4322',
  };

  try {
    const controller = _private.createManagedIsolatedAppRestartController({
      childEnv,
      ownedIsolatedTempRoot: ownedRoot,
      initialChild: oldChild,
      ports: [4320, 4322],
      stopManagedIsolatedAppFn: async () => {},
      async startManagedIsolatedAppFn(_activeEnv, options) {
        options.onSpawnFn(failedReplacement);
        throw new Error('replacement status readiness failed');
      },
      autoStart: false,
    });
    const nonce = 'cover-authority-restart-failure';
    fs.writeFileSync(
      path.join(controller.controlDirectory, 'restart-request.json'),
      JSON.stringify({ nonce }),
      'utf8',
    );

    await assert.rejects(
      controller.processPendingRequest(),
      /replacement status readiness failed/,
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(
        path.join(controller.controlDirectory, 'restart-ack.json'),
        'utf8',
      )),
      {
        nonce,
        status: 'failed',
        phase: 'start-replacement',
        error: 'replacement status readiness failed',
      },
      'a failed restart must publish a concise nonce-matched acknowledgment',
    );
    assert.equal(controller.getCurrentChild(), failedReplacement);
    assert.match(String(controller.getFailure()?.message || ''), /replacement status readiness failed/);
    await controller.close();
  } finally {
    fs.rmSync(ownedRoot, { recursive: true, force: true });
  }
});

test('managed isolated child lifecycle latches an unexpected initial exit once with generation details', async () => {
  const ownedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-child-lifecycle-initial-'));
  const initialChild = createFakeChildProcess(5666, { autoCloseOnExit: false });

  try {
    const controller = _private.createManagedIsolatedAppRestartController({
      childEnv: {},
      ownedIsolatedTempRoot: ownedRoot,
      initialChild,
      ports: [4320, 4322],
      autoStart: false,
    });

    initialChild.emit('exit', 0, null);
    initialChild.emit('close', 0, null);

    const failure = controller.getFailure();
    assert.equal(failure?.code, 'MANAGED_ISOLATED_APP_UNEXPECTED_EXIT');
    assert.match(String(failure?.message || ''), /managed isolated app.*unexpectedly exited/i);
    const exitDetails = failure?.lifecycle?.managedIsolatedAppExit;
    assert.deepEqual({
      generation: exitDetails?.generation,
      pid: exitDetails?.pid,
      creationIdentity: exitDetails?.creationIdentity,
      event: exitDetails?.event,
      exitCode: exitDetails?.exitCode,
      signal: exitDetails?.signal,
      phase: exitDetails?.phase,
    }, {
      generation: 1,
      pid: 5666,
      creationIdentity: null,
      event: 'exit',
      exitCode: 0,
      signal: null,
      phase: 'playwright-run',
    });
    assert.equal(typeof exitDetails?.timestamp, 'string');
    assert.notEqual(exitDetails.timestamp.trim(), '');
    assert.equal(Number.isNaN(Date.parse(exitDetails.timestamp)), false);
    assert.equal(failure?.lifecycle?.exitReason, 'managed-isolated-app-unexpected-exit');
    await controller.close();
  } finally {
    fs.rmSync(ownedRoot, { recursive: true, force: true });
  }
});

test('managed isolated child lifecycle cancels a pending Playwright run before rejecting the attempt', async () => {
  const ownedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-child-lifecycle-fast-fail-'));
  const initialChild = createFakeChildProcess(5667, { autoCloseOnExit: false });
  const events = [];
  let rejectPlaywrightRun;
  const playwrightRun = new Promise((_resolve, reject) => {
    rejectPlaywrightRun = reject;
  });

  try {
    const attemptPromise = _private.runManagedPlaywrightAttempt({
      passthroughArgv: ['test'], childEnv: {}, runTimeoutMs: 1000,
      managesScanApp: false, managesIsolatedApp: true, servesRealApp: false,
      supportAppPort: 4320, realAppPort: 5001,
      isolatedAppPort: 4320, isolatedProviderPort: 4322,
      managedPorts: [4320, 4322], ownedIsolatedTempRoot: ownedRoot,
      isHeadless: true, browserName: 'chromium',
      async startManagedIsolatedAppFn() { return initialChild; },
      async runPlaywrightProcessFn(_argv, _env, _timeoutMs, runOptions) {
        runOptions.signal.addEventListener('abort', () => {
          events.push('playwright-cancelled');
          rejectPlaywrightRun(runOptions.signal.reason);
        }, { once: true });
        return playwrightRun;
      },
      async stopManagedIsolatedAppFn() {},
      cleanupIsolatedLibraryDatabaseFn() {},
      cleanupIsolatedE2ETempRootsFn() { return []; },
      reportManagedPortOwnersFn() { return []; },
    });
    await new Promise((resolve) => setImmediate(resolve));
    initialChild.emit('exit', 0, null);
    initialChild.emit('close', 0, null);

    let attemptError = null;
    try {
      await attemptPromise;
    } catch (error) {
      events.push('attempt-rejected');
      attemptError = error;
    }
    assert.deepEqual(events, ['playwright-cancelled', 'attempt-rejected']);
    assert.equal(attemptError?.code, 'MANAGED_ISOLATED_APP_UNEXPECTED_EXIT');
    assert.equal(
      attemptError?.lifecycle?.exitReason,
      'managed-isolated-app-unexpected-exit',
    );
  } finally {
    rejectPlaywrightRun?.(new Error('test cleanup'));
    fs.rmSync(ownedRoot, { recursive: true, force: true });
  }
});

test('managed isolated app failure cancels and settles Playwright before cleanup begins', async () => {
  const ownedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-child-lifecycle-cancel-'));
  const initialChild = createFakeChildProcess(5677, { autoCloseOnExit: false });
  const events = [];
  let finishPlaywrightRun;
  const playwrightRun = new Promise((resolve) => {
    finishPlaywrightRun = resolve;
  });

  try {
    const attemptPromise = _private.runManagedPlaywrightAttempt({
      passthroughArgv: ['test'], childEnv: {}, runTimeoutMs: 1000,
      managesScanApp: false, managesIsolatedApp: true, servesRealApp: false,
      supportAppPort: 4320, realAppPort: 5001,
      isolatedAppPort: 4320, isolatedProviderPort: 4322,
      managedPorts: [4320, 4322], ownedIsolatedTempRoot: ownedRoot,
      isHeadless: true, browserName: 'chromium',
      async startManagedIsolatedAppFn() { return initialChild; },
      async runPlaywrightProcessFn(_argv, _env, _timeoutMs, runOptions) {
        events.push('playwright-started');
        if (runOptions?.signal) {
          runOptions.signal.addEventListener('abort', () => {
            events.push(`playwright-cancelled:${runOptions.signal.reason?.code}`);
            setImmediate(() => {
              events.push('playwright-settled');
              finishPlaywrightRun({ exitCode: 1, lifecycle: {} });
            });
          }, { once: true });
        }
        return playwrightRun;
      },
      async stopManagedIsolatedAppFn() { events.push('managed-app-cleanup'); },
      cleanupIsolatedLibraryDatabaseFn() { events.push('database-cleanup'); },
      cleanupIsolatedE2ETempRootsFn() {
        events.push('temp-cleanup');
        return [];
      },
      reportManagedPortOwnersFn() { return []; },
    });
    await new Promise((resolve) => setImmediate(resolve));
    initialChild.emit('exit', 0, null);
    initialChild.emit('close', 0, null);

    await assert.rejects(attemptPromise, {
      code: 'MANAGED_ISOLATED_APP_UNEXPECTED_EXIT',
    });
    assert.deepEqual(events, [
      'playwright-started',
      'playwright-cancelled:MANAGED_ISOLATED_APP_UNEXPECTED_EXIT',
      'playwright-settled',
      'managed-app-cleanup',
      'database-cleanup',
      'temp-cleanup',
    ]);
  } finally {
    finishPlaywrightRun?.({ exitCode: 1, lifecycle: {} });
    fs.rmSync(ownedRoot, { recursive: true, force: true });
  }
});

test('managed isolated child lifecycle ignores the controller-owned stop during restart', async () => {
  const ownedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-child-lifecycle-restart-stop-'));
  const initialChild = createFakeChildProcess(5668, { autoCloseOnExit: false });
  const replacementChild = createFakeChildProcess(5669, { autoCloseOnExit: false });

  try {
    const controller = _private.createManagedIsolatedAppRestartController({
      childEnv: {},
      ownedIsolatedTempRoot: ownedRoot,
      initialChild,
      ports: [4320, 4322],
      async stopManagedIsolatedAppFn(child) {
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      },
      async startManagedIsolatedAppFn(_env, options) {
        options.onSpawnFn(replacementChild);
        return replacementChild;
      },
      autoStart: false,
    });
    fs.writeFileSync(
      path.join(controller.controlDirectory, 'restart-request.json'),
      JSON.stringify({ nonce: 'intentional-restart-stop' }),
      'utf8',
    );

    await controller.processPendingRequest();

    assert.equal(controller.getFailure(), null);
    assert.equal(controller.getCurrentChild(), replacementChild);
    await controller.close();
  } finally {
    fs.rmSync(ownedRoot, { recursive: true, force: true });
  }
});

test('managed isolated child lifecycle latches an unexpected replacement close with its generation', async () => {
  const ownedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-child-lifecycle-replacement-'));
  const initialChild = createFakeChildProcess(5670, { autoCloseOnExit: false });
  const replacementChild = createFakeChildProcess(5671, { autoCloseOnExit: false });

  try {
    const controller = _private.createManagedIsolatedAppRestartController({
      childEnv: {},
      ownedIsolatedTempRoot: ownedRoot,
      initialChild,
      ports: [4320, 4322],
      async stopManagedIsolatedAppFn() {},
      async startManagedIsolatedAppFn(_env, options) {
        options.onSpawnFn(replacementChild);
        return replacementChild;
      },
      autoStart: false,
    });
    fs.writeFileSync(
      path.join(controller.controlDirectory, 'restart-request.json'),
      JSON.stringify({ nonce: 'replacement-exit-generation' }),
      'utf8',
    );
    await controller.processPendingRequest();

    replacementChild.emit('close', null, 'SIGTERM');

    const failure = controller.getFailure();
    assert.equal(failure?.code, 'MANAGED_ISOLATED_APP_UNEXPECTED_EXIT');
    const exitDetails = failure?.lifecycle?.managedIsolatedAppExit;
    assert.deepEqual({
      generation: exitDetails?.generation,
      pid: exitDetails?.pid,
      creationIdentity: exitDetails?.creationIdentity,
      event: exitDetails?.event,
      exitCode: exitDetails?.exitCode,
      signal: exitDetails?.signal,
      phase: exitDetails?.phase,
    }, {
      generation: 2,
      pid: 5671,
      creationIdentity: null,
      event: 'close',
      exitCode: null,
      signal: 'SIGTERM',
      phase: 'playwright-run',
    });
    assert.equal(typeof exitDetails?.timestamp, 'string');
    assert.notEqual(exitDetails.timestamp.trim(), '');
    assert.equal(Number.isNaN(Date.parse(exitDetails.timestamp)), false);
    await controller.close();
  } finally {
    fs.rmSync(ownedRoot, { recursive: true, force: true });
  }
});

test('managed isolated child lifecycle ignores the final cleanup stop', async () => {
  const ownedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-child-lifecycle-final-stop-'));
  const child = createFakeChildProcess(5672, { autoCloseOnExit: false });

  try {
    const result = await _private.runManagedPlaywrightAttempt({
      passthroughArgv: ['test'], childEnv: {}, runTimeoutMs: 1000,
      managesScanApp: false, managesIsolatedApp: true, servesRealApp: false,
      supportAppPort: 4320, realAppPort: 5001,
      isolatedAppPort: 4320, isolatedProviderPort: 4322,
      managedPorts: [4320, 4322], ownedIsolatedTempRoot: ownedRoot,
      isHeadless: true, browserName: 'chromium',
      async startManagedIsolatedAppFn() { return child; },
      async runPlaywrightProcessFn() {
        return { exitCode: 0, lifecycle: { exitReason: 'authoritative-pass' } };
      },
      async stopManagedIsolatedAppFn(stoppedChild) {
        stoppedChild.emit('exit', 0, null);
        stoppedChild.emit('close', 0, null);
      },
      cleanupIsolatedLibraryDatabaseFn() {},
      cleanupIsolatedE2ETempRootsFn() { return []; },
      reportManagedPortOwnersFn() { return []; },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.lifecycle.exitReason, 'authoritative-pass');
    assert.equal(result.lifecycle.managedAttempt.isolatedAppCleanup.status, 'completed');
  } finally {
    fs.rmSync(ownedRoot, { recursive: true, force: true });
  }
});

test('managed isolated attempt final cleanup follows the child replaced by the restart controller', async () => {
  const initialChild = createFakeChildProcess(5666);
  const replacementChild = createFakeChildProcess(5667);
  const stopped = [];

  await _private.runManagedPlaywrightAttempt({
    passthroughArgv: ['test'], childEnv: {}, runTimeoutMs: 1000,
    managesScanApp: false, managesIsolatedApp: true, servesRealApp: false,
    supportAppPort: 4320, realAppPort: 5001,
    isolatedAppPort: 4320, isolatedProviderPort: 4322,
    managedPorts: [4320, 4322], ownedIsolatedTempRoot: '',
    isHeadless: true, browserName: 'chromium',
    async startManagedIsolatedAppFn() { return initialChild; },
    createManagedIsolatedAppRestartControllerFn({ onCurrentChildChanged }) {
      onCurrentChildChanged(replacementChild);
      return {
        getCurrentChild() { return replacementChild; },
        getFailure() { return null; },
        async close() {},
      };
    },
    async runPlaywrightProcessFn() {
      return {
        exitCode: 0,
        lifecycle: {
          authoritativeResult: {
            phase: 'run-final', status: 'passed', total: 1, completed: 1,
            failed: 0, skipped: 0, errors: 0,
          },
          exitReason: 'authoritative-pass',
        },
      };
    },
    async stopManagedIsolatedAppFn(child) { stopped.push(child); },
    cleanupIsolatedLibraryDatabaseFn() {},
    cleanupIsolatedE2ETempRootsFn() { return []; },
    reportManagedPortOwnersFn() { return []; },
  });

  assert.deepEqual(stopped, [replacementChild]);
});

test('managed isolated attempt waits for run-final result before app stop and database cleanup', async () => {
  const events = [];
  const child = createFakeChildProcess(5757);
  const result = await _private.runManagedPlaywrightAttempt({
    passthroughArgv: ['test'],
    childEnv: {},
    runTimeoutMs: 1000,
    managesScanApp: false,
    managesIsolatedApp: true,
    servesRealApp: false,
    supportAppPort: 4323,
    realAppPort: 5001,
    managedPorts: [4323, 4325],
    ownedIsolatedTempRoot: '',
    isHeadless: true,
    browserName: 'chromium',
    async startManagedIsolatedAppFn(env, options) {
      events.push('app-start');
      assert.equal(env.PLAYWRIGHT_MANAGED_APP, '1');
      assert.equal(options.port, 4323);
      assert.equal(options.providerPort, 4325);
      assert.equal(typeof options.onSpawnFn, 'function');
      options.onSpawnFn(child);
      return child;
    },
    async runPlaywrightProcessFn(_argv, env) {
      events.push('run-final');
      assert.equal(env.PLAYWRIGHT_MANAGED_APP, '1');
      return {
        exitCode: 0,
        lifecycle: {
          authoritativeResult: {
            phase: 'run-final', status: 'passed', total: 1, completed: 1,
            failed: 0, skipped: 0, errors: 0,
          },
          fakeDatabaseCleanup: { status: 'not-required', error: null },
          exitReason: 'authoritative-pass',
        },
      };
    },
    async stopManagedIsolatedAppFn(stoppedChild, ports) {
      events.push('app-stop');
      assert.equal(stoppedChild, child);
      assert.deepEqual(ports, [4323, 4325]);
    },
    cleanupIsolatedLibraryDatabaseFn() {
      events.push('database-cleanup');
    },
    cleanupIsolatedE2ETempRootsFn() {
      events.push('temp-cleanup');
      return [];
    },
    reportManagedPortOwnersFn() {
      return [];
    },
  });

  assert.deepEqual(events.slice(0, 4), [
    'app-start', 'run-final', 'app-stop', 'database-cleanup',
  ]);
  assert.equal(result.lifecycle.fakeDatabaseCleanup.status, 'completed');
  assert.equal(result.lifecycle.managedAttempt.isolatedAppCleanup.status, 'completed');
});

test('managed isolated synthetic-large-library attempt uses real-app-derived ports through start and cleanup', async () => {
  const fixtureRoot = path.resolve(__dirname, '..', '..', 'test-results', 'fixture-contract');
  const selected = _private.resolveManagedIsolatedAppPorts(
    ['test', '-c', 'playwright.synthetic-large-library.config.cjs'],
    { realAppPort: 5011, supportAppPort: 4173, providerPort: 4175 },
  );
  assert.deepEqual(selected, { appPort: 5011, providerPort: 5013 });
  assert.deepEqual(
    _private.resolveManagedIsolatedAppPorts(
      ['test', '-c', 'playwright.performance.config.cjs'],
      { realAppPort: 5011, supportAppPort: 4181, providerPort: 5199 },
    ),
    { appPort: 4181, providerPort: 5199 },
  );

  const events = [];
  await _private.runManagedPlaywrightAttempt({
    passthroughArgv: ['test', '-c', 'playwright.synthetic-large-library.config.cjs'],
    childEnv: {
      ALBUM_HAVEN_APP_DATABASE_URL:
        'postgresql://album_haven_app_contract@localhost/album_haven_ci_contract',
      ALBUM_HAVEN_FAKE_E2E_DATABASE_URL:
        'postgresql://album_haven_app_contract@localhost/album_haven_ci_contract',
      ALBUM_HAVEN_FIXTURE_PROFILE: 'synthetic-large-library',
      ALBUM_HAVEN_FIXTURE_ROOT: fixtureRoot,
      ALBUM_HAVEN_MEDIA_ROOT: path.join(fixtureRoot, 'media'),
    }, runTimeoutMs: 1000, managesScanApp: false,
    managesIsolatedApp: true, servesRealApp: true,
    supportAppPort: 4173, realAppPort: 5011,
    isolatedAppPort: selected.appPort,
    isolatedProviderPort: selected.providerPort,
    managedPorts: [selected.appPort, selected.providerPort],
    ownedIsolatedTempRoot: '', isHeadless: true, browserName: 'chromium',
    async startManagedIsolatedAppFn(_env, options) {
      events.push(['start', options.port, options.providerPort]);
      return createFakeChildProcess(5758);
    },
    async runPlaywrightProcessFn() {
      return { exitCode: 1, lifecycle: {} };
    },
    async stopManagedIsolatedAppFn(_child, ports) {
      events.push(['stop', ...ports]);
    },
    cleanupIsolatedLibraryDatabaseFn() {},
    cleanupIsolatedE2ETempRootsFn() { return []; },
    reportManagedPortOwnersFn() { return []; },
  });

  assert.deepEqual(events, [
    ['start', 5011, 5013],
    ['stop', 5011, 5013],
  ]);
});

test('managed synthetic attempt rejects an unsafe database before app startup', async () => {
  const fixtureRoot = path.resolve(__dirname, '..', '..', 'test-results', 'fixture-contract');
  let startupCalls = 0;
  let tempCleanupCalls = 0;
  let tempCleanupOwnedRoots = null;
  await assert.rejects(
    _private.runManagedPlaywrightAttempt({
      passthroughArgv: ['test', '-c', 'playwright.synthetic-large-library.config.cjs'],
      childEnv: {
        ALBUM_HAVEN_APP_DATABASE_URL:
          'postgresql://album_haven_app@localhost/album_haven_fake_e2e',
        ALBUM_HAVEN_FAKE_E2E_DATABASE_URL:
          'postgresql://album_haven_app@localhost/album_haven_fake_e2e',
        ALBUM_HAVEN_FIXTURE_PROFILE: 'synthetic-large-library',
        ALBUM_HAVEN_FIXTURE_ROOT: fixtureRoot,
        ALBUM_HAVEN_MEDIA_ROOT: path.join(fixtureRoot, 'media'),
      },
      runTimeoutMs: 1000,
      managesScanApp: false,
      managesIsolatedApp: true,
      servesRealApp: false,
      supportAppPort: 4173,
      realAppPort: 5011,
      isolatedAppPort: 5011,
      isolatedProviderPort: 5013,
      ownedIsolatedTempRoot: 'owned-synthetic-temp-root',
      async startManagedIsolatedAppFn() {
        startupCalls += 1;
        return createFakeChildProcess(5759);
      },
      cleanupIsolatedE2ETempRootsFn(_tempRoot, ownedRoots) {
        tempCleanupCalls += 1;
        tempCleanupOwnedRoots = ownedRoots;
        return ownedRoots;
      },
      reportManagedPortOwnersFn() { return []; },
    }),
    /album_haven_ci_<suffix>/,
  );
  assert.equal(startupCalls, 0);
  assert.equal(tempCleanupCalls, 1);
  assert.deepEqual(tempCleanupOwnedRoots, ['owned-synthetic-temp-root']);
});

test('managed isolated attempt stops the app after a missing run-final result', async () => {
  const events = [];
  await _private.runManagedPlaywrightAttempt({
    passthroughArgv: ['test'],
    childEnv: {},
    runTimeoutMs: 1000,
    managesScanApp: false,
    managesIsolatedApp: true,
    servesRealApp: false,
    supportAppPort: 4324,
    realAppPort: 5001,
    managedPorts: [4324, 4326],
    ownedIsolatedTempRoot: '',
    isHeadless: true,
    browserName: 'chromium',
    async startManagedIsolatedAppFn() {
      events.push('app-start');
      return createFakeChildProcess(5858);
    },
    async runPlaywrightProcessFn() {
      events.push('cli-close-without-run-final');
      return { exitCode: 1, lifecycle: { exitReason: 'wrapper-child-mismatch' } };
    },
    async stopManagedIsolatedAppFn() {
      events.push('app-stop');
    },
    cleanupIsolatedLibraryDatabaseFn() {
      events.push('database-cleanup');
    },
    cleanupIsolatedE2ETempRootsFn() {
      return [];
    },
    reportManagedPortOwnersFn() {
      return [];
    },
  });

  assert.deepEqual(events, [
    'app-start', 'cli-close-without-run-final', 'app-stop', 'database-cleanup',
  ]);
});

test('managed isolated readiness failure still stops the spawned app before database cleanup', async () => {
  const events = [];
  let playwrightCalls = 0;
  await assert.rejects(_private.runManagedPlaywrightAttempt({
    passthroughArgv: ['test'],
    childEnv: {},
    runTimeoutMs: 1000,
    managesScanApp: false,
    managesIsolatedApp: true,
    servesRealApp: false,
    supportAppPort: 4326,
    realAppPort: 5001,
    managedPorts: [4326, 4328],
    ownedIsolatedTempRoot: '',
    isHeadless: true,
    browserName: 'chromium',
    async startManagedIsolatedAppFn(_env, options) {
      events.push('app-spawn');
      options.onSpawnFn(createFakeChildProcess(6060));
      throw new Error('status readiness failed');
    },
    async runPlaywrightProcessFn() {
      playwrightCalls += 1;
      return { exitCode: 0 };
    },
    async stopManagedIsolatedAppFn() {
      events.push('app-stop');
    },
    cleanupIsolatedLibraryDatabaseFn() {
      events.push('database-cleanup');
    },
    cleanupIsolatedE2ETempRootsFn() {
      events.push('temp-cleanup');
      return [];
    },
    reportManagedPortOwnersFn() {
      return [];
    },
  }), /status readiness failed/);

  assert.equal(playwrightCalls, 0);
  assert.deepEqual(events, [
    'app-spawn', 'app-stop', 'database-cleanup', 'temp-cleanup',
  ]);
});

test('managed isolated cleanup and database failures fail the attempt closed', async () => {
  const common = {
    passthroughArgv: ['test'], childEnv: {}, runTimeoutMs: 1000,
    managesScanApp: false, managesIsolatedApp: true, servesRealApp: false,
    supportAppPort: 4325, realAppPort: 5001, managedPorts: [4325, 4327],
    ownedIsolatedTempRoot: '', isHeadless: true, browserName: 'chromium',
    async startManagedIsolatedAppFn() { return createFakeChildProcess(5959); },
    async runPlaywrightProcessFn() { return { exitCode: 1, lifecycle: {} }; },
    cleanupIsolatedE2ETempRootsFn() { return []; },
    reportManagedPortOwnersFn() { return []; },
  };
  let databaseCleanupCalls = 0;
  await assert.rejects(_private.runManagedPlaywrightAttempt({
    ...common,
    async stopManagedIsolatedAppFn() { throw new Error('port still owned'); },
    cleanupIsolatedLibraryDatabaseFn() { databaseCleanupCalls += 1; },
  }), /port still owned/);
  assert.equal(databaseCleanupCalls, 0);

  await assert.rejects(_private.runManagedPlaywrightAttempt({
    ...common,
    async stopManagedIsolatedAppFn() {},
    cleanupIsolatedLibraryDatabaseFn() { throw new Error('database cleanup failed'); },
  }), (error) => {
    assert.match(error.message, /database cleanup failed/);
    assert.equal(error.lifecycle.fakeDatabaseCleanup.status, 'failed');
    assert.deepEqual(error.lifecycle.fakeDatabaseCleanup.error, { name: 'Error' });
    assert.equal(error.lifecycle.exitReason, 'fake-database-cleanup-error');
    return true;
  });
});

test('runPlaywrightProcess prevents inherited report auto-open without changing headed mode', async () => {
  const child = createFakeChildProcess();
  let spawnedCommand;
  let spawnedArgs;
  let spawnOptions;
  const childEnv = {
    PLAYWRIGHT_HEADLESS: 'false',
    PLAYWRIGHT_OPEN_PERFORMANCE_REPORT: '1',
    PLAYWRIGHT_PORT: '4173',
    PLAYWRIGHT_PROVIDER_PORT: '4175',
  };

  const runPromise = _private.runPlaywrightProcess(
    ['test', 'tests/e2e/specs/sample.spec.js'],
    childEnv,
    0,
    {
      spawnFn(command, args, options) {
        spawnedCommand = command;
        spawnedArgs = args;
        spawnOptions = options;
        return child;
      },
      stdout: { write() {} },
      stderr: { write() {} },
    },
  );

  child.emit('exit', 0);
  await runPromise;

  assert.equal(spawnOptions.env.PLAYWRIGHT_OPEN_PERFORMANCE_REPORT, '0');
  assert.equal(spawnOptions.env.PLAYWRIGHT_HEADLESS, 'false');
  assert.equal(childEnv.PLAYWRIGHT_OPEN_PERFORMANCE_REPORT, '1');
  assert.equal(spawnedCommand, process.execPath);
  assert.match(spawnedArgs[0], /playwright[\\/]cli\.js$/);
  assert.notEqual(spawnOptions.shell, true);
});

test('runPlaywrightProcess invokes isolated-library cleanup-only after forced default-config termination and port release', async () => {
  const child = createFakeChildProcess();
  const timerHarness = createTimerHarness();
  const events = [];
  const cleanupCommands = [];
  const childEnv = {
    PLAYWRIGHT_PYTHON: 'python-for-test',
    PLAYWRIGHT_PORT: '4173',
    PLAYWRIGHT_PROVIDER_PORT: '4175',
  };

  const runPromise = _private.runPlaywrightProcess(
    ['test', 'tests/e2e/specs/sample.spec.js'],
    childEnv,
    1000,
    {
      spawnFn() {
        return child;
      },
      stopProcessTreeFn() {
        events.push('process.stop');
      },
      reclaimPortFn(port) {
        events.push(`port.reclaim:${port}`);
        return [];
      },
      async waitForPortReleasedFn(port) {
        events.push(`port.released:${port}`);
        return true;
      },
      cleanupIsolatedLibraryDatabaseFn(cleanupEnv) {
        events.push('database.cleanup');
        _private.cleanupIsolatedLibraryDatabase(cleanupEnv, {
          runCommandFn(command, args, options) {
            cleanupCommands.push({ command, args, options });
            return { status: 0, stdout: '', stderr: '' };
          },
        });
      },
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: { write() {} },
      stderr: { write() {} },
    },
  );

  child.stdout.emit('data', Buffer.from(`
Running 1 test using 1 worker

  ok 1 [chromium] > tests/e2e/specs/sample.spec.js:1:1 > sample test (1.0s)

  1 passed (1.1s)
${PASS_FINAL_RESULT}
`));

  const completionTimer = timerHarness.timers.find((timer) => timer.delay === 15000);
  assert.ok(completionTimer, 'expected the reporter completion timer to be scheduled');
  await completionTimer.fn();
  child.emit('exit', 0);

  const result = await runPromise;
  assert.equal(result.exitCode, 0);
  assert.deepEqual(events, [
    'port.reclaim:4173',
    'port.reclaim:4175',
    'database.cleanup',
  ]);
  assert.equal(cleanupCommands.length, 1);
  assert.equal(cleanupCommands[0].command, 'python-for-test');
  assert.deepEqual(cleanupCommands[0].args, [
    _private.ISOLATED_LIBRARY_APP_PATH,
    '--cleanup-only',
  ]);
  assert.equal(
    cleanupCommands[0].options.env.ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL,
    _private.DEFAULT_FAKE_E2E_SETUP_DATABASE_URL,
  );
  assert.equal(
    cleanupCommands[0].options.env.ALBUM_HAVEN_FAKE_E2E_DATABASE_URL,
    _private.DEFAULT_FAKE_E2E_RUNTIME_DATABASE_URL,
  );
});

test('runPlaywrightProcess waits for reclaimed process identities before isolated database cleanup', async () => {
  const child = createFakeChildProcess();
  const timerHarness = createTimerHarness();
  const events = [];
  let releaseOwnerWait;
  const ownerWaitPromise = new Promise((resolve) => {
    releaseOwnerWait = resolve;
  });

  const runPromise = _private.runPlaywrightProcess(
    ['test', 'tests/e2e/specs/sample.spec.js'],
    {},
    1000,
    {
      spawnFn() {
        return child;
      },
      stopProcessTreeFn() {
        events.push('process.stop');
      },
      reclaimPortFn(port) {
        events.push(`port.reclaim:${port}`);
        return [{ pid: 2468, creationIdentity: '638880000000000000' }];
      },
      async waitForPortReleasedFn(port) {
        events.push(`port.released:${port}`);
        return true;
      },
      async waitForReclaimedProcessesExitedFn(owners) {
        events.push(`process.wait:${owners.length}`);
        await ownerWaitPromise;
        events.push('process.exited');
      },
      cleanupIsolatedLibraryDatabaseFn() {
        events.push('database.cleanup');
      },
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: { write() {} },
      stderr: { write() {} },
    },
  );

  child.stdout.emit('data', Buffer.from(`
Running 1 test using 1 worker

  ok 1 [chromium] > tests/e2e/specs/sample.spec.js:1:1 > sample test (1.0s)

  1 passed (1.1s)
${PASS_FINAL_RESULT}
`));

  const completionTimer = timerHarness.timers.find((timer) => timer.delay === 15000);
  assert.ok(completionTimer, 'expected the reporter completion timer to be scheduled');
  child.emit('exit', 0);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(events.includes('database.cleanup'), false);
  assert.equal(events.includes('process.wait:2'), true);

  releaseOwnerWait();
  const result = await runPromise;
  assert.equal(result.exitCode, 0);
  assert.ok(events.indexOf('process.exited') < events.indexOf('database.cleanup'));
});

test('runPlaywrightProcess propagates reclaimed process identity wait failures before database cleanup', async () => {
  const child = createFakeChildProcess();
  const timerHarness = createTimerHarness();
  let cleanupCalls = 0;

  const runPromise = _private.runPlaywrightProcess(
    ['test', 'tests/e2e/specs/sample.spec.js'],
    {},
    1000,
    {
      spawnFn() {
        return child;
      },
      stopProcessTreeFn() {},
      reclaimPortFn() {
        return [{ pid: 2468, creationIdentity: '638880000000000000' }];
      },
      async waitForPortReleasedFn() {
        return true;
      },
      async waitForReclaimedProcessesExitedFn() {
        throw new Error('reclaimed owner identity did not exit');
      },
      cleanupIsolatedLibraryDatabaseFn() {
        cleanupCalls += 1;
      },
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: { write() {} },
      stderr: { write() {} },
    },
  );

  child.stdout.emit('data', Buffer.from(`
Running 1 test using 1 worker

  ok 1 [chromium] > tests/e2e/specs/sample.spec.js:1:1 > sample test (1.0s)

  1 passed (1.1s)
${PASS_FINAL_RESULT}
`));

  const completionTimer = timerHarness.timers.find((timer) => timer.delay === 15000);
  assert.ok(completionTimer, 'expected the reporter completion timer to be scheduled');
  completionTimer.fn();
  child.emit('exit', 0);

  await assert.rejects(runPromise, /reclaimed owner identity did not exit/);
  assert.equal(cleanupCalls, 0);
});

test('runPlaywrightProcess propagates owner snapshot failures before isolated database cleanup', async () => {
  const child = createFakeChildProcess();
  const timerHarness = createTimerHarness();
  let cleanupCalls = 0;

  const runPromise = _private.runPlaywrightProcess(
    ['test', 'tests/e2e/specs/sample.spec.js'],
    {},
    1000,
    {
      spawnFn() {
        return child;
      },
      stopProcessTreeFn() {},
      reclaimPortFn() {
        throw new Error('creation identity unavailable');
      },
      async waitForPortReleasedFn() {
        return true;
      },
      cleanupIsolatedLibraryDatabaseFn() {
        cleanupCalls += 1;
      },
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: { write() {} },
      stderr: { write() {} },
    },
  );

  child.stdout.emit('data', Buffer.from(`
Running 1 test using 1 worker

  ok 1 [chromium] > tests/e2e/specs/sample.spec.js:1:1 > sample test (1.0s)

  1 passed (1.1s)
${PASS_FINAL_RESULT}
`));

  const completionTimer = timerHarness.timers.find((timer) => timer.delay === 15000);
  assert.ok(completionTimer, 'expected the reporter completion timer to be scheduled');
  completionTimer.fn();
  child.emit('exit', 0);

  await assert.rejects(runPromise, /creation identity unavailable/);
  assert.equal(cleanupCalls, 0);
});

test('runPlaywrightProcess completes cleanup-only without a post-pass port-release barrier', async () => {
  const child = createFakeChildProcess();
  const timerHarness = createTimerHarness();
  const events = [];
  let releasePort;
  let settlement = 'pending';
  const portReleasePromise = new Promise((resolve) => {
    releasePort = resolve;
  });

  const runPromise = _private.runPlaywrightProcess(
    ['test', 'tests/e2e/specs/sample.spec.js'],
    {
      PLAYWRIGHT_PORT: '4173',
      PLAYWRIGHT_PROVIDER_PORT: '4175',
    },
    1000,
    {
      spawnFn() {
        return child;
      },
      stopProcessTreeFn() {
        events.push('process.stop');
        child.emit('exit', 0);
      },
      reclaimPortFn(port) {
        events.push(`port.reclaim:${port}`);
        return [];
      },
      waitForPortReleasedFn(port) {
        events.push(`port.wait:${port}`);
        return port === 4173 ? portReleasePromise : Promise.resolve(true);
      },
      cleanupIsolatedLibraryDatabaseFn() {
        events.push('database.cleanup.start');
        events.push('database.cleanup.complete');
      },
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: { write() {} },
      stderr: { write() {} },
    },
  );
  runPromise.then(
    () => {
      settlement = 'resolved';
      events.push('run.resolved');
    },
    () => {
      settlement = 'rejected';
      events.push('run.rejected');
    },
  );

  child.stdout.emit('data', Buffer.from(`
Running 1 test using 1 worker

  ok 1 [chromium] > tests/e2e/specs/sample.spec.js:1:1 > sample test (1.0s)

  1 passed (1.1s)
${PASS_FINAL_RESULT}
`));

  const completionTimer = timerHarness.timers.find((timer) => timer.delay === 15000);
  assert.ok(completionTimer, 'expected the reporter completion timer to be scheduled');
  completionTimer.fn();
  child.emit('exit', 0);
  await Promise.resolve();

  assert.equal(settlement, 'resolved');
  assert.deepEqual(events, [
    'port.reclaim:4173',
    'port.reclaim:4175',
    'database.cleanup.start',
    'database.cleanup.complete',
    'run.resolved',
  ]);

  const result = await runPromise;
  await Promise.resolve();

  assert.equal(result.exitCode, 0);
  assert.equal(settlement, 'resolved');
  assert.deepEqual(events, [
    'port.reclaim:4173',
    'port.reclaim:4175',
    'database.cleanup.start',
    'database.cleanup.complete',
    'run.resolved',
  ]);
});

test('runPlaywrightProcess propagates reporter cleanup-only failures after synchronous child exit', async () => {
  const child = createFakeChildProcess();
  const timerHarness = createTimerHarness();
  let releasePort;
  let settlement = 'pending';
  const portReleasePromise = new Promise((resolve) => {
    releasePort = resolve;
  });

  const runPromise = _private.runPlaywrightProcess(
    ['test', 'tests/e2e/specs/sample.spec.js'],
    {},
    1000,
    {
      spawnFn() {
        return child;
      },
      stopProcessTreeFn() {
        child.emit('exit', 0);
      },
      reclaimPortFn() {
        return [];
      },
      waitForPortReleasedFn(port) {
        return port === 4173 ? portReleasePromise : Promise.resolve(true);
      },
      cleanupIsolatedLibraryDatabaseFn() {
        throw new Error('cleanup-only failed');
      },
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: { write() {} },
      stderr: { write() {} },
    },
  );
  runPromise.then(
    () => {
      settlement = 'resolved';
    },
    () => {
      settlement = 'rejected';
    },
  );

  child.stdout.emit('data', Buffer.from(`
Running 1 test using 1 worker

  ok 1 [chromium] > tests/e2e/specs/sample.spec.js:1:1 > sample test (1.0s)

  1 passed (1.1s)
${PASS_FINAL_RESULT}
`));

  const completionTimer = timerHarness.timers.find((timer) => timer.delay === 15000);
  assert.ok(completionTimer, 'expected the reporter completion timer to be scheduled');
  completionTimer.fn();
  child.emit('exit', 0);
  await Promise.resolve();

  assert.equal(settlement, 'pending');
  releasePort(true);
  await assert.rejects(runPromise, /cleanup-only failed/);
  await Promise.resolve();
  assert.equal(settlement, 'rejected');
});

test('runPlaywrightProcess hard timeout cannot preempt immediate owned cleanup-only', async () => {
  const child = createFakeChildProcess();
  const timerHarness = createTimerHarness();
  const events = [];
  let releasePort;
  let settlement = 'pending';
  const portReleasePromise = new Promise((resolve) => {
    releasePort = resolve;
  });

  const runPromise = _private.runPlaywrightProcess(
    ['test', 'tests/e2e/specs/sample.spec.js'],
    {},
    1000,
    {
      spawnFn() {
        return child;
      },
      stopProcessTreeFn() {
        events.push('process.stop');
      },
      reclaimPortFn(port) {
        events.push(`port.reclaim:${port}`);
        return [];
      },
      waitForPortReleasedFn(port) {
        events.push(`port.wait:${port}`);
        return port === 4173 ? portReleasePromise : Promise.resolve(true);
      },
      cleanupIsolatedLibraryDatabaseFn() {
        events.push('database.cleanup');
      },
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: { write() {} },
      stderr: { write() {} },
    },
  );
  runPromise.then(
    () => {
      settlement = 'resolved';
    },
    () => {
      settlement = 'rejected';
    },
  );

  child.stdout.emit('data', Buffer.from(`
Running 1 test using 1 worker

  ok 1 [chromium] > tests/e2e/specs/sample.spec.js:1:1 > sample test (1.0s)

  1 passed (1.1s)
${PASS_FINAL_RESULT}
`));

  const completionTimer = timerHarness.timers.find((timer) => timer.delay === 15000);
  const hardTimeoutTimer = timerHarness.timers.find((timer) => timer.delay === 1000);
  assert.ok(completionTimer, 'expected the reporter completion timer to be scheduled');
  assert.ok(hardTimeoutTimer, 'expected the hard timeout timer to be scheduled');

  completionTimer.fn();
  child.emit('exit', 0);
  await Promise.resolve();
  hardTimeoutTimer.fn();
  await Promise.resolve();

  assert.equal(settlement, 'resolved');
  assert.deepEqual(events, [
    'port.reclaim:4173',
    'port.reclaim:4175',
    'database.cleanup',
  ]);

  const result = await runPromise;
  await Promise.resolve();

  assert.equal(result.exitCode, 0);
  assert.equal(settlement, 'resolved');
  assert.deepEqual(events, [
    'port.reclaim:4173',
    'port.reclaim:4175',
    'database.cleanup',
  ]);
});

test('runPlaywrightProcess retains the original hard timeout while run-final awaits natural child close', async () => {
  const child = createFakeChildProcess();
  const timerHarness = createTimerHarness();
  const events = [];
  let settlement = 'pending';

  const runPromise = _private.runPlaywrightProcess(
    ['test', 'tests/e2e/specs/sample.spec.js'],
    {},
    1000,
    {
      spawnFn() {
        return child;
      },
      stopProcessTreeFn() {
        events.push('process.stop');
      },
      reclaimPortFn(port) {
        events.push(`port.reclaim:${port}`);
        return [];
      },
      async waitForPortReleasedFn(port) {
        events.push(`port.released:${port}`);
        return true;
      },
      cleanupIsolatedLibraryDatabaseFn() {
        events.push('database.cleanup');
      },
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: { write() {} },
      stderr: { write() {} },
    },
  );
  runPromise.then(
    () => {
      settlement = 'resolved';
    },
    () => {
      settlement = 'rejected';
    },
  );

  const hardTimeoutTimer = timerHarness.timers.find((timer) => timer.delay === 1000);
  assert.ok(hardTimeoutTimer, 'expected the hard timeout timer to be scheduled');

  child.stdout.emit('data', Buffer.from(`
Running 1 test using 1 worker

  ok 1 [chromium] > tests/e2e/specs/sample.spec.js:1:1 > sample test (1.0s)

  1 passed (1.1s)
${PASS_FINAL_RESULT}
`));

  const completionTimer = timerHarness.timers.find((timer) => timer.delay === 15000);
  assert.ok(completionTimer, 'expected the reporter completion timer to be scheduled');
  assert.equal(hardTimeoutTimer.cleared, false);

  assert.equal(settlement, 'pending');
  assert.deepEqual(events, []);

  child.emit('exit', 0);
  const result = await runPromise;
  await Promise.resolve();

  assert.equal(result.exitCode, 0);
  assert.equal(settlement, 'resolved');
  assert.deepEqual(events, [
    'port.reclaim:4173',
    'port.reclaim:4175',
    'database.cleanup',
  ]);
});

test('runPlaywrightProcess hard timeout cannot hide reporter cleanup-only errors', async () => {
  const child = createFakeChildProcess();
  const timerHarness = createTimerHarness();
  let releasePort;
  let stopCalls = 0;
  const portReleasePromise = new Promise((resolve) => {
    releasePort = resolve;
  });

  const runPromise = _private.runPlaywrightProcess(
    ['test', 'tests/e2e/specs/sample.spec.js'],
    {},
    1000,
    {
      spawnFn() {
        return child;
      },
      stopProcessTreeFn() {
        stopCalls += 1;
      },
      reclaimPortFn() {
        return [];
      },
      waitForPortReleasedFn(port) {
        return port === 4173 ? portReleasePromise : Promise.resolve(true);
      },
      cleanupIsolatedLibraryDatabaseFn() {
        throw new Error('cleanup-only race failure');
      },
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: { write() {} },
      stderr: { write() {} },
    },
  );
  const rejection = assert.rejects(runPromise, /cleanup-only race failure/);

  child.stdout.emit('data', Buffer.from(`
Running 1 test using 1 worker

  ok 1 [chromium] > tests/e2e/specs/sample.spec.js:1:1 > sample test (1.0s)

  1 passed (1.1s)
${PASS_FINAL_RESULT}
`));

  const completionTimer = timerHarness.timers.find((timer) => timer.delay === 15000);
  const hardTimeoutTimer = timerHarness.timers.find((timer) => timer.delay === 1000);
  assert.ok(completionTimer, 'expected the reporter completion timer to be scheduled');
  assert.ok(hardTimeoutTimer, 'expected the hard timeout timer to be scheduled');

  completionTimer.fn();
  child.emit('exit', 0);
  await Promise.resolve();
  hardTimeoutTimer.fn();
  releasePort(true);

  await rejection;
  assert.equal(stopCalls, 0);
});

test('runPlaywrightProcess hard timeout still rejects while the child is running', async () => {
  const child = createFakeChildProcess();
  const timerHarness = createTimerHarness();
  let stopCalls = 0;

  const runPromise = _private.runPlaywrightProcess(
    ['test', 'tests/e2e/specs/sample.spec.js'],
    {},
    1000,
    {
      spawnFn() {
        return child;
      },
      stopProcessTreeFn() {
        stopCalls += 1;
      },
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: { write() {} },
      stderr: { write() {} },
    },
  );
  const rejection = assert.rejects(
    runPromise,
    /Timed out after 1000 ms while running Playwright/,
  );

  const hardTimeoutTimer = timerHarness.timers.find((timer) => timer.delay === 1000);
  assert.ok(hardTimeoutTimer, 'expected the hard timeout timer to be scheduled');
  hardTimeoutTimer.fn();

  await rejection;
  assert.equal(stopCalls, 1);
});

test('runPlaywrightProcess excludes managed real-app and nondefault configs from forced cleanup-only', async () => {
  const cases = [
    {
      name: 'managed real-app',
      argv: ['test', 'tests/e2e/specs/sample.spec.js'],
      childEnv: {
        PLAYWRIGHT_SERVE_REAL_APP: '1',
        PLAYWRIGHT_REAL_APP_PORT: '5001',
      },
    },
    {
      name: 'nondefault isolated config',
      argv: ['test', '-c', 'playwright.performance.config.cjs'],
      childEnv: {},
    },
  ];

  for (const testCase of cases) {
    const child = createFakeChildProcess();
    const timerHarness = createTimerHarness();
    let cleanupCalls = 0;
    const runPromise = _private.runPlaywrightProcess(testCase.argv, testCase.childEnv, 1000, {
      spawnFn() {
        return child;
      },
      stopProcessTreeFn() {},
      reclaimPortFn() {
        return [];
      },
      waitForPortReleasedFn: async () => true,
      cleanupIsolatedLibraryDatabaseFn() {
        cleanupCalls += 1;
      },
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: { write() {} },
      stderr: { write() {} },
    });

    child.stdout.emit('data', Buffer.from(`
Running 1 test using 1 worker

  ok 1 [chromium] > tests/e2e/specs/sample.spec.js:1:1 > sample test (1.0s)

  1 passed (1.1s)
${PASS_FINAL_RESULT}
`));

    const completionTimer = timerHarness.timers.find((timer) => (
      testCase.name === 'managed real-app' ? timer.delay > 15000 : timer.delay === 15000
    ));
    assert.ok(completionTimer, `expected a completion timer for ${testCase.name}`);
    await completionTimer.fn();
    child.emit('exit', 0);
    const result = await runPromise;

    assert.equal(result.exitCode, 0, testCase.name);
    assert.equal(cleanupCalls, 0, testCase.name);
  }
});

test('runPlaywrightProcess fails closed when a managed real-app child never exits after run-final', async () => {
  const child = createFakeChildProcess();
  const timerHarness = createTimerHarness();
  let stopCalls = 0;
  let reclaimCalls = 0;
  let waitCalls = 0;
  const stderrWrites = [];

  const runPromise = _private.runPlaywrightProcess(
    ['test', '-c', 'playwright.external-real-app.config.cjs'],
    {
      PLAYWRIGHT_SERVE_REAL_APP: '1',
      PLAYWRIGHT_REAL_APP_PORT: '5001',
      ALBUM_HAVEN_APP_DATABASE_URL: 'postgresql://album_haven_app@localhost/album_haven',
    },
    1000,
    {
      spawnFn() {
        return child;
      },
      stopProcessTreeFn() {
        stopCalls += 1;
      },
      reclaimPortFn() {
        reclaimCalls += 1;
        return [];
      },
      waitForPortReleasedFn: async () => {
        waitCalls += 1;
        return true;
      },
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: {
        write() {},
      },
      stderr: {
        write(text) { stderrWrites.push(text); },
      },
    },
  );

  child.stdout.emit('data', Buffer.from(`
Running 1 test using 1 worker

  ok 1 [synthetic-large-library] > tests/e2e/syntheticLargeLibrary/sample.spec.js:1:1 > sample test (1.0s)

  1 passed (1.1s)
${PASS_FINAL_RESULT}
`));

  const managedCompletionTimer = timerHarness.timers.find((timer) => timer.delay > 15000);
  assert.ok(managedCompletionTimer, 'expected a longer managed completion fallback timer');
  assert.equal(managedCompletionTimer.cleared, true);
  const hardTimeoutTimer = timerHarness.timers.find((timer) => timer.delay === 1000);
  assert.ok(hardTimeoutTimer, 'expected the original bounded run timeout');
  hardTimeoutTimer.fn();
  const result = await runPromise;

  assert.equal(stopCalls, 1);
  assert.equal(reclaimCalls, 1);
  assert.equal(waitCalls, 0);
  assert.equal(result.exitCode, 1);
  assert.match(stderrWrites.join(''), /"stopReason":"run-timeout-after-authoritative-final"/);
  assert.match(stderrWrites.join(''), /"cleanupOutcome":"completed"/);
});

test('runPlaywrightProcess terminates a never-closing child once when run-final cleanup fails', async () => {
  const child = createFakeChildProcess(4242, { autoCloseOnExit: false });
  const timerHarness = createTimerHarness();
  let stopCalls = 0;
  let ownerWaitCalls = 0;

  const runPromise = _private.runPlaywrightProcess(
    ['test', '-c', 'playwright.external-real-app.config.cjs'],
    {
      PLAYWRIGHT_SERVE_REAL_APP: '1',
      PLAYWRIGHT_REAL_APP_PORT: '5001',
      ALBUM_HAVEN_APP_DATABASE_URL: 'postgresql://album_haven_app@localhost/album_haven',
    },
    1000,
    {
      spawnFn() {
        return child;
      },
      stopProcessTreeFn() {
        stopCalls += 1;
      },
      reclaimPortFn() {
        return [{ pid: 2468, creationIdentity: 'owned-support-process' }];
      },
      async waitForReclaimedProcessesExitedFn() {
        ownerWaitCalls += 1;
        throw new Error('owned support cleanup failed');
      },
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: { write() {} },
      stderr: { write() {} },
    },
  );

  child.stdout.emit('data', Buffer.from(`${PASS_FINAL_RESULT}\n`));
  const hardTimeoutTimer = timerHarness.timers.find((timer) => timer.delay === 1000);
  assert.ok(hardTimeoutTimer, 'expected the original bounded run timeout');
  hardTimeoutTimer.fn();

  await assert.rejects(runPromise, /owned support cleanup failed/);
  assert.equal(ownerWaitCalls, 1);
  assert.equal(stopCalls, 1);
});

test('runPlaywrightProcess accepts non-real-app completion only after final evidence and natural exit', async () => {
  const child = createFakeChildProcess();
  const timerHarness = createTimerHarness();
  let stopCalls = 0;
  let reclaimCalls = 0;
  let waitCalls = 0;
  const waitOptions = [];
  const stderrWrites = [];

  const runPromise = _private.runPlaywrightProcess(
    ['test', '-c', 'playwright.performance.config.cjs'],
    {},
    1000,
    {
      spawnFn() {
        return child;
      },
      stopProcessTreeFn() {
        stopCalls += 1;
      },
      reclaimPortFn() {
        reclaimCalls += 1;
        return [];
      },
      waitForPortReleasedFn: async (_port, options) => {
        waitCalls += 1;
        waitOptions.push(options);
        return true;
      },
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: {
        write() {},
      },
      stderr: {
        write(text) {
          stderrWrites.push(text);
        },
      },
    },
  );

  child.stdout.emit('data', Buffer.from(`
Running 1 test using 1 worker

  ok 1 [idle-memory] > tests/e2e/performance/idleMemory.spec.js:1:1 > sample test (1.0s)

  1 passed (1.1s)
${PASS_FINAL_RESULT}
`));

  const completionTimer = timerHarness.timers.find((timer) => timer.delay === 15000);
  assert.ok(completionTimer, 'expected the reporter completion timer to be scheduled');

  await completionTimer.fn();
  child.emit('exit', 0);
  const result = await runPromise;

  assert.equal(stopCalls, 0);
  assert.equal(reclaimCalls, 2);
  assert.equal(waitCalls, 0);
  assert.deepEqual(waitOptions, []);
  assert.deepEqual(stderrWrites, []);
  assert.equal(result.exitCode, 0);
});

test('runPlaywrightProcess does not impose a post-pass exclusive port-rebinding cooldown', async () => {
  const child = createFakeChildProcess();
  const timerHarness = createTimerHarness();
  let stopCalls = 0;
  let reclaimCalls = 0;
  let waitCalls = 0;
  const waitOptions = [];
  const stderrWrites = [];

  const runPromise = _private.runPlaywrightProcess(
    ['test', '-c', 'playwright.performance.config.cjs'],
    {},
    1000,
    {
      spawnFn() {
        return child;
      },
      stopProcessTreeFn() {
        stopCalls += 1;
      },
      reclaimPortFn() {
        reclaimCalls += 1;
        return [];
      },
      waitForPortReleasedFn: async (_port, options) => {
        waitCalls += 1;
        waitOptions.push(options);
        return false;
      },
      readPortOwningProcessesFn() {
        return [];
      },
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: {
        write() {},
      },
      stderr: {
        write(text) {
          stderrWrites.push(text);
        },
      },
    },
  );

  child.stdout.emit('data', Buffer.from(`
Running 1 test using 1 worker

  ok 1 [idle-memory] > tests/e2e/performance/idleMemory.spec.js:1:1 > sample test (1.0s)

  1 passed (1.1s)
${PASS_FINAL_RESULT}
`));

  const completionTimer = timerHarness.timers.find((timer) => timer.delay === 15000);
  assert.ok(completionTimer, 'expected the reporter completion timer to be scheduled');

  await completionTimer.fn();
  child.emit('exit', 0);
  const result = await runPromise;

  assert.equal(stopCalls, 0);
  assert.equal(reclaimCalls, 2);
  assert.equal(waitCalls, 0);
  assert.deepEqual(waitOptions, []);
  assert.equal(result.exitCode, 0);
  assert.equal(stderrWrites.join(''), '');
});

test('runPlaywrightProcess never treats a later unrelated port binder as owned cleanup work', async () => {
  const child = createFakeChildProcess();
  const timerHarness = createTimerHarness();
  const reclaimOptions = [];

  const runPromise = _private.runPlaywrightProcess(
    ['test', '-c', 'playwright.performance.config.cjs'],
    {},
    1000,
    {
      spawnFn() {
        return child;
      },
      stopProcessTreeFn() {},
      reclaimPortFn(_port, options) {
        reclaimOptions.push(options);
        return [];
      },
      readProcessTreeIdentitiesFn() {
        return [{ pid: child.pid, creationIdentity: 'current-run', depth: 0 }];
      },
      waitForPortReleasedFn: async () => false,
      readPortOwningProcessesFn() {
        return [1234];
      },
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      stdout: {
        write() {},
      },
      stderr: {
        write() {},
      },
    },
  );

  child.stdout.emit('data', Buffer.from(`
Running 1 test using 1 worker

  ok 1 [idle-memory] > tests/e2e/performance/idleMemory.spec.js:1:1 > sample test (1.0s)

  1 passed (1.1s)
${PASS_FINAL_RESULT}
`));

  const completionTimer = timerHarness.timers.find((timer) => timer.delay === 15000);
  assert.ok(completionTimer, 'expected the reporter completion timer to be scheduled');

  await completionTimer.fn();
  child.emit('exit', 0);
  const result = await runPromise;
  assert.equal(result.exitCode, 0);
  assert.equal(reclaimOptions.length, 2);
  assert.deepEqual(reclaimOptions[0].allowedOwners, [{
    pid: child.pid,
    creationIdentity: 'current-run',
    depth: 0,
  }]);
});

test('top-level lifecycle leaves a later unrelated binder alive after inner settlement', async () => {
  let binderAlive = false;
  let cleanupCalls = 0;
  let destructivePortReleaseCalls = 0;
  const passivelyInspectedPorts = [];

  const result = await _private.runManagedPlaywrightAttempt({
    passthroughArgv: ['test', '-c', 'playwright.performance.config.cjs'],
    childEnv: {},
    runTimeoutMs: 1000,
    managesScanApp: false,
    servesRealApp: false,
    supportAppPort: 4173,
    realAppPort: 5001,
    managedPorts: [5001],
    ownedIsolatedTempRoot: '',
    isHeadless: true,
    browserName: 'chromium',
    async runPlaywrightProcessFn() {
      binderAlive = true;
      return { exitCode: 0 };
    },
    cleanupIsolatedE2ETempRootsFn() {
      cleanupCalls += 1;
    },
    reportManagedPortOwnersFn(port) {
      assert.equal(binderAlive, true);
      passivelyInspectedPorts.push(port);
      return [9090];
    },
    async ensurePortReleasedFn() {
      destructivePortReleaseCalls += 1;
      binderAlive = false;
      return true;
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.lifecycle.managedAttempt.tempCleanup.status, 'completed');
  assert.equal(result.lifecycle.managedAttempt.passivePortDiagnostics[0].status, 'completed');
  assert.equal(cleanupCalls, 1);
  assert.deepEqual(passivelyInspectedPorts, [5001]);
  assert.equal(destructivePortReleaseCalls, 0);
  assert.equal(binderAlive, true);
});

test('owned temp cleanup failure rejects authoritative pass while passive diagnostics remain best effort', async () => {
  const result = await _private.runManagedPlaywrightAttempt({
    passthroughArgv: ['test', '-c', 'playwright.performance.config.cjs'],
    childEnv: {},
    runTimeoutMs: 1000,
    managesScanApp: false,
    servesRealApp: false,
    supportAppPort: 4173,
    realAppPort: 5001,
    managedPorts: [5001],
    ownedIsolatedTempRoot: 'owned-temp-root',
    isHeadless: true,
    browserName: 'chromium',
    async runPlaywrightProcessFn() {
      return {
        exitCode: 0,
        lifecycle: {
          authoritativeResult: {
            status: 'passed',
            total: 1,
            completed: 1,
            failed: 0,
            skipped: 0,
            errors: 0,
          },
          exitReason: 'authoritative-pass',
        },
      };
    },
    cleanupIsolatedE2ETempRootsFn() {
      throw new Error('temp cleanup diagnostic failed');
    },
    reportManagedPortOwnersFn() {
      throw new Error('passive port diagnostic failed');
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.lifecycle.exitReason, 'owned-temp-cleanup-error');
  assert.equal(_private.hasCompletedAuthoritativePassLifecycle(result), false);
  assert.equal(result.lifecycle.managedAttempt.tempCleanup.status, 'failed');
  assert.deepEqual(result.lifecycle.managedAttempt.tempCleanup.error, { name: 'Error' });
  assert.equal(result.lifecycle.managedAttempt.passivePortDiagnostics[0].status, 'failed');
  assert.deepEqual(
    result.lifecycle.managedAttempt.passivePortDiagnostics[0].error,
    { name: 'Error' },
  );
});

test('authoritative pass cleanup rejection carries safe final-decision evidence', async () => {
  const child = createFakeChildProcess();
  const timerHarness = createTimerHarness();
  const runPromise = _private.runPlaywrightProcess(
    ['test'],
    {},
    1000,
    {
      spawnFn() {
        return child;
      },
      stopProcessTreeFn() {},
      reclaimPortFn() {
        return [];
      },
      readProcessTreeIdentitiesFn() {
        return [];
      },
      setTimeoutFn: timerHarness.setTimeoutFn,
      clearTimeoutFn: timerHarness.clearTimeoutFn,
      cleanupIsolatedLibraryDatabaseFn() {
        throw new Error('fixture database cleanup failed');
      },
      stdout: { write() {} },
      stderr: { write() {} },
    },
  );

  child.stdout.emit('data', Buffer.from(`Running 1 test using 1 worker\n1 passed (1.1s)\n${PASS_FINAL_RESULT}\n`));
  const completionTimer = timerHarness.timers.find((timer) => timer.delay === 15000);
  assert.ok(completionTimer);
  await completionTimer.fn();
  child.emit('exit', 0);

  await assert.rejects(runPromise, (error) => {
    assert.equal(error.lifecycle.authoritativeResult.status, 'passed');
    assert.equal(error.lifecycle.fakeDatabaseCleanup.status, 'failed');
    assert.deepEqual(error.lifecycle.fakeDatabaseCleanup.error, { name: 'Error' });
    assert.equal(error.lifecycle.exitReason, 'fake-database-cleanup-error');
    return true;
  });
});

test('owned scan teardown failure records all remaining cleanup evidence before failing closed', async () => {
  let tempCleanupCalls = 0;
  const passivelyInspectedPorts = [];
  await assert.rejects(
    _private.runManagedPlaywrightAttempt({
      passthroughArgv: ['test', '-c', 'playwright.scan-performance.config.cjs'],
      childEnv: {},
      runTimeoutMs: 1000,
      managesScanApp: true,
      servesRealApp: false,
      supportAppPort: 4173,
      realAppPort: 5001,
      managedPorts: [4173, 4175],
      ownedIsolatedTempRoot: 'owned-temp-root',
      isHeadless: true,
      browserName: 'chromium',
      async startManagedScanAppFn() {
        return { pid: 1234 };
      },
      async stopManagedScanAppFn() {
        throw new Error('owned scan teardown failed');
      },
      async runPlaywrightProcessFn() {
        return {
          exitCode: 0,
          lifecycle: {
            authoritativeResult: {
              phase: 'run-final',
              status: 'passed',
              total: 1,
              completed: 1,
              failed: 0,
              skipped: 0,
              errors: 0,
            },
            fakeDatabaseCleanup: { status: 'not-required', error: null },
            exitReason: 'authoritative-pass',
          },
        };
      },
      cleanupIsolatedE2ETempRootsFn() {
        tempCleanupCalls += 1;
        return ['owned-temp-root'];
      },
      reportManagedPortOwnersFn(port) {
        passivelyInspectedPorts.push(port);
        return [];
      },
    }),
    (error) => {
      assert.match(error.message, /owned scan teardown failed/);
      assert.equal(error.lifecycle.exitReason, 'managed-scan-cleanup-error');
      assert.equal(error.lifecycle.managedAttempt.scanAppCleanup.status, 'failed');
      assert.deepEqual(error.lifecycle.managedAttempt.scanAppCleanup.error, {
        name: 'Error',
      });
      assert.equal(error.lifecycle.managedAttempt.tempCleanup.status, 'completed');
      assert.equal(error.lifecycle.managedAttempt.tempCleanup.removedCount, 1);
      assert.deepEqual(
        error.lifecycle.managedAttempt.passivePortDiagnostics.map(({ port, status }) => ({ port, status })),
        [
          { port: 4173, status: 'completed' },
          { port: 4175, status: 'completed' },
        ],
      );
      return true;
    },
  );
  assert.equal(tempCleanupCalls, 1);
  assert.deepEqual(passivelyInspectedPorts, [4173, 4175]);
});

test('main final decision reports every post-pass lifecycle stage before returning nonzero', () => {
  const writes = [];
  const processObject = { exitCode: null };
  const exitCode = _private.finalizeMainResult(
    {
      exitCode: 1,
      lifecycle: {
        authoritativeResult: {
          phase: 'run-final',
          status: 'passed',
          total: 3,
          completed: 3,
          failed: 0,
          skipped: 0,
          errors: 0,
        },
        fakeDatabaseCleanup: { status: 'failed', error: { name: 'Error', code: '', message: 'cleanup failed' } },
        managedAttempt: {
          attemptReturn: { exitCode: 0, exitReason: 'authoritative-pass' },
          tempCleanup: { status: 'completed', removedCount: 1, error: null },
          passivePortDiagnostics: [
            { port: 4173, status: 'failed', ownerCount: 0, error: { name: 'Error', code: '', message: 'probe failed' } },
          ],
        },
        exitReason: 'fake-database-cleanup-error',
      },
    },
    {
      processObject,
      stderr: { write(text) { writes.push(text); } },
    },
  );

  assert.equal(exitCode, 1);
  assert.equal(processObject.exitCode, 1);
  assert.equal(writes.length, 1);
  assert.match(writes[0], /^\[playwright-wrapper-final-decision\] /);
  const payload = JSON.parse(writes[0].slice(writes[0].indexOf('{')));
  assert.deepEqual(payload.attemptReturn, { exitCode: 0, exitReason: 'authoritative-pass' });
  assert.equal(payload.fakeDatabaseCleanup.status, 'failed');
  assert.equal(payload.tempCleanup.status, 'completed');
  assert.equal(payload.passivePortDiagnostics[0].status, 'failed');
  assert.deepEqual(payload.finalSummary, {
    phase: 'run-final',
    status: 'passed',
    total: 3,
    completed: 3,
    failed: 0,
    skipped: 0,
    errors: 0,
    listOnly: false,
  });
  assert.equal(payload.exitReason, 'fake-database-cleanup-error');
});

test('final-decision marker never exposes raw credential URL, private path, or command text', () => {
  const writes = [];
  const sensitiveMessage = [
    'postgresql://owner:sentinel-password@localhost/private?sslkey=sentinel-key',
    'C:\\Users\\PrivateOwner\\Music\\secret.flac',
    'powershell.exe -Command sentinel-command',
  ].join(' | ');
  _private.finalizeMainResult(
    {
      exitCode: 1,
      lifecycle: {
        authoritativeResult: {
          phase: 'run-final',
          status: 'passed',
          total: 1,
          completed: 1,
          failed: 0,
          skipped: 0,
          errors: 0,
        },
        fakeDatabaseCleanup: {
          status: 'failed',
          error: { name: 'Error', code: 'ESECRET', message: sensitiveMessage },
        },
        managedAttempt: {
          attemptReturn: { exitCode: 0, exitReason: 'authoritative-pass' },
          scanAppCleanup: {
            status: 'failed',
            error: { name: 'Error', code: 'ESECRET', message: sensitiveMessage },
          },
          tempCleanup: {
            status: 'failed',
            error: { name: 'Error', code: 'ESECRET', message: sensitiveMessage },
          },
          passivePortDiagnostics: [{
            port: 4173,
            status: 'failed',
            ownerCount: 0,
            error: { name: 'Error', code: 'ESECRET', message: sensitiveMessage },
          }],
        },
        exitReason: 'managed-scan-cleanup-error',
      },
    },
    {
      processObject: { exitCode: null },
      stderr: { write(text) { writes.push(text); } },
    },
  );

  assert.equal(writes.length, 1);
  assert.doesNotMatch(writes[0], /sentinel-password|sentinel-key|PrivateOwner|secret\.flac|sentinel-command/);
  assert.match(writes[0], /"name":"Error","code":"ESECRET"/);
});

test('final-decision marker rebuilds injected lifecycle data from a closed safe schema', () => {
  const writes = [];
  const sentinel = 'postgresql://owner:sentinel-password@localhost/private?token=sentinel-query'
    + ' C:\\Users\\SentinelOwner\\secret.flac powershell.exe -Command sentinel-command';
  _private.finalizeMainResult(
    {
      exitCode: 1,
      lifecycle: {
        authoritativeResult: {
          phase: 'run-final',
          status: 'passed',
          total: 1,
          completed: 1,
          failed: 0,
          skipped: 0,
          errors: 0,
          injected: sentinel,
        },
        fakeDatabaseCleanup: {
          status: sentinel,
          injected: sentinel,
          error: { name: sentinel, code: sentinel, message: sentinel, command: sentinel },
        },
        managedAttempt: {
          attemptReturn: {
            exitCode: 0,
            exitReason: sentinel,
            message: sentinel,
            command: sentinel,
            extra: sentinel,
          },
          scanAppCleanup: {
            status: sentinel,
            injected: sentinel,
            error: { name: sentinel, code: sentinel, message: sentinel },
          },
          isolatedAppCleanup: {
            status: sentinel,
            injected: sentinel,
            error: { name: sentinel, code: sentinel, message: sentinel },
          },
          tempCleanup: {
            status: sentinel,
            removedCount: 2,
            injected: sentinel,
            error: { name: sentinel, code: sentinel, message: sentinel },
          },
          passivePortDiagnostics: [{
            port: 4173,
            status: sentinel,
            ownerCount: 2,
            injected: sentinel,
            error: { name: sentinel, code: sentinel, message: sentinel },
          }],
          injected: sentinel,
        },
        exitReason: sentinel,
        injected: sentinel,
      },
    },
    {
      processObject: { exitCode: null },
      stderr: { write(text) { writes.push(text); } },
    },
  );

  assert.equal(writes.length, 1);
  assert.doesNotMatch(
    writes[0],
    /sentinel-password|sentinel-query|SentinelOwner|secret\.flac|sentinel-command/,
  );
  const payload = JSON.parse(writes[0].slice(writes[0].indexOf('{')));
  assert.deepEqual(payload, {
    wrapperExitCode: 1,
    attemptReturn: { exitCode: 0, exitReason: 'unknown' },
    fakeDatabaseCleanup: { status: 'unknown', error: null },
    scanAppCleanup: { status: 'unknown', error: null },
    isolatedAppCleanup: { status: 'unknown', error: null },
    tempCleanup: { status: 'unknown', error: null, removedCount: 2 },
    passivePortDiagnostics: [{
      port: 4173,
      status: 'unknown',
      error: null,
      ownerCount: 2,
    }],
    finalSummary: {
      phase: 'run-final',
      status: 'passed',
      total: 1,
      completed: 1,
      failed: 0,
      skipped: 0,
      errors: 0,
      listOnly: false,
    },
    exitReason: 'unknown',
  });
});

test('failed authoritative markers survive managed isolated cleanup as a nonzero OS exit', () => {
  const runnerPath = path.resolve(__dirname, '..', '..', 'scripts', 'run-playwright.cjs');
  const script = `
    const { EventEmitter } = require('node:events');
    const { _private } = require(${JSON.stringify(runnerPath)});
    const nonce = 'failed-managed-cleanup-process-boundary';
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    let databaseCleanupCalls = 0;

    (async () => {
      const runPromise = _private.runPlaywrightProcess(
        ['test', 'tests/e2e/specs/lastfmProductionPath.spec.js'],
        {},
        10000,
        {
          resultNonce: nonce,
          spawnFn() { return child; },
          stopProcessTreeFn() {},
          reclaimPortFn() { return []; },
          waitForPortReleasedFn: async () => true,
          waitForReclaimedProcessesExitedFn: async () => {},
          readPortOwningProcessesFn() { return []; },
          readProcessTreeIdentitiesFn() { return []; },
          cleanupIsolatedLibraryDatabaseFn() { databaseCleanupCalls += 1; },
          stdout: { write() {} },
          stderr: { write() {} },
        },
      );
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(
          '[album-haven-playwright-result] '
          + JSON.stringify({
            version: 1,
            phase: 'tests-complete',
            nonce,
            status: 'failed',
            total: 1,
            completed: 1,
            failed: 1,
            skipped: 0,
            errors: 0,
          })
          + '\\n[album-haven-playwright-result] '
          + JSON.stringify({
            version: 1,
            phase: 'run-final',
            nonce,
            status: 'failed',
            total: 1,
            completed: 1,
            failed: 1,
            skipped: 0,
            errors: 0,
          })
          + '\\n',
        ));
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      });
      const result = await runPromise;
      if (databaseCleanupCalls !== 1) throw new Error('expected one isolated database cleanup');
      if (result.lifecycle.fakeDatabaseCleanup.status !== 'completed') {
        throw new Error('expected completed isolated database cleanup lifecycle');
      }
      process.stdout.write(JSON.stringify({
        wrapperExitCode: result.exitCode,
        databaseCleanupCalls,
        finalStatus: result.lifecycle.authoritativeResult?.status,
      }));
      _private.finalizeMainResult(result, { stderr: { write() {} } });
    })().catch((error) => {
      console.error(error);
      process.exitCode = 99;
    });
  `;

  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..', '..'),
    encoding: 'utf8',
    windowsHide: true,
  });

  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    wrapperExitCode: 1,
    databaseCleanupCalls: 1,
    finalStatus: 'failed',
  });
});

test('main process boundary preserves pass zero and fails test or no-tests outcomes', () => {
  const cases = [
    {
      name: 'pass',
      result: {
        exitCode: 0,
        lifecycle: {
          authoritativeResult: {
            phase: 'run-final',
            status: 'passed',
            total: 1,
            completed: 1,
            failed: 0,
            skipped: 0,
            errors: 0,
          },
          fakeDatabaseCleanup: { status: 'not-required', error: null },
          exitReason: 'authoritative-pass',
        },
      },
      expected: 0,
    },
    {
      name: 'failed test',
      result: {
        exitCode: 1,
        lifecycle: {
          authoritativeResult: {
            phase: 'run-final',
            status: 'failed',
            total: 1,
            completed: 1,
            failed: 1,
            skipped: 0,
            errors: 0,
          },
        },
      },
      expected: 1,
    },
    {
      name: 'unverified zero result',
      result: { exitCode: 0 },
      expected: 1,
    },
    {
      name: 'ordinary incomplete zero result',
      result: {
        exitCode: 0,
        lifecycle: {
          authoritativeResult: {
            phase: 'run-final',
            status: 'passed',
            total: 2,
            completed: 0,
            failed: 0,
            skipped: 0,
            errors: 0,
          },
          listOnly: false,
          fakeDatabaseCleanup: { status: 'not-required', error: null },
          exitReason: 'authoritative-pass',
        },
      },
      expected: 1,
    },
    {
      name: 'explicit list-only zero result',
      result: {
        exitCode: 0,
        lifecycle: {
          authoritativeResult: {
            phase: 'run-final',
            status: 'passed',
            total: 2,
            completed: 0,
            failed: 0,
            skipped: 0,
            errors: 0,
          },
          listOnly: true,
          fakeDatabaseCleanup: { status: 'not-required', error: null },
          exitReason: 'authoritative-pass',
        },
      },
      expected: 0,
    },
    {
      name: 'no tests collected',
      result: {
        exitCode: 1,
        lifecycle: {
          authoritativeResult: {
            phase: 'run-final',
            status: 'failed',
            total: 0,
            completed: 0,
            failed: 0,
            skipped: 0,
            errors: 1,
          },
        },
      },
      expected: 1,
    },
  ];

  for (const testCase of cases) {
    const processObject = { exitCode: null };
    const exitCode = _private.finalizeMainResult(testCase.result, {
      processObject,
      stderr: { write() {} },
    });
    assert.equal(exitCode, testCase.expected, testCase.name);
    assert.equal(processObject.exitCode, testCase.expected, testCase.name);
  }
});

test('browserless runner self-probe budget stays separate from the production default', () => {
  assert.equal(BROWSERLESS_RUNNER_SELF_PROBE_CHILD_BUDGET_MS, 20_000);
  assert.equal(_private.resolveRunTimeoutMs(), 3_000_000);
});

test('direct Node runner entrypoint explicitly exits zero for pass and one for failed spec or no-tests', async () => {
  const runnerSource = fs.readFileSync(RUNNER_ENTRYPOINT, 'utf8');
  assert.match(runnerSource, /main\(\)\.then\([\s\S]*finalizeMainResult\(result\)[\s\S]*process\.exit\(exitCode\)/);
  assert.match(runnerSource, /finalizeMainResult\(\{ exitCode: 1, lifecycle \}\)[\s\S]*process\.exit\(exitCode\)/);

  const callerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-caller-owned-root-'));
  const callerSentinel = path.join(callerRoot, 'caller-owned.txt');
  fs.writeFileSync(callerSentinel, 'preserve', 'utf8');
  try {
    const passing = await runBrowserlessRunnerEntrypointProbe({
      outcome: 'actual',
      env: { ALBUM_HAVEN_E2E_TEMP_ROOT: callerRoot },
    });
    assert.equal(passing.signal, null, `${passing.stderr}\n${passing.stdout}`);
    assert.equal(passing.status, 0, `${passing.stderr}\n${passing.stdout}`);
    const passingPayloads = parseFinalResultPayloads(passing.stdout);
    assert.equal(passingPayloads.at(-1)?.phase, 'run-final');
    assert.equal(passingPayloads.at(-1)?.status, 'passed');
    assert.match(passing.stderr, /\[playwright-wrapper-final-decision\]/);
    assert.match(passing.stderr, /"wrapperExitCode":0/);
    assert.match(passing.stderr, /"exitReason":"authoritative-pass"/);
    assert.equal(fs.readFileSync(callerSentinel, 'utf8'), 'preserve');
  } finally {
    fs.rmSync(callerRoot, { recursive: true, force: true });
  }

  const listOnly = await runBrowserlessRunnerEntrypointProbe({
    outcome: 'actual',
    listOnly: true,
  });
  assert.equal(listOnly.signal, null, `${listOnly.stderr}\n${listOnly.stdout}`);
  assert.equal(listOnly.status, 0, `${listOnly.stderr}\n${listOnly.stdout}`);
  assert.match(listOnly.stderr, /"wrapperExitCode":0/);
  assert.match(listOnly.stderr, /"listOnly":true/);

  const failing = await runBrowserlessRunnerEntrypointProbe({ outcome: 'expected' });
  assert.equal(failing.signal, null, `${failing.stderr}\n${failing.stdout}`);
  assert.equal(failing.status, 1, `${failing.stderr}\n${failing.stdout}`);
  const failingPayloads = parseFinalResultPayloads(failing.stdout);
  assert.deepEqual(
    failingPayloads.map(({ phase, status }) => ({ phase, status })),
    [
      { phase: 'tests-complete', status: 'failed' },
      { phase: 'run-final', status: 'failed' },
    ],
  );
  assert.equal(new Set(failingPayloads.map(({ nonce }) => nonce)).size, 1);

  const noTests = await runBrowserlessRunnerEntrypointProbe({ outcome: 'actual', noTests: true });
  assert.equal(noTests.signal, null, `${noTests.stderr}\n${noTests.stdout}`);
  assert.equal(noTests.status, 1, `${noTests.stderr}\n${noTests.stdout}`);
  const noTestsPayloads = parseFinalResultPayloads(noTests.stdout);
  assert.equal(noTestsPayloads.at(0)?.phase, 'run-error');
  assert.equal(noTestsPayloads.at(-1)?.phase, 'run-final');
  assert.ok(noTestsPayloads.every(({ status }) => status === 'failed'));
  assert.equal(new Set(noTestsPayloads.map(({ nonce }) => nonce)).size, 1);
});

test('failed lifecycle markers latch OS failure through delayed close and cleanup via direct exe and node.cmd', {
  skip: process.platform !== 'win32',
}, () => {
  for (const launcher of ['direct-exe', 'node.cmd']) {
    const result = runFailureLatchProcessBoundaryProbe({ launcher, mode: 'delayed-close' });
    assert.equal(result.signal, null, `${launcher}: ${result.stderr}\n${result.stdout}`);
    assert.equal(result.status, 1, `${launcher}: ${result.stderr}\n${result.stdout}`);
    assert.match(result.stderr, /\[playwright-wrapper-failure-latched\]/, launcher);
    assert.match(result.stderr, /\[WebServer\] delayed close log/, launcher);
    assert.match(result.stderr, /\[playwright-wrapper-final-decision\]/, launcher);
    assert.match(result.stderr, /"wrapperExitCode":1/, launcher);
    assert.match(result.stderr, /"phase":"run-final","status":"failed"/, launcher);
    const lifecycle = JSON.parse(result.stdout.trim());
    assert.deepEqual(lifecycle, {
      cleanupCalls: 1,
      wrapperExitCode: 1,
      cleanupStatus: 'completed',
    });
  }
});

test('authenticated failure latch survives natural event-loop escape without lifecycle settlement', () => {
  const result = runFailureLatchProcessBoundaryProbe({
    launcher: 'direct-exe',
    mode: 'natural-escape',
  });

  assert.equal(result.signal, null, `${result.stderr}\n${result.stdout}`);
  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stderr, /\[playwright-wrapper-failure-latched\]/);
  assert.match(result.stderr, /"phase":"run-error"/);
  assert.doesNotMatch(result.stderr, /\[playwright-wrapper-final-decision\]/);
});

test('performance run-final failure latches before absent or delayed flush on natural escape', () => {
  for (const mode of ['performance-no-flush', 'performance-delayed-flush']) {
    const result = runFailureLatchProcessBoundaryProbe({
      launcher: 'direct-exe',
      mode,
    });
    assert.equal(result.signal, null, `${mode}: ${result.stderr}\n${result.stdout}`);
    assert.equal(result.status, 1, `${mode}: ${result.stderr}\n${result.stdout}`);
    assert.match(result.stderr, /\[playwright-wrapper-failure-latched\]/, mode);
    assert.match(result.stderr, /"phase":"run-final"/, mode);
    assert.doesNotMatch(result.stderr, /\[playwright-wrapper-final-decision\]/, mode);
    if (mode === 'performance-delayed-flush') {
      assert.match(result.stderr, /\[probe-performance-flush-delayed\]/);
    }
  }
});

test('real runner entrypoint fails an all-skipped suite but passes a mixed pass-and-skip suite', async () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const playwrightTestPath = path.join(repoRoot, 'node_modules', '@playwright', 'test');
  const actualNonceEnv = _private.PLAYWRIGHT_FINAL_RESULT_NONCE_ENV;
  const reviewNamedNonceEnv = 'ALBUM_HAVEN_PLAYWRIGHT_FINAL_RESULT_NONCE';
  const diagnosticSecret = 'postgresql://owner:all-skipped-sentinel@localhost/private';
  const allSkipped = await runBrowserlessRunnerEntrypointProbe({
    specSource: `
      const { expect, test } = require(${JSON.stringify(playwrightTestPath)});
      test('discovered but intentionally skipped', async ({}, testInfo) => {
        expect(process.env[${JSON.stringify(reviewNamedNonceEnv)}]).toBeUndefined();
        expect(process.env[${JSON.stringify(actualNonceEnv)}]).toBeUndefined();
        const workerVisibleState = JSON.stringify({
          envKeys: Object.keys(process.env),
          config: testInfo.config,
          project: testInfo.project,
        }).toLowerCase();
        expect(workerVisibleState).not.toContain('album_haven_playwright_final_result_nonce');
        expect(workerVisibleState).not.toContain('album_haven_playwright_result_nonce');
        test.skip(true, 'intentional skip after worker nonce privacy assertions');
      });
    `,
    env: { ALBUM_HAVEN_PRIVATE_DIAGNOSTIC_PROBE: diagnosticSecret },
  });

  assert.equal(allSkipped.signal, null, `${allSkipped.stderr}\n${allSkipped.stdout}`);
  assert.equal(allSkipped.status, 1, `${allSkipped.stderr}\n${allSkipped.stdout}`);
  const allSkippedPayloads = parseFinalResultPayloads(allSkipped.stdout);
  assert.deepEqual(
    allSkippedPayloads.map(({ phase, status }) => ({ phase, status })),
    [
      { phase: 'tests-complete', status: 'failed' },
      { phase: 'run-final', status: 'failed' },
    ],
  );
  assert.ok(allSkippedPayloads.every((payload) => (
    payload.nonce
    && payload.nonce === allSkippedPayloads[0].nonce
    && payload.total === 1
    && payload.completed === 1
    && payload.failed === 0
    && payload.skipped === 1
    && payload.errors === 0
  )));
  assert.doesNotMatch(`${allSkipped.stdout}\n${allSkipped.stderr}`, /all-skipped-sentinel/);

  const mixed = await runBrowserlessRunnerEntrypointProbe({
    specSource: `
      const { expect, test } = require(${JSON.stringify(playwrightTestPath)});
      test('passing test', async ({}, testInfo) => {
        expect(process.env[${JSON.stringify(reviewNamedNonceEnv)}]).toBeUndefined();
        expect(process.env[${JSON.stringify(actualNonceEnv)}]).toBeUndefined();
        const workerVisibleState = JSON.stringify({
          envKeys: Object.keys(process.env),
          config: testInfo.config,
          project: testInfo.project,
        }).toLowerCase();
        expect(workerVisibleState).not.toContain('album_haven_playwright_final_result_nonce');
        expect(workerVisibleState).not.toContain('album_haven_playwright_result_nonce');
      });
      test.skip('intentionally skipped companion', () => {});
    `,
    env: { ALBUM_HAVEN_PRIVATE_DIAGNOSTIC_PROBE: diagnosticSecret },
  });

  assert.equal(mixed.signal, null, `${mixed.stderr}\n${mixed.stdout}`);
  assert.equal(mixed.status, 0, `${mixed.stderr}\n${mixed.stdout}`);
  const mixedPayloads = parseFinalResultPayloads(mixed.stdout);
  assert.deepEqual(
    mixedPayloads.map(({ phase, status }) => ({ phase, status })),
    [
      { phase: 'tests-complete', status: 'passed' },
      { phase: 'run-final', status: 'passed' },
    ],
  );
  assert.ok(mixedPayloads.every((payload) => (
    payload.nonce
    && payload.nonce === mixedPayloads[0].nonce
    && payload.total === 2
    && payload.completed === 2
    && payload.failed === 0
    && payload.skipped === 1
    && payload.errors === 0
  )));
  assert.doesNotMatch(`${mixed.stdout}\n${mixed.stderr}`, /all-skipped-sentinel/);
});

test('real runner entrypoint main rejection sets a nonzero OS status before Playwright starts', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-runner-catch-probe-'));
  const invalidTempPath = path.join(tempRoot, 'not-a-directory');
  fs.writeFileSync(invalidTempPath, 'sentinel', 'utf8');
  try {
    const result = spawnSync(process.execPath, [
      RUNNER_ENTRYPOINT,
      'test',
      '--grep',
      '^__runner_main_rejection_probe__$',
      '--run-timeout-ms=5000',
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        TEMP: invalidTempPath,
        TMP: invalidTempPath,
      },
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });

    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(parseFinalResultPayloads(result.stdout).length, 0);
    assert.match(result.stderr, /album-haven-e2e-|not-a-directory|ENOTDIR|ENOENT/i);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
