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
