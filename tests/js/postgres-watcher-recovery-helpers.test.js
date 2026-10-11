const assert = require('node:assert/strict');
const test = require('node:test');

test('materializes encoded watcher root IDs into one safe psql command', async () => {
  const { readWatcherRecoverySnapshot } = await import(
    '../e2e/helpers/postgresWatcherRecoveryHelpers.js'
  );
  const failureRootId = "failed-root'; select pg_sleep(10); --";
  const healthyRootId = 'healthy-root/private-path';
  const snapshot = {
    libraryId: 41,
    inventoryRevision: 7,
    roots: {
      [failureRootId]: { acceptedSequence: 3 },
      [healthyRootId]: { acceptedSequence: 5 },
    },
    incidents: [],
    repairs: [],
  };
  const calls = [];
  const env = {
    ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL:
      'postgresql://album_haven_migrator:test-only@127.0.0.1/album_haven_fake_e2e',
    PRESERVED_DIAGNOSTIC_ENV: 'preserved',
  };

  const result = await readWatcherRecoverySnapshot(
    { failureRootId, healthyRootId },
    {
      env,
      platform: 'linux',
      execFileAsync: async (command, args, options) => {
        calls.push({ command, args, options });
        return { stdout: JSON.stringify(snapshot) };
      },
    },
  );

  assert.deepEqual(result, snapshot);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.command, 'psql');
  assert.equal(call.options.encoding, 'utf8');
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.timeout, 15000);
  assert.equal(call.options.env.PRESERVED_DIAGNOSTIC_ENV, 'preserved');
  assert.equal(call.options.env.PGCLIENTENCODING, 'UTF8');
  assert.equal(call.options.env.PGPASSWORD, 'test-only');
  assert.equal(call.options.env.PGDATABASE, undefined);
  assert.ok(call.options.env.PGOPTIONS.includes('statement_timeout=10000'));
  assert.ok(call.options.env.PGOPTIONS.includes('lock_timeout=2000'));

  assert.equal(call.args.some((argument) => argument.startsWith('--variable=')), false);
  const commandArguments = call.args.filter((argument) => argument.startsWith('--command='));
  assert.equal(commandArguments.length, 1);
  const sqlCommand = commandArguments[0].slice('--command='.length);
  const encodedFailureRootId = Buffer.from(failureRootId, 'utf8').toString('base64');
  const encodedHealthyRootId = Buffer.from(healthyRootId, 'utf8').toString('base64');
  assert.match(
    sqlCommand,
    new RegExp(`pg_catalog\\.decode\\('${encodedFailureRootId}', 'base64'\\)`),
  );
  assert.match(
    sqlCommand,
    new RegExp(`pg_catalog\\.decode\\('${encodedHealthyRootId}', 'base64'\\)`),
  );
  assert.doesNotMatch(sqlCommand, /:'(?:failure|healthy)_root_id_b64'/u);
  assert.match(
    sqlCommand,
    /pg_catalog\.replace\(\s*file\.private_path,\s*pg_catalog\.chr\(92\),\s*'\/'\s*\)/u,
  );
  assert.doesNotMatch(
    sqlCommand,
    /pg_catalog\.replace\(\s*file\.private_path,\s*pg_catalog\.chr\(92\)\s*\)/u,
  );
  assert.equal(call.options.input, undefined);
  assert.equal(call.args.includes(failureRootId), false);
  assert.equal(call.args.includes(healthyRootId), false);
  assert.equal(sqlCommand.includes(failureRootId), false);
  assert.equal(sqlCommand.includes(healthyRootId), false);
});

const WATCHER_TIMEOUT_DIAGNOSTIC = {
  incidentMatched: true,
  inventoryRevision: { baseline: 7, current: 8 },
  healthyAcceptedSequence: { baseline: 3, current: 4 },
  healthyAppliedSequence: { baseline: 3, current: 4 },
};
const WATCHER_TIMEOUT_DIAGNOSTIC_PREFIX = 'WATCHER_RECOVERY_DIAGNOSTIC=';

