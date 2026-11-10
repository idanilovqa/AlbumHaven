const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/runtime/mobile-navigation.js'), 'utf8');

function eventTarget(extra = {}) {
  const listeners = new Map();
  return Object.assign({
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) || []).filter(value => value !== listener));
    },
    emit(type, touches = []) {
      const event = { type, touches, cancelable: true, prevented: false, stopped: false,
        preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
      for (const listener of listeners.get(type) || []) listener(event);
      return event;
    },
  }, extra);
}

function harness({ columns = 3, view = 'cards', width = 390, reduced = false } = {}) {
  const calls = { begin: [], update: [], finish: [], save: [] };
  const gallery = eventTarget({ dataset: {}, isConnected: true });
  const document = eventTarget({ hidden: false, getElementById: id => id === 'albums-scroll' ? gallery : null });
  const window = eventTarget({ innerWidth: width, matchMedia: () => ({ matches: reduced }),
    AlbumHavenDevicePreferences: { read: () => columns } });
  const current = { view };
  const grid = {
    beginPinchPreview: value => { calls.begin.push(value); return true; },
    updatePinchPreview: value => calls.update.push(value),
    finishPinchPreview: (...args) => calls.finish.push(args),
  };
  const context = vm.createContext({ window, document, virtualGrid: grid, state: { ui: {} }, Date, Math,
    ensureGalleryMainState: () => current, closeGalleryMainSurface() {},
    requestAnimationFrame: fn => { fn(); return 1; }, cancelAnimationFrame() {} });
  vm.runInContext(source, context);
  context.setMobileGalleryColumns = value => { calls.save.push(value); columns = value; return true; };
  context.initMobileGalleryPinch();
  const touches = (scale = 1) => [{ identifier: 7, clientX: 195 - 55 * scale, clientY: 280 },
    { identifier: 9, clientX: 195 + 55 * scale, clientY: 280 }];
  return { calls, gallery, document, window, current, context, touches };
}

test('continuous density keeps the established 1.28 settle thresholds in both directions', () => {
  const h = harness();
  const resolve = h.context.resolvePinchColumns;
  assert.equal(resolve(3, 1.4), 2);
  assert.equal(resolve(3, 1.8), 1);
  assert.equal(resolve(3, 1.28 - 1e-6), 3);
  assert.equal(resolve(3, 1.28), 2);
  assert.equal(resolve(2, 1 / 1.28), 3);
  assert.equal(resolve(1, .45), 3);
  assert.equal(resolve(3, .45), 3);
  assert.equal(resolve(1, 1.8), 1);
});

test('continuous density moves before the first threshold and remains finite, monotonic and bounded', () => {
  const { context } = harness();
  assert.equal(typeof context.resolvePinchDensity, 'function');
  for (const columns of [1, 2, 3]) {
    assert.equal(context.resolvePinchDensity(columns, 1), columns);
    for (const invalid of [NaN, Infinity, 0, -1]) assert.equal(context.resolvePinchDensity(columns, invalid), columns);
    const densities = [.1, .7, .9, 1, 1.1, 1.2, 1.4, 1.8, 10].map(scale => context.resolvePinchDensity(columns, scale));
    for (const density of densities) assert.ok(density >= 1 && density <= 3 && Number.isFinite(density));
    for (let index = 1; index < densities.length; index++) assert.ok(densities[index] <= densities[index - 1]);
  }
  assert.ok(context.resolvePinchDensity(3, 1.1) < 3);
  assert.ok(context.resolvePinchDensity(3, 1.1) > 2);
  assert.ok(context.resolvePinchDensity(2, .95) > 2);
});

for (const view of ['cards', 'covers']) {
  test(`${view} previews real two-finger movement around its midpoint without saving before release`, () => {
    const h = harness({ view });
    assert.equal(h.gallery.emit('touchstart', h.touches()).prevented, true);
    assert.equal(h.calls.begin.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls.begin[0])), { clientX: 195, clientY: 280, columns: 3 });
    h.gallery.emit('touchmove', h.touches(1.1));
    h.gallery.emit('touchmove', h.touches(1.2));
    assert.equal(h.calls.update.length, 2);
    assert.ok(h.calls.update[0] > h.calls.update[1]);
    assert.ok(h.calls.update[0] < 3 && h.calls.update[1] > 2);
    assert.deepEqual(h.calls.save, []);
    h.gallery.emit('touchend', []);
    assert.equal(h.calls.finish.length, 1);
  });
}

