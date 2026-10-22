'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

// Independent additive sanitation regressions. The original suite is immutable.
// Root owns execution. Pure projection/layout checks do not establish UI/raster acceptance.
const ROOT = path.resolve(process.env.ALBUM_TOP_TEST_ROOT || path.join(__dirname, '../..'));
let projectAlbumTopImage, layoutAlbumTopImage;
test.before(async () => {
  ({projectAlbumTopImage, layoutAlbumTopImage} = await import(pathToFileURL(
    path.join(ROOT, 'music_app/static/js/album-tops/image-export-layout.mjs')).href));
});
function source() {
  return {binding: {scopeKey: 'actor-library-context-generation', topRef: 'top', revision: '1', sourceKey: 'capture'},
    complete: true, total: 1, title: 'Title', description: 'Info', attribution: 'Credit',
    items: [{item_ref: 'member', album_ref: 'album', title: 'Album', artist: 'Artist', year: null}]};
}
const fields = [
  ['title', (s, v) => {s.title = v;}, m => m.title],
  ['description', (s, v) => {s.description = v;}, m => m.info],
  ['attribution', (s, v) => {s.attribution = v;}, m => m.attribution],
  ['album', (s, v) => {s.items[0].title = v;}, m => m.items[0].album],
  ['artist', (s, v) => {s.items[0].artist = v;}, m => m.items[0].artist]
];
const cases = [
  ['NEXT LINE is whitespace', 'A\u0085B', 'A B'],
  ['NUL is removed, not invented whitespace', 'A\u0000B', 'AB'],
  ['Unicode whitespace runs collapse', '\u0085\u00a0A\t\u0085\u2003B\ufeff\u0085', 'A B'],
  ['control removal recollapses exposed spaces', '\u0000 A \u0000 B \u0000', 'A B'],
  ['joiners and combining marks survive beside NEXT LINE', 'e\u0301\u0085👩\u200d💻\u200c', 'e\u0301 👩\u200d💻\u200c']
];
for (const [field, set, get] of fields) for (const [name, raw, expected] of cases) {
  test(`${field}: ${name}`, () => {
    const input = source(); set(input, raw);
    const before = structuredClone(input), result = projectAlbumTopImage(input);
    assert.equal(result.status, 'ready'); assert.equal(get(result.model), expected);
    assert.deepEqual(input, before); assert.equal(Object.isFrozen(input), false);
    assert.equal(Object.isFrozen(result.model), true);
  });
}
function metric(text) {
  const width = Array.from(text).length * 8;
  return {advance: width, left: 0, right: width, ascent: 10, descent: 2};
}
test('normalized NEXT LINE/control output survives frozen-model revalidation unchanged', () => {
  const input = source(), expected = 'A B C';
  for (const [, set] of fields) set(input, '\u0000 A\u0085B \u0000 C \u0000');
  const first = projectAlbumTopImage(input, {columns: 1, showNumber: false});
  assert.equal(first.status, 'ready');
  for (const [, , get] of fields) assert.equal(get(first.model), expected);
  const snapshot = structuredClone(first.model), before = JSON.stringify(first.model);
  const one = layoutAlbumTopImage(first.model, metric, {coverSize: 256});
  const two = layoutAlbumTopImage(first.model, metric, {coverSize: 256});
  assert.equal(one.status, 'ready'); assert.equal(two.status, 'ready');
  assert.deepEqual(one, two); assert.equal(JSON.stringify(first.model), before);
  assert.deepEqual(first.model, snapshot);
  for (const kind of ['title', 'info', 'artist', 'album', 'attribution']) {
    assert.deepEqual(one.layout.texts.filter(line => line.kind === kind).map(line => line.text), [expected]);
  }
  const rebuilt = {binding: {...first.model.binding}, complete: true, total: 1,
    title: first.model.title, description: first.model.info, attribution: first.model.attribution,
    items: first.model.items.map(item => ({item_ref: item.itemRef, album_ref: item.albumRef,
      title: item.album, artist: item.artist, year: item.year}))};
  const again = projectAlbumTopImage(rebuilt, first.model.options);
  assert.equal(again.status, 'ready'); assert.deepEqual(again.model, first.model);
});
test('NEXT LINE-only attribution is empty after normalization and rejected', () => {
  const input = source(); input.attribution = '\u0085\u0085';
  assert.deepEqual(projectAlbumTopImage(input), {status: 'invalid', code: 'invalid_text'});
});
