const test = require('node:test');
const assert = require('node:assert/strict');

test('native artist long press uses 600 ms touch and detaches after failure', async () => {
  const { GalleryRegressions } = await import('../e2e/poms/galleryRegressions.js');
  let detached = 0;
  const ui = Object.create(GalleryRegressions.prototype);
  ui.page = { context: () => ({ newCDPSession: async () => ({
    async send(command, options) {
      assert.equal(command, 'Input.synthesizeTapGesture');
      assert.deepEqual(options, { x: 25, y: 40, duration: 600, gestureSourceType: 'touch', tapCount: 1 });
      throw new Error('browser disconnected');
    },
    async detach() { detached += 1; },
  }) }) };
  await assert.rejects(ui.longPressArtist({ boundingBox: async () => ({ x: 10, y: 20, width: 30, height: 40 }) }), /browser disconnected/);
  assert.equal(detached, 1);
});

test('artist placement observation retains every frame and cancels its owned frame', async () => {
  const { GalleryRegressions } = await import('../e2e/poms/galleryRegressions.js');
  const callbacks = new Map();
  let sequence = 0;
  let aligned = true;
  let disposed = 0;
  const previous = Object.fromEntries(['document', 'requestAnimationFrame', 'cancelAnimationFrame'].map(key => [key, global[key]]));
  const rect = top => ({ getBoundingClientRect: () => ({ top }) });
  const section = { querySelector: selector => rect(selector === '.artist-rows' && !aligned ? 20 : 0) };
  global.document = {
    getElementById: () => rect(0),
    querySelectorAll: () => [{ getAttribute: () => 'Target', closest: () => section }],
    querySelector: () => ({ textContent: 'Target' }),
  };
  global.requestAnimationFrame = callback => { callbacks.set(++sequence, callback); return sequence; };
  global.cancelAnimationFrame = id => callbacks.delete(id);
  const page = {
    locator: () => ({}),
    async evaluateHandle(callback, args) {
      const value = callback(args);
      return { evaluate: fn => fn(value), dispose: async () => { disposed += 1; } };
    },
  };
  try {
    const ui = Object.create(GalleryRegressions.prototype);
    ui.page = page;
    ui.artistHeadingSelector = '[data-owned-heading]';
    const observation = await ui.startArtistJumpPlacementObservation('Target');
    for (let frame = 0; frame < 40; frame += 1) {
      aligned = frame !== 20;
      const [id, callback] = callbacks.entries().next().value;
      callbacks.delete(id);
      callback();
    }
    const samples = await observation.finish();
    assert.equal(samples.length, 40);
    assert.equal(samples.filter(sample => !sample.stable).length, 1);
    assert.equal(callbacks.size, 0);
    assert.equal(disposed, 1);
    await observation.finish();
    assert.equal(disposed, 1);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key]; else global[key] = value;
    }
  }
});