test('first finger release keeps the preview alive and saves exactly once after both lift', () => {
  const h = harness();
  h.gallery.emit('touchstart', h.touches());
  h.gallery.emit('touchmove', h.touches(1.4));
  h.gallery.emit('touchend', h.touches(1.4).slice(0, 1));
  assert.deepEqual(h.calls.save, []);
  assert.equal(h.calls.finish.length, 0);
  h.gallery.emit('touchend', []);
  assert.deepEqual(h.calls.save, [2]);
  assert.equal(h.calls.finish.length, 1);
  h.gallery.emit('touchend', []);
  assert.deepEqual(h.calls.save, [2]);
  const click = h.gallery.emit('click');
  assert.equal(click.prevented, true);
  assert.equal(click.stopped, true);
});

for (const interruption of ['touchcancel', 'third-finger', 'blur', 'resize', 'hidden', 'rows']) {
  test(`${interruption} clears the preview without persisting a partial gesture`, () => {
    const h = harness();
    h.gallery.emit('touchstart', h.touches());
    h.gallery.emit('touchmove', h.touches(1.4));
    if (interruption === 'third-finger') h.gallery.emit('touchstart', [...h.touches(), { identifier: 11, clientX: 220, clientY: 300 }]);
    else if (interruption === 'hidden') { h.document.hidden = true; h.document.emit('visibilitychange'); }
    else if (interruption === 'rows') { h.current.view = 'list'; h.gallery.emit('touchmove', h.touches(1.5)); }
    else (['blur', 'resize'].includes(interruption) ? h.window : h.gallery).emit(interruption, []);
    assert.equal(h.calls.finish.length, 1);
    assert.equal(h.calls.finish[0][1].cancelled, true);
    assert.deepEqual(h.calls.save, []);
    const updated = h.calls.update.length;
    h.gallery.emit('touchmove', h.touches(1.8));
    h.gallery.emit('touchend', []);
    assert.equal(h.calls.update.length, updated);
    assert.deepEqual(h.calls.save, []);
  });
}

for (const options of [{ view: 'list' }, { width: 1180 }]) {
  test(`${options.view || 'desktop'} excludes preview, persistence and event prevention`, () => {
    const h = harness(options);
    assert.equal(h.gallery.emit('touchstart', h.touches()).prevented, false);
    assert.equal(h.gallery.emit('touchmove', h.touches(1.8)).prevented, false);
    h.gallery.emit('touchend', []);
    assert.deepEqual(h.calls, { begin: [], update: [], finish: [], save: [] });
  });
}

test('reduced motion captures a stable anchor, skips animated preview and keeps final density choice', () => {
  const h = harness({ reduced: true });
  h.gallery.emit('touchstart', h.touches());
  h.gallery.emit('touchmove', h.touches(1.8));
  assert.equal(h.calls.begin.length, 1);
  assert.deepEqual(h.calls.update, []);
  h.gallery.emit('touchend', []);
  assert.deepEqual(h.calls.save, [1]);
  assert.equal(h.calls.finish.length, 1);
});

test('single-finger scroll and undersized two-finger contact never start a pinch', () => {
  const h = harness();
  assert.equal(h.gallery.emit('touchstart', h.touches().slice(0, 1)).prevented, false);
  assert.equal(h.gallery.emit('touchstart', h.touches(.1)).prevented, false);
  assert.equal(h.gallery.emit('touchmove', h.touches(1.8)).prevented, false);
  h.gallery.emit('touchend', []);
  assert.deepEqual(h.calls, { begin: [], update: [], finish: [], save: [] });
});

