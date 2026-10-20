'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const {withDomPlatform} = require('./artist-host-fixtures/dom-platform.cjs');
const {withPlaylistDomPlatform} = require('./playlist-dom-platform.cjs');
function fixture(t, install = withDomPlatform) {
  const base = createNativeHomeRuntime(), baseline = base.listeners(), h = install(base);
  const parent = h.document.createElement('section'), child = h.document.createElement('button');
  const inner = h.document.createElement('span'), other = h.document.createElement('button');
  parent.className = 'compound'; child.className = 'cover-lookup-task-open'; inner.className = 'inside';
  child.append(inner); parent.append(child); h.document.body.append(parent, other);
  t.after(() => {
    h.setActiveElement(null); h.setHoveredElement(null); parent.remove(); other.remove();
    assert.equal(h.document.querySelectorAll(':active').length, 0);
    const current = h.listeners();
    assert.ok(current.length === baseline.length && current.every((owner, index) => owner === baseline[index]), 'platform acquires no listeners');
  });
  return {...h, parent, child, inner, other};
}

test('active begins empty and the actual notification selector has no default target', t => {
  const h = fixture(t);
  for (const node of [h.parent, h.child, h.inner, h.other]) assert.equal(node.matches(':active'), false);
  assert.equal(h.document.querySelectorAll(':active').length, 0);
  assert.equal(h.document.querySelector('.cover-lookup-task-open:active'), null);
  assert.equal(h.child.closest(':active'), null);
});

test('explicit active target and connected ancestors match, but descendants and siblings do not', t => {
  const h = fixture(t); h.setActiveElement(h.child);
  assert.equal(h.child.matches('.cover-lookup-task-open:active'), true);
  assert.equal(h.parent.matches('.compound:active'), true);
  assert.equal(h.document.body.matches(':active'), true);
  assert.equal(h.inner.matches(':active'), false); assert.equal(h.other.matches(':active'), false);
  assert.equal(h.document.querySelector('.cover-lookup-task-open:active'), h.child);
  assert.deepEqual(h.document.querySelectorAll('.compound:active, button:active'), [h.parent, h.child]);
});

test('active descendant makes the real notification button and its ancestors active', t => {
  const h = fixture(t); h.setActiveElement(h.inner);
  assert.equal(h.inner.matches('.inside:active'), true);
  assert.equal(h.document.querySelector('.cover-lookup-task-open:active'), h.child);
  assert.equal(h.inner.closest('.compound:active'), h.parent);
  assert.equal(h.parent.querySelector('.cover-lookup-task-open:active .inside:active'), h.inner);
});

test('replacing the explicit active target retires the previous branch', t => {
  const h = fixture(t); h.setActiveElement(h.child); h.setActiveElement(h.other);
  assert.equal(h.child.matches(':active'), false); assert.equal(h.parent.matches(':active'), false);
  assert.equal(h.other.matches(':active'), true);
  assert.equal(h.document.querySelector('.cover-lookup-task-open:active'), null);
  assert.deepEqual(h.document.querySelectorAll('button:active'), [h.other]);
});

test('clearing active state is idempotent and does not retain detached or reattached UI', t => {
  const h = fixture(t); h.setActiveElement(h.inner); h.parent.remove(); h.setActiveElement(null); h.setActiveElement(null);
  h.document.body.append(h.parent);
  assert.equal(h.child.matches(':active'), false); assert.equal(h.parent.matches(':active'), false);
  assert.equal(h.document.querySelectorAll(':active').length, 0);
});

for (const removed of ['target', 'ancestor']) test(`removing the active ${removed} clears all observable active matches`, t => {
  const h = fixture(t); h.setActiveElement(h.child);
  (removed === 'target' ? h.child : h.parent).remove();
  assert.equal(h.child.matches(':active'), false); assert.equal(h.parent.matches(':active'), false);
  assert.equal(h.document.body.matches(':active'), false);
  assert.equal(h.document.querySelectorAll(':active').length, 0);
});

test('a detached same-realm element is admitted without fabricating active matches', t => {
  const h = fixture(t), detached = h.document.createElement('button');
  h.setActiveElement(h.child); h.setActiveElement(detached);
  assert.equal(detached.matches(':active'), false); assert.equal(h.child.matches(':active'), false);
  assert.equal(h.document.querySelectorAll(':active').length, 0); h.setActiveElement(null);
});

