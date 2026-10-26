'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {shared, top, physical, loose, row, album, actualSource, historyPort, observeClose, T, F} = require('./sample-origin-back-fixtures.cjs');
function noWrites(h, svc, admitted = 0) {
  assert.equal(h.calls.save.length, 0);
  if (svc) {assert.equal(svc.count('execute'), 0); assert.equal(svc.count('admitAlbum'), admitted);}
}
function discarded(h, observed) {
  assert.equal(observed.length, 1); assert.equal(observed[0].marker, undefined);
  assert.equal(observed[0].retained, null); assert.equal(observed[0].originCurrent, true);
  assert.equal(h.runtime.snapshot().retainedDraftToken, null);
}

test('actual Sample mount and facade forward the identical history function after real Settings discard', async t => {
  const h = await shared(t), history = historyPort(h), observed = observeClose(h), parent = history.mark();
  let returned = 0, retained;
  const source = await actualSource(t, h, returnToParent => {
    returned++; retained = returnToParent; discarded(h, observed);
    assert.equal(returnToParent, observed[0].returnToParent, 'no intervening facade or lease wrapper replaces the callback');
    assert.equal(source.lease.isCurrent(), true, 'independent original owner survived intentional Sample discard');
    return returnToParent();
  });
  assert.equal(h.facade.openSamplePlaylist({originOwner: source.lease, originNavigation: source.originNavigation}), true); await h.settle(); h.setup();
  h.click(h.named('Back', h.host)); await h.settle();
  assert.equal(returned, 1); assert.equal(retained(), false); history.assertReturned(parent); h.noAcquisition();
  noWrites(h, source.svc);
});

for (const reason of ['cancel', 'source changed', 'destination changed'])
  test(`actual confirmation ${reason} cannot invoke the retained source return`, async t => {
    const h = await shared(t), history = historyPort(h), decision = F.deferred(); let asked = 0, returned = 0;
    const source = await actualSource(t, h, returnToParent => {returned++; return returnToParent();});
    assert.equal(h.facade.openSamplePlaylist({originOwner: source.lease, originNavigation: source.originNavigation}), true); await h.settle();
    await h.generate(); assert.equal(h.calls.capture.length, 1);
    const title = h.host.querySelector('[aria-label="Playlist title"]'); assert.ok(title); assert.equal(title.disabled, false);
    title.value = 'Unsaved Sample title'; title.dispatchEvent(new h.c.Event('input'));
    await h.settle(); assert.equal(title.value, 'Unsaved Sample title');
    // Only the user's dialog decision is controlled. The actual Sample
    // confirmLeave and actual Settings owner/URL/discard path remain intact.
    h.runtime.confirmDraft = () => {asked++; return decision.promise;};
    const token = h.runtime.snapshot().retainedDraftToken;
    h.click(h.named('Back', h.host)); await h.settle(); assert.equal(asked, 1);
    if (reason === 'source changed') source.controller.setScope('retired-top-source');
    else if (reason === 'destination changed') {h.shell.dataset.nativeLibraryId = '6'; h.runtime.sync();}
    decision.resolve(reason !== 'cancel'); await h.settle();
    assert.equal(returned, 0); assert.deepEqual(history.calls.go, []);
    assert.deepEqual(history.calls.fetch, []); assert.deepEqual(history.calls.fallback, []); noWrites(h, source.svc);
    if (reason === 'cancel') assert.equal(h.runtime.snapshot().retainedDraftToken, token, 'cancel keeps the actual Sample draft');
  });

