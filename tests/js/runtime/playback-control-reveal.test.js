const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = path.join(__dirname, '../../../music_app/static/js/runtime/loop-range-controls.js');

function harness({ active = false, canCreate = true, touch = false } = {}) {
  let now = 0, nextId = 0;
  const timers = new Map();
  const document = { activeElement: null };
  function node(attributes = {}) {
    const listeners = new Map();
    const classes = new Set();
    const element = {
      attributes: { ...attributes }, listeners, children: [], hidden: false, disabled: false,
      ownerDocument: document, style: { setProperty() {} }, hovered: false,
      classList: { toggle(name, value) { if (value) classes.add(name); else classes.delete(name); }, contains(name) { return classes.has(name); } },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getAttribute(name) { return this.attributes[name] ?? null; },
      removeAttribute(name) { delete this.attributes[name]; },
      addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
      removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
      contains(child) { return child === this || this.children.some(item => item.contains(child)); },
      matches(selector) { return selector === ':hover' ? this.hovered : false; },
      closest() { return compound; },
      focus() { document.activeElement = this; },
      dispatch(name, extra = {}) {
        if (name === 'pointerenter') this.hovered = true;
        if (name === 'pointerleave') this.hovered = false;
        const event = { type: name, target: this, currentTarget: this, pointerType: 'mouse', button: 0, relatedTarget: null, preventDefault() {}, ...extra };
        for (const fn of [...(listeners.get(name) || [])]) fn(event);
      },
    };
    return element;
  }
  const compound = node({ 'data-playback-control-cluster': '' });
  Object.assign(document, node());
  document.activeElement = null;
  const play = node({ 'data-playback-control-action': 'play-pause' });
  const root = node({ 'data-loop-action-state': 'idle' });
  const enter = node({ 'data-loop-action': 'enter', 'aria-label': 'Create loop' });
  const create = node({ 'data-loop-action': 'create', 'aria-label': 'Save loop' });
  const cancel = node({ 'data-loop-action': 'cancel', 'aria-label': 'Cancel loop' });
  const expanded = node({ 'data-loop-action-expanded': '' });
  root.children = [enter, expanded]; expanded.children = [create, cancel]; compound.children = [play, root];
  root.querySelector = selector => ({ '[data-loop-action="enter"]': enter, '[data-loop-action="create"]': create, '[data-loop-action="cancel"]': cancel, '[data-loop-action-expanded]': expanded }[selector] || null);
  compound.querySelector = selector => selector === '[data-playback-control-action="play-pause"]' ? play : root.querySelector(selector);
  const context = {
    console, document, performance: { now: () => now },
    setTimeout(fn, delay) { const id = ++nextId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    matchMedia: () => ({ matches: touch, addEventListener() {}, removeEventListener() {} }),
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  const range = { startSeconds: 13, endSeconds: 29 };
  const calls = [];
  let controller;
  controller = context.mountLoopEditActionControl({
    root, interactionRoot: compound, active, enabled: true, canCreate,
    onEnter() { calls.push('enter'); controller.update({ active: true }); },
    onCreate() { calls.push('create'); },
    onCancel() { calls.push('cancel'); range.startSeconds = 0; range.endSeconds = 0; controller.update({ active: false }); },
  });
  const tick = elapsed => {
    const end = now + elapsed;
    while (true) {
      const due = [...timers.entries()].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at; timers.delete(due[0]); due[1].fn();
    }
    now = end;
  };
  const revealed = () => root.getAttribute('data-loop-action-engaged') === 'true';
  return { root, compound, play, enter, create, cancel, document, controller, calls, range, tick, timers, revealed };
}

test('B04 Play perimeter reveals idle actions at exactly 300 ms', () => {
  const h = harness();
  assert.equal(h.revealed(), false);
  h.compound.dispatch('pointerenter', { target: h.play });
  h.tick(299); assert.equal(h.revealed(), false);
  h.tick(1); assert.equal(h.revealed(), true);
  assert.equal(h.play.disabled, false);
});

test('B04 early exit cancels reveal and the next visit starts a fresh delay', () => {
  const h = harness();
  h.compound.dispatch('pointerenter'); h.tick(299);
  h.compound.dispatch('pointerleave'); h.tick(1000);
  assert.equal(h.revealed(), false); assert.equal(h.timers.size, 0);
  h.compound.dispatch('pointerenter'); h.tick(299); assert.equal(h.revealed(), false);
  h.tick(1); assert.equal(h.revealed(), true);
});

test('B04 revealed idle actions hide immediately on exit', () => {
  const h = harness(); h.compound.dispatch('pointerenter'); h.tick(300);
  assert.equal(h.revealed(), true);
  h.compound.dispatch('pointerleave'); assert.equal(h.revealed(), false);
  assert.equal(h.timers.size, 0);
});

test('B05 editing folds at exactly 500 ms without cancelling range or playback', () => {
  const h = harness({ active: true });
  h.compound.dispatch('pointerenter'); assert.equal(h.revealed(), true);
  h.compound.dispatch('pointerleave'); h.tick(499); assert.equal(h.revealed(), true);
  h.tick(1); assert.equal(h.revealed(), false);
  assert.equal(h.root.getAttribute('data-loop-action-state'), 'editing');
  assert.deepEqual(h.range, { startSeconds: 13, endSeconds: 29 }); assert.deepEqual(h.calls, []);
  assert.equal(h.play.disabled, false);
  h.compound.dispatch('pointerenter'); assert.equal(h.revealed(), true);
});

test('B05 returning during the grace period cancels folding without timer drift', () => {
  const h = harness({ active: true }); h.compound.dispatch('pointerenter'); h.compound.dispatch('pointerleave');
  h.tick(499); h.compound.dispatch('pointerenter'); h.tick(1000);
  assert.equal(h.revealed(), true); assert.equal(h.timers.size, 0);
});

test('B04 movement from Play to actions inside the compound does not restart reveal', () => {
  const h = harness(); h.compound.dispatch('pointerenter', { target: h.play }); h.tick(200);
  h.compound.dispatch('pointerout', { target: h.play, relatedTarget: h.enter });
  h.compound.dispatch('pointerover', { target: h.enter, relatedTarget: h.play });
  h.tick(100); assert.equal(h.revealed(), true);
  assert.strictEqual(h.compound.children[0], h.play);
});

test('B06 mouse focus cannot pin editing actions after the fold deadline', () => {
  const h = harness({ active: true }); h.compound.dispatch('pointerenter');
  assert.equal(h.revealed(), true, 'editing controls must be revealed before testing whether focus pins them');
  h.compound.dispatch('pointerdown', { target: h.create }); h.create.focus(); h.compound.dispatch('focusin', { target: h.create });
  h.compound.dispatch('pointerleave'); h.tick(500); assert.equal(h.revealed(), false);
});

test('B06 a completed save disposes the old fold timer before a new idle visit', () => {
  const h = harness({ active: true }); h.compound.dispatch('pointerenter'); h.compound.dispatch('pointerleave');
  h.controller.update({ active: false });
  assert.equal(h.timers.size, 0);
  h.compound.dispatch('pointerenter'); h.tick(299); assert.equal(h.revealed(), false);
  h.tick(1); assert.equal(h.revealed(), true);
});

test('B06 keyboard focus reveals controls and retains them while focus is inside', () => {
  const h = harness({ active: true });
  h.document.dispatch('keydown', { key: 'Tab' }); h.compound.dispatch('keydown', { key: 'Tab' });
  h.play.focus(); h.compound.dispatch('focusin', { target: h.play }); assert.equal(h.revealed(), true);
  h.compound.dispatch('pointerleave'); h.tick(1000); assert.equal(h.revealed(), true);
  h.document.activeElement = null; h.compound.dispatch('focusout'); h.tick(500); assert.equal(h.revealed(), false);
});

test('B06 authorized touch input has directly usable controls without a hover timer', () => {
  const h = harness({ touch: true });
  assert.equal(h.revealed(), true);
  h.enter.dispatch('click'); assert.deepEqual(h.calls, ['enter']);
  h.compound.dispatch('pointerleave', { pointerType: 'touch' }); h.tick(1000);
  assert.equal(h.revealed(), true); assert.equal(h.cancel.disabled, false);
});

for (const active of [false, true]) {
  test(`B06 disposal cancels ${active ? 'fold' : 'reveal'} timers and removes compound listeners`, () => {
    const h = harness({ active }); h.compound.dispatch('pointerenter');
    if (active) h.compound.dispatch('pointerleave');
    assert.ok(h.timers.size > 0);
    h.controller.destroy(); assert.equal(h.timers.size, 0);
    assert.equal([...h.compound.listeners.values()].reduce((sum, items) => sum + items.size, 0), 0);
    const state = h.root.getAttribute('data-loop-action-engaged'); h.tick(1000);
    h.compound.dispatch('pointerenter'); assert.equal(h.root.getAttribute('data-loop-action-engaged'), state);
  });
}

test('B06 capability loss hides actions and cancels pending work while Play stays usable', () => {
  const h = harness(); h.compound.dispatch('pointerenter'); h.tick(100);
  h.controller.update({ canCreate: false }); h.tick(1000);
  assert.equal(h.root.hidden, true); assert.equal(h.revealed(), false); assert.equal(h.timers.size, 0);
  h.enter.dispatch('click'); assert.deepEqual(h.calls, []); assert.equal(h.play.disabled, false);
  h.controller.update({ canCreate: true }); assert.equal(h.root.hidden, false);
});

test('B06 real callbacks remain retryable after busy save failure, and cancel resets the edit', () => {
  const h = harness(); h.compound.dispatch('pointerenter'); h.tick(300); h.enter.dispatch('click');
  assert.deepEqual(h.calls, ['enter']);
  h.controller.update({ busy: true }); h.create.dispatch('click'); h.cancel.dispatch('click');
  assert.deepEqual(h.calls, ['enter']); assert.equal(h.play.disabled, false);
  h.controller.update({ busy: false }); h.create.dispatch('click'); h.create.dispatch('click');
  assert.deepEqual(h.calls, ['enter', 'create', 'create']);
  h.compound.dispatch('pointerleave'); h.cancel.dispatch('click'); h.tick(500);
  assert.equal(h.root.getAttribute('data-loop-action-state'), 'idle'); assert.equal(h.timers.size, 0);
  assert.deepEqual(h.calls, ['enter', 'create', 'create', 'cancel']);
});

test('B06 changing song identity cancels an idle reveal owned by the previous song', () => {
  const h = harness();
  h.compound.dispatch('pointerenter');
  h.tick(299);
  h.controller.update({ contextKey: 'next-song', active: false });
  h.tick(1);
  assert.equal(h.revealed(), false);
  assert.equal(h.timers.size, 0);
  h.tick(1000);
  assert.equal(h.revealed(), false);
});
