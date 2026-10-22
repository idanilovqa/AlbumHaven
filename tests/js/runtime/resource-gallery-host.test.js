'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = process.env.ALBUM_TOP_TEST_ROOT || path.resolve(__dirname, '../../..');
const source = fs.readFileSync(path.join(root, 'music_app/static/js/runtime/virtual-artist-grid.js'), 'utf8');

// Deliberately small DOM boundary: run the production owner, not a model of its
// reconciliation. Detached nodes retain listeners, as real DOM nodes do.
class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.clientWidth = 980;
    this.style = { setProperty(name, value) { this[name] = String(value); }, removeProperty(name) { delete this[name]; } };
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle(name, force) {
        const enabled = force === undefined ? !classes.has(name) : force;
        if (enabled) classes.add(name); else classes.delete(name);
        return enabled;
      },
    };
  }
  get parentElement() { return this.parentNode; }
  focus() { this.ownerDocument.activeElement = this; }
  get childNodes() { return this.children; }
  get firstChild() { return this.children[0] || null; }
  get firstElementChild() { return this.firstChild; }
  get nextSibling() {
    if (!this.parentNode) return null;
    return this.parentNode.children[this.parentNode.children.indexOf(this) + 1] || null;
  }
  get isConnected() { return this.connected === true || Boolean(this.parentNode?.isConnected); }
  appendChild(node) { return this.insertBefore(node, null); }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
  insertBefore(node, before) {
    if (node === before) return node;
    node.remove();
    const index = before ? this.children.indexOf(before) : this.children.length;
    assert.ok(index >= 0, 'insertBefore reference belongs to this parent');
    this.children.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild(node) {
    const index = this.children.indexOf(node);
    assert.ok(index >= 0);
    this.children.splice(index, 1);
    if (node.ownerDocument && node.contains(node.ownerDocument.activeElement)) node.ownerDocument.activeElement = node.ownerDocument.body;
    node.parentNode = null;
    return node;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceChildren(...nodes) { [...this.children].forEach(node => node.remove()); this.append(...nodes); }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  matches(selector) {
    const match = selector.match(/^\[([^\]]+)\]$/);
    if (!match) return false;
    const attribute = match[1];
    const key = attribute.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return this.attributes.has(attribute) || (attribute.startsWith('data-') && key in this.dataset);
  }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  dispatchEvent(event) {
    event.target ||= this;
    for (const callback of [...(this.listeners.get(event.type) || [])]) callback.call(this, event);
    if (event.bubbles !== false) this.parentNode?.dispatchEvent(event);
    return true;
  }
  getBoundingClientRect() { return { width: this.clientWidth, height: 600, top: 0, left: 0 }; }
}

function fixture() {
  const window = new Element('window');
  const body = new Element('body');
  body.connected = true;
  const document = new Element('document');
  const nativeElements = new Map();
  const makeElement = tag => Object.assign(new Element(tag), { ownerDocument: document });
  document.defaultView = window;
  Object.assign(document, { body, createElement: makeElement,
    getElementById(id) { if (!nativeElements.has(id)) nativeElements.set(id, makeElement('div')); return nativeElements.get(id); },
  });
  const observers = [];
  const frames = new Map();
  let frameId = 0;
  class ResizeObserver {
    constructor(callback) { this.callback = callback; this.targets = new Set(); this.disconnected = false; observers.push(this); }
    observe(target) { this.targets.add(target); }
    disconnect() { this.targets.clear(); this.disconnected = true; }
  }
  const state = Object.freeze({ gallery: Object.freeze({ sentinel: 'artist' }), view: Object.freeze({}) });
  const context = vm.createContext({ console, window, document, Element, HTMLElement: Element, ResizeObserver, state,
    requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: id => frames.delete(id),
    resolveGalleryRendererMode: mode => mode === 'covers' ? 'covers' : 'cards',
  });
  Object.assign(window, { innerWidth: 1200, ResizeObserver, requestAnimationFrame: context.requestAnimationFrame, cancelAnimationFrame: context.cancelAnimationFrame });
  vm.runInContext(source, context);
  vm.runInContext('virtualGrid._destroyed = true', context);
  const Host = vm.runInContext('ResourceGalleryHost', context);
  function flush() {
    while (frames.size) {
      const pending = [...frames.values()]; frames.clear();
      pending.forEach(callback => callback());
    }
  }
  return { Host, window, document, body, observers, frames, context, state, flush };
}

