'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {disclosureRuntime} = require('./artist-visible-fixtures/source-harness.cjs');

// Synchronous native DOM focus events are a real reentry boundary. These tests
// use the unchanged focus-capable fixture and actual registered native owner;
// no controller body, listener ordering, or callback result is supplied by tests.
function fixture({concealedBaseline = false} = {}) {
  const env = disclosureRuntime(), create = env.owner('createIntrinsicDisclosure');
  assert.equal(typeof create, 'function', 'The real registered disclosure owner must exist');
  const root = env.document.createElement('div'); env.document.body.append(root);
  function member(key, id, concealed = false) {
    const section = env.document.createElement('section'), header = env.document.createElement('header'), buttonHost = env.document.createElement('span');
    buttonHost.innerHTML = env.runtime.actionHtml({icon: 'next', ariaLabel: key, presentation: 'bare'});
    const toggle = buttonHost.firstElementChild, panel = env.document.createElement('div'), child = env.document.createElement('button');
    panel.id = id; panel.setAttribute('data-consumer-marker', id); child.textContent = 'Retained child';
    if (concealed) {panel.setAttribute('hidden', 'consumer-hidden'); panel.setAttribute('inert', 'consumer-inert');}
    header.append(buttonHost); panel.append(child); section.append(header, panel); root.append(section);
    return {key, panel, header, toggle, child, section};
  }
  const primary = member('info', 'first-info', concealedBaseline), changes = [];
  const original = {panel: primary.panel.attributePairs(), toggle: primary.toggle.attributePairs()};
  const owner = create({members: [primary], collapsed: {}, enabled: true,
    onToggle(key, closed) {changes.push([key, closed]);}});
  function focusChild(row = primary) {row.child.focus(); assert.equal(env.document.activeElement, row.child, 'positive focus setup');}
  function originalRestored(row = primary) {
    assert.deepEqual(row.panel.attributePairs(), original.panel);
    assert.deepEqual(row.toggle.attributePairs(), original.toggle);
  }
  function expanded(row = primary) {
    assert.equal(row.panel.hidden, false); assert.equal(row.panel.inert, false);
    assert.equal(row.toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(row.toggle.getAttribute('aria-controls'), row.panel.id);
    assert.equal(row.panel.getAttribute('data-consumer-marker'), row.panel.id);
  }
  return {...env, create, root, member, primary, owner, changes, focusChild, originalRestored, expanded};
}
function successorUntouched(f, mark, row) {
  assert.deepEqual(f.attributeMutations.slice(mark).filter(change => change.node === row.panel || change.node === row.toggle), [],
    'the retired operation must not mutate successor-owned attributes after the focus listener returns');
}
function teardown(f) {f.owner.dispose(); assert.deepEqual(f.forbiddenCalls, []);}

test('current-owner control evacuates focus then emits exactly one completed collapse callback', () => {
  const f = fixture(), trace = []; f.focusChild();
  f.primary.toggle.addEventListener('focus', () => trace.push([f.primary.panel.hidden, f.primary.panel.inert]), {once: true});
  f.click(f.primary.toggle);
  assert.deepEqual(trace, [[false, false]]); assert.equal(f.document.activeElement, f.primary.toggle);
  assert.deepEqual(f.changes, [['info', true]]); assert.equal(f.primary.panel.hidden, true); assert.equal(f.primary.panel.inert, true);
  assert.equal(f.primary.panel.getAttribute('data-consumer-marker'), 'first-info');
  teardown(f); f.originalRestored();
});

test('dispose from collapse focus listener prevents stale callback and all post-disposal mutation', () => {
  const f = fixture(); f.focusChild(); let disposed = false, mark = null;
  f.primary.toggle.addEventListener('focus', () => {
    f.owner.dispose(); disposed = true; mark = f.attributeMutations.length;
  }, {once: true});
  f.click(f.primary.toggle);
  assert.equal(disposed, true, 'the synchronous focus listener actually ran');
  assert.deepEqual(f.changes, [], 'the original click cannot announce a toggle after disposal');
  f.originalRestored(); successorUntouched(f, mark, f.primary);
  f.click(f.primary.toggle); assert.deepEqual(f.changes, []); teardown(f);
});

test('replacement from collapse focus listener retires the old click without changing successor choices', () => {
  const f = fixture(), next = f.member('info', 'replacement-info'); f.focusChild(); let replaced = false, mark = null;
  f.primary.toggle.addEventListener('focus', () => {
    f.owner.update({members: [next], collapsed: {}, enabled: true}); replaced = true; mark = f.attributeMutations.length;
  }, {once: true});
  f.click(f.primary.toggle);
  assert.equal(replaced, true); assert.deepEqual(f.changes, [], 'same semantic key does not preserve the old DOM operation');
  f.originalRestored(); f.expanded(next); successorUntouched(f, mark, next);
  f.click(f.primary.toggle); assert.deepEqual(f.changes, []);
  f.click(next.toggle); assert.deepEqual(f.changes, [['info', true]], 'the successor has one live current handler');
  assert.equal(next.panel.hidden, true); teardown(f);
});

test('disable from collapse focus listener suppresses stale callback and releases the previous attributes', () => {
  const f = fixture(); f.focusChild(); let disabled = false, mark = null;
  f.primary.toggle.addEventListener('focus', () => {
    f.owner.update({enabled: false}); disabled = true; mark = f.attributeMutations.length;
  }, {once: true});
  f.click(f.primary.toggle);
  assert.equal(disabled, true); assert.deepEqual(f.changes, []); f.originalRestored(); successorUntouched(f, mark, f.primary);
  f.click(f.primary.toggle); assert.deepEqual(f.changes, []);
  f.owner.update({collapsed: {}, enabled: true}); f.expanded();
  f.click(f.primary.toggle); assert.deepEqual(f.changes, [['info', true]], 'a later enabled operation still works'); teardown(f);
});

test('disable then reenable inside one focus listener does not revive the earlier click generation', () => {
  const f = fixture(); f.focusChild(); let renewed = false, mark = null;
  f.primary.toggle.addEventListener('focus', () => {
    f.owner.update({enabled: false}); f.owner.update({collapsed: {}, enabled: true});
    renewed = true; mark = f.attributeMutations.length;
  }, {once: true});
  f.click(f.primary.toggle);
  assert.equal(renewed, true); assert.deepEqual(f.changes, [], 'active again is not proof that the original click is current');
  f.expanded(); successorUntouched(f, mark, f.primary);
  f.click(f.primary.toggle); assert.deepEqual(f.changes, [['info', true]]); teardown(f);
});

test('release focus reenable cannot be overwritten by the older restore of hidden and inert baseline', () => {
  const f = fixture({concealedBaseline: true}); f.expanded(); f.focusChild(); let renewed = false, mark = null;
  f.primary.toggle.addEventListener('focus', () => {
    f.owner.update({collapsed: {}, enabled: true}); renewed = true; mark = f.attributeMutations.length;
  }, {once: true});
  f.owner.update({enabled: false});
  assert.equal(renewed, true, 'restoring concealed baseline must evacuate focus');
  assert.deepEqual(f.changes, []); f.expanded(); successorUntouched(f, mark, f.primary);
  f.click(f.primary.toggle); assert.deepEqual(f.changes, [['info', true]], 'renewed member retains its current handler');
  teardown(f); f.originalRestored();
});

test('release focus replacement survives outer membership removal and keeps its own live handler', () => {
  const f = fixture({concealedBaseline: true}), next = f.member('info', 'release-replacement');
  f.focusChild(); let replaced = false, mark = null;
  f.primary.toggle.addEventListener('focus', () => {
    f.owner.update({members: [next], collapsed: {}, enabled: true}); replaced = true; mark = f.attributeMutations.length;
  }, {once: true});
  f.owner.update({members: []});
  assert.equal(replaced, true); assert.deepEqual(f.changes, []); f.originalRestored(); f.expanded(next); successorUntouched(f, mark, next);
  f.click(f.primary.toggle); assert.deepEqual(f.changes, []);
  f.click(next.toggle); assert.deepEqual(f.changes, [['info', true]], 'older reconcile must not erase the focus-installed successor');
  assert.equal(next.panel.hidden, true); teardown(f);
});

test('release focus disposal completes exact baseline cleanup without stale callbacks or leaked listeners', () => {
  const f = fixture({concealedBaseline: true}); f.focusChild(); let disposed = false;
  f.primary.toggle.addEventListener('focus', () => {f.owner.dispose(); disposed = true;}, {once: true});
  f.owner.update({enabled: false});
  assert.equal(disposed, true); assert.deepEqual(f.changes, []); f.originalRestored();
  assert.equal(f.document.activeElement, f.primary.toggle);
  f.click(f.primary.toggle); f.owner.update({enabled: true, collapsed: {info: true}});
  f.originalRestored(); assert.deepEqual(f.changes, []); teardown(f);
});
