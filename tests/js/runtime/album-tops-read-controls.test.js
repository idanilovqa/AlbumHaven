'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const N = require('./album-tops-native-fixtures/actual-native-runtime.cjs');
const {actualChoiceEnvironment} = require('./album-tops-native-fixtures/actual-choice-runtime.cjs');
const F = require('./album-tops-native-gallery-fixture.cjs');
const keys = f => f.host.querySelectorAll('.album-card').map(node => node.getAttribute('data-gallery-card-key'));

async function fixture(t, {data = F.detail(), phone = false} = {}) {
  const env = actualChoiceEnvironment(), c = env.context;
  c.AbortController = AbortController;
  c.innerWidth = phone ? 500 : 1200;
  c.getComputedStyle = () => ({display: 'block', columnGap: '8', overflowY: 'visible', getPropertyValue: () => ''});
  const menus = [];
  env.runtime.openChoice = (anchor, options) => {menus.push(options); return env.owner('openUtilityChoiceDropdown')(anchor, options);};
  const service = N.service(); service.data.detail = data;
  const controller = await N.preparedController(service), mounted = await N.connectedView(env, service, controller);
  t.after(() => {mounted.dispose(); env.cleanupChoiceGlobals();});
  const open = () => env.click(env.button(env.host, 'Filter'));
  const search = () => env.document.querySelector('.collection-filter-search input[type="search"]');
  const choose = (label, value) => {
    const trigger = env.document.querySelectorAll('.ui-choice button').find(node => node.getAttribute('aria-label')?.startsWith(`${label}:`));
    assert.ok(trigger); env.click(trigger);
    const menu = env.document.querySelector(`[role="menu"][aria-label="${label}"]`);
    assert.ok(menu, 'Actual native Choice owns menu');
    assert.equal(menu.getAttribute('data-choice-width'), 'anchor');
    const option = menu.querySelector(`[data-foobar-format="${value}"]`); assert.ok(option); env.click(option);
  };
  return {...env, service, controller, mounted, menus, open, search, choose};
}

test('native shared header Filter opens immediate Search and dirty-only leading Reset without a source write', async t => {
  const f = await fixture(t), filter = f.button(f.host, 'Filter');
  assert.ok(filter.closest('[data-shared-header]'));
  assert.equal(f.host.querySelectorAll('button').some(node => node.textContent.trim() === 'Reset filters' && !node.closest('[hidden]')), false);
  const original = f.controller.getSnapshot().detail.data, canonical = original.items, denominator = original.completion_summary;
  const reads = f.service.count('read'); f.open();
  const input = f.search(); assert.ok(input);
  f.input(input, 'album 12');
  assert.deepEqual(keys(f), [F.IB]);
  assert.equal(f.service.count('read'), reads); assert.equal(f.service.count('execute'), 0);
  assert.equal(f.controller.getSnapshot().detail.data.items, canonical);
  assert.equal(f.controller.getSnapshot().detail.data.completion_summary, denominator);
  const reset = f.button(f.host, 'Reset filters'); assert.equal(reset.disabled, false);
  assert.equal(reset.closest('.collection-filter-toolbar').children[0].contains(reset), true);
  assert.equal(f.search(), input, 'Immediate Search retains its input owner');
  f.click(reset); assert.deepEqual(keys(f), [F.IA, F.IB]); assert.equal(f.search().value, '');
  assert.ok(reset.closest('[hidden]'));
});

test('native Choice sorting is view-only, stable, and composes with text and manual completion', async t => {
  const data = F.detail({items: [F.row(11, {title: 'Zulu', artist: 'Same'}), F.row(12, {title: 'Alpha', artist: 'Same'})]});
  const f = await fixture(t, {data}); f.open();
  const original = f.controller.getSnapshot().detail.data.items, cards = f.host.querySelectorAll('.album-card');
  f.choose('Sort', 'album'); assert.deepEqual(keys(f), [F.IB, F.IA]);
  assert.deepEqual(f.host.querySelectorAll('.album-card'), [cards[1], cards[0]]);
  f.choose('Direction', 'desc'); assert.deepEqual(keys(f), [F.IA, F.IB]);
  f.input(f.search(), 'same'); f.choose('Manual completion', 'complete'); assert.deepEqual(keys(f), [F.IB]);
  assert.equal(f.controller.getSnapshot().detail.data.items, original);
  assert.equal(f.service.count('execute'), 0);
});

test('filtered-empty keeps enabled Filter and Reset, with whole-Top progress unchanged', async t => {
  const f = await fixture(t); f.open(); f.input(f.search(), 'no matches');
  assert.deepEqual(keys(f), []);
  assert.equal(f.button(f.host, 'Filter').disabled, false);
  assert.equal(f.button(f.host, 'Reset filters').disabled, false);
  assert.match(f.host.textContent, /No albums match these filters/);
  assert.deepEqual(f.controller.getSnapshot().detail.data.completion_summary, {completed: 1, total: 2});
  f.click(f.button(f.host, 'Reset filters')); assert.deepEqual(keys(f), [F.IA, F.IB]);
});

