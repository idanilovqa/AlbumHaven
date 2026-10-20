'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

// Pure arithmetic/model tests. No browser, real fonts, decoded pixels or download
// acceptance is claimed. Root owns execution against the admitted source tree.
const ROOT = path.resolve(process.env.ALBUM_TOP_TEST_ROOT || path.join(__dirname, '../..'));
let projectAlbumTopImage, albumTopImageRowSteps, albumTopImageGrid, layoutAlbumTopImage;
test.before(async () => {
  ({projectAlbumTopImage, albumTopImageRowSteps, albumTopImageGrid, layoutAlbumTopImage} =
    await import(pathToFileURL(path.join(ROOT, 'music_app/static/js/album-tops/image-export-layout.mjs')).href));
});

const FONT = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const BINDING = {scopeKey: 'actor/library/context/generation', topRef: 'top-one', revision: '7', sourceKey: 'capture-one'};
const DEFAULTS = {columns: 4, showTitle: true, showInfo: true, showArtist: true, showAlbum: true,
  showYear: true, showNumber: true, showOwnRating: false, numberPlacement: 'on',
  backgroundColor: '#ffffff', textColor: '#111111', frameColor: '#111111', frameWidth: 1, roundedCorners: false};
const BARE = {columns: 1, showTitle: false, showInfo: false, showArtist: false, showAlbum: false,
  showYear: false, showNumber: false};
const source = (count = 1) => ({binding: {...BINDING}, complete: true, total: count,
  title: 'A Top', description: 'Information', attribution: 'C', items: Array.from({length: count}, (_, i) =>
    ({item_ref: `member-${i + 1}`, album_ref: `album-${i + 1}`, title: `Album ${i + 1}`, artist: `Artist ${i + 1}`, year: 2000 + i % 20}))});
function freeze(value) {
  if (value && typeof value === 'object') {for (const child of Object.values(value)) freeze(child); Object.freeze(value);}
  return value;
}
function frozenPlain(value) {
  if (!value || typeof value !== 'object') {assert.ok(['string', 'number', 'boolean'].includes(typeof value) || value === null); return;}
  assert.equal(Object.isFrozen(value), true);
  assert.ok(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype);
  for (const key of Reflect.ownKeys(value)) {
    assert.equal(typeof key, 'string');
    if (Array.isArray(value) && key === 'length') continue;
    frozenPlain(value[key]);
  }
}
function exactKeys(value, keys) {assert.deepEqual(Object.keys(value).sort(), [...keys].sort());}
function invalid(result, code) {
  assert.equal(result.status, 'invalid');
  exactKeys(result, ['status', 'code']);
  assert.equal(typeof result.code, 'string');
  if (code) assert.equal(result.code, code);
}
function projected(input = source(), options = {}, ratings = null) {
  const result = projectAlbumTopImage(input, options, ratings);
  assert.equal(result.status, 'ready', JSON.stringify(result));
  exactKeys(result, ['status', 'model']); frozenPlain(result);
  return result.model;
}
function metric(text, style) {
  return {advance: Array.from(text).length * 8, left: 0, right: Array.from(text).length * 8,
    ascent: 10, descent: 2};
}
function laid(model = projected(), measure = metric, options) {
  const result = layoutAlbumTopImage(model, measure, options);
  assert.equal(result.status, 'ready', JSON.stringify(result));
  exactKeys(result, ['status', 'layout']); frozenPlain(result);
  return result.layout;
}
function ratingsFor(input, rating = 7) {
  return {binding: {...input.binding}, items: input.items.map(item => ({item_ref: item.item_ref, rating}))};
}
function poison(object, keys) {
  for (const key of keys) Object.defineProperty(object, key, {enumerable: true, get() {throw new Error(`Excluded getter ${key}`);}});
  return object;
}
function assertRect(rect, outer) {
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Number.isFinite(rect[key]), key);
  assert.ok(rect.x >= outer.x && rect.y >= outer.y);
  assert.ok(rect.width >= 0 && rect.height >= 0);
  assert.ok(rect.x + rect.width <= outer.x + outer.width + 1e-8);
  assert.ok(rect.y + rect.height <= outer.y + outer.height + 1e-8);
}
function checkLayout(layout, model, measure = metric) {
  exactKeys(layout, ['binding', 'width', 'height', 'pixelCount', 'grid', 'options', 'fontFamily', 'texts', 'items', 'branding']);
  assert.deepEqual(layout.binding, model.binding); assert.notEqual(layout.binding, model.binding);
  assert.deepEqual(layout.options, model.options); assert.notEqual(layout.options, model.options);
  assert.equal(layout.fontFamily, FONT);
  assert.ok(Number.isInteger(layout.width) && layout.width > 0 && layout.width <= 16384);
  assert.ok(Number.isInteger(layout.height) && layout.height > 0 && layout.height <= 16384);
  assert.equal(layout.pixelCount, layout.width * layout.height); assert.ok(layout.pixelCount <= 32000000);
  const canvas = {x: 0, y: 0, width: layout.width, height: layout.height};
  assertRect(layout.grid, canvas); assertRect(layout.branding, canvas);
  assert.deepEqual(layout.items.map(item => [item.itemRef, item.albumRef, item.number]),
    model.items.map(item => [item.itemRef, item.albumRef, item.number]));
  for (const item of layout.items) {
    exactKeys(item, ['itemRef', 'albumRef', 'number', 'row', 'column', 'x', 'y', 'width', 'height', 'cover', 'numberBadge']);
    assertRect(item, canvas); assertRect(item.cover, item);
    exactKeys(item.cover, ['x', 'y', 'width', 'height', 'radius', 'frameWidth', 'frameColor', 'opacity', 'filter']);
    assert.equal(item.cover.width, item.cover.height); assert.equal(item.cover.opacity, 1); assert.equal(item.cover.filter, 'none');
    assert.equal(item.cover.frameWidth, model.options.frameWidth); assert.equal(item.cover.frameColor, model.options.frameColor);
    if (item.numberBadge) {exactKeys(item.numberBadge, ['x', 'y', 'width', 'height', 'color']); assertRect(item.numberBadge, item.cover);}
  }
  for (const text of layout.texts) {
    exactKeys(text, ['kind', 'itemRef', 'text', 'x', 'y', 'width', 'height', 'baselineX', 'baseline', 'fontSize', 'fontWeight', 'color']);
    assert.equal(typeof text.kind, 'string'); assert.equal(typeof text.text, 'string'); assert.ok(text.text.length);
    assert.equal(text.color, model.options.textColor); assertRect(text, canvas);
    const m = measure(text.text, {fontFamily: FONT, fontSize: text.fontSize, fontWeight: text.fontWeight});
    assert.equal(text.width, Math.max(m.advance, m.right) - Math.min(0, m.left));
    assert.equal(text.baselineX, text.x - Math.min(0, m.left)); assert.equal(text.baseline, text.y + m.ascent);
    assert.equal(text.height, Math.max(Math.ceil(1.3 * text.fontSize), Math.ceil(m.ascent + m.descent)));
    assert.ok(text.baselineX + m.left >= text.x - 1e-8);
    assert.ok(text.baselineX + m.right <= text.x + text.width + 1e-8);
    assert.ok(text.baseline - m.ascent >= text.y && text.baseline + m.descent <= text.y + text.height + 1e-8);
    if (text.itemRef !== null) {
      const item = layout.items.find(value => value.itemRef === text.itemRef); assert.ok(item); assertRect(text, item);
      if (item.numberBadge && text.text === String(item.number)) assertRect(text, item.numberBadge);
    }
  }
  assert.equal(layout.branding.width, 24); assert.equal(layout.branding.height, 24);
  assert.ok(layout.branding.y >= Math.max(...layout.items.map(item => item.y + item.height)) + 24);
}
function replaceSegmenter(t, value) {
  const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter');
  Object.defineProperty(Intl, 'Segmenter', {value, configurable: true, writable: true});
  t.after(() => Object.defineProperty(Intl, 'Segmenter', descriptor));
}

