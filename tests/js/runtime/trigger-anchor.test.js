const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/runtime/trigger-anchor.js'), 'utf8'), context);
test('connector follows the actual trigger position within a clamped popup', () => {
  const geometry = context.getTriggerAnchorGeometry({ left: 250, right: 284, top: 10, bottom: 44, width: 34 }, { left: 30, right: 300, top: 54, bottom: 200 });
  assert.equal(geometry.left, 220);
  assert.equal(geometry.right, 16);
  assert.equal(geometry.gap, 10);
  assert.equal(geometry.edge, 'top');
});
test('upward dropdown joins its bottom edge to the trigger', () => {
  const geometry = context.getTriggerAnchorGeometry({ left: 100, right: 134, top: 300, bottom: 334, width: 34 }, { left: 20, right: 200, top: 100, bottom: 292 });
  assert.equal(geometry.edge, 'bottom');
  assert.equal(geometry.gap, 8);
});

test('closing and reanchoring restore the previous trigger', () => {
  const element = (rect) => {
    const classes = new Set();
    return { hidden: false, dataset: {}, style: { setProperty() {} }, classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) }, getBoundingClientRect: () => rect };
  };
  const surface = element({ left: 0, right: 200, top: 50, bottom: 250 });
  const first = element({ left: 100, right: 134, top: 10, bottom: 44, width: 34 });
  const second = element({ left: 140, right: 174, top: 10, bottom: 44, width: 34 });
  context.syncTriggerAnchor(surface, first);
  assert.equal(first.classList.contains('trigger-anchor-open'), true);
  context.syncTriggerAnchor(surface, second);
  assert.equal(first.classList.contains('trigger-anchor-open'), false);
  assert.equal(second.classList.contains('trigger-anchor-open'), true);
  context.clearTriggerAnchor(surface);
  assert.equal(second.classList.contains('trigger-anchor-open'), false);
});

test('connector tracks sibling-driven trigger movement during expansion and stops observing on close', () => {
  let onResize;
  let disconnected = false;
  const observed = [];
  const local = vm.createContext({ ResizeObserver: class {
    constructor(callback) { onResize = callback; }
    observe(node) { observed.push(node); }
    disconnect() { disconnected = true; }
  } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/runtime/trigger-anchor.js'), 'utf8'), local);
  const props = new Map();
  let left = 250;
  const classes = () => ({ add() {}, remove() {} });
  const anchor = { parentElement: {}, dataset: {}, classList: classes(), style: { setProperty() {} }, getBoundingClientRect: () => ({ left, right: left + 34, top: 10, bottom: 44, width: 34 }) };
  const surface = { hidden: false, dataset: {}, classList: classes(), style: { setProperty: (key, value) => props.set(key, value) }, getBoundingClientRect: () => ({ left: 0, right: 400, top: 54, bottom: 250 }) };
  local.syncTriggerAnchor(surface, anchor);
  assert.ok(observed.includes(anchor.parentElement), 'observe the action group whose width moves its trigger');
  for (const x of [242, 234, 218, 250]) {
    left = x;
    onResize();
    assert.equal(props.get('--trigger-anchor-left'), `${x}px`);
    assert.equal(props.get('--trigger-anchor-right'), `${400 - x - 34}px`);
  }
  local.clearTriggerAnchor(surface);
  assert.equal(disconnected, true);
});

test('vertical continuation follows either popup edge and avoids a detached middle accent', () => {
  const surface = { left: 0, right: 300, top: 50, bottom: 250 };
  const anchor = left => ({ left, right: left + 34, width: 34, top: 10, bottom: 44 });
  assert.equal(context.getTriggerAnchorGeometry(anchor(0), surface).side, 'left');
  assert.equal(context.getTriggerAnchorGeometry(anchor(266), surface).side, 'right');
  assert.equal(context.getTriggerAnchorGeometry(anchor(120), surface).side, 'none');
});

test('shared popup ownership closes the previous surface before opening another', () => {
  const events = [];
  const first = {};
  const second = {};
  context.activateTriggerSurface(first, () => events.push('first closed'));
  context.activateTriggerSurface(second, () => events.push('second closed'));
  assert.deepEqual(events, ['first closed']);
  context.activateTriggerSurface(second, () => events.push('replacement'));
  assert.deepEqual(events, ['first closed'], 'repositioning the same popup must not dismiss it');
});

test('text selection extending beyond its originating panel is clamped to the panel boundary', () => {
  const inside = {};
  const outside = {};
  const start = {};
  const end = {};
  const updates = [];
  const surface = { contains: node => node === inside, ownerDocument: { createRange: () => ({ selectNodeContents() {}, comparePoint: () => 1, startContainer: start, startOffset: 0, endContainer: end, endOffset: 4 }) } };
  const selection = { anchorNode: inside, anchorOffset: 2, focusNode: outside, focusOffset: 1, setBaseAndExtent: (...args) => updates.push(args) };
  context.confinePanelTextSelection(selection, surface);
  assert.deepEqual(updates, [[inside, 2, end, 4]]);
  selection.focusNode = inside;
  context.confinePanelTextSelection(selection, surface);
  assert.equal(updates.length, 1, 'ordinary selection inside the panel remains native');
});
