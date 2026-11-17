const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const runtime = path.join(__dirname, '../../../music_app/static/js/runtime');

test('the mounted Edit Tags footer keeps the Apply button the runtime enables', () => {
  const bootstrap = fs.readFileSync(path.join(runtime, 'bootstrap-init.js'), 'utf8');
  const mount = bootstrap.match(/const tagEditorFooter = [\s\S]*?\r?\n}\r?\n/)?.[0];
  assert.ok(mount, 'bootstrap mounts the Edit Tags footer');
  const footer = { innerHTML: '', querySelector: () => ({ prepend() {} }), addEventListener() {} };
  const context = vm.createContext({
    EditorPage: require('../../../music_app/static/js/editor-page.js'),
    document: { getElementById: (id) => (id === 'tag-editor-footer' ? footer : null) },
  });
  vm.runInContext(mount, context);

  const helpers = fs.readFileSync(path.join(runtime, 'modal-and-overlay-helpers.js'), 'utf8');
  const lookup = helpers.match(/applyButton: document\.getElementById\('([^']+)'\)/)?.[1];
  assert.equal(lookup, 'tag-editor-apply');
  const apply = footer.innerHTML.match(new RegExp(`<button[^>]*\\sid="${lookup}"[^>]*>`))?.[0];
  assert.ok(apply, 'the rendered Apply carries the id the runtime looks up');
  assert.match(apply, /data-open-tag-edit-confirm="1"/);
  assert.match(apply, /\sdisabled[\s>]/);
});