function watcherRecoverySnapshots(failureRootId, healthyRootId) {
  const baseline = {
    inventoryRevision: 7,
    roots: {
      [failureRootId]: { acceptedSequence: 2, appliedSequence: 2 },
      [healthyRootId]: { acceptedSequence: 3, appliedSequence: 3 },
    },
    incidents: [],
  };
  const current = {
    inventoryRevision: 8,
    roots: {
      [failureRootId]: { acceptedSequence: 2, appliedSequence: 2 },
      [healthyRootId]: {
        acceptedSequence: 4,
        appliedSequence: 4,
        inventoryEntries: [{
          fileName: 'private-recording.flac',
          privatePath: 'C:\\private-library\\private-recording.flac',
        }],
      },
    },
    incidents: [{
      rootId: failureRootId,
      reasonCode: 'root_unavailable',
      resolved: false,
      incidentId: 'incident-secret',
      warningToken: 'warning-secret',
      message: 'arbitrary private failure detail',
    }],
    commandLine: 'python --database-url postgresql://owner:secret@localhost/private',
    env: { DATABASE_URL: 'postgresql://owner:secret@localhost/private' },
  };
  return { baseline, current };
}

function assertClosedPathFreeTimeoutDiagnostic(
  error,
  excludedValues,
  expected = WATCHER_TIMEOUT_DIAGNOSTIC,
) {
  assert.deepEqual(error.watcherRecoveryDiagnostic, expected);
  assert.deepEqual(
    Object.keys(error.watcherRecoveryDiagnostic),
    [
      'incidentMatched',
      'inventoryRevision',
      'healthyAcceptedSequence',
      'healthyAppliedSequence',
    ],
  );
  for (const key of [
    'inventoryRevision',
    'healthyAcceptedSequence',
    'healthyAppliedSequence',
  ]) {
    assert.deepEqual(Object.keys(error.watcherRecoveryDiagnostic[key]), ['baseline', 'current']);
  }
  const serialized = JSON.stringify(expected);
  const message = String(error.message || '');
  const diagnosticStart = message.indexOf(WATCHER_TIMEOUT_DIAGNOSTIC_PREFIX);
  assert.notEqual(diagnosticStart, -1);
  assert.equal(
    message.indexOf(
      WATCHER_TIMEOUT_DIAGNOSTIC_PREFIX,
      diagnosticStart + WATCHER_TIMEOUT_DIAGNOSTIC_PREFIX.length,
    ),
    -1,
  );
  const diagnosticLine = message
    .slice(diagnosticStart + WATCHER_TIMEOUT_DIAGNOSTIC_PREFIX.length)
    .split(/\r?\n/u, 1)[0];
  assert.equal(diagnosticLine, serialized);
  assert.deepEqual(JSON.parse(diagnosticLine), expected);

  const stack = String(new Error(message).stack || '');
  assert.equal(stack.includes(`${WATCHER_TIMEOUT_DIAGNOSTIC_PREFIX}${serialized}`), true);
  for (const value of excludedValues) {
    assert.equal(JSON.stringify(error.watcherRecoveryDiagnostic).includes(value), false);
    assert.equal(message.includes(value), false);
    assert.equal(stack.includes(value), false);
  }
  return true;
}

test('watcher recovery polling retains only its closed path-free timeout diagnostic', async () => {
  const { waitForWatcherRecoverySnapshot } = await import(
    '../e2e/helpers/postgresWatcherRecoveryHelpers.js'
  );
  const failureRootId = 'failure-C:\\private-library';
  const healthyRootId = 'healthy-C:\\other-private-library';
  const { current } = watcherRecoverySnapshots(failureRootId, healthyRootId);

  await assert.rejects(
    waitForWatcherRecoverySnapshot(() => false, {
      roots: { failureRootId, healthyRootId },
      timeout: 5,
      intervals: [1],
      readSnapshot: async () => current,
      timeoutDiagnostic: () => ({
        ...WATCHER_TIMEOUT_DIAGNOSTIC,
        rootId: failureRootId,
        inventoryEntries: current.roots[healthyRootId].inventoryEntries,
        incident: current.incidents[0],
        commandLine: current.commandLine,
        env: current.env,
        databaseUrl: current.env.DATABASE_URL,
        message: 'arbitrary private failure detail',
      }),
    }),
    (error) => assertClosedPathFreeTimeoutDiagnostic(error, [
      failureRootId,
      healthyRootId,
      'C:\\private-library',
      'private-recording.flac',
      'incident-secret',
      'warning-secret',
      'python --database-url',
      'postgresql://owner:secret@localhost/private',
      'arbitrary private failure detail',
    ]),
  );
});