test('retained real detached Top form returns once with identical input nodes and unsaved selection', async t => {
  const picker = {local_album_id: 11, album_ref: null, inventory_album_ref: 'inventory-album:5:11', title: 'Picked album', artist: 'Artist A', year: 2001};
  const h = await top(t, {selected: null, providers: {searchAlbums: async () => ({albums: [picker], next_cursor: null})}});
  const history = historyPort(h), observed = observeClose(h);
  h.click(h.named('Create Album Top', h.topHost)); await h.settle();
  const form = h.document.querySelector('form[aria-label="Create Album Top"]'); assert.ok(form);
  const title = form.querySelector('[aria-label="Album Top name"]'); h.input(title, 'Unsaved retained name');
  h.click(h.named('Find albums', form)); await h.settle();
  const search = form.querySelector('input[type="search"]'); h.input(search, 'Picked'); await h.settle();
  h.click(form.querySelector('[data-gallery-card-intent="select"]')); await h.settle();
  assert.equal(h.svc.count('admitAlbum'), 1, 'ordinary safe-ID admission already occurred before Back');
  const originalTitle = title.value, originalSearch = search.value, parent = history.mark();
  h.click(h.named('Create sample playlist', form)); await h.settle(); h.setup();
  const lease = h.calls.source[0], selections = F.plain(lease.origin.selections);
  assert.deepEqual(selections, [{kind: 'local', inventory_album_ref: picker.inventory_album_ref}]);
  assert.equal(await lease.back(), false, 'a retained form cannot claim a successful no-op without its history owner');
  h.click(h.named('Back', h.host)); await h.settle();
  discarded(h, observed); history.assertReturned(parent);
  assert.equal(history.calls.settingsReads.length, 1, 'only the account preference refresh accompanies retained return');
  assert.deepEqual(history.calls.settingsReads.map(call => [call.url, call.options.method]),
    [['/account/album-top-listening-settings', 'GET']]);
  assert.equal(h.document.querySelector('form[aria-label="Create Album Top"]'), form);
  assert.equal(form.querySelector('[aria-label="Album Top name"]'), title); assert.equal(title.value, originalTitle);
  assert.equal(form.querySelector('input[type="search"]'), search); assert.equal(search.value, originalSearch);
  assert.equal(form.isConnected, true); assert.equal(lease.isCurrent(), true);
  noWrites(h, h.svc, 1); h.noAcquisition();
  // Recapture through the real initiating form action verifies retained selected
  // draft state without exporting or replacing the builder's private draft.
  h.click(h.named('Create sample playlist', form)); await h.settle();
  assert.equal(h.calls.source.length, 2); assert.deepEqual(F.plain(h.calls.source[1].origin.selections), selections);
  assert.deepEqual(history.calls.go, [-1]); noWrites(h, h.svc, 1);
});

test('real captured edit draft and its volatile snapshot survive the parent return without submission', async t => {
  const h = await shared(t), history = historyPort(h), parent = history.mark(); let returned = 0;
  const source = await actualSource(t, h, returnToParent => {returned++; return returnToParent();}, {draft: true});
  const draft = source.draft, snapshot = draft.getSnapshot(), items = snapshot.items;
  assert.equal(snapshot.dirty, true); assert.equal(snapshot.title, 'Volatile unsaved title');
  assert.equal(h.facade.openSamplePlaylist({originOwner: source.lease, originNavigation: source.originNavigation}), true); await h.settle(); h.setup();
  h.click(h.named('Back', h.host)); await h.settle();
  assert.equal(returned, 1); history.assertReturned(parent); assert.equal(source.draft, draft);
  assert.equal(draft.getSnapshot(), snapshot); assert.equal(draft.getSnapshot().items, items);
  assert.equal(snapshot.title, 'Volatile unsaved title'); assert.equal(snapshot.description, 'Unsaved subtitle');
  assert.equal(snapshot.dirty, true); assert.equal(source.lease.isCurrent(), true); h.noAcquisition(); noWrites(h, source.svc);
});

