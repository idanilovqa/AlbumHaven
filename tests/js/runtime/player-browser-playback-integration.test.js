const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const integrationPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'player-browser-playback-integration.js',
);

function createHarness({ visibilityState = 'visible', paused = false } = {}) {
  const recoveries = [];
  const published = [];
  const audioContext = { state: 'suspended', onstatechange: null };
  const context = {
    console,
    document: { visibilityState },
    Promise,
    state: {
      player: {
        streaming: {
          context: audioContext,
          mode: 'playing',
          roles: { current: { streamId: 7 } },
          snapshot: { paused, ended: false },
        },
      },
    },
    publishStreamingDiagnostics() {
      published.push(audioContext.state);
    },
    reconcileInterruptedStreamingPlayback(expectedContext = null) {
      recoveries.push(expectedContext);
      return Promise.resolve('resumed');
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(integrationPath, 'utf8'), context, {
    filename: integrationPath,
  });
  const api = vm.runInContext(`({
    observe: observeBrowserPlaybackAudioContext,
    foreground: reconcileBrowserPlaybackOnForeground,
  })`, context);
  return { api, audioContext, context, published, recoveries };
}

test('visible browser audio interruption delegates exact-context recovery', async () => {
  const harness = createHarness();
  harness.api.observe(harness.audioContext);

  harness.audioContext.onstatechange({ type: 'statechange' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.published, ['suspended']);
  assert.equal(harness.recoveries.length, 1);
  assert.strictEqual(harness.recoveries[0], harness.audioContext);
});

test('hidden interruption waits for foreground reconciliation', async () => {
  const harness = createHarness({ visibilityState: 'hidden' });
  harness.api.observe(harness.audioContext);

  harness.audioContext.onstatechange({ type: 'statechange' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.recoveries.length, 0);

  harness.context.document.visibilityState = 'visible';
  assert.equal(await harness.api.foreground(), 'resumed');
  assert.deepEqual(harness.recoveries, [null]);
});

test('intentional pause never triggers automatic interruption recovery', async () => {
  const harness = createHarness({ paused: true });
  harness.api.observe(harness.audioContext);

  harness.audioContext.onstatechange({ type: 'statechange' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.recoveries.length, 0);
});
