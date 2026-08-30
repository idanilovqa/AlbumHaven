const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PlaywrightPerformanceReporter = require('../../scripts/playwright-performance-reporter.cjs');
const { _private } = require('../../scripts/playwright-performance-reporter.cjs');

test('reporter uses the absolute history root from the environment unless the constructor overrides it', () => {
  const environmentVariable = 'PLAYWRIGHT_PERFORMANCE_HISTORY_ROOT';
  const previousHistoryRoot = process.env[environmentVariable];
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-reporter-history-root-'));
  const environmentHistoryRoot = path.join(tempRoot, 'target-artifacts', 'history');
  const explicitHistoryRoot = path.join(tempRoot, 'explicit-history');

  try {
    process.env[environmentVariable] = environmentHistoryRoot;

    const environmentReporter = new PlaywrightPerformanceReporter();
    const explicitReporter = new PlaywrightPerformanceReporter({ historyRoot: explicitHistoryRoot });

    assert.deepEqual({
      environmentHistoryRoot: environmentReporter.historyRoot,
      explicitHistoryRoot: explicitReporter.historyRoot,
    }, {
      environmentHistoryRoot: path.resolve(environmentHistoryRoot),
      explicitHistoryRoot: explicitHistoryRoot,
    });
  } finally {
    if (previousHistoryRoot === undefined) {
      delete process.env[environmentVariable];
    } else {
      process.env[environmentVariable] = previousHistoryRoot;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('reporter passes its scoped history root to report auto-open when history flushes', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-reporter-scoped-open-'));
  const openedReports = [];
  const reporter = new PlaywrightPerformanceReporter({
    historyRoot: tempRoot,
    logFn: () => {},
    openLatestReportFn: (relativeTarget, options) => openedReports.push({ relativeTarget, options }),
  });

  try {
    reporter.onBegin(
      {
        use: { headless: true },
        projects: [],
      },
      {
        allTests: () => ([{ id: 'scoped-report-1' }]),
      },
    );

    reporter.onTestEnd(
      { title: 'scoped performance report' },
      {
        attachments: [
          {
            name: 'performance-report-metrics',
            body: Buffer.from(JSON.stringify({
              reportId: 'scopedReport',
              title: 'Scoped Performance Report',
              intro: 'The auto-open helper must serve the reporter-owned history root.',
              caseId: 'FTC-SCOPED-REPORT-001',
              summaryCards: [],
              rawMetrics: {},
              checkpoints: [],
              stepEvents: [],
              stepTranscript: [],
            })),
            contentType: 'application/json',
          },
        ],
        status: 'passed',
        startTime: new Date('2026-08-25T12:00:00.000Z'),
        duration: 100,
      },
    );

    assert.equal(openedReports.length, 1);
    assert.equal(openedReports[0].options.historyRoot, tempRoot);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('reporter resolves the configured project environment from a real-shaped TestCase when TestResult has no projectName', () => {
  const reporter = new PlaywrightPerformanceReporter({
    logFn: () => {},
    openLatestReportFn: () => {},
  });
  const project = {
    name: 'idle-memory',
    use: {
      browserName: 'chromium',
      channel: '',
    },
  };

  reporter.onBegin(
    {
      use: {
        baseURL: 'http://127.0.0.1:4173',
        headless: true,
      },
      projects: [project],
    },
    {
      allTests: () => ([{ id: 'playback-start-1' }, { id: 'playback-start-2' }]),
    },
  );

  reporter.onTestEnd(
    {
      title: 'FTC-PLAYER-013 playback starts promptly',
      parent: {
        project: () => project,
      },
    },
    {
      attachments: [
        {
          name: 'performance-report-metrics',
          body: Buffer.from(JSON.stringify({
            reportId: 'playbackStart',
            title: 'Playback Start Benchmark',
            intro: 'The reporter should retain the actual Playwright project environment.',
            caseId: 'FTC-PLAYER-013',
            summaryCards: [],
            rawMetrics: {},
            checkpoints: [],
            stepEvents: [],
            stepTranscript: [],
          })),
          contentType: 'application/json',
        },
      ],
      status: 'passed',
      startTime: new Date('2026-07-22T18:00:00.000Z'),
      duration: 500,
    },
  );

  assert.deepEqual(reporter.testRecords[0].environment, {
    projectName: 'idle-memory',
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    channel: '',
    headless: true,
  });
});

test('reporter flushes retained performance history on the final onTestEnd before onEnd runs', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-reporter-flush-'));
  const flushLogs = [];
  const openedTargets = [];
  const reporter = new PlaywrightPerformanceReporter({
    historyRoot: tempRoot,
    logFn: (message) => flushLogs.push(message),
    openLatestReportFn: (target) => openedTargets.push(target),
  });

  reporter.onBegin(
    {
      use: {
        baseURL: 'http://127.0.0.1:4173',
        headless: false,
      },
      projects: [
        {
          name: 'idle-memory',
          use: {
            browserName: 'chromium',
            channel: 'chrome',
          },
        },
      ],
    },
    {
      allTests: () => ([{ id: 'idle-memory-1' }]),
    },
  );

  reporter.onTestEnd(
    {
      title: 'FTC-GALLERY-STARTUP-005 idle gallery memory stays under the budget once startup settles',
    },
    {
      attachments: [
        {
          name: 'performance-report-metrics',
          body: Buffer.from(JSON.stringify({
            reportId: 'idleMemory',
            title: 'Idle Gallery Memory Benchmark',
            intro: 'Flush before onEnd so the wrapper does not wait on teardown.',
            caseId: 'FTC-GALLERY-STARTUP-005',
            summaryCards: [],
            rawMetrics: {},
            checkpoints: [
              {
                key: 'scrolled-gallery-idle-1',
                label: 'Scrolled gallery idle sample 1',
                timingMs: null,
                memoryBytes: 3945000,
                memorySource: 'Runtime.getHeapUsage',
                valueText: '',
                recordedAt: '2026-06-08T15:36:54.173Z',
                details: null,
              },
            ],
            stepEvents: [],
            stepTranscript: [],
          })),
          contentType: 'application/json',
        },
      ],
      status: 'passed',
      startTime: new Date('2026-06-08T15:36:45.627Z'),
      duration: 8172,
      projectName: 'idle-memory',
    },
  );

  const manifestPath = path.join(tempRoot, 'idleMemory', 'index.json');
  assert.equal(fs.existsSync(manifestPath), true);
  assert.deepEqual(flushLogs, [_private.PLAYWRIGHT_PERFORMANCE_REPORTER_FLUSH_MARKER]);
  assert.deepEqual(openedTargets, ['index.html']);

  await reporter.onEnd();

  assert.deepEqual(flushLogs, [_private.PLAYWRIGHT_PERFORMANCE_REPORTER_FLUSH_MARKER]);
  assert.deepEqual(openedTargets, ['index.html']);
});

test('reporter force flushes retained performance history onEnd when a run ends early', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-reporter-force-flush-'));
  const flushLogs = [];
  const openedTargets = [];
  const reporter = new PlaywrightPerformanceReporter({
    historyRoot: tempRoot,
    logFn: (message) => flushLogs.push(message),
    openLatestReportFn: (target) => openedTargets.push(target),
  });

  reporter.onBegin(
    {
      use: {
        baseURL: 'http://127.0.0.1:4173',
        headless: false,
      },
      projects: [
        {
          name: 'idle-memory',
          use: {
            browserName: 'chromium',
            channel: 'chrome',
          },
        },
      ],
    },
    {
      allTests: () => ([{ id: 'idle-memory-1' }, { id: 'idle-memory-2' }]),
    },
  );

  reporter.onTestEnd(
    {
      title: 'FTC-GALLERY-STARTUP-005 idle gallery memory stays under the budget once startup settles',
    },
    {
      attachments: [
        {
          name: 'performance-report-metrics',
          body: Buffer.from(JSON.stringify({
            reportId: 'idleMemory',
            title: 'Idle Gallery Memory Benchmark',
            intro: 'Flush onEnd when teardown starts before every expected test completed.',
            caseId: 'FTC-GALLERY-STARTUP-005',
            summaryCards: [],
            rawMetrics: {},
            checkpoints: [
              {
                key: 'scrolled-gallery-idle-1',
                label: 'Scrolled gallery idle sample 1',
                timingMs: null,
                memoryBytes: 3945000,
                memorySource: 'Runtime.getHeapUsage',
                valueText: '',
                recordedAt: '2026-06-08T15:36:54.173Z',
                details: null,
              },
            ],
            stepEvents: [],
            stepTranscript: [],
          })),
          contentType: 'application/json',
        },
      ],
      status: 'interrupted',
      startTime: new Date('2026-06-08T15:36:45.627Z'),
      duration: 8172,
      projectName: 'idle-memory',
    },
  );

  const manifestPath = path.join(tempRoot, 'idleMemory', 'index.json');
  assert.equal(fs.existsSync(manifestPath), false);

  await reporter.onEnd();

  assert.equal(fs.existsSync(manifestPath), true);
  assert.deepEqual(flushLogs, [_private.PLAYWRIGHT_PERFORMANCE_REPORTER_FLUSH_MARKER]);
  assert.deepEqual(openedTargets, ['index.html']);
});

test('shouldOpenLatestReport skips non-interactive orchestration even for headed local runs', () => {
  assert.equal(
    _private.shouldOpenLatestReport({
      ci: '',
      openPerformanceReport: '',
      playwrightHeadless: '',
      stdoutIsTTY: false,
    }),
    false,
  );

  assert.equal(
    _private.shouldOpenLatestReport({
      ci: '',
      openPerformanceReport: '',
      playwrightHeadless: '',
      stdoutIsTTY: true,
    }),
    true,
  );
});

test('shouldOpenLatestReport honors a forced closed setting for an interactive headed run', () => {
  assert.equal(
    _private.shouldOpenLatestReport({
      ci: '',
      openPerformanceReport: '0',
      playwrightHeadless: 'false',
      resolvedHeadless: false,
      stdoutIsTTY: true,
    }),
    false,
  );
});

test('shouldOpenLatestReport skips a resolved headless config in a TTY when the env is absent', () => {
  assert.equal(
    _private.shouldOpenLatestReport({
      ci: '',
      openPerformanceReport: '',
      playwrightHeadless: '',
      resolvedHeadless: true,
      stdoutIsTTY: true,
    }),
    false,
  );
  assert.equal(
    _private.shouldOpenLatestReport({
      ci: '',
      openPerformanceReport: '',
      playwrightHeadless: '',
      resolvedHeadless: false,
      stdoutIsTTY: true,
    }),
    true,
  );
});

test('buildManifestEntry keeps retained report links rooted at the suite directory', () => {
  const suiteDir = path.join('C:', 'Repositories', 'MusicApp', 'test-results', 'playwrightPerformanceHistory', 'allArtistsLocal');
  const runId = '2026-06-04T07-06-16-838Z';
  const reportFilePath = path.join(suiteDir, 'runs', runId, 'report.html');
  const metricsFilePath = path.join(suiteDir, 'runs', runId, 'metrics.json');
  const entry = _private.buildManifestEntry({
    runId,
    caseId: 'FTC-GALLERY-STARTUP-005A',
    reportId: 'allArtistsLocal',
    title: 'Local real-build responsiveness',
    reportTitle: 'All Artists Local History',
    status: 'failed',
    startedAt: '2026-06-04T07:06:16.838Z',
    finishedAt: '2026-06-04T07:07:16.838Z',
    durationMs: 60000,
    peakMemoryBytes: 123456789,
    checkpoints: [{ key: 'gallery-ready' }],
    environment: {
      projectName: 'local-real-data',
      baseURL: 'http://127.0.0.1:5001',
      browserName: 'chromium',
      channel: 'chrome',
      headless: false,
    },
  }, suiteDir, reportFilePath, metricsFilePath);

  assert.equal(entry.reportPath, `runs/${runId}/report.html`);
  assert.equal(entry.metricsPath, `runs/${runId}/metrics.json`);
  assert.equal(entry.benchmarkValidation, null);
});

test('buildManifestEntry keeps benchmark validation summaries for retained threshold overlays', () => {
  const suiteDir = path.join('C:', 'Repositories', 'MusicApp', 'test-results', 'playwrightPerformanceHistory', 'allArtistsLocal');
  const runId = '2026-06-04T17-36-55-384Z';
  const reportFilePath = path.join(suiteDir, 'runs', runId, 'report.html');
  const metricsFilePath = path.join(suiteDir, 'runs', runId, 'metrics.json');
  const entry = _private.buildManifestEntry({
    runId,
    caseId: 'FTC-GALLERY-STARTUP-005A',
    reportId: 'allArtistsLocal',
    title: 'Local real-build responsiveness',
    reportTitle: 'All Artists Local History',
    status: 'passed',
    startedAt: '2026-06-04T17:36:55.384Z',
    finishedAt: '2026-06-04T17:37:55.384Z',
    durationMs: 60000,
    peakMemoryBytes: 123456789,
    checkpoints: [{ key: 'startup-preview-sidebar' }],
    environment: {
      projectName: 'local-real-data',
      baseURL: 'http://127.0.0.1:5001',
      browserName: 'chromium',
      channel: 'chrome',
      headless: false,
    },
    rawMetrics: {
      benchmarkValidation: {
        benchmarkId: 'all-artists-local-managed-chrome',
        benchmarkVersion: '2026-06-04-managed-chrome-five-run-baseline',
        results: [
          {
            key: 'startupPreviewSidebarMs',
            checkpointKey: 'startup-preview-sidebar',
            description: 'Startup preview sidebar should appear quickly from the cached preview.',
            units: 'ms',
            actual: 900,
            targetMaximum: 881,
            graceMs: 200,
            hardCeiling: 1081,
            allowedMaximum: 1081,
            allowedText: '1081 ms',
            performanceStatus: 'grace-used',
            targetMet: false,
            graceUsed: true,
            passed: true,
          },
        ],
      },
    },
  }, suiteDir, reportFilePath, metricsFilePath);

  assert.deepEqual(entry.benchmarkValidation, {
    benchmarkId: 'all-artists-local-managed-chrome',
    benchmarkVersion: '2026-06-04-managed-chrome-five-run-baseline',
    results: [
      {
        key: 'startupPreviewSidebarMs',
        checkpointKey: 'startup-preview-sidebar',
        description: 'Startup preview sidebar should appear quickly from the cached preview.',
        units: 'ms',
        actual: 900,
        actualText: '',
        observedBaseline: 0,
        observedRange: null,
        targetMaximum: 881,
        graceMs: 200,
        hardCeiling: 1081,
        allowedMaximum: 1081,
        allowedText: '1081 ms',
        performanceStatus: 'grace-used',
        targetMet: false,
        graceUsed: true,
        passed: true,
      },
    ],
  });
});

test('single-run uncalibrated reporting uses the run status as process evidence', () => {
  const suiteDir = path.join('C:', 'Repositories', 'MusicApp', 'test-results', 'playwrightPerformanceHistory', 'uncalibrated');
  const buildEntry = (status) => _private.buildManifestEntry({
    runId: `uncalibrated-${status}`,
    caseId: 'FTC-UNCALIBRATED',
    reportId: 'uncalibrated',
    title: 'Uncalibrated metric',
    reportTitle: 'Uncalibrated metric',
    status,
    checkpoints: [],
    rawMetrics: {
      benchmarkValidation: {
        results: [{
          key: 'uncalibratedMs',
          checkpointKey: 'uncalibrated-ms',
          units: 'ms',
          actual: 123,
          targetMaximum: null,
          graceMs: null,
          hardCeiling: null,
          allowedMaximum: null,
          calibrationState: 'uncalibrated',
          blocking: false,
          performanceStatus: 'uncalibrated',
          passed: status === 'passed',
        }],
      },
    },
  }, suiteDir, 'report.html', 'metrics.json');

  const passed = buildEntry('passed').benchmarkValidation.results[0];
  assert.equal(passed.performanceStatus, 'uncalibrated');
  assert.equal(passed.thresholdPassed, null);
  assert.equal(passed.passed, true);

  const failed = buildEntry('failed').benchmarkValidation.results[0];
  assert.equal(failed.performanceStatus, 'uncalibrated');
  assert.equal(failed.thresholdPassed, null);
  assert.equal(failed.passed, false);
});

test('buildProjectEnvironment keeps inherited Playwright use values when project use only overrides browser-specific fields', () => {
  const environment = _private.buildProjectEnvironment(
    {
      baseURL: 'http://127.0.0.1:5001',
      headless: false,
    },
    {
      name: 'local-real-data',
      use: {
        browserName: 'chromium',
        channel: 'chrome',
      },
    },
  );

  assert.deepEqual(environment, {
    projectName: 'local-real-data',
    baseURL: 'http://127.0.0.1:5001',
    browserName: 'chromium',
    channel: 'chrome',
    headless: false,
  });
});

test('buildHistoricalTimingData groups timed checkpoints by action across retained runs', () => {
  const history = _private.buildHistoricalTimingData([
    {
      runId: 'run-3',
      startedAt: '2026-06-04T08:02:19.569Z',
      status: 'passed',
      durationMs: 5200,
      peakMemoryBytes: 125000000,
      checkpoints: [
        { key: 'startup-covers', label: 'Startup Covers Ready', timingMs: 1100, memoryBytes: null },
        { key: 'modal-open', label: 'Album Details Open', timingMs: 450, memoryBytes: null },
      ],
    },
    {
      runId: 'run-2',
      startedAt: '2026-06-04T07:02:19.569Z',
      status: 'failed',
      durationMs: 5400,
      peakMemoryBytes: 126000000,
      checkpoints: [
        { key: 'startup-covers', label: 'Startup Covers Ready', timingMs: 1200, memoryBytes: null },
      ],
    },
    {
      runId: 'run-1',
      startedAt: '2026-06-04T06:02:19.569Z',
      status: 'passed',
      durationMs: 5000,
      peakMemoryBytes: 124000000,
      checkpoints: [
        { key: 'startup-covers', label: 'Startup Covers Ready', timingMs: 1000, memoryBytes: null },
        { key: 'modal-open', label: 'Album Details Open', timingMs: 400, memoryBytes: null },
      ],
    },
  ]);

  assert.equal(history.runCount, 3);
  assert.deepEqual(history.runs.map((run) => run.runId), ['run-1', 'run-2', 'run-3']);
  assert.deepEqual(history.actions.map((action) => action.key), ['modal-open', 'startup-covers']);
  assert.deepEqual(
    history.actions.find((action) => action.key === 'startup-covers').points.map((point) => point.value),
    [1000, 1200, 1100],
  );
  assert.deepEqual(
    history.actions.find((action) => action.key === 'modal-open').points.map((point) => ({
      runIndex: point.runIndex,
      value: point.value,
    })),
    [
      { runIndex: 0, value: 400 },
      { runIndex: 2, value: 450 },
    ],
  );
  assert.deepEqual(
    history.overlays.averageTiming.map((point) => ({ runIndex: point.runIndex, value: point.value })),
    [
      { runIndex: 0, value: 700 },
      { runIndex: 1, value: 1200 },
      { runIndex: 2, value: 775 },
    ],
  );
  assert.deepEqual(
    history.overlays.medianTiming.map((point) => ({ runIndex: point.runIndex, value: point.value })),
    [
      { runIndex: 0, value: 700 },
      { runIndex: 1, value: 1200 },
      { runIndex: 2, value: 775 },
    ],
  );
});

test('buildLatestVerificationSummary aggregates the newest verification group by median and majority pass count', () => {
  const summary = _private.buildLatestVerificationSummary([
    {
      runId: 'run-5',
      startedAt: '2026-06-07T05:00:00.000Z',
      status: 'passed',
      verificationRunGroup: { id: 'all-artists-123', label: 'all-artists', attempt: 5, maxAttempts: 5 },
      benchmarkValidation: {
        results: [
          { key: 'selectedArtistGalleryMs', description: 'Selected artist gallery', units: 'ms', actual: 2100, targetMaximum: 2800, graceMs: 400, allowedMaximum: 3200, allowedText: '3200 ms', passed: true },
        ],
      },
    },
    {
      runId: 'run-4',
      startedAt: '2026-06-07T04:59:00.000Z',
      status: 'passed',
      verificationRunGroup: { id: 'all-artists-123', label: 'all-artists', attempt: 4, maxAttempts: 5 },
      benchmarkValidation: {
        results: [
          { key: 'selectedArtistGalleryMs', description: 'Selected artist gallery', units: 'ms', actual: 1900, targetMaximum: 2800, graceMs: 400, allowedMaximum: 3200, allowedText: '3200 ms', passed: true },
        ],
      },
    },
    {
      runId: 'run-3',
      startedAt: '2026-06-07T04:58:00.000Z',
      status: 'failed',
      verificationRunGroup: { id: 'all-artists-123', label: 'all-artists', attempt: 3, maxAttempts: 5 },
      benchmarkValidation: {
        results: [
          { key: 'selectedArtistGalleryMs', description: 'Selected artist gallery', units: 'ms', actual: 5000, targetMaximum: 2800, graceMs: 400, allowedMaximum: 3200, allowedText: '3200 ms', passed: false },
        ],
      },
    },
    {
      runId: 'run-2',
      startedAt: '2026-06-07T04:57:00.000Z',
      status: 'passed',
      verificationRunGroup: { id: 'all-artists-123', label: 'all-artists', attempt: 2, maxAttempts: 5 },
      benchmarkValidation: {
        results: [
          { key: 'selectedArtistGalleryMs', description: 'Selected artist gallery', units: 'ms', actual: 2000, targetMaximum: 2800, graceMs: 400, allowedMaximum: 3200, allowedText: '3200 ms', passed: true },
        ],
      },
    },
    {
      runId: 'run-1',
      startedAt: '2026-06-07T04:56:00.000Z',
      status: 'passed',
      verificationRunGroup: { id: 'all-artists-123', label: 'all-artists', attempt: 1, maxAttempts: 5 },
      benchmarkValidation: {
        results: [
          { key: 'selectedArtistGalleryMs', description: 'Selected artist gallery', units: 'ms', actual: 1800, targetMaximum: 2800, graceMs: 400, allowedMaximum: 3200, allowedText: '3200 ms', passed: true },
        ],
      },
    },
  ]);

  assert.equal(summary.aggregate.passed, true);
  assert.equal(summary.aggregate.metrics[0].medianActual, 2000);
  assert.equal(summary.aggregate.metrics[0].passCount, 4);
  assert.equal(summary.aggregate.metrics[0].requiredPassCount, 3);
});

test('verification summaries retain target and grace classification separately from the hard ceiling', () => {
  const summary = _private.buildVerificationMetricSummary([1, 2, 3].map((run) => ({
    benchmarkValidation: {
      results: [{
        key: 'selectedArtistSelectionMs',
        checkpointKey: 'selected-artist-selection-visible',
        units: 'ms',
        actual: 399,
        targetMaximum: 350,
        graceMs: 200,
        allowedMaximum: 550,
        passed: true,
      }],
    },
    run,
  })));

  assert.equal(summary.passed, true);
  assert.equal(summary.metrics[0].targetMaximum, 350);
  assert.equal(summary.metrics[0].graceMs, 200);
  assert.equal(summary.metrics[0].allowedMaximum, 550);
  assert.equal(summary.metrics[0].performanceStatus, 'grace-used');
  assert.equal(summary.metrics[0].graceUsed, true);
});

test('verification summaries use entry status for nonblocking uncalibrated process evidence', () => {
  const entry = (status) => ({
    status,
    benchmarkValidation: {
      results: [{
        key: 'uncalibratedMs',
        checkpointKey: 'uncalibrated-ms',
        units: 'ms',
        actual: 123,
        targetMaximum: null,
        graceMs: null,
        hardCeiling: null,
        allowedMaximum: null,
        calibrationState: 'uncalibrated',
        blocking: false,
        performanceStatus: 'uncalibrated',
        passed: status === 'passed',
      }],
    },
  });
  const majorityPassed = _private.buildVerificationMetricSummary([
    entry('passed'),
    entry('passed'),
    entry('failed'),
  ]);
  assert.equal(majorityPassed.metrics[0].performanceStatus, 'uncalibrated');
  assert.equal(majorityPassed.metrics[0].thresholdPassed, null);
  assert.equal(majorityPassed.metrics[0].passCount, 2);
  assert.equal(majorityPassed.passed, true);

  const failed = _private.buildVerificationMetricSummary([entry('failed')]);
  assert.equal(failed.metrics[0].performanceStatus, 'uncalibrated');
  assert.equal(failed.metrics[0].thresholdPassed, null);
  assert.equal(failed.metrics[0].passCount, 0);
  assert.equal(failed.passed, false);
});

test('verification summaries fail closed on effective-ceiling and sample-window policy drift', () => {
  const timingResult = (overrides = {}) => ({
    key: 'selectionMs',
    checkpointKey: 'selection',
    units: 'ms',
    actual: 300,
    targetMaximum: 350,
    graceMs: 200,
    hardCeiling: 550,
    allowedMaximum: 550,
    passed: true,
    performanceStatus: 'target-met',
    ...overrides,
  });
  const summarize = (results) => _private.buildVerificationMetricSummary(
    results.map((result) => ({ status: 'passed', benchmarkValidation: { results: [result] } })),
  );

  const ceilingDrift = summarize([
    timingResult(),
    timingResult({ hardCeiling: 600, allowedMaximum: 600 }),
  ]);
  const ceilingDisagreement = summarize([
    timingResult({ hardCeiling: 550, allowedMaximum: 600 }),
    timingResult({ hardCeiling: 550, allowedMaximum: 600 }),
  ]);
  const graceDrift = summarize([
    timingResult(),
    timingResult({ graceMs: 250 }),
  ]);
  const invalidGraceContract = summarize([
    timingResult({ graceMs: 100 }),
    timingResult({ graceMs: 100 }),
  ]);
  const memoryResult = (failingSampleCount) => ({
    key: 'allArtistsReturnMemoryBytes',
    checkpointKey: 'all-artists-return-memory',
    units: 'bytes',
    actual: 1025,
    hardCeiling: 1024,
    allowedMaximum: 1024,
    passed: true,
    performanceStatus: 'hard-fail',
    classificationPolicy: 'all-artists-return-memory-sample-window',
    sampleCount: 3,
    overThresholdCount: 1,
    failingSampleCount,
  });
  const policyDrift = summarize([memoryResult(2), memoryResult(3)]);
  assert.deepEqual({
    ceilingDrift: {
      passed: ceilingDrift.passed,
      contractConsistent: ceilingDrift.metrics[0].contractConsistent,
    },
    ceilingDisagreement: {
      passed: ceilingDisagreement.passed,
      passCount: ceilingDisagreement.metrics[0].passCount,
    },
    graceDrift: {
      passed: graceDrift.passed,
      contractConsistent: graceDrift.metrics[0].contractConsistent,
    },
    invalidGraceContract: {
      passed: invalidGraceContract.passed,
      passCount: invalidGraceContract.metrics[0].passCount,
    },
    policyDrift: {
      passed: policyDrift.passed,
      contractConsistent: policyDrift.metrics[0].contractConsistent,
    },
  }, {
    ceilingDrift: { passed: false, contractConsistent: false },
    ceilingDisagreement: { passed: false, passCount: 0 },
    graceDrift: { passed: false, contractConsistent: false },
    invalidGraceContract: { passed: false, passCount: 0 },
    policyDrift: { passed: false, contractConsistent: false },
  });
});

test('verification summaries fail closed for missing observations and timing targets', () => {
  const summary = _private.buildVerificationMetricSummary([{
    benchmarkValidation: {
      results: [
        { key: 'nullActual', units: 'ms', actual: null, targetMaximum: 350, allowedMaximum: 550, passed: true },
        { key: 'blankActual', units: 'ms', actual: ' ', targetMaximum: 350, allowedMaximum: 550, passed: true },
        { key: 'nonFiniteActual', units: 'ms', actual: Number.POSITIVE_INFINITY, targetMaximum: 350, allowedMaximum: 550, passed: true },
        { key: 'missingTarget', units: 'ms', actual: 100, targetMaximum: null, allowedMaximum: 550, passed: true },
      ],
    },
  }]);

  assert.equal(summary.passed, false);
  for (const metric of summary.metrics) {
    assert.equal(metric.passCount, 0);
    assert.equal(metric.passed, false);
    assert.equal(metric.performanceStatus, 'hard-fail');
  }
});

test('retained benchmark validation does not coerce missing timing evidence to zero', () => {
  const summarized = _private.summarizeBenchmarkValidation({
    results: [
      { checkpointKey: 'null', units: 'ms', actual: null, targetMaximum: 350, allowedMaximum: 550, passed: true },
      { checkpointKey: 'blank', units: 'ms', actual: '', targetMaximum: 350, allowedMaximum: 550, passed: true },
      { checkpointKey: 'negative', units: 'ms', actual: -1, targetMaximum: 350, allowedMaximum: 550, passed: true, performanceStatus: 'target-met' },
      { checkpointKey: 'missing-target', units: 'ms', actual: 100, allowedMaximum: 550, passed: true },
    ],
  });

  assert.deepEqual(summarized.results.map((result) => result.actual), [null, null, -1, 100]);
  assert.deepEqual(summarized.results.map((result) => result.passed), [false, false, false, false]);
  assert.deepEqual(
    summarized.results.map((result) => result.performanceStatus),
    ['hard-fail', 'hard-fail', 'hard-fail', 'hard-fail'],
  );
});

test('median returns the middle value for odd lists and the midpoint for even lists', () => {
  assert.equal(_private.median([900, 300, 600]), 600);
  assert.equal(_private.median([1000, 200, 600, 1400]), 800);
  assert.equal(_private.median([]), null);
});

test('trimRunsToRetentionWindow keeps only the latest 30 days of history', () => {
  const trimmed = _private.trimRunsToRetentionWindow([
    { runId: 'run-newest', startedAt: '2026-06-04T12:00:00.000Z' },
    { runId: 'run-kept-edge', startedAt: '2026-05-05T12:00:00.000Z' },
    { runId: 'run-dropped', startedAt: '2026-05-05T11:59:59.000Z' },
  ], 30, '2026-06-04T12:00:00.000Z');

  assert.deepEqual(trimmed.map((entry) => entry.runId), ['run-newest', 'run-kept-edge']);
});

test('single-line chart script wires full-chart hover regions and explicit point tooltips', () => {
  const html = _private.renderShell(
    'Chart Test',
    'Chart Test',
    'Hover values should be visible.',
    {},
    `
    app.innerHTML = buildLineChart(
      'Duration Trend',
      [
        { label: 'Run 1', value: 1000, runId: 'run-1' },
        { label: 'Run 2', value: 1200, runId: 'run-2' },
      ],
      formatMs,
      '#15616d',
    );
    `,
  );

  assert.ok(html.includes("const chartTooltip = document.createElement('div');"));
  assert.ok(html.includes("const chartLightbox = document.createElement('div');"));
  assert.ok(html.includes("function attachChartTooltips(root = document) {"));
  assert.ok(html.includes("function attachChartHoverRegions(root = document) {"));
  assert.ok(html.includes("function scrollChartContainersToLatest(root = document) {"));
  assert.ok(html.includes("function attachExpandableCharts(root = document) {"));
  assert.ok(html.includes("function buildYAxisMarkup(width, height, padding, formatter, maxValue, axisTitle) {"));
  assert.ok(html.includes("data-chart-tooltip=\"' + escapeHtml(tooltipText) + '\""));
  assert.ok(html.includes("data-chart-hover-area=\"1\""));
  assert.ok(html.includes("data-chart-hover-definition=\"' + escapeHtml(JSON.stringify(hoverDefinition)) + '\""));
  assert.ok(html.includes("data-chart-hover-markers"));
  assert.ok(html.includes("data-chart-expandable=\"1\""));
  assert.ok(html.includes("chart-hover-marker visible"));
  assert.ok(html.includes('chart-scroll'));
  assert.ok(html.includes('chart-shell'));
  assert.ok(html.includes('.chart {\n      min-height: 280px;\n      min-width: 0;\n      width: 100%;'));
  assert.ok(html.includes('.chart-shell {\n      position: relative;\n      min-width: 0;\n      width: 100%;'));
  assert.ok(html.includes('.chart-scroll {\n      width: 100%;\n      min-width: 0;'));
  assert.ok(html.includes('scrollEl.scrollLeft = maxScrollLeft;'));
  assert.ok(!html.includes("join('\n')"));
  assert.ok(html.includes(
    "<title>' + escapeHtml(pointLabel + ': ' + formatter(point.value) + pointRunLabel) + '</title>'",
  ));
});

test('single-line chart script can render dashed acceptable baseline reference lines', () => {
  const html = _private.renderShell(
    'Chart Test',
    'Chart Test',
    'Reference lines should be visible.',
    {},
    `
    app.innerHTML = buildLineChart(
      'Duration Trend',
      [
        { label: 'Run 1', value: 1000, runId: 'run-1' },
        { label: 'Run 2', value: 1200, runId: 'run-2' },
      ],
      formatMs,
      '#15616d',
      {
        referenceLines: [
          { value: 1100, label: 'Acceptable baseline', note: 'Reference threshold' },
        ],
      },
    );
    `,
  );

  assert.ok(html.includes('chart-reference-line'));
  assert.ok(html.includes('Acceptable baseline'));
  assert.ok(html.includes('chart-reference-chip'));
  assert.ok(html.includes('chart-reference-label'));
  assert.ok(html.includes("stroke-dasharray=\"' + escapeHtml(entry.dashArray) + '\""));
  assert.ok(html.includes("stroke=\"' + escapeHtml(entry.color) + '\""));
  assert.ok(html.includes("color: entry?.color || ghostColor(color)"));
});

test('buildRetainedArtifactEntries excludes metrics attachment and keeps failure artifacts', () => {
  const entries = _private.buildRetainedArtifactEntries([
    { name: 'performance-report-metrics', body: '{"ok":true}', contentType: 'application/json' },
    { name: 'failure-screenshot.png', body: Buffer.from([1, 2, 3]), contentType: 'image/png' },
    { name: 'playwright-trace.zip', path: 'C:\\temp\\playwright-trace.zip', contentType: 'application/zip' },
  ]);

  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.name), ['failure-screenshot.png', 'playwright-trace.zip']);
});

test('materializeRetainedArtifacts copies screenshot and trace into the retained run folder', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-report-artifacts-'));
  const sourceTracePath = path.join(tempRoot, 'source-trace.zip');
  const runDir = path.join(tempRoot, 'run');
  fs.writeFileSync(sourceTracePath, Buffer.from('trace-bytes'));

  const retained = _private.materializeRetainedArtifacts([
    {
      key: 'failure-screenshot-1',
      name: 'failure-screenshot.png',
      contentType: 'image/png',
      body: Buffer.from([7, 8, 9]),
    },
    {
      key: 'playwright-trace-2',
      name: 'playwright-trace.zip',
      contentType: 'application/zip',
      path: sourceTracePath,
    },
  ], runDir);

  assert.deepEqual(retained.map((entry) => entry.kind), ['image', 'trace']);
  assert.ok(fs.existsSync(path.join(runDir, retained[0].relativePath)));
  assert.ok(fs.existsSync(path.join(runDir, retained[1].relativePath)));
  assert.deepEqual([...fs.readFileSync(path.join(runDir, retained[0].relativePath))], [7, 8, 9]);
  assert.equal(fs.readFileSync(path.join(runDir, retained[1].relativePath), 'utf8'), 'trace-bytes');
});

test('pruneTraceArtifactsForRun removes the stored trace artifact when the run falls outside the trace retention window', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-report-trace-prune-'));
  const runDir = path.join(tempRoot, 'run');
  fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
  const tracePath = path.join(runDir, 'artifacts', 'playwright-trace.zip');
  fs.writeFileSync(tracePath, Buffer.from('trace-bytes'));

  const runMetrics = {
    retainedArtifacts: [
      { kind: 'image', name: 'failure-screenshot.png', relativePath: 'artifacts/failure-screenshot.png' },
      { kind: 'trace', name: 'playwright-trace.zip', relativePath: 'artifacts/playwright-trace.zip' },
    ],
  };

  const didChange = _private.pruneTraceArtifactsForRun(runMetrics, runDir, false);

  assert.equal(didChange, true);
  assert.deepEqual(runMetrics.retainedArtifacts.map((entry) => entry.kind), ['image']);
  assert.equal(fs.existsSync(tracePath), false);
});

