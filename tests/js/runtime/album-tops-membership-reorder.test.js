const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const F = require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
const {createNativeHomeRuntime} = require(path.join(F.ROOT, 'tests/js/runtime/native-home-harness.cjs'));
let mountCollectionReorder;
test.before(async () => {({mountCollectionReorder} = await F.load('playlists/reorder.mjs'));});

// Independent bounded DOM capabilities; real owning gesture implementation only.
function fixture(t) {
  const env = createNativeHomeRuntime(), doc = env.document, host = doc.createElement('main'), win = doc.createElement('window');
  doc.body.appendChild(host); doc.defaultView = win; doc.scrollingElement = doc.documentElement;
  const frames = new Map(), observers = new Set(), captured = new Set(), commands = [], announcements = []; let serial = 0;
  Object.assign(win, {innerWidth: 800, innerHeight: 600, getComputedStyle: () => ({overflowY: 'visible'}),
    requestAnimationFrame(fn) {const id = ++serial; frames.set(id, fn); return id;}, cancelAnimationFrame(id) {frames.delete(id);},
    MutationObserver: class {constructor(fn) {this.fn = fn;} observe() {observers.add(this);} disconnect() {observers.delete(this);}}});
  Object.assign(doc.documentElement, {scrollHeight: 600, clientHeight: 600, scrollTop: 0});
  Object.assign(host, {scrollHeight: 260, clientHeight: 260, setPointerCapture: id => captured.add(id), releasePointerCapture: id => captured.delete(id)});
  const Element = host.constructor;
  Element.prototype.focus = function () {if (this.isConnected && !this.disabled) doc.activeElement = this;};
  Element.prototype.scrollIntoView = function () {};
  Element.prototype.cloneNode = function (deep) {const copy = doc.createElement(this.tagName); for (const {name, value} of this.attributes) copy.setAttribute(name, value);
    if (deep) for (const node of this.childNodes) copy.appendChild(node.nodeType === 3 ? doc.createTextNode(node.textContent) : node.cloneNode(true)); return copy;};
  Element.prototype.getBoundingClientRect = function () {
    const index = host.querySelectorAll('[data-album-draft-key]').indexOf(this), left = index < 0 ? 20 : 20 + (index % 2) * 120, top = index < 0 ? 20 : 20 + Math.floor(index / 2) * 120;
    return {left, right: left + (index < 0 ? 240 : 100), top, bottom: top + (index < 0 ? 240 : 100), width: index < 0 ? 240 : 100, height: index < 0 ? 240 : 100};
  };
  let state = {scopeKey: F.SCOPE, draftKey: 'volatile-top', source: {}, selectedRowKey: null,
    itemsComplete: true, canEdit: true, canReorder: true, unfiltered: true, defaultOrder: true, busy: false,
    rows: ['a', 'b', 'c', 'd'].map(key => ({row_key: key, album_ref: key}))};
  function render() {const grid = doc.createElement('section'); for (const item of state.rows) {const row = doc.createElement('article'); row.setAttribute('data-album-draft-key', item.row_key);
    const button = doc.createElement('button'); button.setAttribute('data-album-draft-move', ''); button.setAttribute('aria-label', `Reorder ${item.row_key}`); row.appendChild(button); grid.appendChild(row);} host.replaceChildren(grid);}
  render();
  const adapter = mountCollectionReorder(host, {snapshot: () => state, rowSelector: '[data-album-draft-key]', handleSelector: '[data-album-draft-move]', rowKeyAttribute: 'data-album-draft-key', layout: 'grid',
    collectionKey: value => value.draftKey, itemKey: row => row.album_ref, onAnnounce: text => announcements.push(text),
    onReorder: order => {commands.push([...order]); state = {...state, rows: order.map(key => state.rows.find(row => row.album_ref === key))}; render(); return true;}});
  const handle = key => host.querySelectorAll('[data-album-draft-key]').find(node => node.getAttribute('data-album-draft-key') === key)?.firstElementChild;
  const emit = (target, type, patch = {}) => {const event = new env.context.Event(type); Object.assign(event, {button: 0, isPrimary: true, pointerId: 7, clientX: 70, clientY: 70}, patch); target.dispatchEvent(event); return event;};
  const frame = () => {const waiting = [...frames.values()]; frames.clear(); waiting.forEach(fn => fn(16));};
  t.after(() => {adapter.dispose(); assert.equal(frames.size, 0); assert.equal(observers.size, 0); assert.equal(captured.size, 0); assert.equal(doc.listeners.length, 0); assert.equal(win.listeners.length, 0); assert.equal(host.listeners.length, 0);});
  return {host, doc, win, adapter, commands, announcements, emit, handle, frame, render, frames,
    order: () => host.querySelectorAll('[data-album-draft-key]').map(node => node.getAttribute('data-album-draft-key')),
    patch(value) {state = {...state, ...value};}};
}

for (const [x, y, expected] of [[190, 70, ['b', 'a', 'c', 'd']], [70, 190, ['b', 'c', 'a', 'd']], [190, 190, ['b', 'c', 'd', 'a']]]) {
  test(`grid hit testing distinguishes horizontal and vertical card centers (${x},${y})`, t => {
    const f = fixture(t); f.emit(f.handle('a'), 'pointerdown'); f.emit(f.doc, 'pointermove', {clientX: x, clientY: y}); f.frame();
    assert.deepEqual(f.commands, []); assert.deepEqual(f.order(), expected);
    assert.equal(f.host.querySelectorAll('[aria-hidden="true"]').length, 1, 'one inert gesture ghost');
    f.emit(f.doc, 'pointerup', {clientX: x, clientY: y}); assert.deepEqual(f.commands, [expected]);
    assert.equal(f.doc.activeElement, f.handle('a')); assert.equal(f.host.querySelectorAll('[aria-hidden="true"]').length, 0);
  });
}

for (const reason of ['escape', 'cancel', 'scope', 'source', 'permission', 'dispose']) test(`grid ${reason} interruption restores order without a membership command`, t => {
  const f = fixture(t); f.emit(f.handle('a'), 'pointerdown'); f.emit(f.doc, 'pointermove', {clientX: 190, clientY: 190}); f.frame();
  if (reason === 'escape') f.emit(f.doc, 'keydown', {key: 'Escape'});
  else if (reason === 'cancel') f.emit(f.doc, 'pointercancel');
  else if (reason === 'dispose') f.adapter.dispose();
  else f.patch(reason === 'scope' ? {scopeKey: 'replacement'} : reason === 'source' ? {source: {}} : {canReorder: false});
  f.emit(f.doc, 'pointerup', {clientX: 190, clientY: 190});
  assert.deepEqual(f.commands, []); assert.deepEqual(f.order(), ['a', 'b', 'c', 'd']); assert.equal(f.frames.size, 0);
});

test('grid keyboard reorder targets canonical identities and restores the replacement handle', t => {
  const f = fixture(t); f.handle('a').focus(); f.emit(f.handle('a'), 'keydown', {key: 'End'});
  assert.deepEqual(f.commands, [['b', 'c', 'd', 'a']]); assert.equal(f.doc.activeElement, f.handle('a'));
  f.emit(f.handle('a'), 'keydown', {key: 'Home'}); assert.deepEqual(f.commands[1], ['a', 'b', 'c', 'd']);
});