test('actual loose Back preserves the retained sourceView and playtable owner without reopening', async t => {
  const h = await shared(t), history = historyPort(h), m = await loose(h), parent = history.mark();
  const owner = m.prepared.get('loose-tracks'), sourceView = m.c.state.view, rows = owner.privateRows, handle = owner.source;
  let reopened = 0; const open = m.c.openNonAlbumModal;
  m.c.openNonAlbumModal = (...args) => {reopened++; return open(...args);};
  h.click(m.button()); await h.settle(); h.setup();
  assert.equal(await m.captured[0].lease.back(), false, 'no supplied parent history means no loose reopen');
  h.click(h.named('Back', h.host)); await h.settle();
  history.assertReturned(parent); assert.equal(reopened, 0); assert.equal(m.prepared.get('loose-tracks'), owner);
  assert.equal(m.c.state.view, sourceView); assert.equal(owner.privateRows, rows); assert.equal(owner.source, handle);
  assert.ok(handle.snapshot()); assert.equal(m.c.fetchCalls.length, 0); h.noAcquisition(); noWrites(h);
});

for (const duplicate of [false, true])
  test(`actual ${duplicate ? 'duplicate' : 'physical'} Back without a source page uses retained history without reconstruction`, async t => {
    const h = await shared(t), history = historyPort(h);
    const value = album(duplicate ? {duplicate_sources: [{folder_path: '/test-only/a', tracks: [row(F.refs[0])]},
      {folder_path: '/test-only/b', tracks: [row(F.refs[1]), row(F.refs[2])]}]} : {});
    const m = physical(h, {value}), parent = history.mark(), retainedAlbum = m.c.getCurrentTrackModalAlbum();
    let reopened = 0, restored = 0; const open = m.c.openTrackModal, restore = m.c.restoreTrackModalSourcePage;
    m.c.openTrackModal = (...args) => {reopened++; return open(...args);};
    m.c.restoreTrackModalSourcePage = (...args) => {restored++; return restore(...args);};
    h.click(m.button(duplicate ? 1 : undefined)); await h.settle(); h.setup();
    assert.equal(await m.captured[0].lease.back(), false, 'ordinary physical origin cannot reconstruct when history is unavailable');
    h.click(h.named('Back', h.host)); await h.settle();
    history.assertReturned(parent); assert.equal(reopened, 0); assert.equal(restored, 0);
    assert.equal(m.c.getCurrentTrackModalAlbum(), retainedAlbum); assert.equal(m.c.fetchCalls.length, 0);
    assert.equal(m.captured[0].lease.isCurrent(), true); h.noAcquisition(); noWrites(h);
  });

test('actual source-page physical return revalidates then traverses Sample parent history once before guarded reopen', async t => {
  const h = await shared(t), history = historyPort(h), fresh = album({name: 'Revalidated source album'}); let revalidations = 0;
  const m = physical(h, {options: {sourcePageOwner: {isCurrent: () => true, revalidate: async () => {
    revalidations++; return {album: fresh, isCurrent: () => true, presentationRestrictions: {can_open_album_page: true, can_play_album: false}};
  }}}});
  const token = m.c.getTrackModalSourcePageToken(), calls = [], restore = m.c.restoreTrackModalSourcePage;
  m.c.restoreTrackModalSourcePage = (descriptor, options) => {calls.push(descriptor); return restore(descriptor, options);};
  const reopened = [], open = m.c.openTrackModal;
  m.c.openTrackModal = function (value, options) {
    assert.deepEqual(history.calls.go, [-1], 'guarded reopen follows the one actual parent-history request');
    reopened.push({value, options}); return open.call(this, value, options);
  };
  h.click(m.button()); await h.settle(); h.setup();
  h.click(h.named('Back', h.host)); await h.settle();
  assert.equal(calls.length, 1); assert.equal(revalidations, 1); assert.equal(calls[0].sourcePageToken, token);
  assert.equal(calls[0].albumKey, 'actual:alpha'); assert.equal(reopened.length, 1); assert.equal(reopened[0].value, fresh);
  assert.equal(reopened[0].options.sourcePageOwner.isCurrent(), true);
  const {tabLabel, ...rendered} = m.c.getCurrentTrackModalAlbum();
  assert.deepEqual(F.plain(rendered), F.plain(fresh)); assert.equal(tabLabel, 'Original');
  assert.equal(m.c.getAlbumRequestKey(m.c.getCurrentTrackModalAlbum()), 'actual:alpha');
  assert.equal(Object.hasOwn(fresh, 'tabLabel'), false, 'native presentation copies rather than mutates revalidated input');
  assert.equal(h.runtime.snapshot().retainedDraftToken, null, 'successful source restoration may vacate the destination');
  assert.deepEqual(history.calls.go, [-1]); assert.deepEqual(history.calls.fallback, []); assert.deepEqual(history.calls.fetch, []);
  assert.equal(m.c.fetchCalls.length, 0); h.noAcquisition(); noWrites(h);
});

