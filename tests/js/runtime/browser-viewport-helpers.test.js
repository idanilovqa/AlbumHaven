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
  'browser-viewport-helpers.js',
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
  const context = loadHelper({
    innerWidth: 1280,
    innerHeight: 720,
    scrollX: 33,
    scrollY: 44,
  });

  assert.deepEqual(JSON.parse(JSON.stringify(context.getViewportSize())), {
    width: 1280,
    height: 720,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(context.getViewportScrollPosition())), {
    x: 33,
    y: 44,
  });
}

{
  const context = loadHelper({
    innerWidth: 400,
    innerHeight: 300,
  });

  assert.deepEqual(JSON.parse(JSON.stringify(context.clampPositionToViewport(390, 290, 100, 80, 8))), {
    left: 292,
    top: 212,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(context.clampPositionToViewport(-20, -10, 10, 10, 6))), {
    left: 6,
    top: 6,
  });
}
