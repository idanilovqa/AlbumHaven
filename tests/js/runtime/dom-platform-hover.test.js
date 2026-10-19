'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const {withDomPlatform} = require('./artist-host-fixtures/dom-platform.cjs');
function fixture() {
  const h = withDomPlatform(createNativeHomeRuntime());
  const parent = h.document.createElement('div'), child = h.document.createElement('button'), other = h.document.createElement('button');
  parent.className = 'compound'; parent.append(child); h.document.body.append(parent, other);
  return {...h, parent, child, other};
}
test('hover is initially empty and explicitly tracks a connected target and its ancestors', () => {
  const h = fixture();
  assert.equal(h.child.matches(':hover'), false);
  assert.equal(h.document.querySelectorAll(':hover').length, 0);
  h.setHoveredElement(h.child);
  assert.equal(h.child.matches('button:hover'), true);
  assert.equal(h.parent.matches('.compound:hover'), true);
  assert.equal(h.other.matches(':hover'), false);
  assert.equal(h.document.querySelector('button:hover'), h.child);
  assert.equal(h.child.closest('.compound:hover'), h.parent);
  assert.equal(h.parent.querySelector(':scope:hover button:hover'), h.child);
  assert.equal(h.child.matches(':not(:hover)'), false);
  assert.equal(h.other.matches(':not(:hover)'), true);
  assert.equal(h.child.matches('.missing, button:hover'), true);
  h.setHoveredElement(h.other);
  assert.equal(h.child.matches(':hover'), false);
  assert.equal(h.parent.matches(':hover'), false);
  assert.equal(h.other.matches(':hover'), true);
  h.setHoveredElement(null);
  assert.equal(h.document.querySelectorAll(':hover').length, 0);
});
test('hover ignores synthetic events, disconnected targets and foreign fixture nodes', () => {
  const h = fixture();
  h.child.dispatchEvent(new h.context.Event('pointerenter'));
  assert.equal(h.child.matches(':hover'), false, 'dispatchEvent does not perform browser hit testing');
  h.setHoveredElement(h.child); h.parent.remove();
  assert.equal(h.child.matches(':hover'), false);
  assert.equal(h.parent.matches(':hover'), false);
  assert.equal(h.document.querySelectorAll(':hover').length, 0);
  assert.throws(() => h.setHoveredElement({}), TypeError);
  assert.throws(() => h.setHoveredElement(h.document), TypeError);
  assert.throws(() => h.setHoveredElement(h.document.createTextNode('x')), TypeError);
  assert.throws(() => h.setHoveredElement(fixture().child), TypeError);
});
test('hover parsing preserves quoted attributes and rejects unknown or malformed selectors even without candidates', () => {
  const h = fixture(), empty = h.document.createElement('div');
  h.child.setAttribute('data-label', ':hover');
  assert.equal(h.child.matches('[data-label=":hover"]'), true);
  assert.equal(h.child.matches('[data-label=":hover"]:hover'), false);
  h.setHoveredElement(h.child);
  assert.equal(h.child.matches('[data-label=":hover"]:hover'), true);
  for (const selector of [':hovering', ':hover-extra', ':hover()', ':focus', ':active', ':not(:focus)', ':hover > button']) {
    assert.throws(() => h.child.matches(selector), /Unsupported fixture selector/);
    assert.throws(() => empty.querySelectorAll(selector), /Unsupported fixture selector/);
  }
});