test('projection copies exact allowlisted shapes and native reversible defaults', () => {
  const input = source(3), model = projected(input);
  exactKeys(model, ['binding', 'title', 'info', 'attribution', 'branding', 'options', 'items']);
  assert.deepEqual(model.binding, BINDING); assert.deepEqual(model.options, DEFAULTS);
  assert.equal(model.title, input.title); assert.equal(model.info, input.description); assert.equal(model.attribution, 'C');
  assert.equal(model.branding, 'AlbumHaven');
  for (let i = 0; i < model.items.length; i++) {
    exactKeys(model.items[i], ['itemRef', 'albumRef', 'number', 'artist', 'album', 'year']);
    assert.deepEqual(model.items[i], {itemRef: `member-${i + 1}`, albumRef: `album-${i + 1}`, number: i + 1,
      artist: `Artist ${i + 1}`, album: `Album ${i + 1}`, year: 2000 + i});
  }
});

test('inputs stay mutable, are not retained, and outputs are fresh recursively frozen graphs', () => {
  const input = source(2), options = {columns: 2}, own = ratingsFor(input, 8);
  options.showOwnRating = true;
  const before = structuredClone({input, options, own}), one = projected(input, options, own), two = projected(input, options, own);
  assert.deepEqual({input, options, own}, before); assert.deepEqual(one, two); assert.notEqual(one, two);
  for (const value of [input, input.binding, input.items, input.items[0], options, own, own.items]) assert.equal(Object.isFrozen(value), false);
  input.binding.scopeKey = 'changed'; input.items[0].title = 'changed'; options.columns = 10; own.items[0].rating = 1;
  assert.equal(one.binding.scopeKey, BINDING.scopeKey); assert.equal(one.items[0].album, 'Album 1');
  assert.equal(one.options.columns, 2); assert.equal(one.items[0].ownRating, 8);
  const layoutOne = laid(one), layoutTwo = laid(one); assert.deepEqual(layoutOne, layoutTwo);
  assert.notEqual(layoutOne, layoutTwo); assert.notEqual(layoutOne.items[0], layoutTwo.items[0]);
});

test('complete ordered 5000-member capture is preserved without label dedupe or truncation', () => {
  const input = source(5000); for (const item of input.items) {item.title = ''; item.artist = 'Same'; item.year = null;}
  input.items.reverse(); const model = projected(input);
  assert.equal(model.items.length, 5000);
  assert.deepEqual(model.items.map(x => x.itemRef), input.items.map(x => x.item_ref));
  assert.deepEqual(model.items.map(x => x.number), Array.from({length: 5000}, (_, i) => i + 1));
  invalid(layoutAlbumTopImage(model, metric, {coverSize: 128}), 'side_limit');
  assert.equal(model.items.length, 5000);
});

for (const [label, mutate, code] of [
  ['not complete', x => {x.complete = false;}, 'incomplete_source'],
  ['count mismatch', x => {x.total++;}, 'incomplete_source'],
  ['sparse membership', x => {delete x.items[0];}, 'incomplete_source'],
  ['negative count', x => {x.total = -1;}, 'incomplete_source'],
  ['fractional count', x => {x.total = 1.5;}, 'incomplete_source'],
  ['coerced count', x => {x.total = '1';}, 'incomplete_source'],
  ['unsafe count', x => {x.total = Number.MAX_SAFE_INTEGER + 1;}, 'incomplete_source'],
  ['over cap', x => {x.total = 5001; x.items = Array(5001).fill(x.items[0]);}, 'incomplete_source'],
  ['duplicate member', x => {x.items.push({...x.items[0], album_ref: 'other'}); x.total = 2;}, 'duplicate_member'],
  ['duplicate album', x => {x.items.push({...x.items[0], item_ref: 'other'}); x.total = 2;}, 'duplicate_member']
]) test(`projection rejects ${label} atomically`, () => {const input = source(); mutate(input); invalid(projectAlbumTopImage(input), code);});

