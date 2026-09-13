const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

test('player spacing measures the timeline surface independently of its full-width metadata parent', async () => {
  const { GlobalPlayer } = await import('../e2e/poms/globalPlayer.js');
  const bounds = (x, width = 56) => ({ x, y: 600, width, height: 56 });
  const locator = value => ({ boundingBox: async () => value });
  const parentBounds = bounds(0, 1280);
  const pod = locator(bounds(192, 34));
  let timelineBounds = bounds(200, 1060);
  const owner = {
    expandedPlaybackControls: { root: locator(bounds(136)) },
    loopAction: { ...pod, evaluate: async () => ({ state: 'idle' }) },
    loopPod: pod, player: locator(bounds(0, 1280)), mainArea: locator(parentBounds),
    waveformCanvas: locator(bounds(200, 1060)), coverButton: locator(bounds(70, 50)),
    playButton: locator(bounds(140, 48)), timeline: { boundingBox: async () => timelineBounds },
    title: locator(bounds(0, 600)),
  };
  const visual = await GlobalPlayer.prototype.readLoopActionVisualSnapshot.call(owner);
  assert.equal(visual.mainAreaBounds, parentBounds, 'metadata parent bounds remain available unchanged');
  assert.equal(visual.mainLeftGapFromPlay, -188);
  assert.equal(visual.timelineLeftGapFromPlay, 12);
  timelineBounds = bounds(220, 1040);
  const shifted = await GlobalPlayer.prototype.readLoopActionVisualSnapshot.call(owner);
  assert.throws(() => assert.ok(Math.abs(shifted.timelineLeftGapFromPlay - 12) <= 1),
    'a wrong timeline position must fail the unchanged one-pixel spacing contract');
});

test('paused waveform readiness requires exact detail bins, owned path, and pixels beyond the playhead', async () => {
  const { GlobalPlayerActions } = await import('../e2e/actions/globalPlayerActions.js');
  const source = fs.readFileSync(path.resolve(__dirname, '../../music_app/static/js/runtime/player-waveform-peaks.js'), 'utf8');
  const bins = Number(source.match(/PLAYER_WAVEFORM_DETAIL_PEAK_COUNT = (\d+)/u)[1]);
  assert.equal(bins, 720);
  let predicate;
  const action = new GlobalPlayerActions({
    waveformCanvasSelector: '#waveform',
    waitForPageCondition: async callback => { predicate = callback; },
    readRenderedWaveformCheckpoint: async () => ({}),
  });
  await action.waitForRenderedWaveform({ path: 'owned-track' });
  function ready(count, ownedPath, drawn) {
    class Canvas {
      width = 20; height = 1; hidden = false;
      getContext() { return { getImageData: () => ({ data: Array.from({ length: 80 }, (_, i) => drawn && i === 79 ? 255 : 0) }) }; }
    }
    const canvas = new Canvas();
    return vm.runInNewContext(`(${predicate})({canvasSelector:'#waveform',path:'owned-track'})`, {
      HTMLCanvasElement: Canvas, document: { querySelector: () => canvas },
      state: { player: { waveform: { compactPeaks: { path: ownedPath, data: { left: Array(count).fill(1), right: Array(count).fill(1) } } } } },
      getStreamingPlaybackSnapshot: () => ({ duration: 20, currentTime: 0 }),
    });
  }
  assert.equal(ready(bins, 'owned-track', true), true);
  assert.equal(ready(280, 'owned-track', true), false);
  assert.equal(ready(bins, 'other-track', true), false);
  assert.equal(ready(bins, 'owned-track', false), false);
});