test('physical source-page revalidation cannot resurrect a source retired during its awaited return', async t => {
  const h = await shared(t), history = historyPort(h), gate = F.deferred(); let current = true, revalidations = 0;
  const m = physical(h, {options: {sourcePageOwner: {isCurrent: () => current, revalidate: async () => {
    revalidations++; return gate.promise;
  }}}});
  const original = m.c.getCurrentTrackModalAlbum(); let reopened = 0; const open = m.c.openTrackModal;
  m.c.openTrackModal = (...args) => {reopened++; return open(...args);};
  h.click(m.button()); await h.settle(); h.setup(); h.click(h.named('Back', h.host)); await h.settle();
  assert.equal(revalidations, 1); current = false;
  gate.resolve({album: album({name: 'Must not render'}), isCurrent: () => current}); await h.settle();
  assert.equal(reopened, 0); assert.equal(m.c.getCurrentTrackModalAlbum(), original);
  assert.deepEqual(history.calls.go, []); assert.deepEqual(history.calls.fallback, []); assert.deepEqual(history.calls.fetch, []);
  assert.equal(m.c.fetchCalls.length, 0); noWrites(h);
});

for (const change of ['original source', 'provider generation', 'mount owner'])
  test(`actual ${change} change during an awaited original return fences the identical retained history callback`, async t => {
    const h = await shared(t), history = historyPort(h), observed = observeClose(h), gate = F.deferred(); let retained, returned = 0;
    const source = await actualSource(t, h, async returnToParent => {
      retained = returnToParent; returned++; discarded(h, observed); await gate.promise; return returnToParent();
    });
    assert.equal(h.facade.openSamplePlaylist({originOwner: source.lease, originNavigation: source.originNavigation}), true); await h.settle(); h.setup();
    h.click(h.named('Back', h.host)); await h.settle(); assert.equal(returned, 1);
    assert.equal(retained, observed[0].returnToParent);
    if (change === 'original source') source.controller.setScope('retired-top-source');
    else if (change === 'provider generation') h.facade.configureProviders({...h.providers});
    else {const replacement = h.document.createElement('section'); replacement.id = 'playlists-root'; h.host.replaceWith(replacement);}
    assert.equal(source.lease.isCurrent(), change !== 'original source', 'source and destination fences remain independent');
    gate.resolve(); await h.settle(); assert.equal(retained(), false);
    assert.deepEqual(history.calls.go, []); assert.deepEqual(history.calls.fetch, []); assert.deepEqual(history.calls.fallback, []);
    noWrites(h, source.svc);
  });

for (const [url, options] of [
  ['/account/album-top-listening-settings?unexpected=1', {method: 'GET', credentials: 'same-origin', redirect: 'error'}],
  ['/account/album-top-listening-settings', {method: 'PUT', credentials: 'same-origin', redirect: 'error'}],
  ['/account/album-top-listening-settings', {method: 'GET', credentials: 'same-origin', redirect: 'error', body: '{}'}],
  ['/view-data?surface=album_tops', {method: 'GET', credentials: 'same-origin', redirect: 'error'}],
]) test(`retained history port rejects non-preference request ${options.method} ${url} body:${Object.hasOwn(options, 'body')}`, async () => {
  const h = {c: {location: new URL('https://fixture.invalid/'), history: {state: {}}}};
  const port = historyPort(h);
  await assert.rejects(h.c.fetch(url, options), /must not fetch a reconstructed source/);
  assert.equal(port.calls.fetch.length, 1);
  assert.equal(port.calls.settingsReads.length, 0);
});
