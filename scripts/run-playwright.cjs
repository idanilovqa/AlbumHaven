const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { resolveRuntimeFlags } = require('./playwright-runtime-flags.cjs');
const {
  DEFAULT_PLAYWRIGHT_PYTHON,
  resolvePlaywrightPython,
} = require('./playwright-python.cjs');
const {
  assertProviderWriteSafeEnv,
  buildAndAssertProviderWriteSafeEnv,
} = require('./playwright-provider-safety.cjs');
const {
  assertManagedRealDataDatabaseEnv,
  assertManagedSyntheticLargeFixtureEnv,
} = require('./playwright-real-data-safety.cjs');
const {
  PLAYWRIGHT_PERFORMANCE_REPORTER_FLUSH_MARKER,
} = require('./playwright-performance-constants.cjs');
const {
  FINAL_RESULT_MARKER: PLAYWRIGHT_FINAL_RESULT_MARKER,
  FINAL_RESULT_NONCE_ENV: PLAYWRIGHT_FINAL_RESULT_NONCE_ENV,
} = require('./playwright-final-result-reporter.cjs');
const {
  _private: terminalSummary,
} = require('./playwright-terminal-summary.cjs');

const runtimeFlags = resolveRuntimeFlags();
const playwrightCliPath = path.join(__dirname, '..', 'node_modules', 'playwright', 'cli.js');
const playwrightFinalResultControlPath = path.join(
  __dirname,
  'playwright-final-result-control.cjs',
);
const repoRoot = path.join(__dirname, '..');
const DEFAULT_PLAYWRIGHT_BROWSERS_PATH = path.join(
  repoRoot,
  'node_modules',
  '.cache',
  'ms-playwright',
);

function resolvePlaywrightBrowsersPath(environment = {}, options = {}) {
  const explicitBrowsersPath = environment.PLAYWRIGHT_BROWSERS_PATH;
  if (
    explicitBrowsersPath !== undefined
    && explicitBrowsersPath !== null
    && String(explicitBrowsersPath).trim()
  ) {
    return String(explicitBrowsersPath);
  }

  const defaultBrowsersPath = options.defaultBrowsersPath
    || DEFAULT_PLAYWRIGHT_BROWSERS_PATH;
  const existsSyncFn = options.existsSyncFn || fs.existsSync;
  return existsSyncFn(defaultBrowsersPath) ? defaultBrowsersPath : undefined;
}

const ISOLATED_E2E_TEMP_PREFIX = 'album-haven-e2e-';
const ISOLATED_E2E_TEMP_LEASE = '.album-haven-run-lease.json';
const REAL_APP_DATA_ROOT = path.join(repoRoot, '.tmp', 'playwright-real-appdata');
const DEFAULT_RUN_TIMEOUT_MS = 3000000;
const PLAYWRIGHT_COMPLETION_GRACE_MS = 15000;
const PLAYWRIGHT_FINALIZATION_GRACE_MS = 15000;
const PLAYWRIGHT_TERMINAL_COLLECTION_FAILURE_GRACE_MS = 1000;
const MANAGED_REAL_APP_COMPLETION_GRACE_MS = 30000;
const MANAGED_SUPPORT_APP_PORT_REUSE_TIMEOUT_MS = 15000;
const RECLAIMED_PROCESS_EXIT_TIMEOUT_MS = 15000;
const PROCESS_TREE_STOP_TIMEOUT_MS = 15000;
const WINDOWS_PROCESS_TREE_MAX_DEPTH = 32;
const WINDOWS_PROCESS_TREE_MAX_PROCESSES = 256;
const ISOLATED_LIBRARY_CLEANUP_TIMEOUT_MS = 135000;
const DEFAULT_FAKE_E2E_SETUP_DATABASE_URL = 'postgresql://album_haven_migrator@localhost:5432/album_haven_fake_e2e';
const DEFAULT_FAKE_E2E_RUNTIME_DATABASE_URL = 'postgresql://album_haven_app@localhost:5432/album_haven_fake_e2e';
const ISOLATED_LIBRARY_APP_PATH = path.join(repoRoot, 'tests', 'e2e', 'support', 'isolatedLibraryApp.py');
const SCAN_PERFORMANCE_APP_PATH = path.join(repoRoot, 'tests', 'e2e', 'support', 'scanPerformanceApp.py');
const MANAGED_SCAN_APP_ENV = 'PLAYWRIGHT_MANAGED_SCAN_APP';
const MANAGED_ISOLATED_APP_ENV = 'PLAYWRIGHT_MANAGED_APP';
const MANAGED_ISOLATED_RESTART_CONTROL_DIR_ENV = 'ALBUM_HAVEN_E2E_RESTART_CONTROL_DIR';
const MANAGED_ISOLATED_PRESERVE_ON_SHUTDOWN_ENV = 'ALBUM_HAVEN_E2E_PRESERVE_ON_SHUTDOWN';
const MANAGED_ISOLATED_REUSE_STATE_ENV = 'ALBUM_HAVEN_E2E_REUSE_STATE';
const MANAGED_ISOLATED_RESTART_REQUEST_FILE = 'restart-request.json';
const MANAGED_ISOLATED_RESTART_ACK_FILE = 'restart-ack.json';
const MANAGED_ISOLATED_RESTART_POLL_INTERVAL_MS = 100;
const SCAN_STATUS_SAMPLES_ENV = 'ALBUM_HAVEN_SCAN_STATUS_SAMPLES_PATH';
const MANAGED_SCAN_APP_STARTUP_TIMEOUT_MS = 120000;
const MANAGED_ISOLATED_APP_STARTUP_TIMEOUT_MS = 120000;
const MANAGED_FUNCTIONAL_FIXTURE_WARMUP_TIMEOUT_MS = 120000;
const MANAGED_REAL_APP_PORT_CONFLICT_PATTERNS = [
  /already used, make sure that nothing is running on the port\/url/i,
  /attempt was made to access a socket in a way forbidden by its access permissions/i,
  /winerror\s*10013/i,
  /\[(?:errno|winerror)\s*10048\]/i,
];
function createPlaywrightResultNonce() {
  return randomBytes(32).toString('hex');
}

function safeErrorSummary(error) {
  if (!error) {
    return null;
  }
  const safeTokenPattern = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
  const name = String(error.name || '');
  const code = String(error.code || '');
  const summary = {};
  if (safeTokenPattern.test(name)) {
    summary.name = name;
  }
  if (safeTokenPattern.test(code)) {
    summary.code = code;
  }
  return Object.keys(summary).length > 0 ? summary : null;
}

const SAFE_LIFECYCLE_STAGE_STATUSES = new Set([
  'not-required',
  'pending',
  'running',
  'completed',
  'failed',
  'unknown',
]);
const SAFE_LIFECYCLE_EXIT_REASONS = new Set([
  'authoritative-pass',
  'wrapper-child-lifecycle-mismatch',
  'child-close-result-mismatch',
  'fake-database-cleanup-error',
  'managed-scan-cleanup-error',
  'managed-isolated-app-cleanup-error',
  'owned-temp-cleanup-error',
  'unknown',
]);
const SAFE_FINAL_RESULT_PHASES = new Set(['tests-complete', 'run-error', 'run-final', 'unknown']);
const SAFE_FINAL_RESULT_STATUSES = new Set([
  'passed',
  'failed',
  'timedout',
  'interrupted',
  'unknown',
]);

function safeClosedValue(value, allowedValues) {
  const normalized = String(value || '');
  return allowedValues.has(normalized) ? normalized : 'unknown';
}

function safeNonnegativeInteger(value, fallback = 0) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function safeAttemptReturn(attemptReturn) {
  if (!attemptReturn || typeof attemptReturn !== 'object') {
    return null;
  }
  return {
    exitCode: typeof attemptReturn.exitCode === 'number' && Number.isInteger(attemptReturn.exitCode)
      ? attemptReturn.exitCode
      : 1,
    exitReason: safeClosedValue(attemptReturn.exitReason, SAFE_LIFECYCLE_EXIT_REASONS),
  };
}

function safeLifecycleStage(stage, extraFields = []) {
  if (!stage || typeof stage !== 'object') {
    return null;
  }
  const safeStage = {
    status: safeClosedValue(stage.status, SAFE_LIFECYCLE_STAGE_STATUSES),
    error: safeErrorSummary(stage.error),
  };
  for (const field of extraFields) {
    safeStage[field] = safeNonnegativeInteger(stage[field]);
  }
  return safeStage;
}

function buildAuthoritativePassFinalDecisionDiagnostic(result) {
  const exitCode = typeof result?.exitCode === 'number' && Number.isInteger(result.exitCode)
    ? result.exitCode
    : 1;
  const lifecycle = result?.lifecycle || {};
  const finalResult = lifecycle.authoritativeResult;
  const finalCounts = ['total', 'completed', 'failed', 'skipped', 'errors']
    .map((field) => safeNonnegativeInteger(finalResult?.[field]));
  const managedAttempt = lifecycle.managedAttempt || {};
  return {
    wrapperExitCode: exitCode,
    attemptReturn: safeAttemptReturn(managedAttempt.attemptReturn),
    fakeDatabaseCleanup: safeLifecycleStage(lifecycle.fakeDatabaseCleanup),
    scanAppCleanup: safeLifecycleStage(managedAttempt.scanAppCleanup),
    isolatedAppCleanup: safeLifecycleStage(managedAttempt.isolatedAppCleanup),
    tempCleanup: safeLifecycleStage(managedAttempt.tempCleanup, ['removedCount']),
    passivePortDiagnostics: (managedAttempt.passivePortDiagnostics || []).map((diagnostic) => ({
      port: safeNonnegativeInteger(diagnostic?.port),
      ...safeLifecycleStage(diagnostic, ['ownerCount']),
    })),
    finalSummary: {
      phase: safeClosedValue(finalResult?.phase, SAFE_FINAL_RESULT_PHASES),
      status: safeClosedValue(finalResult?.status, SAFE_FINAL_RESULT_STATUSES),
      total: finalCounts[0],
      completed: finalCounts[1],
      failed: finalCounts[2],
      skipped: finalCounts[3],
      errors: finalCounts[4],
      listOnly: lifecycle.listOnly === true,
    },
    exitReason: safeClosedValue(lifecycle.exitReason, SAFE_LIFECYCLE_EXIT_REASONS),
  };
}

function hasCompletedAuthoritativePassLifecycle(result) {
  const lifecycle = result?.lifecycle || {};
  const finalResult = lifecycle.authoritativeResult;
  const fakeDatabaseCleanupStatus = String(lifecycle.fakeDatabaseCleanup?.status || 'unknown');
  const tempCleanupStatus = lifecycle.managedAttempt?.tempCleanup?.status;
  const completionCountsAreValid = finalResult?.completed === finalResult?.total
    || (
      lifecycle.listOnly === true
      && finalResult?.total > 0
      && finalResult?.completed === 0
    );
  return (
    result?.exitCode === 0
    && lifecycle.exitReason === 'authoritative-pass'
    && finalResult?.phase === 'run-final'
    && finalResult?.status === 'passed'
    && Number.isInteger(finalResult?.total)
    && Number.isInteger(finalResult?.completed)
    && completionCountsAreValid
    && finalResult.failed === 0
    && finalResult.errors === 0
    && ['not-required', 'completed'].includes(fakeDatabaseCleanupStatus)
    && (
      tempCleanupStatus === undefined
      || ['not-required', 'completed'].includes(String(tempCleanupStatus))
    )
  );
}

function finalizeMainResult(result, options = {}) {
  const processObject = options.processObject || process;
  const stderr = options.stderr || process.stderr;
  const requestedExitCode = hasCompletedAuthoritativePassLifecycle(result) ? 0 : 1;
  const priorExitCode = Number(processObject.exitCode || 0);
  const exitCode = requestedExitCode === 0 && priorExitCode === 0 ? 0 : 1;
  const diagnostic = buildAuthoritativePassFinalDecisionDiagnostic({
    ...result,
    exitCode,
  });
  stderr.write(`[playwright-wrapper-final-decision] ${JSON.stringify(diagnostic)}\n`);
  processObject.exitCode = exitCode;
  return exitCode;
}
function parseEnvValue(rawValue) {
  const value = String(rawValue || '').trim();
  if (value.length >= 2 && value[0] === value[value.length - 1] && ['"', "'"].includes(value[0])) {
    return value.slice(1, -1);
  }
  return value;
}

function loadDotEnvFile(env, dotenvPath = path.join(repoRoot, '.env')) {
  if (!fs.existsSync(dotenvPath)) {
    return env;
  }
  const nextEnv = { ...env };
  const lines = fs.readFileSync(dotenvPath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    if (!line || line.startsWith('#') || !line.includes('=')) {
      continue;
    }
    const separatorIndex = line.indexOf('=');
    const key = String(line.slice(0, separatorIndex) || '').trim();
    if (!key || Object.prototype.hasOwnProperty.call(nextEnv, key)) {
      continue;
    }
    nextEnv[key] = parseEnvValue(line.slice(separatorIndex + 1));
  }
  return nextEnv;
}

function isListOnlyCommand(argv) {
  return argv.includes('--list');
}

function hasTerminalPlaywrightCollectionFailure(output) {
  const text = String(output || '');
  return (
    /(?:^|\r?\n)Error: No tests found\.(?:\r?\n|$)/m.test(text)
    && !/(?:^|\r?\n)Running\s+\d+\s+tests?\s+using\s+\d+\s+workers?(?:\r?\n|$)/m.test(text)
  );
}

function writeIsolatedE2ETempRootLease(entryPath, owner, options = {}) {
  const writeFileSyncFn = options.writeFileSyncFn || fs.writeFileSync;
  const lease = {
    version: 1,
    pid: Number(owner?.pid),
    creationIdentity: String(owner?.creationIdentity || '').trim(),
  };
  if (!Number.isInteger(lease.pid) || lease.pid <= 0 || !lease.creationIdentity) {
    throw new Error('Isolated Playwright temp-root lease requires a PID and creation identity.');
  }
  writeFileSyncFn(
    path.join(entryPath, ISOLATED_E2E_TEMP_LEASE),
    `${JSON.stringify(lease)}\n`,
    'utf8',
  );
  return lease;
}

function createOwnedIsolatedE2ETempRoot(options = {}) {
  const tempRoot = options.tempRoot || os.tmpdir();
  const readProcessCreationIdentityFn = options.readProcessCreationIdentityFn
    || readProcessCreationIdentity;
  const entryPath = fs.mkdtempSync(path.join(tempRoot, ISOLATED_E2E_TEMP_PREFIX));
  try {
    writeIsolatedE2ETempRootLease(entryPath, {
      pid: process.pid,
      creationIdentity: readProcessCreationIdentityFn(process.pid),
    });
    return entryPath;
  } catch (error) {
    fs.rmSync(entryPath, { recursive: true, force: true });
    throw error;
  }
}