test('pruneRetainedTraceArtifacts keeps traces only for the latest 7 retained runs', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-report-trace-window-'));
  const suiteDir = path.join(tempRoot, 'idleMemory');
  const runsDir = path.join(suiteDir, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });

  const manifestRuns = [];
  for (let index = 0; index < 9; index += 1) {
    const runId = `run-${index + 1}`;
    const runDir = path.join(runsDir, runId);
    fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'artifacts', 'playwright-trace.zip'), Buffer.from(`trace-${index + 1}`));
    const runMetrics = {
      runId,
      retainedArtifacts: [
        { kind: 'trace', name: 'playwright-trace.zip', relativePath: 'artifacts/playwright-trace.zip' },
      ],
    };
    fs.writeFileSync(path.join(runDir, 'metrics.json'), JSON.stringify(runMetrics, null, 2));
    manifestRuns.push({
      runId,
      metricsPath: `runs/${runId}/metrics.json`,
      reportPath: `runs/${runId}/report.html`,
    });
  }

  const updatedRunMetrics = _private.pruneRetainedTraceArtifacts(manifestRuns, suiteDir, 7);

  assert.equal(updatedRunMetrics.size, 9);
  for (let index = 0; index < 9; index += 1) {
    const runId = `run-${index + 1}`;
    const tracePath = path.join(runsDir, runId, 'artifacts', 'playwright-trace.zip');
    const retainedArtifacts = updatedRunMetrics.get(runId).retainedArtifacts;
    if (index < 7) {
      assert.equal(fs.existsSync(tracePath), true, `${runId} should keep its trace`);
      assert.deepEqual(retainedArtifacts.map((entry) => entry.kind), ['trace']);
    } else {
      assert.equal(fs.existsSync(tracePath), false, `${runId} should have its trace pruned`);
      assert.deepEqual(retainedArtifacts, []);
    }
  }
});

