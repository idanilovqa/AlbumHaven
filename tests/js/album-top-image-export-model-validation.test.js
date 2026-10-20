'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const ROOT = path.resolve(process.env.ALBUM_TOP_TEST_ROOT || path.join(__dirname, '../..'));
let projectAlbumTopImage, validateAlbumTopImageModel, layoutAlbumTopImage;
test.before(async () => {
  ({projectAlbumTopImage, validateAlbumTopImageModel, layoutAlbumTopImage} = await import(pathToFileURL(
    path.join(ROOT, 'music_app/static/js/album-tops/image-export-layout.mjs')).href));
  assert.equal(typeof validateAlbumTopImageModel, 'function');
});
function source(count = 2) {
  return {binding: {scopeKey: 'actor/library/context', topRef: 'top', revision: '1', sourceKey: 'capture'},
    complete: true, total: count, title: 'Title', description: 'Info', attribution: 'Credit',
    items: Array.from({length: count}, (_, i) => ({item_ref: `item-${i}`, album_ref: `album-${i}`,
      title: `Album ${i}`, artist: 'Artist', year: null}))};
}
function freeze(value) {
  if (value && typeof value === 'object') {for (const child of Object.values(value)) freeze(child); Object.freeze(value);}
  return value;
}
function model(count = 2, own = false) {
  const s = source(count), r = projectAlbumTopImage(s, {showOwnRating: own},
    own ? {binding: s.binding, items: s.items.map(x => ({item_ref: x.item_ref, rating: 7}))} : null);
  assert.equal(r.status, 'ready'); return r.model;
}
function fresh(copy, original) {
  assert.deepEqual(copy, original); assert.equal(Object.isFrozen(copy), true); assert.notEqual(copy, original);
  for (const key of Object.keys(copy)) if (copy[key] && typeof copy[key] === 'object') fresh(copy[key], original[key]);
}
function invalid(value) {
  const result = validateAlbumTopImageModel(value);
  assert.deepEqual(result, {status: 'invalid', code: 'invalid_source'}); assert.equal(Object.isFrozen(result), true);
}
test('safe validator returns a newly allocated deeply frozen equivalent graph, independently each time', () => {
  for (const own of [false, true]) {
    const input = model(2, own), a = validateAlbumTopImageModel(input), b = validateAlbumTopImageModel(input);
    assert.deepEqual(Object.keys(a).sort(), ['model', 'status']); assert.equal(a.status, 'ready');
    assert.equal(Object.isFrozen(a), true); fresh(a.model, input); fresh(b.model, a.model);
  }
});
test('empty model is admitted without measuring while legacy layout keeps empty_source', () => {
  const input = model(0); assert.equal(validateAlbumTopImageModel(input).status, 'ready');
  let measured = 0;
  assert.deepEqual(layoutAlbumTopImage(input, () => {measured++; throw Error('must not measure');}), {status: 'invalid', code: 'empty_source'});
  assert.equal(measured, 0);
});
for (const [name, change] of [
  ['binding', x => {x.binding.sourceKey = '';}], ['binding extra', x => {x.binding.url = '/private';}],
  ['options', x => {x.options.columns = 11;}], ['unknown option', x => {x.options.path = '/private';}],
  ['noncanonical color', x => {x.options.textColor = '#ABCDEF';}], ['numbering', x => {x.items[0].number = 2;}],
  ['duplicate identity', x => {x.items[1].albumRef = x.items[0].albumRef;}],
  ['unclean text', x => {x.title = ' A\u0085B ';}], ['oversized text', x => {x.items[0].album = 'a'.repeat(1001);}],
  ['brand', x => {x.branding = 'Other';}], ['extra rating off', x => {x.items[0].ownRating = 7;}],
  ['foreign map', x => {x.ratings = new Map();}], ['sparse', x => {delete x.items[0];}],
  ['array extra', x => {x.items.extra = 1;}], ['bad year', x => {x.items[0].year = '2000';}]
]) test(`safe validator rejects frozen malformed ${name}`, () => {const x = structuredClone(model()); change(x); invalid(freeze(x));});
test('mutable records at every graph level and exotic records are not admitted', () => {
  const original = model(); invalid(structuredClone(original));
  for (const build of [x => ({...x}), x => Object.freeze({...x, binding: {...x.binding}}),
    x => Object.freeze({...x, options: {...x.options}}), x => Object.freeze({...x, items: [...x.items]}),
    x => Object.freeze({...x, items: Object.freeze([{...x.items[0]}, x.items[1]])}),
    x => Object.freeze(Object.assign(Object.create(null), x))]) invalid(build(original));
});
test('accessors and throwing proxy errors are bounded without evaluating excluded ratings', () => {
  let reads = 0; const x = {...model()};
  Object.defineProperty(x, 'title', {enumerable: true, get() {reads++; throw Error('private-secret');}});
  invalid(Object.freeze(x)); assert.equal(reads, 0);
  const item = {...model().items[0]};
  Object.defineProperty(item, 'ownRating', {enumerable: true, get() {reads++; throw Error('private-secret');}});
  invalid(Object.freeze({...model(), items: Object.freeze([Object.freeze(item), model().items[1]])}));
  assert.equal(reads, 0);
  invalid(new Proxy({}, {getPrototypeOf() {throw Error('private-secret');}, isExtensible() {throw Error('private-secret');}}));
});
test('opted-in ratings require complete canonical per-member values', () => {
  for (const change of [x => {delete x.items[0].ownRating;}, x => {x.items[0].ownRating = 0;},
    x => {x.items[0].ownRating = '7';}, x => {x.items[0].ownRating = 11;}]) {
    const x = structuredClone(model(2, true)); change(x); invalid(freeze(x));
  }
});
test('validator does not need measurement, fonts, surfaces, DOM or resources', () => {
  // No port exists on this pure API. Poison unrelated projection fields and the opt-out map.
  const s = source(); let reads = 0;
  for (const target of [s, ...s.items]) for (const key of ['path', 'artwork_url', 'rating', 'tracks'])
    Object.defineProperty(target, key, {get() {reads++; throw Error('private-secret');}});
  const ratings = new Proxy({}, {get() {reads++; throw Error('private-secret');}, ownKeys() {reads++; throw Error('private-secret');}});
  const projected = projectAlbumTopImage(s, {}, ratings); assert.equal(projected.status, 'ready');
  assert.equal(validateAlbumTopImageModel(projected.model).status, 'ready'); assert.equal(reads, 0);
});