function cleanupIsolatedE2ETempRoots(tempRoot = os.tmpdir(), ownedRoots = [], options = {}) {
  const resolvedTempRoot = path.resolve(tempRoot);
  const readProcessCreationIdentityFn = options.readProcessCreationIdentityFn
    || readProcessCreationIdentity;
  const rmSyncFn = options.rmSyncFn || fs.rmSync;
  const existsSyncFn = options.existsSyncFn || fs.existsSync;
  const explicitRoots = new Set(ownedRoots.map((entry) => path.resolve(String(entry || ''))));
  const removedRoots = [];
  let candidates = [...explicitRoots];
  if (options.reclaimOrphans === true) {
    try {
      candidates = candidates.concat(fs.readdirSync(resolvedTempRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(ISOLATED_E2E_TEMP_PREFIX))
        .map((entry) => path.join(resolvedTempRoot, entry.name)));
    } catch (_error) {
      // Best-effort orphan discovery only.
    }
  }
  for (const entryPath of new Set(candidates)) {
    if (
      path.dirname(entryPath) !== resolvedTempRoot
      || !path.basename(entryPath).startsWith(ISOLATED_E2E_TEMP_PREFIX)
    ) {
      continue;
    }
    const isExplicitRoot = explicitRoots.has(entryPath);
    try {
      if (!isExplicitRoot) {
        const leasePath = path.join(entryPath, ISOLATED_E2E_TEMP_LEASE);
        if (!fs.existsSync(leasePath)) {
          continue;
        }
        const lease = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
        if (
          Number.isInteger(lease?.pid)
          && lease.pid > 0
          && String(lease?.creationIdentity || '').trim()
          && readProcessCreationIdentityFn(lease.pid) === String(lease.creationIdentity)
        ) {
          continue;
        }
      }
      rmSyncFn(entryPath, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
      if (existsSyncFn(entryPath)) {
        throw new Error(
          `Runner-owned isolated Playwright temp root still exists after cleanup: ${entryPath}`,
        );
      }
      removedRoots.push(entryPath);
    } catch (error) {
      if (isExplicitRoot) {
        throw error;
      }
      // Best-effort orphan temp cleanup only.
    }
  }
  return removedRoots;
}

function runCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
}