test('pruneGlobalRetainedTraceArtifacts keeps traces only for the latest 7 retained runs across all suites', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-report-global-trace-window-'));
  const historyRoot = path.join(tempRoot, 'playwrightPerformanceHistory');
  const suiteIds = ['allArtistsLocal', 'artistFamilyLocal'];

  for (const suiteId of suiteIds) {
    fs.mkdirSync(path.join(historyRoot, suiteId, 'runs'), { recursive: true });
  }

  for (let index = 0; index < 5; index += 1) {
    for (let suiteIndex = 0; suiteIndex < suiteIds.length; suiteIndex += 1) {
      const suiteId = suiteIds[suiteIndex];
      const runId = `${suiteId}-run-${index + 1}`;
      const suiteDir = path.join(historyRoot, suiteId);
      const runDir = path.join(suiteDir, 'runs', runId);
      fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
      fs.writeFileSync(path.join(runDir, 'artifacts', 'playwright-trace.zip'), Buffer.from(`${suiteId}-trace-${index + 1}`));
      fs.writeFileSync(path.join(runDir, 'metrics.json'), JSON.stringify({
        runId,
        retainedArtifacts: [
          { kind: 'trace', name: 'playwright-trace.zip', relativePath: 'artifacts/playwright-trace.zip' },
        ],
      }, null, 2));
    }
  }

  for (const suiteId of suiteIds) {
    const suiteDir = path.join(historyRoot, suiteId);
    const runs = [];
    for (let index = 0; index < 5; index += 1) {
      const runId = `${suiteId}-run-${index + 1}`;
      const startedAt = new Date(Date.UTC(2026, 5, 9, 4, (suiteId === 'allArtistsLocal' ? 0 : 10) + index, 0)).toISOString();
      runs.push({
        runId,
        startedAt,
        metricsPath: `runs/${runId}/metrics.json`,
        reportPath: `runs/${runId}/report.html`,
      });
    }
    fs.writeFileSync(path.join(suiteDir, 'index.json'), JSON.stringify({
      reportId: suiteId,
      runs,
    }, null, 2));
  }

  const updatedRunMetrics = _private.pruneGlobalRetainedTraceArtifacts(historyRoot, 7);

  assert.equal(updatedRunMetrics.size, 10);
  for (const suiteId of suiteIds) {
    for (let index = 0; index < 5; index += 1) {
      const runId = `${suiteId}-run-${index + 1}`;
      const tracePath = path.join(historyRoot, suiteId, 'runs', runId, 'artifacts', 'playwright-trace.zip');
      const runMetrics = updatedRunMetrics.get(`${path.resolve(path.join(historyRoot, suiteId))}::${runId}`);
      const shouldKeepTrace = suiteId === 'artistFamilyLocal' || index >= 3;
      assert.ok(runMetrics, `expected cached metrics for ${runId}`);
      if (shouldKeepTrace) {
        assert.equal(fs.existsSync(tracePath), true, `${runId} should keep its trace`);
        assert.deepEqual(runMetrics.retainedArtifacts.map((entry) => entry.kind), ['trace']);
      } else {
        assert.equal(fs.existsSync(tracePath), false, `${runId} should have its trace pruned`);
        assert.deepEqual(runMetrics.retainedArtifacts, []);
      }
    }
  }
});

