'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const F = require('./sample-native-fixtures.cjs');
let normalize;
test.before(async () => {
  ({normalizeSampleOptions: normalize} = await import('../../../music_app/static/js/playlists/sample-playlist-input.mjs'));
});
for (const field of ['styles', 'countries']) {
  const prefix = field === 'styles' ? 'genre-tag:' : 'musicbrainz-country:';
  test(`${field}: exact canonical arrays are copied and frozen, with scalar not UTF-16 ordering`, () => {
    const input = F.options('random', {[field]: [prefix + '\ue000', prefix + '\u{10000}']});
    const output = normalize(input);
    assert.ok(output); assert.deepEqual(output[field], input[field]);
    assert.ok(Object.isFrozen(output) && Object.isFrozen(output[field]));
    input[field].push(prefix + 'changed');
    assert.equal(output[field].length, 2);
  });
  for (const values of [[], [prefix], [prefix + ' Rock'], [prefix + 'Rock '],
    [prefix + '\u001cRock'], [prefix + 'Rock\u00a0'], [prefix + '\ud800'],
    [prefix + 'x', prefix + 'x'], [prefix + 'b', prefix + 'a'],
    [prefix + '\u{10000}', prefix + '\ue000'], [null], [1], 'Rock', {}, Array(1)]) {
    test(`${field}: rejects rather than repairs noncanonical ${JSON.stringify(values)}`, () => {
      assert.equal(normalize(F.options('random', {[field]: values})), null);
    });
  }
  test(`${field}: punctuation/case/internal whitespace survive unchanged`, () => {
    const token = prefix + 'Rock;Jazz / métal:Live';
    assert.deepEqual(normalize(F.options('random', {[field]: [token]}))[field], [token]);
    const nonTrim = prefix + '\ufeffRock';
    assert.deepEqual(normalize(F.options('random', {[field]: [nonTrim]}))[field], [nonTrim],
      'U+FEFF is not in the frozen producer trim set, despite JavaScript trim()');
  });
  test(`${field}: exactly 5000 selected identities allowed, 5001 rejected, no quota maximum`, () => {
    const values = Array.from({length: 5001}, (_, i) => prefix + String(i).padStart(5, '0'));
    assert.ok(normalize(F.options('random', {[field]: values.slice(0, 5000), songs_per_group: 5001})));
    assert.equal(normalize(F.options('random', {[field]: values})), null);
  });
}
for (const patch of [{styles: ['rock']}, {countries: ['GB']}, {styles: ['style:rock']},
  {countries: ['country:GB']}, {songs_per_group: undefined}, {unknown_facets: undefined}]) {
  test(`old negative still rejects without protocol defaults: ${JSON.stringify(patch)}`, async t => {
    const h = await F.controllerFixture(); t.after(() => h.controller.dispose());
    await h.generate({options: F.options('random', patch)});
    assert.equal(h.calls.capture.length, 0); assert.equal(h.calls.representatives.length, 0);
  });
}
test('real controller binds immutable canonical facets to representatives, capture, and original retry intent', async t => {
  let failed = true; const writes = [];
  const h = await F.controllerFixture({captureSamplePlaylist: async input => {
    writes.push(F.plain({...input, signal: undefined}));
    if (failed) throw new Error('Lost capture response');
    return F.captureResult(input);
  }});
  t.after(() => h.controller.dispose());
  const options = F.options('random', {styles: ['genre-tag:Rock'], countries: ['musicbrainz-country:GB']});
  await h.generate({options}); const keys = h.keys(), draws = h.draws();
  options.styles[0] = 'genre-tag:Jazz'; options.countries.push('musicbrainz-country:US');
  failed = false; await h.controller.retryCapture();
  assert.deepEqual(writes[1], writes[0]);
  assert.deepEqual(writes[0].options.styles, ['genre-tag:Rock']);
  assert.deepEqual(writes[0].options.countries, ['musicbrainz-country:GB']);
  assert.equal(h.keys(), keys); assert.equal(h.draws(), draws);
  assert.deepEqual(h.calls.representatives[0].options, writes[0].options);
});