function resolvePlaywrightSummaryExitCode(outputText) {
  const normalized = String(outputText || '');
  const lines = normalized.split(/\r?\n/);
  let inferredExitCode = null;

  for (const rawLine of lines) {
    const line = String(rawLine || '')
      .replace(/\u001b\[[0-9;]*m/g, '')
      .trim();
    if (!line) {
      continue;
    }
    if (/^\d+\s+failed\b/i.test(line)) {
      inferredExitCode = 1;
      continue;
    }
    if (/^\d+\s+passed\b/i.test(line)) {
      if (inferredExitCode === null) {
        inferredExitCode = 0;
      }
    }
  }

  return inferredExitCode;
}

function stripAnsiAndTrim(line) {
  return String(line || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .trim();
}

function maybeWritePlaywrightTerminalSummary(outputText, stdout = process.stdout) {
  const summaryText = terminalSummary.formatPlaywrightTerminalSummary(
    terminalSummary.parsePlaywrightListResults(outputText),
  );
  if (!summaryText) {
    return '';
  }
  stdout.write(`\n${summaryText}`);
  return summaryText;
}

function resolvePlaywrightListReporterExitCode(outputText) {
  const normalized = String(outputText || '');
  const lines = normalized.split(/\r?\n/).map(stripAnsiAndTrim);
  let announcedTestCount = null;
  let passedCount = 0;
  let failedCount = 0;

  for (const line of lines) {
    if (!line) {
      continue;
    }
    const runningMatch = line.match(/^Running\s+(\d+)\s+tests?\b/i);
    if (runningMatch) {
      announcedTestCount = Number(runningMatch[1]);
      continue;
    }
    if (/^ok\s+\d+\b/i.test(line)) {
      passedCount += 1;
      continue;
    }
    if (/^(not ok|x)\s+\d+\b/i.test(line)) {
      failedCount += 1;
    }
  }

  if (!Number.isInteger(announcedTestCount) || announcedTestCount <= 0) {
    return null;
  }

  const completedCount = passedCount + failedCount;
  if (completedCount < announcedTestCount) {
    return null;
  }

  return failedCount > 0 ? 1 : 0;
}

function hasIncompletePlaywrightListRun(outputText) {
  const normalized = String(outputText || '');
  const lines = normalized.split(/\r?\n/).map(stripAnsiAndTrim);
  let announcedTestCount = null;
  let completedCount = 0;

  for (const line of lines) {
    if (!line) {
      continue;
    }
    const runningMatch = line.match(/^Running\s+(\d+)\s+tests?\b/i);
    if (runningMatch) {
      announcedTestCount = Number(runningMatch[1]);
      continue;
    }
    if (/^(ok|not ok|x)\s+\d+\b/i.test(line)) {
      completedCount += 1;
    }
  }

  return Number.isInteger(announcedTestCount)
    && announcedTestCount > 0
    && completedCount < announcedTestCount;
}

function parsePlaywrightFinalResult(outputText, options = {}) {
  const lines = String(outputText || '').split(/\r?\n/);
  let finalResult = null;

  for (const rawLine of lines) {
    const line = stripAnsiAndTrim(rawLine);
    if (!line.startsWith(`${PLAYWRIGHT_FINAL_RESULT_MARKER} `)) {
      continue;
    }
    const serialized = line.slice(PLAYWRIGHT_FINAL_RESULT_MARKER.length).trim();
    try {
      const parsed = JSON.parse(serialized);
      const integerFields = ['total', 'completed', 'failed', 'skipped', 'errors'];
      if (
        parsed?.version !== 1
        || !['tests-complete', 'run-error', 'run-final'].includes(parsed?.phase)
        || typeof parsed?.nonce !== 'string'
        || (
          String(options.expectedNonce || '')
          && parsed.nonce !== String(options.expectedNonce)
        )
        || !['passed', 'failed', 'timedout', 'interrupted'].includes(parsed?.status)
        || integerFields.some((field) => !Number.isInteger(parsed?.[field]) || parsed[field] < 0)
        || parsed.completed > parsed.total
        || parsed.failed > parsed.completed
        || parsed.skipped > parsed.completed
        || parsed.failed + parsed.skipped > parsed.completed
      ) {
        continue;
      }
      finalResult = parsed;
    } catch (_error) {
      // The reporter line can arrive across multiple chunks. Wait for a complete valid line.
    }
  }

  return finalResult;
}

function resolvePlaywrightFinalResultExitCode(outputText, options = {}) {
  const result = parsePlaywrightFinalResult(outputText, options);
  if (!result) {
    return null;
  }
  if (result.status !== 'passed') {
    return 1;
  }
  if (result.phase !== 'run-final') {
    return null;
  }
  if (options.listOnly === true) {
    return result.failed === 0 && result.errors === 0 ? 0 : 1;
  }
  if (
    result.completed !== result.total
    || result.failed !== 0
    || result.errors !== 0
    || (result.total > 0 && result.skipped === result.completed)
  ) {
    return 1;
  }
  return 0;
}

function resolvePlaywrightCompletionSignal(outputText, options = {}) {
  const result = parsePlaywrightFinalResult(outputText, options);
  if (!result) {
    return null;
  }
  if (
    String(options.childEnv?.PLAYWRIGHT_PERF_VERIFICATION_GROUP_ID || '').trim()
    && !String(outputText || '').includes(PLAYWRIGHT_PERFORMANCE_REPORTER_FLUSH_MARKER)
  ) {
    return null;
  }
  return result;
}

function resolvePlaywrightCompletionExitCode(outputText, options = {}) {
  const completionExitCode = resolvePlaywrightFinalResultExitCode(outputText, options);

  if (completionExitCode === null) {
    return null;
  }

  if (
    String(options.childEnv?.PLAYWRIGHT_PERF_VERIFICATION_GROUP_ID || '').trim()
    && !String(outputText || '').includes(PLAYWRIGHT_PERFORMANCE_REPORTER_FLUSH_MARKER)
  ) {
    return null;
  }

  return completionExitCode;
}

function shouldUseReporterDrivenCompletion(options = {}) {
  return options.listOnly !== true
    && (options.servesRealApp === true || options.servesRealApp === false);
}

function resolveReporterDrivenCompletionGraceMs(options = {}) {
  return options.servesRealApp === true
    ? MANAGED_REAL_APP_COMPLETION_GRACE_MS
    : PLAYWRIGHT_COMPLETION_GRACE_MS;
}

function resolveManagedPortReuseTimeoutMs(options = {}) {
  return options.servesRealApp === true
    ? 15000
    : MANAGED_SUPPORT_APP_PORT_REUSE_TIMEOUT_MS;
}

function resolveManagedWebServerPorts(options = {}) {
  if (options.isListOnlyCommand === true) {
    return [];
  }

  if (options.servesRealApp === true) {
    const realAppPort = Number(options.realAppPort || 5001);
    return [Number.isFinite(realAppPort) ? realAppPort : 5001];
  }

  if (options.managesSupportAppPort !== true) {
    return [];
  }

  const supportAppPort = Number(options.supportAppPort || 4173);
  const resolvedSupportAppPort = Number.isFinite(supportAppPort) ? supportAppPort : 4173;
  const providerPort = Number(options.providerPort || resolvedSupportAppPort + 2);
  if (options.managesProviderPort === false) {
    return [resolvedSupportAppPort];
  }
  return [resolvedSupportAppPort, Number.isFinite(providerPort) ? providerPort : resolvedSupportAppPort + 2];
}

function resolveRunTimeoutMs(overrideTimeoutMs) {
  const parsedTimeoutMs = Number(overrideTimeoutMs);
  return Number.isFinite(parsedTimeoutMs) && parsedTimeoutMs > 0
    ? parsedTimeoutMs
    : DEFAULT_RUN_TIMEOUT_MS;
}

function usesManagedSupportAppPort(passthroughArgv = []) {
  const explicitConfig = resolveExplicitPlaywrightConfig(passthroughArgv);
  if (!explicitConfig) {
    return true;
  }

  return isManagedIsolatedLibraryConfig(passthroughArgv)
    || /playwright\.(?:performance|scan-performance)\.config\.cjs$/i.test(explicitConfig);
}

function resolveExplicitPlaywrightConfig(passthroughArgv = []) {
  const args = Array.isArray(passthroughArgv) ? passthroughArgv : [];
  const configFlagIndex = args.findIndex((arg) => arg === '-c' || arg === '--config');
  let explicitConfig = '';

  if (configFlagIndex >= 0 && configFlagIndex + 1 < args.length) {
    explicitConfig = String(args[configFlagIndex + 1] || '');
  } else {
    const inlineConfigArg = args.find((arg) => String(arg || '').startsWith('--config='));
    if (inlineConfigArg) {
      explicitConfig = inlineConfigArg.slice('--config='.length);
    }
  }

  if (!explicitConfig) {
    return '';
  }

  return explicitConfig;
}

function isDefaultIsolatedLibraryConfig(passthroughArgv = []) {
  const explicitConfig = resolveExplicitPlaywrightConfig(passthroughArgv);
  if (!explicitConfig) {
    return true;
  }
  return path.resolve(repoRoot, explicitConfig) === path.join(repoRoot, 'playwright.config.js');
}

function isManagedIsolatedLibraryConfig(passthroughArgv = []) {
  if (isDefaultIsolatedLibraryConfig(passthroughArgv)) {
    return true;
  }
  return /playwright\.(?:lastfm-auto-timezone|cover-rescan|non-album-rescan)\.config\.js$/i.test(
    resolveExplicitPlaywrightConfig(passthroughArgv),
  ) || Boolean(resolveManagedFixtureProfile(passthroughArgv));
}

function isScanPerformanceConfig(passthroughArgv = []) {
  return /playwright\.scan-performance\.config\.cjs$/i.test(
    resolveExplicitPlaywrightConfig(passthroughArgv),
  );
}

function resolveManagedIsolatedAppPorts(passthroughArgv = [], options = {}) {
  const realAppPort = Number(options.realAppPort || 5001);
  if (resolveManagedFixtureProfile(passthroughArgv)) {
    const appPort = Number.isFinite(realAppPort) ? realAppPort : 5001;
    return { appPort, providerPort: appPort + 2 };
  }
  const supportAppPort = Number(options.supportAppPort || 4173);
  const appPort = Number.isFinite(supportAppPort) ? supportAppPort : 4173;
  const providerPort = Number(options.providerPort || appPort + 2);
  return {
    appPort,
    providerPort: Number.isFinite(providerPort) ? providerPort : appPort + 2,
  };
}

function buildIsolatedLibraryCleanupEnv(childEnv = {}) {
  return {
    ...childEnv,
    ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL:
      childEnv.ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL || DEFAULT_FAKE_E2E_SETUP_DATABASE_URL,
    ALBUM_HAVEN_FAKE_E2E_DATABASE_URL:
      childEnv.ALBUM_HAVEN_FAKE_E2E_DATABASE_URL || DEFAULT_FAKE_E2E_RUNTIME_DATABASE_URL,
  };
}

function cleanupIsolatedLibraryDatabase(childEnv = {}, options = {}) {
  const runCommandFn = options.runCommandFn || runCommand;
  const timeoutMs = Number(options.timeoutMs || ISOLATED_LIBRARY_CLEANUP_TIMEOUT_MS);
  const result = runCommandFn(
    resolvePlaywrightPython(childEnv),
    [ISOLATED_LIBRARY_APP_PATH, '--cleanup-only'],
    {
      cwd: repoRoot,
      env: buildIsolatedLibraryCleanupEnv(childEnv),
      stdio: 'pipe',
      windowsHide: true,
      timeout: timeoutMs,
    },
  );
  if (result.error) {
    throw new Error(`Isolated library database cleanup failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(
      `Isolated library database cleanup exited with status ${String(result.status)}`
      + (detail ? `: ${detail}` : '.'),
    );
  }
}

function isSyntheticLargeLibraryConfig(passthroughArgv = []) {
  return /playwright\.synthetic-large-library\.config\.cjs$/i.test(resolveExplicitPlaywrightConfig(passthroughArgv));
}

function shouldSeedAllFunctionalCoverMisses(passthroughArgv = []) {
  return /playwright\.non-album-rescan\.config\.js$/i.test(
    resolveExplicitPlaywrightConfig(passthroughArgv),
  ) || passthroughArgv.some((argument) => (
    /(?:^|[\\/])sparseTagEditReconciliation\.spec\.js$/i.test(String(argument || ''))
  ));
}

function resolveManagedFixtureProfile(passthroughArgv = []) {
  const config = resolveExplicitPlaywrightConfig(passthroughArgv);
  if (/playwright\.synthetic-large-library\.config\.cjs$/i.test(config)) {
    return 'synthetic-large-library';
  }
  if (/playwright\.utility-problematic-files\.config\.cjs$/i.test(config)) {
    return 'utility-problematic-files';
  }
  if (
    String(process.env.ALBUM_HAVEN_FIXTURE_PROFILE || '').trim() === 'functional-core'
    && /(?:playwright\.config\.js|playwright\.autoplay-allowed\.config\.js|playwright\.cover-rescan\.config\.js|playwright\.lastfm-auto-timezone\.config\.js|playwright\.non-album-rescan\.config\.js)$/i.test(config)
  ) {
    return 'functional-core';
  }
  return '';
}

function shouldRetryManagedRealAppPortConflict(result, options = {}) {
  const attemptsRemaining = Number(options.attemptsRemaining || 0);
  const managedPorts = Array.isArray(options.managedPorts) ? options.managedPorts : [];
  if (attemptsRemaining <= 0 || managedPorts.length === 0) {
    return false;
  }
  if (!result || Number(result.exitCode || 0) === 0) {
    return false;
  }
  const combinedOutput = String(result.combinedOutput || '');
  return MANAGED_REAL_APP_PORT_CONFLICT_PATTERNS.some((pattern) => pattern.test(combinedOutput));
}

function usesRunnerOwnedIsolatedTempRoot(passthroughArgv = [], childEnv = {}) {
  if (String(childEnv.ALBUM_HAVEN_PERFORMANCE_PROFILE_SESSION || '').trim() === '1') {
    return false;
  }
  return isManagedIsolatedLibraryConfig(passthroughArgv)
    || /playwright\.performance\.config\.cjs$/i.test(
      resolveExplicitPlaywrightConfig(passthroughArgv),
    )
    || /playwright\.scan-performance\.config\.cjs$/i.test(
      resolveExplicitPlaywrightConfig(passthroughArgv),
    );
}

function probePortListening(port, options = {}) {
  const host = String(options.host || '127.0.0.1');
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(Number(options.socketTimeoutMs || 1000), () => finish(false));
  });
}

async function waitForManagedScanAppReady(child, port, options = {}) {
  const timeoutMs = Number(options.timeoutMs || MANAGED_SCAN_APP_STARTUP_TIMEOUT_MS);
  const pollIntervalMs = Number(options.pollIntervalMs || 100);
  const probeHttpStatusReadyFn = options.probeHttpStatusReadyFn || probeHttpStatusReady;
  const sleepFn = options.sleepFn || sleep;
  const nowFn = options.nowFn || Date.now;
  const getLaunchErrorFn = options.getLaunchErrorFn || (() => null);
  const statusUrl = `http://127.0.0.1:${port}/status`;
  const deadline = nowFn() + timeoutMs;

  while (nowFn() <= deadline) {
    const launchError = getLaunchErrorFn();
    if (launchError) {
      throw new Error(`Managed scan app failed before readiness: ${launchError.message || launchError}`);
    }
    if (child.exitCode !== null && child.exitCode !== undefined) {
      throw new Error(`Managed scan app exited before readiness with code ${String(child.exitCode)}.`);
    }
    if (await probeHttpStatusReadyFn(statusUrl, options)) {
      return;
    }
    await sleepFn(pollIntervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for managed scan app on port ${port}.`);
}

async function startManagedScanApp(childEnv, options = {}) {
  const spawnFn = options.spawnFn || spawn;
  const port = Number(options.port || childEnv.PLAYWRIGHT_PORT || 4174);
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const managedEnv = {
    ...childEnv,
    [MANAGED_SCAN_APP_ENV]: '1',
    [SCAN_STATUS_SAMPLES_ENV]: childEnv[SCAN_STATUS_SAMPLES_ENV]
      || path.join(repoRoot, '.tmp', 'playwright-scan-status', `direct-port-${port}.jsonl`),
  };
  const child = spawnFn(
    resolvePlaywrightPython(managedEnv),
    [SCAN_PERFORMANCE_APP_PATH, '--port', String(port)],
    {
      cwd: repoRoot,
      env: managedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    },
  );
  child.stdout?.on('data', (chunk) => stdout.write(chunk));
  child.stderr?.on('data', (chunk) => stderr.write(chunk));
  let launchError = null;
  child.once('error', (error) => {
    launchError = error;
  });
  try {
    await waitForManagedScanAppReady(child, port, {
      ...options,
      getLaunchErrorFn: () => launchError,
    });
    return child;
  } catch (error) {
    try {
      (options.stopProcessTreeFn || stopProcessTree)(child.pid);
    } catch (_cleanupError) {
      try {
        child.kill();
      } catch (_killError) {
        // Preserve the startup error after best-effort cleanup.
      }
    }
    throw error;
  }
}

async function stopManagedScanApp(child, port, options = {}) {
  if (!child || (child.exitCode !== null && child.exitCode !== undefined)) {
    return;
  }
  const stopProcessTreeFn = options.stopProcessTreeFn || stopProcessTree;
  const waitForPortReleasedFn = options.waitForPortReleasedFn || waitForPortReleased;
  stopProcessTreeFn(child.pid);
  const released = await waitForPortReleasedFn(port, {
    timeoutMs: Number(options.timeoutMs || MANAGED_SUPPORT_APP_PORT_REUSE_TIMEOUT_MS),
    pollIntervalMs: Number(options.pollIntervalMs || 250),
  });
  if (!released) {
    throw new Error(`Managed scan app port ${port} was not reusable after teardown.`);
  }
}

function probeHttpStatusReady(url, options = {}) {
  const requestTimeoutMs = Number(options.requestTimeoutMs || 1000);
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(Number(response.statusCode || 0) >= 200 && Number(response.statusCode || 0) < 300);
    });
    request.once('error', () => resolve(false));
    request.setTimeout(requestTimeoutMs, () => {
      request.destroy();
      resolve(false);
    });
  });
}

function probeHttpResponseComplete(url, options = {}) {
  return fetchHttpResponseComplete(url, options).then((response) => response.ok);
}

function fetchHttpResponseComplete(url, options = {}) {
  const requestTimeoutMs = Number(
    options.requestTimeoutMs || MANAGED_FUNCTIONAL_FIXTURE_WARMUP_TIMEOUT_MS,
  );
  const maximumBodyBytes = Number(options.maximumBodyBytes || (64 * 1024 * 1024));
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = http.get(url, (response) => {
      const successful = Number(response.statusCode || 0) >= 200
        && Number(response.statusCode || 0) < 300;
      const chunks = [];
      let bodyBytes = 0;
      response.on('data', (chunk) => {
        bodyBytes += chunk.length;
        if (bodyBytes > maximumBodyBytes) {
          response.destroy();
          finish({ ok: false, statusCode: Number(response.statusCode || 0), body: '' });
          return;
        }
        chunks.push(chunk);
      });
      response.once('end', () => finish({
        ok: successful,
        statusCode: Number(response.statusCode || 0),
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      response.once('error', () => finish({
        ok: false,
        statusCode: Number(response.statusCode || 0),
        body: '',
      }));
    });
    request.once('error', () => finish({ ok: false, statusCode: 0, body: '' }));
    request.setTimeout(requestTimeoutMs, () => {
      request.destroy();
      finish({ ok: false, statusCode: 0, body: '' });
    });
  });
}

function collectLocalCoverPreviewUrls(value, baseUrl, found = new Set(), options = {}) {
  if (typeof value === 'string') {
    if (!value.startsWith('/cover?')) return found;
    try {
      const candidate = new URL(value, baseUrl);
      const expectedOrigin = new URL(baseUrl).origin;
      if (candidate.origin === expectedOrigin && candidate.pathname === '/cover') {
        found.add(candidate.toString());
      }
    } catch {
      // Ignore malformed values from a response that will fail its owning contract elsewhere.
    }
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLocalCoverPreviewUrls(item, baseUrl, found, options);
    return found;
  }
  if (value && typeof value === 'object') {
    const mediaRoot = String(options.mediaRoot || '').trim();
    const coverPath = String(value.cover_path || '').trim();
    if (mediaRoot && coverPath) {
      const resolvedMediaRoot = path.resolve(mediaRoot);
      const resolvedCoverPath = path.resolve(coverPath);
      const relativeCoverPath = path.relative(resolvedMediaRoot, resolvedCoverPath);
      if (
        relativeCoverPath
        && !relativeCoverPath.startsWith('..')
        && !path.isAbsolute(relativeCoverPath)
      ) {
        const candidate = new URL('/cover', baseUrl);
        candidate.searchParams.set('path', resolvedCoverPath);
        candidate.searchParams.set('size', '480');
        found.add(candidate.toString());
      }
    }
    for (const item of Object.values(value)) {
      collectLocalCoverPreviewUrls(item, baseUrl, found, options);
    }
  }
  return found;
}

async function prewarmFunctionalFixture(port, options = {}) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const indexUrl = `${baseUrl}/?surface=albums`;
  const viewUrl = `${baseUrl}/view-data?surface=albums&omit_sidebar=1`;
  const fetchHttpResponseCompleteFn = options.fetchHttpResponseCompleteFn
    || fetchHttpResponseComplete;
  const indexResponse = await fetchHttpResponseCompleteFn(indexUrl, {
    requestTimeoutMs: MANAGED_FUNCTIONAL_FIXTURE_WARMUP_TIMEOUT_MS,
  });
  if (!indexResponse?.ok) return false;
  const viewResponse = await fetchHttpResponseCompleteFn(viewUrl, {
    requestTimeoutMs: MANAGED_FUNCTIONAL_FIXTURE_WARMUP_TIMEOUT_MS,
  });
  if (!viewResponse?.ok) return false;

  let payload;
  try {
    payload = JSON.parse(String(viewResponse.body || ''));
  } catch {
    return false;
  }
  const coverUrls = [...collectLocalCoverPreviewUrls(payload, baseUrl, new Set(), {
    mediaRoot: options.mediaRoot,
  })].sort();
  if (coverUrls.length === 0) return false;
  for (let offset = 0; offset < coverUrls.length; offset += 4) {
    const responses = await Promise.all(
      coverUrls.slice(offset, offset + 4).map((coverUrl) => fetchHttpResponseCompleteFn(
        coverUrl,
        { requestTimeoutMs: MANAGED_FUNCTIONAL_FIXTURE_WARMUP_TIMEOUT_MS },
      )),
    );
    if (responses.some((response) => !response?.ok)) return false;
  }
  for (const pathname of ['/utilities/problematic-files', '/utilities/rules']) {
    const response = await fetchHttpResponseCompleteFn(`${baseUrl}${pathname}`, {
      requestTimeoutMs: MANAGED_FUNCTIONAL_FIXTURE_WARMUP_TIMEOUT_MS,
    });
    if (!response?.ok) return false;
  }
  return true;
}

async function waitForFunctionalFixtureBackgroundIdle(child, port, options = {}) {
  const timeoutMs = Number(options.timeoutMs || MANAGED_FUNCTIONAL_FIXTURE_WARMUP_TIMEOUT_MS);
  const pollIntervalMs = Number(options.pollIntervalMs || 250);
  const stablePollCount = Math.max(1, Number(options.stablePollCount || 2));
  const fetchHttpResponseCompleteFn = options.fetchHttpResponseCompleteFn
    || fetchHttpResponseComplete;
  const sleepFn = options.sleepFn || sleep;
  const nowFn = options.nowFn || Date.now;
  const statusUrl = `http://127.0.0.1:${port}/status`;
  const deadline = nowFn() + timeoutMs;
  let consecutiveIdlePolls = 0;
  let lastStatus = null;

  while (nowFn() <= deadline) {
    if (child.exitCode !== null && child.exitCode !== undefined) {
      throw new Error(
        `Managed functional fixture app exited before background readiness with code ${String(child.exitCode)}.`,
      );
    }
    const response = await fetchHttpResponseCompleteFn(statusUrl, {
      requestTimeoutMs: Math.min(timeoutMs, 5000),
    });
    try {
      lastStatus = response?.ok ? JSON.parse(String(response.body || '')) : null;
    } catch {
      lastStatus = null;
    }
    const idle = Boolean(
      lastStatus
      && lastStatus.scan_in_progress === false
      && lastStatus.relations_in_progress === false
      && lastStatus.covers_in_progress === false
      && lastStatus.pending_cover_refresh_after_scan === false
    );
    consecutiveIdlePolls = idle ? consecutiveIdlePolls + 1 : 0;
    if (consecutiveIdlePolls >= stablePollCount) return;
    await sleepFn(pollIntervalMs);
  }
  throw new Error(
    `Timed out after ${timeoutMs} ms waiting for functional fixture background work to become idle at `
    + `${statusUrl}. Last status: ${JSON.stringify(lastStatus)}`,
  );
}

async function waitForManagedIsolatedAppReady(child, port, options = {}) {
  const timeoutMs = Number(options.timeoutMs || MANAGED_ISOLATED_APP_STARTUP_TIMEOUT_MS);
  const pollIntervalMs = Number(options.pollIntervalMs || 100);
  const probeHttpStatusReadyFn = options.probeHttpStatusReadyFn || probeHttpStatusReady;
  const sleepFn = options.sleepFn || sleep;
  const nowFn = options.nowFn || Date.now;
  const getLaunchErrorFn = options.getLaunchErrorFn || (() => null);
  const statusUrl = `http://127.0.0.1:${port}/status`;
  const deadline = nowFn() + timeoutMs;
  while (nowFn() <= deadline) {
    const launchError = getLaunchErrorFn();
    if (launchError) {
      throw new Error(`Managed isolated app failed before readiness: ${launchError.message || launchError}`);
    }
    if (child.exitCode !== null && child.exitCode !== undefined) {
      throw new Error(`Managed isolated app exited before readiness with code ${String(child.exitCode)}.`);
    }
    if (await probeHttpStatusReadyFn(statusUrl, options)) {
      return;
    }
    await sleepFn(pollIntervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for managed isolated app at ${statusUrl}.`);
}

function waitForDirectChildExit(child, options = {}) {
  const timeoutMs = Number(options.timeoutMs || RECLAIMED_PROCESS_EXIT_TIMEOUT_MS);
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
  if (child.exitCode !== null && child.exitCode !== undefined) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeoutFn(timer);
      child.removeListener('exit', onExit);
      child.removeListener('close', onExit);
      if (error) reject(error);
      else resolve();
    };
    const onExit = () => finish();
    timer = setTimeoutFn(() => {
      finish(new Error(`Timed out after ${timeoutMs} ms aborting managed isolated app PID ${child.pid}.`));
    }, timeoutMs);
    child.once('exit', onExit);
    child.once('close', onExit);
  });
}

async function abortManagedIsolatedAppStartup(child, options = {}) {
  const waitForDirectChildExitFn = options.waitForDirectChildExitFn || waitForDirectChildExit;
  const exitPromise = waitForDirectChildExitFn(child, {
    timeoutMs: RECLAIMED_PROCESS_EXIT_TIMEOUT_MS,
  });
  child.kill('SIGKILL');
  await exitPromise;
}

async function startManagedIsolatedApp(childEnv, options = {}) {
  const spawnFn = options.spawnFn || spawn;
  const port = Number(options.port || childEnv.PLAYWRIGHT_PORT || 4173);
  const providerPort = Number(options.providerPort || childEnv.PLAYWRIGHT_PROVIDER_PORT || port + 2);
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const readProcessCreationIdentityFn = options.readProcessCreationIdentityFn || readProcessCreationIdentity;
  const managedEnv = buildAndAssertProviderWriteSafeEnv(buildIsolatedLibraryCleanupEnv({
    ...childEnv,
    [MANAGED_ISOLATED_APP_ENV]: '1',
    PLAYWRIGHT_PORT: String(port),
    PLAYWRIGHT_PROVIDER_PORT: String(providerPort),
    ALBUM_HAVEN_FAKE_E2E_PROVIDER_BASE_URL: `http://127.0.0.1:${providerPort}`,
  }));
  const child = spawnFn(
    resolvePlaywrightPython(managedEnv),
    [
      ISOLATED_LIBRARY_APP_PATH,
      '--port',
      String(port),
      '--provider-port',
      String(providerPort),
      ...(options.seedAllFunctionalCoverMisses
        ? ['--seed-all-functional-cover-misses']
        : []),
    ],
    {
      cwd: repoRoot,
      env: managedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    },
  );
  let spawnHandedOff = false;
  if (typeof options.onSpawnFn === 'function') {
    options.onSpawnFn(child);
    spawnHandedOff = true;
  }
  child.stdout?.on('data', (chunk) => stdout.write(chunk));
  child.stderr?.on('data', (chunk) => stderr.write(chunk));
  let launchError = null;
  child.once('error', (error) => {
    launchError = error;
  });
  try {
    child.albumHavenCreationIdentity = readProcessCreationIdentityFn(child.pid);
    if (!child.albumHavenCreationIdentity) {
      throw new Error('Managed isolated app process had no creation identity after launch.');
    }
    await waitForManagedIsolatedAppReady(child, port, {
      ...options,
      getLaunchErrorFn: () => launchError,
    });
    if (String(childEnv.ALBUM_HAVEN_FIXTURE_PROFILE || '').trim() === 'functional-core') {
      const prewarmFunctionalFixtureFn = options.prewarmFunctionalFixtureFn
        || prewarmFunctionalFixture;
      const warmed = await prewarmFunctionalFixtureFn(port, {
        fetchHttpResponseCompleteFn: options.fetchHttpResponseCompleteFn,
        mediaRoot: childEnv.ALBUM_HAVEN_MEDIA_ROOT,
      });
      if (!warmed) {
        throw new Error(
          `Managed functional fixture did not complete its gallery and cover warmup on port ${port}.`,
        );
      }
      const waitForFunctionalFixtureBackgroundIdleFn = (
        options.waitForFunctionalFixtureBackgroundIdleFn
        || waitForFunctionalFixtureBackgroundIdle
      );
      await waitForFunctionalFixtureBackgroundIdleFn(child, port, {
        fetchHttpResponseCompleteFn: options.fetchHttpResponseCompleteFn,
      });
    }
    return child;
  } catch (error) {
    if (!spawnHandedOff) {
      try {
        await stopManagedIsolatedApp(child, [port, providerPort], options);
      } catch (_cleanupError) {
        // Preserve the startup/readiness error for direct callers.
      }
    }
    throw error;
  }
}

async function stopManagedIsolatedApp(child, ports, options = {}) {
  if (!child) return;
  const expectedCreationIdentity = String(child.albumHavenCreationIdentity || '');
  const readProcessCreationIdentityFn = options.readProcessCreationIdentityFn || readProcessCreationIdentity;
  const stopProcessTreeFn = options.stopProcessTreeFn || stopProcessTree;
  const waitForReclaimedProcessesExitedFn = options.waitForReclaimedProcessesExitedFn
    || waitForReclaimedProcessesExited;
  const waitForPortReleasedFn = options.waitForPortReleasedFn || waitForPortReleased;
  if (!expectedCreationIdentity) {
    await (options.abortManagedIsolatedAppStartupFn || abortManagedIsolatedAppStartup)(child, options);
  } else {
    const currentIdentity = readProcessCreationIdentityFn(child.pid);
    if (currentIdentity && currentIdentity !== expectedCreationIdentity) {
      throw new Error(`Managed isolated app PID ${child.pid} changed creation identity before teardown.`);
    }
    if (currentIdentity === expectedCreationIdentity) {
      stopProcessTreeFn(child.pid, { expectedCreationIdentity });
      await waitForReclaimedProcessesExitedFn([
        { pid: child.pid, creationIdentity: expectedCreationIdentity },
      ], {
        timeoutMs: RECLAIMED_PROCESS_EXIT_TIMEOUT_MS,
        pollIntervalMs: 250,
      });
    }
  }
  for (const port of [...new Set(Array.isArray(ports) ? ports : [])]) {
    const released = await waitForPortReleasedFn(port, {
      timeoutMs: MANAGED_SUPPORT_APP_PORT_REUSE_TIMEOUT_MS,
      pollIntervalMs: 250,
      // The owned process tree has already exited with its creation identity
      // verified. A stable exclusive bind proves that each loopback port is
      // reusable, including when an unrelated process races to claim it,
      // without repeatedly launching the expensive Windows TCP-owner probe.
      readPortOwningProcessesFn: () => [],
    });
    if (!released) {
      throw new Error(`Managed isolated app port ${port} was not reusable after teardown.`);
    }
  }
}

function writeJsonAtomically(targetPath, value) {
  const temporaryPath = `${targetPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, 'utf8');
  try {
    fs.rmSync(targetPath, { force: true });
    fs.renameSync(temporaryPath, targetPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function createManagedIsolatedAppRestartController(options = {}) {
  const {
    childEnv,
    ownedIsolatedTempRoot,
    initialChild,
    ports = [],
  } = options;
  if (!childEnv || typeof childEnv !== 'object') {
    throw new Error('Managed isolated restart controller requires a child environment.');
  }
  if (!ownedIsolatedTempRoot) {
    throw new Error('Managed isolated restart controller requires a runner-owned temp root.');
  }

  const resolvedOwnedRoot = path.resolve(ownedIsolatedTempRoot);
  const controlDirectory = path.resolve(resolvedOwnedRoot, 'restart-control');
  if (path.dirname(controlDirectory) !== resolvedOwnedRoot) {
    throw new Error('Managed isolated restart control directory escaped its runner-owned temp root.');
  }
  fs.mkdirSync(controlDirectory, { recursive: true });
  childEnv[MANAGED_ISOLATED_RESTART_CONTROL_DIR_ENV] = controlDirectory;

  const requestPath = path.join(controlDirectory, MANAGED_ISOLATED_RESTART_REQUEST_FILE);
  const ackPath = path.join(controlDirectory, MANAGED_ISOLATED_RESTART_ACK_FILE);
  const startManagedIsolatedAppFn = options.startManagedIsolatedAppFn || startManagedIsolatedApp;
  const stopManagedIsolatedAppFn = options.stopManagedIsolatedAppFn || stopManagedIsolatedApp;
  const onCurrentChildChanged = options.onCurrentChildChanged || (() => {});
  const resolvedAppPort = Number(options.port || ports[0] || childEnv.PLAYWRIGHT_PORT || 4173);
  const resolvedProviderPort = Number(
    options.providerPort || ports[1] || childEnv.PLAYWRIGHT_PROVIDER_PORT || resolvedAppPort + 2,
  );
  const seedAllFunctionalCoverMisses = options.seedAllFunctionalCoverMisses === true;
  const managedPorts = [resolvedAppPort, resolvedProviderPort];
  const pollIntervalMs = Number(
    options.pollIntervalMs || MANAGED_ISOLATED_RESTART_POLL_INTERVAL_MS,
  );
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;

  let currentChild = initialChild || null;
  let currentChildRecord = null;
  let childGeneration = 0;
  let failure = null;
  let closed = false;
  let pollTimer = null;
  let activeRequestPromise = null;
  let lastProcessedNonce = '';
  let resolveFailureSignal;
  const failureSignal = new Promise((resolve) => {
    resolveFailureSignal = resolve;
  });

  const recordFailure = (error) => {
    if (failure) return failure;
    failure = error instanceof Error ? error : new Error(String(error));
    resolveFailureSignal(failure);
    return failure;
  };

  const observeCurrentChild = (child, phase) => {
    if (!child) {
      currentChildRecord = null;
      return;
    }
    const record = {
      child,
      generation: ++childGeneration,
      intentionalStop: false,
      phase: String(phase || 'playwright-run'),
      terminated: false,
    };
    currentChildRecord = record;
    const observeTermination = (event, exitCode, signal) => {
      if (record.terminated) return;
      record.terminated = true;
      if (record.intentionalStop || record !== currentChildRecord || failure) return;
      const termination = {
        generation: record.generation,
        pid: Number.isInteger(Number(child.pid)) ? Number(child.pid) : null,
        creationIdentity: String(child.albumHavenCreationIdentity || '') || null,
        event,
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal: signal ? String(signal) : null,
        phase: record.phase,
        timestamp: new Date().toISOString(),
      };
      const error = new Error(
        `Managed isolated app generation ${record.generation} PID ${String(termination.pid)} unexpectedly exited.`,
      );
      error.code = 'MANAGED_ISOLATED_APP_UNEXPECTED_EXIT';
      error.lifecycle = {
        exitReason: 'managed-isolated-app-unexpected-exit',
        managedIsolatedAppExit: termination,
      };
      recordFailure(error);
    };
    child.once('exit', (exitCode, signal) => observeTermination('exit', exitCode, signal));
    child.once('close', (exitCode, signal) => observeTermination('close', exitCode, signal));
    if (child.exitCode !== null && child.exitCode !== undefined) {
      observeTermination('exit', child.exitCode, child.signalCode || null);
    }
  };

  const markCurrentChildStopIntentional = (phase) => {
    if (!currentChildRecord || currentChildRecord.child !== currentChild) return;
    currentChildRecord.intentionalStop = true;
    currentChildRecord.phase = String(phase || currentChildRecord.phase);
  };

  const updateCurrentChild = (child, phase = 'playwright-run') => {
    if (currentChild === child && currentChildRecord?.child === child) {
      currentChildRecord.phase = String(phase || currentChildRecord.phase);
      return;
    }
    currentChild = child || null;
    observeCurrentChild(currentChild, phase);
    onCurrentChildChanged(currentChild);
  };

  if (currentChild) observeCurrentChild(currentChild, 'playwright-run');

  const readPendingRequest = () => {
    if (!fs.existsSync(requestPath)) return null;
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
    const nonce = String(request?.nonce || '').trim();
    if (!nonce || nonce.length > 256) {
      throw new Error('Managed isolated restart request requires a valid nonce.');
    }
    return { nonce };
  };

  const processPendingRequest = async () => {
    if (activeRequestPromise) return activeRequestPromise;
    activeRequestPromise = (async () => {
      let request = null;
      let phase = 'read-request';
      try {
        if (failure) throw failure;
        if (closed) return false;
        request = readPendingRequest();
        if (!request || request.nonce === lastProcessedNonce) return false;
        lastProcessedNonce = request.nonce;
        fs.rmSync(ackPath, { force: true });

        if (currentChild) {
          phase = 'stop-current';
          const childToStop = currentChild;
          markCurrentChildStopIntentional(phase);
          await stopManagedIsolatedAppFn(childToStop, managedPorts);
          if (currentChild === childToStop) updateCurrentChild(null);
        }

        phase = 'start-replacement';
        const replacementEnv = {
          ...childEnv,
          [MANAGED_ISOLATED_PRESERVE_ON_SHUTDOWN_ENV]: '1',
          [MANAGED_ISOLATED_REUSE_STATE_ENV]: '1',
        };
        const replacementChild = await startManagedIsolatedAppFn(replacementEnv, {
          port: resolvedAppPort,
          providerPort: resolvedProviderPort,
          seedAllFunctionalCoverMisses,
          onSpawnFn(child) {
            updateCurrentChild(child, 'start-replacement');
          },
        });
        if (currentChild !== replacementChild) updateCurrentChild(replacementChild, 'start-replacement');
        else if (currentChildRecord) currentChildRecord.phase = 'playwright-run';
        phase = 'publish-ready';
        writeJsonAtomically(ackPath, { nonce: request.nonce, status: 'ready' });
        return true;
      } catch (error) {
        const recordedFailure = recordFailure(error);
        if (request?.nonce) {
          const safeMessage = String(recordedFailure.message || 'managed app restart failed')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 256);
          writeJsonAtomically(ackPath, {
            nonce: request.nonce,
            status: 'failed',
            phase,
            error: safeMessage || 'managed app restart failed',
          });
        } else {
          fs.rmSync(ackPath, { force: true });
        }
        throw recordedFailure;
      }
    })();

    try {
      return await activeRequestPromise;
    } finally {
      activeRequestPromise = null;
    }
  };

  const schedulePoll = () => {
    if (closed || failure || pollTimer) return;
    pollTimer = setTimeoutFn(async () => {
      pollTimer = null;
      try {
        await processPendingRequest();
      } catch (_error) {
        // The attempt observes getFailure() and fails closed after Playwright returns.
      }
      schedulePoll();
    }, pollIntervalMs);
    pollTimer.unref?.();
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    markCurrentChildStopIntentional('final-cleanup');
    if (pollTimer) {
      clearTimeoutFn(pollTimer);
      pollTimer = null;
    }
    if (activeRequestPromise) {
      try {
        await activeRequestPromise;
      } catch (_error) {
        // The recorded failure remains available through getFailure().
      }
    }
  };

  if (options.autoStart !== false) schedulePoll();

  return {
    controlDirectory,
    requestPath,
    ackPath,
    processPendingRequest,
    getCurrentChild: () => currentChild,
    getFailure: () => failure,
    getFailureSignal: () => failureSignal,
    close,
  };
}

function forceAutomatedPerformanceReportClosedEnv(env = {}) {
  return {
    ...env,
    PLAYWRIGHT_OPEN_PERFORMANCE_REPORT: '0',
  };
}

function runPlaywrightProcess(passthroughArgv, childEnv, runTimeoutMs, options = {}) {
  return new Promise((resolve, reject) => {
    assertProviderWriteSafeEnv(childEnv);
    assertManagedRealDataDatabaseEnv(childEnv, {
      managedGenericRealData: childEnv.PLAYWRIGHT_SERVE_REAL_APP === '1'
        && Boolean(resolveManagedFixtureProfile(passthroughArgv))
        && childEnv.PLAYWRIGHT_ISOLATED_LIBRARY_APP !== '1',
    });
    const expectedFixtureProfile = resolveManagedFixtureProfile(passthroughArgv);
    assertManagedSyntheticLargeFixtureEnv(childEnv, {
      managedSyntheticLarge: Boolean(expectedFixtureProfile),
      expectedFixtureProfile,
    });
    const spawnFn = options.spawnFn || spawn;
    const stopProcessTreeFn = options.stopProcessTreeFn || stopProcessTree;
    const reclaimPortFn = options.reclaimPortFn || reclaimPort;
    const waitForPortReleasedFn = options.waitForPortReleasedFn || waitForPortReleased;
    const waitForReclaimedProcessesExitedFn = options.waitForReclaimedProcessesExitedFn
      || waitForReclaimedProcessesExited;
    const readPortOwningProcessesFn = options.readPortOwningProcessesFn || readPortOwningProcesses;
    const readPortOwningProcessIdentitiesFn = options.readPortOwningProcessIdentitiesFn
      || (options.spawnFn ? (() => []) : readPortOwningProcessIdentities);
    const readProcessCreationIdentityFn = options.readProcessCreationIdentityFn
      || (options.spawnFn ? (() => null) : readProcessCreationIdentity);
    const readProcessTreeIdentitiesFn = options.readProcessTreeIdentitiesFn
      || (options.spawnFn ? (() => []) : readProcessTreeIdentities);
    const setTimeoutFn = options.setTimeoutFn || setTimeout;
    const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
    const cleanupIsolatedLibraryDatabaseFn = options.cleanupIsolatedLibraryDatabaseFn
      || (options.spawnFn ? null : cleanupIsolatedLibraryDatabase);
    const stdout = options.stdout || process.stdout;
    const stderr = options.stderr || process.stderr;
    const processObject = options.processObject || process;
    const servesRealApp = childEnv.PLAYWRIGHT_SERVE_REAL_APP === '1';
    const realAppPort = Number(childEnv.PLAYWRIGHT_REAL_APP_PORT || 5001);
    const supportAppPort = Number(childEnv.PLAYWRIGHT_PORT || 4173);
    const providerPort = Number(childEnv.PLAYWRIGHT_PROVIDER_PORT || supportAppPort + 2);
    const managesSupportAppPort = usesManagedSupportAppPort(passthroughArgv);
    const wrapperOwnsIsolatedApp = childEnv[MANAGED_ISOLATED_APP_ENV] === '1';
    const managedPorts = wrapperOwnsIsolatedApp ? [] : resolveManagedWebServerPorts({
      servesRealApp,
      realAppPort,
      supportAppPort,
      providerPort,
      managesSupportAppPort,
      managesProviderPort: !isScanPerformanceConfig(passthroughArgv),
    });
    const resultNonce = String(options.resultNonce || createPlaywrightResultNonce());
    const finalResultControlRequire = `--require=${JSON.stringify(
      playwrightFinalResultControlPath.replace(/\\/g, '/'),
    )}`;
    const inheritedNodeOptions = String(childEnv.NODE_OPTIONS || '').trim();
    const automatedChildEnv = {
      ...forceAutomatedPerformanceReportClosedEnv(childEnv),
      [PLAYWRIGHT_FINAL_RESULT_NONCE_ENV]: resultNonce,
      NODE_OPTIONS: inheritedNodeOptions
        ? `${finalResultControlRequire} ${inheritedNodeOptions}`
        : finalResultControlRequire,
    };
    const child = spawnFn(process.execPath, [playwrightCliPath, ...passthroughArgv], {
      cwd: repoRoot,
      env: automatedChildEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let settlementState = 'running';
    let completionGraceTimer = null;
    let finalizationTimer = null;
    let hardTimeoutTimer = null;
    let combinedOutput = '';
    let stdoutOutput = '';
    let terminalSummaryWritten = false;
    let childExitCode = null;
    let childExitRawCode = null;
    let childExitSignal = null;
    let childClosed = false;
    let childCloseCode = null;
    let childCloseSignal = null;
    let childStopRequested = false;
    let stopReason = 'none';
    let childProcessError = null;
    let portCleanupCompleted = false;
    let cleanupOutcome = 'not-started';
    let reporterFinalizing = false;
    let reporterFailureLatched = false;
    let processFailureLatchWritten = false;
    let terminalCollectionFailureObserved = false;
    let testsCompleteObserved = false;
    let authoritativeFinalObserved = false;
    let hardTimeoutExpired = false;
    let mismatchDiagnosticWritten = false;
    const abortSignal = options.signal;
    let abortReason = null;
    let abortHandler = null;
    let managedRunProcessOwners = [];
    const managedLaunchRootsByPid = new Map();
    const reclaimedProcessOwners = [];
    const portReclaimErrors = [];
    const lifecycle = {
      authoritativeResult: null,
      listOnly: isListOnlyCommand(passthroughArgv),
      fakeDatabaseCleanup: {
        status: 'not-required',
        error: null,
      },
      exitReason: 'running',
    };

    const refreshAuthoritativeResult = () => {
      lifecycle.authoritativeResult = parsePlaywrightFinalResult(stdoutOutput, {
        expectedNonce: resultNonce,
      });
      return lifecycle.authoritativeResult;
    };

    const latchAuthenticatedReporterFailure = (completionSignal) => {
      processObject.exitCode = 1;
      if (processFailureLatchWritten) {
        return;
      }
      processFailureLatchWritten = true;
      const diagnostic = {
        phase: safeClosedValue(completionSignal?.phase, SAFE_FINAL_RESULT_PHASES),
        status: safeClosedValue(completionSignal?.status, SAFE_FINAL_RESULT_STATUSES),
        total: safeNonnegativeInteger(completionSignal?.total),
        completed: safeNonnegativeInteger(completionSignal?.completed),
        failed: safeNonnegativeInteger(completionSignal?.failed),
        skipped: safeNonnegativeInteger(completionSignal?.skipped),
        errors: safeNonnegativeInteger(completionSignal?.errors),
      };
      stderr.write(`[playwright-wrapper-failure-latched] ${JSON.stringify(diagnostic)}\n`);
    };

    const attachLifecycle = (error, exitReason) => {
      lifecycle.exitReason = String(exitReason || 'wrapper-error');
      refreshAuthoritativeResult();
      const nextError = error instanceof Error ? error : new Error(String(error));
      nextError.lifecycle = lifecycle;
      return nextError;
    };

    const emitTerminalSummary = () => {
      if (terminalSummaryWritten) {
        return;
      }
      const summaryText = maybeWritePlaywrightTerminalSummary(combinedOutput, stdout);
      if (summaryText) {
        terminalSummaryWritten = true;
      }
    };

    const clearTimers = () => {
      if (completionGraceTimer) {
        clearTimeoutFn(completionGraceTimer);
        completionGraceTimer = null;
      }
      if (hardTimeoutTimer) {
        clearTimeoutFn(hardTimeoutTimer);
        hardTimeoutTimer = null;
      }
      if (finalizationTimer) {
        clearTimeoutFn(finalizationTimer);
        finalizationTimer = null;
      }
    };

    const finish = (callback) => {
      if (settlementState === 'settled') {
        return;
      }
      settlementState = 'settled';
      clearTimers();
      if (abortHandler) abortSignal?.removeEventListener('abort', abortHandler);
      callback();
    };

    const stopChildProcess = (reason = 'unspecified') => {
      if (childClosed || childStopRequested) {
        return;
      }
      childStopRequested = true;
      stopReason = String(reason || 'unspecified');
      try {
        stopProcessTreeFn(child.pid);
      } catch (_error) {
        try {
          child.kill();
        } catch (_innerError) {
          // Best-effort cleanup only.
        }
      }
    };

    abortHandler = () => {
      abortReason = abortSignal.reason instanceof Error
        ? abortSignal.reason
        : new Error(String(abortSignal.reason || 'Playwright run aborted.'));
      childProcessError = abortReason;
      stopChildProcess('abort-signal');
      if (childClosed) finish(() => reject(abortReason));
    };
    if (abortSignal?.aborted) abortHandler();
    else abortSignal?.addEventListener('abort', abortHandler, { once: true });

    const emitAuthoritativePassMismatchDiagnostic = (reason) => {
      if (mismatchDiagnosticWritten) {
        return;
      }
      mismatchDiagnosticWritten = true;
      const processError = safeErrorSummary(childProcessError);
      const diagnostic = `[playwright-wrapper-diagnostic] ${JSON.stringify({
        reason: String(reason || 'authoritative-pass-mismatch'),
        childExitCode: childExitRawCode,
        childExitSignal,
        childCloseCode,
        childCloseSignal,
        processError,
        stopReason,
        cleanupOutcome,
      })}\n`;
      combinedOutput += diagnostic;
      stderr.write(diagnostic);
    };

    const completeReporterRun = async (exitCode) => {
      if (reporterFinalizing || settlementState === 'settled') {
        return;
      }
      reporterFinalizing = true;
      settlementState = 'reporter-finalizing';
      if (
        !servesRealApp
        && isDefaultIsolatedLibraryConfig(passthroughArgv)
        && !wrapperOwnsIsolatedApp
        && cleanupIsolatedLibraryDatabaseFn
      ) {
        if (portReclaimErrors.length > 0) {
          throw new Error(
            'Could not safely snapshot and reclaim all isolated Playwright port owners: '
            + portReclaimErrors.map((error) => String(error?.message || error)).join('; '),
          );
        }
        lifecycle.fakeDatabaseCleanup.status = 'running';
        try {
          cleanupIsolatedLibraryDatabaseFn(childEnv);
          lifecycle.fakeDatabaseCleanup.status = 'completed';
        } catch (error) {
          lifecycle.fakeDatabaseCleanup.status = 'failed';
          lifecycle.fakeDatabaseCleanup.error = safeErrorSummary(error);
          throw attachLifecycle(error, 'fake-database-cleanup-error');
        }
      }
      emitTerminalSummary();
      const combinedExitCode = (
        exitCode === 0
        && childProcessError === null
        && childClosed
        && childExitCode === 0
      ) ? 0 : 1;
      if (combinedExitCode !== 0) {
        emitAuthoritativePassMismatchDiagnostic('wrapper-child-lifecycle-mismatch');
      }
      lifecycle.exitReason = combinedExitCode === 0
        ? 'authoritative-pass'
        : 'wrapper-child-lifecycle-mismatch';
      refreshAuthoritativeResult();
      finish(() => resolve({ exitCode: combinedExitCode, combinedOutput, lifecycle }));
    };

    const tryFinalizeReporterRun = async () => {
      if (!portCleanupCompleted || reporterFinalizing || settlementState === 'settled') {
        return false;
      }
      const reporterExitCode = resolvePlaywrightCompletionExitCode(stdoutOutput, {
        childEnv,
        listOnly: isListOnlyCommand(passthroughArgv),
        expectedNonce: resultNonce,
      });
      const processFailed = reporterFailureLatched
        || childProcessError !== null
        || (childExitCode !== null && childExitCode !== 0);
      if (processFailed) {
        if (!childClosed) {
          stopChildProcess();
          return false;
        }
        await completeReporterRun(1);
        return true;
      }
      if (reporterExitCode === 1) {
        if (!childClosed) {
          stopChildProcess();
          return false;
        }
        await completeReporterRun(1);
        return true;
      }
      if (reporterExitCode === 0 && childClosed && childExitCode === 0) {
        await completeReporterRun(0);
        return true;
      }
      return false;
    };

    const scheduleFinalizationTimeout = () => {
      if (
        runTimeoutMs <= PLAYWRIGHT_FINALIZATION_GRACE_MS
        || finalizationTimer
        || reporterFinalizing
        || settlementState === 'settled'
      ) {
        return;
      }
      finalizationTimer = setTimeoutFn(() => {
        void (async () => {
          if (reporterFinalizing || settlementState === 'settled') {
            return;
          }
          childProcessError = childProcessError
            || new Error(
              authoritativeFinalObserved
                ? 'Playwright did not close naturally after producing an authoritative final result.'
                : testsCompleteObserved
                  ? 'Playwright did not produce an authoritative final result after tests completed.'
                  : 'Playwright did not close naturally after a terminal collection failure.',
            );
          stopChildProcess('finalization-timeout');
          if (!portCleanupCompleted) {
            settlementState = 'reporter-grace';
            await beginReporterCleanup();
          }
          await completeReporterRun(1);
        })().catch((error) => {
          stopChildProcess();
          finish(() => reject(error));
        });
      }, PLAYWRIGHT_FINALIZATION_GRACE_MS);
    };

    const beginReporterCleanup = async () => {
      if (settlementState !== 'reporter-grace') {
        return;
      }
      settlementState = 'reporter-cleanup';
      cleanupOutcome = 'in-progress';
      try {
        for (const launchRoot of managedLaunchRootsByPid.values()) {
          if (launchRoot.pid === child.pid) {
            continue;
          }
          if (readProcessCreationIdentityFn(launchRoot.pid) !== launchRoot.creationIdentity) {
            continue;
          }
          stopProcessTreeFn(launchRoot.pid, {
            expectedCreationIdentity: launchRoot.creationIdentity,
          });
          reclaimedProcessOwners.push(...launchRoot.capturedSubtree);
        }
        for (const managedPort of managedPorts) {
          try {
            const reclaimedOwners = reclaimPortFn(managedPort, {
              allowedOwners: managedRunProcessOwners,
            });
            if (Array.isArray(reclaimedOwners)) {
              reclaimedProcessOwners.push(...reclaimedOwners);
            }
          } catch (portCleanupError) {
            portReclaimErrors.push(portCleanupError);
          }
        }
        if (reclaimedProcessOwners.length > 0) {
          await waitForReclaimedProcessesExitedFn(reclaimedProcessOwners, {
            timeoutMs: RECLAIMED_PROCESS_EXIT_TIMEOUT_MS,
            pollIntervalMs: 250,
          });
        }
        portCleanupCompleted = true;
        cleanupOutcome = portReclaimErrors.length > 0 ? 'completed-with-reclaim-errors' : 'completed';
        settlementState = authoritativeFinalObserved ? 'awaiting-child-close' : 'awaiting-final';
        if (hardTimeoutExpired) {
          await completeReporterRun(1);
          return;
        }
        const finalized = await tryFinalizeReporterRun();
        if (!finalized && (
          authoritativeFinalObserved
          || testsCompleteObserved
          || terminalCollectionFailureObserved
        )) {
          scheduleFinalizationTimeout();
        }
      } catch (error) {
        cleanupOutcome = 'failed';
        throw error;
      }
    };

    const snapshotManagedRunProcessOwners = () => {
      try {
        const processOwners = readProcessTreeIdentitiesFn(child.pid);
        if (Array.isArray(processOwners) && processOwners.length > 0) {
          managedRunProcessOwners = processOwners;
        }
      } catch (_error) {
        // Preserve an earlier authenticated lifecycle snapshot if the child is already exiting.
      }
    };

    const snapshotManagedServiceOwners = () => {
      const managedRunOwnersByPid = new Map(managedRunProcessOwners.map((owner) => [owner.pid, owner]));
      const resolveLaunchRoot = (portOwner) => {
        let current = managedRunOwnersByPid.get(portOwner.pid);
        const visited = new Set();
        while (current && current.pid !== child.pid && !visited.has(current.pid)) {
          visited.add(current.pid);
          if (current.parentPid === child.pid) {
            return current;
          }
          current = managedRunOwnersByPid.get(current.parentPid);
        }
        return null;
      };
      const belongsToLaunchRoot = (processOwner, launchRootPid) => {
        let current = processOwner;
        const visited = new Set();
        while (current && current.pid !== child.pid && !visited.has(current.pid)) {
          if (current.pid === launchRootPid) {
            return true;
          }
          visited.add(current.pid);
          current = managedRunOwnersByPid.get(current.parentPid);
        }
        return false;
      };
      for (const managedPort of managedPorts) {
        let portOwners;
        try {
          portOwners = readPortOwningProcessIdentitiesFn(managedPort);
        } catch (error) {
          portReclaimErrors.push(error);
          continue;
        }
        for (const owner of Array.isArray(portOwners) ? portOwners : []) {
          const pid = Number(owner?.pid);
          const creationIdentity = String(owner?.creationIdentity || '').trim();
          if (
            !Number.isInteger(pid)
            || pid <= 0
            || !creationIdentity
            || pid === child.pid
            || managedRunOwnersByPid.get(pid)?.creationIdentity !== creationIdentity
          ) {
            continue;
          }
          const launchRoot = resolveLaunchRoot({ pid, creationIdentity });
          if (!launchRoot || launchRoot.pid === child.pid) {
            continue;
          }
          const existingRoot = managedLaunchRootsByPid.get(launchRoot.pid);
          if (existingRoot && existingRoot.creationIdentity !== launchRoot.creationIdentity) {
            managedLaunchRootsByPid.delete(launchRoot.pid);
            portReclaimErrors.push(new Error(
              `Managed launch-root PID ${launchRoot.pid} changed identity while port ownership was captured.`,
            ));
            continue;
          }
          managedLaunchRootsByPid.set(launchRoot.pid, {
            pid: launchRoot.pid,
            creationIdentity: launchRoot.creationIdentity,
            capturedSubtree: managedRunProcessOwners
              .filter((processOwner) => belongsToLaunchRoot(processOwner, launchRoot.pid))
              .map((processOwner) => ({
                pid: processOwner.pid,
                creationIdentity: processOwner.creationIdentity,
              })),
          });
        }
      }
    };

    const scheduleTerminalCollectionFailureCleanup = () => {
      if (
        settlementState !== 'running'
        || completionGraceTimer
        || !shouldUseReporterDrivenCompletion({
          servesRealApp,
          childEnv,
          listOnly: isListOnlyCommand(passthroughArgv),
        })
      ) {
        return;
      }
      reporterFailureLatched = true;
      terminalCollectionFailureObserved = true;
      snapshotManagedRunProcessOwners();
      if (hardTimeoutTimer) {
        clearTimeoutFn(hardTimeoutTimer);
        hardTimeoutTimer = null;
      }
      settlementState = 'reporter-grace';
      completionGraceTimer = setTimeoutFn(() => {
        void beginReporterCleanup().catch((error) => {
          stopChildProcess();
          finish(() => reject(error));
        });
      }, PLAYWRIGHT_TERMINAL_COLLECTION_FAILURE_GRACE_MS);
    };

    const relayChunk = (stream, chunk, source) => {
      const text = chunk.toString();
      combinedOutput += text;
      if (source === 'stdout') {
        stdoutOutput += text;
      }
      stream.write(text);

      if (hasTerminalPlaywrightCollectionFailure(combinedOutput)) {
        scheduleTerminalCollectionFailureCleanup();
      }

      const authenticatedSignal = parsePlaywrightFinalResult(stdoutOutput, {
        expectedNonce: resultNonce,
      });
      if (authenticatedSignal && authenticatedSignal.status !== 'passed') {
        latchAuthenticatedReporterFailure(authenticatedSignal);
      }

      const nextSummaryExitCode = resolvePlaywrightCompletionExitCode(stdoutOutput, {
        childEnv,
        listOnly: isListOnlyCommand(passthroughArgv),
        expectedNonce: resultNonce,
      });
      const completionSignal = resolvePlaywrightCompletionSignal(stdoutOutput, {
        childEnv,
        expectedNonce: resultNonce,
      });
      if (completionSignal === null) {
        return;
      }
      if (completionSignal.phase === 'run-error') {
        reporterFailureLatched = true;
        return;
      }
      if (!['tests-complete', 'run-final'].includes(completionSignal.phase)) {
        return;
      }
      if (!shouldUseReporterDrivenCompletion({
        servesRealApp,
        childEnv,
        listOnly: isListOnlyCommand(passthroughArgv),
      })) {
        return;
      }
      snapshotManagedRunProcessOwners();
      if (completionSignal.phase === 'tests-complete' && !testsCompleteObserved) {
        testsCompleteObserved = true;
        snapshotManagedServiceOwners();
      }
      if (!completionGraceTimer) {
        completionGraceTimer = setTimeoutFn(() => {
          void beginReporterCleanup().catch((error) => {
            stopChildProcess();
            finish(() => reject(error));
          });
        }, resolveReporterDrivenCompletionGraceMs({ servesRealApp, childEnv }));
      }
      if (completionSignal.phase === 'run-final') {
        authoritativeFinalObserved = true;
        if (completionGraceTimer) {
          clearTimeoutFn(completionGraceTimer);
          completionGraceTimer = null;
        }
        if (finalizationTimer) {
          clearTimeoutFn(finalizationTimer);
          finalizationTimer = null;
        }
        if (settlementState === 'reporter-cleanup') {
          return;
        }
        if (settlementState !== 'reporter-finalizing' && settlementState !== 'settled') {
          settlementState = 'awaiting-child-close';
          void (async () => {
            const finalized = await tryFinalizeReporterRun();
            if (!finalized) {
              scheduleFinalizationTimeout();
            }
          })().catch((error) => finish(() => reject(error)));
        }
        return;
      }
      if (settlementState !== 'running' && settlementState !== 'reporter-grace') {
        return;
      }
      settlementState = 'reporter-grace';
      if (completionGraceTimer) {
        return;
      }
    };

    child.stdout.on('data', (chunk) => relayChunk(stdout, chunk, 'stdout'));
    child.stderr.on('data', (chunk) => relayChunk(stderr, chunk, 'stderr'));
    child.on('error', (error) => {
      childProcessError = error;
      if (settlementState === 'running') {
        finish(() => reject(error));
        return;
      }
      if (settlementState === 'reporter-grace') {
        void beginReporterCleanup().catch((cleanupError) => {
          stopChildProcess();
          finish(() => reject(cleanupError));
        });
        return;
      }
      void tryFinalizeReporterRun().catch((finalizeError) => finish(() => reject(finalizeError)));
    });
    child.on('exit', (code, signal) => {
      childExitRawCode = code;
      childExitCode = code === null ? 1 : code;
      childExitSignal = signal || null;
    });
    child.on('close', (code, signal) => {
      childClosed = true;
      childCloseCode = code;
      childCloseSignal = signal || null;
      if (childExitCode === null) {
        childExitCode = code === null ? 1 : code;
      }
      if (abortReason) {
        finish(() => reject(abortReason));
        return;
      }
      if (settlementState !== 'running') {
        if (settlementState === 'awaiting-child-close') {
          settlementState = 'reporter-grace';
          void beginReporterCleanup().catch((cleanupError) => {
            stopChildProcess();
            finish(() => reject(cleanupError));
          });
          return;
        }
        if (settlementState === 'reporter-grace') {
          void beginReporterCleanup().catch((cleanupError) => {
            stopChildProcess();
            finish(() => reject(cleanupError));
          });
          return;
        }
        void tryFinalizeReporterRun().catch((error) => finish(() => reject(error)));
        return;
      }
      emitTerminalSummary();
      const finalResultExitCode = resolvePlaywrightFinalResultExitCode(stdoutOutput, {
        listOnly: isListOnlyCommand(passthroughArgv),
        expectedNonce: resultNonce,
      });
      const combinedExitCode = childExitCode === 0 && finalResultExitCode === 0 ? 0 : 1;
      if (combinedExitCode !== 0) {
        emitAuthoritativePassMismatchDiagnostic('child-close-result-mismatch');
      }
      finish(() => resolve({
        exitCode: combinedExitCode,
        combinedOutput,
        lifecycle: {
          ...lifecycle,
          authoritativeResult: parsePlaywrightFinalResult(stdoutOutput, {
            expectedNonce: resultNonce,
          }),
          exitReason: combinedExitCode === 0
            ? 'authoritative-pass'
            : 'child-close-result-mismatch',
        },
      }));
    });

    hardTimeoutTimer = setTimeoutFn(() => {
      if (settlementState !== 'running') {
        if (reporterFinalizing || settlementState === 'settled') {
          return;
        }
        hardTimeoutExpired = true;
        childProcessError = childProcessError
          || new Error(authoritativeFinalObserved
            ? 'Playwright exceeded the run timeout while closing after an authoritative final result.'
            : 'Playwright exceeded the run timeout while waiting for an authoritative final result.');
        stopChildProcess(authoritativeFinalObserved
          ? 'run-timeout-after-authoritative-final'
          : 'run-timeout-awaiting-authoritative-final');
        if (settlementState === 'reporter-cleanup') {
          return;
        }
        void (async () => {
          if (!portCleanupCompleted) {
            settlementState = 'reporter-grace';
            await beginReporterCleanup();
          }
          await completeReporterRun(1);
        })().catch((error) => {
          emitAuthoritativePassMismatchDiagnostic('authoritative-pass-cleanup-error');
          finish(() => reject(error));
        });
        return;
      }
      stopChildProcess('run-timeout');
      finish(() => reject(new Error(`Timed out after ${runTimeoutMs} ms while running Playwright.`)));
    }, runTimeoutMs);
  });
}

function stopProcessTree(pid, options = {}) {
  const runCommandFn = options.runCommandFn || runCommand;
  const processKillFn = options.processKillFn || process.kill.bind(process);
  const readProcessTreeIdentitiesFn = options.readProcessTreeIdentitiesFn
    || readProcessTreeIdentities;
  const readProcessCreationIdentityFn = options.readProcessCreationIdentityFn
    || readProcessCreationIdentity;
  const expectedCreationIdentity = options.expectedCreationIdentity == null
    ? null
    : String(options.expectedCreationIdentity);
  const expectedIdentityMatches = () => (
    expectedCreationIdentity === null
    || readProcessCreationIdentityFn(pid) === expectedCreationIdentity
  );
  const discoverProcessTree = () => readProcessTreeIdentitiesFn(pid, {
    maxDepth: options.maxDepth,
    maxProcesses: options.maxProcesses,
  });
  if (!expectedIdentityMatches()) {
    return;
  }

  let processTree = null;
  if (expectedCreationIdentity !== null) {
    processTree = discoverProcessTree();
    const rootIdentity = processTree.find((processIdentity) => (
      processIdentity.pid === pid && processIdentity.depth === 0
    ));
    if (rootIdentity?.creationIdentity !== expectedCreationIdentity) {
      return;
    }
    if (!expectedIdentityMatches()) {
      return;
    }
  }

  const result = runCommandFn('taskkill', ['/PID', String(pid), '/T', '/F'], {
    stdio: 'pipe',
    windowsHide: true,
    timeout: PROCESS_TREE_STOP_TIMEOUT_MS,
  });
  if (!result.error && result.status === 0) {
    return;
  }

  if (processTree === null) {
    try {
      processTree = discoverProcessTree();
    } catch (discoveryError) {
      throw new Error(
        `Failed to stop process tree ${String(pid)}. `
        + `taskkill status=${String(result.status)}; `
        + `stdout=${JSON.stringify(String(result.stdout || ''))}; `
        + `stderr=${JSON.stringify(String(result.stderr || ''))}; `
        + `error=${result.error ? String(result.error.stack || result.error) : 'none'}; `
        + `fallback discovery error=${String(discoveryError?.stack || discoveryError)}`,
      );
    }
  }

  const fallbackErrors = [];
  const orderedProcessTree = [...processTree].sort((left, right) => right.depth - left.depth);
  for (const processIdentity of orderedProcessTree) {
    let currentIdentity;
    try {
      currentIdentity = readProcessCreationIdentityFn(processIdentity.pid);
    } catch (identityError) {
      fallbackErrors.push(
        `pid=${processIdentity.pid} identity error=${String(identityError?.stack || identityError)}`,
      );
      continue;
    }
    if (currentIdentity !== processIdentity.creationIdentity) {
      continue;
    }
    try {
      processKillFn(processIdentity.pid, 'SIGKILL');
    } catch (fallbackError) {
      if (fallbackError?.code !== 'ESRCH') {
        fallbackErrors.push(
          `pid=${processIdentity.pid} kill error=${String(fallbackError?.stack || fallbackError)}`,
        );
      }
    }
  }

  if (fallbackErrors.length > 0) {
    throw new Error(
      `Failed to stop process tree ${String(pid)}. `
      + `taskkill status=${String(result.status)}; `
      + `stdout=${JSON.stringify(String(result.stdout || ''))}; `
      + `stderr=${JSON.stringify(String(result.stderr || ''))}; `
      + `error=${result.error ? String(result.error.stack || result.error) : 'none'}; `
      + `fallback errors=${fallbackErrors.join('; ')}`,
    );
  }
}

function parseProcessIds(stdout) {
  return String(stdout || '')
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function parseProcessIdentityRecords(stdout) {
  const normalized = String(stdout || '').trim();
  if (!normalized) {
    return [];
  }
  const parsed = JSON.parse(normalized);
  const records = Array.isArray(parsed) ? parsed : [parsed];
  return records
    .map((record) => ({
      pid: Number(record?.pid),
      creationIdentity: String(record?.creationIdentity || '').trim(),
    }))
    .filter((record) => Number.isInteger(record.pid) && record.pid > 0 && record.creationIdentity);
}

function parseProcessTreeIdentityRecords(stdout) {
  const normalized = String(stdout || '').trim();
  if (!normalized) {
    return [];
  }
  const parsed = JSON.parse(normalized);
  const records = Array.isArray(parsed) ? parsed : [parsed];
  return records
    .map((record) => ({
      pid: Number(record?.pid),
      creationIdentity: String(record?.creationIdentity || '').trim(),
      depth: Number(record?.depth),
      parentPid: Number(record?.parentPid),
    }))
    .filter((record) => (
      Number.isInteger(record.pid)
      && record.pid > 0
      && record.creationIdentity
      && Number.isInteger(record.depth)
      && record.depth >= 0
      && Number.isInteger(record.parentPid)
      && record.parentPid >= 0
    ));
}

function readPortOwningProcesses(port, options = {}) {
  const runCommandFn = options.runCommandFn || runCommand;
  const powershellCommand = [
    `$connections = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue;`,
    'if (-not $connections) { return }',
    '$connections | Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { [int]$_ -gt 0 }',
  ].join(' ');
  const result = runCommandFn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-Command', powershellCommand], {
    stdio: 'pipe',
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }

  return [...new Set(parseProcessIds(result.stdout))];
}

function readPortOwningProcessIdentities(port, options = {}) {
  const runCommandFn = options.runCommandFn || runCommand;
  const powershellCommand = [
    `$connections = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue;`,
    '$ownerPids = @($connections | Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { [int]$_ -gt 0 });',
    '$records = @();',
    'foreach ($ownerPid in $ownerPids) {',
    'try {',
    '$ownerProcess = Get-Process -Id $ownerPid -ErrorAction Stop;',
    '$ownerStartTime = $ownerProcess.StartTime;',
    'if ($null -eq $ownerStartTime) { throw "Process $ownerPid has no creation identity." }',
    '$records += [PSCustomObject]@{ pid = [int]$ownerPid; creationIdentity = $ownerStartTime.ToUniversalTime().Ticks.ToString() };',
    '} catch {',
    '$snapshotError = $_;',
    'if (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue) { Write-Error $snapshotError; exit 1 }',
    '}',
    '}',
    'ConvertTo-Json -InputObject $records -Compress',
  ].join(' ');
  const result = runCommandFn(
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-Command', powershellCommand],
    { stdio: 'pipe', windowsHide: true },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Failed to snapshot owners of port ${port}: ${String(result.stderr || '').trim()}`);
  }
  return parseProcessIdentityRecords(result.stdout);
}

function readProcessCreationIdentity(pid, options = {}) {
  const runCommandFn = options.runCommandFn || runCommand;
  const powershellCommand = [
    `try { $ownerProcess = Get-Process -Id ${pid} -ErrorAction Stop;`,
    '$ownerProcess.StartTime.ToUniversalTime().Ticks.ToString()',
    '} catch {',
    `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Write-Error $_; exit 1 }`,
    '}',
  ].join(' ');
  const result = runCommandFn(
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-Command', powershellCommand],
    { stdio: 'pipe', windowsHide: true },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Failed to read creation identity for process ${pid}: ${String(result.stderr || '').trim()}`);
  }
  return String(result.stdout || '').trim() || null;
}

function readProcessTreeIdentities(rootPid, options = {}) {
  const runCommandFn = options.runCommandFn || runCommand;
  const maxDepth = Number(options.maxDepth || WINDOWS_PROCESS_TREE_MAX_DEPTH);
  const maxProcesses = Number(options.maxProcesses || WINDOWS_PROCESS_TREE_MAX_PROCESSES);
  const powershellCommand = [
    "$toolhelpSource = @'",
    'using System;',
    'using System.Collections.Generic;',
    'using System.ComponentModel;',
    'using System.Runtime.InteropServices;',
    'public static class AlbumHavenProcessSnapshot {',
    '  public sealed class Entry {',
    '    public int ProcessId { get; set; }',
    '    public int ParentProcessId { get; set; }',
    '  }',
    '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
    '  private struct PROCESSENTRY32 {',
    '    public uint dwSize;',
    '    public uint cntUsage;',
    '    public uint th32ProcessID;',
    '    public UIntPtr th32DefaultHeapID;',
    '    public uint th32ModuleID;',
    '    public uint cntThreads;',
    '    public uint th32ParentProcessID;',
    '    public int pcPriClassBase;',
    '    public uint dwFlags;',
    '    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]',
    '    public string szExeFile;',
    '  }',
    '  [DllImport("kernel32.dll", SetLastError = true)]',
    '  public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);',
    '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
    '  private static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);',
    '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
    '  private static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);',
    '  [DllImport("kernel32.dll", SetLastError = true)]',
    '  private static extern bool CloseHandle(IntPtr handle);',
    '  public static Entry[] Read() {',
    '    var snapshot = CreateToolhelp32Snapshot(2, 0);',
    '    if (snapshot == new IntPtr(-1)) throw new Win32Exception();',
    '    try {',
    '      var entries = new List<Entry>();',
    '      var entry = new PROCESSENTRY32();',
    '      entry.dwSize = (uint)Marshal.SizeOf(entry);',
    '      if (Process32First(snapshot, ref entry)) {',
    '        do {',
    '          entries.Add(new Entry {',
    '            ProcessId = (int)entry.th32ProcessID,',
    '            ParentProcessId = (int)entry.th32ParentProcessID',
    '          });',
    '        } while (Process32Next(snapshot, ref entry));',
    '      }',
    '      return entries.ToArray();',
    '    } finally {',
    '      CloseHandle(snapshot);',
    '    }',
    '  }',
    '}',
    "'@;",
    'if (-not ("AlbumHavenProcessSnapshot" -as [type])) { Add-Type -TypeDefinition $toolhelpSource }',
    `$rootPid = ${rootPid};`,
    `$maxDepth = ${maxDepth};`,
    `$maxProcesses = ${maxProcesses};`,
    '$allProcesses = @([AlbumHavenProcessSnapshot]::Read());',
    '$childrenByParent = @{};',
    'foreach ($candidate in $allProcesses) {',
    '$parentPid = [int]$candidate.ParentProcessId;',
    'if (-not $childrenByParent.ContainsKey($parentPid)) { $childrenByParent[$parentPid] = @() }',
    '$childrenByParent[$parentPid] += [int]$candidate.ProcessId;',
    '}',
    '$queue = [System.Collections.Generic.Queue[object]]::new();',
    '$queue.Enqueue([PSCustomObject]@{ pid = [int]$rootPid; parentPid = 0; depth = 0 });',
    '$seen = [System.Collections.Generic.HashSet[int]]::new();',
    '$records = @();',
    'while ($queue.Count -gt 0) {',
    '$current = $queue.Dequeue();',
    'if (-not $seen.Add([int]$current.pid)) { continue }',
    'if ($seen.Count -gt $maxProcesses) { throw "Process tree exceeds $maxProcesses processes." }',
    'try {',
    '$currentProcess = Get-Process -Id $current.pid -ErrorAction Stop;',
    '$startTime = $currentProcess.StartTime;',
    'if ($null -eq $startTime) { throw "Process $($current.pid) has no creation identity." }',
    '$records += [PSCustomObject]@{',
    'pid = [int]$current.pid;',
    'parentPid = [int]$current.parentPid;',
    'creationIdentity = $startTime.ToUniversalTime().Ticks.ToString();',
    'depth = [int]$current.depth',
    '};',
    '} catch {',
    '$identityError = $_;',
    'if (Get-Process -Id $current.pid -ErrorAction SilentlyContinue) { Write-Error $identityError; exit 1 }',
    '}',
    '$children = @();',
    'if ($childrenByParent.ContainsKey([int]$current.pid)) {',
    '$children = @($childrenByParent[[int]$current.pid]);',
    '}',
    'if ($children.Count -gt 0 -and $current.depth -ge $maxDepth) {',
    'throw "Process tree exceeds maximum depth $maxDepth at PID $($current.pid)."',
    '}',
    'foreach ($childPid in $children) {',
    '$queue.Enqueue([PSCustomObject]@{ pid = [int]$childPid; parentPid = [int]$current.pid; depth = [int]$current.depth + 1 });',
    '}',
    '}',
    'ConvertTo-Json -InputObject $records -Compress',
  ].join('\n');
  const result = runCommandFn(
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-Command', powershellCommand],
    { stdio: 'pipe', windowsHide: true },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Failed to snapshot process tree ${rootPid}: ${String(result.stderr || '').trim()}`);
  }
  return parseProcessTreeIdentityRecords(result.stdout);
}

function reclaimPort(port, options = {}) {
  const readPortOwningProcessIdentitiesFn = options.readPortOwningProcessIdentitiesFn
    || readPortOwningProcessIdentities;
  const stopProcessTreeFn = options.stopProcessTreeFn || stopProcessTree;
  const readProcessCreationIdentityFn = options.readProcessCreationIdentityFn
    || readProcessCreationIdentity;
  const owningProcesses = readPortOwningProcessIdentitiesFn(port);
  const allowedOwnerKeys = options.allowedOwners == null
    ? null
    : new Set((Array.isArray(options.allowedOwners) ? options.allowedOwners : [])
      .filter((owner) => Number.isInteger(owner?.pid) && owner.pid > 0 && owner.creationIdentity)
      .map((owner) => `${owner.pid}:${String(owner.creationIdentity)}`));
  const reclaimedOwners = [];

  for (const owner of owningProcesses) {
    if (allowedOwnerKeys !== null && !allowedOwnerKeys.has(`${owner.pid}:${owner.creationIdentity}`)) {
      continue;
    }
    if (readProcessCreationIdentityFn(owner.pid) === owner.creationIdentity) {
      stopProcessTreeFn(owner.pid, {
        expectedCreationIdentity: owner.creationIdentity,
      });
      reclaimedOwners.push(owner);
    }
  }

  return reclaimedOwners;
}

function sleep(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

async function waitForReclaimedProcessesExited(processOwners, options = {}) {
  const timeoutMs = Number(options.timeoutMs || RECLAIMED_PROCESS_EXIT_TIMEOUT_MS);
  const pollIntervalMs = Number(options.pollIntervalMs || 250);
  const readProcessCreationIdentityFn = options.readProcessCreationIdentityFn
    || readProcessCreationIdentity;
  const sleepFn = options.sleepFn || sleep;
  const nowFn = options.nowFn || Date.now;
  const owners = [...new Map(
    (Array.isArray(processOwners) ? processOwners : [])
      .filter((owner) => Number.isInteger(owner?.pid) && owner.pid > 0 && owner.creationIdentity)
      .map((owner) => {
        const normalizedOwner = {
          pid: owner.pid,
          creationIdentity: String(owner.creationIdentity),
        };
        return [`${normalizedOwner.pid}:${normalizedOwner.creationIdentity}`, normalizedOwner];
      }),
  ).values()];
  const deadline = nowFn() + timeoutMs;

  while (owners.length > 0) {
    const stillRunning = owners.filter((owner) => (
      readProcessCreationIdentityFn(owner.pid) === owner.creationIdentity
    ));
    if (stillRunning.length === 0) {
      return;
    }
    if (nowFn() >= deadline) {
      const details = stillRunning
        .map((owner) => `pid=${owner.pid} creationIdentity=${owner.creationIdentity}`)
        .join(', ');
      throw new Error(`Timed out after ${timeoutMs} ms waiting for reclaimed process owners to exit: ${details}`);
    }
    await sleepFn(pollIntervalMs);
  }
}

async function waitForPortReleased(port, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 15000);
  const pollIntervalMs = Number(options.pollIntervalMs || 250);
  const stablePollCount = Number(options.stablePollCount || 4);
  const readPortOwningProcessesFn = options.readPortOwningProcessesFn || readPortOwningProcesses;
  const probePortBindableFn = options.probePortBindableFn || probePortBindable;
  const sleepFn = options.sleepFn || sleep;
  const deadline = Date.now() + timeoutMs;
  let consecutiveBindablePolls = 0;

  while (Date.now() <= deadline) {
    const owningProcesses = readPortOwningProcessesFn(port);
    if (owningProcesses.length === 0 && await probePortBindableFn(port, options)) {
      consecutiveBindablePolls += 1;
      if (consecutiveBindablePolls >= stablePollCount) {
        return true;
      }
      await sleepFn(pollIntervalMs);
      continue;
    }

    consecutiveBindablePolls = 0;
    await sleepFn(pollIntervalMs);
  }

  return readPortOwningProcessesFn(port).length === 0 && await probePortBindableFn(port, options);
}

function probePortBindable(port, options = {}) {
  const host = String(options.host || '127.0.0.1');

  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        server.close(() => resolve(result));
      } catch (_error) {
        resolve(result);
      }
    };

    server.once('error', () => {
      finish(false);
    });

    server.once('listening', () => {
      finish(true);
    });

    server.listen({
      host,
      port,
      exclusive: true,
    });
  });
}

