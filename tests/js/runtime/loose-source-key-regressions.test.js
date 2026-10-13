// R4: source lineage belongs to population/filter scope, not display mode.
// Whole real URL/transition/preference owners; no browser or UI event claim.
const nodeTest = require('node:test');
const test = (name, body) => nodeTest(name, {timeout: 5000}, body);
const assert = require('node:assert/strict');
const {fixture, albumRead, readKnown, looseRow, browsePayload, overlay} = require('./loose-revocation-regression-harness.cjs');
function presentationFixture() {
  const f = fixture(); f.context.window.innerWidth = 390; f.context.virtualGrid = null;
  for (const file of ['gallery-main-state.js', 'gallery-display-preference-helpers.js', 'gallery-main-interactions.js']) f.loadRuntime(file);
  return f;
}
const sourceView = (id, patch = {}) => browsePayload([looseRow(id)], {selected_artist: 'Source Artist',
  visible_library_categories: ['main_library'], gallery_scope: 'all', gallery_display_mode: 'cards',
  gallery_scale_percent: 100, ...patch});
async function deny(f, url, status = 403) {
  const index = f.requests.length, pending = f.read(url); f.respond(index, {ok: false, error: 'Denied'}, status);
  const result = await pending; assert.ok(result.error); return index;
}

for (const change of ['cards to list', 'cards to covers', 'scale', 'family presentation']) {
  test(`${change} retains one Loose denial lineage after actual URL building`, async () => {
    const f = presentationFixture(), album = await albumRead(f);
    const other = await readKnown(f, sourceView(902, {selected_artist: 'Other Artist'}));
    const original = await readKnown(f, sourceView(301)), live = f.state.view, row = live.non_album_tracks[0];
    const source = f.source(row), adapter = f.mount(); let notifications = 0;
    const unsubscribe = adapter.runtime.subscribeTrackPreferences(() => {notifications++;});
    const initialUrl = f.url(live), before = f.batches.length;
    if (change === 'cards to list' || change === 'cards to covers') {
      f.context.transitionGalleryMain({type: 'set-view', view: change === 'cards to list' ? 'list' : 'covers'});
      assert.equal(f.state.view.gallery_display_mode, change === 'cards to list' ? 'list' : 'covers');
      assert.equal(f.state.gallery.displayPreferences.defaultGalleryDisplayMode, f.state.view.gallery_display_mode);
    } else if (change === 'scale') {
      // No separate scale event setter is present in the runtime. Exercise the
      // genuine persisted-preference owner and URL builder after unit state setup.
      live.gallery_scale_percent = 125; f.context.persistCurrentGalleryDisplayPreferences(live);
      assert.equal(f.state.gallery.displayPreferences.defaultGalleryScalePercent, 125);
    } else {
      live.selected_artist_family_display_mode = 'chronological';
    }
    assert.equal(f.state.view, live); assert.equal(f.state.view.non_album_tracks[0], row);
    assert.equal(f.source(row), source); assert.equal(f.value(adapter).allowed_actions.can_set_love_tier, true);
    const changedUrl = f.url(f.state.view); assert.notEqual(changedUrl, initialUrl);
    await deny(f, changedUrl);
    assert.equal(f.source(row), null, 'current presentation-equivalent 403 must invalidate the original exact receipt');
    assert.equal(f.value(adapter), null, 'the already mounted original source becomes unknown without a cache restore');
    assert.ok(notifications > 0); assert.equal(f.batches.length, before);
    assert.equal(f.preference(album).love_tier, 'obsessed'); assert.ok(f.source(other.non_album_tracks[0]));
    const requestCount = f.requests.length;
    await assert.rejects(adapter.runtime.setTrackLove({row: adapter.rows[0], context: adapter.context, love_tier: 'loved'}));
    assert.equal(f.requests.length, requestCount); unsubscribe();
  });
}

test('Display and scale change followed by a current successful whole-source denial also revokes old rows', async () => {
  const f = presentationFixture(), original = await readKnown(f, sourceView(311));
  const row = original.non_album_tracks[0], adapter = f.mount();
  f.context.transitionGalleryMain({type: 'set-view', view: 'list'});
  f.state.view.gallery_scale_percent = 125; f.context.persistCurrentGalleryDisplayPreferences();
  const denied = sourceView(311, {gallery_display_mode: 'list', gallery_scale_percent: 125, source_readable: false});
  const index = f.requests.length, pending = f.read(f.url(f.state.view)); f.respond(index, denied);
  const result = await pending; assert.ifError(result.error); assert.equal(result.value, true);
  assert.equal(f.source(row), null); assert.equal(f.source(denied.non_album_tracks[0]), null);
  assert.equal(f.value(adapter), null); assert.equal(f.batches.length, 1);
});

