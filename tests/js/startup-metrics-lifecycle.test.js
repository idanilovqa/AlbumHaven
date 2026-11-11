const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadStartupMetrics() {
  const frames = [];
  const progress = [];
  let finishes = 0;
  const context = vm.createContext({
    appBootstrap: { getBootstrap: () => ({ startupPreview: {}, startupTiming: {} }) },
    document: { querySelectorAll: () => [] },
    window: {
      __ALBUM_HAVEN_STARTUP_MARKS__: [],
      AlbumHavenStartupProgress: {
        finish() { finishes += 1; },
        show(value) { progress.push(value); },
      },
      performance: { now: () => 1 },
      requestAnimationFrame(callback) { frames.push(callback); },
    },
  });
  const sourcePath = path.resolve(
    __dirname,
    '../../music_app/static/js/runtime/startup-metrics-helpers.js',
  );
  vm.runInContext(
    `${fs.readFileSync(sourcePath, 'utf8')}\nglobalThis.__testStartupMetrics = startupMetrics;`,
    context,
  );
  return {
    frames,
    get finishes() { return finishes; },
    metrics: context.__testStartupMetrics,
    progress,
    runNextFrame() {
      const callbacks = frames.splice(0);
      assert.ok(callbacks.length, 'expected a queued animation frame');
      callbacks.forEach(callback => callback());
    },
  };
}

test('startup lifecycle advances real milestones and finishes after populated paint', () => {
  const lifecycle = loadStartupMetrics();

  lifecycle.metrics.beginInitialRefresh();
  lifecycle.metrics.markInitialRender({ selected_artist: 'Broadcast' });
  lifecycle.metrics.advanceInitialRefresh(75);
  lifecycle.metrics.advanceInitialRefresh(85);
  lifecycle.metrics.advanceInitialRefresh(90);
  lifecycle.metrics.advanceInitialRefresh(95);
  lifecycle.metrics.completeVisibleInitialRefresh({ album_count: 2 });

  assert.deepEqual(lifecycle.progress, [65, 70, 75, 85, 90, 95]);
  assert.equal(lifecycle.finishes, 0);
  lifecycle.runNextFrame();
  assert.equal(lifecycle.finishes, 0);
  lifecycle.runNextFrame();
  assert.equal(lifecycle.finishes, 1);
});