function snapshot(overrides = {}) {
  return Object.freeze({ scopeKey: 'viewer-one', resourceKey: 'top-one', displayMode: 'cards',
    layoutConfig: Object.freeze({ cardMinWidth: 180 }), mobileColumns: 3, ...overrides });
}

function mount(f, options = {}) {
  const host = options.host || f.document.createElement('div');
  if (!host.parentNode) f.body.appendChild(host);
  let currentSnapshot = options.snapshot || snapshot();
  let current = true;
  const rendered = [], updated = [], disposed = [], actions = [];
  const renderCard = (row, captured) => {
    const element = f.document.createElement('article');
    element.dataset.testKey = row.key;
    const action = f.document.createElement('button');
    action.setAttribute('data-gallery-card-intent', 'open');
    element.appendChild(action);
    rendered.push({ row, captured, element });
    return { element,
      update(value, next) { updated.push({ row: value, captured: next, element }); },
      dispose() { disposed.push(element); },
    };
  };
  const owner = new f.Host({ host, readSnapshot: () => currentSnapshot,
    renderCard: options.renderCard || renderCard,
    onAction: (row, event, captured) => actions.push({ row, event, captured }),
    isCurrent: () => current,
  });
  return { owner, host, rendered, updated, disposed, actions,
    setSnapshot(value) { currentSnapshot = value; }, revoke() { current = false; },
    update(rows) { owner.update(rows); f.flush(); },
  };
}

function click(node) { node.dispatchEvent({ type: 'click', bubbles: true, preventDefault() {}, stopPropagation() {} }); }

test('keyed updates preserve surviving nodes, selection, order, and current action data', () => {
  const f = fixture(), h = mount(f);
  const a = { key: 'a', title: 'old' }, b = { key: 'b' };
  h.update([a, b]);
  const [aNode, bNode] = h.rendered.map(value => value.element);
  aNode.setAttribute('aria-selected', 'true');
  bNode.firstChild.focus();
  const latestA = { key: 'a', title: 'new' };
  h.update([b, latestA]);
  h.update([b, latestA]);
  assert.equal(h.rendered.length, 2);
  assert.equal(aNode.getAttribute('aria-selected'), 'true');
  assert.equal(f.document.activeElement, bNode.firstChild);
  assert.deepEqual(h.host.firstChild.children, [bNode, aNode]);
  click(aNode.firstChild);
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].row, latestA);
  click(aNode);
  assert.equal(h.actions.length, 1, 'non-intent card clicks do not invoke actions');
  h.update([latestA]);
  assert.deepEqual(h.disposed, [bNode]);
  assert.deepEqual(h.host.firstChild.children, [aNode]);
  h.owner.dispose();
  h.owner.dispose();
  assert.deepEqual(h.disposed, [bNode, aNode]);
});

test('two resources with identical keys resolve only their own local rows and snapshots', () => {
  const f = fixture();
  const leftSnapshot = snapshot(), rightSnapshot = snapshot({ resourceKey: 'top-two' });
  const left = mount(f, { snapshot: leftSnapshot }), right = mount(f, { snapshot: rightSnapshot });
  const leftRow = { key: 'same', title: 'left' }, rightRow = { key: 'same', title: 'right' };
  left.update([leftRow]); right.update([rightRow]);
  click(left.rendered[0].element.firstChild); click(right.rendered[0].element.firstChild);
  assert.equal(left.actions[0].row, leftRow);
  assert.equal(right.actions[0].row, rightRow);
  assert.equal(left.actions[0].captured, leftSnapshot);
  assert.equal(right.actions[0].captured, rightSnapshot);
  assert.deepEqual(Object.keys(f.state.gallery), ['sentinel']);
  left.owner.dispose();
  click(right.rendered[0].element.firstChild);
  assert.equal(right.actions.length, 2);
  right.owner.dispose();
});

