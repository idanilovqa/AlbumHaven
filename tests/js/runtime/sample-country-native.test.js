'use strict';
// Actual shared controls and Sample page. No replacement menus or direct form transport.
const test = require('node:test'), assert = require('node:assert/strict');
const {nativeMixFixture} = require('./library-mix-react-fixture.cjs');
const F = require('./sample-facet-fixtures.cjs');
const REFRESH = 'Refresh available values', LOAD = 'Load Country metadata for selected artists';
async function mounted(t, behavior = {}, options = F.options('most_listened')) {
  const dom = await nativeMixFixture(t), h = await F.facetFixture(behavior);
  const {mountSamplePlaylistPage} = await import('../../../music_app/static/js/playlists/native-sample-playlist.mjs');
  let closes = 0;
  const props = {controller: h.controller, parent: F.parent(), onClose() {closes++;},
    async onSaved() {}, ...(options === null ? {} : {options})};
  const page = mountSamplePlaylistPage(dom.host, dom.runtime, props);
  t.after(() => {page.dispose(); h.controller.dispose();});
  const select = value => {
    // Use the actual shared menu's canonical value. The contract intentionally
    // does not invent an artist display label or another raw menu implementation.
    for (const trigger of [...dom.host.querySelectorAll('.ui-choice__trigger')]) {
      if (trigger.disabled) continue;
      dom.click(trigger);
      const option = [...dom.document.querySelectorAll('[data-foobar-format]')]
        .find(node => node.getAttribute('data-foobar-format') === value);
      if (option) {dom.click(option); return trigger;}
    }
    assert.fail(`No actual shared choice offered ${value}`);
  };
  return {...dom, ...h, page, props, closes: () => closes, select,
    async add(pair) {
      select(JSON.stringify([pair.track_ref, pair.primary_artist_ref]));
      dom.click(dom.named('Add artist')); await dom.settle();
    }};
}
test('initial render and explicit method choice do not discover or acquire until Refresh is pressed', async t => {
  const h = await mounted(t, {}, null);
  assert.equal(h.named(REFRESH).disabled, true); assert.equal(h.facetCalls.discovery.length, 0);
  h.choose('Selection method', 'random'); await h.settle();
  assert.equal(h.named(REFRESH).disabled, false); assert.equal(h.facetCalls.discovery.length, 0);
  h.click(h.named(REFRESH)); await h.settle();
  assert.equal(h.facetCalls.discovery.length, 1);
  assert.deepEqual(h.facetCalls.discovery[0].source, F.parent());
  assert.deepEqual(h.facetCalls.discovery[0].facets, ['styles', 'countries']);
  assert.equal(h.facetCalls.acquisition.length, 0); assert.equal(h.keys(), 0);
  assert.deepEqual(h.controller.getSnapshot().countryMetadata.selectedTargets, []);
  assert.equal(h.named(LOAD).disabled, true);
});
test('real target choice/Add/Remove preserves offered order and only the separate Load button acquires', async t => {
  const h = await mounted(t); h.click(h.named(REFRESH)); await h.settle();
  await h.add(F.targets()[2]); await h.add(F.targets()[0]);
  assert.deepEqual(h.controller.getSnapshot().countryMetadata.selectedTargets, [F.targets()[0], F.targets()[2]]);
  assert.equal(h.facetCalls.acquisition.length, 0); assert.equal(h.keys(), 0);
  h.click(h.named('Remove artist')); await h.settle();
  assert.equal(h.controller.getSnapshot().countryMetadata.selectedTargets.length, 1);
  const selected = F.plain(h.controller.getSnapshot().countryMetadata.selectedTargets);
  h.click(h.named(LOAD)); await h.settle();
  assert.equal(h.facetCalls.acquisition.length, 1);
  assert.deepEqual(h.facetCalls.acquisition[0].targets, selected);
  assert.equal(h.facetCalls.discovery.length, 1); assert.equal(h.controller.source(), null);
  assert.equal(h.keys(), 0); assert.ok(Object.values(h.calls).every(rows => rows.length === 0));
  assert.equal(h.named('Save as playlist').disabled, true); assert.equal(h.named('Play').disabled, true);
});
test('choosing a Country filter never chooses artists, refreshes, or acquires metadata', async t => {
  const h = await mounted(t); h.click(h.named(REFRESH)); await h.settle();
  h.select('musicbrainz-country:GB'); await h.settle();
  assert.equal(h.facetCalls.acquisition.length, 0); assert.equal(h.facetCalls.discovery.length, 1);
  assert.deepEqual(h.controller.getSnapshot().countryMetadata.selectedTargets, []);
  assert.equal(h.keys(), 0);
});
test('false permission hint offers no enabled acquisition action or invented targets', async t => {
  const h = await mounted(t, {discover: input => {
    const result = F.discovery(input); result.data.allowed_actions.enrich_country = false;
    result.data.facets.countries.enrichment_targets = []; return result;
  }});
  h.click(h.named(REFRESH)); await h.settle();
  assert.ok(!h.named(LOAD) || h.named(LOAD).disabled);
  assert.ok(!h.named('Add artist') || h.named('Add artist').disabled);
  assert.equal(h.facetCalls.acquisition.length, 0);
});
test('Cancel control aborts in-flight signal, warns about possible writes, and exposes no Retry request', async t => {
  const entered = F.deferred(), release = F.deferred(); let input;
  const h = await mounted(t, {acquire: value => {input = value; entered.resolve(); return release.promise;}});
  h.click(h.named(REFRESH)); await h.settle(); await h.add(F.targets()[0]);
  h.click(h.named(LOAD)); await entered.promise;
  assert.equal(h.named(LOAD).disabled, true); assert.equal(h.named('Add artist').disabled, true);
  assert.equal(h.host.querySelector('[aria-label="Songs per group"]').disabled, true);
  for (const label of ['Generate', 'Save as playlist', 'Play']) assert.equal(h.named(label).disabled, true);
  h.click(h.named('Cancel Country metadata loading')); await h.settle();
  assert.equal(input.signal.aborted, true);
  release.resolve(F.acquired(input)); await h.settle();
  assert.equal(h.controller.getSnapshot().countryMetadata.status, 'uncertain');
  assert.match(h.host.textContent, /uncertain|may.*(?:saved|changed)|might.*saved/i);
  assert.doesNotMatch(h.host.textContent, /nothing changed|nothing was saved|rolled back|Retry Country request/i);
  assert.equal(h.facetCalls.acquisition.length, 1);
  h.click(h.named(REFRESH)); await h.settle();
  assert.equal(h.facetCalls.acquisition.length, 1); assert.equal(h.facetCalls.discovery.length, 2);
  assert.equal(h.named(LOAD).disabled, true);
});
for (const change of ['quota', 'null_method', 'source', 'unmount']) {
  test(`actual page ${change} change fences late discovery without key allocation`, async t => {
    const entered = F.deferred(), release = F.deferred(); let input;
    const h = await mounted(t, {discover: value => {input = value; entered.resolve(); return release.promise;}});
    h.click(h.named(REFRESH)); await entered.promise;
    if (change === 'quota') {
      const count = h.host.querySelector('[aria-label="Songs per group"]');
      count.value = '3'; count.dispatchEvent(new h.c.Event('input'));
    } else if (change === 'null_method') h.choose('Selection method', '');
    else if (change === 'source') h.page.update({...h.props, parent: {...F.parent(), revision: '4'}});
    else h.page.dispose();
    assert.equal(input.signal.aborted, true);
    release.resolve(F.discovery(input)); await h.settle();
    assert.equal(h.controller.getSnapshot().facetDiscovery.data, null);
    assert.equal(h.facetCalls.acquisition.length, 0); assert.equal(h.keys(), 0);
  });
}
test('new prop/callback identities and same-value input do not invalidate current discovery', async t => {
  const h = await mounted(t); h.click(h.named(REFRESH)); await h.settle();
  const data = h.controller.getSnapshot().facetDiscovery.data;
  h.page.update({...h.props, parent: {...F.parent()}, onClose() {}});
  const count = h.host.querySelector('[aria-label="Songs per group"]');
  count.value = '2'; count.dispatchEvent(new h.c.Event('input')); await h.settle();
  assert.equal(h.controller.getSnapshot().facetDiscovery.data, data);
  assert.equal(h.facetCalls.discovery.length, 1); assert.equal(h.facetCalls.acquisition.length, 0);
});