for (const value of [null, undefined, false, 1, 'source', [], {}]) test(`invalid source envelope ${String(value)}`, () => invalid(projectAlbumTopImage(value), 'invalid_source'));
for (const field of Object.keys(BINDING)) for (const value of ['', 1, '\u0001x', 'x\u0080', 'x\ud800', 'x'.repeat(4097)]) {
  test(`binding ${field} rejects ${typeof value}:${String(value).length}`, () => {
    const input = source(); input.binding[field] = value; invalid(projectAlbumTopImage(input), 'invalid_binding');
  });
}
test('binding limits count UTF-16 units and copy permitted opaque strings exactly', () => {
  const input = source(); input.binding.scopeKey = '😀'.repeat(2048); input.binding.sourceKey = '  opaque  ';
  assert.equal(projected(input).binding.scopeKey, input.binding.scopeKey); assert.equal(projected(input).binding.sourceKey, '  opaque  ');
  input.binding.scopeKey += 'a'; invalid(projectAlbumTopImage(input), 'invalid_binding');
});
test('member identities are bounded, unique opaque values with no label inference', () => {
  const input = source(2); input.items[0].item_ref = 'x'.repeat(256); input.items[1].title = input.items[0].title;
  assert.equal(projected(input).items.length, 2);
  for (const field of ['item_ref', 'album_ref']) for (const value of ['', 2, 'x'.repeat(257), 'x\u0000', 'x\u0080', 'x\udfff']) {
    const bad = source(); bad.items[0][field] = value; invalid(projectAlbumTopImage(bad));
  }
});
for (const value of [0, -1, 10000, 1.5, '2001', NaN, Infinity, undefined]) test(`year strict rejection ${String(value)}`, () => {
  const input = source(); input.items[0].year = value; invalid(projectAlbumTopImage(input));
});
test('year null and inclusive boundaries remain exact', () => {
  const input = source(3); [null, 1, 9999].forEach((value, i) => {input.items[i].year = value;});
  assert.deepEqual(projected(input).items.map(x => x.year), [null, 1, 9999]);
});

test('display sanitation removes controls/bidi but retains literal text, joiners and combining marks', () => {
  const input = source(), raw = ' \tA\r\nB\u00a0\u2003C\u2028D\u0001\u0080\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069<svg>e\u0301\u200c👩\u200d💻\ud800 ';
  const expected = 'A B C D<svg>e\u0301\u200c👩\u200d💻\ufffd';
  input.title = input.description = input.attribution = input.items[0].title = input.items[0].artist = raw;
  const model = projected(input);
  assert.deepEqual([model.title, model.info, model.attribution, model.items[0].album, model.items[0].artist], Array(5).fill(expected));
});
test('1000 Unicode code points accepted, 1001 rejected before normalization for every display field', () => {
  for (const field of ['title', 'description', 'attribution', 'album', 'artist']) {
    const put = (input, text) => field === 'album' ? input.items[0].title = text : field === 'artist' ? input.items[0].artist = text : input[field] = text;
    let input = source(); put(input, '😀'.repeat(1000)); projected(input);
    input = source(); put(input, '😀'.repeat(1001)); invalid(projectAlbumTopImage(input), 'invalid_text');
    input = source(); put(input, ' '.repeat(1001)); invalid(projectAlbumTopImage(input), 'invalid_text');
  }
  const input = source(); input.attribution = '\u0001\u202e \t'; invalid(projectAlbumTopImage(input), 'invalid_text');
});
test('projection failure precedence is envelope/binding, completeness, text, options, opted-in ratings', () => {
  const input = source(); input.binding.scopeKey = ''; input.complete = false; input.title = null;
  invalid(projectAlbumTopImage(input, {columns: 0}), 'invalid_binding'); input.binding = {...BINDING};
  invalid(projectAlbumTopImage(input, {columns: 0}), 'incomplete_source'); input.complete = true;
  invalid(projectAlbumTopImage(input, {columns: 0}), 'invalid_text'); input.title = 'Top';
  invalid(projectAlbumTopImage(input, {columns: 0, showOwnRating: true}, null), 'invalid_options');
});

test('privacy getters and opted-out rating snapshot are never inspected', () => {
  const input = source(); poison(input, ['progress', 'favorites', 'history', 'peer_taste', 'paths', 'asset_url', 'source_proof', 'top_viewer_overlay']);
  poison(input.items[0], ['rating', 'ownRating', 'peerRating', 'progress', 'plays', 'duration', 'tracks', 'path', 'artwork_url', 'availability']);
  const own = new Proxy({}, {get() {throw new Error('opt-out inspected ratings');}, ownKeys() {throw new Error('opt-out enumerated ratings');}});
  const model = projected(input, {}, own); assert.equal(Object.hasOwn(model.items[0], 'ownRating'), false);
  const layout = laid(model); checkLayout(layout, model);
  for (const marker of ['peer_taste', 'source_proof', 'top_viewer_overlay', 'artwork_url', 'availability']) assert.equal(JSON.stringify({model, layout}).includes(marker), false);
});
test('own rating explicit full same-binding map can be reordered and preserves null as absent text', () => {
  const input = source(3), own = ratingsFor(input); own.items[0].rating = null; own.items[1].rating = 1; own.items[2].rating = 10; own.items.reverse();
  const model = projected(input, {showOwnRating: true}, own);
  assert.deepEqual(model.items.map(x => x.ownRating), [null, 1, 10]);
  const text = laid(model).texts.map(x => x.text);
  assert.ok(text.includes('Rating: 1/10')); assert.ok(text.includes('Rating: 10/10')); assert.equal(text.some(x => /Rating: null/.test(x)), false);
});
for (const field of Object.keys(BINDING)) test(`own rating mismatched ${field} cannot enter image`, () => {
  const input = source(), own = ratingsFor(input); own.binding[field] += '-other';
  invalid(projectAlbumTopImage(input, {showOwnRating: true}, own), 'invalid_own_ratings');
});
for (const [label, mutate] of [
  ['missing member', x => {x.items.pop();}], ['duplicate member', x => {x.items[1] = {...x.items[0]};}],
  ['foreign member', x => {x.items[0].item_ref = 'foreign';}], ['sparse snapshot', x => {delete x.items[0];}],
  ['missing binding', x => {delete x.binding;}], ['invalid zero', x => {x.items[0].rating = 0;}],
  ['invalid eleven', x => {x.items[0].rating = 11;}], ['fraction', x => {x.items[0].rating = 1.5;}],
  ['coercion', x => {x.items[0].rating = '7';}], ['unknown rating', x => {delete x.items[0].rating;}]
]) test(`own rating rejects ${label}`, () => {const input = source(2), own = ratingsFor(input); mutate(own); invalid(projectAlbumTopImage(input, {showOwnRating: true}, own), 'invalid_own_ratings');});

