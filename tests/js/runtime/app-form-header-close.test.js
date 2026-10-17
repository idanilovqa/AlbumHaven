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
    for (const suffix of ['modal', 'title', 'content', 'error', 'text', 'cancel', 'submit', 'accept', 'close']) nodes.set(`${prefix}-${suffix}`, node());
    nodes.get(`${prefix}-modal`).hidden = true;
  }
  document.body = node(); document.activeElement = node(); const trigger = document.activeElement;
  const context = vm.createContext({document, window: {}, Promise,
    bindOverlayPointerOrigin() {}, overlayClickStartedOnOverlay: (_modal, event) => event.backdrop === true});
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime/browser-dialog-helpers.js'), 'utf8'), context);
  const fire = (id, type, detail = {}) => nodes.get(id).listeners.get(type)?.({preventDefault() {}, stopPropagation() {}, ...detail});
  return {context, document, nodes, focus, trigger, node, fire};
}

test('opt-in native header close uses the same veto and restores trigger focus', async () => {
  const h = setup(); let approve = false, calls = 0, controls;
  const result = h.context.showAppFormDialog({showCloseButton: true, beforeDismiss(reason) {
    calls++; assert.equal(reason, 'cancel'); return approve;
  }, onMount(_host, owner) {controls = owner;}});
  const close = h.nodes.get('app-form-close');
  assert.equal(close.hidden, false); assert.equal(close.disabled, false);
  assert.equal(await h.fire('app-form-close', 'click'), false);
  assert.equal(h.nodes.get('app-form-modal').hidden, false);
  approve = true; assert.equal(await h.fire('app-form-close', 'click'), true);
  assert.equal(await result, null); assert.equal(calls, 2);
  assert.equal(close.hidden, true); assert.equal(close.listeners.has('click'), false);
  assert.strictEqual(h.document.activeElement, h.trigger);
  controls.close(null, {force: true});
});

test('busy header, Escape and footer dismissal stay disabled but forced retirement remains possible', async () => {
  const h = setup(); let calls = 0;
  const dialog = h.context.openReactFormDialog({showCloseButton: true, dismissDisabled: true,
    beforeDismiss() {calls++; return true;}});
  assert.equal(h.nodes.get('app-form-close').disabled, true);
  h.fire('app-form-close', 'click');
  assert.equal(await h.fire('app-form-modal', 'keydown', {key: 'Escape'}), false);
  assert.equal(await dialog.dismiss('cancel'), false); assert.equal(calls, 0);
  assert.equal(h.nodes.get('app-form-modal').hidden, false);
  dialog.setDismissDisabled(false); assert.equal(h.nodes.get('app-form-close').disabled, false);
  dialog.setDismissDisabled(true);
  const successorFocus = h.node(); successorFocus.focus();
  dialog.close(null, {force: true, restoreFocus: false}); await dialog.promise;
  assert.equal(h.nodes.get('app-form-modal').hidden, true);
  assert.strictEqual(h.document.activeElement, successorFocus);
  const ordinary = h.context.showAppFormDialog();
  assert.equal(h.nodes.get('app-form-close').hidden, true);
  dialog.setDismissDisabled(true);
  assert.equal(h.nodes.get('app-form-cancel').disabled, false, 'retired owner cannot disable replacement');
  h.fire('app-form-cancel', 'click'); await ordinary;
});

test('native header close participates in portal keyboard focus cycle', async () => {
  const h = setup(), first = h.node(), last = h.node();
  h.nodes.get('app-form-content').querySelectorAll = () => [first, last];
  const dialog = h.context.openReactFormDialog({showCloseButton: true});
  const close = h.nodes.get('app-form-close');
  assert.strictEqual(h.document.activeElement, first, 'initial focus still prefers content');
  last.focus(); h.fire('app-form-modal', 'keydown', {key: 'Tab'});
  assert.strictEqual(h.document.activeElement, close);
  h.fire('app-form-modal', 'keydown', {key: 'Tab', shiftKey: true});
  assert.strictEqual(h.document.activeElement, last);
  await h.fire('app-form-close', 'click'); await dialog.promise;
});

test('header close stays disabled during pending native confirmation and cannot duplicate it', async () => {
  const h = setup(); let finish, calls = 0;
  const result = h.context.showAppFormDialog({showCloseButton: true,
    beforeDismiss() {calls++; return new Promise(resolve => {finish = resolve;});}});
  const pending = h.fire('app-form-close', 'click'); await flush();
  assert.equal(h.nodes.get('app-form-close').disabled, true);
  h.fire('app-form-close', 'click'); assert.equal(calls, 1);
  finish(true); await pending; await result;
  assert.equal(h.nodes.get('app-form-close').hidden, true);
});

test('presentation updates preserve busy close ownership and retired methods cannot touch successor', async () => {
  const h = setup();
  const dialog = h.context.openReactFormDialog({title: 'Sharing', pageId: 'playlist-sharing',
    showCloseButton: true, dismissDisabled: true});
  assert.equal(dialog.updatePresentation({title: 'Sharing updated', pageId: 'playlist-sharing-updated'}), true);
  assert.equal(h.nodes.get('app-form-title').textContent, 'Sharing updated');
  assert.equal(h.nodes.get('app-form-close').hidden, false);
  assert.equal(h.nodes.get('app-form-close').disabled, true);
  assert.equal(await dialog.dismiss('cancel'), false);
  dialog.setDismissDisabled(false);
  await h.fire('app-form-close', 'click'); await dialog.promise;
  const successor = h.context.openReactFormDialog({title: 'Next form', pageId: 'next-form'});
  assert.equal(dialog.updatePresentation({title: 'Obsolete', pageId: 'obsolete'}), false);
  dialog.setDismissDisabled(true);
  assert.equal(h.nodes.get('app-form-title').textContent, 'Next form');
  assert.equal(h.nodes.get('app-form-cancel').disabled, false);
  successor.close(null, {force: true}); await successor.promise;
});
