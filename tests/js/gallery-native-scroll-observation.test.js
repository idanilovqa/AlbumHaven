const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('desktop album-card hover and focus preserve exact card geometry', () => {
  const css = fs.readFileSync(path.resolve(
    __dirname,
    '../../music_app/static/css/runtime/non-album-and-player.css',
  ), 'utf8');
  const cardRule = css.match(/\.album-card\s*\{([^}]*)\}/)?.[1] || '';
  const interactionRule = css.match(
    /\.album-card:hover,\s*\.album-card:focus-within\s*\{([^}]*)\}/,
  )?.[1] || '';

  assert.ok(cardRule, 'album-card rule must exist');
  assert.ok(interactionRule, 'album-card hover/focus rule must exist');
  assert.doesNotMatch(cardRule, /transition:[^;]*\btransform\b/);
  assert.doesNotMatch(interactionRule, /\btransform\s*:/);
});

test('artist jump placement requires exact row alignment and an uncut first card', () => {
  const source = fs.readFileSync(path.resolve(
    __dirname,
    '../e2e/poms/galleryRegressions.js',
  ), 'utf8');

  assert.match(source, /scrollContentTop = scrollRect\.top \+ scroll\.clientTop/);
  assert.match(source, /rowsAligned:\s*rowsRect\.top === scrollContentTop/);
  assert.match(source, /firstCardUncut:\s*firstCardRect\.top >= scrollContentTop/);
  assert.doesNotMatch(source, /rowsAligned:[^\n]*<=\s*1/);
  assert.doesNotMatch(source, /firstCardUncut:[^\n]*-\s*1/);
});

test('response-overlap scenarios use event-driven completion instead of a fixed polling budget', () => {
  const source = fs.readFileSync(path.resolve(
    __dirname,
    '../e2e/syntheticLargeLibrary/galleryNativeResponseOverlap.spec.js',
  ), 'utf8');

  assert.doesNotMatch(source, /step\s*<\s*60\s*&&\s*!deferredEvent/);
  assert.doesNotMatch(source, /while\s*\(\s*!deferredEvent\s*\)/);
  assert.doesNotMatch(source, /waitForTimeout\(20\)/);
});