test('actual native shell suspends facet work without remounting the retained edited Sample form or capture', async t => {
  const h = await nativeMixFixture(t); h.installNavigation();
  const entered = F.deferred(), release = F.deferred(); let discoveryInput, reads = 0, captures = 0;
  const detail = {playlist_id: F.parent().playlist_ref, revision: F.parent().revision,
    title: 'Saved parent', playlist_kind: 'ordinary', items_complete: true,
    allowed_actions: {can_open: true, can_play: true, can_create_sample: true},
    track_rows: [{playlist_item_id: F.id(71), title: 'Parent track', availability: 'local',
      source_readable: true, allowed_actions: {can_read: true, can_play: true}}]};
  const payload = {context_ref: 'a'.repeat(64), surface: {active: 'playlists'},
    playlist_sidebar: {active_playlist_id: detail.playlist_id,
      items: [{playlist_id: detail.playlist_id, title: detail.title, allowed_actions: {can_open: true}}]},
    playlist_detail: detail};
  h.state.view = payload; h.runtime.sync(); h.c.AlbumHavenPlaylistRuntime = h.runtime;
  const original = h.runtime.createSamplePlaylistRuntime;
  h.runtime.createSamplePlaylistRuntime = input => {
    const value = original(input);
    for (const key of ['buttonHtml', 'actionHtml', 'iconHtml', 'tableHtml', 'artboxHtml',
      'albumTrackRow', 'escapeHtml', 'alertHtml', 'navigationItemHtml', 'openChoice']) value[key] = h.runtime[key];
    return value;
  };
  const {mountPlaylists} = await import('../../../music_app/static/js/playlists/native.mjs');
  const owner = mountPlaylists({host: h.host, runtime: h.runtime, providers: {
    readPlaylists: async () => payload,
    captureSamplePlaylist: async input => {captures++; return F.captureResult(input);},
    readSamplePlaylist: async input => F.readResult(input),
    readSamplePlaylistFacets: async input => {reads++; discoveryInput = input; entered.resolve(); return release.promise;},
    enrichSamplePlaylistCountryMetadata: async () => assert.fail('Suspension must not acquire'),
    hasPendingPlaylistOperation: () => false,
    createPlaylistFromSelection: async () => assert.fail('No Save was requested'),
  }, isRuntimeCurrent: () => h.c.AlbumHavenPlaylistRuntime === h.runtime});
  t.after(() => owner.dispose()); await h.settle();
  assert.equal(owner.openSamplePlaylist({parent: F.parent(), options: F.options('most_listened')}), true);
  await h.settle();
  const page = h.host.querySelector('main[aria-label="Temporary Sample Playlist"]');
  const quota = h.host.querySelector('[aria-label="Songs per group"]');
  quota.value = '7'; quota.dispatchEvent(new h.c.Event('input')); await h.settle();
  h.click(h.named('Generate')); await h.settle(); assert.equal(captures, 1);
  const token = h.runtime.snapshot().retainedDraftToken, table = h.host.querySelector('table');
  const history = {url: h.c.location.href, state: structuredClone(h.c.history.state)};
  h.click(h.named(REFRESH)); await entered.promise;
  h.c.history.replaceState(history.state, '', '/?surface=album_tops'); h.runtime.sync(); await h.settle();
  assert.equal(h.runtime.snapshot().retainedDraftToken, token); assert.equal(h.runtime.snapshot().draftToken, null);
  assert.equal(discoveryInput.signal.aborted, true);
  assert.equal(h.host.querySelector('main[aria-label="Temporary Sample Playlist"]'), page);
  assert.equal(h.host.querySelector('[aria-label="Songs per group"]'), quota); assert.equal(quota.value, '7');
  release.resolve(F.discovery(discoveryInput)); await h.settle();
  h.c.history.replaceState(history.state, '', history.url); h.runtime.sync(); await h.settle();
  assert.equal(h.runtime.snapshot().draftToken, token);
  assert.equal(h.host.querySelector('main[aria-label="Temporary Sample Playlist"]'), page);
  assert.equal(h.host.querySelector('[aria-label="Songs per group"]'), quota); assert.equal(quota.value, '7');
  assert.equal(h.host.querySelector('table'), table); assert.equal(h.named('Save as playlist').disabled, false);
  assert.equal(reads, 1); assert.equal(captures, 1);
  assert.ok(!h.named(LOAD) || h.named(LOAD).disabled);
});