for (const [key, value] of [
  ['columns', 0], ['columns', 11], ['columns', 1.2], ['columns', '2'], ['frameWidth', 0], ['frameWidth', 13], ['frameWidth', '1'],
  ['numberPlacement', 'left'], ['showOwnRating', 1], ['roundedCorners', 'true'], ['showTitle', null], ['showInfo', undefined],
  ['backgroundColor', 'red'], ['backgroundColor', '#fff'], ['textColor', '#11223344'], ['frameColor', 'url(secret)'],
  ['backgroundColor', 'linear-gradient(red,blue)'], ['fontFamily', 'other'], ['url', 'https://secret.test/']
]) test(`options reject ${key}:${String(value)}`, () => invalid(projectAlbumTopImage(source(), {[key]: value}), 'invalid_options'));
test('options canonicalize only hex case, retain independent colors, frame boundaries and booleans', () => {
  const options = {columns: 10, backgroundColor: '#ABCDEF', textColor: '#012ABC', frameColor: '#FEDCBA', frameWidth: 12,
    roundedCorners: true, showTitle: false, showInfo: false, numberPlacement: 'below'};
  const model = projected(source(), options);
  assert.equal(model.options.backgroundColor, '#abcdef'); assert.equal(model.options.textColor, '#012abc');
  assert.equal(model.options.frameColor, '#fedcba'); assert.equal(model.options.frameWidth, 12);
});

for (const count of [0, 1, 7, 20, 37, 5000]) test(`reachable grid is complete and exactly round-trips at count ${count}`, () => {
  const expected = [...new Set(Array.from({length: Math.min(10, count)}, (_, i) => Math.ceil(count / (i + 1))))].sort((a, b) => a - b);
  const steps = albumTopImageRowSteps(count); assert.deepEqual(steps, expected); frozenPlain(steps);
  for (let columns = 1; columns <= 10; columns++) {
    const grid = albumTopImageGrid(count, {columns}); frozenPlain(grid); exactKeys(grid, ['columns', 'rows', 'rowIndex', 'rowSteps']);
    assert.equal(grid.columns, Math.min(count, columns)); assert.equal(grid.rows, count ? Math.ceil(count / grid.columns) : 0);
    assert.deepEqual(grid.rowSteps, expected); assert.equal(grid.rowIndex, count ? expected.indexOf(grid.rows) : null);
    if (count) {assert.ok((grid.rows - 1) * grid.columns < count); assert.ok(grid.rows * grid.columns >= count);}
  }
  for (const rowIndex of [...expected.keys(), ...[...expected.keys()].reverse()]) {
    const grid = albumTopImageGrid(count, {rowIndex});
    assert.equal(grid.rows, expected[rowIndex]); assert.equal(grid.columns, Math.ceil(count / expected[rowIndex])); assert.equal(grid.rowIndex, rowIndex);
    assert.equal(albumTopImageGrid(count, {columns: grid.columns}).rowIndex, rowIndex);
  }
});
test('Height ordinary incremental forward/reverse states cross every 20-album gap', () => {
  assert.deepEqual(albumTopImageRowSteps(20), [2, 3, 4, 5, 7, 10, 20]);
  assert.deepEqual([3, 4, 5, 6, 5, 4, 3].map(rowIndex => albumTopImageGrid(20, {rowIndex}).rows), [5, 7, 10, 20, 10, 7, 5]);
});
for (const value of [-1, 5001, 1.5, '1', null, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER]) test(`grid rejects invalid count ${String(value)}`, () => {
  assert.throws(() => albumTopImageRowSteps(value), TypeError); assert.throws(() => albumTopImageGrid(value, {columns: 1}), TypeError);
});
for (const selection of [undefined, null, {}, {columns: 0}, {columns: 11}, {columns: '2'}, {columns: 1.5},
  {rowIndex: -1}, {rowIndex: 7}, {rowIndex: '1'}, {rowIndex: 1.5}, {columns: 1, rowIndex: 0}, {columns: 1, extra: true}]) {
  test(`grid rejects selection ${JSON.stringify(selection)}`, () => assert.throws(() => albumTopImageGrid(20, selection), TypeError));
}
test('empty capture has no nominal image and only columns grid selection is valid', () => {
  const model = projected(source(0)); assert.deepEqual(albumTopImageGrid(0, {columns: 4}), {columns: 0, rows: 0, rowIndex: null, rowSteps: []});
  assert.throws(() => albumTopImageGrid(0, {rowIndex: 0}), TypeError);
  let calls = 0; invalid(layoutAlbumTopImage(model, () => {calls++; return metric('x');}), 'empty_source'); assert.equal(calls, 0);
});

