const assert = require('node:assert/strict');
const test = require('node:test');

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
