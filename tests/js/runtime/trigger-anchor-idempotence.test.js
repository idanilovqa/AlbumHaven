const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
  const mutations = [];
  const node = (name, initialBounds) => {
    const classes = new Set(), properties = new Map();
    return {
      hidden: false, bounds: initialBounds,
      dataset: new Proxy({}, { set(target, key, value) {
        mutations.push(`${name}.data.${key}`); target[key] = value; return true;
      }, deleteProperty(target, key) {
        if (Object.hasOwn(target, key)) mutations.push(`${name}.data.${key}`);
        return delete target[key];
      } }),
      classList: {
        add(value) { mutations.push(`${name}.class`); classes.add(value); },
        remove(value) { mutations.push(`${name}.class`); classes.delete(value); },
        contains: value => classes.has(value),
      },
      style: {
        setProperty(key, value) {
          if (properties.get(key) !== value) mutations.push(`${name}.style.${key}`);
          properties.set(key, value);
        },
        removeProperty(key) {
          if (properties.has(key)) mutations.push(`${name}.style.${key}`);
          properties.delete(key);
        },
        getPropertyValue: key => properties.get(key) || '',
      },
      getBoundingClientRect() { return this.bounds; },
    };
  };
  const anchor = node('anchor', { left: 100, right: 134, top: 10, bottom: 44, width: 34 });
  let content = true;
  anchor.closest = () => content ? {} : null;
  const surface = node('surface', { left: 0, right: 300, top: 54, bottom: 250 });
  const context = vm.createContext({ getComputedStyle: () => ({ backgroundColor: 'rgb(237, 242, 247)' }) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/runtime/trigger-anchor.js'), 'utf8'), context);
  return { anchor, surface, mutations, context, chrome: () => { content = false; } };
}

test('unchanged anchor synchronization leaves the mounted surface and trigger untouched', () => {
  const { anchor, surface, mutations, context } = setup();
  context.syncTriggerAnchor(surface, anchor);
  assert.equal(surface.classList.contains('trigger-anchor-surface'), true);
  assert.equal(anchor.classList.contains('trigger-anchor-open'), true);
  mutations.length = 0;
  context.syncTriggerAnchor(surface, anchor);
  assert.deepEqual(mutations, []);
});

test('anchor synchronization still applies changed context, edge, side and geometry', () => {
  const { anchor, surface, mutations, context, chrome } = setup();
  context.syncTriggerAnchor(surface, anchor);
  mutations.length = 0;
  chrome();
  anchor.bounds = { left: 266, right: 300, top: 300, bottom: 334, width: 34 };
  surface.bounds = { left: 0, right: 300, top: 50, bottom: 292 };
  context.syncTriggerAnchor(surface, anchor);
  assert.equal(surface.dataset.triggerAnchorContext, 'chrome');
  assert.equal(anchor.dataset.triggerAnchorContext, 'chrome');
  assert.equal(surface.dataset.triggerAnchorEdge, 'bottom');
  assert.equal(anchor.dataset.triggerAnchorEdge, 'bottom');
  assert.equal(surface.dataset.triggerAnchorSide, 'right');
  assert.equal(surface.style.getPropertyValue('--trigger-anchor-left'), '266px');
  assert.equal(surface.style.getPropertyValue('--trigger-anchor-gap'), '8px');
  assert.equal(mutations.includes('surface.class'), false);
  context.clearTriggerAnchor(surface);
  assert.equal(surface.classList.contains('trigger-anchor-surface'), false);
  assert.equal(anchor.classList.contains('trigger-anchor-open'), false);
});
