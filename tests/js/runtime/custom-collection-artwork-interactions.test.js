const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(
  __dirname,
  '../../../music_app/static/js/runtime/bootstrap-utility-event-handlers.js',
), 'utf8');

function loadContext() {
  const saves = [];
  const edits = [];
  const confirmations = [];
  let deletes = 0;
  const context = {
    console,
    Promise,
    setTimeout,
    clearTimeout,
    state: { utility: {}, coverLookup: { modal: {} }, tagEditor: {} },
    document: { querySelectorAll: () => [] },
    closeTagEditorExceptionMenu() {},
    closeUtilityLoopSettingMenu() {},
    handleLibrarySettingsChange: () => false,
    saveCustomCollectionArtworkFile: async (name, file) => saves.push({ name, file }),
    openCustomCollectionCoverLookup: async name => edits.push(name),
    openCoverLookupDeleteConfirm: value => confirmations.push(value),
    closeCoverLookupDeleteConfirm() {},
    deleteCustomCollectionArtwork: async () => { deletes += 1; },
    showRepairAlert() {},
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { context, saves, edits, confirmations, get deletes() { return deletes; } };
}

test('collection ready artbox opens Cover Lookup for that collection', async () => {
  const { context, edits } = loadContext();
  const event = {
    preventDefault() {},
    target: { closest: selector => (selector === '[data-edit-custom-collection-artwork]' ? {
      getAttribute: () => 'Night',
    } : null) },
  };

  await context.handleUtilityBootstrapClick(event);

  assert.deepEqual(edits, ['Night']);
});

test('collection empty artbox opens its own native image input', async () => {
  const { context } = loadContext();
  let clicked = 0;
  const input = { click() { clicked += 1; } };
  const button = {
    closest(selector) {
      return selector === '.album-artbox' ? { querySelector: () => input } : null;
    },
  };
  const event = {
    preventDefault() {},
    target: {
      closest(selector) {
        return selector === '[data-choose-custom-collection-artwork]' ? button : null;
      },
    },
  };

  await context.handleUtilityBootstrapClick(event);

  assert.equal(clicked, 1);
});

test('collection image input saves only the selected file for its collection', async () => {
  const { context, saves } = loadContext();
  const file = { name: 'night.png', type: 'image/png' };
  const input = {
    files: [file],
    value: 'selected',
    getAttribute(name) {
      return name === 'data-custom-collection-artwork-input' ? 'Night' : '';
    },
  };
  const event = {
    target: {
      closest(selector) {
        return selector === '[data-custom-collection-artwork-input]' ? input : null;
      },
    },
  };

  context.handleUtilityBootstrapChange(event);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(saves, [{ name: 'Night', file }]);
  assert.equal(input.value, '');
});

test('collection artwork delete reuses confirmation and deletes the collection row', async () => {
  const fixture = loadContext();
  const deleteButton = {};
  await fixture.context.handleUtilityBootstrapClick({
    preventDefault() {},
    target: { closest: selector => (selector === '[data-delete-custom-collection-artwork]' ? deleteButton : null) },
  });
  assert.deepEqual(fixture.confirmations, ['custom-collection']);

  fixture.context.state.coverLookup.modal.collectionName = 'Night';
  await fixture.context.handleUtilityBootstrapClick({
    preventDefault() {},
    target: { closest: selector => (selector === '[data-confirm-cover-lookup-delete="1"]' ? {} : null) },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.deletes, 1);
});
