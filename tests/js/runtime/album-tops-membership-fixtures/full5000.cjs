const assert = require('node:assert/strict');
const {performance} = require('node:perf_hooks');
const F = require('./top-builder-fixtures.cjs');
const root = F.ROOT;

function dataset(count) {
  const items = Array.from({length: count}, (_, index) => ({item_ref: F.id(10000 + index),
    album_ref: F.id(20000 + index), title: `Retained ${index + 1}`, artist: 'Fixture artist', year: null,
    position: index + 1, original_position: index + 1}));
  const bindings = items.map((row, index) => ({item_ref: row.item_ref, album_ref: row.album_ref,
    ...(index % 2 === 0 ? {selected_local_album_id: index + 1, selected_source_ref: F.id(30000 + index)} : {})}));
  const data = F.detail({items, edit_draft: {items: bindings, publication_preview_required: false}});
  const expected = items.map((row, index) => ({...row, ...bindings[index]}));
  return {data, expected};
}
function setup(createAlbumTopDraft, data) {
  const fixture = F.controllerFixture(F.state({editing: true, data}));
  const provider = F.providerFixture({search: () => ({albums: [], next_cursor: null})});
  const draft = createAlbumTopDraft({controller: fixture.controller, providers: provider.providers});
  return {draft, controller: fixture.controller, writes: fixture.calls, providerCalls: provider.calls, replace: fixture.replace};
}
// Transparent Node-only read instrumentation. Values, identity and enumeration
// stay unchanged. No setter and no builtin/prototype patch is installed.
function countReads(rows, key) {
  let count = 0;
  const descriptors = rows.map(row => Object.getOwnPropertyDescriptor(row, key));
  rows.forEach((row, index) => {
    const descriptor = descriptors[index];
    assert.ok(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.configurable);
    Object.defineProperty(row, key, {enumerable: descriptor.enumerable, configurable: true,
      get() {count++; return descriptor.value;}});
  });
  return {read: () => count, reset() {count = 0;},
    restore() {rows.forEach((row, index) => Object.defineProperty(row, key, descriptors[index]));}};
}
function observe(t, phase, counter, operation) {
  counter.reset();
  const start = performance.now(), result = operation(), elapsedMs = performance.now() - start;
  const reads = counter.read();
  t.diagnostic(JSON.stringify({phase, reads, elapsedMs, qualification: 'Deterministic property-read count; elapsed time is diagnostic only'}));
  return {result, reads};
}
module.exports = {root, F, dataset, setup, countReads, observe};