test('exact bare one-card geometry includes native footer and all margins', () => {
  const model = projected(source(), BARE), layout = laid(model, metric, {coverSize: 128}); checkLayout(layout, model);
  assert.equal(layout.width, 176); assert.equal(layout.height, 248); assert.equal(layout.pixelCount, 43648);
  assert.deepEqual({...layout.grid}, {columns: 1, rows: 1, rowIndex: 0, rowSteps: [1], x: 24, y: 24, width: 128, height: 128});
  assert.deepEqual(layout.branding, {x: 32, y: 176, width: 24, height: 24});
  assert.deepEqual(layout.items[0].cover, {x: 24, y: 24, width: 128, height: 128, radius: 0, frameWidth: 1, frameColor: '#111111', opacity: 1, filter: 'none'});
  const brand = layout.texts.find(x => x.text === 'AlbumHaven'), credit = layout.texts.find(x => x.text === 'C');
  assert.equal(brand.x, 64); assert.equal(brand.y, 177.5); assert.equal(brand.height, 21);
  assert.equal(credit.x, 84); assert.equal(credit.y, 208); assert.equal(credit.height, 16);
  assert.equal(credit.y + credit.height + 24, layout.height);
});
test('partial final row is centered; row maxima and inter-row gaps preserve every member', () => {
  const input = source(3), model = projected(input, {...BARE, columns: 2}), layout = laid(model, metric, {coverSize: 128}); checkLayout(layout, model);
  assert.equal(layout.width, 320); assert.equal(layout.height, 392);
  assert.deepEqual(layout.items.map(x => [x.row, x.column, x.x, x.y, x.height]), [[0, 0, 24, 24, 128], [0, 1, 168, 24, 128], [1, 0, 96, 168, 128]]);
  assert.equal(layout.grid.height, 272); assert.equal(layout.branding.y, 320);
  const mixed = source(3); mixed.items[0].title = 'A'.repeat(33); mixed.items[1].title = 'B'; mixed.items[2].title = 'C';
  const m = projected(mixed, {...BARE, columns: 2, showAlbum: true}), l = laid(m, metric, {coverSize: 128}); checkLayout(l, m);
  assert.ok(l.items[0].height > l.items[1].height);
  assert.equal(l.items[2].y, l.items[0].y + Math.max(l.items[0].height, l.items[1].height) + 16);
});
test('header/title/info and caption blocks use only their exact conditional gaps', () => {
  const input = source(), model = projected(input, {columns: 1, showNumber: false}), layout = laid(model, metric, {coverSize: 256}); checkLayout(layout, model);
  const title = layout.texts.find(x => x.text === 'A Top'), info = layout.texts.find(x => x.text === 'Information');
  assert.equal(title.y, 24); assert.equal(title.height, 37); assert.equal(info.y, 69); assert.equal(info.height, 19);
  assert.equal(layout.grid.y, 104);
  const captions = layout.texts.filter(x => x.itemRef !== null);
  assert.deepEqual(captions.map(x => x.text), ['Artist 1', 'Album 1', '2000']);
  assert.deepEqual(captions.map(x => x.y), [368, 395, 424]);
  assert.deepEqual(captions.map(x => [x.fontSize, x.fontWeight, x.height]), [[14, 400, 19], [16, 600, 21], [14, 400, 19]]);
  assert.equal(layout.items[0].height, 339);
  const onlyInfo = laid(projected(input, {...BARE, showInfo: true}), metric, {coverSize: 128});
  assert.equal(onlyInfo.texts.find(x => x.text === 'Information').y, 24); assert.equal(onlyInfo.grid.y, 59);
  input.title = input.description = ''; const empty = laid(projected(input, {...BARE, showTitle: true, showInfo: true}), metric, {coverSize: 128});
  assert.equal(empty.grid.y, 24);
});
test('number on/below is independent; badge padding, inset, text anchor and frame are exact', () => {
  for (const frameWidth of [1, 12]) for (const roundedCorners of [false, true]) {
    const model = projected(source(), {...BARE, showNumber: true, frameWidth, roundedCorners, backgroundColor: '#abcdef', textColor: '#123456', frameColor: '#fedcba'});
    const layout = laid(model, metric, {coverSize: 128}); checkLayout(layout, model);
    const item = layout.items[0], badge = item.numberBadge, text = layout.texts.find(x => x.itemRef !== null);
    assert.deepEqual(badge, {x: 24 + frameWidth + 8, y: 24 + 128 - frameWidth - 8 - 29, width: 20, height: 29, color: '#abcdef'});
    assert.equal(text.x, badge.x + 6); assert.equal(text.y, badge.y + 4); assert.equal(text.text, '1');
    assert.equal(item.cover.radius, roundedCorners ? 12 : 0); assert.equal(item.height, 128);
    const belowModel = projected(source(), {...model.options, numberPlacement: 'below'}), below = laid(belowModel, metric, {coverSize: 128});
    assert.equal(below.items[0].numberBadge, null); assert.equal(below.items[0].height, 157);
    assert.equal(below.texts.find(x => x.itemRef !== null).y, 160);
  }
});
test('all visibility combinations preserve independent requested fields and no empty caption rows', () => {
  const toggles = ['showTitle', 'showInfo', 'showArtist', 'showAlbum', 'showYear', 'showNumber', 'showOwnRating'];
  for (let bits = 0; bits < 128; bits++) for (const numberPlacement of ['on', 'below']) {
    const input = source(), options = {columns: 1, numberPlacement};
    toggles.forEach((key, i) => {options[key] = Boolean(bits & (1 << i));});
    const model = projected(input, options, options.showOwnRating ? ratingsFor(input, 7) : null), layout = laid(model); checkLayout(layout, model);
    const text = layout.texts.map(x => x.text);
    for (const [key, label] of [['showTitle', 'A Top'], ['showInfo', 'Information'], ['showArtist', 'Artist 1'], ['showAlbum', 'Album 1'],
      ['showYear', '2000'], ['showNumber', '1'], ['showOwnRating', 'Rating: 7/10']]) assert.equal(text.includes(label), options[key], `${bits}:${key}:${numberPlacement}`);
    assert.equal(text.includes('AlbumHaven'), true); assert.equal(text.includes('C'), true);
    assert.equal(Boolean(layout.items[0].numberBadge), options.showNumber && numberPlacement === 'on');
    if (!options.showArtist && !options.showAlbum && !options.showYear && !options.showOwnRating && !(options.showNumber && numberPlacement === 'below')) assert.equal(layout.items[0].height, 256);
  }
});

