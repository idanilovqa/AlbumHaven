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
  'browser-scheduling-helpers.js',
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

(async () => {
  const calls = [];
  const context = loadHelper({
    setTimeout(callback, delay) {
      calls.push(['timeout', delay]);
      callback();
      return 12;
    },
    clearTimeout(id) {
      calls.push(['clear-timeout', id]);
    },
    requestAnimationFrame(callback) {
      calls.push(['raf']);
      callback();
      return 34;
    },
    cancelAnimationFrame(id) {
      calls.push(['cancel-raf', id]);
    },
  });

  assert.equal(context.scheduleBrowserTimeout(() => calls.push(['ran-timeout']), 25), 12);
  assert.equal(context.clearBrowserTimeout(12), true);
  assert.equal(context.scheduleBrowserAnimationFrame(() => calls.push(['ran-raf'])), 34);
  assert.equal(context.cancelBrowserAnimationFrame(34), true);
  await context.waitForBrowserTimeout(5);
  assert.deepEqual(calls, [
    ['timeout', 25],
    ['ran-timeout'],
    ['clear-timeout', 12],
    ['raf'],
    ['ran-raf'],
    ['cancel-raf', 34],
    ['timeout', 5],
  ]);
})();

{
  const calls = [];
  const context = loadHelper({});
  assert.equal(context.scheduleBrowserTimeout(() => calls.push('timeout')), 0);
  assert.equal(context.clearBrowserTimeout(1), false);
  assert.equal(context.scheduleBrowserAnimationFrame(() => calls.push('raf')), 0);
  assert.equal(context.cancelBrowserAnimationFrame(1), false);
  assert.deepEqual(calls, ['timeout', 'raf']);
}