test('run report includes failure artifact section and trace link', () => {
  const html = _private.renderRunReport({
    runId: '2026-06-04T13-27-32-219Z',
    reportId: 'allArtistsLocal',
    reportTitle: 'All Artists Real-Data Responsiveness Benchmark',
    intro: 'Failed runs should keep visible artifacts.',
    status: 'failed',
    title: 'Failure report',
    caseId: 'FTC-GALLERY-STARTUP-005A',
    startedAt: '2026-06-04T13:27:32.219Z',
    finishedAt: '2026-06-04T13:28:34.611Z',
    durationMs: 62392,
    environment: {
      projectName: 'local-real-data',
      baseURL: 'http://127.0.0.1:5001',
      browserName: 'chromium',
      channel: 'chrome',
      headless: false,
    },
    summaryCards: [],
    rawMetrics: {},
    stepEvents: [],
    stepTranscript: [],
    checkpoints: [],
    timingCheckpoints: [],
    memoryCheckpoints: [],
    timingSeries: [],
    memorySeries: [],
    peakMemoryBytes: 0,
    retainedArtifacts: [
      { kind: 'image', name: 'failure-screenshot.png', relativePath: 'artifacts/failure-screenshot.png' },
      { kind: 'trace', name: 'playwright-trace.zip', relativePath: 'artifacts/playwright-trace.zip' },
      { kind: 'file', name: 'stacktrace.txt', relativePath: 'artifacts/stacktrace.txt', body: 'Error 1\\nTimeoutError: boom' },
    ],
  }, {
    runs: [],
  }, '..');

  assert.ok(html.includes('Failure Artifacts'));
  assert.ok(html.includes('Download Playwright Trace'));
  assert.ok(html.includes('Download Stacktrace'));
  assert.ok(html.includes('Failure screenshot preview'));
});

