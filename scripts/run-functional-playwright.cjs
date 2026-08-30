const path = require('node:path');
const { spawnSync } = require('node:child_process');

const runnerPath = path.join(__dirname, 'run-playwright.cjs');
const suites = [
  {
    config: 'playwright.lastfm-auto-timezone.config.js',
    env: { ALBUM_HAVEN_E2E_LASTFM_TIMEZONE_MODE: 'blank' },
  },
  { config: 'playwright.cover-rescan.config.js' },
  { config: 'playwright.non-album-rescan.config.js' },
  { config: 'playwright.config.js' },
];

function hasFocusedSelection(argv) {
  return argv.some((arg) => (
    ['-g', '-G'].includes(String(arg))
    || /^--grep(?:-invert)?(?:=|$)/.test(String(arg))
    || /(?:^|[\\/])[^\\/]+\.(?:spec|test)\.[cm]?[jt]sx?$/.test(String(arg))
  ));
}

function isNoTestsResult(result) {
  return result?.status !== 0
    && /(?:^|\r?\n)Error: No tests found\.?(?:\r?\n|$)/m.test(
      `${result?.stdout || ''}\n${result?.stderr || ''}`,
    );
}

function childResult(result, failed = false) {
  if (result?.signal) return { exitCode: 1, signal: result.signal };
  return {
    exitCode: failed || result?.error || result?.status !== 0 ? 1 : 0,
    signal: null,
  };
}

function runFunctionalSuites(argv, options = {}) {
  const spawnSyncFn = options.spawnSyncFn || spawnSync;
  const stderr = options.stderr || process.stderr;
  const stdout = options.stdout || process.stdout;
  const focusedSelection = hasFocusedSelection(argv);
  let failed = false;
  let discoveredAny = false;

  for (const suite of suites) {
    const config = suite.config;
    const childEnv = { ...process.env };
    delete childEnv.ALBUM_HAVEN_E2E_LASTFM_TIMEZONE_MODE;
    Object.assign(childEnv, suite.env || {});
    if (focusedSelection) {
      const discovery = spawnSyncFn(
        process.execPath,
        [runnerPath, ...argv, '--list', `--config=${config}`],
        {
          cwd: path.join(__dirname, '..'),
          env: childEnv,
          encoding: 'utf8',
          stdio: 'pipe',
          windowsHide: true,
        },
      );
      if (discovery.signal) return childResult(discovery, true);
      if (isNoTestsResult(discovery)) continue;
      if (discovery.error || discovery.status !== 0) {
        if (discovery.stdout) stdout.write(discovery.stdout);
        if (discovery.stderr) stderr.write(discovery.stderr);
        failed = true;
        continue;
      }
      discoveredAny = true;
    }

    const result = spawnSyncFn(
      process.execPath,
      [runnerPath, ...argv, `--config=${config}`],
      {
        cwd: path.join(__dirname, '..'),
        env: childEnv,
        stdio: 'inherit',
        windowsHide: true,
      },
    );
    if (result.signal) return childResult(result, true);
    if (result.error || result.status !== 0) {
      failed = true;
    }
  }

  if (focusedSelection && !discoveredAny) failed = true;
  return { exitCode: failed ? 1 : 0, signal: null };
}

function applyFunctionalSuiteResult(result, processObject = process) {
  if (result.signal) {
    processObject.kill(processObject.pid, result.signal);
    return;
  }
  processObject.exitCode = result.exitCode;
}

module.exports = {
  _private: {
    runFunctionalSuites,
    applyFunctionalSuiteResult,
  },
};

if (require.main === module) {
  applyFunctionalSuiteResult(runFunctionalSuites(process.argv.slice(2)));
}
