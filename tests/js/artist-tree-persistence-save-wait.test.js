const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('Artist Tree persistence scenario awaits each server save before reloading', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../e2e/specs/artistTreePersistence.spec.js'), 'utf8')
    .replace(/^import .*;\s*/u, '');
  let scenario;
  let folded = false;
  let pending = false;
  const saveGates = [];
  let reloads = 0;
  const navigation = {
    artistTreeFoldButton: 'collapse', artistTreeNavigationButton: 'expand', layoutPreferenceSync: 'sync',
    readArtistTreeFoldState: async () => ({ folded, transitioning: false }),
  };
  const expect = actual => ({
    toBeVisible: async () => {}, toBeHidden: async () => {},
    toMatchObject: expected => {
      for (const [key, value] of Object.entries(expected)) assert.equal(actual[key], value);
    },
    toHaveAttribute: async (name, value) => {
      assert.equal(actual, 'sync');
      assert.equal(name, 'data-preferences-sync');
      assert.equal(value, 'saved');
      await new Promise(resolve => { saveGates.push({ folded, release: () => { pending = false; resolve(); } }); });
    },
  });
  vm.runInNewContext(source, { expect, test: (_name, _options, fn) => { scenario = fn; } });
  const running = scenario({
    galleryActions: { goto: async () => {}, waitForGalleryReady: async () => {} },
    navigationPanelActions: {
      navigationPanel: navigation,
      setArtistTreeFolded: async value => { folded = value; pending = true; },
    },
    page: { reload: async () => { assert.equal(pending, false, 'reload must await persistence'); reloads += 1; } },
    stepLogger: { step: async (_name, action) => action() },
  });
  for (const [index, gate] of [
    { folded: false, before: 0, after: 0 },
    { folded: true, before: 0, after: 1 },
    { folded: false, before: 1, after: 2 },
  ].entries()) {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(saveGates.length, index + 1);
    assert.equal(saveGates[index].folded, gate.folded);
    assert.equal(reloads, gate.before, 'Reload must not precede its save acknowledgement');
    saveGates[index].release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reloads, gate.after);
  }
  await running;
  assert.equal(saveGates.length, 3);
  assert.equal(reloads, 2);
});
