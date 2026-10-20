'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const F = require('./sample-facet-fixtures.cjs');
async function fixture(t, options) {
  const h = await F.facetFixture(options); t.after(() => h.controller.dispose()); return h;
}
test('initial metadata state has no selection, permission, acquisition or implicit capture', async t => {
  const h = await fixture(t), state = h.controller.getSnapshot();
  assert.deepEqual(state.facetDiscovery, {status: 'idle', data: null, error: null});
  assert.deepEqual(state.countryMetadata, {status: 'idle', selectedTargets: [], results: null, error: null});
  assert.ok(Object.isFrozen(state.countryMetadata.selectedTargets));
  assert.equal(await h.controller.loadCountryMetadata(), false);
  assert.equal(h.controller.cancelCountryMetadata(), false);
  assert.equal(h.facetCalls.acquisition.length, 0); assert.equal(h.keys(), 0);
});
for (const count of [0, 1, 25, 26]) {
  test(`selection of ${count} offered pairs obeys the finite explicit target limit`, async t => {
    const h = await fixture(t); assert.equal(await h.discover(), true);
    const selected = F.targets(count), accepted = h.controller.setCountryMetadataTargets(selected);
    assert.equal(accepted, count <= 25);
    assert.equal(h.controller.getSnapshot().countryMetadata.selectedTargets.length, count <= 25 ? count : 0);
    assert.equal(h.facetCalls.acquisition.length, 0); assert.equal(h.keys(), 0);
  });
}
for (const invalid of [[F.targets()[1], F.targets()[0]], [F.targets()[0], F.targets()[0]],
  [{...F.targets()[0], country: 'GB'}], [{...F.targets()[0], primary_artist_ref: F.targets()[1].primary_artist_ref}],
  [{track_ref: 'inventory-track:5:31', primary_artist_ref: 'musicbrainz-artist:' + F.id(31)}],
  null, {}, 'all']) {
  test(`target selection rejects rather than repairs ${JSON.stringify(invalid)}`, async t => {
    const h = await fixture(t); await h.discover();
    const selected = [F.targets()[0]]; assert.equal(h.controller.setCountryMetadataTargets(selected), true);
    const before = h.controller.getSnapshot().countryMetadata.selectedTargets;
    assert.equal(h.controller.setCountryMetadataTargets(invalid), false);
    assert.equal(h.controller.getSnapshot().countryMetadata.selectedTargets, before);
    assert.equal(h.facetCalls.acquisition.length, 0);
  });
}
for (const denial of ['hint', 'unavailable', 'style_only']) {
  test(`no target authority is invented from ${denial} discovery`, async t => {
    const h = await fixture(t, {discover: input => {
      const result = F.discovery(input);
      if (denial === 'hint') {result.data.allowed_actions.enrich_country = false; result.data.facets.countries.enrichment_targets = [];}
      if (denial === 'unavailable') result.data.facets.countries = {status: 'unavailable',
        choices: [], coverage: null, error: 'source_too_large', enrichment_targets: []};
      return result;
    }});
    await h.discover(denial === 'style_only' ? {facets: ['styles']} : {});
    assert.equal(h.controller.setCountryMetadataTargets([F.targets()[0]]), false);
    assert.equal(await h.controller.loadCountryMetadata(), false);
    assert.equal(h.facetCalls.acquisition.length, 0);
  });
}
test('Load snapshots immutable offered-order targets, blocks duplicates, and never optimistically fills Country', async t => {
  const entered = F.deferred(), release = F.deferred(); let input;
  const h = await fixture(t, {acquire: supplied => {input = supplied; entered.resolve(); return release.promise;}});
  await h.discover(); const selected = [F.targets()[0], F.targets()[2]];
  assert.equal(h.controller.setCountryMetadataTargets(selected), true);
  selected[0].track_ref = 'inventory-track:5:999';
  const result = h.controller.loadCountryMetadata(); await entered.promise;
  assert.equal(input.scopeKey, h.scopeKey); assert.deepEqual(input.source, F.parent());
  assert.equal(input.selectionMethod, 'random');
  assert.deepEqual(input.targets, [F.targets()[0], F.targets()[2]]);
  assert.ok(Object.isFrozen(input.targets) && input.targets.every(Object.isFrozen));
  assert.ok(input.signal instanceof AbortSignal);
  assert.equal(h.controller.getSnapshot().facetDiscovery.data, null);
  assert.deepEqual(h.controller.getSnapshot().countryMetadata.selectedTargets, []);
  assert.equal(await h.controller.loadCountryMetadata(), false);
  assert.equal(await h.discover(), false);
  assert.equal(h.controller.setCountryMetadataTargets([F.targets()[1]]), false);
  release.resolve(F.acquired(input, ['stored_unknown', 'unresolved']));
  assert.equal(await result, true);
  assert.deepEqual(h.controller.getSnapshot().countryMetadata.results.map(row => row.status), ['stored_unknown', 'unresolved']);
  assert.equal(h.controller.getSnapshot().facetDiscovery.data, null);
  assert.equal(h.facetCalls.discovery.length, 1); assert.equal(h.facetCalls.acquisition.length, 1);
  assert.equal(h.keys(), 0); assert.equal(h.controller.source(), null);
  assert.ok(Object.values(h.calls).every(rows => rows.length === 0));
  assert.equal(await h.controller.loadCountryMetadata(), false);
});
for (const status of [401, 403, 409, 500, undefined]) {
  test(`dispatched error ${status} is uncertain, including partial mid-batch authority loss`, async t => {
    const error = Object.assign(new Error('Lost or rejected acquisition'), {status});
    const h = await fixture(t, {acquire: () => {throw error;}});
    await h.discover(); h.controller.setCountryMetadataTargets([F.targets()[0]]);
    assert.equal(await h.controller.loadCountryMetadata(), false);
    let state = h.controller.getSnapshot();
    assert.equal(state.countryMetadata.status, 'uncertain'); assert.equal(state.countryMetadata.results, null);
    assert.equal(state.facetDiscovery.data, null);
    assert.equal(await h.controller.loadCountryMetadata(), false);
    assert.equal(h.facetCalls.acquisition.length, 1);
    assert.equal(await h.discover(), true);
    state = h.controller.getSnapshot();
    assert.equal(state.countryMetadata.status, 'uncertain');
    assert.deepEqual(state.countryMetadata.selectedTargets, []);
    assert.equal(await h.controller.loadCountryMetadata(), false);
    assert.equal(h.facetCalls.acquisition.length, 1);
    assert.equal(h.keys(), 0); assert.equal(h.calls.save.length, 0);
  });
}
test('only fresh explicit selection after rediscovery permits a new finite action', async t => {
  let failed = true;
  const h = await fixture(t, {acquire: input => {if (failed) throw new Error('Lost'); return F.acquired(input);}});
  await h.discover(); h.controller.setCountryMetadataTargets([F.targets()[0]]);
  await h.controller.loadCountryMetadata(); failed = false; await h.discover();
  assert.equal(h.controller.setCountryMetadataTargets([F.targets()[1]]), true);
  assert.equal(await h.controller.loadCountryMetadata(), true);
  assert.equal(h.facetCalls.acquisition.length, 2);
  assert.deepEqual(h.facetCalls.acquisition[1].targets, [F.targets()[1]]);
});
test('cancel before any Load makes no call; dispatched cancellation aborts the real signal and ignores late success', async t => {
  const entered = F.deferred(), release = F.deferred(); let input;
  const h = await fixture(t, {acquire: value => {input = value; entered.resolve(); return release.promise;}});
  assert.equal(h.controller.cancelCountryMetadata(), false); await h.discover();
  h.controller.setCountryMetadataTargets([F.targets()[0]]);
  const pending = h.controller.loadCountryMetadata(); await entered.promise;
  assert.equal(h.controller.cancelCountryMetadata(), true); assert.equal(input.signal.aborted, true);
  assert.equal(h.controller.cancelCountryMetadata(), false);
  release.resolve(F.acquired(input)); assert.equal(await pending, false);
  assert.equal(h.controller.getSnapshot().countryMetadata.status, 'uncertain');
  assert.equal(h.controller.getSnapshot().countryMetadata.results, null);
  assert.equal(h.facetCalls.acquisition.length, 1);
});
for (const reason of ['edit', 'source', 'suspend']) {
  test(`late discovery after ${reason} invalidation cannot repopulate a retained controller`, async t => {
    const entered = F.deferred(), release = F.deferred(); let input;
    const h = await fixture(t, {discover: value => {input = value; entered.resolve(); return release.promise;}});
    const pending = h.discover(); await entered.promise;
    assert.equal(h.controller.invalidateOptions({reason}), true); assert.equal(input.signal.aborted, true);
    release.resolve(F.discovery(input)); assert.equal(await pending, false);
    assert.equal(h.controller.getSnapshot().facetDiscovery.data, null);
    assert.deepEqual(h.controller.getSnapshot().countryMetadata.selectedTargets, []);
    assert.equal(h.keys(), 0);
  });
}
test('a newer discovery supersedes only older discovery and keeps its own explicit method/source', async t => {
  const first = F.deferred(), entered = F.deferred(); let old;
  const h = await fixture(t, {discover: input => {
    if (!old) {old = input; entered.resolve(); return first.promise;}
    return F.discovery(input);
  }});
  const pending = h.discover(); await entered.promise;
  assert.equal(await h.discover({selectionMethod: 'most_listened'}), true);
  first.resolve(F.discovery(old)); assert.equal(await pending, false);
  assert.equal(old.signal.aborted, true);
  assert.equal(h.controller.getSnapshot().facetDiscovery.data.selection_method, 'most_listened');
  assert.equal(h.facetCalls.discovery.length, 2); assert.equal(h.facetCalls.acquisition.length, 0);
});
for (const reason of ['edit', 'source', 'suspend']) {
  test(`${reason} respects captured intent versus suspension without generating a key`, async t => {
    const h = await fixture(t); await h.generate({options: F.options('most_listened')});
    h.controller.edit({title: 'Retained title', description: 'Retained description'});
    const source = h.controller.source(), keys = h.keys();
    await h.discover(); h.controller.setCountryMetadataTargets([F.targets()[0]]);
    assert.equal(h.controller.invalidateOptions({reason}), true);
    assert.equal(h.controller.source(), reason === 'suspend' ? source : null);
    assert.equal(h.controller.getSnapshot().title, 'Retained title');
    assert.equal(h.controller.getSnapshot().description, 'Retained description');
    assert.equal(h.controller.getSnapshot().facetDiscovery.data, null);
    assert.deepEqual(h.controller.getSnapshot().countryMetadata.selectedTargets, []);
    assert.equal(h.keys(), keys);
    if (reason !== 'suspend') {await h.controller.retryCapture(); await h.controller.recoverCapture();
      assert.equal(h.calls.capture.length, 1); assert.equal(h.calls.read.length, 0);}
  });
}
for (const reason of ['source', 'suspend']) {
  test(`${reason} does not cancel or supersede the existing in-flight Save generation`, async t => {
    const entered = F.deferred(), release = F.deferred(); let input;
    const h = await fixture(t, {providers: {createPlaylistFromSelection: value => {
      input = value; entered.resolve(); return release.promise;
    }}});
    await h.generate({options: F.options('most_listened')});
    const pending = h.controller.save(); await entered.promise; const keys = h.keys();
    assert.equal(h.controller.invalidateOptions({reason}), true); assert.equal(input.signal.aborted, false);
    assert.equal(await h.discover(), false);
    assert.equal(h.controller.setCountryMetadataTargets([]), false);
    release.resolve({status: 'ready', data: {scopeKey: h.scopeKey, ok: true, action: 'create',
      playlist_id: F.id(80), revision: '1', request_key: input.request_key}});
    assert.ok(await pending); assert.equal(h.controller.getSnapshot().mutation.status, 'ready');
    assert.equal(h.keys(), keys);
  });
}
for (const predicate of [undefined, null, true, () => false, () => 'yes', () => {throw new Error('Unavailable owner');}]) {
  test(`missing or non-true facet activity fails closed without changing existing capture: ${String(predicate)}`, async t => {
    const h = await fixture(t, {extra: {isFacetActive: predicate}});
    assert.equal(await h.discover(), false);
    assert.equal(h.controller.setCountryMetadataTargets([]), false);
    assert.equal(await h.controller.loadCountryMetadata(), false);
    assert.equal(h.facetCalls.discovery.length, 0); assert.equal(h.facetCalls.acquisition.length, 0);
    assert.equal(await h.generate({options: F.options('most_listened')}), true);
    assert.ok(h.controller.source()); assert.equal(h.calls.capture.length, 1);
  });
}
test('retained but inactive facet owner blocks initiation and late publication while preserving capture and Save', async t => {
  const entered = F.deferred(), release = F.deferred(); let input;
  const h = await fixture(t, {acquire: value => {input = value; entered.resolve(); return release.promise;}});
  await h.generate({options: F.options('most_listened')}); const captured = h.controller.source();
  await h.discover(); h.controller.setCountryMetadataTargets([F.targets()[0]]);
  const pending = h.controller.loadCountryMetadata(); await entered.promise;
  h.suspendFacets(); assert.equal(h.controller.invalidateOptions({reason: 'suspend'}), true);
  const before = h.controller.getSnapshot(); let publications = 0;
  const stop = h.controller.subscribe(() => publications++); t.after(stop);
  assert.equal(await h.discover(), false);
  assert.equal(h.controller.setCountryMetadataTargets([F.targets()[0]]), false);
  assert.equal(await h.controller.loadCountryMetadata(), false);
  assert.equal(input.signal.aborted, true);
  release.resolve(F.acquired(input)); assert.equal(await pending, false);
  assert.equal(publications, 0); assert.equal(h.controller.getSnapshot(), before);
  assert.equal(h.controller.source(), captured); assert.equal(h.controller.canSave(), true);
  h.resumeFacets();
  assert.equal(h.facetCalls.discovery.length, 1); assert.equal(h.facetCalls.acquisition.length, 1);
  assert.equal(await h.discover(), true); assert.deepEqual(h.controller.getSnapshot().countryMetadata.selectedTargets, []);
  assert.equal(h.facetCalls.acquisition.length, 1);
});
for (const phase of ['discovery', 'acquisition']) {
  test(`pending ${phase} also blocks capture and Save in the reverse admission order`, async t => {
    const entered = F.deferred(), release = F.deferred(); let input;
    const behavior = phase === 'discovery' ? {discover: value => {
      input = value; entered.resolve(); return release.promise;
    }} : {acquire: value => {input = value; entered.resolve(); return release.promise;}};
    const h = await fixture(t, behavior); await h.generate({options: F.options('most_listened')});
    const keys = h.keys();
    if (phase === 'acquisition') {await h.discover(); h.controller.setCountryMetadataTargets([F.targets()[0]]);}
    const pending = phase === 'discovery' ? h.discover() : h.controller.loadCountryMetadata();
    await entered.promise;
    assert.equal(h.controller.canSave(), false); assert.equal(await h.controller.save(), false);
    assert.equal(await h.generate({options: F.options('most_listened')}), false);
    assert.equal(await h.controller.retryCapture(), false); assert.equal(await h.controller.recoverCapture(), false);
    assert.equal(h.calls.save.length, 0); assert.equal(h.calls.capture.length, 1); assert.equal(h.calls.read.length, 0);
    assert.equal(h.keys(), keys);
    release.resolve(phase === 'discovery' ? F.discovery(input) : F.acquired(input));
    assert.equal(await pending, true);
  });
}
test('uncertain Save blocks every new facet action and edit while preserving original recovery', async t => {
  let uncertain = false, recoveries = 0;
  const h = await fixture(t, {providers: {
    hasPendingPlaylistOperation: () => uncertain,
    createPlaylistFromSelection: async () => {uncertain = true; throw new Error('Lost Save');},
    recoverPlaylistCreation: async input => {recoveries++; return {scopeKey: input.scopeKey, ok: true,
      action: 'create', playlist_id: F.id(80), revision: '1', request_key: F.id(91)};},
  }});
  await h.generate({options: F.options('most_listened')}); await h.controller.save();
  const keys = h.keys(), captured = h.controller.source();
  assert.equal(await h.discover(), false);
  assert.equal(h.controller.setCountryMetadataTargets([]), false);
  assert.equal(await h.controller.loadCountryMetadata(), false);
  assert.equal(h.controller.invalidateOptions({reason: 'edit'}), false);
  assert.equal(h.controller.source(), captured); assert.equal(h.keys(), keys);
  assert.equal(h.facetCalls.discovery.length, 0); assert.equal(h.facetCalls.acquisition.length, 0);
  h.suspendFacets(); assert.equal(h.controller.invalidateOptions({reason: 'suspend'}), true);
  assert.ok(await h.controller.recoverSave()); assert.equal(recoveries, 1);
  assert.equal(h.controller.getSnapshot().mutation.status, 'ready');
});