test('obsolete snapshot and revoked lease reject clicks and queued layout callbacks', () => {
  const f = fixture(), h = mount(f);
  h.update([{ key: 'a' }]);
  const node = h.rendered[0].element;
  const oldSnapshot = h.rendered[0].captured;
  h.setSnapshot(snapshot({ resourceKey: 'new-top' }));
  click(node.firstChild);
  assert.equal(h.actions.length, 0);
  h.revoke();
  f.window.dispatchEvent({ type: 'resize' });
  f.window.dispatchEvent({ type: 'album-haven:artist-tree-settled' });
  f.observers.forEach(observer => observer.callback([]));
  f.flush();
  assert.ok(h.updated.every(update => update.captured === oldSnapshot));
  assert.equal(h.rendered.length, 1);
  h.owner.dispose();
});

test('disposed owner removes listeners and ignores already captured observer callbacks', () => {
  const f = fixture();
  const beforeResize = f.window.listeners.get('resize')?.size || 0;
  const beforeSettled = f.window.listeners.get('album-haven:artist-tree-settled')?.size || 0;
  const h = mount(f);
  h.update([{ key: 'a' }]);
  const callbacks = f.observers.map(observer => observer.callback);
  const node = h.rendered[0].element;
  h.owner.dispose();
  const updates = h.updated.length;
  callbacks.forEach(callback => callback([]));
  f.window.dispatchEvent({ type: 'resize' });
  f.flush();
  click(node.firstChild);
  h.owner.update([{ key: 'late' }]);
  f.flush();
  assert.equal(h.updated.length, updates);
  assert.equal(h.rendered.length, 1);
  assert.equal(h.actions.length, 0);
  assert.ok(f.observers.every(observer => observer.disconnected));
  assert.equal(f.window.listeners.get('resize')?.size || 0, beforeResize);
  assert.equal(f.window.listeners.get('album-haven:artist-tree-settled')?.size || 0, beforeSettled);
});

test('rehosting the same element retires its old lease without touching the successor', () => {
  const f = fixture(), old = mount(f);
  old.update([{ key: 'same' }]);
  const staleNode = old.rendered[0].element;
  const staleResize = f.observers[0].callback;
  const next = mount(f, { host: old.host, snapshot: snapshot({ resourceKey: 'replacement' }) });
  const row = { key: 'same', title: 'successor' };
  next.update([row]);
  assert.deepEqual(old.disposed, [staleNode]);
  old.owner.dispose(); old.owner.update([{ key: 'late' }]); staleResize([]); f.flush();
  click(staleNode.firstChild);
  click(next.rendered[0].element.firstChild);
  assert.equal(old.actions.length, 0);
  assert.equal(next.actions.length, 1);
  assert.equal(next.actions[0].row, row);
  assert.equal(next.host.children.length, 1);
  assert.equal(next.rendered[0].element.isConnected, true);
  next.owner.dispose();
});

test('renderer reentrancy cannot append stale rows over a newer update', () => {
  const f = fixture();
  let h, reentered = false;
  const disposed = [], nodes = new Map();
  h = mount(f, { renderCard(row) {
    const element = f.document.createElement('article'); nodes.set(row.key, element);
    if (!reentered) { reentered = true; h.owner.update([{ key: 'new' }]); }
    return { element, update() {}, dispose() { disposed.push(row.key); } };
  } });
  h.update([{ key: 'old' }, { key: 'never' }]);
  assert.deepEqual(h.host.firstChild.children, [nodes.get('new')]);
  assert.deepEqual(disposed, ['old']);
  assert.equal(nodes.has('never'), false);
  h.owner.dispose();
  assert.deepEqual(disposed, ['old', 'new']);
});

