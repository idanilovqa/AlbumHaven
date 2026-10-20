'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const S = require('./artist-host-fixtures/artist-sheet-runtime.cjs');
const H = require('./artist-creation-fixtures/facade.cjs');

for (const withLaunch of [false, true]) test(`Top observer preserves actual nested Cover Back lineage with admitted launch ${withLaunch}`, async t => {
  const launch = H.wire(), group = S.group(S.ARTIST, [S.fullAlbum(1)], withLaunch ? {artist_listen_through_launch: launch} : {});
  const view = withLaunch ? H.payload({artist_groups: [group], primary_artist_groups: [group]})
    : S.artistView({artist_groups: [group], primary_artist_groups: [group]});
  const h = await S.mounted(t, {view}), runtime = h.runtime(), bridge = h.context.AlbumHavenAlbumTopsRuntime;
  assert.ok(bridge?.artistCreation, 'the actual earlier Top observer is installed');
  const initial = bridge.artistCreation.snapshot();
  assert.equal(Boolean(initial), withLaunch, 'only actual registered Top evidence admits an origin');
  const source = S.opener(h);
  assert.equal(h.context.openTrackModalForButton(source.button), true); await S.drain(); h.frame();
  h.send(h.toggle, 'click', {detail: 0}); h.frame();
  const before = {session: runtime.snapshot().sessionId, lease: h.grid._artistPageLease,
    host: h.host, header: h.header, headerText: h.header.textContent, grid: h.grid,
    viewport: h.nodes.viewport, panel: h.panel, list: h.document.getElementById('track-modal-list'),
    table: h.overlay.querySelector('.album-track-table'), actions: h.overlay.querySelector('.album-track-table__selection-actions'),
    player: h.player, playerState: h.state.player, discography: h.section('discography').panel,
    origin: h.context.getTrackModalArtistSheetOrigin(), album: h.context.getCurrentTrackModalAlbum()};
  assert.ok(before.session); assert.ok(before.lease); assert.ok(before.origin); assert.ok(before.table);
  assert.equal(h.context.presentMobileCoverLookupPage(before.album), true); await S.drain(); h.frame();
  assert.equal(h.mobileState().pages.length, 2); assert.equal(h.overlay.hidden, true);
  const observations = [], requests = h.requests.length, calls = h.historyCalls.length;
  const unsubscribe = runtime.subscribe(() => {
    const historyLength = h.history.state.mobilePages.length, liveLength = h.mobileState().pages.length;
    const snapshot = runtime.snapshot();
    observations.push({historyLength, liveLength, session: snapshot.sessionId, retained: snapshot.retained,
      actionable: snapshot.actionable, sameLease: h.grid._artistPageLease === before.lease});
  }); t.after(unsubscribe);
  const stopTop = bridge.artistCreation.subscribe(() => {bridge.artistCreation.snapshot();}); t.after(stopTop);
  assert.equal(bridge.snapshot().sidebarMode, 'albums');
  const reentries = [];
  const stopBridge = bridge.subscribe(() => {
    const observation = {history: h.history.state.mobilePages.length, live: h.mobileState().pages.length};
    bridge.artistCreation.snapshot(); bridge.artistCreation.snapshot();
    if (initial) {observation.ownerCurrent = initial.isOwnerCurrent(); observation.canCreate = initial.canCreate();}
    reentries.push(observation);
  }); t.after(stopBridge);
  h.holdHistory(); h.context.closeCoverLookupModal(); assert.equal(h.pendingHistory().length, 1);
  assert.equal(h.mobileState().pages.length, 2); assert.equal(h.requests.length, requests);
  const priorCallbacks = reentries.length;
  // Valid shell presentation input changes the next actual Top snapshot, without changing Artist authority.
  h.state.ui.librarySidebarMode = 'playlists';
  h.settleHistory(); await S.drain(); h.frame();
  assert.ok(reentries.length > priorCallbacks, 'the changed Top presentation actually notifies its ordinary subscriber');
  for (const row of reentries) {
    assert.equal(row.history, row.live, 'ordinary Top callback cannot observe the unmatched history midpoint');
    if (initial) assert.equal(row.canCreate, false, 'captured origin never gains Create while the album sheet is active');
  }
  assert.equal(observations.some(row => row.historyLength !== row.liveLength), false, 'no transient lineage publication');
  for (const row of observations) {
    assert.equal(row.session, before.session); assert.equal(row.retained, true);
    assert.equal(row.actionable, false); assert.equal(row.sameLease, true);
  }
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.sessionId, before.session); assert.equal(snapshot.retained, true); assert.equal(snapshot.actionable, false);
  // Boolean identity assertions preserve exact semantics without formatting cyclic DOM graphs on failure.
  for (const [label, actual, expected] of [
    ['lease', h.grid._artistPageLease, before.lease], ['host', h.host, before.host], ['header', h.header, before.header],
    ['grid', h.grid, before.grid], ['viewport', h.nodes.viewport, before.viewport], ['panel', h.panel, before.panel],
    ['album list', h.document.getElementById('track-modal-list'), before.list],
    ['table', h.overlay.querySelector('.album-track-table'), before.table],
    ['actions', h.overlay.querySelector('.album-track-table__selection-actions'), before.actions],
    ['player', h.player, before.player], ['player state', h.state.player, before.playerState],
    ['discography', h.section('discography').panel, before.discography],
    ['origin', h.context.getTrackModalArtistSheetOrigin(), before.origin],
    ['album', h.context.getCurrentTrackModalAlbum(), before.album],
  ]) assert.equal(actual === expected, true, `exact retained ${label}`);
  assert.equal(h.header.textContent, before.headerText);
  assert.equal(h.mobileState().pages.length, 1); assert.equal(h.mobileState().pages[0].presentation, 'artist-discography-sheet');
  assert.equal(h.overlay.hidden, false); assert.equal(h.overlay.getAttribute('data-sheet-state'), 'expanded');
  assert.equal(h.host.inert, true); assert.equal(h.main.classList.contains('has-mobile-page'), false);
  assert.equal(h.requests.length, requests); assert.equal(h.historyCalls.length, calls);
});