for (const view of ['cards', 'covers']) {
  for (const replacementId of [11, 9]) {
    test(`${view} cancels a partially released pinch when a replacement finger ${replacementId === 9 ? 'reuses the lifted identifier' : 'lands'}`, () => {
      const h = harness({ view });
      h.gallery.emit('touchstart', h.touches());
      h.gallery.emit('touchmove', h.touches(1.4));
      const remaining = h.touches(1.4).slice(0, 1);
      h.gallery.emit('touchend', remaining);
      const replacement = [...remaining, { identifier: replacementId, clientX: 340, clientY: 280 }];
      h.gallery.emit('touchstart', replacement);
      assert.equal(h.calls.finish.length, 1, 'Replacing a lifted finger interrupts the original two-finger gesture.');
      assert.equal(h.calls.finish[0][1].cancelled, true);
      const updates = h.calls.update.length;
      h.gallery.emit('touchmove', replacement);
      h.gallery.emit('touchend', []);
      assert.equal(h.calls.update.length, updates);
      assert.deepEqual(h.calls.save, [], 'A replacement finger must not apply a scale from the previous contact span.');
      h.gallery.emit('touchstart', h.touches());
      h.gallery.emit('touchmove', h.touches(1.4));
      h.gallery.emit('touchend', []);
      assert.deepEqual(h.calls.save, [2], 'A fresh complete pinch must remain usable after the interruption.');
    });
  }
}

for (const interruption of ['pagehide', 'mobile-page', 'desktop-at-release', 'rows-at-release']) {
  test(`${interruption} prevents a stale release from persisting density and allows the next gallery pinch`, () => {
    const h = harness();
    h.gallery.emit('touchstart', h.touches());
    h.gallery.emit('touchmove', h.touches(1.4));
    if (interruption === 'pagehide') h.window.emit('pagehide');
    else if (interruption === 'mobile-page') {
      vm.runInContext("mobilePageState.pages.push({ kind: 'album' }); syncMobilePageShell();", h.context);
      assert.equal(h.calls.finish.length, 1, 'Navigation must cancel immediately, before a later touch event.');
    } else if (interruption === 'desktop-at-release') h.window.innerWidth = 1180;
    else h.current.view = 'list';
    h.gallery.emit('touchend', []);
    assert.equal(h.calls.finish.length, 1);
    assert.equal(h.calls.finish[0][1].cancelled, true);
    assert.deepEqual(h.calls.save, []);
    h.window.innerWidth = 390;
    h.current.view = 'cards';
    vm.runInContext('mobilePageState.pages.length = 0;', h.context);
    h.gallery.emit('touchstart', h.touches());
    h.gallery.emit('touchmove', h.touches(1.4));
    h.gallery.emit('touchend', []);
    assert.deepEqual(h.calls.save, [2]);
  });
}

test('reinitializing pinch bindings cannot double-preview or persist one gesture twice', () => {
  const h = harness();
  h.context.initMobileGalleryPinch();
  h.context.initMobileGalleryPinch();
  h.gallery.emit('touchstart', h.touches());
  h.gallery.emit('touchmove', h.touches(1.4));
  h.gallery.emit('touchend', []);
  assert.equal(h.calls.begin.length, 1);
  assert.equal(h.calls.update.length, 1);
  assert.equal(h.calls.finish.length, 1);
  assert.deepEqual(h.calls.save, [2]);
});

for (const view of ['cards', 'covers']) {
  test(`${view} keeps the same contact pair when separate touch targets deliver repeated starts`, () => {
    const h = harness({ view });
    h.gallery.emit('touchstart', h.touches());
    // Simultaneous touches on different elements can each bubble a start carrying
    // the same global touches. TouchList ordering is not contact identity.
    h.gallery.emit('touchstart', h.touches().reverse());
    assert.equal(h.calls.begin.length, 1);
    assert.equal(h.calls.finish.length, 0, 'The original pair is still down; this is not a replacement finger.');
    h.gallery.emit('touchmove', h.touches(1.4));
    assert.equal(h.calls.update.length, 1);
    h.gallery.emit('touchend', []);
    assert.deepEqual(h.calls.save, [2]);
    assert.equal(h.calls.finish.length, 1);
    assert.equal(h.calls.finish[0][1].cancelled, false);
  });
}