test('dispose during renderer cleans the returned uncommitted owner exactly once', () => {
  const f = fixture(); let h, disposed = 0;
  h = mount(f, { renderCard() {
    const element = f.document.createElement('article');
    h.owner.dispose();
    return { element, update() {}, dispose() { disposed++; } };
  } });
  h.update([{ key: 'old' }]);
  h.owner.dispose();
  assert.equal(disposed, 1);
  assert.equal(h.host.children.length, 0);
});

test('reentrant card update leaves the latest order and actions intact', () => {
  const f = fixture(); let h, reentered = false;
  const nodes = new Map();
  h = mount(f, { renderCard(row) {
    const element = f.document.createElement('article');
    const action = f.document.createElement('button');
    action.setAttribute('data-gallery-card-intent', 'open'); element.append(action);
    nodes.set(row.key, element);
    return { element, update() {
      if (!reentered) { reentered = true; h.owner.update([{ key: 'b' }, { key: 'a', latest: true }]); }
    }, dispose() {} };
  } });
  h.update([{ key: 'a' }, { key: 'b' }]);
  h.update([{ key: 'a', stale: true }, { key: 'b' }]);
  assert.deepEqual(h.host.firstChild.children, [nodes.get('b'), nodes.get('a')]);
  click(nodes.get('a').firstChild);
  assert.equal(h.actions[0].row.latest, true);
  h.owner.dispose();
});

test('invalid duplicate keys do not partially retire a valid render', () => {
  const f = fixture(), h = mount(f);
  h.update([{ key: 'a' }]);
  const node = h.rendered[0].element;
  assert.throws(() => h.owner.update([{ key: 'duplicate' }, { key: 'duplicate' }]), /unique stable row keys/);
  assert.deepEqual(h.host.firstChild.children, [node]);
  assert.equal(h.disposed.length, 0);
  click(node.firstChild);
  assert.equal(h.actions.length, 1);
  h.owner.dispose();
});

test('disabled intents and unowned elements cannot invoke a resource action', () => {
  const f = fixture(), h = mount(f);
  h.update([{ key: 'a' }]);
  const button = h.rendered[0].element.firstChild;
  button.disabled = true; click(button);
  button.disabled = false; button.setAttribute('aria-disabled', 'true'); click(button);
  const foreign = f.document.createElement('button');
  foreign.setAttribute('data-gallery-card-intent', 'open'); h.host.firstChild.append(foreign); click(foreign);
  assert.equal(h.actions.length, 0);
  button.removeAttribute('aria-disabled'); click(button);
  assert.equal(h.actions.length, 1);
  h.owner.dispose();
});

test('snapshot replacement within renderer retires late owner and all prior cards', () => {
  const f = fixture(); let h; const disposed = [];
  h = mount(f, { renderCard(row) {
    if (row.key === 'late') h.setSnapshot(snapshot({ resourceKey: 'other' }));
    return { element: f.document.createElement('article'), update() {}, dispose() { disposed.push(row.key); } };
  } });
  h.update([{ key: 'first' }]);
  h.update([{ key: 'first' }, { key: 'late' }]);
  assert.deepEqual(disposed.sort(), ['first', 'late']);
  assert.equal(h.host.children.length, 0);
  assert.ok(f.observers.every(observer => observer.disconnected));
});