test('watcher recovery action throws the final four-conjunct timeout projection', async () => {
  const [
    { LibraryFilesystemWatcherActions },
    { waitForWatcherRecoverySnapshot },
  ] = await Promise.all([
    import('../e2e/actions/libraryFilesystemWatcherActions.js'),
    import('../e2e/helpers/postgresWatcherRecoveryHelpers.js'),
  ]);
  const failureRootId = 'failure-C:\\private-library';
  const healthyRootId = 'healthy-C:\\other-private-library';
  const { baseline, current } = watcherRecoverySnapshots(failureRootId, healthyRootId);
  const recovery = {
    manifest: { failureRootId, healthyRootId },
    makeFailureRootUnavailable: async () => {},
    removeOneUnavailableFile: () => {},
    createHealthyFile: () => {},
  };
  const actions = new LibraryFilesystemWatcherActions(
    { page: {} },
    { scanPage: {}, getWatcherRecovery: async () => recovery },
  );
  actions._openProductionGallery = async () => {};
  actions._readRecoverySnapshot = async () => baseline;
  actions._waitForRecoverySnapshot = async (predicate, options) => {
    assert.equal(await predicate(current), true);
    assert.equal(await predicate({ ...current, incidents: [] }), false);
    assert.equal(await predicate({ ...current, inventoryRevision: 7 }), false);
    assert.equal(await predicate({
      ...current,
      roots: {
        ...current.roots,
        [healthyRootId]: { ...current.roots[healthyRootId], acceptedSequence: 3 },
      },
    }), false);
    assert.equal(await predicate({
      ...current,
      roots: {
        ...current.roots,
        [healthyRootId]: { ...current.roots[healthyRootId], appliedSequence: 3 },
      },
    }), false);
    return waitForWatcherRecoverySnapshot(predicate, {
      ...options,
      roots: { failureRootId, healthyRootId },
      timeout: 5,
      intervals: [1],
      readSnapshot: async () => ({ ...current, inventoryRevision: 7 }),
    });
  };

  await assert.rejects(
    actions.failOwnedRootAndAdvanceHealthyRoot(),
    (error) => assertClosedPathFreeTimeoutDiagnostic(error, [
      failureRootId,
      healthyRootId,
      'C:\\private-library',
      'private-recording.flac',
      'incident-secret',
      'warning-secret',
      'python --database-url',
      'postgresql://owner:secret@localhost/private',
      'arbitrary private failure detail',
    ], {
      ...WATCHER_TIMEOUT_DIAGNOSTIC,
      inventoryRevision: { baseline: 7, current: 7 },
    }),
  );
});