for (const [label, first, second] of [
  ['key order', '/view-data?surface=albums&artist=Order&q=one&category=main_library',
    '/view-data?category=main_library&q=one&artist=Order&surface=albums'],
  ['hydration and paging', '/view-data?surface=albums&artist=Order&payload_tier=full',
    '/view-data?artist=Order&root_sidebar=1&omit_sidebar=1&surface=albums'],
]) {
  test(`${label} alone does not separate one request-source denial lineage`, async () => {
    const f = fixture(), original = await readKnown(f, sourceView(321, {selected_artist: 'Order'}), first);
    await deny(f, second); assert.equal(f.source(original.non_album_tracks[0]), null);
  });
}

for (const [label, patch] of [
  ['artist', {selected_artist: 'Different Artist'}],
  ['search', {query: 'different query'}],
  ['category', {visible_library_categories: ['hoard']}],
  ['gallery scope', {gallery_scope: 'new_arrivals'}],
  ['related artist', {related_filter_artists: ['Related Artist']}],
  ['primary filter', {primary_filter_active: true}],
  ['genre', {search_filters: {genre: ['Jazz']}}],
  ['mood', {search_filters: {mood: ['Calm']}}],
  ['style', {search_filters: {style: ['Acoustic']}}],
  ['duration bound', {search_filters: {duration: {min_seconds: 60, max_seconds: 300}}}],
]) {
  test(`Real ${label} population difference keeps its own Loose revocation source`, async () => {
    const f = presentationFixture(), original = await readKnown(f, sourceView(331));
    const originalRow = original.non_album_tracks[0], originalUrl = f.url(original);
    const other = sourceView(332, patch), otherUrl = f.url(other); assert.notEqual(otherUrl, originalUrl);
    await readKnown(f, other, otherUrl); const otherRow = other.non_album_tracks[0];
    // Presentation changes are orthogonal to the preserved filter distinction.
    other.gallery_display_mode = 'list'; other.gallery_scale_percent = 125;
    await deny(f, f.url(other));
    assert.equal(f.source(otherRow), null, 'deny the equivalent presented form of this exact filter source');
    assert.ok(f.source(originalRow), 'a different population/filter lineage must survive');
    assert.equal(f.preference(originalRow).allowed_actions.can_set_love_tier, true);
  });
}

for (const change of ['actor', 'library', 'transport', 'inventory']) {
  test(`Presentation normalization never merges ${change}-replaced authority with old scope`, async () => {
    const f = presentationFixture(), original = await readKnown(f, sourceView(341)), row = original.non_album_tracks[0];
    f.context.transitionGalleryMain({type: 'set-view', view: 'list'});
    const index = f.requests.length, pending = f.read(f.url(f.state.view));
    if (change === 'actor') f.shell.dataset.nativeAccountId = '8';
    if (change === 'library') f.shell.dataset.nativeLibraryId = '10';
    if (change === 'transport') f.changeSession();
    if (change === 'inventory') f.state.status.inventory_mutation_revision++;
    const stale = sourceView(341, {gallery_display_mode: 'list'}); f.respond(index, stale); await pending;
    assert.equal(f.source(stale.non_album_tracks[0]), null); assert.equal(f.source(row), null);
  });
}

test('Delayed presentation-equivalent denial from a superseded dispatch cannot revoke the new current receipt', async () => {
  const f = presentationFixture(), original = await readKnown(f, sourceView(351));
  f.context.transitionGalleryMain({type: 'set-view', view: 'list'});
  const index = f.requests.length, obsolete = f.read(f.url(f.state.view));
  const current = sourceView(351, {gallery_display_mode: 'covers'}), pending = f.read(f.url(current));
  f.respond(index + 1, current); assert.equal((await pending).value, true);
  f.respond(index, {ok: false, error: 'Old denial'}, 403); assert.equal((await obsolete).value, false);
  assert.equal(f.preference(current.non_album_tracks[0]).allowed_actions.can_set_love_tier, true);
});