test('replacement created by a disposer supersedes the constructor trying to replace it', () => {
  const f = fixture(); let old, winner;
  old = mount(f, { renderCard() {
    return { element: f.document.createElement('article'), update() {}, dispose() {
      winner = mount(f, { host: old.host, snapshot: snapshot({ resourceKey: 'winner' }) });
      winner.update([{ key: 'winner' }]);
    } };
  } });
  old.update([{ key: 'old' }]);
  const superseded = mount(f, { host: old.host, snapshot: snapshot({ resourceKey: 'superseded' }) });
  superseded.update([{ key: 'must-not-mount' }]);
  assert.equal(superseded.rendered.length, 0);
  assert.equal(old.host.children.length, 1);
  assert.equal(winner.rendered[0].element.isConnected, true);
  click(winner.rendered[0].element.firstChild);
  assert.equal(winner.actions.length, 1);
  superseded.owner.dispose();
  assert.equal(winner.rendered[0].element.isConnected, true);
  winner.owner.dispose();
});

test('resize, observer and tree settlement use live dimensions and current snapshot without remounting', () => {
  const f = fixture(), h = mount(f);
  h.update(Array.from({ length: 8 }, (_, index) => ({ key: String(index) })));
  const root = h.host.firstChild, node = h.rendered[0].element;
  assert.equal(root.style.gridTemplateColumns, 'repeat(5, minmax(0, 184px))');
  h.host.clientWidth = 600;
  f.window.dispatchEvent({ type: 'resize' }); f.flush();
  assert.equal(root.style.gridTemplateColumns, 'repeat(3, minmax(0, 189.333px))');
  h.host.clientWidth = 400;
  f.observers[0].callback([]); f.flush();
  assert.equal(root.style.gridTemplateColumns, 'repeat(2, minmax(0, 191px))');
  h.host.clientWidth = 800;
  f.window.dispatchEvent({ type: 'album-haven:artist-tree-settled' }); f.flush();
  assert.equal(root.style.gridTemplateColumns, 'repeat(4, minmax(0, 188.5px))');
  assert.equal(h.rendered.length, 8);
  assert.equal(root.firstChild, node);
  h.owner.dispose();
});

test('a queued old revision cannot overwrite newer display and mobile geometry', () => {
  const f = fixture(), h = mount(f);
  const calls = [];
  f.window.AlbumHavenClientLayout = { resolveMobileGalleryGeometry(input) {
    calls.push(input);
    return input.viewportWidth < 600 ? { columns: input.columns, cardTrackWidth: 110 } : null;
  } };
  h.owner.update([{ key: 'a' }]);
  const oldFrame = [...f.frames.values()][0];
  h.setSnapshot(snapshot({ displayMode: 'covers', mobileColumns: 2 }));
  f.window.innerWidth = 390;
  h.owner.update([{ key: 'a' }]);
  oldFrame(); f.flush();
  assert.equal(h.host.firstChild.getAttribute('data-gallery-display'), 'covers');
  assert.equal(h.host.firstChild.style.gridTemplateColumns, 'repeat(2, minmax(0, 110px))');
  assert.equal(calls.at(-1).viewportWidth, 390);
  assert.equal(calls.at(-1).mode, 'covers');
  assert.equal(calls.at(-1).columns, 2);
  assert.equal(h.rendered.length, 1);
  h.owner.dispose();
});

for (const [name, options, expected] of [
  ['normal', {}, { columns: 3, cardTrackWidth: 316 }],
  ['preserved width', { preserveCardTrackWidth: true, cardTrackWidth: 300, itemCount: 2 }, { columns: 3, cardTrackWidth: 300 }],
  ['settled fill', { width: 950, preserveCardTrackWidth: true, cardTrackWidth: 300, itemCount: 8 }, { columns: 4, cardTrackWidth: 227 }],
  ['preserved geometry', { preserveColumnGeometry: true, columns: 2, cardTrackWidth: 410 }, { columns: 2, cardTrackWidth: 410 }],
  ['mobile override', { preserveColumnGeometry: true, mobileGeometry: { columns: 2, cardTrackWidth: 150 } }, { columns: 2, cardTrackWidth: 150 }],
]) test(`shared geometry preserves the existing ${name} formula`, () => {
  const f = fixture();
  const resolve = vm.runInContext('resolveGalleryColumnGeometry', f.context);
  const result = resolve({ width: 976, selectedCardWidth: 240, columnGap: 14, itemCount: 0, columns: 3, cardTrackWidth: 240, ...options });
  assert.equal(result.columns, expected.columns);
  assert.equal(result.cardTrackWidth, expected.cardTrackWidth);
});

