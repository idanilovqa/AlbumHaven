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
  return {
    clientHeight: 340,
    clientWidth: 320,
    dataset: {},
    innerHTML: '',
    scrollLeft: 0,
    scrollTop: 0,
    addEventListener(type, callback) {
      listeners.set(type, callback);
    },
    removeEventListener(type, callback) {
      if (listeners.get(type) === callback) listeners.delete(type);
    },
    emit(type) {
      listeners.get(type)?.();
    },
    listenerCount() {
      return listeners.size;
    },
    ...overrides,
  };
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
  assert.equal(list.listenerCount(), 1);

  list.emit('scroll');
  virtualList.dispose();
  assert.equal(list.listenerCount(), 0);
  assert.equal(list.dataset.problematicMountedCount, undefined);
  assert.equal(frames.length, 1);
});
