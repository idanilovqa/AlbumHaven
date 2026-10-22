'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {load, drain, nativeEnvironment} = require('./album-tops-native-fixtures/actual-native-runtime.cjs');
const {F, dataset} = require('./album-tops-membership-fixtures/full5000.cjs');
const N = 24, ZERO = {galleryCardHtml: 0, artboxHtml: 0, rowButtonHtml: 0};
const delta = (after, before) => Object.fromEntries(Object.keys(before).map(key => [key, after[key] - before[key]]));

async function fixture() {
  const env = nativeEnvironment(), data = dataset(N), original = structuredClone(data.data);
  const initial = F.state({editing: true, data: data.data}), controller = F.controllerFixture(initial);
  const searches = [], providers = {async searchAlbums(request) {searches.push({q: request.q}); return {albums: [], next_cursor: null};}};
  const {createAlbumTopDraft} = await load('album-tops/draft.mjs');
  const {mountAlbumPicker} = await load('album-tops/builder.mjs');
  const draft = createAlbumTopDraft({controller: controller.controller, providers});
  const initialItems = draft.getSnapshot().items;
  const counts = {...ZERO}, runtime = {...env.runtime,
    galleryCardHtml(config) {counts.galleryCardHtml++; return env.runtime.galleryCardHtml(config);},
    artboxHtml(config) {counts.artboxHtml++; return env.runtime.artboxHtml(config);},
    buttonHtml(config) {
      if (Object.hasOwn(config.attributes || {}, 'data-album-draft-move') || Object.hasOwn(config.attributes || {}, 'data-album-draft-remove')) counts.rowButtonHtml++;
      return env.runtime.buttonHtml(config);
    },
  };
  const props = () => {const value = draft.getSnapshot(); return {draft, value, disabled: value.busy || value.stale || value.denied};};
  let picker, unsubscribe = () => {};
  try {
    picker = mountAlbumPicker(env.host, runtime, props());
    unsubscribe = draft.subscribe(() => picker.update(props()));
  } catch (error) {picker?.dispose(); draft.dispose(); throw error;}
  const rows = () => [...env.host.querySelectorAll('[data-album-draft-key]')];
  const remember = () => new Map(rows().map(row => [row.getAttribute('data-album-draft-key'), {
    row, card: row.firstElementChild, cardMarkup: row.firstElementChild.firstElementChild,
    move: row.querySelector('[data-album-draft-move]'), remove: row.querySelector('[data-album-draft-remove]'),
  }]));
  function retained(before, expected) {
    assert.deepEqual(rows().map(row => row.getAttribute('data-album-draft-key')), expected.map(row => row.album_ref));
    for (const row of rows()) {
      const ref = row.getAttribute('data-album-draft-key'), old = before.get(ref); assert.ok(old);
      assert.equal(row, old.row, 'physical selected row is retained');
      assert.equal(row.firstElementChild, old.card, 'card host is retained');
      assert.equal(row.firstElementChild.firstElementChild, old.cardMarkup, 'canonical card DOM is retained');
      assert.equal(row.querySelector('[data-album-draft-move]'), old.move, 'native reorder handle is retained');
      assert.equal(row.querySelector('[data-album-draft-remove]'), old.remove, 'native remove control is retained');
      assert.equal(draft.getSnapshot().items.find(item => item.album_ref === ref), initialItems.find(item => item.album_ref === ref), 'draft row object is retained');
    }
  }
  function unchanged() {assert.deepEqual(initial.detail.data, original); assert.deepEqual(data.data, original); assert.deepEqual(controller.calls, []);}
  return {...env, data, draft, counts, searches, initialItems, rows, remember, retained, unchanged,
    dispose() {unsubscribe(); picker.dispose(); draft.dispose(); assert.equal(controller.listeners.size, 0, 'draft controller subscription retired'); env.assertClean();}};
}

test('actual native picker initially renders the exact 24-row browser dataset once', async () => {
  const h = await fixture();
  try {
    assert.deepEqual(h.counts, {galleryCardHtml: N, artboxHtml: N, rowButtonHtml: N * 2});
    assert.deepEqual(h.draft.getSnapshot().items, h.data.expected);
    assert.equal(h.draft.getSnapshot().tab, 'selected');
    assert.equal(h.rows().length, N); h.unchanged();
  } finally {h.dispose();}
});

test('actual native Selected query retains all rows and invokes no unchanged card, artbox or row Button renderers', async () => {
  const h = await fixture();
  try {
    const before = {...h.counts}, nodes = h.remember(), input = h.host.querySelector('input[type="search"]');
    input.focus(); h.input(input, 'Needle'); await drain();
    const state = h.draft.getSnapshot();
    assert.equal(state.query, 'Needle'); assert.equal(state.search.status, 'ready'); assert.equal(state.tab, 'selected');
    assert.equal(state.items, h.initialItems); assert.deepEqual(state.items, h.data.expected);
    assert.equal(h.host.querySelector('input[type="search"]'), input); assert.equal(h.document.activeElement, input);
    assert.deepEqual(h.searches, [{q: 'Needle'}]); h.retained(nodes, h.data.expected); h.unchanged();
    assert.deepEqual(delta(h.counts, before), ZERO);
  } finally {h.dispose();}
});

test('actual native Selected removal retains all surviving cards and invokes no surviving row renderers', async () => {
  const h = await fixture();
  try {
    const before = {...h.counts}, nodes = h.remember(), first = nodes.get(h.data.expected[0].album_ref), next = nodes.get(h.data.expected[1].album_ref);
    first.remove.focus(); h.click(first.remove); await drain();
    assert.deepEqual(h.draft.getSnapshot().items, h.data.expected.slice(1));
    assert.equal(first.row.isConnected, false); assert.equal(h.document.activeElement, next.remove);
    assert.equal(h.host.querySelector('[data-in-page-tab="selected"]').textContent, 'Selected (23)');
    h.retained(nodes, h.data.expected.slice(1)); h.unchanged();
    assert.deepEqual(delta(h.counts, before), ZERO);
  } finally {h.dispose();}
});

test('actual native End/Home reorder retains card and handle identity with zero renderer regeneration', async () => {
  const h = await fixture();
  try {
    const nodes = h.remember(), handle = nodes.get(h.data.expected[0].album_ref).move;
    const moved = [...h.data.expected.slice(1), h.data.expected[0]];
    let before = {...h.counts}; handle.focus(); handle.dispatchEvent(new h.context.Event('keydown', {key: 'End'})); await drain();
    assert.deepEqual(h.draft.getSnapshot().items, moved); h.retained(nodes, moved);
    assert.equal(h.document.activeElement, handle); assert.equal(h.host.querySelector('[aria-live="polite"]').textContent, 'Moved to position 24 of 24.');
    h.unchanged(); assert.deepEqual(delta(h.counts, before), ZERO);
    before = {...h.counts}; handle.dispatchEvent(new h.context.Event('keydown', {key: 'Home'})); await drain();
    assert.deepEqual(h.draft.getSnapshot().items, h.data.expected); h.retained(nodes, h.data.expected);
    assert.equal(h.document.activeElement, handle); assert.equal(h.host.querySelector('[aria-live="polite"]').textContent, 'Moved to position 1 of 24.');
    assert.equal(h.draft.getSnapshot().dirty, false); h.unchanged(); assert.deepEqual(delta(h.counts, before), ZERO);
  } finally {h.dispose();}
});