test('run report renders a collapsed stacktrace section near the top when a stacktrace artifact exists', () => {
  const html = _private.renderRunReport({
    runId: '2026-06-04T13-27-32-219Z',
    reportId: 'allArtistsLocal',
    reportTitle: 'All Artists Real-Data Responsiveness Benchmark',
    intro: 'Failed runs should surface the stacktrace early.',
    status: 'failed',
    title: 'Failure report',
    caseId: 'FTC-GALLERY-STARTUP-005A',
    startedAt: '2026-06-04T13:27:32.219Z',
    finishedAt: '2026-06-04T13:28:34.611Z',
    durationMs: 62392,
    environment: {
      projectName: 'local-real-data',
      baseURL: 'http://127.0.0.1:5001',
      browserName: 'chromium',
      channel: 'chrome',
      headless: false,
    },
    summaryCards: [],
    rawMetrics: {},
    stepEvents: [],
    stepTranscript: [],
    checkpoints: [],
    timingCheckpoints: [],
    memoryCheckpoints: [],
    timingSeries: [],
    memorySeries: [],
    peakMemoryBytes: 0,
    retainedArtifacts: [
      { kind: 'file', name: 'stacktrace.txt', relativePath: 'artifacts/stacktrace.txt', body: 'Error 1\nTimeoutError: boom' },
    ],
  }, {
    runs: [],
  }, '..');

  assert.ok(html.includes('<details class="panel collapsible-panel">'));
  assert.ok(html.includes('Failure Reason'));
  assert.ok(html.includes('Failure Stacktrace'));
  assert.ok(html.includes('Captured Failure Stacktrace'));
  assert.ok(html.includes('TimeoutError: boom'));
  assert.ok(!html.includes('<details class="panel collapsible-panel" open>'));
});

test('run report strips ANSI color codes and surfaces failure summary reasons before the raw stacktrace', () => {
  const html = _private.renderRunReport({
    runId: '2026-06-04T13-27-32-219Z',
    reportId: 'allArtistsLocal',
    reportTitle: 'All Artists Real-Data Responsiveness Benchmark',
    intro: 'Failed runs should show a clean summary first.',
    status: 'failed',
    title: 'Failure report',
    caseId: 'FTC-GALLERY-STARTUP-005A',
    startedAt: '2026-06-04T13:27:32.219Z',
    finishedAt: '2026-06-04T13:28:34.611Z',
    durationMs: 62392,
    environment: {
      projectName: 'local-real-data',
      baseURL: 'http://127.0.0.1:5001',
      browserName: 'chromium',
      channel: 'chrome',
      headless: false,
    },
    summaryCards: [],
    rawMetrics: {},
    stepEvents: [
      {
        type: 'step',
        level: 1,
        label: 'Assert the retained benchmark ceilings',
        status: 'failed',
        durationMs: 7,
        message: '\u001b[31mThreshold exceeded\u001b[39m for startup-preview-sidebar',
      },
    ],
    stepTranscript: [],
    checkpoints: [],
    timingCheckpoints: [],
    memoryCheckpoints: [],
    timingSeries: [],
    memorySeries: [],
    peakMemoryBytes: 0,
    retainedArtifacts: [
      {
        kind: 'file',
        name: 'stacktrace.txt',
        relativePath: 'artifacts/stacktrace.txt',
        body: 'Error 1\n\u001b[31mThreshold exceeded\u001b[39m for startup-preview-sidebar\nExpected: <= 320\nReceived: 580',
      },
    ],
  }, {
    runs: [],
  }, '..');

  assert.ok(html.includes('Failure Reason'));
  assert.ok(html.includes('Assert the retained benchmark ceilings'));
  assert.ok(html.includes('Threshold exceeded'));
  assert.ok(html.includes('Assertion details'));
  assert.ok(html.includes('stacktrace-line-number'));
  assert.ok(html.includes('normalizeReportText('));
});

test('run report highlights the owning Playwright test and step timeline', () => {
  const html = _private.renderRunReport({
    runId: '2026-06-04T13-27-32-219Z',
    reportId: 'allArtistsLocal',
    reportTitle: 'All Artists Real-Data Responsiveness Benchmark',
    intro: 'Passed runs should still show test-owned step timings clearly.',
    status: 'passed',
    title: 'All Artists round-trip reports real-data responsiveness and memory timings',
    caseId: 'FTC-GALLERY-STARTUP-005A',
    startedAt: '2026-06-04T13:27:32.219Z',
    finishedAt: '2026-06-04T13:28:34.611Z',
    durationMs: 62392,
    environment: {
      projectName: 'local-real-data',
      baseURL: 'http://127.0.0.1:5001',
      browserName: 'chromium',
      channel: 'chrome',
      headless: false,
    },
    summaryCards: [],
    rawMetrics: {},
    stepEvents: [
      { level: 1, label: 'Load the real All Artists view and capture startup responsiveness checkpoints', durationMs: 1800 },
      { level: 1, label: 'Return to All Artists and record responsiveness plus memory after the round-trip', durationMs: 950 },
    ],
    stepTranscript: [
      '[TEST] All Artists round-trip reports real-data responsiveness and memory timings',
      '  [STEP] Load the real All Artists view and capture startup responsiveness checkpoints',
      '  [PASS] Load the real All Artists view and capture startup responsiveness checkpoints (1800 ms)',
    ],
    checkpoints: [],
    timingCheckpoints: [],
    memoryCheckpoints: [],
    timingSeries: [
      { key: 'step-1', label: 'Load the real All Artists view and capture startup responsiveness checkpoints', value: 1800 },
      { key: 'step-2', label: 'Return to All Artists and record responsiveness plus memory after the round-trip', value: 950 },
    ],
    memorySeries: [],
    peakMemoryBytes: 0,
    retainedArtifacts: [],
  }, {
    runs: [],
  }, '..');

  assert.ok(html.includes('Playwright Test Run'));
  assert.ok(html.includes('Test-Owned Step Timeline'));
  assert.ok(html.includes('[TEST] All Artists round-trip reports real-data responsiveness and memory timings'));
  assert.ok(html.includes('Primary step/checkpoint timings for'));
  assert.ok(html.includes('&#10003;'));
});