test('signed bearings and overhang use union width for wrapping, centering, badges and footer', () => {
  const ink = (text, style) => ({advance: Array.from(text).length * 8, left: -3, right: Array.from(text).length * 8 + 5, ascent: 13, descent: 6});
  const model = projected(source(3), {columns: 2, numberPlacement: 'on'}), layout = laid(model, ink, {coverSize: 128}); checkLayout(layout, model, ink);
  for (const text of layout.texts) {
    if (text.itemRef !== null && text.text !== String(layout.items.find(x => x.itemRef === text.itemRef).number)) {
      const item = layout.items.find(x => x.itemRef === text.itemRef); assert.equal(text.x, item.x + (128 - text.width) / 2);
    }
    assert.equal(text.baselineX, text.x + 3);
  }
  assert.equal(layout.items[0].numberBadge.width, 28);
  const positiveLeft = (text, style) => ({...metric(text, style), left: 4, right: Array.from(text).length * 8 - 1});
  const l = laid(projected(source(), BARE), positiveLeft, {coverSize: 128}); checkLayout(l, projected(source(), BARE), positiveLeft);
});
test('large vertical metrics expand line boxes and the entire occupied row/footer', () => {
  const tall = (text, style) => ({...metric(text, style), ascent: 40, descent: 12});
  const model = projected(source(2), {columns: 2}), layout = laid(model, tall); checkLayout(layout, model, tall);
  assert.ok(layout.texts.every(x => x.height === 52));
  const title = layout.texts.find(x => x.text === 'A Top'); assert.equal(title.baseline, title.y + 40);
});
test('wrapping preserves literal text and Unicode graphemes without ellipsis or compression', () => {
  const words = ['abcdefghij'.repeat(5), '東京京都大阪札幌'.repeat(5), 'e\u0301'.repeat(25), '👩\u200d💻'.repeat(16), '<svg>literal text</svg>'];
  const graphemes = new Intl.Segmenter('und', {granularity: 'grapheme'});
  const measure = (text, style) => {const width = text === 'AlbumHaven' ? 80 : [...graphemes.segment(text)].length * 12;
    return {advance: width, left: 0, right: width, ascent: 10, descent: 2};};
  for (const value of words) {
    const input = source(); input.items[0].title = value;
    const model = projected(input, {...BARE, showAlbum: true}), layout = laid(model, measure, {coverSize: 128}); checkLayout(layout, model, measure);
    const lines = layout.texts.filter(x => x.itemRef !== null).map(x => x.text);
    assert.equal(lines.join('').replace(/\s/gu, ''), value.replace(/\s/gu, ''));
    const offsets = new Set([0]); let offset = 0; for (const part of graphemes.segment(value)) {offset += part.segment.length; offsets.add(offset);}
    offset = 0; for (const line of lines) {offset += line.length; if (!/\s/u.test(value)) assert.ok(offsets.has(offset));}
  }
});
test('whitespace wrapping chooses whole words when they fit and wrapped lines add no block gap', () => {
  const input = source(); input.items[0].title = 'alpha beta gamma delta';
  const model = projected(input, {...BARE, showAlbum: true}), layout = laid(model, metric, {coverSize: 128});
  const lines = layout.texts.filter(x => x.itemRef !== null);
  assert.deepEqual(lines.map(x => x.text), ['alpha beta gamma', 'delta']);
  assert.equal(lines[1].y, lines[0].y + lines[0].height);
});
test('an oversized grapheme, number badge or brand group fails rather than compressing', () => {
  const input = source(); input.items[0].title = '👩\u200d💻';
  const hugeGlyph = (text, style) => text.includes('👩') ? {...metric(text, style), advance: 129, right: 129} : metric(text, style);
  invalid(layoutAlbumTopImage(projected(input, {...BARE, showAlbum: true}), hugeGlyph, {coverSize: 128}), 'unreadable_text');
  const hugeNumber = (text, style) => text === '1' ? {...metric(text, style), advance: 100, right: 100} : metric(text, style);
  invalid(layoutAlbumTopImage(projected(source(), {...BARE, showNumber: true, frameWidth: 12}), hugeNumber, {coverSize: 128}), 'unreadable_text');
  const hugeBrand = (text, style) => text === 'AlbumHaven' ? {...metric(text, style), advance: 100, right: 100} : metric(text, style);
  invalid(layoutAlbumTopImage(projected(source(), BARE), hugeBrand, {coverSize: 128}), 'unreadable_text');
});
test('measurement receives immutable exact native styles and its output is not retained', () => {
  const styles = [], m = {advance: 8, left: 0, right: 8, ascent: 10, descent: 2};
  const model = projected(), layout = laid(model, (text, style) => {exactKeys(style, ['fontFamily', 'fontSize', 'fontWeight']);
    frozenPlain(style); assert.equal(style.fontFamily, FONT); styles.push(style); return m;});
  const before = JSON.stringify(layout); m.advance = Infinity; m.ascent = 900;
  assert.equal(JSON.stringify(layout), before); assert.ok(styles.length);
});
for (const [label, measure] of [
  ['missing', undefined], ['not function', 1], ['throwing', () => {throw new Error('private-secret');}], ['null result', () => null],
  ['async result', async () => metric('x')], ['missing fields', () => ({advance: 1})], ['nonfinite advance', () => ({...metric('x'), advance: Infinity})],
  ['negative advance', () => ({...metric('x'), advance: -1})], ['coerced advance', () => ({...metric('x'), advance: '8'})],
  ['nonfinite left', () => ({...metric('x'), left: NaN})], ['nonfinite right', () => ({...metric('x'), right: Infinity})],
  ['inverted ink', () => ({...metric('x'), left: 9, right: 1})], ['negative ascent', () => ({...metric('x'), ascent: -1})],
  ['zero vertical ink', () => ({...metric('x'), ascent: 0, descent: 0})], ['negative descent', () => ({...metric('x'), descent: -1})],
  ['nonfinite ascent', () => ({...metric('x'), ascent: Infinity})], ['nonfinite descent', () => ({...metric('x'), descent: NaN})],
  ['throwing metric getter', () => ({...metric('x'), get advance() {throw new Error('private-secret');}})],
  ['overflow union', () => ({advance: Number.MAX_VALUE, left: -Number.MAX_VALUE, right: Number.MAX_VALUE, ascent: 1, descent: 1})],
  ['overflow vertical sum', () => ({advance: 1, left: 0, right: 1, ascent: Number.MAX_VALUE, descent: Number.MAX_VALUE})]
]) test(`invalid measurement ${label} fails closed without input/error disclosure`, () => {
  const result = layoutAlbumTopImage(projected(source(), BARE), measure); invalid(result, 'invalid_metrics'); assert.equal(JSON.stringify(result).includes('private-secret'), false);
});