test('Artist recalculation and scoped resource host share desktop and mobile geometry', () => {
  const f = fixture(), h = mount(f, { snapshot: snapshot({ layoutConfig: Object.freeze({ cardMinWidth: 240 }) }) });
  const native = vm.runInContext('virtualGrid', f.context);
  for (const width of [320, 600, 980, 1440]) {
    native.scrollEl.clientWidth = width; h.host.clientWidth = width;
    native.recalculate(); h.update([{ key: 'a' }]);
    const template = vm.runInContext('buildAlbumRowGridTemplate', f.context)(native.columns, native.cardTrackWidth);
    assert.equal(h.host.firstChild.style.gridTemplateColumns, template);
  }
  f.window.AlbumHavenClientLayout = { resolveMobileGalleryGeometry: () => ({ columns: 2, cardTrackWidth: 130 }) };
  native.recalculate(); h.update([{ key: 'a' }]);
  assert.equal(native.columns, 2);
  assert.equal(native.cardTrackWidth, 130);
  assert.equal(h.host.firstChild.style.gridTemplateColumns, 'repeat(2, minmax(0, 130px))');
  h.owner.dispose();
});

test('scale belongs to the scoped snapshot and preserves default, minimum and maximum geometry', () => {
  const f = fixture(), h = mount(f);
  h.update([{ key: 'a' }]);
  assert.equal(h.host.firstChild.style.gridTemplateColumns, 'repeat(5, minmax(0, 184px))');
  h.setSnapshot(snapshot({ galleryScalePercent: 80 })); h.update([{ key: 'a' }]);
  assert.equal(h.host.firstChild.style.gridTemplateColumns, 'repeat(6, minmax(0, 151px))');
  h.setSnapshot(snapshot({ galleryScalePercent: 140 })); h.update([{ key: 'a' }]);
  assert.equal(h.host.firstChild.style.gridTemplateColumns, 'repeat(3, minmax(0, 316px))');
  assert.equal(h.rendered.length, 1);
  h.owner.dispose();
});

test('sidebar transition defers layout until settlement then fills using all resource rows', () => {
  const f = fixture(), h = mount(f, { snapshot: snapshot({ layoutConfig: Object.freeze({ cardMinWidth: 240 }) }) });
  const rows = Array.from({ length: 8 }, (_, index) => ({ key: String(index) }));
  h.update(rows);
  const root = h.host.firstChild;
  assert.equal(root.style.gridTemplateColumns, 'repeat(3, minmax(0, 316px))');
  const rail = f.document.getElementById('shell-navigation-rail');
  rail.classList.add('is-transitioning');
  h.host.clientWidth = 954;
  f.window.dispatchEvent({ type: 'resize' }); f.observers[0].callback([]); f.flush();
  assert.equal(root.style.gridTemplateColumns, 'repeat(3, minmax(0, 316px))');
  rail.classList.remove('is-transitioning');
  f.window.dispatchEvent({ type: 'album-haven:artist-tree-settled' }); f.flush();
  assert.equal(root.style.gridTemplateColumns, 'repeat(4, minmax(0, 227px))');
  assert.equal(h.rendered.length, 8);
  h.update(rows);
  assert.equal(root.style.gridTemplateColumns, 'repeat(3, minmax(0, 307.333px))');
  assert.equal(h.rendered.length, 8);
  h.owner.dispose();
});