async function ensurePortReleased(port, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 15000);
  const pollIntervalMs = Number(options.pollIntervalMs || 250);
  const stablePollCount = Number(options.stablePollCount || 4);
  const readPortOwningProcessesFn = options.readPortOwningProcessesFn || readPortOwningProcesses;
  const probePortBindableFn = options.probePortBindableFn || probePortBindable;
  const stopProcessTreeFn = options.stopProcessTreeFn || stopProcessTree;
  const sleepFn = options.sleepFn || sleep;
  const deadline = Date.now() + timeoutMs;
  let consecutiveBindablePolls = 0;

  while (Date.now() <= deadline) {
    const owningProcesses = readPortOwningProcessesFn(port);
    if (owningProcesses.length === 0 && await probePortBindableFn(port, options)) {
      consecutiveBindablePolls += 1;
      if (consecutiveBindablePolls >= stablePollCount) {
        return true;
      }
      await sleepFn(pollIntervalMs);
      continue;
    }

    consecutiveBindablePolls = 0;
    for (const pid of owningProcesses) {
      stopProcessTreeFn(pid);
    }
    await sleepFn(pollIntervalMs);
  }

  if (readPortOwningProcessesFn(port).length === 0 && await probePortBindableFn(port, options)) {
    return true;
  }

  throw new Error(
    `Managed port ${port} was not reusable before startup after ${timeoutMs} ms.`,
  );
}