for (const [label, engine] of [['below floor', {coverSize: 127}], ['over bound', {coverSize: 16385}], ['fraction', {coverSize: 128.5}],
  ['coercion', {coverSize: '128'}], ['NaN', {coverSize: NaN}], ['infinite size', {coverSize: Infinity}], ['null size', {coverSize: null}], ['unknown setting', {quality: 2}]]) {
  test(`engine options reject ${label}`, () => invalid(layoutAlbumTopImage(projected(), metric, engine), 'invalid_options'));
}
test('layout revalidates deeply immutable data, not possession of a mutable lookalike', () => {
  const model = projected(); invalid(layoutAlbumTopImage(structuredClone(model), metric));
  const changed = structuredClone(model); changed.items[0].number = 99; invalid(layoutAlbumTopImage(freeze(changed), metric));
  const injected = structuredClone(model); injected.items[0].path = '/secret'; invalid(layoutAlbumTopImage(freeze(injected), metric));
  const shallow = structuredClone(model); Object.freeze(shallow); invalid(layoutAlbumTopImage(shallow, metric));
  const valid = freeze(structuredClone(model)); const layout = laid(valid); checkLayout(layout, valid);
});

test('minimal side lower bound rejects large complete capture before any measurement', () => {
  const model = projected(source(5000), {...BARE, columns: 10}); let calls = 0;
  invalid(layoutAlbumTopImage(model, () => {calls++; return metric('x');}, {coverSize: 128}), 'side_limit'); assert.equal(calls, 0);
});
test('side and pixel bounds include margins/footer and never shrink the cover', () => {
  const bare = projected(source(), BARE);
  let calls = 0; invalid(layoutAlbumTopImage(bare, () => {calls++; return metric('x');}, {coverSize: 16384}), 'side_limit'); assert.equal(calls, 0);
  // Exact bare geometry is (cover + 48) × (cover + 120).
  const c = 5572, low = laid(bare, metric, {coverSize: c});
  assert.equal(low.width, c + 48); assert.equal(low.height, c + 120); assert.ok(low.pixelCount <= 32000000);
  invalid(layoutAlbumTopImage(bare, metric, {coverSize: 5573}), 'pixel_limit');
  assert.equal(low.items[0].cover.width, c);
});
test('caption/footer-inclusive pixel overflow is explicit and leaves original model intact', () => {
  const input = source(), model = projected(input, {...BARE, showAlbum: true}), before = JSON.stringify(model);
  invalid(layoutAlbumTopImage(model, metric, {coverSize: 5560}), 'pixel_limit');
  assert.equal(JSON.stringify(model), before);
});
test('monotonic measured height failure stops before subsequent member blocks', () => {
  const input = source(2); input.items[0].artist = 'TOO-TALL'; input.items[1].artist = 'MUST-NOT-MEASURE';
  const model = projected(input, {...BARE, columns: 1, showArtist: true}); let laterCalls = 0;
  const measure = (text, style) => {if (text.includes('MUST-NOT')) laterCalls++; return {...metric(text, style), ascent: text.includes('TOO-TALL') ? 16384 : 10};};
  invalid(layoutAlbumTopImage(model, measure, {coverSize: 128}), 'side_limit'); assert.equal(laterCalls, 0);
});