test('later actual popstate private-context replacement wins over deferred Top Artist observation', async t => {
  const launch = H.wire(), group = S.group(S.ARTIST, [S.fullAlbum(1)], {artist_listen_through_launch: launch});
  const h = await S.mounted(t, {view: H.payload({artist_groups: [group], primary_artist_groups: [group]})});
  const bridge = h.context.AlbumHavenAlbumTopsRuntime, namespace = bridge.artistCreation;
  const origin = namespace.snapshot(); assert.ok(origin); const oldScope = bridge.snapshot().scopeKey;
  const source = S.opener(h); assert.equal(h.context.openTrackModalForButton(source.button), true);
  await S.drain(); h.frame();
  assert.equal(h.context.presentMobileCoverLookupPage(h.context.getCurrentTrackModalAlbum()), true); await S.drain(); h.frame();
  const requests = h.requests.length, observed = [];
  const later = () => {
    h.change('context');
    observed.push({scopeChanged: bridge.snapshot().scopeKey !== oldScope, originCurrent: origin.isOwnerCurrent()});
  };
  h.context.addEventListener('popstate', later); t.after(() => h.context.removeEventListener('popstate', later));
  h.holdHistory(); h.context.closeCoverLookupModal(); assert.equal(h.pendingHistory().length, 1);
  h.settleHistory();
  assert.equal(observed.length, 1); assert.deepEqual(observed[0], {scopeChanged: true, originCurrent: false});
  await S.drain(); h.frame();
  assert.equal(namespace.snapshot(), null); assert.equal(origin.isOwnerCurrent(), false); assert.equal(origin.canCreate(), false);
  assert.equal(bridge.snapshot().scopeKey === oldScope, false); assert.equal(h.runtime().snapshot().sessionId, null);
  assert.equal(h.requests.length, requests); assert.equal(h.owner('activeAppFormDialog'), null);
});