function reportManagedPortOwners(port, options = {}) {
  const readPortOwningProcessesFn = options.readPortOwningProcessesFn || readPortOwningProcesses;
  const stderr = options.stderr || process.stderr;
  try {
    const owners = readPortOwningProcessesFn(port);
    if (owners.length > 0) {
      stderr.write(
        `[playwright-runner] managed port ${port} was rebound after current-run cleanup; `
        + `leaving post-settlement owner PIDs untouched: ${owners.join(', ')}\n`,
      );
    }
    return owners;
  } catch (error) {
    stderr.write(
      `[playwright-runner] could not inspect managed port ${port} after current-run cleanup: `
      + `${String(error?.message || error)}\n`,
    );
    return [];
  }
}

async function runManagedPlaywrightAttempt(options = {}) {
  const {
    passthroughArgv,
    childEnv,
    runTimeoutMs,
    managesScanApp,
    managesIsolatedApp,
    preservesPreloadedDatabase = false,
    servesRealApp,
    supportAppPort,
    realAppPort,
    isolatedAppPort,
    isolatedProviderPort,
    managedPorts = [],
    ownedIsolatedTempRoot,
    isHeadless,
    browserName,
  } = options;
  const startManagedScanAppFn = options.startManagedScanAppFn || startManagedScanApp;
  const stopManagedScanAppFn = options.stopManagedScanAppFn || stopManagedScanApp;
  const startManagedIsolatedAppFn = options.startManagedIsolatedAppFn || startManagedIsolatedApp;
  const stopManagedIsolatedAppFn = options.stopManagedIsolatedAppFn || stopManagedIsolatedApp;
  const createManagedIsolatedAppRestartControllerFn = (
    options.createManagedIsolatedAppRestartControllerFn
    || createManagedIsolatedAppRestartController
  );
  const cleanupIsolatedLibraryDatabaseFn = options.cleanupIsolatedLibraryDatabaseFn
    || cleanupIsolatedLibraryDatabase;
  const runPlaywrightProcessFn = options.runPlaywrightProcessFn || runPlaywrightProcess;
  const cleanupIsolatedE2ETempRootsFn = (
    options.cleanupIsolatedE2ETempRootsFn || cleanupIsolatedE2ETempRoots
  );
  const reportManagedPortOwnersFn = options.reportManagedPortOwnersFn || reportManagedPortOwners;
  let managedScanChild = null;
  let managedIsolatedChild = null;
  let managedIsolatedAppStarted = false;
  let managedIsolatedRestartController = null;
  let result = null;
  let attemptError = null;
  const managedAttempt = {
    attemptReturn: null,
    scanAppCleanup: { status: managesScanApp ? 'pending' : 'not-required', error: null },
    isolatedAppCleanup: { status: managesIsolatedApp ? 'pending' : 'not-required', error: null },
    tempCleanup: { status: 'pending', removedCount: 0, error: null },
    passivePortDiagnostics: [],
  };

  try {
    const expectedFixtureProfile = resolveManagedFixtureProfile(passthroughArgv);
    const seedAllFunctionalCoverMisses = shouldSeedAllFunctionalCoverMisses(passthroughArgv);
    assertManagedSyntheticLargeFixtureEnv(childEnv, {
      managedSyntheticLarge: Boolean(expectedFixtureProfile),
      expectedFixtureProfile,
    });
    if (managesScanApp) {
      managedScanChild = await startManagedScanAppFn(childEnv, {
        port: supportAppPort,
      });
    }
    if (managesIsolatedApp) {
      const isolatedDatabaseEnv = buildIsolatedLibraryCleanupEnv(childEnv);
      childEnv.ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL = (
        isolatedDatabaseEnv.ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL
      );
      childEnv.ALBUM_HAVEN_FAKE_E2E_DATABASE_URL = (
        isolatedDatabaseEnv.ALBUM_HAVEN_FAKE_E2E_DATABASE_URL
      );
      childEnv[MANAGED_ISOLATED_APP_ENV] = '1';
      const preparedProfileSession = (
        String(childEnv.ALBUM_HAVEN_PERFORMANCE_PROFILE_SESSION || '').trim() === '1'
      );
      if (!preparedProfileSession) {
        delete childEnv[MANAGED_ISOLATED_REUSE_STATE_ENV];
      }
      if (ownedIsolatedTempRoot) {
        childEnv[MANAGED_ISOLATED_PRESERVE_ON_SHUTDOWN_ENV] = '1';
      } else if (preparedProfileSession) {
        childEnv[MANAGED_ISOLATED_PRESERVE_ON_SHUTDOWN_ENV] = '1';
        childEnv[MANAGED_ISOLATED_REUSE_STATE_ENV] = '1';
      }
      const resolvedIsolatedAppPort = Number(isolatedAppPort || supportAppPort);
      const resolvedIsolatedProviderPort = Number(
        isolatedProviderPort || childEnv.PLAYWRIGHT_PROVIDER_PORT || resolvedIsolatedAppPort + 2,
      );
      managedIsolatedChild = await startManagedIsolatedAppFn(childEnv, {
        port: resolvedIsolatedAppPort,
        providerPort: resolvedIsolatedProviderPort,
        seedAllFunctionalCoverMisses,
        onSpawnFn(child) {
          managedIsolatedChild = child;
          managedIsolatedAppStarted = true;
        },
      });
      managedIsolatedAppStarted = true;
      if (ownedIsolatedTempRoot || options.createManagedIsolatedAppRestartControllerFn) {
        managedIsolatedRestartController = createManagedIsolatedAppRestartControllerFn({
          childEnv,
          ownedIsolatedTempRoot,
          initialChild: managedIsolatedChild,
          ports: [resolvedIsolatedAppPort, resolvedIsolatedProviderPort],
          seedAllFunctionalCoverMisses,
          startManagedIsolatedAppFn,
          stopManagedIsolatedAppFn,
          onCurrentChildChanged(child) {
            managedIsolatedChild = child;
          },
        });
        if (typeof managedIsolatedRestartController.getCurrentChild === 'function') {
          managedIsolatedChild = managedIsolatedRestartController.getCurrentChild();
        }
      }
    }
    if (servesRealApp) {
      const modeLabel = isHeadless ? 'headless' : 'headed';
      console.log(
        `[playwright-runner] launching managed real-app session | mode=${modeLabel} | browser=${browserName} | `
        + `port=${realAppPort} | note=each_performance_target_uses_a_fresh_browser_session`
      );
      if (!isHeadless) {
        console.log('[playwright-runner] headed mode note | a fresh browser may briefly show about:blank before the spec navigates to /.');
      }
    }
    const playwrightAbortController = new AbortController();
    const playwrightRunPromise = Promise.resolve().then(
      () => runPlaywrightProcessFn(
        passthroughArgv,
        childEnv,
        runTimeoutMs,
        { signal: playwrightAbortController.signal },
      ),
    );
    const managedIsolatedAppFailureSignal = managedIsolatedRestartController
      ?.getFailureSignal?.();
    result = managedIsolatedAppFailureSignal
      ? await Promise.race([
        playwrightRunPromise,
        managedIsolatedAppFailureSignal.then(async (failureError) => {
          playwrightAbortController.abort(failureError);
          try {
            await playwrightRunPromise;
          } catch (_error) {
            // The managed-app failure remains authoritative after the owned runner settles.
          }
          throw failureError;
        }),
      ])
      : await playwrightRunPromise;
    if (managedIsolatedRestartController) {
      await managedIsolatedRestartController.close();
      const restartFailure = managedIsolatedRestartController.getFailure?.();
      if (restartFailure) throw restartFailure;
      if (typeof managedIsolatedRestartController.getCurrentChild === 'function') {
        managedIsolatedChild = managedIsolatedRestartController.getCurrentChild();
      }
    }
    managedAttempt.attemptReturn = {
      exitCode: Number(result?.exitCode ?? 1),
      exitReason: String(result?.lifecycle?.exitReason || ''),
    };
    if (!result.lifecycle) {
      result.lifecycle = {};
    }
    result.lifecycle.managedAttempt = managedAttempt;
    return result;
  } catch (error) {
    const nextError = error instanceof Error ? error : new Error(String(error));
    if (!nextError.lifecycle) {
      nextError.lifecycle = {};
    }
    nextError.lifecycle.managedAttempt = managedAttempt;
    attemptError = nextError;
    throw nextError;
  } finally {
    let scanCleanupError = null;
    let isolatedCleanupError = null;
    let restartControllerCleanupError = null;
    let databaseCleanupError = null;
    if (managedIsolatedRestartController) {
      try {
        await managedIsolatedRestartController.close();
      } catch (error) {
        restartControllerCleanupError = error instanceof Error ? error : new Error(String(error));
      }
      if (typeof managedIsolatedRestartController.getCurrentChild === 'function') {
        managedIsolatedChild = managedIsolatedRestartController.getCurrentChild();
      }
    }
    if (managedScanChild) {
      try {
        await stopManagedScanAppFn(managedScanChild, supportAppPort);
        managedAttempt.scanAppCleanup.status = 'completed';
      } catch (error) {
        managedAttempt.scanAppCleanup.status = 'failed';
        managedAttempt.scanAppCleanup.error = safeErrorSummary(error);
        scanCleanupError = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (managedIsolatedChild) {
      try {
        await stopManagedIsolatedAppFn(managedIsolatedChild, managedPorts);
        managedAttempt.isolatedAppCleanup.status = 'completed';
      } catch (error) {
        managedAttempt.isolatedAppCleanup.status = 'failed';
        managedAttempt.isolatedAppCleanup.error = safeErrorSummary(error);
        isolatedCleanupError = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (managedIsolatedAppStarted && !managedIsolatedChild && !isolatedCleanupError) {
      managedAttempt.isolatedAppCleanup.status = 'completed';
    }
    if (managedIsolatedAppStarted && !isolatedCleanupError && !preservesPreloadedDatabase) {
      const lifecycle = result?.lifecycle || attemptError?.lifecycle || {};
      try {
        cleanupIsolatedLibraryDatabaseFn(childEnv);
        lifecycle.fakeDatabaseCleanup = { status: 'completed', error: null };
      } catch (error) {
        lifecycle.fakeDatabaseCleanup = { status: 'failed', error: safeErrorSummary(error) };
        databaseCleanupError = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (restartControllerCleanupError && !isolatedCleanupError) {
      managedAttempt.isolatedAppCleanup.status = 'failed';
      managedAttempt.isolatedAppCleanup.error = safeErrorSummary(restartControllerCleanupError);
      isolatedCleanupError = restartControllerCleanupError;
    }
    try {
      const removedRoots = cleanupIsolatedE2ETempRootsFn(
        os.tmpdir(),
        ownedIsolatedTempRoot ? [ownedIsolatedTempRoot] : [],
      );
      managedAttempt.tempCleanup.status = 'completed';
      managedAttempt.tempCleanup.removedCount = Array.isArray(removedRoots) ? removedRoots.length : 0;
    } catch (error) {
      managedAttempt.tempCleanup.status = 'failed';
      managedAttempt.tempCleanup.error = safeErrorSummary(error);
      if (ownedIsolatedTempRoot) {
        const lifecycle = result?.lifecycle || attemptError?.lifecycle || {};
        lifecycle.exitReason = 'owned-temp-cleanup-error';
        if (result) {
          result.exitCode = 1;
          result.lifecycle = lifecycle;
        }
      }
    }
    for (const managedPort of managedPorts) {
      const portDiagnostic = {
        port: managedPort,
        status: 'pending',
        ownerCount: 0,
        error: null,
      };
      managedAttempt.passivePortDiagnostics.push(portDiagnostic);
      try {
        const owners = await reportManagedPortOwnersFn(managedPort);
        portDiagnostic.status = 'completed';
        portDiagnostic.ownerCount = Array.isArray(owners) ? owners.length : 0;
      } catch (error) {
        portDiagnostic.status = 'failed';
        portDiagnostic.error = safeErrorSummary(error);
      }
    }
    if (scanCleanupError) {
      const lifecycle = result?.lifecycle || attemptError?.lifecycle || {};
      lifecycle.managedAttempt = managedAttempt;
      lifecycle.exitReason = 'managed-scan-cleanup-error';
      scanCleanupError.lifecycle = lifecycle;
      throw scanCleanupError;
    }
    if (isolatedCleanupError) {
      const lifecycle = result?.lifecycle || attemptError?.lifecycle || {};
      lifecycle.managedAttempt = managedAttempt;
      lifecycle.exitReason = 'managed-isolated-app-cleanup-error';
      isolatedCleanupError.lifecycle = lifecycle;
      throw isolatedCleanupError;
    }
    if (databaseCleanupError) {
      const lifecycle = result?.lifecycle || attemptError?.lifecycle || {};
      lifecycle.managedAttempt = managedAttempt;
      lifecycle.exitReason = 'fake-database-cleanup-error';
      databaseCleanupError.lifecycle = lifecycle;
      throw databaseCleanupError;
    }
  }
}

async function main() {
  let childEnv = loadDotEnvFile({
    ...process.env,
  });

  if (runtimeFlags.isRealApp) {
    childEnv.PLAYWRIGHT_REAL_APP = '1';
  }
  if (runtimeFlags.serveRealApp) {
    childEnv.PLAYWRIGHT_SERVE_REAL_APP = '1';
    childEnv.MUSIC_APP_PORT = String(runtimeFlags.realAppPort || 5001);
    childEnv.MUSIC_APP_DEBUG = '0';
    childEnv.MUSIC_APP_RELOADER = '0';
  }
  if (runtimeFlags.browser) {
    childEnv.PLAYWRIGHT_BROWSER = runtimeFlags.browser;
  }
  const playwrightBrowsersPath = resolvePlaywrightBrowsersPath(childEnv);
  if (playwrightBrowsersPath === undefined) {
    delete childEnv.PLAYWRIGHT_BROWSERS_PATH;
  } else {
    childEnv.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath;
  }
  childEnv.PLAYWRIGHT_HEADLESS = runtimeFlags.headlessOverride === false ? 'false' : 'true';
  if (runtimeFlags.realAppPort) {
    childEnv.PLAYWRIGHT_REAL_APP_PORT = String(runtimeFlags.realAppPort);
  }
  if (runtimeFlags.supportAppPort) {
    childEnv.PLAYWRIGHT_PORT = String(runtimeFlags.supportAppPort);
  }
  if (runtimeFlags.providerPort) {
    childEnv.PLAYWRIGHT_PROVIDER_PORT = String(runtimeFlags.providerPort);
    childEnv.ALBUM_HAVEN_FAKE_E2E_PROVIDER_BASE_URL = `http://127.0.0.1:${runtimeFlags.providerPort}`;
  }
  if (runtimeFlags.runTimeoutMs) {
    childEnv.PLAYWRIGHT_RUN_TIMEOUT_MS = String(runtimeFlags.runTimeoutMs);
  }
  childEnv = buildAndAssertProviderWriteSafeEnv(childEnv);
  const runPlaywright = async (
    runTimeoutMs = resolveRunTimeoutMs(runtimeFlags.runTimeoutMs),
    passthroughArgv = runtimeFlags.passthroughArgv,
  ) => {
    cleanupIsolatedE2ETempRoots(os.tmpdir(), [], { reclaimOrphans: true });
    const needsOwnedIsolatedTempRoot = usesRunnerOwnedIsolatedTempRoot(
      passthroughArgv,
      childEnv,
    ) && !isListOnlyCommand(passthroughArgv);
    const managesScanApp = isScanPerformanceConfig(passthroughArgv)
      && !isListOnlyCommand(passthroughArgv);
    if (managesScanApp) {
      childEnv[MANAGED_SCAN_APP_ENV] = '1';
    }
    const servesRealApp = childEnv.PLAYWRIGHT_SERVE_REAL_APP === '1' && !isListOnlyCommand(passthroughArgv);
    const explicitConfig = resolveExplicitPlaywrightConfig(passthroughArgv);
    const managesIsolatedApp = !isListOnlyCommand(passthroughArgv) && (
      isManagedIsolatedLibraryConfig(passthroughArgv)
      || /playwright\.performance\.config\.cjs$/i.test(explicitConfig)
        || Boolean(resolveManagedFixtureProfile(passthroughArgv))
    );
    if (managesIsolatedApp) {
      childEnv[MANAGED_ISOLATED_APP_ENV] = '1';
    }
    const realAppPort = Number(childEnv.PLAYWRIGHT_REAL_APP_PORT || runtimeFlags.realAppPort || 5001);
    const supportAppPort = Number(childEnv.PLAYWRIGHT_PORT || runtimeFlags.supportAppPort || 4173);
    const providerPort = Number(childEnv.PLAYWRIGHT_PROVIDER_PORT || runtimeFlags.providerPort || supportAppPort + 2);
    const isolatedPorts = resolveManagedIsolatedAppPorts(passthroughArgv, {
      realAppPort,
      supportAppPort,
      providerPort,
    });
    const managesSupportAppPort = usesManagedSupportAppPort(passthroughArgv);
    const managedPorts = managesIsolatedApp
      ? [isolatedPorts.appPort, isolatedPorts.providerPort]
      : resolveManagedWebServerPorts({
      servesRealApp,
      realAppPort,
      supportAppPort,
      providerPort,
      managesSupportAppPort,
      managesProviderPort: !managesScanApp,
      isListOnlyCommand: isListOnlyCommand(passthroughArgv),
      });
    const isHeadless = String(childEnv.PLAYWRIGHT_HEADLESS || '').trim().toLowerCase() !== 'false';
    const browserName = String(childEnv.PLAYWRIGHT_BROWSER || 'chromium').trim() || 'chromium';
    let attemptsRemaining = managedPorts.length > 0 ? 1 : 0;

    while (true) {
      const ownedIsolatedTempRoot = needsOwnedIsolatedTempRoot
        ? createOwnedIsolatedE2ETempRoot()
        : '';
      if (ownedIsolatedTempRoot) {
        childEnv.ALBUM_HAVEN_E2E_TEMP_ROOT = ownedIsolatedTempRoot;
      }
      let attemptStarted = false;
      try {
        for (const managedPort of managedPorts) {
          await ensurePortReleased(managedPort);
        }
        attemptStarted = true;
      } finally {
        if (!attemptStarted && ownedIsolatedTempRoot) {
          cleanupIsolatedE2ETempRoots(os.tmpdir(), [ownedIsolatedTempRoot]);
        }
      }
      const result = await runManagedPlaywrightAttempt({
        passthroughArgv,
        childEnv,
        runTimeoutMs,
        managesScanApp,
        managesIsolatedApp,
        preservesPreloadedDatabase: Boolean(resolveManagedFixtureProfile(passthroughArgv))
          || String(childEnv.ALBUM_HAVEN_PERFORMANCE_PROFILE_SESSION || '').trim() === '1',
        servesRealApp,
        supportAppPort,
        realAppPort,
        isolatedAppPort: isolatedPorts.appPort,
        isolatedProviderPort: isolatedPorts.providerPort,
        managedPorts,
        ownedIsolatedTempRoot,
        isHeadless,
        browserName,
      });
      if (!shouldRetryManagedRealAppPortConflict(result, { managedPorts, attemptsRemaining })) {
        return result;
      }
      attemptsRemaining -= 1;
      console.warn(
        `Managed Playwright startup hit a port conflict in ${managedPorts.join(', ')}. `
        + 'Reclaiming the managed ports and retrying once.'
      );
    }
  };

  return runPlaywright();
}

module.exports = {
  _private: {
    ISOLATED_E2E_TEMP_PREFIX,
    ISOLATED_E2E_TEMP_LEASE,
    writeIsolatedE2ETempRootLease,
    createOwnedIsolatedE2ETempRoot,
    cleanupIsolatedE2ETempRoots,
    readPortOwningProcesses,
    resolvePlaywrightCompletionExitCode,
    resolvePlaywrightFinalResultExitCode,
    resolvePlaywrightCompletionSignal,
    parsePlaywrightFinalResult,
    resolvePlaywrightListReporterExitCode,
    resolvePlaywrightSummaryExitCode,
    hasIncompletePlaywrightListRun,
    parsePlaywrightListResults: terminalSummary.parsePlaywrightListResults,
    formatPlaywrightTerminalSummary: terminalSummary.formatPlaywrightTerminalSummary,
    stripAnsi: terminalSummary.stripAnsi,
    maybeWritePlaywrightTerminalSummary,
    forceAutomatedPerformanceReportClosedEnv,
    loadDotEnvFile,
    buildAndAssertProviderWriteSafeEnv,
    assertManagedRealDataDatabaseEnv,
    buildIsolatedLibraryCleanupEnv,
    cleanupIsolatedLibraryDatabase,
    DEFAULT_FAKE_E2E_RUNTIME_DATABASE_URL,
    DEFAULT_FAKE_E2E_SETUP_DATABASE_URL,
    DEFAULT_PLAYWRIGHT_PYTHON,
    ISOLATED_LIBRARY_APP_PATH,
    SCAN_PERFORMANCE_APP_PATH,
    MANAGED_SCAN_APP_ENV,
    SCAN_STATUS_SAMPLES_ENV,
    MANAGED_SCAN_APP_STARTUP_TIMEOUT_MS,
    ISOLATED_LIBRARY_CLEANUP_TIMEOUT_MS,
    PLAYWRIGHT_PERFORMANCE_REPORTER_FLUSH_MARKER,
    PLAYWRIGHT_FINAL_RESULT_NONCE_ENV,
    PLAYWRIGHT_FINALIZATION_GRACE_MS,
    PLAYWRIGHT_TERMINAL_COLLECTION_FAILURE_GRACE_MS,
    hasTerminalPlaywrightCollectionFailure,
    createPlaywrightResultNonce,
    isSyntheticLargeLibraryConfig,
    resolveManagedFixtureProfile,
    usesRunnerOwnedIsolatedTempRoot,
    isDefaultIsolatedLibraryConfig,
    isManagedIsolatedLibraryConfig,
    shouldSeedAllFunctionalCoverMisses,
    isScanPerformanceConfig,
    resolvePlaywrightBrowsersPath,
    resolveManagedIsolatedAppPorts,
    resolvePlaywrightPython,
    resolveExplicitPlaywrightConfig,
    resolveManagedWebServerPorts,
    resolveRunTimeoutMs,
    shouldRetryManagedRealAppPortConflict,
    shouldUseReporterDrivenCompletion,
    MANAGED_REAL_APP_COMPLETION_GRACE_MS,
    MANAGED_SUPPORT_APP_PORT_REUSE_TIMEOUT_MS,
    RECLAIMED_PROCESS_EXIT_TIMEOUT_MS,
    MANAGED_ISOLATED_APP_ENV,
    ISOLATED_LIBRARY_APP_PATH,
    resolveReporterDrivenCompletionGraceMs,
    resolveManagedPortReuseTimeoutMs,
    usesManagedSupportAppPort,
    ensurePortReleased,
    reportManagedPortOwners,
    waitForPortReleased,
    waitForReclaimedProcessesExited,
    readPortOwningProcessIdentities,
    readProcessCreationIdentity,
    readProcessTreeIdentities,
    reclaimPort,
    probePortBindable,
    probePortListening,
    waitForManagedScanAppReady,
    startManagedScanApp,
    stopManagedScanApp,
    probeHttpStatusReady,
    probeHttpResponseComplete,
    fetchHttpResponseComplete,
    collectLocalCoverPreviewUrls,
    prewarmFunctionalFixture,
    waitForFunctionalFixtureBackgroundIdle,
    MANAGED_FUNCTIONAL_FIXTURE_WARMUP_TIMEOUT_MS,
    waitForManagedIsolatedAppReady,
    waitForDirectChildExit,
    abortManagedIsolatedAppStartup,
    startManagedIsolatedApp,
    stopManagedIsolatedApp,
    createManagedIsolatedAppRestartController,
    runManagedPlaywrightAttempt,
    buildAuthoritativePassFinalDecisionDiagnostic,
    hasCompletedAuthoritativePassLifecycle,
    finalizeMainResult,
    runPlaywrightProcess,
    stopProcessTree,
  },
};

if (require.main === module) {
  main().then(
    (result) => {
      const exitCode = finalizeMainResult(result);
      process.exit(exitCode);
    },
    (error) => {
      const lifecycle = error?.lifecycle || {};
      console.error(
        `[playwright-wrapper-error] ${JSON.stringify(
          safeErrorSummary(error) || { name: 'Error' },
        )}`,
      );
      const exitCode = finalizeMainResult({ exitCode: 1, lifecycle });
      process.exit(exitCode);
    },
  );
}
