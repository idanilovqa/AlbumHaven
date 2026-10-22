'use strict';
// Exact acquisition transport. No provider network, DOM or product execution at authoring time.
const test = require('node:test'), assert = require('node:assert/strict');
const F = require('./sample-origin-fixtures.cjs');
const PATH = '/playlists/creation-source/sample/country-metadata', CONTEXT = 'a'.repeat(64);
const target = n => ({track_ref: `inventory-track:5:${n}`, primary_artist_ref: 'musicbrainz-artist:' + F.id(n)});
let create;
test.before(async () => {
  ({createPlaylistBackendProviders: create} = await import('../../../music_app/static/js/playlists/backend-providers.mjs'));
});
function acknowledgment(input, statuses) {
  return {status: 'ready', context_ref: CONTEXT, data: {selection_method: input.body.selection_method,
    results: input.body.targets.map((pair, i) => ({...pair, status: statuses?.[i] || 'stored_known'}))}};
}
function fixture(handler) {
  let scope = 'sample:scope', context = CONTEXT, listener;
  const calls = [], transport = {context: () => context,
    subscribe(fn) {listener = fn; return () => {listener = null;};},
    async request(path, input) {
      calls.push({path, ...input, body: F.plain(input.body)});
      assert.equal(path, PATH, 'Acquisition must not use Save, generic refresh, capture, or retry transport');
      return handler ? handler(input) : acknowledgment(input);
    }};
  const providers = create({transport, runtime: {acceptsPrivateScope: key => key === scope}});
  return {providers, calls, input: () => ({scopeKey: scope, source: F.parent(),
    selectionMethod: 'random', targets: [target(1), target(2)]}),
    clear() {context = 'b'.repeat(64); listener?.();}, retire() {scope = 'retired';}};
}
for (const kind of ['playlist', 'album_top', 'album_set', 'album_details']) {
  test(`${kind}: exact explicit acquisition body, scope injection and real signal`, async t => {
    const h = fixture(), abort = new AbortController(); t.after(() => h.providers.dispose());
    const source = kind === 'playlist' ? F.parent() : {origin: F.origins[kind]()};
    const input = {...h.input(), source, signal: abort.signal};
    const result = await h.providers.enrichSamplePlaylistCountryMetadata(input);
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].method, 'POST');
    assert.equal(h.calls[0].expected, CONTEXT); assert.equal(h.calls[0].signal, abort.signal);
    assert.deepEqual(h.calls[0].body, {...source, selection_method: 'random', targets: input.targets});
    assert.deepEqual(result, {status: 'ready', data: {scopeKey: 'sample:scope', selection_method: 'random',
      results: input.targets.map(pair => ({...pair, status: 'stored_known'}))}});
  });
}
for (const patch of [{scopeKey: undefined}, {scopeKey: 'foreign'}, {source: {parent: F.parent()}},
  {source: {kind: 'playlist', ref: F.id(1), revision: F.id(2)}},
  {source: {source_ref: F.id(1), source_revision: F.id(2)}}, {selectionMethod: null},
  {targets: []}, {targets: [target(1), target(1)]}, {targets: [{...target(1), country: 'GB'}]},
  {targets: Array.from({length: 26}, (_, n) => target(n + 1))}]) {
  test(`invalid acquisition input is rejected before transport: ${JSON.stringify(patch)}`, async t => {
    const h = fixture(); t.after(() => h.providers.dispose());
    await assert.rejects(h.providers.enrichSamplePlaylistCountryMetadata({...h.input(), ...patch}));
    assert.equal(h.calls.length, 0);
  });
}
test('exactly 25 targets and every closed partial status are acknowledged without follow-on work', async t => {
  const statuses = ['stored_known', 'stored_unknown', 'unchanged', 'unresolved',
    'source_changed', 'concurrent_change', 'cancelled', 'not_attempted'];
  const h = fixture(input => acknowledgment(input, statuses)); t.after(() => h.providers.dispose());
  const result = await h.providers.enrichSamplePlaylistCountryMetadata({...h.input(),
    targets: Array.from({length: 25}, (_, n) => target(n + 1))});
  assert.deepEqual(result.data.results.slice(0, 8).map(row => row.status), statuses);
  assert.equal(result.data.results.length, 25); assert.equal(h.calls.length, 1);
});
for (const change of ['context', 'method', 'missing', 'reordered', 'track', 'artist', 'status', 'extra', 'body']) {
  test(`malformed acknowledgment ${change} never qualifies as success or triggers resubmit`, async t => {
    const h = fixture(input => {
      const out = acknowledgment(input), rows = out.data.results;
      if (change === 'context') out.context_ref = 'b'.repeat(64);
      if (change === 'method') out.data.selection_method = 'most_listened';
      if (change === 'missing') rows.pop();
      if (change === 'reordered') rows.reverse();
      if (change === 'track') rows[0].track_ref = target(3).track_ref;
      if (change === 'artist') rows[0].primary_artist_ref = target(3).primary_artist_ref;
      if (change === 'status') rows[0].status = 'success';
      if (change === 'extra') rows[0].country = 'GB';
      if (change === 'body') out.provider_body = {};
      return out;
    });
    t.after(() => h.providers.dispose());
    await assert.rejects(h.providers.enrichSamplePlaylistCountryMetadata(h.input()));
    assert.equal(h.calls.length, 1);
  });
}
for (const change of ['context', 'scope', 'abort']) {
  test(`dispatched acquisition is not accepted after ${change} and never automatically retried`, async t => {
    const entered = F.deferred(), release = F.deferred(); let supplied;
    const h = fixture(input => {supplied = input; entered.resolve(); return release.promise;});
    t.after(() => h.providers.dispose());
    const abort = new AbortController();
    const pending = h.providers.enrichSamplePlaylistCountryMetadata({...h.input(), signal: abort.signal});
    await entered.promise;
    if (change === 'context') h.clear(); else if (change === 'scope') h.retire(); else abort.abort();
    release.resolve(acknowledgment(supplied)); await assert.rejects(pending);
    assert.equal(h.calls.length, 1);
  });
}
test('an already aborted signal invokes no acquisition transport', async t => {
  const h = fixture(), abort = new AbortController(); t.after(() => h.providers.dispose()); abort.abort();
  await assert.rejects(h.providers.enrichSamplePlaylistCountryMetadata({...h.input(), signal: abort.signal}));
  assert.equal(h.calls.length, 0);
});
