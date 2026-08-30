const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const helperPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'browser-storage-helpers.js',
);
const helperSource = fs.readFileSync(helperPath, 'utf8');

function loadHelper(windowOverrides = {}) {
  const context = {
    window: {},
  };
  Object.defineProperties(
    context.window,
    Object.getOwnPropertyDescriptors(windowOverrides),
  );
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return context;
}

{
  const storage = new Map();
  const context = loadHelper({
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, value);
      },
      removeItem(key) {
        storage.delete(key);
      },
    },
  });

  assert.equal(context.getLocalStorageItem('missing'), '');
  assert.equal(context.setLocalStorageItem('albumhaven.test', '{"ok":true}'), true);
  assert.equal(storage.get('albumhaven.test'), '{"ok":true}');
  assert.equal(context.getLocalStorageItem('albumhaven.test'), '{"ok":true}');
  assert.equal(context.removeLocalStorageItem('albumhaven.test'), true);
  assert.equal(storage.has('albumhaven.test'), false);
}

{
  const context = loadHelper({
    get localStorage() {
      throw new Error('blocked');
    },
  });

  assert.equal(context.getLocalStorageItem('albumhaven.test', 'fallback'), 'fallback');
  assert.equal(context.setLocalStorageItem('albumhaven.test', 'value'), false);
  assert.equal(context.removeLocalStorageItem('albumhaven.test'), false);
}

{
  const storage = new Map();
  const context = loadHelper({
    sessionStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, value);
      },
      removeItem(key) {
        storage.delete(key);
      },
    },
  });

  assert.equal(context.getSessionStorageItem('missing'), '');
  assert.equal(context.setSessionStorageItem('albumhaven.test', '{"ok":true}'), true);
  assert.equal(storage.get('albumhaven.test'), '{"ok":true}');
  assert.equal(context.getSessionStorageItem('albumhaven.test'), '{"ok":true}');
  assert.equal(context.removeSessionStorageItem('albumhaven.test'), true);
  assert.equal(storage.has('albumhaven.test'), false);
}

{
  const context = loadHelper({
    get sessionStorage() {
      throw new Error('blocked');
    },
  });

  assert.equal(context.getSessionStorageItem('albumhaven.test', 'fallback'), 'fallback');
  assert.equal(context.setSessionStorageItem('albumhaven.test', 'value'), false);
  assert.equal(context.removeSessionStorageItem('albumhaven.test'), false);
}
