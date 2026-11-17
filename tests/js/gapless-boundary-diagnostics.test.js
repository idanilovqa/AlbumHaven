const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const helperUrl = pathToFileURL(path.join(__dirname, '../e2e/helpers/gaplessPlaybackHelpers.js')).href;

test('gapless timeout preserves original failure and reports final role ownership without media paths', async () => {
  const { waitForGaplessBoundary } = await import(helperUrl);
  const failure = new Error('Original boundary timeout');
  const originalStack = failure.stack;
  const page = {
    waitForFunction: async (predicate, expected, options) => {
      assert.equal(expected, 9);
      assert.equal(options.timeout, 60000);
      throw failure;
    },
    evaluate: async () => ({ generation: 3, currentTime: 3.569, paused: false,
      currentStreamId: 8, continuityStreamId: 9, pendingPromotionStreamId: 9,
      boundaryCapture: null, bufferedFrames: { current: 0, continuity: 0 },
      inFlightFrames: { current: 0, continuity: 0 }, activeRoles: ['current', 'continuity'],
      underruns: 0, lastError: null, src: 'private media path' }),
  };
  await assert.rejects(waitForGaplessBoundary(page, { expectedPromotedStreamId: 9 }), error => {
    assert.equal(error, failure);
    assert.match(error.message, /Original boundary timeout/);
    assert.ok(error.stack.startsWith(originalStack));
    assert.match(error.stack, /Final gapless boundary state:/);
    assert.match(error.message, /"currentStreamId":8/);
    assert.match(error.message, /"continuityStreamId":9/);
    assert.match(error.message, /"pendingPromotionStreamId":9/);
    assert.match(error.message, /"boundaryCapturePresent":false/);
    assert.doesNotMatch(error.message, /private media path/);
    return true;
  });
});

test('unavailable gapless diagnostics never replace the original timeout', async () => {
  const { waitForGaplessBoundary } = await import(helperUrl);
  const failure = new Error('Original timeout');
  await assert.rejects(waitForGaplessBoundary({
    waitForFunction: async () => { throw failure; },
    evaluate: async () => { throw new Error('Page closed'); },
  }), error => error === failure && /state unavailable: Page closed/.test(error.message));
});

test('successful boundary keeps its configured timeout and one existing diagnostics read', async () => {
  const { waitForGaplessBoundary } = await import(helperUrl);
  const diagnostics = { currentStreamId: 9, boundaryCapture: {} };
  let reads = 0;
  const result = await waitForGaplessBoundary({
    waitForFunction: async (predicate, expected, options) => {
      assert.equal(expected, 9); assert.equal(options.timeout, 1234);
    },
    evaluate: async () => { reads += 1; return diagnostics; },
  }, { expectedPromotedStreamId: 9, timeout: 1234 });
  assert.equal(result, diagnostics);
  assert.equal(reads, 1);
});

test('playback diagnostics expose failure-safe start ownership and engine lifecycle state', async () => {
  const { readGaplessPlaybackDiagnostics } = await import(helperUrl);
  const page = {
    evaluate: async (readDiagnostics) => {
      globalThis.getStreamingPlaybackSnapshot = () => ({
        mode: 'starting',
        sampleRate: 48000,
        diagnostics: {},
      });
      globalThis.state = {
        player: {
          ownership: {
            activeClaim: { token: 'must-not-leak' },
            blockedReason: '',
            lockStatus: 'owned',
            requestVersion: 6,
          },
          streaming: {
            context: { state: 'running' },
            lifecycleEpoch: 4,
            pendingPromotion: { streamId: 11 },
            pendingSeek: { kind: 'replacement' },
            pendingTransportRecovery: { attempt: 1 },
            roles: {
              current: {
                firstFrameNotified: false,
                generation: 9,
                streamId: 10,
                track: { path: 'must-not-leak' },
              },
              continuity: null,
            },
            socket: { readyState: 0 },
            startRequestId: 12,
            stopPromise: Promise.resolve(),
          },
        },
      };
      try {
        return readDiagnostics();
      } finally {
        delete globalThis.getStreamingPlaybackSnapshot;
        delete globalThis.state;
      }
    },
  };

  const diagnostics = await readGaplessPlaybackDiagnostics(page);

  assert.deepEqual(diagnostics.engineLifecycle, {
    audioContextState: 'running',
    lifecycleEpoch: 4,
    pendingPromotion: true,
    pendingSeek: true,
    pendingStop: true,
    pendingTransportRecovery: true,
    playerCurrentPresent: false,
    socketReadyState: 0,
    startRequestId: 12,
  });
  assert.deepEqual(diagnostics.ownership, {
    activeClaim: true,
    blockedReason: '',
    lockStatus: 'owned',
    requestVersion: 6,
  });
  assert.deepEqual(diagnostics.roleDiagnostics.current, {
    eosReceived: false,
    firstFrameNotified: false,
    generation: 9,
    initialCreditDeferred: false,
    metadataAccepted: false,
    provisionalTotalFrames: 0,
    streamId: 10,
    targetBufferFrames: 0,
    timelineStartFrame: 0,
  });
  assert.doesNotMatch(JSON.stringify(diagnostics), /must-not-leak/);
});

test('streaming diagnostics observer preserves initial-start lifecycle transitions', async () => {
  const { createStreamingReplacementDiagnosticsObserver } = await import(helperUrl);
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let sampleInterval;

  globalThis.getStreamingPlaybackSnapshot = () => ({
    mode: 'starting',
    diagnostics: {},
  });
  globalThis.state = {
    player: {
      ownership: {
        activeClaim: { token: 'must-not-leak' },
        lockStatus: 'owned',
        requestVersion: 2,
      },
      streaming: {
        context: { state: 'running' },
        lifecycleEpoch: 3,
        roles: { current: null, continuity: null },
        socket: { readyState: 0 },
        startRequestId: 4,
      },
    },
  };
  globalThis.setInterval = callback => {
    sampleInterval = callback;
    return 17;
  };
  globalThis.clearInterval = intervalId => assert.equal(intervalId, 17);

  const page = {
    evaluateHandle: async createObserver => {
      const observer = createObserver();
      return {
        evaluate: async finishObserver => finishObserver(observer),
        dispose: async () => {},
      };
    },
  };

  try {
    const observer = await createStreamingReplacementDiagnosticsObserver(page);
    globalThis.state.player.streaming.startRequestId = 5;
    globalThis.state.player.streaming.stopPromise = Promise.resolve();
    sampleInterval();
    const samples = await observer.finish();

    assert.deepEqual(samples.at(-1).engineLifecycle, {
      audioContextState: 'running',
      lifecycleEpoch: 3,
      pendingStop: true,
      pendingTransportRecovery: false,
      playerCurrentPresent: false,
      socketReadyState: 0,
      startRequestId: 5,
    });
    assert.deepEqual(samples.at(-1).ownership, {
      activeClaim: true,
      blockedReason: '',
      lockStatus: 'owned',
      requestVersion: 2,
    });
    assert.doesNotMatch(JSON.stringify(samples), /must-not-leak/);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    delete globalThis.getStreamingPlaybackSnapshot;
    delete globalThis.state;
  }
});