test('final repair watermark timeout emits one closed path-free recovery diagnostic', async () => {
  const [
    { LibraryFilesystemWatcherActions },
    { waitForWatcherRecoverySnapshot },
  ] = await Promise.all([
    import('../e2e/actions/libraryFilesystemWatcherActions.js'),
    import('../e2e/helpers/postgresWatcherRecoveryHelpers.js'),
  ]);
  const failureRootId = 'failure-C:\\private-library';
  const healthyRootId = 'healthy-C:\\other-private-library';
  const incidentId = 'incident-secret';
  const inventoryFileName = 'private-recording.flac';
  const privateFailureReason = 'failed C:\\private-library with token-secret';
  const recovery = {
    manifest: { failureRootId, healthyRootId },
  };
  const actions = new LibraryFilesystemWatcherActions(
    { page: {} },
    { scanPage: {}, getWatcherRecovery: async () => recovery },
  );
  actions.firstIncident = { incidentId };
  actions._openProductionGallery = async () => {};

  const snapshot = {
    aggregates: {
      scanInProgress: true,
      watcherState: 'degraded',
      repairRequired: true,
      failedJobCount: 2,
      readyGenerationCount: 1,
      dirtyLaneCount: 2,
    },
    roots: {
      [failureRootId]: {
        acceptedSequence: 12,
        appliedSequence: 10,
        dirtyGeneration: 8,
        repairedDirtyGeneration: 6,
        inventoryEntries: [],
      },
      [healthyRootId]: {
        acceptedSequence: 21,
        appliedSequence: 20,
        dirtyGeneration: 4,
        repairedDirtyGeneration: 4,
        inventoryEntries: [{
          fileName: 'different-private-recording.flac',
          privatePath: 'C:\\other-private-library\\different-private-recording.flac',
        }],
      },
    },
    incidents: [{
      incidentId,
      rootId: failureRootId,
      resolved: false,
      warningToken: 'warning-secret',
      message: 'arbitrary private incident detail',
    }],
    repairs: [{
      state: 'running',
      completed: false,
      terminalFailureReason: privateFailureReason,
      roots: [
        {
          rootId: failureRootId,
          incidentId,
          capturedAcceptedSequence: 11,
          capturedDirtyGeneration: 7,
        },
        {
          rootId: healthyRootId,
          incidentId: null,
          capturedAcceptedSequence: 19,
          capturedDirtyGeneration: 4,
        },
      ],
    }],
    commandLine: 'python --database-url postgresql://owner:secret@localhost/private',
    env: { DATABASE_URL: 'postgresql://owner:secret@localhost/private' },
  };
  const duringRepairFence = {
    healthyRootId,
    acceptedSequence: 21,
    inventoryEntry: { fileName: inventoryFileName },
  };
  const expected = {
    repairMatched: true,
    repairState: 'running',
    repairCompleted: false,
    terminalFailureReason: 'unknown',
    incidentResolved: false,
    duringRepairAppliedThroughFence: false,
    inventoryEntryMatched: false,
    aggregates: {
      scanInProgress: true,
      watcherState: 'degraded',
      repairRequired: true,
      failedJobCount: 2,
      readyGenerationCount: 1,
      dirtyLaneCount: 2,
    },
    watermarks: {
      failure: {
        acceptedSequence: 12,
        appliedSequence: 10,
        capturedAcceptedSequence: 11,
        dirtyGeneration: 8,
        capturedDirtyGeneration: 7,
        repairedDirtyGeneration: 6,
        caughtUp: false,
      },
      healthy: {
        acceptedSequence: 21,
        appliedSequence: 20,
        capturedAcceptedSequence: 19,
        dirtyGeneration: 4,
        capturedDirtyGeneration: 4,
        repairedDirtyGeneration: 4,
        caughtUp: false,
      },
    },
  };

  actions._waitForRecoverySnapshot = (predicate, options) => (
    waitForWatcherRecoverySnapshot(predicate, {
      ...options,
      roots: { failureRootId, healthyRootId },
      timeout: 5,
      intervals: [1],
      readSnapshot: async () => snapshot,
    })
  );

  await assert.rejects(
    actions.waitForRepairWatermark(duringRepairFence),
    (error) => {
      assert.deepEqual(error.watcherRecoveryDiagnostic, expected);
      assert.deepEqual(Object.keys(error.watcherRecoveryDiagnostic), [
        'repairMatched',
        'repairState',
        'repairCompleted',
        'terminalFailureReason',
        'incidentResolved',
        'duringRepairAppliedThroughFence',
        'inventoryEntryMatched',
        'aggregates',
        'watermarks',
      ]);
      assert.deepEqual(Object.keys(error.watcherRecoveryDiagnostic.aggregates), [
        'scanInProgress',
        'watcherState',
        'repairRequired',
        'failedJobCount',
        'readyGenerationCount',
        'dirtyLaneCount',
      ]);
      for (const role of ['failure', 'healthy']) {
        assert.deepEqual(Object.keys(error.watcherRecoveryDiagnostic.watermarks[role]), [
          'acceptedSequence',
          'appliedSequence',
          'capturedAcceptedSequence',
          'dirtyGeneration',
          'capturedDirtyGeneration',
          'repairedDirtyGeneration',
          'caughtUp',
        ]);
      }

      const serialized = JSON.stringify(expected);
      const message = String(error.message || '');
      const firstDiagnostic = message.indexOf(WATCHER_TIMEOUT_DIAGNOSTIC_PREFIX);
      assert.notEqual(firstDiagnostic, -1);
      assert.equal(
        message.indexOf(
          WATCHER_TIMEOUT_DIAGNOSTIC_PREFIX,
          firstDiagnostic + WATCHER_TIMEOUT_DIAGNOSTIC_PREFIX.length,
        ),
        -1,
      );
      assert.equal(
        message
          .slice(firstDiagnostic + WATCHER_TIMEOUT_DIAGNOSTIC_PREFIX.length)
          .split(/\r?\n/u, 1)[0],
        serialized,
      );
      assert.deepEqual(JSON.parse(
        message
          .slice(firstDiagnostic + WATCHER_TIMEOUT_DIAGNOSTIC_PREFIX.length)
          .split(/\r?\n/u, 1)[0],
      ), expected);

      const stack = String(new Error(message).stack || '');
      for (const value of [
        failureRootId,
        healthyRootId,
        incidentId,
        inventoryFileName,
        privateFailureReason,
        'different-private-recording.flac',
        'C:\\other-private-library',
        'warning-secret',
        'arbitrary private incident detail',
        'python --database-url',
        'postgresql://owner:secret@localhost/private',
        'token-secret',
      ]) {
        assert.equal(JSON.stringify(error.watcherRecoveryDiagnostic).includes(value), false);
        assert.equal(message.includes(value), false);
        assert.equal(stack.includes(value), false);
      }
      return true;
    },
  );
});

