const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const fixtureSource = fs.readFileSync(path.resolve(__dirname, '../e2e/support/isolatedLibraryApp.py'), 'utf8');
const manualPage = fixtureSource.split('    def _serve_manual_page(')[1].split('    def _serve_manual_image(')[0];
const script = manualPage.match(/<script>([\s\S]*?)<\/script>/)[1].replaceAll('{{', '{').replaceAll('}}', '}');
const settle = () => new Promise(resolve => setImmediate(resolve));

function createHarness({ complete = true, width = 7500, height = 7500, blob = { type: 'image/png', size: 649815 } } = {}) {
  const imageListeners = new Map();
  const buttonListeners = new Map();
  const draws = [];
  const writes = [];
  const image = {
    complete, naturalWidth: width, naturalHeight: height,
    addEventListener(type, listener, options) {
      assert.deepEqual(JSON.parse(JSON.stringify(options)), { once: true });
      imageListeners.set(type, listener);
    },
    decode() { throw new Error('Clipboard preparation must not require eager full-size decoding'); },
  };
  const button = { disabled: true, addEventListener: (type, listener) => buttonListeners.set(type, listener) };
  const status = { textContent: 'Preparing image' };
  const canvas = {
    width: 0, height: 0,
    getContext(type) {
      assert.equal(type, '2d');
      return { drawImage: (...args) => draws.push(args) };
    },
    toBlob(resolve, type) { assert.equal(type, 'image/png'); resolve(blob); },
  };
  vm.runInNewContext(script, {
    document: {
      querySelector: selector => ({ img: image, button, '[role="status"]': status })[selector],
      createElement(type) { assert.equal(type, 'canvas'); return canvas; },
    },
    navigator: { clipboard: { async write(items) { writes.push(items); } } },
    ClipboardItem: class { constructor(data) { this.data = data; } },
    console: { error() {} },
  });
  return { image, imageListeners, button, buttonListeners, status, canvas, draws, writes, blob };
}

test('a loaded full-size provider image prepares the existing PNG canvas and copies only on click', async () => {
  const h = createHarness();
  await settle();
  assert.equal(h.status.textContent, 'Image ready');
  assert.equal(h.button.disabled, false);
  assert.equal(h.canvas.width, 512);
  assert.equal(h.canvas.height, 512);
  assert.equal(h.draws.length, 1);
  assert.equal(h.draws[0][0], h.image);
  assert.deepEqual(h.draws[0].slice(1), [0, 0, 512, 512]);
  assert.equal(h.writes.length, 0);
  await h.buttonListeners.get('click')();
  assert.equal(h.writes[0][0].data['image/png'], h.blob);
  assert.equal(h.status.textContent, 'Image copied');
});

test('an in-flight provider image waits for its normal load before canvas preparation', async () => {
  const h = createHarness({ complete: false, width: 0, height: 0 });
  await settle();
  assert.equal(h.draws.length, 0);
  assert.equal(h.button.disabled, true);
  h.image.complete = true;
  h.image.naturalWidth = 128;
  h.image.naturalHeight = 64;
  h.imageListeners.get('load')();
  await settle();
  assert.equal(h.status.textContent, 'Image ready');
  assert.equal(h.canvas.width, 128);
  assert.equal(h.canvas.height, 64);
  assert.equal(h.draws.length, 1);
});

test('a provider image load error keeps Copy disabled and never fabricates image bytes', async () => {
  const h = createHarness({ complete: false, width: 0, height: 0 });
  h.imageListeners.get('error')();
  await settle();
  assert.equal(h.status.textContent, 'Image preparation failed');
  assert.equal(h.button.disabled, true);
  assert.equal(h.draws.length, 0);
  assert.equal(h.writes.length, 0);
});

for (const dimensions of [{ width: 0, height: 7500 }, { width: 7500, height: 0 }]) {
  test(`a completed image with invalid dimensions ${dimensions.width}x${dimensions.height} fails preparation`, async () => {
    const h = createHarness(dimensions);
    await settle();
    assert.equal(h.status.textContent, 'Image preparation failed');
    assert.equal(h.button.disabled, true);
    assert.equal(h.draws.length, 0);
  });
}

test('PNG conversion failure keeps Copy disabled', async () => {
  const h = createHarness({ blob: null });
  await settle();
  assert.equal(h.status.textContent, 'Image preparation failed');
  assert.equal(h.button.disabled, true);
  assert.equal(h.writes.length, 0);
});