test('invalid active targets fail without mutating the current target, including foreign elements', t => {
  const h = fixture(t), foreign = fixture(t); h.setActiveElement(h.child); foreign.setActiveElement(foreign.other);
  for (const invalid of [undefined, false, 0, 'button', {}, h.document, h.document.createTextNode('x'), foreign.child]) {
    assert.throws(() => h.setActiveElement(invalid), TypeError);
    assert.equal(h.document.querySelector('.cover-lookup-task-open:active'), h.child);
    assert.equal(foreign.other.matches(':active'), true);
  }
});

test('explicit active state and cleanup remain isolated between fixture realms', t => {
  const first = fixture(t), second = fixture(t); first.setActiveElement(first.child);
  assert.equal(second.document.querySelectorAll(':active').length, 0);
  second.setActiveElement(second.other); first.setActiveElement(null); first.parent.remove();
  assert.equal(first.document.querySelectorAll(':active').length, 0);
  assert.equal(second.other.matches(':active'), true);
  assert.equal(second.document.querySelector('.cover-lookup-task-open:active'), null);
});

test('synthetic pointer mouse and keyboard events do not supply or clear browser active state', t => {
  const h = fixture(t), events = ['pointerdown', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'click', 'keydown', 'keyup'];
  for (const type of events) h.child.dispatchEvent(new h.context.Event(type));
  assert.equal(h.document.querySelectorAll(':active').length, 0);
  h.setActiveElement(h.child);
  for (const type of events) h.other.dispatchEvent(new h.context.Event(type));
  assert.equal(h.document.querySelector('.cover-lookup-task-open:active'), h.child);
  assert.equal(h.other.matches(':active'), false);
});

test('active composes with selector lists descendants scope negation and closest', t => {
  const h = fixture(t); h.setActiveElement(h.child);
  assert.equal(h.child.matches('.missing, button:active'), true);
  assert.equal(h.child.matches(':not(:active)'), false); assert.equal(h.other.matches(':not(:active)'), true);
  assert.equal(h.child.matches(':not(:not(:active))'), true);
  assert.equal(h.parent.querySelector(':scope:active .cover-lookup-task-open:active'), h.child);
  assert.equal(h.child.closest(':scope:active'), h.child);
  assert.equal(h.inner.closest('button:active'), h.child);
  assert.equal(h.parent.querySelector('.missing, :scope:active button:not(:not(:active))'), h.child);
});

test('quoted active text remains an attribute value rather than a pseudo-class', t => {
  const h = fixture(t); h.child.setAttribute('data-label', ':active');
  assert.equal(h.child.matches('[data-label=":active"]'), true);
  assert.equal(h.child.matches('[data-label=":active"]:active'), false);
  h.setActiveElement(h.child);
  assert.equal(h.child.matches('[data-label=":active"]:active'), true);
  assert.equal(h.other.matches('[data-label=":active"]'), false);
});

test('active and hover are independent explicit states with unchanged hover behavior', t => {
  const h = fixture(t); h.setHoveredElement(h.other); h.setActiveElement(h.child);
  assert.equal(h.child.matches(':active:not(:hover)'), true);
  assert.equal(h.other.matches(':hover:not(:active)'), true);
  h.setHoveredElement(h.child); assert.equal(h.child.matches(':hover:active'), true);
  h.setActiveElement(null); assert.equal(h.child.matches(':hover'), true); assert.equal(h.child.matches(':active'), false);
  h.setHoveredElement(null); assert.equal(h.document.querySelectorAll(':hover, :active').length, 0);
});

test('active syntax does not accept arbitrary suffixes pseudos or combinators, even for empty results', t => {
  const h = fixture(t), empty = h.document.createElement('div');
  const unsupported = [':actively', ':active-extra', ':active_more', ':active2', ':active()', ':focus', ':not(:active-extra)',
    ':active > button', ':active+button', '.missing, :active-extra'];
  for (const target of [null, h.child]) {
    h.setActiveElement(target);
    for (const selector of unsupported) {
      assert.throws(() => h.child.matches(selector), /Unsupported fixture selector/);
      assert.throws(() => empty.querySelectorAll(selector), /Unsupported fixture selector/);
    }
  }
});

test('the composed Playlist platform retains active and native disabled selector semantics', t => {
  const h = fixture(t, withPlaylistDomPlatform); h.setActiveElement(h.child);
  assert.equal(h.document.querySelector('.cover-lookup-task-open:active:not(:disabled)'), h.child);
  h.child.disabled = true;
  assert.equal(h.child.matches(':active:disabled'), true);
  assert.equal(h.document.querySelector('.cover-lookup-task-open:active:not(:disabled)'), null);
  h.setActiveElement(null); assert.equal(h.child.matches(':active'), false); assert.equal(h.child.matches(':disabled'), true);
});
