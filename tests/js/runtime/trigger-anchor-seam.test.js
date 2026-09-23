const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const css = fs.readFileSync(
  path.join(__dirname, '../../../music_app/static/css/runtime/trigger-anchor.css'),
  'utf8',
);
const runtimeSource = fs.readFileSync(
  path.join(__dirname, '../../../music_app/static/js/runtime/trigger-anchor.js'),
  'utf8',
);

test('connected panel masks the trigger interior seam', () => {
  assert.match(
    css,
    /\.trigger-anchor-surface::after\s*\{[^}]*linear-gradient\(var\(--trigger-anchor-background\),\s*var\(--trigger-anchor-background\)\)\s*calc\(var\(--trigger-anchor-left\) \+ 2px\) top \/ calc\(var\(--trigger-anchor-width\) - 4px\)/s,
  );
  assert.match(
    css,
    /\.trigger-anchor-open::after\s*\{[^}]*top:\s*calc\(100% - 3px\);[^}]*height:\s*calc\(var\(--trigger-anchor-gap, 0px\) \+ 3px\);/s,
  );
});

test('connected dropdown surfaces do not animate their shadow-bearing outer panel', () => {
  assert.doesNotMatch(
    css,
    /\.trigger-anchor-surface:not\(\.artist-family-panel\)\s*\{[^}]*animation\s*:/s,
  );
  assert.doesNotMatch(
    css,
    /\.trigger-anchor-surface\[data-trigger-anchor-edge="bottom"\]\s*\{[^}]*animation-name\s*:/s,
  );
});

test('open trigger preserves and shares the panel color rendered before anchor styling', () => {
  const context = vm.createContext({
    getComputedStyle: surface => ({
      getPropertyValue: property => property === '--trigger-anchor-background' ? '#fff7e5' : '',
      backgroundColor: surface.classList.contains('trigger-anchor-surface')
        ? 'rgb(255, 247, 229)' : 'rgb(237, 242, 247)',
    }),
  });
  vm.runInContext(runtimeSource, context);
  const triggerProperties = new Map();
  const surfaceProperties = new Map();
  const classes = () => {
    const values = new Set();
    return {
      add: name => values.add(name),
      remove: name => values.delete(name),
      contains: name => values.has(name),
    };
  };
  const surface = {
    hidden: false,
    dataset: {},
    classList: classes(),
    style: {
      setProperty: (name, value) => surfaceProperties.set(name, value),
      removeProperty: name => surfaceProperties.delete(name),
    },
    getBoundingClientRect: () => ({ left: 0, right: 220, top: 54, bottom: 220 }),
  };
  const anchor = {
    dataset: {},
    classList: classes(),
    style: {
      setProperty: (name, value) => triggerProperties.set(name, value),
      removeProperty: name => triggerProperties.delete(name),
    },
    closest: () => ({}),
    getBoundingClientRect: () => ({ left: 170, right: 204, top: 14, bottom: 48, width: 34 }),
  };

  context.syncTriggerAnchor(surface, anchor);
  assert.equal(triggerProperties.get('--trigger-anchor-background'), 'rgb(237, 242, 247)');
  assert.equal(surfaceProperties.get('--trigger-anchor-background'), 'rgb(237, 242, 247)');
  context.clearTriggerAnchor(surface);
  assert.equal(triggerProperties.has('--trigger-anchor-background'), false);
  assert.equal(surfaceProperties.has('--trigger-anchor-background'), false);
  assert.equal(surface.classList.contains('trigger-anchor-surface'), false);
});
