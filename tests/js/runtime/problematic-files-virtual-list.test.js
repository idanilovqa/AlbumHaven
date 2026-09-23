const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const sourcePath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'problematic-files-virtual-list.js',
);

function loadVirtualList({ horizontal = false } = {}) {
  const frames = [];
  const context = {
    window: {
      matchMedia() {
        return { matches: horizontal };
      },
      requestAnimationFrame(callback) {
        frames.push(callback);
        return frames.length;
      },
      cancelAnimationFrame() {},
      addEventListener() {},
      removeEventListener() {},
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  return { api: context.window.ProblematicFilesVirtualList, frames };
}

function createList(overrides = {}) {
  const listeners = new Map();
  const document = { activeElement: null };
  class Element {
    constructor(tagName) {
      this.tagName = tagName;
      this.ownerDocument = document;
      this.children = [];
      this.parentNode = null;
      this.attributes = {};
      this.dataset = {};
      this.style = { cssText: '' };
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    get firstElementChild() { return this.children[0] || null; }
    get nextElementSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    closest(selector) {
      const attribute = selector.match(/^\[([^\]]+)\]$/)?.[1];
      return attribute && this.getAttribute(attribute) !== null ? this : this.parentNode?.closest(selector) || null;
    }
    focus() { document.activeElement = this; }
    remove() {
      if (!this.parentNode) return;
      if (this.contains(document.activeElement)) document.activeElement = null;
      this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
      this.parentNode = null;
    }
    insertBefore(node, reference) {
      if (node === reference) return node;
      node.remove();
      const index = reference === null ? this.children.length : this.children.indexOf(reference);
      assert.ok(index >= 0, 'reference must belong to the parent');
      this.children.splice(index, 0, node);
      node.parentNode = this;
      return node;
    }
    replaceChildren(...nodes) {
      [...this.children].forEach(node => node.remove());
      nodes.forEach(node => this.insertBefore(node, null));
    }
    get innerHTML() { return this.children.map(child => child.outerHTML).join(''); }
    get outerHTML() {
      const attributes = { ...this.attributes };
      if (this.className) attributes.class = this.className;
      if (this.style.cssText) attributes.style = this.style.cssText;
      const markup = Object.entries(attributes).map(([name, value]) => ` ${name}="${value}"`).join('');
      return `<${this.tagName}${markup}>${this.innerHTML}</${this.tagName}>`;
    }
  }
  document.createElement = tagName => {
    if (tagName !== 'template') return new Element(tagName);
    const content = new Element('fragment');
    return { content, set innerHTML(html) {
      const match = html.match(/^<([a-z]+)([^>]*)><\/\1>$/);
      assert.ok(match, 'fixture expects one empty rendered element');
      const element = new Element(match[1]);
      for (const [, name, value] of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) element.setAttribute(name, value);
      content.replaceChildren(element);
    } };
  };
  return Object.assign(new Element('div'), {
    clientHeight: 340,
    clientWidth: 320,
    dataset: {},
    scrollLeft: 0,
    scrollTop: 0,
    addEventListener(type, callback) {
      listeners.set(type, callback);
    },
    removeEventListener(type, callback) {
      if (listeners.get(type) === callback) listeners.delete(type);
    },
    emit(type, event = {}) {
      listeners.get(type)?.(event);
    },
    listenerCount() {
      return listeners.size;
    },
    ...overrides,
  });
}

function makeItems(count) {
  return Array.from({ length: count }, (_value, index) => ({ key: `album-${index}` }));
}

function mountedKeys(html) {
  return [...html.matchAll(/data-problematic-album-key="([^"]+)"/g)].map((match) => match[1]);
}

test('vertical window mounts a bounded overscanned subset of 706 rows', () => {
  const { api } = loadVirtualList();
  const list = createList();
  const virtualList = api.create({
    list,
    renderRow: (item) => `<button data-problematic-album-key="${item.key}"></button>`,
  });

  virtualList.render(makeItems(706), 'album-0');

  assert.deepEqual(mountedKeys(list.innerHTML), makeItems(11).map((item) => item.key));
  assert.equal(list.dataset.problematicMountedCount, '11');
  assert.equal(list.dataset.problematicVirtualStart, '0');
  assert.equal(list.dataset.problematicVirtualEnd, '11');
  assert.match(list.innerHTML, /data-problematic-virtual-spacer="after"/);
});

test('scroll schedules one range update and keeps mounted rows bounded', () => {
  const { api, frames } = loadVirtualList();
  const list = createList();
  const virtualList = api.create({
    list,
    renderRow: (item) => `<button data-problematic-album-key="${item.key}"></button>`,
  });
  virtualList.render(makeItems(706), 'album-0');

  list.scrollTop = 6800;
  list.emit('scroll');
  list.emit('scroll');
  assert.equal(frames.length, 1);
  frames.shift()();

  const keys = mountedKeys(list.innerHTML);
  assert.ok(keys.length <= 17);
  assert.ok(keys.includes('album-100'));
  assert.ok(Number(list.dataset.problematicVirtualStart) > 0);
});

test('reveal scrolls an offscreen selected row into the mounted range', () => {
  const { api, frames } = loadVirtualList();
  const list = createList();
  const virtualList = api.create({
    list,
    renderRow: (item) => `<button data-problematic-album-key="${item.key}"></button>`,
  });
  virtualList.render(makeItems(706), 'album-0');

  virtualList.reveal('album-700');
  assert.ok(list.scrollTop > 0);
  frames.shift()();
  assert.ok(mountedKeys(list.innerHTML).includes('album-700'));
});

test('initial render reveals an offscreen selected row', () => {
  const { api, frames } = loadVirtualList();
  const list = createList();
  const virtualList = api.create({
    list,
    renderRow: (item) => `<button data-problematic-album-key="${item.key}"></button>`,
  });

  virtualList.render(makeItems(706), 'album-700');
  frames.shift()();

  assert.ok(list.scrollTop > 0);
  assert.ok(mountedKeys(list.innerHTML).includes('album-700'));
});

test('mobile mode windows the existing horizontal strip', () => {
  const { api } = loadVirtualList({ horizontal: true });
  const list = createList();
  const virtualList = api.create({
    list,
    renderRow: (item) => `<button data-problematic-album-key="${item.key}"></button>`,
  });

  virtualList.render(makeItems(706), 'album-0');

  assert.equal(list.dataset.problematicVirtualAxis, 'horizontal');
  assert.ok(mountedKeys(list.innerHTML).length < 20);
  assert.match(list.innerHTML, /style="width:/);
});

test('dispose removes listeners and cancels later rendering', () => {
  const { api, frames } = loadVirtualList();
  const list = createList();
  const virtualList = api.create({
    list,
    renderRow: (item) => `<button data-problematic-album-key="${item.key}"></button>`,
  });
  virtualList.render(makeItems(706), 'album-0');
  assert.equal(list.listenerCount(), 2);

  list.emit('scroll');
  virtualList.dispose();
  assert.equal(list.listenerCount(), 0);
  assert.equal(list.dataset.problematicMountedCount, undefined);
  assert.equal(frames.length, 1);
});