test('run report adds acceptable baseline lines to retained timing trend charts when benchmark ceilings are available', () => {
  const html = _private.renderRunReport({
    runId: '2026-06-04T13-27-32-219Z',
    reportId: 'allArtistsLocal',
    reportTitle: 'All Artists Real-Data Responsiveness Benchmark',
    intro: 'Trend charts should include acceptable baselines.',
    status: 'passed',
    title: 'All Artists round-trip reports real-data responsiveness and memory timings',
    caseId: 'FTC-GALLERY-STARTUP-005A',
    startedAt: '2026-06-04T13:27:32.219Z',
    finishedAt: '2026-06-04T13:28:34.611Z',
    durationMs: 62392,
    environment: {
      projectName: 'local-real-data',
      baseURL: 'http://127.0.0.1:5001',
      browserName: 'chromium',
      channel: 'chrome',
      headless: false,
    },
    summaryCards: [],
    rawMetrics: {
      benchmarkValidation: {
        results: [
          {
            key: 'startupPreviewSidebarMs',
            checkpointKey: 'startup-preview-sidebar',
            description: 'Startup preview sidebar should appear quickly from the cached preview.',
            actual: 399,
            actualText: '399 ms',
            targetMaximum: 350,
            graceMs: 200,
            hardCeiling: 550,
            allowedMaximum: 550,
            allowedText: '550 ms',
            performanceStatus: 'grace-used',
            graceUsed: true,
            passed: true,
          },
        ],
      },
    },
    stepEvents: [],
    stepTranscript: [],
    checkpoints: [
      { key: 'startup-preview-sidebar', label: 'Startup preview sidebar count 19 appeared', timingMs: 150, memoryBytes: null },
    ],
    timingCheckpoints: [
      { key: 'startup-preview-sidebar', label: 'Startup preview sidebar count 19 appeared', timingMs: 150, memoryBytes: null },
    ],
    memoryCheckpoints: [],
    timingSeries: [
      { key: 'startup-preview-sidebar', label: 'Startup preview sidebar count 19 appeared', value: 150 },
    ],
    memorySeries: [],
    peakMemoryBytes: 0,
    retainedArtifacts: [],
  }, {
    runs: [
      {
        runId: '2026-06-04T13-27-32-219Z',
        startedAt: '2026-06-04T13:27:32.219Z',
        status: 'passed',
        durationMs: 62392,
        peakMemoryBytes: 0,
        checkpoints: [
          { key: 'startup-preview-sidebar', label: 'Startup preview sidebar count 19 appeared', timingMs: 150, memoryBytes: null },
        ],
      },
    ],
  }, '..');

  assert.ok(html.includes('chart-reference-line'));
  assert.ok(html.includes('referenceLines: acceptableBaselineForCheckpoint(action.key)'));
  assert.ok(html.includes("color: referenceLine?.color || ghostColor(entry.color)"));
  assert.ok(html.includes("'Time (ms)'"));
  assert.ok(html.includes('"checkpointKey":"startup-preview-sidebar"'));
  assert.ok(html.includes('Performance Contracts'));
  assert.ok(html.includes('Grace usage passes the guard without counting as target attainment.'));
  assert.ok(html.includes('"performanceStatus":"grace-used"'));
  assert.ok(html.includes("performanceStatus || (result.passed ? 'target-met' : 'hard-fail')"));
  assert.ok(html.includes('"targetMaximum":350'));
  assert.ok(html.includes('"graceMs":200'));
  assert.ok(html.includes('"allowedMaximum":550'));
});

test('retained report views auto-scroll wide charts to the latest retained runs', () => {
  const html = _private.renderRunReport({
    runId: '2026-06-04T13-27-32-219Z',
    reportId: 'allArtistsLocal',
    reportTitle: 'All Artists Real-Data Responsiveness Benchmark',
    intro: 'Wide charts should open focused on the newest data.',
    status: 'passed',
    title: 'All Artists round-trip reports real-data responsiveness and memory timings',
    caseId: 'FTC-GALLERY-STARTUP-005A',
    startedAt: '2026-06-04T13:27:32.219Z',
    finishedAt: '2026-06-04T13:28:34.611Z',
    durationMs: 62392,
    environment: {
      projectName: 'local-real-data',
      baseURL: 'http://127.0.0.1:5001',
      browserName: 'chromium',
      channel: 'chrome',
      headless: false,
    },
    summaryCards: [],
    rawMetrics: {},
    stepEvents: [],
    stepTranscript: [],
    checkpoints: [],
    timingCheckpoints: [],
    memoryCheckpoints: [],
    timingSeries: [
      { key: 'step-1', label: 'Step 1', value: 150 },
      { key: 'step-2', label: 'Step 2', value: 200 },
    ],
    memorySeries: [
      { key: 'memory-1', label: 'Memory 1', value: 1_000_000 },
      { key: 'memory-2', label: 'Memory 2', value: 1_100_000 },
    ],
    peakMemoryBytes: 1_100_000,
    retainedArtifacts: [],
  }, {
    runs: [
      {
        runId: 'run-1',
        startedAt: '2026-06-04T12:27:32.219Z',
        status: 'passed',
        durationMs: 60000,
        peakMemoryBytes: 1000000,
        checkpoints: [
          { key: 'startup-preview-sidebar', label: 'Startup preview sidebar', timingMs: 150, memoryBytes: null },
        ],
      },
      {
        runId: 'run-2',
        startedAt: '2026-06-04T13:27:32.219Z',
        status: 'passed',
        durationMs: 62392,
        peakMemoryBytes: 1100000,
        checkpoints: [
          { key: 'startup-preview-sidebar', label: 'Startup preview sidebar', timingMs: 175, memoryBytes: null },
        ],
      },
    ],
  }, '..');

  assert.ok(html.includes('scrollChartContainersToLatest(body);'));
  assert.ok(html.includes('scrollChartContainersToLatest(target);'));
  assert.ok(html.includes('scrollChartContainersToLatest(app);'));
  assert.ok(html.includes("window.requestAnimationFrame(() => {"));
});

test('run report falls back to retained history benchmark validation when the current failed run is missing it', () => {
  const html = _private.renderRunReport({
    runId: '2026-06-04T20-03-49-714Z',
    reportId: 'allArtistsLocal',
    reportTitle: 'All Artists Real-Data Responsiveness Benchmark',
    intro: 'Failed runs should still keep acceptable baselines visible.',
    status: 'failed',
    title: 'All Artists round-trip reports real-data responsiveness and memory timings',
    caseId: 'FTC-GALLERY-STARTUP-005A',
    startedAt: '2026-06-04T20:03:49.714Z',
    finishedAt: '2026-06-04T20:04:20.935Z',
    durationMs: 31221,
    environment: {
      projectName: 'local-real-data',
      baseURL: 'http://127.0.0.1:5001',
      browserName: 'chromium',
      channel: 'chrome',
      headless: false,
    },
    summaryCards: [],
    rawMetrics: {},
    stepEvents: [],
    stepTranscript: [],
    checkpoints: [
      { key: 'startup-preview-sidebar', label: 'Startup preview sidebar count 40 appeared', timingMs: 89, memoryBytes: 26083512 },
    ],
    timingCheckpoints: [
      { key: 'startup-preview-sidebar', label: 'Startup preview sidebar count 40 appeared', timingMs: 89, memoryBytes: 26083512 },
    ],
    memoryCheckpoints: [],
    timingSeries: [
      { key: 'startup-preview-sidebar', label: 'Startup preview sidebar count 40 appeared', value: 89 },
    ],
    memorySeries: [],
    peakMemoryBytes: 26083512,
    retainedArtifacts: [],
  }, {
    runs: [
      {
        runId: '2026-06-04T20-03-49-714Z',
        startedAt: '2026-06-04T20:03:49.714Z',
        status: 'failed',
        durationMs: 31221,
        peakMemoryBytes: 26083512,
        checkpoints: [
          { key: 'startup-preview-sidebar', label: 'Startup preview sidebar count 40 appeared', timingMs: 89, memoryBytes: 26083512 },
        ],
      },
      {
        runId: '2026-06-04T17-36-55-384Z',
        startedAt: '2026-06-04T17:36:55.384Z',
        status: 'passed',
        durationMs: 45050,
        peakMemoryBytes: 19420576,
        checkpoints: [
          { key: 'startup-preview-sidebar', label: 'Startup preview sidebar count 40 appeared', timingMs: 105, memoryBytes: 7469548 },
        ],
        benchmarkValidation: {
          benchmarkId: 'all-artists-local-managed-chrome',
          benchmarkVersion: '2026-06-04-managed-chrome-five-run-baseline',
          results: [
            {
              key: 'startupPreviewSidebarMs',
              checkpointKey: 'startup-preview-sidebar',
              description: 'Startup preview sidebar should appear quickly from the cached preview.',
              units: 'ms',
              allowedMaximum: 881,
              allowedText: '881 ms',
            },
          ],
        },
      },
    ],
  }, '..');

  assert.ok(html.includes('chart-reference-line'));
  assert.ok(html.includes('"checkpointKey":"startup-preview-sidebar"'));
  assert.ok(html.includes('"allowedMaximum":881'));
});