for (const [label, factory] of [
  ['unavailable', () => undefined], ['throwing constructor', () => class {constructor() {throw new Error('segment-secret');}}],
  ['missing segment method', () => class {}], ['throwing segment method', () => class {segment() {throw new Error('segment-secret');}}],
  ['noniterable segments', () => class {segment() {return {};}}], ['bad iterator', () => class {segment() {return {[Symbol.iterator]: () => ({next: 1})};}}],
  ['bad iterator result', () => class {segment() {return {[Symbol.iterator]: () => ({next: () => null})};}}],
  ['empty segment', () => class {segment() {return [{segment: ''}];}}], ['nonstring segment', () => class {segment() {return [{segment: 7}];}}]
]) test(`segmentation ${label} fails explicitly`, {concurrency: false}, t => {
  replaceSegmenter(t, factory());
  const input = source(); input.items[0].title = 'LongWord'.repeat(30);
  const result = layoutAlbumTopImage(projected(input, {...BARE, showAlbum: true}), metric, {coverSize: 128});
  invalid(result, 'segmentation_unavailable'); assert.equal(JSON.stringify(result).includes('segment-secret'), false);
});
test('segmentation occurs at most once per requested block and total segment inspection is bounded', {concurrency: false}, t => {
  const Native = Intl.Segmenter, inputs = new Map(); let inspected = 0, yielded = 0, constructorOptions;
  class Observed {
    constructor(locale, options) {constructorOptions = [locale, options]; this.native = new Native(locale, options);}
    segment(text) {
      inputs.set(text, (inputs.get(text) || 0) + 1); const iterator = this.native.segment(text)[Symbol.iterator]();
      return {[Symbol.iterator]() {return {next() {const next = iterator.next(); if (next.done) return next; yielded++; let examined = false;
        return {done: false, value: {get segment() {if (!examined) {inspected++; examined = true;} return next.value.segment;}, index: next.value.index, input: text}};}};}};
    }
  }
  replaceSegmenter(t, Observed);
  const input = source(); input.title = ''; input.description = ''; input.items[0].title = 'abcdefghij'.repeat(50);
  const model = projected(input, {...BARE, showAlbum: true}); laid(model, metric, {coverSize: 128});
  assert.equal(constructorOptions[0], 'und'); assert.equal(constructorOptions[1].granularity, 'grapheme');
  assert.ok([...inputs.values()].every(value => value === 1)); assert.ok(yielded <= 511); assert.ok(inspected <= 511);
});
test('finite extra segment is malformed rather than accepted as additional source text', {concurrency: false}, t => {
  const Native = Intl.Segmenter;
  class Extra {
    constructor(locale, options) {this.native = new Native(locale, options);}
    segment(text) {
      const parts = [...this.native.segment(text)];
      if (text.length > 100) parts.push({segment: 'x', index: text.length, input: text});
      return parts;
    }
  }
  replaceSegmenter(t, Extra);
  const input = source(); input.items[0].title = 'a'.repeat(500);
  invalid(layoutAlbumTopImage(projected(input, {...BARE, showAlbum: true}), metric, {coverSize: 128}), 'segmentation_unavailable');
});
test('nonterminating segment iterator is stopped by text budget without unbounded collection', {concurrency: false}, t => {
  const Native = Intl.Segmenter;
  let steps = 0, inspected = 0;
  class Endless {
    constructor(locale, options) {this.native = new Native(locale, options);}
    segment(text) {
      if (text.length < 100) return this.native.segment(text);
      let index = 0;
      return {
        [Symbol.iterator]() {
          return {
            next() {
              steps++; if (steps > 1015) throw new Error('test guard: unbounded iterator'); let examined = false;
              return {done: false, value: {get segment() {if (!examined) {inspected++; examined = true;} return 'a';}, index: index++, input: text}};
            }
          };
        }
      };
    }
  }
  replaceSegmenter(t, Endless);
  const input = source(); input.items[0].title = 'a'.repeat(1000);
  const result = layoutAlbumTopImage(projected(input, {...BARE, showAlbum: true}), metric, {coverSize: 128});
  invalid(result, 'text_budget'); assert.ok(inspected <= 1011); assert.ok(steps <= 1012);
});
test('bounded text workload never exceeds absolute measurement or segment ceilings', {concurrency: false}, t => {
  const Native = Intl.Segmenter; let measurements = 0, inspected = 0;
  class Counted {
    constructor(locale, options) {this.native = new Native(locale, options);}
    segment(text) {
      const it = this.native.segment(text)[Symbol.iterator]();
      return {
        [Symbol.iterator]() {
          return {
            next() {
              const next = it.next(); if (next.done) return next; let examined = false;
              return {done: false, value: {get segment() {if (!examined) {inspected++; examined = true;} if (inspected > 131073) throw new Error('segment guard'); return next.value.segment;}, index: next.value.index, input: text}};
            }
          };
        }
      };
    }
  }
  replaceSegmenter(t, Counted);
  const input = source(500); for (const item of input.items) item.artist = 'a'.repeat(1000);
  const model = projected(input, {...BARE, columns: 10, showArtist: true});
  const measure = (text, style) => {measurements++; if (measurements > 65537) throw new Error('measurement guard');
    const width = text === 'AlbumHaven' || text === 'C' ? text.length * 8 : Array.from(text).length;
    return {advance: width, left: 0, right: width, ascent: 10, descent: 2};};
  invalid(layoutAlbumTopImage(model, measure, {coverSize: 128}), 'text_budget');
  assert.ok(measurements <= 65536); assert.ok(inspected <= 131072);
});
test('dynamic measurement ceiling tracks requested characters/blocks rather than unused metadata', () => {
  const input = source(); input.title = input.description = 'x'.repeat(1000); input.items[0].title = input.items[0].artist = 'x'.repeat(1000);
  const model = projected(input, BARE); let calls = 0;
  const measure = (text, style) => {calls++; return metric(text, style);};
  laid(model, measure, {coverSize: 128});
  const S = 11, B = 2; assert.ok(calls <= 4 * S + 4 * B + 64);
});
test('8192 text-line boundary succeeds and the next record is an explicit budget failure', () => {
  const input = source(20); input.items.forEach((item, i) => {item.artist = 'a'.repeat(i < 10 ? 750 : 69);});
  const options = {...BARE, columns: 10, showArtist: true};
  const measure = (text, style) => {const width = text === 'AlbumHaven' || text === 'C' ? text.length * 8 : text.length * 128;
    return {advance: width, left: 0, right: width, ascent: 10, descent: 2};};
  const model = projected(input, options), layout = laid(model, measure, {coverSize: 128});
  assert.equal(layout.texts.length, 8192); assert.equal(layout.items.length, 20); assert.ok(layout.height <= 16384); assert.ok(layout.pixelCount <= 32000000);
  input.items[10].artist += 'a';
  invalid(layoutAlbumTopImage(projected(input, options), measure, {coverSize: 128}), 'text_budget');
});
test('deterministic output is independent of prior invalid calls and caller object identity', () => {
  const one = projected(source(7), {columns: 3}), expected = laid(one, metric, {coverSize: 128});
  invalid(projectAlbumTopImage(source(), {columns: 0})); invalid(layoutAlbumTopImage(one, () => null), 'invalid_metrics');
  assert.throws(() => albumTopImageGrid(20, {rowIndex: 100}), TypeError);
  const two = projected(structuredClone(source(7)), {columns: 3});
  assert.deepEqual(laid(two, metric, {coverSize: 128}), expected); assert.deepEqual(one, two);
});