test('a resize frame queued before sidebar transition cannot publish intermediate geometry', () => {
  const f = fixture(), h = mount(f, { snapshot: snapshot({ layoutConfig: Object.freeze({ cardMinWidth: 240 }) }) });
  h.update(Array.from({ length: 8 }, (_, index) => ({ key: String(index) })));
  const root = h.host.firstChild;
  assert.equal(root.style.gridTemplateColumns, 'repeat(3, minmax(0, 316px))');
  f.window.dispatchEvent({ type: 'resize' });
  assert.equal(f.frames.size, 1, 'resize work was already queued before transition');
  const rail = f.document.getElementById('shell-navigation-rail');
  rail.classList.add('is-transitioning');
  h.host.clientWidth = 700;
  f.flush();
  assert.equal(root.style.gridTemplateColumns, 'repeat(3, minmax(0, 316px))');
  h.host.clientWidth = 954;
  rail.classList.remove('is-transitioning');
  f.window.dispatchEvent({ type: 'album-haven:artist-tree-settled' });
  f.flush();
  assert.equal(root.style.gridTemplateColumns, 'repeat(4, minmax(0, 227px))');
  assert.equal(h.rendered.length, 8);
  h.owner.dispose();
});

function actionCard(f, { update = () => {}, dispose = () => {} } = {}) {
  const element = f.document.createElement('article');
  const action = f.document.createElement('button');
  action.setAttribute('data-gallery-card-intent', 'open');
  element.append(action);
  return { element, update, dispose };
}

test('throwing superseded renderer cannot dispose a successfully committed nested update', () => {
  const f = fixture(); let h, winnerNode; const disposed = [];
  const winner = { key: 'winner' };
  const winningSnapshot = snapshot({ displayMode: 'covers' });
  const failure = new Error('superseded renderer failed');
  h = mount(f, { renderCard(row) {
    if (row.key === 'outer') {
      h.setSnapshot(winningSnapshot);
      assert.equal(h.owner.update([winner]), true);
      throw failure;
    }
    const owner = actionCard(f, { dispose: () => disposed.push(row.key) });
    winnerNode = owner.element;
    return owner;
  } });
  assert.throws(() => h.owner.update([{ key: 'outer' }]), error => error === failure);
  f.flush();
  assert.deepEqual(h.host.firstChild.children, [winnerNode]);
  assert.deepEqual(disposed, []);
  click(winnerNode.firstChild);
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].row, winner);
  assert.equal(h.actions[0].captured, winningSnapshot);
  h.owner.dispose();
  assert.deepEqual(disposed, ['winner']);
});

test('throwing superseded card update cannot dispose a successfully committed nested update', () => {
  const f = fixture(); let h; const nodes = new Map(), disposed = [];
  const winnerA = { key: 'a', generation: 'winner' }, winnerB = { key: 'b', generation: 'winner' };
  const failure = new Error('superseded card update failed');
  h = mount(f, { renderCard(row) {
    const owner = actionCard(f, { update(next) {
      if (next.triggerNested) {
        assert.equal(h.owner.update([winnerB, winnerA]), true);
        throw failure;
      }
    }, dispose: () => disposed.push(row.key) });
    nodes.set(row.key, owner.element);
    return owner;
  } });
  h.update([{ key: 'a' }, { key: 'b' }]);
  assert.throws(() => h.owner.update([{ key: 'a', triggerNested: true }, { key: 'b', generation: 'obsolete' }]), error => error === failure);
  f.flush();
  assert.deepEqual(h.host.firstChild.children, [nodes.get('b'), nodes.get('a')]);
  assert.deepEqual(disposed, []);
  click(nodes.get('b').firstChild); click(nodes.get('a').firstChild);
  assert.deepEqual(h.actions.map(action => action.row), [winnerB, winnerA]);
  h.owner.dispose();
  assert.deepEqual(disposed.sort(), ['a', 'b']);
});