test('true-empty disables content controls but preserves authorized dirty Reset after source refresh', async t => {
  const f = await fixture(t); f.open(); f.input(f.search(), 'album');
  f.service.data.detail = F.detail({items: [], completion_summary: {completed: 0, total: 0}});
  await f.controller.open(N.TOP);
  assert.equal(f.button(f.host, 'Filter').disabled, true);
  assert.equal(f.host.querySelector('.unfolding-action-button'), null);
  assert.equal(f.search(), null, 'Replaced source retires its old disclosure');
  const reset = f.button(f.host, 'Reset filters'); assert.equal(reset.disabled, false);
  f.click(reset); assert.ok(reset.closest('[hidden]'));
  assert.equal(f.service.count('execute'), 0);
});

for (const permission of ['can_read', 'library.browse.read']) test(`${permission} denial retires disclosure and prevents Reset recovery from bypassing authority`, async t => {
  const f = await fixture(t); f.open(); f.input(f.search(), 'album 12');
  const staleInput = f.search(), staleReset = f.button(f.host, 'Reset filters');
  f.service.data.detail = F.detail({allowed_actions: {...F.detail().allowed_actions, [permission]: false}});
  await f.controller.open(N.TOP);
  assert.equal(f.search(), null);
  assert.equal(f.button(f.host, 'Filter').disabled, true);
  assert.ok(staleReset.disabled || staleReset.closest('[hidden]') || !staleReset.isConnected);
  f.input(staleInput, 'album 11'); f.click(staleReset);
  assert.equal(f.service.count('execute'), 0);
});

test('phone disclosure uses the native form owner and preserves values when closed and reopened', async t => {
  const f = await fixture(t, {phone: true}); f.open();
  assert.equal(f.opens.length, 1); assert.equal(f.opens[0].title, 'Top filters');
  assert.ok(f.search().closest('#app-form-modal'));
  f.input(f.search(), 'album 12'); assert.deepEqual(keys(f), [F.IB]);
  f.click(f.document.getElementById('app-form-cancel')); await N.drain();
  assert.equal(f.search(), null);
  f.open(); assert.equal(f.search().value, 'album 12');
  assert.deepEqual(keys(f), [F.IB]);
});

test('retired native Choice callbacks cannot change a replacement source', async t => {
  const f = await fixture(t); f.open(); f.choose('Sort', 'year');
  const stale = f.menus[0].onSelect;
  f.service.data.detail = F.detail({revision: '8', items: [F.row(12), F.row(11)]});
  await f.controller.open(N.TOP);
  const before = keys(f); stale('album'); assert.deepEqual(keys(f), before);
  assert.equal(f.search(), null);
});

test('new Top scope gets its own default view without retaining the prior query', async t => {
  const f = await fixture(t); f.open(); f.input(f.search(), 'album 12');
  await f.controller.open(N.OTHER);
  assert.deepEqual(keys(f), [F.IA, F.IB]);
  f.open(); assert.equal(f.search().value, '');
  assert.equal(f.service.count('execute'), 0);
});

test('registered native Filter icon survives source updates and retires all mounted owners', async t => {
  const f = await fixture(t);
  const filter = f.button(f.host, 'Filter');
  assert.ok(filter.querySelector('svg'), 'Actual Button renderer supplies the registered icon');
  assert.deepEqual(keys(f), [F.IA, F.IB], 'Gallery mount completes after the Filter control');
  f.mounted.update({});
  assert.equal(f.button(f.host, 'Filter'), filter, 'Update retains the native Button node');
  f.open();
  assert.ok(f.search(), 'Actual Search owner opens');
  f.service.data.detail = F.detail({revision: '8'});
  await f.controller.open(N.TOP);
  assert.ok(f.button(f.host, 'Filter').querySelector('svg'));
  f.open();
  assert.ok(f.search(), 'Replacement source can reopen the native disclosure');
  f.mounted.dispose();
  f.assertClean();
});

test('same-resource loading remount preserves applied query while retiring the old disclosure', async t => {
  const f = await fixture(t); f.open(); f.input(f.search(), 'album 12');
  const priorInput = f.search(), original = f.controller.getSnapshot().detail.data.items;
  f.service.data.detail = F.detail({revision: '8'});
  await f.controller.open(N.TOP);
  assert.equal(priorInput.isConnected, false);
  assert.deepEqual(keys(f), [F.IB]);
  assert.ok(f.button(f.host, 'Reset filters'));
  f.open(); assert.equal(f.search().value, 'album 12');
  assert.equal(f.controller.getSnapshot().detail.data.items.length, original.length);
  assert.equal(f.service.count('execute'), 0);
});
