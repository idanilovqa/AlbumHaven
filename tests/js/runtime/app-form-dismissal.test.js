const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const flush = () => new Promise(setImmediate);

function setup() {
  const nodes = new Map(), focus = [];
  const document = {getElementById: id => nodes.get(id), createElement: () => node(), addEventListener() {}, removeEventListener() {}};
  function node() {
    const attributes = new Map(), listeners = new Map(), classes = new Set();
    return {hidden: false, disabled: false, inert: false, isConnected: true, style: {}, children: [], listeners,
      classList: {add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name), toggle() {}},
      setAttribute: (name, value) => attributes.set(name, value), getAttribute: name => attributes.get(name) ?? null,
      removeAttribute: name => attributes.delete(name), addEventListener: (name, fn) => listeners.set(name, fn),
      removeEventListener: name => listeners.delete(name), closest: () => null, querySelector: () => null, querySelectorAll: () => [],
      appendChild(child) {this.children.push(child);}, set innerHTML(_value) {this.children = [];},
      focus() {document.activeElement = this; focus.push(this);}};
  }
  for (const prefix of ['app-form', 'app-confirm']) {
    for (const suffix of ['modal', 'title', 'content', 'error', 'text', 'cancel', 'submit', 'accept']) nodes.set(`${prefix}-${suffix}`, node());
    nodes.get(`${prefix}-modal`).hidden = true;
  }
  document.body = node(); document.activeElement = node(); const trigger = document.activeElement;
  const context = vm.createContext({document, window: {}, Promise,
    bindOverlayPointerOrigin() {}, overlayClickStartedOnOverlay: (_modal, event) => event.backdrop === true});
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime/browser-dialog-helpers.js'), 'utf8'), context);
  const fire = (id, type, detail = {}) => nodes.get(id).listeners.get(type)?.({preventDefault() {}, stopPropagation() {}, ...detail});
  return {context, document, nodes, focus, trigger, node, fire};
}

for (const [reason, dismiss] of [
  ['cancel', h => h.fire('app-form-cancel', 'click')],
  ['escape', h => h.fire('app-form-modal', 'keydown', {key: 'Escape'})],
  ['overlay', h => h.fire('app-form-modal', 'click', {backdrop: true})],
]) test(`${reason} asks the same native owner and a veto preserves the draft`, async () => {
  const h = setup(); let owner, resolve, calls = 0;
  const pending = h.context.showAppFormDialog({beforeDismiss(value) {assert.equal(value, reason); calls++; return new Promise(done => {resolve = done;});},
    onMount(_host, controls) {owner = controls;}});
  const first = dismiss(h), second = dismiss(h);
  assert.strictEqual(first, second);
  assert.equal(h.nodes.get('app-form-cancel').disabled, true);
  assert.equal(h.nodes.get('app-form-submit').disabled, true);
  await flush(); assert.equal(calls, 1);
  resolve(false); assert.equal(await first, false);
  assert.equal(h.nodes.get('app-form-modal').hidden, false);
  assert.equal(h.nodes.get('app-form-content').inert, false);
  assert.equal(h.nodes.get('app-form-cancel').disabled, false);
  owner.close(null, {force: true}); assert.equal(await pending, null);
});

test('only exact true approves dismissal; rejection leaves the owner usable', async () => {
  for (const decision of [() => 1, () => 'true', () => undefined, () => false, () => Promise.reject(new Error('confirmation unavailable'))]) {
    const h = setup(); let owner;
    const result = h.context.showAppFormDialog({beforeDismiss: decision, onMount(_host, controls) {owner = controls;}});
    assert.equal(await owner.dismiss('discard'), false);
    assert.equal(h.nodes.get('app-form-modal').hidden, false);
    owner.close(null, {force: true}); await result;
  }
});

test('forced disposal cancels its native confirmation and stale completion cannot close a replacement', async () => {
  const h = setup(); let owner, calls = 0;
  const old = h.context.showAppFormDialog({beforeDismiss: () => h.context.showAppConfirmDialog({message: 'Discard?'}),
    onMount(_host, controls) {owner = controls;}, onClose() {calls++;}});
  const dismissing = owner.dismiss('discard'); await flush();
  assert.equal(h.nodes.get('app-confirm-modal').hidden, false);
  const routeFocus = h.node(); routeFocus.focus();
  owner.close(null, {force: true, restoreFocus: false}); await old;
  assert.equal(h.nodes.get('app-confirm-modal').hidden, true);
  assert.equal(await dismissing, false); assert.equal(calls, 1);
  assert.strictEqual(h.document.activeElement, routeFocus);
  const replacement = h.context.openReactFormDialog({title: 'New form'});
  owner.close(null, {force: true});
  assert.equal(h.nodes.get('app-form-modal').hidden, false);
  replacement.close(); await replacement.promise;
});

test('forced disposal before callback delivery never opens a late confirmation', async () => {
  const h = setup(); let owner, prompts = 0;
  const result = h.context.showAppFormDialog({beforeDismiss() {prompts++; return true;}, onMount(_host, controls) {owner = controls;}});
  const dismissing = owner.dismiss('back');
  owner.close(null, {force: true, restoreFocus: false}); await result;
  assert.equal(await dismissing, false); assert.equal(prompts, 0);
});

test('a form submission cannot start during confirmation, and an accepted dismissal closes once', async () => {
  const h = setup(); let owner, accept, writes = 0, closes = 0;
  const result = h.context.showAppFormDialog({beforeDismiss: () => new Promise(resolve => {accept = resolve;}),
    onSubmit() {writes++;}, onClose() {closes++;}, onMount(_host, controls) {owner = controls;}});
  const dismissing = owner.dismiss('discard'); await flush();
  await h.fire('app-form-submit', 'click'); assert.equal(writes, 0);
  accept(true); assert.equal(await dismissing, true); await result;
  owner.close(null, {force: true}); assert.equal(closes, 1);
  assert.strictEqual(h.document.activeElement, h.trigger);
});

test('ordinary forms keep their synchronous close contract and React forwards opt-in options', async () => {
  const h = setup(); let prompts = 0;
  const owner = h.context.openReactFormDialog({pageId: 'create-playlist', beforeDismiss() {prompts++; return false;}});
  assert.equal(h.context.getActiveAppFormPage().pageId, 'create-playlist');
  assert.equal(await owner.dismiss('cancel'), false); assert.equal(prompts, 1);
  owner.close(null, {force: true}); await owner.promise;
  const ordinary = h.context.openReactFormDialog(); ordinary.close();
  assert.equal(h.nodes.get('app-form-modal').hidden, true); await ordinary.promise;
});

test('the shared capture Escape handler preserves the opt-in dismissal reason', async () => {
  const h = setup(); let accept, reason;
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime/track-modal-lightbox-helpers.js'), 'utf8'), h.context);
  const modal = h.nodes.get('app-form-modal'); modal.id = 'app-form-modal';
  h.context.getTopmostOpenModal = () => modal;
  const owner = h.context.openReactFormDialog({pageId: 'create-playlist', beforeDismiss(value) {reason = value; return new Promise(resolve => {accept = resolve;});}});
  h.context.handleModalEscapeKeydown({key: 'Escape', preventDefault() {}, stopImmediatePropagation() {}});
  await flush(); assert.equal(reason, 'escape');
  accept(true); await owner.promise; assert.equal(modal.hidden, true);
});
