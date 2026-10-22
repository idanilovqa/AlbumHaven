'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./album-tops-source-replay-fixture.cjs');

test('native mobile descriptor retains the registry token and details-only rights after Top UI retirement', async t => {
  const f = await F.fixture(t); assert.equal(await f.ui.open(), true); f.ui.details.dispose();
  F.script(f.context, 'mobile-navigation.js');
  const descriptor = f.context.mobilePageDescriptor('album', f.presentations[0].album);
  assert.equal(descriptor.sourcePageToken, f.presentations[0].owner.token); assert.equal(descriptor.albumKey, F.KEY);
  assert.equal(f.context.nativeAlbumPagePresentationAllowed(), true);
  assert.equal(f.context.canPlayTrackModalSelection({closest: selector => selector === '#track-modal' ? {} : null}), false);
  assert.equal(f.context.canViewTrackModalArtwork(), true);
  assert.equal(Object.hasOwn(descriptor, 'top_ref'), false); assert.equal(Object.hasOwn(descriptor, 'inventory_album_ref'), false);
  assert.equal(Object.hasOwn(descriptor, 'items'), false);
});

test('native mobile traversal replacement cancels a pending saved-Top replay without presenting it', async t => {
  const gate = F.deferred(), entered = F.deferred();
  const f = await F.fixture(t, {readTop(call) {entered.resolve(call); return gate.promise;}});
  assert.equal(await f.ui.open(), true); f.ui.details.dispose();
  const descriptor = f.descriptor(), c = f.context;
  c.window.location = new URL('https://albumhaven.test/?mobile_page=album');
  c.window.history = {state: {albumHavenNavigationPosition: 2, mobilePages: [descriptor]}};
  F.script(c, 'mobile-navigation.js');
  const operation = c.restoreSourceMobileAlbumPage(descriptor), observed = await F.atBoundary(entered, operation);
  assert.equal(c.restoreSourceMobileAlbumPage(descriptor), operation, 'Same native traversal deduplicates its pending request');
  c.window.history.state = {albumHavenNavigationPosition: 3, mobilePages: []};
  assert.equal(c.handleMobilePagePopState(), false);
  assert.equal(observed.options.signal.aborted, true);
  gate.resolve(F.detail()); assert.equal(await operation, false); f.counts(1, 2, 1, 1);
});

test('the real modal Artist-link handler reaches existing navigation after Top UI disposal and leaves its token replayable', async t => {
  const f = await F.fixture(t); assert.equal(await f.ui.open(), true); const descriptor = f.descriptor();
  f.ui.details.dispose();
  const c = f.context, calls = [];
  c.state.view = {};
  c.invalidateAdvancedSearchIntent = () => {};
  // Deliberately stop at the established native navigation boundary; neither
  // a fake Artist page nor an invented nested-history stack is introduced.
  c.deferAppFormPageReplacement = () => {calls.push('artist-navigation'); return true;};
  F.script(c, 'bootstrap-gallery-event-handlers.js');
  const link = {closest: selector => selector === '#track-modal' ? {} : null};
  assert.equal(c.handleSidebarArtistSelectionClick({target: {closest: () => link}, preventDefault() {}}), true);
  assert.deepEqual(calls, ['artist-navigation']);
  // Leave the unrelated form-defer seam and use the original source-page owner
  // for the same native history return, including a fresh server authorization.
  c.deferAppFormPageReplacement = () => false;
  assert.equal(await f.restore(descriptor), true); f.counts(1, 3, 2, 2);
  assert.equal(f.presentations[1].owner.token, descriptor.sourcePageToken);
});

// These additive regressions require the shared Artist-link admission fix.
// The accepted preview-navigation R3 handler checks isCurrent only for owners
// with retainNavigation; a saved Top deliberately needs no draft exemption.
for (const [name, retire] of [['mount disposal', f => f.sourceReplay.dispose()],
  ['logout', f => f.setShell({authenticated: false})], ['local mutation', f => f.sourceReplay.invalidate()]]) {
  test(`native Artist admission rejects ${name} even without a retention wrapper`, async t => {
    const f = await F.fixture(t); assert.equal(await f.ui.open(), true); f.ui.details.dispose();
    const c = f.context, owner = c.getTrackModalSourcePageOwner();
    assert.equal(typeof owner.retainNavigation, 'undefined');
    retire(f); assert.equal(owner.isCurrent(), false);
    let navigations = 0;
    c.state.view = {}; c.invalidateAdvancedSearchIntent = () => {};
    c.deferAppFormPageReplacement = () => {navigations++; return true;};
    F.script(c, 'bootstrap-gallery-event-handlers.js');
    const link = {closest: selector => selector === '#track-modal' ? {} : null};
    assert.equal(c.handleSidebarArtistSelectionClick({target: {closest: () => link}, preventDefault() {}}), true);
    assert.equal(navigations, 0, 'Retired native source must stop before Artist navigation');
    f.counts(0, 2, 1, 1);
  });
}