test('full-refresh response overlap guarantees watcher cleanup after observation reporting', () => {
  const source = fs.readFileSync(path.resolve(
    __dirname,
    '../e2e/syntheticLargeLibrary/galleryNativeResponseOverlap.spec.js',
  ), 'utf8');
  const fullRefreshScenario = source.slice(
    source.indexOf("test('full preserve-scroll response during wheel sequence"),
    source.indexOf("test('real continuation response during wheel sequence"),
  );

  assert.match(
    fullRefreshScenario,
    /finally\s*\{[\s\S]*?try\s*\{[\s\S]*?observation\.finish\(\)[\s\S]*?testInfo\.attach\([\s\S]*?\}\s*finally\s*\{[\s\S]*?watcherFixture\.cleanup\(/,
  );
});

test('response-overlap evidence uses browser-clock event boundaries and exact commanded movement', () => {
  const source = fs.readFileSync(path.resolve(
    __dirname,
    '../e2e/syntheticLargeLibrary/galleryNativeResponseOverlap.spec.js',
  ), 'utf8');
  const stableOverlap = source.slice(
    source.indexOf('function expectStableOverlap'),
    source.indexOf('async function positionWithWheelBeforeContinuation'),
  );

  assert.doesNotMatch(source, /(inputStartedAt|inputEndedAt|responseAt)\s*=\s*Date\.now\(\)/);
  assert.doesNotMatch(source, /responseAt\s*=\s*await ui\.readBrowserEpoch\(\)/);
  assert.match(source, /ui\.readBrowserEpoch\(\)/);
  assert.match(source, /Network\.responseReceived/);
  assert.match(source, /response\.responseTime/);
  assert.match(source, /TOUCH_ACTIVATION_DISTANCE/);
  assert.match(source, /STATIONARY_TOUCH_FRAMES/);
  assert.match(stableOverlap, /nativeScrollDisplacementMatchesCommand/);
  assert.match(stableOverlap, /nativeScrollStepsMatchCommand/);
});

test('held-touch response overlap settles at the commanded endpoint before release', () => {
  const source = fs.readFileSync(path.resolve(
    __dirname,
    '../e2e/syntheticLargeLibrary/galleryNativeResponseOverlap.spec.js',
  ), 'utf8');
  const mobileScenario = source.slice(
    source.indexOf("test('real continuation response during held touch"),
    source.indexOf("test.describe('desktop Cards'"),
  );
  const deferredAssertion = mobileScenario.indexOf('expect(deferredEvent.touchGestureActive).toBe(true)');
  const stationaryFrames = mobileScenario.indexOf('STATIONARY_TOUCH_FRAMES', deferredAssertion);
  const touchEnd = mobileScenario.indexOf("type: 'touchEnd'", deferredAssertion);

  assert.match(source, /const TOUCH_ACTIVATION_DISTANCE = 15;/);
  assert.match(source, /const STATIONARY_TOUCH_FRAMES = 12;/);
  assert.ok(deferredAssertion >= 0);
  assert.ok(stationaryFrames > deferredAssertion);
  assert.ok(touchEnd > stationaryFrames);
});

test('continuation overlap cleanup preserves original failures and runs every cleanup step', async () => {
  const { finalizeResponseOverlapCleanup } = await import(
    '../e2e/helpers/failureSafeCleanup.js'
  );
  const source = fs.readFileSync(path.resolve(
    __dirname,
    '../e2e/syntheticLargeLibrary/galleryNativeResponseOverlap.spec.js',
  ), 'utf8');
  const mobileScenario = source.slice(
    source.indexOf("test('real continuation response during held touch"),
    source.indexOf("test.describe('desktop Cards'"),
  );
  const desktopContinuation = source.slice(
    source.indexOf("test('real continuation response during wheel sequence"),
  );

  const originalFailure = new Error('original failure');
  const cleanupFailure = new Error('cleanup failure');
  const calls = [];
  await assert.rejects(
    finalizeResponseOverlapCleanup(originalFailure, [
      async () => {
        calls.push('first');
        throw cleanupFailure;
      },
      async () => {
        calls.push('second');
      },
    ], 'combined failure'),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, 'combined failure');
      assert.deepEqual(error.errors, [originalFailure, cleanupFailure]);
      return true;
    },
  );
  assert.deepEqual(calls, ['first', 'second']);

  await assert.rejects(
    finalizeResponseOverlapCleanup(
      originalFailure,
      [async () => { throw originalFailure; }],
      'duplicate failure',
    ),
    error => {
      assert.equal(error, originalFailure);
      return true;
    },
  );

  for (const scenario of [mobileScenario, desktopContinuation]) {
    assert.match(scenario, /catch \(error\)[\s\S]*originalFailure = error/);
    assert.match(scenario, /finalizeResponseOverlapCleanup\(/);
    assert.match(scenario, /responseBoundary\?*\.dispose\(\)/);
    assert.match(scenario, /cdp\.detach\(\)/);
  }
});

test('response-overlap setup keeps native input active through fixture and response settlement', () => {
  const source = fs.readFileSync(path.resolve(
    __dirname,
    '../e2e/syntheticLargeLibrary/galleryNativeResponseOverlap.spec.js',
  ), 'utf8');

  assert.doesNotMatch(source, /waitForTimeout\(40\)/);
  assert.match(
    source,
    /Promise\.allSettled\(\s*\[\s*responseOverlap,\s*fixtureMutation,\s*activeInput\.completion,\s*\]\s*\)/,
  );
  assert.match(source, /keepWheelActiveUntilResponseBoundary\(/);
  assert.match(
    source,
    /page\.waitForResponse\(\s*candidate => isFullSearchRefresh[\s\S]*?timeout: RESPONSE_BOUNDARY_TIMEOUT_MS/,
  );
  assert.match(
    source,
    /page\.waitForResponse\(isRootContinuation,\s*\{\s*timeout: RESPONSE_BOUNDARY_TIMEOUT_MS/,
  );
});

test('response-overlap wheel ownership is bounded and explicitly stopped during cleanup', () => {
  const source = fs.readFileSync(path.resolve(
    __dirname,
    '../e2e/syntheticLargeLibrary/galleryNativeResponseOverlap.spec.js',
  ), 'utf8');
  const ownerSource = fs.readFileSync(path.resolve(
    __dirname,
    '../e2e/poms/galleryRegressions.js',
  ), 'utf8');
  const helper = ownerSource.slice(
    ownerSource.indexOf('export function keepWheelActiveUntilResponseBoundary'),
    ownerSource.indexOf('export function analyzeNativeScrollGesture'),
  );
  const fullRefreshScenario = source.slice(
    source.indexOf("test('full preserve-scroll response during wheel sequence"),
    source.indexOf("test('real continuation response during wheel sequence"),
  );
  const continuationScenario = source.slice(
    source.indexOf("test('real continuation response during wheel sequence"),
  );

  assert.match(source, /const RESPONSE_BOUNDARY_TIMEOUT_MS = 15_000;/);
  assert.match(source, /timeoutMs: RESPONSE_BOUNDARY_TIMEOUT_MS/);
  assert.match(helper, /setTimeout\([\s\S]*timeoutMs/);
  assert.match(helper, /return \{[\s\S]*completion[\s\S]*stop\(\)/);
  for (const scenario of [fullRefreshScenario, continuationScenario]) {
    assert.match(scenario, /finally\s*\{[\s\S]*activeInput\?*\.stop\(\)[\s\S]*await activeInput\?*\.completion/);
  }
});

test('response-overlap wheel ownership times out while a browser input step is stalled', async () => {
  const { keepWheelActiveUntilResponseBoundary } = await import(
    '../e2e/poms/galleryRegressions.js'
  );
  const never = new Promise(() => {});
  const activeInput = keepWheelActiveUntilResponseBoundary(
    { waitForAnimationFrame: () => Promise.resolve() },
    { mouse: { wheel: () => never } },
    never,
    () => {},
    { timeoutMs: 10 },
  );

  await assert.rejects(
    activeInput.completion,
    /Gallery response boundary was not observed within 10ms/,
  );
});

test('response-overlap wheel ownership stops idempotently during a stalled animation frame', async () => {
  const { keepWheelActiveUntilResponseBoundary } = await import(
    '../e2e/poms/galleryRegressions.js'
  );
  const never = new Promise(() => {});
  let wheelCount = 0;
  const activeInput = keepWheelActiveUntilResponseBoundary(
    { waitForAnimationFrame: () => never },
    { mouse: { wheel: async () => { wheelCount += 1; } } },
    never,
    () => {},
    { timeoutMs: 1000 },
  );

  await Promise.resolve();
  activeInput.stop();
  activeInput.stop();

  assert.equal(await activeInput.completion, undefined);
  assert.equal(wheelCount, 1);
});

test('reverse pagination requires exact visible movement across stable or explicitly rebased coordinates', () => {
  const source = fs.readFileSync(path.resolve(
    __dirname,
    '../e2e/syntheticLargeLibrary/artistTreeScrollNavigation.spec.js',
  ), 'utf8');
  const reverseScenario = source.slice(
    source.indexOf('const upwardArtists = new Set()'),
    source.indexOf('const reverseState = await page.evaluate'),
  );

  assert.match(reverseScenario, /coordinateRestore[\s\S]*scroll-restore-settled/);
  assert.match(reverseScenario, /restoredWheelDelta[\s\S]*coordinateRestore\.scrollTop/);
  assert.match(reverseScenario, /visibleDrift = Math\.abs\(Number\(continuity\.delta\) - 160\)/);
  assert.match(reverseScenario, /expect\(continuity\.connected\)\.toBe\(true\)/);
  assert.match(reverseScenario, /expect\(visibleDrift\)\.toBe\(0\)/);
  assert.doesNotMatch(reverseScenario, /if \(continuity\.connected && continuity\.delta !== null\)/);
  assert.doesNotMatch(reverseScenario, /continuity\.delta\)\.toBeGreaterThanOrEqual/);
  assert.doesNotMatch(reverseScenario, /continuity\.delta\)\.toBeLessThanOrEqual/);
});

test('native stability scenarios select presentation after Artist Tree enters the mobile Gallery', () => {
  const source = fs.readFileSync(path.resolve(
    __dirname,
    '../e2e/syntheticLargeLibrary/galleryNativeScrollStability.spec.js',
  ), 'utf8');
  const helper = source.slice(
    source.indexOf('async function openDeepGallery'),
    source.indexOf('function expectGestureStable'),
  );

  assert.ok(helper.indexOf('selectView(view)') >= 0);
  assert.ok(helper.indexOf('selectView(view)') > helper.indexOf('scrollToArtistAction.click()'));
});

test('native mobile stability uses a continuous touch contact instead of ignored synthesized gestures', () => {
  const source = fs.readFileSync(path.resolve(
    __dirname,
    '../e2e/syntheticLargeLibrary/galleryNativeScrollStability.spec.js',
  ), 'utf8');

  assert.match(source, /Input\.dispatchTouchEvent/);
  assert.doesNotMatch(source, /Input\.synthesizeScrollGesture/);
  assert.match(source, /TOUCH_ACTIVATION_DISTANCE\s*=\s*15/);
});

test('native frame observation records a baseline before input can be dispatched', () => {
  const source = fs.readFileSync(path.resolve(
    __dirname,
    '../e2e/poms/galleryRegressions.js',
  ), 'utf8');
  const helper = source.slice(
    source.indexOf('async startNativeScrollFrameObservation'),
    source.indexOf('async startVisibleCardAnchorObservation'),
  );

  assert.match(helper, /\bsample\(\);\s*return\s*\{/);
  assert.doesNotMatch(helper, /frame\s*=\s*requestAnimationFrame\(sample\);\s*return\s*\{/);
});

test('native frame observation includes virtual-grid events at the frame that changes geometry', () => {
  const source = fs.readFileSync(path.resolve(
    __dirname,
    '../e2e/poms/galleryRegressions.js',
  ), 'utf8');
  const helper = source.slice(
    source.indexOf('async startNativeScrollFrameObservation'),
    source.indexOf('async startVisibleCardAnchorObservation'),
  );

  assert.match(helper, /lastGridEventSequence/);
  assert.match(helper, /gridEvents/);
});

test('native scroll evidence exposes anchor replacement instead of rebasing it away', async () => {
  const { analyzeNativeScrollGesture } = await import('../e2e/poms/galleryRegressions.js');
  const samples = [
    { anchorGeneration: 0, scrollTop: 100, contentCoordinate: 500 },
    { anchorGeneration: 1, scrollTop: 132, contentCoordinate: 532 },
  ];

  const evidence = analyzeNativeScrollGesture(samples, 1);

  assert.deepEqual(evidence.anchorReplacementIndexes, [1]);
  assert.equal(evidence.signedTotalDisplacement, 32);
});

test('native scroll evidence exposes replacement before its first animation-frame sample', async () => {
  const { analyzeNativeScrollGesture } = await import('../e2e/poms/galleryRegressions.js');
  const samples = [
    { anchorGeneration: 1, scrollTop: 100, contentCoordinate: 500 },
    { anchorGeneration: 1, scrollTop: 132, contentCoordinate: 500 },
  ];

  assert.deepEqual(analyzeNativeScrollGesture(samples, 1).anchorReplacementIndexes, [0, 1]);
});

test('native scroll evidence exposes replacement by an equivalent DOM node', async () => {
  const { analyzeNativeScrollGesture } = await import('../e2e/poms/galleryRegressions.js');
  const samples = [
    { anchorGeneration: 0, originalConnected: true, sameNode: true, scrollTop: 100, contentCoordinate: 500 },
    { anchorGeneration: 0, originalConnected: false, sameNode: false, scrollTop: 132, contentCoordinate: 500 },
  ];

  assert.deepEqual(
    analyzeNativeScrollGesture(samples, 1).originalNodeReplacementIndexes,
    [1],
  );
});

test('native scroll evidence keeps a reverse first twitch in the full signed movement stream', async () => {
  const { analyzeNativeScrollGesture } = await import('../e2e/poms/galleryRegressions.js');
  const samples = [
    { anchorGeneration: 0, scrollTop: 100, contentCoordinate: 500 },
    { anchorGeneration: 0, scrollTop: 99, contentCoordinate: 500 },
    { anchorGeneration: 0, scrollTop: 110, contentCoordinate: 500 },
  ];

  const evidence = analyzeNativeScrollGesture(samples, 1);

  assert.equal(evidence.firstMovementIndex, 1);
  assert.deepEqual(evidence.signedStepDeltas, [-1, 11]);
  assert.equal(evidence.signedTotalDisplacement, 10);
});

test('native scroll evidence reports total same-direction displacement for gesture bounds', async () => {
  const { analyzeNativeScrollGesture } = await import('../e2e/poms/galleryRegressions.js');
  const samples = [
    { anchorGeneration: 0, scrollTop: 100, contentCoordinate: 500 },
    { anchorGeneration: 0, scrollTop: 220, contentCoordinate: 500 },
    { anchorGeneration: 0, scrollTop: 420, contentCoordinate: 500 },
  ];

  const evidence = analyzeNativeScrollGesture(samples, 1);

  assert.equal(evidence.signedTotalDisplacement, 320);
  assert.equal(evidence.maxContentDrift, 0);
});

test('native scroll evidence reports no movement when the browser ignores input', async () => {
  const { analyzeNativeScrollGesture } = await import('../e2e/poms/galleryRegressions.js');
  const samples = [
    { anchorGeneration: 0, scrollTop: 100, contentCoordinate: 500 },
    { anchorGeneration: 0, scrollTop: 100, contentCoordinate: 500 },
  ];

  const evidence = analyzeNativeScrollGesture(samples, 1);

  assert.equal(evidence.firstMovementIndex, -1);
  assert.equal(evidence.signedTotalDisplacement, 0);
  assert.deepEqual(evidence.signedStepDeltas, []);
});

test('native scroll evidence treats a compensated virtual-coordinate rebase as zero visible movement', async () => {
  const { analyzeNativeScrollGesture } = await import('../e2e/poms/galleryRegressions.js');
  const samples = [
    { anchorGeneration: 0, scrollTop: 100, viewportOffset: 50, contentCoordinate: 150 },
    { anchorGeneration: 0, scrollTop: 132, viewportOffset: 18, contentCoordinate: 150 },
    { anchorGeneration: 0, scrollTop: 24_877, viewportOffset: 18, contentCoordinate: 24_895 },
    { anchorGeneration: 0, scrollTop: 24_909, viewportOffset: -14, contentCoordinate: 24_895 },
  ];

  const evidence = analyzeNativeScrollGesture(samples, 1);

  assert.equal(evidence.firstMovementIndex, 1);
  assert.deepEqual(evidence.signedStepDeltas, [32, 0, 32]);
  assert.equal(evidence.maxForwardVisibleStep, 32);
  assert.equal(evidence.maxReverseVisibleDrift, 0);
  assert.equal(evidence.signedTotalDisplacement, 64);
});

test('native scroll evidence preserves a one-pixel visible drift across a compensated rebase', async () => {
  const { analyzeNativeScrollGesture } = await import('../e2e/poms/galleryRegressions.js');
  const samples = [
    { anchorGeneration: 0, scrollTop: 100, viewportOffset: 50, contentCoordinate: 150 },
    { anchorGeneration: 0, scrollTop: 24_846, viewportOffset: 17, contentCoordinate: 24_863 },
    { anchorGeneration: 0, scrollTop: 24_878, viewportOffset: -15, contentCoordinate: 24_863 },
  ];

  const evidence = analyzeNativeScrollGesture(samples, 1);

  assert.deepEqual(evidence.signedStepDeltas, [33, 32]);
  assert.equal(evidence.maxForwardVisibleStep, 33);
  assert.equal(evidence.maxReverseVisibleDrift, 0);
  assert.equal(evidence.signedTotalDisplacement, 65);
});

test('native scroll activation settling waits for consecutive stable animation frames', async () => {
  const { GalleryRegressions } = await import('../e2e/poms/galleryRegressions.js');
  const observed = [15, 15, 20, 20, 20];
  let frameCount = 0;
  const ui = {
    galleryScroll: {
      evaluate: async () => observed[Math.min(frameCount, observed.length - 1)],
    },
    waitForAnimationFrame: async () => { frameCount += 1; },
  };

  await GalleryRegressions.prototype.waitForNativeScrollSettled.call(ui, {
    stableFrames: 2,
    maximumFrames: 8,
  });

  assert.equal(frameCount, 4);
});

test('native scroll displacement requires the exact commanded distance', async () => {
  const { nativeScrollDisplacementMatchesCommand } = await import('../e2e/poms/galleryRegressions.js');

  assert.equal(nativeScrollDisplacementMatchesCommand(128, 128), true);
  assert.equal(nativeScrollDisplacementMatchesCommand(126, 128), false);
  assert.equal(nativeScrollDisplacementMatchesCommand(130, 128), false);
  assert.equal(nativeScrollDisplacementMatchesCommand(135, 139), false);
});

test('native scroll displacement rejects same-direction jumps beyond the commanded distance', async () => {
  const { nativeScrollDisplacementMatchesCommand } = await import('../e2e/poms/galleryRegressions.js');

  assert.equal(nativeScrollDisplacementMatchesCommand(138, 128), false);
  assert.equal(nativeScrollDisplacementMatchesCommand(129, 139), false);
  assert.equal(nativeScrollDisplacementMatchesCommand(178, 128), false);
});

test('native scroll step ceiling rejects extra same-direction application movement', async () => {
  const { nativeScrollStepsMatchCommand } = await import('../e2e/poms/galleryRegressions.js');

  assert.equal(nativeScrollStepsMatchCommand([8, 9, 8], 9), true);
  assert.equal(nativeScrollStepsMatchCommand([8, 19, 8], 9), false);
  assert.equal(nativeScrollStepsMatchCommand([8, -1, 8], 9), false);
});

test('CDP response timestamps normalize both seconds and milliseconds to epoch milliseconds', async () => {
  const { normalizeCdpResponseEpoch } = await import('../e2e/poms/galleryRegressions.js');
  assert.equal(normalizeCdpResponseEpoch(1792153107.482), 1792153107482);
  assert.equal(normalizeCdpResponseEpoch(1792153107.4826), 1792153107.4826 * 1000);
  assert.notEqual(normalizeCdpResponseEpoch(1792153107.4826), 1792153107483);
  assert.equal(normalizeCdpResponseEpoch(1792153107482), 1792153107482);
  assert.equal(normalizeCdpResponseEpoch(0), null);
  assert.equal(normalizeCdpResponseEpoch(Number.NaN), null);
});
