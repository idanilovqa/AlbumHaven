const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

test('small native wheel checkpoint waits for requested position instead of old boundary tolerance', async () => {
  const { hasSettledVirtualGalleryRender } = await import(pathToFileURL(path.resolve(__dirname, '../e2e/poms/galleryPage.js')).href);
  class Element {}
  const gallery = Object.assign(new Element(), { scrollTop: 0, scrollHeight: 602, clientHeight: 600 });
  const diagnostics = {
    latestScroll: { scrollTop: 0, renderGeneration: 8, renderRafOwner: 12 },
    latestRender: { viewportTop: 0, renderGeneration: 8, renderRafOwner: 12 },
  };
  const probe = { galleryScrollSelector: '#albums-scroll', priorPosition: 0, expectedDirection: 1 };
  const run = args => vm.runInNewContext(`(${hasSettledVirtualGalleryRender.toString()})(args)`, {
    args, HTMLElement: Element, document: { querySelector: () => gallery },
    __ALBUM_HAVEN_VIRTUAL_GRID__: diagnostics,
  });
  assert.equal(run(probe), true, 'Legacy boundary-only observation accepts old completed zero-pixel state');
  assert.equal(run({ ...probe, targetScrollTop: 2 }), false);
  gallery.scrollTop = 1;
  assert.equal(run({ ...probe, targetScrollTop: 2 }), false, 'Partial native wheel delivery is not its target');
  gallery.scrollTop = 2;
  diagnostics.latestScroll = { scrollTop: 2, renderGeneration: 8, renderRafOwner: 13 };
  assert.equal(run({ ...probe, targetScrollTop: 2 }), false, 'Still waits for existing render-owner contract');
  diagnostics.latestRender = { viewportTop: 2, renderGeneration: 8, renderRafOwner: 13 };
  assert.equal(run({ ...probe, targetScrollTop: 2 }), true, 'Same virtual-window generation can settle');
  assert.equal(run({ ...probe, targetScrollTop: 100 }), true, 'Targets clamp to real lower boundary');
  const up = { ...probe, priorPosition: 2, expectedDirection: -1, targetScrollTop: -10 };
  assert.equal(run(up), false);
  gallery.scrollTop = 0;
  diagnostics.latestScroll.scrollTop = 0;
  diagnostics.latestRender.viewportTop = 0;
  assert.equal(run(up), true, 'Upward movement clamps to zero');
});

test('middle continuity checkpoint forwards exact native wheel target to unchanged readiness wait', async () => {
  const { GalleryActions } = await import(pathToFileURL(path.resolve(__dirname, '../e2e/actions/galleryActions.js')).href);
  const calls = [];
  const owner = {
    readGalleryScrollState: async () => ({ scrollTop: 0, maxScrollTop: 4 }),
    scrollGalleryBy: async delta => calls.push(['wheel', delta]),
    galleryPage: { waitForGalleryScrollMovement: async (...args) => calls.push(['wait', ...args]) },
  };
  await GalleryActions.prototype.scrollGalleryToMiddle.call(owner);
  assert.deepEqual(calls, [['wheel', 2], ['wait', 0, 1, { targetScrollTop: 2 }]]);
});