test('run report rebuilds local real-data summary cards from raw metrics so retained runs do not stay stuck at 0 ms', () => {
  const html = _private.renderRunReport({
    runId: '2026-06-04T20-03-49-714Z',
    reportId: 'allArtistsLocal',
    reportTitle: 'All Artists Real-Data Responsiveness Benchmark',
    intro: 'Retained local runs should recover from stale summary cards.',
    status: 'failed',
    title: 'All Artists round-trip reports real-data responsiveness and memory timings',
    caseId: 'FTC-GALLERY-STARTUP-005A',
    startedAt: '2026-06-04T20:03:49.714Z',
    finishedAt: '2026-06-04T20:04:20.935Z',
    durationMs: 31221,
    environment: {
      projectName: 'local-real-data',
      baseURL: 'http://127.0.0.1:5001',
      browserName: 'chromium',
      channel: 'chrome',
      headless: false,
    },
    summaryCards: [
      { label: 'Startup Covers Ready', value: '0 ms', note: 'stale' },
      { label: 'Return Covers Ready', value: '0 ms', note: 'stale' },
      { label: 'Peak Idle Memory', value: '0.0 MB', note: 'stale' },
      { label: 'Album Details Open', value: '0 ms', note: 'stale' },
    ],
    rawMetrics: {
      startupSidebarHydration: { coversMs: 92 },
      allArtistsCoversMs: 1584,
      albumDetailsOpenMs: 486,
    },
    stepEvents: [],
    stepTranscript: [],
    checkpoints: [
      { key: 'startup-visible-covers', label: 'Initial All Artists visible covers ready', timingMs: 92, memoryBytes: 25856996 },
      { key: 'all-artists-visible-covers', label: 'All artists visible covers ready again', timingMs: 1584, memoryBytes: 26429196 },
      { key: 'album-details-open', label: 'Album details opened', timingMs: 486, memoryBytes: 26927808 },
      { key: 'final-idle-memory', label: 'Peak idle memory after modal close', timingMs: null, memoryBytes: 44339272 },
    ],
    timingCheckpoints: [],
    memoryCheckpoints: [
      { key: 'startup-visible-covers', label: 'Initial All Artists visible covers ready', timingMs: 92, memoryBytes: 25856996 },
      { key: 'all-artists-visible-covers', label: 'All artists visible covers ready again', timingMs: 1584, memoryBytes: 26429196 },
      { key: 'album-details-open', label: 'Album details opened', timingMs: 486, memoryBytes: 26927808 },
      { key: 'final-idle-memory', label: 'Peak idle memory after modal close', timingMs: null, memoryBytes: 44339272 },
    ],
    timingSeries: [],
    memorySeries: [],
    peakMemoryBytes: 44339272,
    retainedArtifacts: [],
  }, {
    runs: [],
  }, '..');

  assert.ok(html.includes('92 ms'));
  assert.ok(html.includes('1584 ms'));
  assert.ok(html.includes('486 ms'));
  assert.ok(html.includes('42.3 MB'));
  assert.ok(html.includes('Initial All Artists visible covers'));
  assert.ok(html.includes('After the artist round-trip'));
});

test('run report charts can open an enlarged double-click view', () => {
  const html = _private.renderRunReport({
    runId: '2026-06-04T13-27-32-219Z',
    reportId: 'allArtistsLocal',
    reportTitle: 'All Artists Real-Data Responsiveness Benchmark',
    intro: 'Expanded chart view should be available.',
    status: 'passed',
    title: 'All Artists round-trip reports real-data responsiveness and memory timings',
    caseId: 'FTC-GALLERY-STARTUP-005A',
    startedAt: '2026-06-04T13:27:32.219Z',
    finishedAt: '2026-06-04T13:28:34.611Z',
    durationMs: 62392,
    environment: {
      projectName: 'local-real-data',
      baseURL: 'http://127.0.0.1:5001',
      browserName: 'chromium',
      channel: 'chrome',
      headless: false,
    },
    summaryCards: [],
    rawMetrics: {},
    stepEvents: [],
    stepTranscript: [],
    checkpoints: [],
    timingCheckpoints: [],
    memoryCheckpoints: [],
    timingSeries: [
      { key: 'startup-preview-sidebar', label: 'Startup preview sidebar count 19 appeared', value: 150 },
    ],
    memorySeries: [],
    peakMemoryBytes: 0,
    retainedArtifacts: [],
  }, {
    runs: [],
  }, '..');

  assert.ok(html.includes('chart-lightbox'));
  assert.ok(html.includes('Close enlarged chart'));
  assert.ok(html.includes("panel.addEventListener('dblclick'"));
  assert.ok(html.includes('chartShell.outerHTML'));
});

test('run report keeps graphs before steps and failure screenshot after step sections', () => {
  const html = _private.renderRunReport({
    runId: '2026-06-04T13-27-32-219Z',
    reportId: 'allArtistsLocal',
    reportTitle: 'All Artists Real-Data Responsiveness Benchmark',
    intro: 'Reports should stay chart-first and keep screenshots below steps.',
    status: 'failed',
    title: 'All Artists round-trip reports real-data responsiveness and memory timings',
    caseId: 'FTC-GALLERY-STARTUP-005A',
    startedAt: '2026-06-04T13:27:32.219Z',
    finishedAt: '2026-06-04T13:28:34.611Z',
    durationMs: 62392,
    environment: {
      projectName: 'local-real-data',
      baseURL: 'http://127.0.0.1:5001',
      browserName: 'chromium',
      channel: 'chrome',
      headless: false,
    },
    summaryCards: [],
    rawMetrics: {},
    stepEvents: [
      { level: 1, label: 'Load the real All Artists view and capture startup responsiveness checkpoints', durationMs: 1800 },
    ],
    stepTranscript: [
      '[TEST] All Artists round-trip reports real-data responsiveness and memory timings',
      '  [STEP] Load the real All Artists view and capture startup responsiveness checkpoints',
      '  [PASS] Load the real All Artists view and capture startup responsiveness checkpoints (1800 ms)',
    ],
    checkpoints: [],
    timingCheckpoints: [],
    memoryCheckpoints: [],
    timingSeries: [
      { key: 'step-1', label: 'Load the real All Artists view and capture startup responsiveness checkpoints', value: 1800 },
    ],
    memorySeries: [],
    peakMemoryBytes: 0,
    retainedArtifacts: [
      { kind: 'image', name: 'failure-screenshot.png', relativePath: 'artifacts/failure-screenshot.png' },
    ],
  }, {
    runs: [],
  }, '..');

  const layoutBlock = html.slice(html.indexOf('app.innerHTML ='));
  assert.ok(html.indexOf('Current Run Timing Sequence') < html.indexOf('Playwright Test Run'));
  assert.ok(layoutBlock.indexOf('Step Transcript') < layoutBlock.indexOf('failureArtifactsSection'));
});

test('idle-memory run report omits timing-only charts and keeps memory-focused graphs', () => {
  const html = _private.renderRunReport({
    runId: '2026-06-05T00-31-30-537Z',
    reportId: 'idleMemory',
    reportTitle: 'Idle Gallery Memory Benchmark',
    intro: 'Idle-memory reports should stay focused on memory-retention charts.',
    status: 'passed',
    title: 'Idle gallery memory stays under the budget once startup settles',
    caseId: 'FTC-GALLERY-STARTUP-005',
    startedAt: '2026-06-05T00:31:30.537Z',
    finishedAt: '2026-06-05T00:31:47.612Z',
    durationMs: 17075,
    environment: {
      projectName: 'idle-memory',
      baseURL: 'http://127.0.0.1:4173',
      browserName: 'chromium',
      channel: '',
      headless: false,
    },
    summaryCards: [],
    rawMetrics: {},
    stepEvents: [
      { level: 1, label: 'Open All Artists and wait for the gallery to settle', durationMs: 1875 },
      { level: 1, label: 'Scroll to the middle of the gallery and wait for visible covers', durationMs: 8733 },
    ],
    stepTranscript: [
      '[TEST] Idle gallery memory stays under the budget once startup settles',
    ],
    checkpoints: [
      { key: 'scrolled-gallery-idle-1', label: 'Scrolled gallery idle sample 1', timingMs: null, memoryBytes: 5495420, memorySource: 'Runtime.getHeapUsage' },
      { key: 'detail-run-1-sample-1', label: 'Album detail 1 idle sample 1', timingMs: null, memoryBytes: 4769508, memorySource: 'Runtime.getHeapUsage' },
    ],
    timingCheckpoints: [],
    memoryCheckpoints: [
      { key: 'scrolled-gallery-idle-1', label: 'Scrolled gallery idle sample 1', timingMs: null, memoryBytes: 5495420, memorySource: 'Runtime.getHeapUsage' },
      { key: 'detail-run-1-sample-1', label: 'Album detail 1 idle sample 1', timingMs: null, memoryBytes: 4769508, memorySource: 'Runtime.getHeapUsage' },
    ],
    timingSeries: [
      { key: 'step-1', label: 'Open All Artists and wait for the gallery to settle', value: 1875 },
      { key: 'step-2', label: 'Scroll to the middle of the gallery and wait for visible covers', value: 8733 },
    ],
    memorySeries: [
      { key: 'scrolled-gallery-idle-1', label: 'Scrolled gallery idle sample 1', value: 5495420 },
      { key: 'detail-run-1-sample-1', label: 'Album detail 1 idle sample 1', value: 4769508 },
    ],
    peakMemoryBytes: 5495420,
    retainedArtifacts: [],
  }, {
    runs: [
      {
        runId: '2026-06-05T00-31-30-537Z',
        startedAt: '2026-06-05T00:31:30.537Z',
        durationMs: 17075,
        peakMemoryBytes: 5495420,
        checkpoints: [
          { key: 'scrolled-gallery-idle-1', label: 'Scrolled gallery idle sample 1', timingMs: null, memoryBytes: 5495420 },
        ],
      },
    ],
  }, '..');

  const currentRunSectionBlock = html.slice(
    html.indexOf('const currentRunChartsSection = isIdleMemoryReport'),
    html.indexOf('const retainedTrendSection = isIdleMemoryReport'),
  );
  const retainedTrendSectionBlock = html.slice(
    html.indexOf('const retainedTrendSection = isIdleMemoryReport'),
    html.indexOf('const retainedTimingSection = isIdleMemoryReport'),
  );
  const retainedTimingSectionBlock = html.slice(
    html.indexOf('const retainedTimingSection = isIdleMemoryReport'),
    html.indexOf('const screenshotArtifact ='),
  );

  assert.ok(currentRunSectionBlock.includes("buildLineChart('Current Run Memory Sequence'"));
  assert.ok(currentRunSectionBlock.includes("'Current Run Timing Sequence'"));
  assert.ok(retainedTrendSectionBlock.includes("buildLineChart('30-Day Peak Memory Trend'"));
  assert.ok(retainedTrendSectionBlock.includes("'30-Day Duration Trend'"));
  assert.ok(retainedTimingSectionBlock.includes("const retainedTimingSection = isIdleMemoryReport"));
  assert.ok(retainedTimingSectionBlock.includes("? ''"));
  assert.ok(html.includes('Playwright Test Run'));
});