test('watcher snapshot links repair to its full-scan job outcome without selecting private detail', async () => {
  const { readWatcherRecoverySnapshot } = await import(
    '../e2e/helpers/postgresWatcherRecoveryHelpers.js'
  );
  const failureRootId = 'failure-root';
  const healthyRootId = 'healthy-root';
  const snapshot = {
    libraryId: 41,
    inventoryRevision: 7,
    roots: {
      [failureRootId]: { acceptedSequence: 3 },
      [healthyRootId]: { acceptedSequence: 5 },
    },
    incidents: [],
    repairs: [],
  };
  let sqlCommand = '';

  await readWatcherRecoverySnapshot(
    { failureRootId, healthyRootId },
    {
      env: {
        ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL:
          'postgresql://album_haven_migrator:test-only@127.0.0.1/album_haven_fake_e2e',
      },
      platform: 'linux',
      execFileAsync: async (_command, args) => {
        sqlCommand = args.find((argument) => argument.startsWith('--command='))
          .slice('--command='.length);
        return { stdout: JSON.stringify(snapshot) };
      },
    },
  );

  assert.match(
    sqlCommand,
    /left join library\.full_scan_intents as intent\s+on intent\.watcher_repair_id = repair\.id/u,
  );
  assert.match(
    sqlCommand,
    /left join ops\.jobs as job\s+on job\.id = intent\.job_id/u,
  );
  assert.match(sqlCommand, /'terminalFailureReason', job\.outcome_code/u);
  assert.deepEqual(
    [...new Set([...sqlCommand.matchAll(/\bjob\.([a-z_]+)/gu)].map((match) => match[1]))]
      .sort(),
    ['id', 'outcome_code'],
  );
  assert.deepEqual(
    [...new Set([...sqlCommand.matchAll(/\bintent\.([a-z_]+)/gu)].map((match) => match[1]))]
      .sort(),
    ['job_id', 'watcher_repair_id'],
  );
  assert.doesNotMatch(
    sqlCommand,
    /current_path|parameters|last_error|command_line|environment/iu,
  );
});

