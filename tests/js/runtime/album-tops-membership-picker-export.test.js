const test = require('node:test');
const assert = require('node:assert/strict');
const {load, nativeEnvironment, service, preparedController, detail, connectedView} = require('./album-tops-native-fixtures/actual-native-runtime.cjs');

test('the native AlbumPicker, builder and inline editor exports retain mountable ownership', async t => {
  const exports = await load('album-tops/builder.mjs');
  assert.equal(typeof exports.mountAlbumPicker, 'function', 'Missing native AlbumPicker export: this is a mount-seam gate, not capacity UI evidence');
  assert.equal(typeof exports.openAlbumTopBuilder, 'function');
  assert.equal(typeof exports.mountInlineAlbumTopEdit, 'function');

  // Mount the picker with the real detached draft and canonical controls.
  const pickerEnv = nativeEnvironment(), pickerBackend = service();
  const pickerController = await preparedController(pickerBackend, {selected: null});
  const {createAlbumTopDraft} = await load('album-tops/draft.mjs');
  const draft = createAlbumTopDraft({controller: pickerController, providers: pickerBackend.providers});
  const pickerProps = () => ({draft, value: draft.getSnapshot(), disabled: false});
  const picker = exports.mountAlbumPicker(pickerEnv.host, pickerEnv.runtime, pickerProps());
  t.after(() => {picker.dispose(); draft.dispose(); pickerController.dispose(); pickerEnv.assertClean();});
  assert.equal(typeof picker.update, 'function'); assert.equal(typeof picker.dispose, 'function');
  assert.ok(pickerEnv.host.querySelector('[aria-label="Choose albums"]'));
  assert.ok(pickerEnv.host.querySelector('input[type="search"]'));
  picker.update(pickerProps()); picker.dispose();
  assert.equal(pickerEnv.host.childNodes.length, 0);

  // Open the actual editor through the canonical native form dialog.
  const builderEnv = nativeEnvironment(), builderBackend = service();
  const builderController = await preparedController(builderBackend, {selected: null});
  const builder = exports.openAlbumTopBuilder({runtime: builderEnv.runtime, controller: builderController,
    providers: builderBackend.providers, state: builderController.getSnapshot(), fallbackHost: builderEnv.host,
    onClose() {}});
  t.after(() => {builder.dispose(); builderController.dispose(); builderEnv.assertClean();});
  assert.equal(typeof builder.update, 'function'); assert.equal(typeof builder.dispose, 'function');
  assert.ok(builderEnv.content().querySelector('form[aria-label="Create Album Top"]'));
  builder.update({state: builderController.getSnapshot()}); builder.dispose();
  assert.equal(builderEnv.content().childNodes.length, 0);
  assert.equal(builderEnv.modal().hidden, true);

  // Exercise the inline export through its actual app caller, which supplies
  // the real shared header, rather than fabricating a successful header owner.
  const inlineEnv = nativeEnvironment(), inlineBackend = service();
  inlineBackend.data.detail = detail({edit_draft: {items: [], publication_preview_required: false}});
  const inlineController = await preparedController(inlineBackend);
  const composition = await connectedView(inlineEnv, inlineBackend, inlineController);
  t.after(() => {composition.dispose(); inlineEnv.assertClean();});
  inlineEnv.click(inlineEnv.button(inlineEnv.host, 'Edit Album Top'));
  assert.ok(inlineEnv.host.querySelector('form.album-top-inline-edit[aria-label="Edit Album Top"]'));
  assert.ok(inlineEnv.host.querySelector('input[aria-label="Album Top name"]'));
  // This seam fixture deliberately has no navigation owner. Native editing
  // must remain fail-closed; the mount gate must not fake a successful guard.
  assert.match(inlineEnv.host.textContent, /navigation protection could not be started/i);
  assert.equal(inlineEnv.host.querySelector('input[aria-label="Album Top name"]').disabled, true);
  composition.update({}); composition.dispose();
  assert.equal(inlineEnv.host.childNodes.length, 0);
  assert.equal(pickerBackend.count('execute') + builderBackend.count('execute') + inlineBackend.count('execute'), 0);
});