test('a synchronous click during reconciliation cannot combine an old row with the new snapshot', () => {
  const f = fixture(); let h; const nodes = new Map();
  const oldB = { key: 'b', generation: 'old' }, newB = { key: 'b', generation: 'new' };
  const newSnapshot = snapshot({ displayMode: 'covers' });
  h = mount(f, { renderCard(row) {
    const owner = actionCard(f, { update(next) {
      if (next.clickOldB) click(nodes.get('b').firstChild);
    } });
    nodes.set(row.key, owner.element);
    return owner;
  } });
  h.update([{ key: 'a' }, oldB]);
  h.setSnapshot(newSnapshot);
  h.update([{ key: 'a', clickOldB: true }, newB]);
  assert.equal(h.actions.length, 0, 'in-progress update must not dispatch an unrefreshed row');
  click(nodes.get('b').firstChild);
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].row, newB);
  assert.equal(h.actions[0].captured, newSnapshot);
  h.owner.dispose();
});

test('nested successful update enables its actions before the superseded outer callback returns', () => {
  const f = fixture(); let h, insideOuterCallback = false; const nodes = new Map();
  const winnerA = { key: 'a', generation: 'winner' }, winnerB = { key: 'b', generation: 'winner' };
  const winningSnapshot = snapshot({ displayMode: 'covers' });
  h = mount(f, { renderCard(row) {
    const owner = actionCard(f, { update(next) {
      if (!next.triggerNested) return;
      insideOuterCallback = true;
      h.setSnapshot(winningSnapshot);
      assert.equal(h.owner.update([winnerB, winnerA]), true);
      click(nodes.get('b').firstChild);
      assert.equal(h.actions.length, 1, 'winning revision is actionable while outer revision remains on stack');
      assert.equal(h.actions[0].row, winnerB);
      assert.equal(h.actions[0].captured, winningSnapshot);
      assert.equal(insideOuterCallback, true);
      insideOuterCallback = false;
    } });
    nodes.set(row.key, owner.element);
    return owner;
  } });
  h.update([{ key: 'a' }, { key: 'b' }]);
  assert.equal(h.owner.update([{ key: 'a', triggerNested: true }, { key: 'b', generation: 'obsolete' }]), false);
  f.flush();
  assert.equal(insideOuterCallback, false);
  assert.deepEqual(h.host.firstChild.children, [nodes.get('b'), nodes.get('a')]);
  click(nodes.get('a').firstChild);
  assert.deepEqual(h.actions.map(action => action.row), [winnerB, winnerA]);
  h.owner.dispose();
});

test('sparse rows are rejected before changing existing DOM, owners, or action bindings', () => {
  const f = fixture(), h = mount(f);
  const a = { key: 'a' }, b = { key: 'b' };
  h.update([a, b]);
  const root = h.host.firstChild;
  const [aNode, bNode] = h.rendered.map(card => card.element);
  const committedSnapshot = h.rendered[0].captured;
  const originalGeometry = root.style.gridTemplateColumns;
  bNode.firstChild.focus();
  for (const rows of [Array(1), [a, , b]]) {
    assert.throws(() => h.owner.update(rows), /unique stable row keys/);
    f.flush();
    assert.equal(h.host.firstChild, root);
    assert.deepEqual(root.children, [aNode, bNode]);
    assert.equal(root.style.gridTemplateColumns, originalGeometry);
    assert.equal(f.document.activeElement, bNode.firstChild);
    assert.equal(h.rendered.length, 2);
    assert.equal(h.updated.length, 0);
    assert.deepEqual(h.disposed, []);
  }
  click(aNode.firstChild); click(bNode.firstChild);
  assert.deepEqual(h.actions.map(action => action.row), [a, b]);
  assert.ok(h.actions.every(action => action.captured === committedSnapshot));
  h.update([b, a]);
  assert.deepEqual(root.children, [bNode, aNode]);
  assert.equal(h.rendered.length, 2);
  h.owner.dispose();
  assert.deepEqual(h.disposed, [aNode, bNode]);
});