test('watcher timeout diagnostic preserves only allowlisted full-scan outcomes', async () => {
  const { waitForWatcherRecoverySnapshot } = await import(
    '../e2e/helpers/postgresWatcherRecoveryHelpers.js'
  );
  const diagnosticFor = (terminalFailureReason) => ({
    repairMatched: true,
    repairState: 'running',
    repairCompleted: false,
    terminalFailureReason,
    incidentResolved: false,
    duringRepairAppliedThroughFence: false,
    inventoryEntryMatched: false,
    aggregates: {
      scanInProgress: false,
      watcherState: 'repair_required',
      repairRequired: true,
      failedJobCount: 1,
      readyGenerationCount: 0,
      dirtyLaneCount: 1,
    },
    watermarks: {
      failure: {},
      healthy: {},
    },
    privatePath: 'C:\\private-library\\recording.flac',
    secret: 'postgresql://owner:secret@localhost/private',
  });

  for (const [sourceReason, expectedReason] of [
    ['full_scan_publication_integrity_failed', 'full_scan_publication_integrity_failed'],
    ['C:\\private-library\\recording.flac token=secret', 'unknown'],
  ]) {
    await assert.rejects(
      waitForWatcherRecoverySnapshot(() => false, {
        roots: { failureRootId: 'failure-root', healthyRootId: 'healthy-root' },
        timeout: 5,
        intervals: [1],
        readSnapshot: async () => ({}),
        timeoutDiagnostic: () => diagnosticFor(sourceReason),
      }),
      (error) => {
        assert.equal(
          error.watcherRecoveryDiagnostic.terminalFailureReason,
          expectedReason,
        );
        assert.deepEqual(Object.keys(error.watcherRecoveryDiagnostic), [
          'repairMatched',
          'repairState',
          'repairCompleted',
          'terminalFailureReason',
          'incidentResolved',
          'duringRepairAppliedThroughFence',
          'inventoryEntryMatched',
          'aggregates',
          'watermarks',
        ]);
        const retained = JSON.stringify(error.watcherRecoveryDiagnostic);
        assert.doesNotMatch(retained, /private-library|recording\.flac|owner:secret/u);
        assert.doesNotMatch(String(error.message), /private-library|recording\.flac|owner:secret/u);
        return true;
      },
    );
  }
});

for (const [sourceReason, expectedReason] of [
  ['full_scan_revision_conflict', 'full_scan_revision_conflict'],
  ['private failure C:\\leak-sentinel token=secret-sentinel', 'unknown'],
]) {
  test(`final repair watermark timeout sanitizes ${expectedReason} from the raw snapshot`, async () => {
    const [
      { LibraryFilesystemWatcherActions },
      { waitForWatcherRecoverySnapshot },
    ] = await Promise.all([
      import('../e2e/actions/libraryFilesystemWatcherActions.js'),
      import('../e2e/helpers/postgresWatcherRecoveryHelpers.js'),
    ]);
    const failureRootId = 'failure-root-leak-sentinel';
    const healthyRootId = 'healthy-root-leak-sentinel';
    const incidentId = 'incident-leak-sentinel';
    const inventoryFileName = 'inventory-leak-sentinel.flac';
    const recovery = { manifest: { failureRootId, healthyRootId } };
    const actions = new LibraryFilesystemWatcherActions(
      { page: {} },
      { scanPage: {}, getWatcherRecovery: async () => recovery },
    );
    actions.firstIncident = { incidentId };
    actions._openProductionGallery = async () => {};

    const snapshot = {
      aggregates: {},
      roots: {
        [failureRootId]: {},
        [healthyRootId]: { inventoryEntries: [] },
      },
      incidents: [{ incidentId, resolved: false }],
      repairs: [{
        state: 'failed',
        completed: false,
        terminalFailureReason: sourceReason,
        roots: [
          { rootId: failureRootId, incidentId },
          { rootId: healthyRootId, incidentId: null },
        ],
      }],
    };
    const duringRepairFence = {
      healthyRootId,
      acceptedSequence: 1,
      inventoryEntry: { fileName: inventoryFileName },
    };

    actions._waitForRecoverySnapshot = (predicate, options) => (
      waitForWatcherRecoverySnapshot(predicate, {
        ...options,
        roots: { failureRootId, healthyRootId },
        timeout: 5,
        intervals: [1],
        readSnapshot: async () => snapshot,
      })
    );

    await assert.rejects(
      actions.waitForRepairWatermark(duringRepairFence),
      (error) => {
        assert.equal(error.watcherRecoveryDiagnostic.terminalFailureReason, expectedReason);
        const retained = JSON.stringify(error.watcherRecoveryDiagnostic);
        const message = String(error.message);
        for (const sentinel of [
          failureRootId,
          healthyRootId,
          incidentId,
          inventoryFileName,
          'C:\\leak-sentinel',
          'secret-sentinel',
        ]) {
          assert.equal(retained.includes(sentinel), false);
          assert.equal(message.includes(sentinel), false);
        }
        return true;
      },
    );
  });
}
