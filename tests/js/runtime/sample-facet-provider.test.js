'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const F = require('./sample-origin-fixtures.cjs');
const PATH = '/playlists/creation-source/sample/facets', CONTEXT = 'a'.repeat(64);
let create;
test.before(async () => {
  ({createPlaylistBackendProviders: create} = await import('../../../music_app/static/js/playlists/backend-providers.mjs'));
});
function response(input) {
  const field = name => ({status: 'ready', choices: name === 'styles' ? [
    {identity: 'genre-tag:\ue000', label: '\ue000'}, {identity: 'genre-tag:\u{10000}', label: '\u{10000}'}] : [
    {identity: 'musicbrainz-country:GB', label: 'GB'}],
    coverage: {candidate_count: 3, known: 1, unknown: 1, unresolved: 1},
    error: null, enrichment_targets: []});
  return {status: 'ready', data: {selection_method: input.body.selection_method,
    facets: Object.fromEntries(input.body.facets.map(name => [name, field(name)])),
    allowed_actions: {enrich_country: false}}, context_ref: CONTEXT};
}
function fixture(handler) {
  let context = CONTEXT, scope = 'sample:scope', listener;
  const calls = [], transport = {
    context: () => context,
    subscribe(fn) {listener = fn; return () => {listener = null;};},
    async request(path, input) {
      calls.push({path, ...input, body: F.plain(input.body)});
      assert.equal(path, PATH, 'Discovery must not capture, enrich, scan, or read providers');
      return handler ? handler(input) : response(input);
    }};
  const providers = create({transport, runtime: {acceptsPrivateScope: key => key === scope}});
  return {providers, calls, input: (source = F.parent()) => ({
    source, scopeKey: scope, selectionMethod: 'random', facets: ['styles', 'countries']}),
    clear() {context = 'b'.repeat(64); listener?.();}, retire() {scope = 'new:scope';}};
}
for (const kind of ['playlist', 'album_top', 'album_set', 'album_details']) {
  test(`${kind}: exact read-only source selector request and context transport`, async t => {
    const h = fixture(); t.after(() => h.providers.dispose());
    const source = kind === 'playlist' ? F.parent() : {origin: F.origins[kind]()};
    const input = h.input(source), output = await h.providers.readSamplePlaylistFacets(input);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].method, 'POST'); assert.equal(h.calls[0].expected, CONTEXT);
    assert.deepEqual(h.calls[0].body, {...(kind === 'playlist' ? F.parent() : source),
      selection_method: 'random', facets: ['styles', 'countries']});
    assert.equal(output.status, 'ready'); assert.equal(output.data.selection_method, 'random');
    assert.deepEqual(output.data.facets.styles.choices.map(v => v.identity),
      ['genre-tag:\ue000', 'genre-tag:\u{10000}']);
    assert.equal(Object.hasOwn(h.calls[0].body, 'options'), false);
    assert.equal(Object.hasOwn(h.calls[0].body, 'request_key'), false);
  });
}
for (const change of ['extra', 'method', 'mask', 'count_bool', 'coverage_sum', 'label',
  'prefix', 'order', 'duplicate', 'unavailable_prefix', 'targets_when_denied', 'country_target_extra']) {
  test(`discovery DTO ${change} is rejected instead of cached as authority`, async t => {
    const h = fixture(input => {
      const out = response(input), style = out.data.facets.styles, country = out.data.facets.countries;
      if (change === 'extra') out.data.secret_metadata = {};
      if (change === 'method') out.data.selection_method = 'most_listened';
      if (change === 'mask') delete out.data.facets.countries;
      if (change === 'count_bool') style.coverage.known = true;
      if (change === 'coverage_sum') style.coverage.known = 20;
      if (change === 'label') style.choices[0].label = 'Display guess';
      if (change === 'prefix') style.choices[0].identity = 'style:Rock';
      if (change === 'order') style.choices.reverse();
      if (change === 'duplicate') style.choices.push(style.choices[0]);
      if (change === 'unavailable_prefix') {style.status = 'unavailable'; style.error = 'source_too_large'; style.coverage = null;}
      if (change === 'targets_when_denied') country.enrichment_targets = [{
        track_ref: F.refs[0], primary_artist_ref: 'musicbrainz-artist:' + F.id(1)}];
      if (change === 'country_target_extra') {out.data.allowed_actions.enrich_country = true;
        country.enrichment_targets = [{track_ref: F.refs[0], primary_artist_ref: 'musicbrainz-artist:' + F.id(1), local_artist_id: '9'}];}
      return out;
    });
    t.after(() => h.providers.dispose());
    await assert.rejects(h.providers.readSamplePlaylistFacets(h.input()));
    assert.equal(h.calls.length, 1);
  });
}
for (const change of ['context', 'scope', 'abort']) {
  test(`late discovery after ${change} is fenced and never retried automatically`, async t => {
    const entered = F.deferred(), waiting = F.deferred(); let pendingInput;
    const h = fixture(input => {pendingInput = input; entered.resolve(); return waiting.promise;});
    t.after(() => h.providers.dispose());
    const abort = new AbortController();
    const result = h.providers.readSamplePlaylistFacets({...h.input(), signal: abort.signal});
    await entered.promise;
    if (change === 'context') h.clear(); else if (change === 'scope') h.retire(); else abort.abort();
    waiting.resolve(response(pendingInput)); await assert.rejects(result);
    assert.equal(h.calls.length, 1);
  });
}
test('discovery does not reuse data across method or source changes', async t => {
  const h = fixture(); t.after(() => h.providers.dispose());
  await h.providers.readSamplePlaylistFacets(h.input());
  await h.providers.readSamplePlaylistFacets({...h.input(), selectionMethod: 'most_listened'});
  await h.providers.readSamplePlaylistFacets(h.input({origin: F.origins.album_details()}));
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[1].body.selection_method, 'most_listened');
  assert.deepEqual(h.calls[2].body.origin, F.origins.album_details());
});
for (const source of [{parent: F.parent()}, {source_ref: F.id(1), source_revision: F.id(2)},
  {kind: 'playlist', ref: F.id(1), revision: F.id(2)}, {...F.parent(), origin: F.origins.album_details()}]) {
  test(`discovery rejects a non-selector source ${JSON.stringify(source)}`, async t => {
    const h = fixture(); t.after(() => h.providers.dispose());
    await assert.rejects(h.providers.readSamplePlaylistFacets(h.input(source)));
    assert.equal(h.calls.length, 0);
  });
}
for (const scopeKey of [undefined, 'foreign:scope']) {
  test(`discovery rejects missing or stale authenticated scope ${scopeKey} before transport`, async t => {
    const h = fixture(); t.after(() => h.providers.dispose());
    await assert.rejects(h.providers.readSamplePlaylistFacets({...h.input(), scopeKey}));
    assert.equal(h.calls.length, 0);
  });
}