test('suite overview and run report include the latest verification-set summary when aggregate retries were used', () => {
  const manifest = {
    title: 'All Artists Real-Data Responsiveness Benchmark',
    intro: 'Aggregate retry summaries should stay visible.',
    caseId: 'FTC-GALLERY-STARTUP-005A',
    runs: [
      {
        runId: 'run-5',
        reportPath: 'runs/run-5/report.html',
        status: 'passed',
        startedAt: '2026-06-07T05:00:00.000Z',
        durationMs: 60000,
        peakMemoryBytes: 20 * 1024 * 1024,
        checkpointCount: 1,
        environment: { projectName: 'local-real-data' },
        verificationRunGroup: { id: 'all-artists-123', label: 'all-artists', attempt: 5, maxAttempts: 5 },
        benchmarkValidation: {
          results: [
            { key: 'selectedArtistGalleryMs', description: 'Selected artist gallery', units: 'ms', actual: 2100, allowedMaximum: 3200, allowedText: '3200 ms', passed: true },
          ],
        },
        checkpoints: [],
      },
      {
        runId: 'run-4',
        reportPath: 'runs/run-4/report.html',
        status: 'passed',
        startedAt: '2026-06-07T04:59:00.000Z',
        durationMs: 61000,
        peakMemoryBytes: 20 * 1024 * 1024,
        checkpointCount: 1,
        environment: { projectName: 'local-real-data' },
        verificationRunGroup: { id: 'all-artists-123', label: 'all-artists', attempt: 4, maxAttempts: 5 },
        benchmarkValidation: {
          results: [
            { key: 'selectedArtistGalleryMs', description: 'Selected artist gallery', units: 'ms', actual: 1900, allowedMaximum: 3200, allowedText: '3200 ms', passed: true },
          ],
        },
        checkpoints: [],
      },
      {
        runId: 'run-3',
        reportPath: 'runs/run-3/report.html',
        status: 'failed',
        startedAt: '2026-06-07T04:58:00.000Z',
        durationMs: 62000,
        peakMemoryBytes: 20 * 1024 * 1024,
        checkpointCount: 1,
        environment: { projectName: 'local-real-data' },
        verificationRunGroup: { id: 'all-artists-123', label: 'all-artists', attempt: 3, maxAttempts: 5 },
        benchmarkValidation: {
          results: [
            { key: 'selectedArtistGalleryMs', description: 'Selected artist gallery', units: 'ms', actual: 5000, allowedMaximum: 3200, allowedText: '3200 ms', passed: false },
          ],
        },
        checkpoints: [],
      },
      {
        runId: 'run-2',
        reportPath: 'runs/run-2/report.html',
        status: 'passed',
        startedAt: '2026-06-07T04:57:00.000Z',
        durationMs: 63000,
        peakMemoryBytes: 20 * 1024 * 1024,
        checkpointCount: 1,
        environment: { projectName: 'local-real-data' },
        verificationRunGroup: { id: 'all-artists-123', label: 'all-artists', attempt: 2, maxAttempts: 5 },
        benchmarkValidation: {
          results: [
            { key: 'selectedArtistGalleryMs', description: 'Selected artist gallery', units: 'ms', actual: 2000, allowedMaximum: 3200, allowedText: '3200 ms', passed: true },
          ],
        },
        checkpoints: [],
      },
      {
        runId: 'run-1',
        reportPath: 'runs/run-1/report.html',
        status: 'passed',
        startedAt: '2026-06-07T04:56:00.000Z',
        durationMs: 64000,
        peakMemoryBytes: 20 * 1024 * 1024,
        checkpointCount: 1,
        environment: { projectName: 'local-real-data' },
        verificationRunGroup: { id: 'all-artists-123', label: 'all-artists', attempt: 1, maxAttempts: 5 },
        benchmarkValidation: {
          results: [
            { key: 'selectedArtistGalleryMs', description: 'Selected artist gallery', units: 'ms', actual: 1800, allowedMaximum: 3200, allowedText: '3200 ms', passed: true },
          ],
        },
        checkpoints: [],
      },
    ],
  };

  const suiteHtml = _private.renderSuiteOverview(manifest, manifest.runs[0]);
  assert.ok(suiteHtml.includes('Latest Verification Set'));
  assert.ok(suiteHtml.includes('Latest Verification Verdict'));
  assert.ok(suiteHtml.includes('median stays within bounds'));

  const runHtml = _private.renderRunReport({
    runId: 'run-5',
    reportId: 'allArtistsLocal',
    reportTitle: 'All Artists Real-Data Responsiveness Benchmark',
    intro: 'Aggregate retry summaries should stay visible.',
    status: 'passed',
    title: 'All Artists round-trip reports real-data responsiveness and memory timings',
    caseId: 'FTC-GALLERY-STARTUP-005A',
    startedAt: '2026-06-07T05:00:00.000Z',
    finishedAt: '2026-06-07T05:01:00.000Z',
    durationMs: 60000,
    environment: {
      projectName: 'local-real-data',
      baseURL: 'http://127.0.0.1:5001',
      browserName: 'chromium',
      channel: 'chrome',
      headless: false,
    },
    verificationRunGroup: { id: 'all-artists-123', label: 'all-artists', attempt: 5, maxAttempts: 5 },
    summaryCards: [],
    rawMetrics: {
      benchmarkValidation: {
        results: [
          { key: 'selectedArtistGalleryMs', checkpointKey: 'selected-artist-gallery-ready', description: 'Selected artist gallery', units: 'ms', actual: 2100, allowedMaximum: 3200, allowedText: '3200 ms', passed: true },
        ],
      },
    },
    stepEvents: [],
    stepTranscript: [],
    checkpoints: [],
    timingCheckpoints: [],
    memoryCheckpoints: [],
    timingSeries: [],
    memorySeries: [],
    peakMemoryBytes: 20 * 1024 * 1024,
    retainedArtifacts: [],
  }, manifest, '..');
  assert.ok(runHtml.includes('Latest Verification Set'));
  assert.ok(runHtml.includes('Pass Count'));
  assert.ok(runHtml.includes('Selected artist gallery'));
});

test('allArtistsLocal run report declares runOwnedTitle before current-run chart markup uses it', () => {
  const html = _private.renderRunReport({
    runId: '2026-06-05T11-55-51-983Z',
    reportId: 'allArtistsLocal',
    reportTitle: 'All Artists Real-Data Responsiveness Benchmark',
    intro: 'Run reports should render their charts instead of stopping at the shell.',
    status: 'passed',
    title: 'All Artists round-trip reports real-data responsiveness and memory timings',
    caseId: 'FTC-GALLERY-STARTUP-005A',
    startedAt: '2026-06-05T11:55:51.983Z',
    finishedAt: '2026-06-05T11:56:09.980Z',
    durationMs: 17997,
    environment: {
      projectName: 'local-real-data',
      baseURL: 'http://127.0.0.1:5001',
      browserName: 'chromium',
      channel: 'chrome',
      headless: false,
    },
    summaryCards: [],
    rawMetrics: {},
    stepEvents: [
      { level: 1, label: 'Load the real All Artists view and capture startup responsiveness checkpoints', durationMs: 1800 },
    ],
    stepTranscript: [
      '[TEST] All Artists round-trip reports real-data responsiveness and memory timings',
    ],
    checkpoints: [],
    timingCheckpoints: [],
    memoryCheckpoints: [],
    timingSeries: [
      { key: 'startup-visible-covers', label: 'Startup Covers Ready', value: 44 },
    ],
    memorySeries: [
      { key: 'final-memory', label: 'Final idle memory', value: 19457836 },
    ],
    peakMemoryBytes: 19457836,
    retainedArtifacts: [],
  }, {
    runs: [],
  }, '..');

  assert.ok(html.includes("note: 'Primary step/checkpoint timings for ' + runOwnedTitle"));
  assert.ok(html.indexOf('const runOwnedTitle =') < html.indexOf("note: 'Primary step/checkpoint timings for ' + runOwnedTitle"));
});
