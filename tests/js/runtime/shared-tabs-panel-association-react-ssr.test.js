const test = require('node:test');
const assert = require('node:assert/strict');
const {load, nativeEnvironment} = require('./album-tops-native-fixtures/actual-native-runtime.cjs');

// Actual delivered native consumer and canonical tab renderer/listener owner.
// Counts observe delegated acquisitions; no native control is replaced.
async function render(t, items, value = 'albums') {
  const native = nativeEnvironment(), {host, runtime} = native;
  const {mountTabs} = await load('home-friends/native-controls.mjs');
  const nativeMount = runtime.mountTabs, acquisitions = [], changes = [];
  runtime.mountTabs = node => {acquisitions.push(node); return nativeMount(node);};
  const props = (items, value) => ({id: 'search-result-tabs', label: 'Search result types',
    items, value, onChange: key => changes.push(key)});
  const owner = mountTabs(host, runtime, props(items, value));
  t.after(() => {
    owner.dispose(); owner.dispose();
    assert.equal(host.childNodes.length, 0);
    assert.equal(native.listeners().filter(row => row.target === host).length, 0);
    // Native helper owns detached list listeners; it has no dispose API. Verify
    // they cannot bubble into the retired consumer, not garbage collection.
    for (const list of acquisitions) list.querySelector('button').dispatchEvent(new native.context.Event('click'));
    assert.deepEqual(changes, []);
    native.assertClean();
  });
  function check(items) {
    const tablist = host.querySelector('[role="tablist"]');
    assert.ok(tablist, 'the actual native tablist is mounted');
    assert.equal(tablist.id, 'search-result-tabs');
    assert.equal(tablist.getAttribute('aria-label'), 'Search result types');
    assert.equal(host.querySelectorAll('[role="tablist"]').length, 1);
    assert.equal(host.querySelectorAll('[role="tab"]').length, items.length);
    assert.equal(acquisitions.filter(node => node.isConnected).length, 1);
    assert.deepEqual(native.forbiddenCalls, []);
    assert.deepEqual(changes, []);
  }
  assert.equal(acquisitions.length, 1); check(items);
  return {
    get markup() {return host.innerHTML;},
    tab: key => host.querySelector(`[data-in-page-tab="${key}"]`),
    update(items, value) {const count = acquisitions.length; owner.update(props(items, value));
      assert.equal(acquisitions.length, count + 1); check(items);},
  };
}

function assertSelection(button, selected, disabled = false) {
  assert.ok(button);
  assert.equal(button.getAttribute('aria-selected'), String(selected));
  assert.equal(button.getAttribute('tabindex'), selected ? '0' : '-1');
  assert.equal(button.hasAttribute('disabled'), disabled);
  assert.equal(button.getAttribute('aria-disabled'), disabled ? 'true' : null);
}

test('actual native mount forwards each shared Tabs panelId into native aria-controls', async t => {
  const view = await render(t, [
    ['albums', 'Albums', {panelId: 'search-album-results'}],
    ['tracks', 'Tracks', {panelId: 'search-track-results'}],
  ]);
  assert.equal(view.tab('albums').getAttribute('aria-controls'), 'search-album-results');
  assert.equal(view.tab('tracks').getAttribute('aria-controls'), 'search-track-results');
  assert.equal(view.tab('albums').id, 'search-result-tabs-albums');
  assert.equal(view.tab('tracks').id, 'search-result-tabs-tracks');
  assertSelection(view.tab('albums'), true);
  assertSelection(view.tab('tracks'), false);
});

test('actual native mount keeps existing shared Tabs consumers without panelId unchanged', async t => {
  const view = await render(t, [
    ['albums', 'Albums'],
    ['tracks', 'Tracks', {}],
  ], 'tracks');
  for (const key of ['albums', 'tracks']) {
    assert.equal(view.tab(key).hasAttribute('aria-controls'), false);
  }
  assertSelection(view.tab('albums'), false);
  assertSelection(view.tab('tracks'), true);
  assert.equal(view.tab('albums').textContent, 'Albums');
  assert.equal(view.tab('tracks').textContent, 'Tracks');
});

test('actual native mount preserves disabled tabs and native enabled-selection fallback', async t => {
  const view = await render(t, [
    ['albums', 'Albums', {disabled: true, panelId: 'disabled-album-results'}],
    ['tracks', 'Tracks', {panelId: 'enabled-track-results'}],
  ], 'albums');
  assertSelection(view.tab('albums'), false, true);
  assertSelection(view.tab('tracks'), true);
  assert.equal(view.tab('albums').getAttribute('aria-controls'), 'disabled-album-results');
  assert.equal(view.tab('tracks').getAttribute('aria-controls'), 'enabled-track-results');
});

test('actual native update renders new panel IDs without stale associations', async t => {
  const view = await render(t, [
    ['albums', 'Albums', {panelId: 'previous-album-results'}],
    ['tracks', 'Tracks', {panelId: 'previous-track-results'}],
  ]);
  assert.equal(view.tab('albums').getAttribute('aria-controls'), 'previous-album-results');
  assert.equal(view.tab('tracks').getAttribute('aria-controls'), 'previous-track-results');
  view.update([
    ['albums', 'Albums', {panelId: 'current-album-results'}],
    ['tracks', 'Tracks', {panelId: 'current-track-results'}],
  ], 'tracks');
  assert.equal(view.tab('albums').getAttribute('aria-controls'), 'current-album-results');
  assert.equal(view.tab('tracks').getAttribute('aria-controls'), 'current-track-results');
  assert.doesNotMatch(view.markup, /previous-(?:album|track)-results/);
  assertSelection(view.tab('albums'), false);
  assertSelection(view.tab('tracks'), true);
});
