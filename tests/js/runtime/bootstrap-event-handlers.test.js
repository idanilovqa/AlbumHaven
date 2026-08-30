const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const handlerPath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'bootstrap-event-handlers.js');
const handlerSource = fs.readFileSync(handlerPath, 'utf8');

function createContext({
  searchClickHandled = false,
  sidebarHandled = false,
  drawerHandled = false,
  searchMouseDownHandled = false,
} = {}) {
  const listeners = {};
  const calls = [];
  const context = {
    document: {
      addEventListener(name, callback) {
        listeners[name] = callback;
      },
      getElementById() {
        return null;
      },
    },
    window: {
      addEventListener(name, callback) {
        listeners[`window:${name}`] = callback;
      },
    },
    handleGalleryBootstrapSearchClick() {
      calls.push('search');
      return searchClickHandled;
    },
    handleSidebarArtistSelectionClick() {
      calls.push('sidebar');
      return sidebarHandled;
    },
    handleArtistsDrawerClick() {
      calls.push('drawer');
      return drawerHandled;
    },
    handleUtilityBootstrapClick() {
      calls.push('utility');
    },
    cancelLibraryScan() {
      calls.push('cancel-library-scan');
    },
    browseScannedLibrarySnapshot() {
      calls.push('browse-library');
    },
    handleGalleryBootstrapClick() {
      calls.push('gallery');
    },
    handleGalleryBootstrapSearchMouseDown() {
      calls.push('search-mousedown');
      return searchMouseDownHandled;
    },
    handleUtilityBootstrapMouseDown() {
      calls.push('utility-mousedown');
    },
  };
  vm.createContext(context);
  vm.runInContext(handlerSource, context, { filename: handlerPath });
  return { calls, listeners };
}

test('document click stops after a handled search interaction', () => {
  const { calls, listeners } = createContext({ searchClickHandled: true });

  listeners.click({ defaultPrevented: false, target: {} });

  assert.deepEqual(calls, ['search']);
});

test('document click dispatches an unhandled search before a handled sidebar artist selection', () => {
  const { calls, listeners } = createContext({ sidebarHandled: true });

  listeners.click({ defaultPrevented: false, target: {} });

  assert.deepEqual(calls, ['search', 'sidebar']);
});

test('document click preserves the complete dispatcher chain when no handler claims the event', () => {
  const { calls, listeners } = createContext();

  listeners.click({
    defaultPrevented: false,
    target: {
      closest() {
        return null;
      },
    },
  });

  assert.deepEqual(calls, ['search', 'sidebar', 'drawer', 'utility', 'gallery']);
});

test('document click dispatches the dedicated Scan Page cancel action once', () => {
  const { calls, listeners } = createContext();
  let prevented = 0;
  listeners.click({
    defaultPrevented: false,
    preventDefault() {
      prevented += 1;
    },
    target: {
      closest(selector) {
        return selector === '[data-cancel-library-scan="1"]'
          ? { disabled: false }
          : null;
      },
    },
  });

  assert.equal(prevented, 1);
  assert.deepEqual(calls, ['search', 'sidebar', 'drawer', 'cancel-library-scan']);
});

test('document mousedown stops after a handled search interaction', () => {
  const { calls, listeners } = createContext({ searchMouseDownHandled: true });

  listeners.mousedown({ target: {} });

  assert.deepEqual(calls, ['search-mousedown']);
});

test('document mousedown reaches the utility handler after an unhandled search interaction', () => {
  const { calls, listeners } = createContext();

  listeners.mousedown({ target: {} });

  assert.deepEqual(calls, ['search-mousedown', 'utility-mousedown']);
});
